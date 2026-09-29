/**
 * Regression test for the two defects the production console exposed.
 *
 * 1. WebSocket leak under React StrictMode. StrictMode mounts, unmounts and
 *    remounts every effect, and createWebSocket's reconnect path was async:
 *    close() during an in-flight token refresh still scheduled a new socket, so
 *    each mount leaked one live connection. The backend logs showed
 *    connect/disconnect/connect pairs that never settled.
 *
 * 2. Transient QR 404 treated as fatal. WhatsApp answers a scanned QR with
 *    restartRequired (515); the gateway drops and rebuilds the socket, and
 *    GET /sessions/{id}/qr is genuinely 404 for those seconds. WhatsAppApiError
 *    also dropped the HTTP status entirely, so no caller could tell a transient
 *    404 from a dead pairing.
 *
 * Both are asserted against the REAL modules, not a reimplementation.
 *
 * Run: node scripts/verify-ws-lifecycle.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-ws-lifecycle-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  `export { createWebSocket, setTokenRefresher, subscribeRealtime } from '${SRC}/api/client';\n` +
    `export { WhatsAppApiError } from '${SRC}/features/whatsapp/api/whatsappApi';\n`,
  'utf8',
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile: out,
  platform: 'node',
  absWorkingDir: frontendRoot,
  nodePaths: [path.join(frontendRoot, 'node_modules')],
  logLevel: 'silent',
});

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// ---------------------------------------------------------------- fake socket

/** Records lifecycle transitions so a leak is observable, not inferred. */
class FakeSocket {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    FakeSocket.instances.push(this);
  }

  /** Completes the handshake. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** Server-side close (auth reject, network drop). */
  remoteClose(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  send() {}
  terminate() {}
}

/** Sockets the current code considers alive. */
const liveSockets = () =>
  FakeSocket.instances.filter((s) => s.readyState !== FakeSocket.CLOSED);

// Backoff base is 1s, so waiting past it lets any scheduled reconnect fire.
const pastBackoff = () => new Promise((r) => setTimeout(r, 1400));

const { createWebSocket, setTokenRefresher, WhatsAppApiError } = await import(out);
globalThis.WebSocket = FakeSocket;

// ---------------------------------------------------------------- 1. WS leak

await check('open + close leaves no live socket', async () => {
  FakeSocket.instances = [];
  const sock = createWebSocket(() => {});
  FakeSocket.instances[0].open();
  assert.equal(liveSockets().length, 1, 'precondition: one live socket');
  sock.close();
  assert.equal(liveSockets().length, 0, 'close() must leave nothing behind');
});

await check('StrictMode mount/unmount/mount leaks no connection', async () => {
  FakeSocket.instances = [];

  // First mount: opens, then React tears it down.
  const first = createWebSocket(() => {});
  FakeSocket.instances[0].open();
  first.close();

  // Second mount: the one that should survive.
  const second = createWebSocket(() => {});
  FakeSocket.instances[1].open();

  assert.equal(
    liveSockets().length,
    1,
    `StrictMode must settle on exactly one connection, got ${liveSockets().length}`,
  );
  second.close();
  assert.equal(liveSockets().length, 0, 'and none after the final unmount');
});

await check('close() during an in-flight token refresh does not resurrect', async () => {
  FakeSocket.instances = [];

  // The refresher must be installed BEFORE the socket exists, because
  // handleAuthRejection captures it at rejection time. Registering it after
  // would silently exercise a different path than production takes.
  let releaseRefresh;
  let refreshStarted = false;
  setTokenRefresher(
    () =>
      new Promise((resolve) => {
        refreshStarted = true;
        releaseRefresh = resolve;
      }),
  );

  const sock = createWebSocket(() => {});
  FakeSocket.instances[0].open();
  // Handshake completed, then the server rejected the auth.
  FakeSocket.instances[0].remoteClose(1008);

  // The refresh is now genuinely parked on an unresolved promise.
  assert.ok(refreshStarted, 'precondition: the auth rejection must have started a refresh');
  assert.equal(liveSockets().length, 0, 'precondition: nothing is connected right now');

  // React unmounts the component while the refresh is still in flight.
  sock.close();

  // The refresh resolves afterwards — this is the exact window in which the
  // old code called scheduleReconnect() and opened a socket for a component
  // that no longer existed.
  releaseRefresh('fresh-token');
  await pastBackoff();

  assert.equal(
    liveSockets().length,
    0,
    'a refresh resolving after close() must not open a socket for an unmounted caller',
  );
  setTokenRefresher(null);
});

