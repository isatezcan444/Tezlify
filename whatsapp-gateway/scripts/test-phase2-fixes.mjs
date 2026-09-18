// Phase 2 forensic-audit regression tests for the WhatsApp gateway.
//
// Covers: H-4 (provider_status semantics), G-4 (degenerate contacts via
// contacts.update), G-5 (live inbound dedup), G-6 (sync counter naming),
// G-7 (@c.us canonicalization), G-8 (pairing phone country assumption),
// G-9 (bounded avatar retry cache), G-10 (durable event not silently dropped).
//
// Run: `node scripts/test-phase2-fixes.mjs` — exit code 0 = PASS, non-zero = FAIL.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSessionManager,
  contactPhoneJid,
  isDegenerateJid,
  normalizePairingPhone,
  resolveJidKey,
  resolveSyncState,
} from '../src/session-manager.js';
import { createEventBridge } from '../src/events.js';

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-phase2-'));
const makeManager = () => createSessionManager({
  sessionsDir: dir,
  mediaDir: dir,
  aesKey: '0'.repeat(64),
  backendWsUrl: '',
});

try {
  // =========================================================================
  // H-4 — provider_status must distinguish "never requested" from failure.
  // =========================================================================
  await check('H-4: fetchProvider=false -> NOT_REQUESTED', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('h4-a', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    const jid = '905551112233@s.whatsapp.net';
    sm._storeOf(session).messagesByChat.set(jid, [
      { id: 1, wa_message_id: 'm1', direction: 'INBOUND', timestamp_s: 1, body: 'a' },
    ]);
    const res = await sm.getMessages(sid, jid, { limit: 50 });
    assert.equal(res.provider_status, 'NOT_REQUESTED');
  });

  await check('H-4: cache already sufficient and no anchor -> NOT_REQUESTED (genuinely never called)', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('h4-b', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    let providerCalls = 0;
    session.sock = {
      async fetchMessageHistory() { providerCalls += 1; return 'pdo'; },
    };
    const jid = '905551112233@s.whatsapp.net';
    sm._storeOf(session).messagesByChat.set(jid, [
      { id: 1, wa_message_id: 'm1', direction: 'INBOUND', timestamp_s: 1, body: 'a' },
      { id: 2, wa_message_id: 'm2', direction: 'INBOUND', timestamp_s: 2, body: 'b' },
      { id: 3, wa_message_id: 'm3', direction: 'INBOUND', timestamp_s: 3, body: 'c' },
    ]);
    const res = await sm.getMessages(sid, jid, { limit: 3, fetchProvider: true });
    assert.equal(res.provider_status, 'NOT_REQUESTED');
    assert.equal(providerCalls, 0, 'provider must NOT be called when the cache is sufficient');
  });

  await check('H-4: fetch requested but socket missing -> SOCKET_UNAVAILABLE (not NOT_REQUESTED)', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('h4-c', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    session.sock = null;
    const jid = '905551112233@s.whatsapp.net';
    const res = await sm.getMessages(sid, jid, { limit: 50, fetchProvider: true });
    assert.equal(res.provider_status, 'SOCKET_UNAVAILABLE');
    assert.notEqual(res.provider_status, 'NOT_REQUESTED');
  });

  await check('H-4: fetch requested, socket present, no anchor -> NO_ANCHOR', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('h4-d', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    session.sock = { async fetchMessageHistory() { return 'pdo'; } };
    const jid = '905551112233@s.whatsapp.net'; // empty store, no oldestMsgId
    const res = await sm.getMessages(sid, jid, { limit: 50, fetchProvider: true, timeoutMs: 30 });
    assert.equal(res.provider_status, 'NO_ANCHOR');
  });

  await check('H-4: fetch requested with anchor -> provider actually called', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('h4-e', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    let providerCalls = 0;
    session.sock = {
      async fetchMessageHistory() { providerCalls += 1; return 'pdo'; },
    };
    const jid = '905551112233@s.whatsapp.net';
    sm._storeOf(session).messagesByChat.set(jid, [
      { id: 1, wa_message_id: 'm1', direction: 'INBOUND', timestamp_s: 1, body: 'a' },
    ]);
    const res = await sm.getMessages(sid, jid, { limit: 50, fetchProvider: true, timeoutMs: 30 });
    assert.equal(providerCalls, 1, 'provider must be called exactly once');
    assert.notEqual(res.provider_status, 'NOT_REQUESTED');
    assert.notEqual(res.provider_status, 'SOCKET_UNAVAILABLE');
  });

  await check('H-4: requestOlderHistory still fails closed with SOCKET_UNAVAILABLE (defence in depth)', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('h4-f', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    session.sock = null;
    // Anchor present so the socket check is reached (NO_ANCHOR takes precedence).
    const out = await sm.requestOlderHistory(sid, '905551112233@s.whatsapp.net', {
      count: 10,
      oldestMsgId: 'm1',
      oldestMsgFromMe: false,
      oldestMsgTimestampMs: 1000,
    });
    assert.equal(out.status, 'SOCKET_UNAVAILABLE');
  });

  // =========================================================================
  // G-4 — degenerate JIDs must never create a contact via contacts.update.
  // =========================================================================
  await check('G-4: isDegenerateJid rejects degenerate/bare JIDs and keeps valid ones', () => {
    assert.equal(isDegenerateJid('0@s.whatsapp.net'), true);
    assert.equal(isDegenerateJid('000@s.whatsapp.net'), true);
    assert.equal(isDegenerateJid('123@s.whatsapp.net'), true, 'fewer than 5 digits');
    assert.equal(isDegenerateJid('@g.us'), true, 'bare group JID');
    assert.equal(isDegenerateJid('@lid'), true, 'bare LID JID');
    assert.equal(isDegenerateJid('status@broadcast'), true);
    assert.equal(isDegenerateJid('123@newsletter'), true, 'short newsletter user');
    // Valid identities must NOT be treated as degenerate.
    assert.equal(isDegenerateJid('905321002030@s.whatsapp.net'), false);
    assert.equal(isDegenerateJid('62771114836011@lid'), false, 'valid LID');
    assert.equal(isDegenerateJid('120363012345678901@g.us'), false, 'valid group');
    assert.equal(isDegenerateJid('905321002030:12@s.whatsapp.net'), false, 'device index');
    assert.equal(isDegenerateJid(null), false);
  });

  await check('G-4: contacts.update creates no contact for degenerate/broadcast JIDs', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g4-a', { autoStart: false })).id;
    const session = sm.getSession(sid);
    const events = [];
    sm.onEvent((e) => events.push(e));
    sm._ingestContactUpdates(session, [
      { id: '0@s.whatsapp.net', name: 'Zero' },
      { id: '@g.us', name: 'Bare group' },
      { id: '@lid', name: 'Bare lid' },
      { id: 'status@broadcast', name: 'Status' },
      { id: '1234567890@newsletter', name: 'News' },
      { id: '000@s.whatsapp.net', name: 'Zeros' },
      { id: '123@s.whatsapp.net', name: 'Short' },
    ]);
    assert.equal(sm._storeOf(session).contacts.size, 0, 'no ghost contact may be created');
    assert.equal(events.filter((e) => e.event === 'contact_synced').length, 0, 'no contact_synced event');
  });

  await check('G-4: contacts.update still ingests valid contacts', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g4-b', { autoStart: false })).id;
    const session = sm.getSession(sid);
    const events = [];
    sm.onEvent((e) => events.push(e));
    sm._ingestContactUpdates(session, [
      { id: '905321002030@s.whatsapp.net', name: 'Ahmet Yilmaz' },
    ]);
    const contact = sm._storeOf(session).contacts.get('905321002030@s.whatsapp.net');
    assert.ok(contact, 'valid contact must be stored');
    assert.equal(contact.name, 'Ahmet Yilmaz');
    assert.equal(contact.name_source, 'addressbook');
    assert.equal(events.filter((e) => e.event === 'contact_synced').length, 1);
  });

  await check('G-4: valid LID mapped to a PN still resolves (LID logic not broken)', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g4-c', { autoStart: false })).id;
    const session = sm.getSession(sid);
    const store = sm._storeOf(session);
    const lid = '62771114836011@lid';
    const phone = '905321002030@s.whatsapp.net';
    store.lidToJid.set(lid, phone);
    store.jidToLid.set(phone, lid);
    sm._ingestContactUpdates(session, [{ id: lid, name: 'Rehber Adi' }]);
    assert.equal(store.contacts.has(lid), false, 'no ghost LID contact');
    const contact = store.contacts.get(phone);
    assert.ok(contact, 'LID must resolve to the phone key');
    assert.equal(contact.name, 'Rehber Adi');
  });

  // =========================================================================
  // G-5 — live inbound dedup: one store record, one event.
  // =========================================================================
  await check('G-5: duplicate inbound upsert -> one record, one event, unread counted once', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g5-a', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    const events = [];
    sm.onEvent((e) => events.push(e));
    const jid = '905551112233@s.whatsapp.net';
    const msg = {
      key: { remoteJid: jid, id: 'IN-DUP-1' },
      pushName: 'Ali',
      message: { conversation: 'merhaba' },
      messageTimestamp: 1000,
    };
    const first = await sm._ingestUpsertMessage(msg, null, sid);
    const second = await sm._ingestUpsertMessage(msg, null, sid);
    assert.ok(first, 'first delivery stored');
    assert.equal(second, null, 'replayed delivery must be ignored');
    const list = sm._storeOf(session).messagesByChat.get(jid) || [];
    assert.equal(list.filter((m) => m.wa_message_id === 'IN-DUP-1').length, 1);
    assert.equal(events.filter((e) => e.event === 'message_new').length, 1);
    assert.equal(sm._storeOf(session).chats.get(jid).unread_count, 1);
  });

  await check('G-5: fromMe echo dedup still holds', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g5-b', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    const jid = '905551112233@s.whatsapp.net';
    const msg = {
      key: { remoteJid: jid, id: 'OUT-DUP-1', fromMe: true },
      message: { conversation: 'gonderildi' },
      messageTimestamp: 1000,
    };
    const first = await sm._ingestUpsertMessage(msg, null, sid);
    const second = await sm._ingestUpsertMessage(msg, null, sid);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal((sm._storeOf(session).messagesByChat.get(jid) || []).length, 1);
  });

  // =========================================================================
  // G-6 — cumulative counters vs unique entity counts.
  // =========================================================================
  await check('G-6: sync state exposes unique counts alongside cumulative counters', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g6-a', { autoStart: false })).id;
    const sync = sm.getSession(sid).sync;
    // Cumulative/per-event counters (documented as NOT unique).
    assert.equal(sync.chats_synced, 0);
    assert.equal(sync.contacts_synced, 0);
    assert.equal(sync.messages_synced, 0);
    // Correctly-named unique-entity counters for the progress UI.
    assert.equal(sync.chats_unique, 0);
    assert.equal(sync.contacts_unique, 0);
    assert.equal(sync.messages_cached, 0);
  });

  await check('G-6: resolveSyncState preserves the unique counters', () => {
    const prev = {
      phase: 'syncing', progress: 10,
      chats_synced: 50, contacts_synced: 120, messages_synced: 900,
      chats_unique: 12, contacts_unique: 120, messages_cached: 480,
    };
    const { next } = resolveSyncState(prev, { progress: 40, isLatest: false });
    assert.equal(next.chats_unique, 12);
    assert.equal(next.contacts_unique, 120);
    assert.equal(next.messages_cached, 480);
    // Cumulative counters are untouched by this function.
    assert.equal(next.chats_synced, 50);
    assert.equal(next.messages_synced, 900);
  });

  // =========================================================================
  // G-7 — @c.us canonicalization.
  // =========================================================================
  await check('G-7: @c.us and @s.whatsapp.net collapse to the same key', () => {
    const canonical = '905321234567@s.whatsapp.net';
    assert.equal(resolveJidKey(null, '905321234567@c.us'), canonical);
    assert.equal(resolveJidKey(null, '905321234567@s.whatsapp.net'), canonical);
    assert.equal(resolveJidKey(null, '905321234567:12@c.us'), canonical, 'device index stripped too');
    // Phone-JID normalizer used by LID resolution also canonicalizes @c.us.
    assert.equal(
      contactPhoneJid({ id: '62771114836011@lid', phoneNumber: '905321002030@c.us' }),
      '905321002030@s.whatsapp.net',
    );
    // Group / LID / broadcast behaviour unchanged.
    assert.equal(resolveJidKey(null, '120363012345678901@g.us'), '120363012345678901@g.us');
    assert.equal(resolveJidKey(null, '62771114836011@lid'), '62771114836011@lid');
    assert.equal(resolveJidKey(null, 'status@broadcast'), 'status@broadcast');
  });

  await check('G-7: a LID learned via a @c.us phone resolves to the canonical key', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g7-b', { autoStart: false })).id;
    const session = sm.getSession(sid);
    sm._applyLidMapping(session, '62771114836011@lid', '905321002030@c.us');
    assert.equal(resolveJidKey(sm._storeOf(session), '62771114836011@lid'), '905321002030@s.whatsapp.net');
  });

  await check('G-7: both forms land in one store chat', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g7-a', { autoStart: false })).id;
    const session = sm.getSession(sid);
    sm._touchChat(session, '905321234567@c.us', 'x', '2026-01-01T00:00:00.000Z');
    sm._touchChat(session, '905321234567@s.whatsapp.net', 'y', '2026-01-02T00:00:00.000Z');
    const store = sm._storeOf(session);
    assert.equal(store.chats.has('905321234567@c.us'), false);
    assert.equal(store.chats.has('905321234567@s.whatsapp.net'), true);
    assert.equal(
      [...store.chats.keys()].filter((k) => k.startsWith('905321234567@')).length,
      1,
    );
  });

  // =========================================================================
  // G-8 — pairing phone must not assume Turkey for international input.
  // =========================================================================
  await check('G-8: international input is never silently rewritten to +90', () => {
    // `00` is the international prefix — Brazil must stay Brazil.
    assert.equal(normalizePairingPhone('005512345678'), '5512345678');
    assert.equal(normalizePairingPhone('+55 11 91234 5678'), '5511912345678');
    // Existing TR + international formats keep working.
    assert.equal(normalizePairingPhone('5528073007'), '905528073007');
    assert.equal(normalizePairingPhone('05528073007'), '905528073007');
    assert.equal(normalizePairingPhone('+90 552 807 30 07'), '905528073007');
    assert.equal(normalizePairingPhone('0090 552 807 30 07'), '905528073007');
    assert.equal(normalizePairingPhone('+1 555 123 4567'), '15551234567');
    assert.throws(() => normalizePairingPhone('123'), /Geçersiz/);
  });

  // =========================================================================
  // G-9 — bounded long-lived maps.
  // =========================================================================
  await check('G-9: avatarFetchAttemptedAt is a bounded cache (TTL + max entries)', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g9-a', { autoStart: false })).id;
    const store = sm._storeOf(sm.getSession(sid));
    assert.equal(typeof store.avatarFetchAttemptedAt.get, 'function');
    assert.equal(typeof store.avatarFetchAttemptedAt.set, 'function');
    for (let i = 0; i < 10_050; i += 1) {
      store.avatarFetchAttemptedAt.set(`90555000${String(i).padStart(5, '0')}@s.whatsapp.net`, Date.now());
    }
    assert.ok(store.avatarFetchAttemptedAt.size <= 10_000, 'retry map must be bounded');
  });

  // =========================================================================
  // G-10 — a durable event must not be silently dropped when the outbox write fails.
  // =========================================================================
  await check('G-10: outbox enqueue failure falls back to best-effort delivery', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('g10-a', { autoStart: false })).id;
    const received = [];
    const fakeWs = {
      readyState: 1,
      send(payload) { received.push(JSON.parse(payload)); },
      on() {},
      close() {},
    };
    const failingOutbox = {
      async enqueue() { throw new Error('outbox db down'); },
      async cleanup() { return 0; },
      async close() {},
      async claimPending() { return []; },
      async acknowledge() {},
      async reject() {},
      async requeueInflight() {},
    };
    const bridge = createEventBridge({ backendWsUrl: '', sessionManager: sm, eventOutbox: failingOutbox });
    try {
      bridge.attachClient(fakeWs);
      sm._emit({
        event: 'message_new',
        gateway_session_id: sid,
        conversation_id: '905551112233@s.whatsapp.net',
        message: { wa_message_id: 'g10-1', body: 'hi' },
      });
      await new Promise((r) => setTimeout(r, 20));
      const delivered = received.filter((e) => e.event === 'message_new');
      assert.equal(delivered.length, 1, 'event must still be delivered best-effort, not dropped');
      assert.equal(delivered[0].message.wa_message_id, 'g10-1');
    } finally {
      bridge.close();
    }
  });

  // =========================================================================
  // §1.1 — an unconfirmed outbound record must never default to SENT.
  // =========================================================================
  await check('§1.1: _recordOutbound without an explicit status records PENDING, never SENT', async () => {
    const sm = makeManager();
    const sid = (await sm.createSession('truth-a', { autoStart: false })).id;
    const session = sm.getSession(sid);
    session.status = 'CONNECTED';
    const jid = '905551112244@s.whatsapp.net';
    sm._recordOutbound(jid, { body: 'hi', wa_message_id: 'TRUTH-1' }, sid);
    const list = sm._storeOf(session).messagesByChat.get(jid) || [];
    const rec = list.find((m) => m.wa_message_id === 'TRUTH-1');
    assert.ok(rec, 'the outbound record must exist');
    assert.equal(
      rec.status,
      'PENDING',
      "a message with no explicit status must not be reported as SENT (AGENTS.md §1.1)"
    );
  });

  console.log(`\n[test-phase2-fixes] ${passed} checks passed.`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
