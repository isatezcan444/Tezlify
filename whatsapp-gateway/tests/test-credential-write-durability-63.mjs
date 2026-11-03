/**
 * Phase 6.3 — WhatsApp credential write durability.
 *
 * Real-storage tests. The PostgreSQL cases run against an isolated LOCAL
 * database (`TZ63_PG_URL`), never production, and skip cleanly when a real `pg`
 * driver URL is not provided. The disk cases write REAL files through the
 * production `saveCreds` branch (`useMultiFileAuthState` test double writes to
 * the filesystem; the assertion reads the file back).
 *
 * Coverage maps to the brief:
 *   A normal write, B write failure, C sequential, D concurrent ordering,
 *   E bounded retry, F session isolation, G restart/ACK truthfulness,
 *   plus the creds.update handler and the disk branch.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPostgresAuthRepository } from '../src/auth/postgres-auth-repository.js';
import { createSocketForSession } from '../src/socket/socket-connector.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

const HAS_REAL_PG = Boolean(process.env.TZ63_PG_MODULE_URL);
const PG_URL = process.env.TZ63_PG_URL
  || 'postgresql://isatezcan@localhost:5432/tezlify_62_isolated';
const PREFIX = 'tz63-';
const ENCRYPTION_KEY = crypto.createHash('sha256').update('tz63-isolated-test-key').digest();

const pgModule = HAS_REAL_PG ? (await import('pg')).default : null;
let adminPool = null;

const quietLogger = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return quietLogger; },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function creds(tag) {
  return {
    registered: true,
    me: { id: `9055500000${tag}@s.whatsapp.net`, name: `Cred ${tag}` },
    myAppStateKeyId: `key-${tag}`,
  };
}

function makeRepo(overrides = {}) {
  return createPostgresAuthRepository({
    connectionString: PG_URL,
    encryptionKey: ENCRYPTION_KEY,
    credentialWriteRetryDelaysMs: [],
    ...overrides,
  });
}

/**
 * Wraps the REAL pool. `handler(sql, params, run)` may delay, reject, or count,
 * but `run()` is the only path that touches the database.
 */
function wrapPool(realPool, handler) {
  return {
    query: (sql, params) => handler(String(sql), params || [], () => realPool.query(sql, params)),
    connect: (...args) => realPool.connect(...args),
    end: async () => {},
  };
}

async function wipe() {
  if (!adminPool) return;
  await adminPool.query(
    `DELETE FROM whatsapp_private.session_credentials WHERE session_id LIKE '${PREFIX}%'`,
  );
  await adminPool.query(
    `DELETE FROM whatsapp_private.gateway_sessions WHERE session_id LIKE '${PREFIX}%'`,
  );
}

before(async () => {
  if (!HAS_REAL_PG) return;
  adminPool = new pgModule.Pool({ connectionString: PG_URL, max: 4 });
  await wipe();
});

beforeEach(async () => {
  await wipe();
});

after(async () => {
  await wipe();
  if (adminPool) await adminPool.end();
});

test('A: a normal credential update is awaited and reloads from storage', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}a`;
  const repo = makeRepo();
  await repo.registerSession(sid, 'A');
  const value = creds('a');

  await repo.saveCredentials(sid, value);

  const reloaded = makeRepo();
  assert.deepEqual(await reloaded.loadCredentials(sid), value);
  const state = repo.getCredentialWriteState(sid);
  assert.equal(state.pendingWrites, 0);
  assert.equal(state.lastError, null);
  await repo.close();
  await reloaded.close();
});

test('B: a storage failure rejects, is recorded, and is not treated as persisted', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}b`;
  const good = makeRepo();
  await good.registerSession(sid, 'B');
  const first = creds('b1');
  await good.saveCredentials(sid, first);

  const endedPool = new pgModule.Pool({ connectionString: PG_URL, max: 1 });
  await endedPool.end();
  const broken = makeRepo({ pool: endedPool, credentialWriteRetryDelaysMs: [] });

  await assert.rejects(() => broken.saveCredentials(sid, creds('b2')));

  const state = broken.getCredentialWriteState(sid);
  assert.ok(state.lastError, 'the failure must be visible in the write state');
  assert.equal(state.pendingWrites, 0);
  assert.deepEqual(await good.loadCredentials(sid), first, 'failed write must not be a success');
  await good.close();
});