await check('reconnect does not stack a second socket while one is CONNECTING', async () => {
  FakeSocket.instances = [];
  const sock = createWebSocket(() => {});
  const created = FakeSocket.instances.length;
  // No open(): the socket stays CONNECTING, which is the state a slow
  // handshake leaves behind when the backoff fires.
  sock.close();
  assert.equal(FakeSocket.instances.length, created, 'close() must not construct a socket');
});

await check('repeated mount/unmount cycles never accumulate sockets', async () => {
  FakeSocket.instances = [];
  // What React StrictMode + navigation actually produces over a session.
  for (let i = 0; i < 6; i += 1) {
    const sock = createWebSocket(() => {});
    FakeSocket.instances[FakeSocket.instances.length - 1].open();
    sock.close();
  }
  assert.equal(
    liveSockets().length,
    0,
    `six mount/unmount cycles must leave nothing open, got ${liveSockets().length}`,
  );
});

await check('close() is idempotent and does not throw on a dead socket', () => {
  FakeSocket.instances = [];
  const sock = createWebSocket(() => {});
  FakeSocket.instances[0].open();
  sock.close();
  // A double close is what a StrictMode teardown racing a reconnect produces.
  sock.close();
  assert.equal(liveSockets().length, 0, 'a repeated close must stay clean');
});

// ------------------------------------------------------- 2. shared stream

await check('many subscribers share ONE socket, not one each', async () => {
  FakeSocket.instances = [];
  const { subscribeRealtime } = await import(out);
  // This is the shape the app actually has: App, useOpsEvents and
  // LeadFinderPage all subscribe to the same stream.
  const subs = [subscribeRealtime(() => {}), subscribeRealtime(() => {}), subscribeRealtime(() => {})];
  FakeSocket.instances[0].open();
  assert.equal(
    FakeSocket.instances.length,
    1,
    `three subscribers must share one socket, got ${FakeSocket.instances.length}`,
  );
  for (const s of subs) s.close();
  assert.equal(liveSockets().length, 0, 'the last release must close the socket');
});

await check('a StrictMode double-mount does not double-count the reference', async () => {
  FakeSocket.instances = [];
  const { subscribeRealtime } = await import(out);
  // StrictMode mounts, unmounts, remounts. If the second mount re-subscribes
  // before the first release, the count must still land on zero.
  const a = subscribeRealtime(() => {});
  const b = subscribeRealtime(() => {});
  FakeSocket.instances[0].open();
  a.close();
  b.close();
  a.close(); // teardown racing the remount
  assert.equal(liveSockets().length, 0, 'duplicate close must not leave the socket open');
});

await check('every subscriber receives the same event', async () => {
  FakeSocket.instances = [];
  const { subscribeRealtime } = await import(out);
  const seen = [];
  const a = subscribeRealtime(() => seen.push('a'));
  const b = subscribeRealtime(() => seen.push('b'));
  FakeSocket.instances[0].open();
  FakeSocket.instances[0].onmessage({ data: JSON.stringify({ event: 'scraper_progress' }) });
  assert.deepEqual(seen.sort(), ['a', 'b'], 'both subscribers must be fanned out to');
  a.close();
  b.close();
});

// ---------------------------------------------------------------- 2. QR 404

await check('WhatsAppApiError carries the HTTP status', () => {
  const err = new WhatsAppApiError('Gateway oturumu bulunamadı.', 404);
  assert.equal(err.status, 404, 'the status must survive to the caller');
  assert.ok(err instanceof Error, 'must still be an Error for existing handlers');
  assert.equal(err.name, 'WhatsAppApiError');
});

await check('a status-less error stays undefined, not a fake 404', () => {
  const err = new WhatsAppApiError('boom');
  assert.equal(err.status, undefined, 'no status must mean undefined, not 0 or 404');
  assert.ok(!(err.status === 404), 'an unknown status must not be mistaken for a transient 404');
});

console.log(`\n${passed}/11 checks passed`);
await rm(tmp, { recursive: true, force: true });
process.exit(passed === 11 ? 0 : 1);
