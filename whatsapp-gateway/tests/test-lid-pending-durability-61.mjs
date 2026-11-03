/**
 * PHASE 6.1 — Unknown-LID pending message durability.
 *
 * These tests drive the REAL `session-manager` ingestion and release paths
 * against an in-memory fake of the `whatsapp_private.lid_pending_messages`
 * contract. No PostgreSQL server, no WhatsApp account and no network access is
 * involved; controlled failures are injected through the fake pool and the
 * event listener. That makes this evidence L3 (logic/integration with a fake
 * persistence boundary), not L4.
 *
 * Run with:
 *   node --import ./tests/lid-durability-test-register.mjs \
 *        tests/test-lid-pending-durability-61.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionManager } from '../src/session-manager.js';
import { pendingLidEventId } from '../src/lid/pending-lid-repository.js';

const AES_KEY = crypto.createHash('sha256').update('phase-6.1-lid-durability').digest();
const LID = '11111111111111@lid';
const PHONE = '905551112233@s.whatsapp.net';
const SESSION_A = 'session-tenant-a';
const SESSION_B = 'session-tenant-b';

/** Fake of the private-schema pending table + the queries other repos issue. */
class FakePool {
  constructor() {
    this.rows = new Map();
    this.seq = 0;
    this.failures = { insert: 0, select: 0, delete: 0, mappingInsert: 0 };
    this.queryLog = [];
  }

  static key(sessionId, lidJid, waMessageId) {
    return `${sessionId}|${lidJid}|${waMessageId}`;
  }

  pendingRows(sessionId = null) {
    return [...this.rows.values()].filter((row) => !sessionId || row.session_id === sessionId);
  }

  failNext(kind, count = 1) {
    this.failures[kind] = (this.failures[kind] || 0) + count;
  }

  takeFailure(kind) {
    if (this.failures[kind] > 0) {
      this.failures[kind] -= 1;
      const err = new Error(`injected ${kind} failure`);
      err.code = '57P01';
      throw err;
    }
  }

  async query(sql, params = []) {
    this.queryLog.push({ sql, params });

    if (sql.includes('lid_pending_messages')) {
      const trimmed = sql.trim();
      if (trimmed.startsWith('INSERT')) {
        this.takeFailure('insert');
        const [sessionId, lidJid, waMessageId, eventId, upsertType,
          ciphertext, nonce, authTag, keyVersion] = params;
        const key = FakePool.key(sessionId, lidJid, waMessageId);
        if (!this.rows.has(key)) {
          this.seq += 1;
          this.rows.set(key, {
            session_id: sessionId,
            lid_jid: lidJid,
            wa_message_id: waMessageId,
            event_id: eventId,
            upsert_type: upsertType,
            ciphertext,
            nonce,
            auth_tag: authTag,
            key_version: keyVersion,
            created_at: new Date(1700000000000 + this.seq).toISOString(),
          });
        }
        return { rowCount: 1, rows: [] };
      }
      if (trimmed.startsWith('DELETE')) {
        this.takeFailure('delete');
        const [sessionId, lidJid, waMessageId] = params;
        const deleted = this.rows.delete(FakePool.key(sessionId, lidJid, waMessageId));
        return { rowCount: deleted ? 1 : 0, rows: [] };
      }
      if (trimmed.startsWith('SELECT')) {
        this.takeFailure('select');
        let list = this.pendingRows(params[0]);
        if (params.length > 1 && sql.includes('lid_jid = $2')) {
          list = list.filter((row) => row.lid_jid === params[1]);
        }
        list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))
          || String(a.wa_message_id).localeCompare(String(b.wa_message_id)));
        return { rows: list.map((row) => ({ ...row })) };
      }
    }

    if (sql.includes('lid_mappings') && sql.trim().startsWith('INSERT')) {
      this.takeFailure('mappingInsert');
      return { rowCount: 1, rows: [] };
    }

    // Session owner / contact hydration queries: no rows in this harness.
    return { rows: [], rowCount: 0 };
  }
}

function makeSock() {
  return {
    user: { id: '905550000000:1@s.whatsapp.net', lid: '99999999999999:1@lid' },
    ev: { on() {}, removeAllListeners() {} },
    sendMessage: async () => ({}),
    fetchMessageHistory: async () => ({}),
  };
}