test('C: sequential updates persist the newest credential', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}c`;
  const repo = makeRepo();
  await repo.registerSession(sid, 'C');

  await repo.saveCredentials(sid, creds('c1'));
  await repo.saveCredentials(sid, creds('c2'));

  assert.deepEqual(await repo.loadCredentials(sid), creds('c2'));
  const row = await adminPool.query(
    'SELECT version FROM whatsapp_private.session_credentials WHERE session_id = $1',
    [sid],
  );
  assert.equal(Number(row.rows[0].version), 2);
  await repo.close();
});

test('D: concurrent updates are serialized; an older write cannot overwrite the newer one', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}d`;
  let credentialWrites = 0;
  const wrapper = wrapPool(adminPool, async (sql, params, run) => {
    if (sql.includes('INSERT INTO whatsapp_private.session_credentials')) {
      credentialWrites += 1;
      // The FIRST write is slow. Without per-session serialization the second
      // write would commit first and the old payload would land last.
      if (credentialWrites === 1) await sleep(200);
    }
    return run();
  });
  const repo = makeRepo({ pool: wrapper, credentialWriteRetryDelaysMs: [] });
  await repo.registerSession(sid, 'D');

  const oldWrite = repo.saveCredentials(sid, { ...creds('d1'), marker: 'old' });
  const newWrite = repo.saveCredentials(sid, { ...creds('d2'), marker: 'new' });
  await Promise.all([oldWrite, newWrite]);

  const stored = await repo.loadCredentials(sid);
  assert.equal(stored.marker, 'new', 'the newest update must win');
  assert.equal(credentialWrites, 2, 'both writes must reach storage, in order');
});

test('E1: a transient failure is retried a bounded number of times and then succeeds', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}e1`;
  let attempts = 0;
  const wrapper = wrapPool(adminPool, async (sql, params, run) => {
    if (sql.includes('INSERT INTO whatsapp_private.session_credentials')) {
      attempts += 1;
      if (attempts <= 2) throw new Error('injected transient credential failure');
    }
    return run();
  });
  const repo = makeRepo({ pool: wrapper, credentialWriteRetryDelaysMs: [0, 0, 0] });
  await repo.registerSession(sid, 'E1');

  await repo.saveCredentials(sid, creds('e1'));
  assert.equal(attempts, 3, 'two failures + one success, no infinite loop');
  assert.deepEqual(await repo.loadCredentials(sid), creds('e1'));
});

test('E2: persistent failure stops after the bounded retries and never loops', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}e2`;
  let attempts = 0;
  const wrapper = wrapPool(adminPool, async (sql, params, run) => {
    if (sql.includes('INSERT INTO whatsapp_private.session_credentials')) {
      attempts += 1;
      throw new Error('persistent credential failure');
    }
    return run();
  });
  const repo = makeRepo({ pool: wrapper, credentialWriteRetryDelaysMs: [0, 0] });
  await repo.registerSession(sid, 'E2');

  await assert.rejects(() => repo.saveCredentials(sid, creds('e2')));
  assert.equal(attempts, 3, 'one attempt + two retries, then stop');
  assert.equal(repo.getCredentialWriteState(sid).pendingWrites, 0);
});

test('F: one session failure does not block or corrupt another session', { skip: !HAS_REAL_PG }, async () => {
  const sidA = `${PREFIX}f-a`;
  const sidB = `${PREFIX}f-b`;
  const wrapper = wrapPool(adminPool, async (sql, params, run) => {
    if (sql.includes('INSERT INTO whatsapp_private.session_credentials') && params[0] === sidA) {
      throw new Error('session A storage failure');
    }
    return run();
  });
  const repo = makeRepo({ pool: wrapper, credentialWriteRetryDelaysMs: [] });
  await repo.registerSession(sidA, 'F-A');
  await repo.registerSession(sidB, 'F-B');

  const failing = assert.rejects(repo.saveCredentials(sidA, creds('fa')));
  const succeeding = repo.saveCredentials(sidB, creds('fb'));
  await succeeding;
  await failing;

  assert.deepEqual(await repo.loadCredentials(sidB), creds('fb'));
  assert.equal(await repo.loadCredentials(sidA), null);
});

