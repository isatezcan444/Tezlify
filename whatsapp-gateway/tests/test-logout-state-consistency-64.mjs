/**
 * PHASE 6.4 — Provider logout state consistency.
 *
 * Drives the REAL `session-manager` logout path (and the REAL
 * `bindSocketEvents` connection handler for the close-during-logout race)
 * against fake provider sockets and a fake auth/persistence boundary. No
 * WhatsApp account, network or PostgreSQL server is involved: this is L3
 * evidence (logic/integration against faked external boundaries), not L4.
 *
 * Run with:
 *   node --import ./tests/lid-durability-test-register.mjs \
 *        tests/test-logout-state-consistency-64.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

const AES_KEY = crypto.createHash('sha256').update('phase-6.4-logout-state').digest();
const SESSION_A = 'logout-64-a';
const SESSION_B = 'logout-64-b';

/** Generic empty-result fake for the repos the manager touches on create/logout. */
class FakePool {
  async query() {
    return { rows: [], rowCount: 0 };
  }
}

function createFakeAuthRepository() {
  const log = { registerSession: [], clearAuth: [], setSessionActive: [] };
  const state = {
    clearAuthImpl: async () => {},
    setSessionActiveImpl: async () => {},
  };
  return {
    log,
    state,
    registerSession: async (id, name, options) => {
      log.registerSession.push([id, name, options]);
    },
    clearAuth: async (id) => {
      log.clearAuth.push(id);
      return state.clearAuthImpl(id);
    },
    setSessionActive: async (id, active) => {
      log.setSessionActive.push([id, active]);
      return state.setSessionActiveImpl(id, active);
    },
    listRestorableSessions: async () => [],
  };
}

function createFakeSock({ logoutImpl } = {}) {
  const state = {
    logoutCalls: 0,
    endCalls: 0,
    removeAllListenersCalls: 0,
    handlers: new Map(),
  };
  const sock = {
    state,
    user: { id: '905550000001:1@s.whatsapp.net', lid: '11111111111111:1@lid' },
    ev: {
      on(event, handler) {
        if (!state.handlers.has(event)) state.handlers.set(event, []);
        state.handlers.get(event).push(handler);
      },
      removeAllListeners() {
        state.removeAllListenersCalls += 1;
        state.handlers.clear();
      },
    },
    logout: async () => {
      state.logoutCalls += 1;
      if (logoutImpl) return logoutImpl();
      return undefined;
    },
    end: () => {
      state.endCalls += 1;
    },
    sendMessage: async () => ({}),
    fetchMessageHistory: async () => ({}),
  };
  return sock;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-logout-64-'));
  const auth = createFakeAuthRepository();
  const manager = createSessionManager({
    sessionsDir: path.join(root, 'sessions'),
    mediaDir: path.join(root, 'media'),
    aesKey: AES_KEY,
    backendWsUrl: 'ws://127.0.0.1:1',
    authRepository: auth,
    pool: new FakePool(),
    instanceId: 'phase-6.4-test',
  });
  return { root, manager, auth };
}

function sessionDir(root, id) {
  return path.join(root, 'sessions', id);
}

function seedSessionDir(root, id) {
  const dir = sessionDir(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), '{"registered":true}');
  return dir;
}

async function connectedSession(manager, id, sock) {
  const session = await manager.createSession(`test-${id}`, { autoStart: false, id });
  session.sock = sock;
  session.status = 'CONNECTED';
  session.is_active = true;
  session.is_phone_online = true;
  session.lifecycle.attach(session.lifecycle.generation, sock);
  return session;
}

function attachRecorder(manager) {
  const events = [];
  manager.onEvent((event) => {
    events.push(event);
  });
  return {
    events,
    named: (name) => events.filter((event) => event?.event === name),
  };
}