function newManager(pool, root) {
  return createSessionManager({
    sessionsDir: path.join(root, 'sessions'),
    mediaDir: path.join(root, 'media'),
    aesKey: AES_KEY,
    backendWsUrl: 'ws://127.0.0.1:1',
    pool,
    instanceId: 'phase-6.1-test',
  });
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tz-lid-61-'));
}

async function newSession(manager, id = SESSION_A) {
  const session = await manager.createSession(`test-${id}`, { autoStart: false, id });
  session.sock = makeSock();
  session.status = 'CONNECTED';
  return session;
}

/**
 * Event listener that records everything and lets a test decide whether a
 * `message_new` enqueue is durable, rejected, or non-durable. This is the exact
 * contract `events.js` exposes to `_emit` (`{durable: true|false}`).
 */
function attachRecorder(manager) {
  const events = [];
  const control = { durable: true, reject: false };
  manager.onEvent((event) => {
    events.push(event);
    if (event?.event !== 'message_new') return undefined;
    if (control.reject) {
      return Promise.reject(new Error('injected event delivery failure'));
    }
    return Promise.resolve({ durable: control.durable });
  });
  return {
    events,
    control,
    messageNew: () => events.filter((event) => event?.event === 'message_new'),
  };
}

function lidMessage({
  lid = LID,
  id = 'WA-LID-1',
  ts = 1700000000,
  text = 'bilinmeyen lid mesaji',
} = {}) {
  return {
    key: { remoteJid: lid, id, fromMe: false },
    message: { conversation: text },
    messageTimestamp: ts,
    pushName: 'Test Kisi',
  };
}

async function waitFor(predicate, { timeout = 3000, interval = 5 } = {}) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeout) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function waitForReleaseIdle(session) {
  await waitFor(() => session._pendingLidReleaseInFlight !== true);
}

async function withHarness(fn, { pool = new FakePool() } = {}) {
  const root = makeRoot();
  const manager = newManager(pool, root);
  try {
    return await fn({ manager, pool, root });
  } finally {
    try { await manager.shutdown(); } catch { /* test cleanup */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Core persistence contract
// ---------------------------------------------------------------------------

test('persists before returning and does not emit an unknown-LID message', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    const record = await manager._ingestUpsertMessage(lidMessage(), session.sock, session.id, {
      upsertType: 'notify',
    });

    assert.ok(record, 'held message still returns its RAM record');
    assert.equal(record.conversation_id, LID, 'held record stays under the raw LID in RAM');
    assert.equal(pool.pendingRows(session.id).length, 1,
      'the durable row exists by the time ingestion returns');
    assert.equal(recorder.messageNew().length, 0,
      'no message_new may be published before the mapping is known');
    const row = pool.pendingRows(session.id)[0];
    assert.equal(row.event_id, pendingLidEventId(session.id, LID, 'WA-LID-1'));
    assert.ok(!row.ciphertext.toString('utf8').includes('bilinmeyen lid mesaji'),
      'payload is stored encrypted, not as plaintext');
    assert.equal(record._lid_pending_event_id, row.event_id);
    assert.equal(record._lid_pending_emitted, false);
  });
});

