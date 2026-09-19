/**
 * Phase 6.4 — pairing harness.
 *
 * Builds a REAL SessionManager (no DB, no lease, file auth state in a temp dir)
 * with the Baileys network boundary faked, and captures every event the manager
 * would have pushed to the backend.
 */
import { register } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// `encryptBuffer` uses aes-256-cbc, so the key MUST be exactly 32 bytes.
const TEST_AES_KEY = randomBytes(32);

// MUST precede the session-manager import so the resolve hook is installed.
register('./baileys-stub-loader.mjs', import.meta.url);

const mod = await import('../src/session-manager.js');
const { __fakeRegistry } = await import('./fake-baileys.mjs');

const tmpRoots = [];

export async function createHarness(opts = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wa-pairing-'));
  tmpRoots.push(root);

  // A restart test reuses the SAME on-disk auth store as the previous
  // "process", so `sessionsDir` can be supplied instead of a fresh temp dir.
  const sessionsDir = opts.sessionsDir || path.join(root, 'sessions');

  // Exact socket dispatch: waiting on `sockets.length >= N` is ambiguous once
  // two managers share the global registry (a second harness's socket can
  // satisfy the first harness's predicate). Each harness hands out sockets in
  // creation order from its own cursor instead.
  let socketCursor = __fakeRegistry().sockets.length;

  const emitted = [];
  const manager = mod.createSessionManager({
    sessionsDir,
    mediaDir: path.join(root, 'media'),
    aesKey: opts.aesKey || TEST_AES_KEY,
    backendWsUrl: null,
    authRepository: null,
    leaseRepository: null,
    pool: null,
    instanceId: opts.instanceId || 'test-instance',
  });

  // Intercept the outbox: the real _emit would open a WebSocket to the backend.
  const originalEmit = manager._emit;
  manager._emit = async (event) => {
    emitted.push(event);
    return true;
  };

  return {
    manager,
    emitted,
    registry: __fakeRegistry(),
    originalEmit,
    sessionsDir,
    /** The on-disk auth directory a session's credentials live in.
     *  Mirrors `getSessionDir(sessionsDir, id)` in session-manager.js. */
    sessionsDirFor: (id) => path.join(sessionsDir, String(id)),
    eventsOfType: (name) => emitted.filter((e) => e.event === name),
    clearEvents: () => { emitted.length = 0; },
    /**
     * Wait for the next socket THIS harness has not handed out yet and return
     * it. Deterministic even when another manager is creating sockets too.
     */
    async nextSocket(label = 'socket') {
      await waitFor(() => __fakeRegistry().sockets.length > socketCursor, { label });
      const sock = __fakeRegistry().sockets[socketCursor];
      socketCursor += 1;
      return sock;
    },
    /** Skip sockets another manager created, so a later nextSocket() is exact. */
    syncSocketCursor() { socketCursor = __fakeRegistry().sockets.length; },
    /** Fire a Baileys connection.update on a given fake socket. */
    async connectionUpdate(sock, update) {
      sock.ev.emit('connection.update', update);
      await settle();
    },
    async credsUpdate(sock) {
      sock.ev.emit('creds.update', {});
      await settle();
    },
  };
}

export async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Socket startup performs a real `fetchLatestBaileysVersion()` network call
 * (~1.2s observed), so microtask draining is NOT enough. Poll for a condition.
 */
export async function waitFor(predicate, { timeout = 20000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out waiting for ${label} (${timeout}ms)`);
}

export async function cleanupHarness() {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export const sessionManagerModule = mod;