test('G: no persistence is claimed before the write completes; restart reloads it', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}g`;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = false;
  const wrapper = wrapPool(adminPool, async (sql, params, run) => {
    if (sql.includes('INSERT INTO whatsapp_private.session_credentials') && !gated) {
      gated = true;
      await gate;
    }
    return run();
  });
  const repo = makeRepo({ pool: wrapper, credentialWriteRetryDelaysMs: [] });
  await repo.registerSession(sid, 'G');

  const pending = repo.saveCredentials(sid, creds('g'));
  await sleep(30);
  assert.equal(repo.getCredentialWriteState(sid).pendingWrites, 1, 'write is still in flight');
  assert.equal(await repo.loadCredentials(sid), null, 'no persistence claim before ACK');

  release();
  await pending;
  assert.equal(repo.getCredentialWriteState(sid).pendingWrites, 0);

  const restarted = makeRepo();
  assert.deepEqual(await restarted.loadCredentials(sid), creds('g'));
  await restarted.close();
});

test('G2: flushCredentialWrites drains an in-flight write (shutdown path)', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}g2`;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = false;
  const wrapper = wrapPool(adminPool, async (sql, params, run) => {
    if (sql.includes('INSERT INTO whatsapp_private.session_credentials') && !gated) {
      gated = true;
      await gate;
    }
    return run();
  });
  const repo = makeRepo({ pool: wrapper, credentialWriteRetryDelaysMs: [] });
  await repo.registerSession(sid, 'G2');

  const pending = repo.saveCredentials(sid, creds('g2'));
  await sleep(20);
  const flush = repo.flushCredentialWrites(sid);
  setTimeout(release, 30);
  await flush;
  await pending;

  assert.deepEqual(await repo.loadCredentials(sid), creds('g2'));
  assert.equal(repo.getCredentialWriteState(sid).pendingWrites, 0);
});