async function withHarness(fn) {
  const harness = createHarness();
  try {
    return await fn(harness);
  } finally {
    try { await harness.manager.shutdown(); } catch { /* test cleanup */ }
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
}

function assertDisconnected(session) {
  assert.equal(session.status, 'DISCONNECTED');
  assert.equal(session.is_active, false);
  assert.equal(session.is_phone_online, false);
  assert.equal(session.sock, null);
}

// ---------------------------------------------------------------------------
// A. Successful provider logout — existing behaviour preserved.
// ---------------------------------------------------------------------------

test('A. successful provider logout reaches a consistent final state', async () => {
  await withHarness(async ({ root, manager, auth }) => {
    const recorder = attachRecorder(manager);
    const sock = createFakeSock();
    const session = await connectedSession(manager, SESSION_A, sock);
    const dir = seedSessionDir(root, SESSION_A);

    const result = await manager.logoutSession(SESSION_A);

    assert.equal(result, session);
    assertDisconnected(session);
    assert.equal(sock.state.logoutCalls, 1, 'provider logout called once');
    assert.equal(sock.state.endCalls, 1, 'old socket closed locally');
    assert.equal(auth.log.clearAuth.length, 1, 'persistent auth cleared');
    assert.equal(auth.log.clearAuth[0], SESSION_A);
    assert.deepEqual(auth.log.setSessionActive, [[SESSION_A, false]]);
    assert.equal(fs.existsSync(dir), false, 'session directory removed');
    assert.equal(recorder.named('session_disconnected').length, 1);

    // Repeat is idempotent: no second provider call, no duplicated teardown.
    const again = await manager.logoutSession(SESSION_A);
    assert.equal(again, session);
    assertDisconnected(session);
    assert.equal(sock.state.logoutCalls, 1);
    assert.equal(sock.state.endCalls, 1);
    assert.equal(auth.log.clearAuth.length, 1);
    assert.equal(recorder.named('session_disconnected').length, 1);
  });
});

// ---------------------------------------------------------------------------
// B. Provider logout rejection — never CONNECTED, error observable, local
//    cleanup completed, failure never reported as success.
// ---------------------------------------------------------------------------

test('B. provider logout rejection leaves DISCONNECTED and surfaces the error', async () => {
  await withHarness(async ({ root, manager, auth }) => {
    const recorder = attachRecorder(manager);
    const sock = createFakeSock({
      logoutImpl: async () => {
        throw new Error('provider unlink rejected');
      },
    });
    const session = await connectedSession(manager, SESSION_A, sock);
    const dir = seedSessionDir(root, SESSION_A);

    const err = await manager.logoutSession(SESSION_A).then(
      () => { throw new Error('logout must not resolve on provider failure'); },
      (error) => error,
    );

    assertDisconnected(session);
    assert.match(err.message, /provider unlink rejected/);
    assert.equal(err.logoutReason, 'provider');
    assert.equal(err.localStatus, 'DISCONNECTED');
    assert.equal(err.providerError, 'provider unlink rejected');
    assert.equal(err.cleanupErrors, null);
    // Local cleanup still completed.
    assert.equal(sock.state.logoutCalls, 1);
    assert.equal(sock.state.endCalls, 1);
    assert.deepEqual(auth.log.clearAuth, [SESSION_A]);
    assert.deepEqual(auth.log.setSessionActive, [[SESSION_A, false]]);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(recorder.named('session_disconnected').length, 1);

    // A repeat without force keeps reporting the provider failure (no false
    // success) and does not re-run the provider call.
    const repeatErr = await manager.logoutSession(SESSION_A).then(
      () => { throw new Error('repeat logout must not resolve'); },
      (error) => error,
    );
    assert.equal(repeatErr.logoutReason, 'provider');
    assert.match(repeatErr.message, /provider unlink rejected/);
    assert.equal(sock.state.logoutCalls, 1);
    assert.equal(auth.log.clearAuth.length, 1);

    // `force` explicitly accepts the provider failure.
    const forced = await manager.logoutSession(SESSION_A, { force: true });
    assertDisconnected(forced);
    assert.equal(sock.state.logoutCalls, 1);
  });
});

// ---------------------------------------------------------------------------
// C. Provider logout hang — bounded wait, no ghost CONNECTED state.
// ---------------------------------------------------------------------------

test('C. provider logout timeout does not leave a connected session', async () => {
  await withHarness(async ({ root, manager, auth }) => {
    const gate = deferred();
    const sock = createFakeSock({ logoutImpl: () => gate.promise });
    const session = await connectedSession(manager, SESSION_A, sock);
    const dir = seedSessionDir(root, SESSION_A);

    const started = Date.now();
    const err = await manager.logoutSession(SESSION_A, { providerLogoutTimeoutMs: 40 }).then(
      () => { throw new Error('logout must not resolve on timeout'); },
      (error) => error,
    );
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2000, `logout must be bounded, took ${elapsed}ms`);
    assert.match(err.message, /timed out/i);
    assert.equal(err.logoutReason, 'provider');
    assert.equal(err.localStatus, 'DISCONNECTED');
    assertDisconnected(session);
    assert.equal(sock.state.endCalls, 1, 'local socket closed despite the hang');
    assert.deepEqual(auth.log.clearAuth, [SESSION_A]);
    assert.equal(fs.existsSync(dir), false);

    // The provider promise settling later must not resurrect any state.
    gate.resolve();
    await tick();
    assertDisconnected(session);
    assert.equal(auth.log.clearAuth.length, 1);
    assert.equal(sock.state.endCalls, 1);
  });
});