test('pending message survives a gateway restart', async () => {
  const pool = new FakePool();
  const root1 = makeRoot();
  const manager1 = newManager(pool, root1);
  const session1 = await newSession(manager1);
  await manager1._ingestUpsertMessage(lidMessage(), session1.sock, session1.id, { upsertType: 'notify' });
  assert.equal(pool.pendingRows(session1.id).length, 1);
  await manager1.shutdown();

  const root2 = makeRoot();
  const manager2 = newManager(pool, root2);
  const recorder2 = attachRecorder(manager2);
  const session2 = await newSession(manager2);
  try {
    assert.equal(session2.store._pendingLidMessages?.size, 1,
      'the restarted process reloads the durable pending index');
    assert.equal(recorder2.messageNew().length, 0);

    manager2._applyLidMapping(session2, LID, PHONE);
    await waitFor(() => recorder2.messageNew().length === 1);
    await waitForReleaseIdle(session2);

    const [event] = recorder2.messageNew();
    assert.equal(event.conversation_id, PHONE);
    assert.equal(event.message.wa_message_id, 'WA-LID-1');
    assert.equal(pool.pendingRows(session2.id).length, 0,
      'the row is removed only after the release was durably enqueued');
  } finally {
    await manager2.shutdown();
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test('pending message survives repeated restarts with no duplicate row', async () => {
  const pool = new FakePool();
  const roots = [];
  const boot = async (index) => {
    const root = makeRoot();
    roots.push(root);
    const manager = newManager(pool, root);
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);
    return { manager, recorder, session, index };
  };

  try {
    const first = await boot(1);
    await first.manager._ingestUpsertMessage(lidMessage({ id: 'WA-RESTART-1' }), first.session.sock, first.session.id, { upsertType: 'notify' });
    await first.manager.shutdown();

    const second = await boot(2);
    assert.equal(pool.pendingRows(SESSION_A).length, 1);
    assert.equal(second.session.store._pendingLidMessages?.size, 1);
    await second.manager.shutdown();

    const third = await boot(3);
    assert.equal(pool.pendingRows(SESSION_A).length, 1, 'still exactly one durable row');
    assert.equal(third.session.store._pendingLidMessages?.size, 1);
    third.manager._applyLidMapping(third.session, LID, PHONE);
    await waitFor(() => third.recorder.messageNew().length === 1);
    await waitForReleaseIdle(third.session);

    assert.equal(third.recorder.messageNew().length, 1);
    assert.equal(third.recorder.messageNew()[0].conversation_id, PHONE);
    assert.equal(pool.pendingRows(SESSION_A).length, 0);

    await first.manager.shutdown().catch(() => {});
    await second.manager.shutdown().catch(() => {});
    await third.manager.shutdown();
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Release semantics
// ---------------------------------------------------------------------------

test('pending message is not emitted before mapping and is released after mapping', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    await manager._ingestUpsertMessage(lidMessage(), session.sock, session.id, { upsertType: 'notify' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(recorder.messageNew().length, 0, 'nothing before the mapping');
    assert.equal(pool.pendingRows(session.id).length, 1);

    manager._applyLidMapping(session, LID, PHONE);
    await waitFor(() => recorder.messageNew().length === 1);
    await waitForReleaseIdle(session);

    const event = recorder.messageNew()[0];
    assert.equal(event.conversation_id, PHONE, 'delivered under the phone conversation');
    assert.equal(event.event_id, pendingLidEventId(session.id, LID, 'WA-LID-1'),
      'release uses the deterministic event id');
    assert.equal(pool.pendingRows(session.id).length, 0);
  });
});

test('released message is emitted exactly once', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    await manager._ingestUpsertMessage(lidMessage(), session.sock, session.id, { upsertType: 'notify' });
    manager._applyLidMapping(session, LID, PHONE);
    await waitFor(() => recorder.messageNew().length === 1);
    await waitForReleaseIdle(session);

    await manager.releasePendingLidMessages(session);
    await waitForReleaseIdle(session);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(recorder.messageNew().length, 1, 'second sweep does not republish');

    // The same message arriving again long after release is a plain duplicate.
    await manager._ingestUpsertMessage(lidMessage(), session.sock, session.id, { upsertType: 'notify' });
    assert.equal(recorder.messageNew().length, 1, 'duplicate uplink after release is not republished');
    assert.equal(
      (session.store.messagesByChat.get(PHONE) || []).filter((m) => m.wa_message_id === 'WA-LID-1').length,
      1,
      'one RAM record per wa_message_id',
    );
  });
});

test('duplicate delivery while held is idempotent and does not emit under the LID', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    await manager._ingestUpsertMessage(lidMessage(), session.sock, session.id, { upsertType: 'notify' });
    await manager._ingestUpsertMessage(lidMessage(), session.sock, session.id, { upsertType: 'notify' });

    assert.equal(pool.pendingRows(session.id).length, 1, 'one durable row for the duplicated id');
    assert.equal(recorder.messageNew().length, 0, 'a duplicate must not publish the raw-LID record');
    assert.equal(recorder.events.filter((e) => e?.event === 'lid_mapped').length, 0);

    manager._applyLidMapping(session, LID, PHONE);
    await waitFor(() => recorder.messageNew().length === 1);
    await waitForReleaseIdle(session);

    assert.equal(recorder.messageNew().length, 1);
    assert.equal(recorder.messageNew()[0].conversation_id, PHONE);
    assert.equal(pool.pendingRows(session.id).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Controlled failure injection
// ---------------------------------------------------------------------------

test('pending row remains after event delivery failure and resumes with the same id', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    await manager._ingestUpsertMessage(lidMessage(), session.sock, session.id, { upsertType: 'notify' });
    recorder.control.durable = false;
    manager._applyLidMapping(session, LID, PHONE);
    await waitFor(() => recorder.messageNew().length === 1);
    await waitForReleaseIdle(session);

    assert.equal(pool.pendingRows(session.id).length, 1,
      'non-durable delivery keeps the row');
    const firstId = recorder.messageNew()[0].event_id;

    recorder.control.durable = true;
    await manager.releasePendingLidMessages(session);
    await waitFor(() => pool.pendingRows(session.id).length === 0);
    await waitForReleaseIdle(session);

    const events = recorder.messageNew();
    assert.equal(events.length, 2, 'the retry re-emits the same record');
    assert.equal(events[0].event_id, events[1].event_id,
      'both attempts share the deterministic id so the outbox/backend can dedupe');
    assert.equal(firstId, pendingLidEventId(session.id, LID, 'WA-LID-1'));
    assert.equal(events[1].conversation_id, PHONE);
  });
});