test('socket: saveCreds surfaces PG failure and marks the session non-durable', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}sock-fail`;
  const wrapper = wrapPool(adminPool, async (sql, params, run) => {
    if (sql.includes('INSERT INTO whatsapp_private.session_credentials')) {
      throw new Error('injected socket credential failure');
    }
    return run();
  });
  const repo = makeRepo({ pool: wrapper, credentialWriteRetryDelaysMs: [] });
  await repo.registerSession(sid, 'SockFail');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tz63-sock-fail-'));
  const session = { store: {}, ephemeral: false, session_name: 'SockFail' };

  try {
    const created = await createSocketForSession({
      id: sid,
      session,
      generation: 1,
      sessionsDir: tmp,
      aesKey: ENCRYPTION_KEY,
      authRepository: repo,
      logger: quietLogger,
      retryCounterCacheFor: () => ({}),
    });
    created.state.creds.registered = true;
    created.state.creds.me = { id: '905550000099:1@s.whatsapp.net', name: 'SockFail' };

    assert.equal(typeof session.saveCreds, 'function', 'self-heal paths need session.saveCreds');
    await assert.rejects(() => created.saveCreds());
    assert.equal(session._credentialsDurable, false);
    assert.match(String(session._credentialWriteError), /socket credential failure/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('socket: a successful PG write is durable and written exactly once', { skip: !HAS_REAL_PG }, async () => {
  const sid = `${PREFIX}sock-ok`;
  let credentialWrites = 0;
  const wrapper = wrapPool(adminPool, async (sql, params, run) => {
    if (sql.includes('INSERT INTO whatsapp_private.session_credentials')) credentialWrites += 1;
    return run();
  });
  const repo = makeRepo({ pool: wrapper, credentialWriteRetryDelaysMs: [] });
  await repo.registerSession(sid, 'SockOk');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tz63-sock-ok-'));
  const session = { store: {}, ephemeral: false, session_name: 'SockOk' };

  try {
    const created = await createSocketForSession({
      id: sid,
      session,
      generation: 1,
      sessionsDir: tmp,
      aesKey: ENCRYPTION_KEY,
      authRepository: repo,
      logger: quietLogger,
      retryCounterCacheFor: () => ({}),
    });
    created.state.creds.registered = true;
    created.state.creds.me = { id: '905550000098:1@s.whatsapp.net', name: 'SockOk' };

    await created.saveCreds();

    assert.equal(session._credentialsDurable, true);
    assert.equal(credentialWrites, 1, 'credentials must not be written twice per update');
    assert.deepEqual(await repo.loadCredentials(sid), created.state.creds);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('disk branch: credentials are written to a real file and failures propagate', async () => {
  const sid = `${PREFIX}file`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tz63-file-'));
  const session = { store: {}, ephemeral: false, session_name: 'File' };

  try {
    const created = await createSocketForSession({
      id: sid,
      session,
      generation: 1,
      sessionsDir: tmp,
      aesKey: ENCRYPTION_KEY,
      authRepository: null,
      logger: quietLogger,
      retryCounterCacheFor: () => ({}),
    });
    created.state.creds.registered = true;
    created.state.creds.me = { id: '905550000097:1@s.whatsapp.net', name: 'File' };
    await created.saveCreds();

    const credsFile = path.join(tmp, sid, 'creds.json');
    const persisted = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
    assert.equal(persisted.registered, true);
    assert.equal(session._credentialsDurable, true);

    // Remove the file and make the directory read-only: the next write MUST fail
    // and MUST reach the caller instead of being swallowed.
    fs.rmSync(credsFile);
    fs.chmodSync(path.dirname(credsFile), 0o500);
    await assert.rejects(() => created.saveCreds());
    assert.equal(session._credentialsDurable, false);
  } finally {
    fs.chmodSync(path.join(tmp, sid), 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('creds.update handler logs the failure instead of swallowing it', async () => {
  const handlers = new Map();
  const sock = {
    ev: {
      on(event, handler) { handlers.set(event, handler); },
      emit() {},
      removeAllListeners() {},
    },
    sendNode: async () => {},
    sendPresenceUpdate: async () => {},
    query: async () => ({}),
    end() {},
  };
  const store = { contacts: new Map(), chats: new Map(), messagesByChat: new Map() };
  const logs = [];
  const logger = {
    ...quietLogger,
    error(fields, message) { logs.push({ fields, message }); },
  };
  let saveCalls = 0;

  bindSocketEvents({
    id: `${PREFIX}event`,
    session: { lifecycle: { generation: 1, isCurrent: () => true } },
    generation: 1,
    sock,
    state: { creds: {} },
    saveCreds: async () => { saveCalls += 1; throw new Error('event write failure'); },
    connectStarted: 0,
    sessionDir: os.tmpdir(),
    manager: { _storeOf: () => store },
    sessions: new Map(),
    leaseCoordinator: {},
    lidRepository: {},
    mediaStore: {},
    authRepository: null,
    leaseRepository: null,
    instanceId: 'tz63',
    aesKey: null,
    logger,
    pendingHistoryWaiters: new Map(),
    inFlightHistoryFetches: new Map(),
    resetRetryCounterCache: () => {},
    clearSessionHistoryFetches: () => {},
    deactivatePersistentSession: async () => {},
    armLeaseRenewal: () => {},
  });

  const handler = handlers.get('creds.update');
  assert.equal(typeof handler, 'function', 'creds.update must be registered');
  await handler();

  assert.equal(saveCalls, 1);
  assert.ok(
    logs.some((entry) => /auth state write failed/i.test(String(entry.message))),
    'the failure must be logged at error level',
  );
});