// ---------------------------------------------------------------------------
// D. Socket close during logout — the real connection handler must treat the
//    event as stale; no double cleanup and no conflicting status.
// ---------------------------------------------------------------------------

function bindRealConnectionHandler(manager, session, sock, root) {
  const sessionsMap = new Map([[session.id, session]]);
  const noop = () => {};
  const generation = session.lifecycle.generation;
  bindSocketEvents({
    id: session.id,
    session,
    generation,
    sock,
    state: {},
    saveCreds: async () => {},
    connectStarted: Date.now(),
    sessionDir: sessionDir(root, session.id),
    manager,
    sessions: sessionsMap,
    leaseCoordinator: {
      clearLeaseTimers: noop,
      releaseLease: async () => {},
      armLeaseRenewal: noop,
    },
    lidRepository: {},
    mediaStore: {},
    authRepository: null,
    leaseRepository: null,
    instanceId: 'phase-6.4-test',
    aesKey: AES_KEY,
    logger: {
      info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
      child() { return this; },
    },
    pendingHistoryWaiters: new Map(),
    inFlightHistoryFetches: new Map(),
    resetRetryCounterCache: noop,
    clearSessionHistoryFetches: noop,
    deactivatePersistentSession: async () => {},
    armLeaseRenewal: noop,
  });
  const handlers = sock.state.handlers.get('connection.update') || [];
  assert.ok(handlers.length > 0, 'connection.update handler must be bound');
  return handlers[0];
}