test('pending row remains when the mapping write fails and is released once delivery is durable', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    await manager._ingestUpsertMessage(lidMessage(), session.sock, session.id, { upsertType: 'notify' });
    assert.equal(pool.pendingRows(session.id).length, 1);

    pool.failNext('mappingInsert');
    recorder.control.durable = false;
    manager._applyLidMapping(session, LID, PHONE);
    await waitFor(() => recorder.messageNew().length === 1);
    await waitForReleaseIdle(session);

    assert.equal(pool.pendingRows(session.id).length, 1,
      'a failed lid_mappings write must not delete the pending message');
    assert.equal(
      pool.queryLog.filter((q) => q.sql.includes('lid_mappings') && q.sql.trim().startsWith('INSERT')).length >= 1,
      true,
      'the mapping write was actually attempted and failed',
    );

    recorder.control.durable = true;
    await manager.releasePendingLidMessages(session);
    await waitFor(() => pool.pendingRows(session.id).length === 0);
    await waitForReleaseIdle(session);

    const events = recorder.messageNew();
    assert.equal(events.length, 2);
    assert.equal(events[0].event_id, events[1].event_id);
    assert.equal(events[1].conversation_id, PHONE);
  });
});

test('durable write failure leaves the message held in RAM and schedules a retry', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    pool.failNext('insert');
    const record = await manager._ingestUpsertMessage(lidMessage({ id: 'WA-DB-FAIL' }), session.sock, session.id, { upsertType: 'notify' });

    assert.ok(record, 'ingestion must not throw away the message when the durable write fails');
    assert.equal(pool.pendingRows(session.id).length, 0);
    assert.equal(session._pendingLidRetry?.get('WA-DB-FAIL')?.attempts, 1,
      'a retry is queued with an explicit attempt count');
    assert.equal(recorder.messageNew().length, 0);

    // The injected failure is gone: the retry flush must make the row durable
    // and annotate the RAM record so the later release owns its delivery.
    await manager._flushPendingLidRetries(session);
    assert.equal(pool.pendingRows(session.id).length, 1);
    assert.equal(record._lid_pending_event_id, pendingLidEventId(session.id, LID, 'WA-DB-FAIL'));
    assert.equal(session._pendingLidRetry.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Isolation and identity
// ---------------------------------------------------------------------------

test('pending messages are isolated by session', async () => {
  await withHarness(async ({ manager, pool }) => {
    const sessionA = await newSession(manager, SESSION_A);
    const sessionB = await newSession(manager, SESSION_B);

    await manager._ingestUpsertMessage(lidMessage({ id: 'WA-A' }), sessionA.sock, sessionA.id, { upsertType: 'notify' });
    await manager._ingestUpsertMessage(lidMessage({ id: 'WA-B' }), sessionB.sock, sessionB.id, { upsertType: 'notify' });
    assert.equal(pool.pendingRows(SESSION_A).length, 1);
    assert.equal(pool.pendingRows(SESSION_B).length, 1);

    const recorderA = attachRecorder(manager);
    manager._applyLidMapping(sessionA, LID, PHONE);
    await waitFor(() => recorderA.messageNew().length === 1);
    await waitForReleaseIdle(sessionA);

    assert.equal(recorderA.messageNew()[0].message.wa_message_id, 'WA-A');
    assert.equal(pool.pendingRows(SESSION_A).length, 0);
    assert.equal(pool.pendingRows(SESSION_B).length, 1, "session B's message is untouched");
    assert.equal(sessionB.store._pendingLidMessages?.get('WA-B')?.waMessageId, 'WA-B');

    // Session B still cannot resolve the LID: no event may have appeared for it.
    assert.equal(recorderA.messageNew().filter((e) => e.conversation_id === LID).length, 0);
  });
});

test('pending messages are isolated by tenant (session-scoped queries only)', async () => {
  const pool = new FakePool();
  // Two gateway sessions belonging to two different backend users. The
  // repository is only ever given a session id, so the session id IS the
  // tenant boundary at this layer.
  const tenants = [
    { sessionId: 'tenant-a-session', owner: 'user-a' },
    { sessionId: 'tenant-b-session', owner: 'user-b' },
  ];
  const root = makeRoot();
  const manager = newManager(pool, root);
  const recorder = attachRecorder(manager);
  try {
    const sessions = [];
    for (const tenant of tenants) {
      const session = await newSession(manager, tenant.sessionId);
      await manager._ingestUpsertMessage(
        lidMessage({ id: `WA-${tenant.owner}` }),
        session.sock,
        session.id,
        { upsertType: 'notify' },
      );
      sessions.push(session);
    }

    assert.equal(pool.pendingRows('tenant-a-session').length, 1);
    assert.equal(pool.pendingRows('tenant-b-session').length, 1);

    manager._applyLidMapping(sessions[0], LID, PHONE);
    await waitFor(() => recorder.messageNew().length === 1);
    await waitForReleaseIdle(sessions[0]);

    const delivered = recorder.messageNew();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].message.wa_message_id, 'WA-user-a');
    assert.equal(pool.pendingRows('tenant-b-session').length, 1,
      'tenant B row is not eligible for tenant A release');
    const allSelects = pool.queryLog.filter((q) => q.sql.includes('lid_pending_messages') && q.sql.includes('SELECT'));
    assert.ok(allSelects.every((q) => Array.isArray(q.params) && q.params.length >= 1),
      'every pending read is parameterized by a session id');
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('released record retains the original wa_message_id and timestamp', async () => {
  await withHarness(async ({ manager }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);
    const originalTs = 1699999999;

    await manager._ingestUpsertMessage(
      lidMessage({ id: 'WA-TS-1', ts: originalTs, text: 'zaman damgasi' }),
      session.sock,
      session.id,
      { upsertType: 'notify' },
    );
    manager._applyLidMapping(session, LID, PHONE);
    await waitFor(() => recorder.messageNew().length === 1);
    await waitForReleaseIdle(session);

    const record = recorder.messageNew()[0].message;
    assert.equal(record.wa_message_id, 'WA-TS-1');
    assert.equal(record.timestamp_s, originalTs);
    assert.equal(record.created_at, new Date(originalTs * 1000).toISOString());
    assert.equal(record.body, 'zaman damgasi');
    assert.equal(record.conversation_id, PHONE);
  });
});

test('not lost when the RAM store limit drops the held record', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    await manager._ingestUpsertMessage(lidMessage({ id: 'WA-RAM-TRIM' }), session.sock, session.id, { upsertType: 'notify' });
    assert.equal(pool.pendingRows(session.id).length, 1);

    // Simulate the per-chat cap / restart eviction: the only RAM copy is gone.
    session.store.messagesByChat.delete(LID);
    assert.equal((session.store.messagesByChat.get(LID) || []).length, 0);

    manager._applyLidMapping(session, LID, PHONE);
    await waitFor(() => recorder.messageNew().length === 1);
    await waitForReleaseIdle(session);

    const record = recorder.messageNew()[0].message;
    assert.equal(record.wa_message_id, 'WA-RAM-TRIM');
    assert.equal(record.conversation_id, PHONE);
    assert.equal(
      (session.store.messagesByChat.get(PHONE) || []).filter((m) => m.wa_message_id === 'WA-RAM-TRIM').length,
      1,
      'the durable row re-created exactly one RAM record under the phone JID',
    );
    assert.equal(pool.pendingRows(session.id).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Regressions on the same ingestion path
// ---------------------------------------------------------------------------

test('regression: normal PN message still emits immediately', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    const record = await manager._ingestUpsertMessage({
      key: { remoteJid: PHONE, id: 'WA-PN-1', fromMe: false },
      message: { conversation: 'normal' },
      messageTimestamp: 1700000100,
    }, session.sock, session.id, { upsertType: 'notify' });

    assert.equal(record.conversation_id, PHONE);
    assert.equal(recorder.messageNew().length, 1);
    assert.equal(recorder.messageNew()[0].conversation_id, PHONE);
    assert.equal(recorder.messageNew()[0].event_id, undefined);
    assert.equal(pool.pendingRows(session.id).length, 0);
  });
});

test('regression: already-mapped LID message emits under the phone JID', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    manager._applyLidMapping(session, LID, PHONE);
    await manager._ingestUpsertMessage(lidMessage({ id: 'WA-MAPPED-1' }), session.sock, session.id, {
      upsertType: 'notify',
    });

    assert.equal(recorder.messageNew().length, 1);
    assert.equal(recorder.messageNew()[0].conversation_id, PHONE);
    assert.equal(pool.pendingRows(session.id).length, 0);
  });
});