test('D. socket close during logout runs no second cleanup', async () => {
  await withHarness(async ({ root, manager, auth }) => {
    const recorder = attachRecorder(manager);
    const gate = deferred();
    const sock = createFakeSock({ logoutImpl: () => gate.promise });
    const session = await connectedSession(manager, SESSION_A, sock);
    seedSessionDir(root, SESSION_A);

    const closeHandler = bindRealConnectionHandler(manager, session, sock, root);

    const op = manager.logoutSession(SESSION_A);
    await tick();
    // Logout left CONNECTED before awaiting the provider.
    assertDisconnected(session);

    // The provider closes the socket while `sock.logout()` is still pending.
    await closeHandler({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await tick();

    gate.resolve();
    await op;

    assertDisconnected(session);
    assert.equal(sock.state.logoutCalls, 1);
    assert.equal(sock.state.endCalls, 1, 'the close event must not close again');
    assert.equal(auth.log.clearAuth.length, 1, 'no second auth cleanup');
    assert.equal(session.lifecycle.hasReconnectTimer, false, 'no reconnect armed by the stale close');
    assert.equal(recorder.named('session_disconnected').length, 1);
  });
});

// ---------------------------------------------------------------------------
// E. Logout/reconnect race — the old logout callback must not overwrite or
//    tear down the new generation.
// ---------------------------------------------------------------------------

test('E. reconnect during logout is not overwritten or closed by the old callback', async () => {
  await withHarness(async ({ root, manager, auth }) => {
    const recorder = attachRecorder(manager);
    const gate = deferred();
    const oldSock = createFakeSock({ logoutImpl: () => gate.promise });
    const session = await connectedSession(manager, SESSION_A, oldSock);
    const dir = seedSessionDir(root, SESSION_A);

    const op = manager.logoutSession(SESSION_A);
    await tick();

    // A fresh connection attempt wins during the provider await.
    const newSock = createFakeSock();
    const newGeneration = session.lifecycle.beginAttempt();
    session.lifecycle.attach(newGeneration, newSock);
    session.sock = newSock;
    session.status = 'CONNECTING';
    session.is_active = true;
    session.is_phone_online = false;

    gate.resolve();
    const result = await op;

    assert.equal(result, session);
    assert.equal(session.sock, newSock, 'new socket stays attached');
    assert.equal(session.status, 'CONNECTING', 'old logout must not force DISCONNECTED again');
    assert.equal(session.is_active, true);
    assert.equal(newSock.state.endCalls, 0, 'new connection must not be closed');
    assert.equal(newSock.state.removeAllListenersCalls, 0);
    assert.deepEqual(auth.log.clearAuth, [], 'new credentials must not be cleared');
    assert.deepEqual(auth.log.setSessionActive, []);
    assert.equal(fs.existsSync(dir), true, 'new session directory preserved');
    assert.equal(recorder.named('session_disconnected').length, 0);
    assert.equal(oldSock.state.endCalls, 1, 'only the old socket is closed');
    assert.notEqual(session._logoutCompleted, true);
  });
});

// ---------------------------------------------------------------------------
// F. Concurrent logout — coalesced, single teardown, consistent result.
// ---------------------------------------------------------------------------

test('F. concurrent logout calls share one idempotent teardown', async () => {
  await withHarness(async ({ root, manager, auth }) => {
    const recorder = attachRecorder(manager);
    const gate = deferred();
    const sock = createFakeSock({ logoutImpl: () => gate.promise });
    const session = await connectedSession(manager, SESSION_A, sock);
    seedSessionDir(root, SESSION_A);

    const first = manager.logoutSession(SESSION_A);
    const second = manager.logoutSession(SESSION_A);
    await tick();
    gate.resolve();
    const [r1, r2] = await Promise.all([first, second]);

    assert.equal(r1, session);
    assert.equal(r2, session);
    assertDisconnected(session);
    assert.equal(sock.state.logoutCalls, 1, 'provider logout coalesced');
    assert.equal(sock.state.endCalls, 1);
    assert.equal(auth.log.clearAuth.length, 1);
    assert.equal(recorder.named('session_disconnected').length, 1);
  });
});

// ---------------------------------------------------------------------------
// G. Session isolation — one session's failure must not touch another.
// ---------------------------------------------------------------------------

test('G. a provider failure on one session does not affect another session', async () => {
  await withHarness(async ({ root, manager, auth }) => {
    const failingSock = createFakeSock({
      logoutImpl: async () => {
        throw new Error('provider unlink rejected for A');
      },
    });
    const healthySock = createFakeSock();
    const sessionA = await connectedSession(manager, SESSION_A, failingSock);
    const sessionB = await connectedSession(manager, SESSION_B, healthySock);
    seedSessionDir(root, SESSION_A);
    const dirB = seedSessionDir(root, SESSION_B);

    await assert.rejects(manager.logoutSession(SESSION_A), /provider unlink rejected for A/);

    assertDisconnected(sessionA);
    assert.equal(sessionB.status, 'CONNECTED');
    assert.equal(sessionB.sock, healthySock);
    assert.equal(healthySock.state.logoutCalls, 0);
    assert.equal(healthySock.state.endCalls, 0);
    assert.deepEqual(auth.log.clearAuth, [SESSION_A], 'only the failing session was cleared');
    assert.equal(fs.existsSync(dirB), true, 'other session directory untouched');

    // The healthy session still logs out normally afterwards.
    const result = await manager.logoutSession(SESSION_B);
    assertDisconnected(result);
    assert.equal(healthySock.state.logoutCalls, 1);
  });
});

// ---------------------------------------------------------------------------
// Distinguish a local cleanup failure from a provider failure.
// ---------------------------------------------------------------------------

test('local cleanup failure is reported distinctly and never as provider failure', async () => {
  await withHarness(async ({ root, manager, auth }) => {
    const sock = createFakeSock();
    const session = await connectedSession(manager, SESSION_A, sock);
    seedSessionDir(root, SESSION_A);
    auth.state.clearAuthImpl = async () => {
      throw new Error('credential store unavailable');
    };

    const err = await manager.logoutSession(SESSION_A).then(
      () => { throw new Error('logout must not resolve on cleanup failure'); },
      (error) => error,
    );

    assert.equal(err.logoutReason, 'cleanup');
    assert.equal(err.localStatus, 'DISCONNECTED');
    assert.match(err.message, /credential store unavailable/);
    assert.equal(err.providerError, null);
    assertDisconnected(session);
    assert.equal(sock.state.logoutCalls, 1);
    assert.notEqual(session._logoutCompleted, true, 'a failed cleanup stays retryable');

    // The retry (provider already gone) completes the cleanup and succeeds.
    auth.state.clearAuthImpl = async () => {};
    await manager.logoutSession(SESSION_A);
    assert.equal(auth.log.clearAuth.length, 2);
    assertDisconnected(session);
  });
});