test('regression: group message uses the group conversation and participant', async () => {
  await withHarness(async ({ manager, pool }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);
    const group = '120363000000000000@g.us';

    const record = await manager._ingestUpsertMessage({
      key: { remoteJid: group, id: 'WA-GROUP-1', fromMe: false, participant: PHONE },
      message: { conversation: 'grup mesaji' },
      messageTimestamp: 1700000200,
      pushName: 'Grup Uyesi',
    }, session.sock, session.id, { upsertType: 'notify' });

    assert.equal(record.conversation_id, group);
    assert.equal(recorder.messageNew().length, 1);
    assert.equal(recorder.messageNew()[0].conversation_id, group);
    assert.equal(recorder.messageNew()[0].message.participant_jid, PHONE);
    assert.equal(pool.pendingRows(session.id).length, 0);
  });
});

test('regression: outbound recording still emits message_new', async () => {
  await withHarness(async ({ manager }) => {
    const recorder = attachRecorder(manager);
    const session = await newSession(manager);

    const record = await manager._recordOutbound(PHONE, {
      body: 'giden mesaj',
      message_type: 'TEXT',
      client_message_id: 'CLIENT-1',
    }, session.id);

    assert.equal(record.direction, 'OUTBOUND');
    assert.equal(recorder.messageNew().length, 1);
    assert.equal(recorder.messageNew()[0].conversation_id, PHONE);
  });
});

test('regression: append (history sync) does not raise the unread badge', async () => {
  await withHarness(async ({ manager }) => {
    const session = await newSession(manager);
    const store = session.store;
    store.chats.set(PHONE, { id: PHONE, jid: PHONE, unread_count: 0 });

    await manager._ingestUpsertMessage({
      key: { remoteJid: PHONE, id: 'WA-HIST-1', fromMe: false },
      message: { conversation: 'gecmis' },
      messageTimestamp: 1700000300,
    }, session.sock, session.id, { upsertType: 'notify' });
    assert.equal(store.chats.get(PHONE).unread_count, 1, 'live notify counts');

    await manager._ingestUpsertMessage({
      key: { remoteJid: PHONE, id: 'WA-HIST-2', fromMe: false },
      message: { conversation: 'eski gecmis' },
      messageTimestamp: 1690000000,
    }, session.sock, session.id, { upsertType: 'append' });
    assert.equal(store.chats.get(PHONE).unread_count, 1, 'append must not count as a new arrival');
  });
});

// ---------------------------------------------------------------------------
// Deterministic id contract
// ---------------------------------------------------------------------------

test('deterministic event id is stable, session-scoped and UUID-shaped', () => {
  const id = pendingLidEventId(SESSION_A, LID, 'WA-1');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, pendingLidEventId(SESSION_A, LID, 'WA-1'));
  assert.notEqual(id, pendingLidEventId(SESSION_B, LID, 'WA-1'));
  assert.notEqual(id, pendingLidEventId(SESSION_A, '22222222222222@lid', 'WA-1'));
  assert.notEqual(id, pendingLidEventId(SESSION_A, LID, 'WA-2'));
});
