/**
 * Outbound delete sync (gateway side) — `deleteConversationRemote` contract.
 *
 * PRODUCTION SYMPTOM (2026-10-01, "Tezlify'dan sohbeti sil dedigim zaman
 * whatsapp uygulamasinda da silmiyor"): the gateway never told WhatsApp to
 * delete anything. `chatModify` appeared nowhere in its source.
 *
 * The risk in the fix is NOT the network call — it is the `lastMessages`
 * payload. Read from the running Baileys 7.0.0-rc14 sources
 * (`Utils/chat-utils.js`, `getMessageRange`), the payload is validated
 * HARD and throws instead of degrading:
 *
 *   - every entry needs `key.remoteJid` and `key.id`   -> "Incomplete key"
 *   - every entry needs a convertible `messageTimestamp`
 *                                                      -> "Missing timestamp"
 *   - a GROUP entry with `fromMe: false` needs `key.participant`
 *                                                      -> "Expected not from
 *                                                         me message to have
 *                                                         participant"
 *
 * So this gate locks the SHAPE, and the two properties that make the delete
 * durable:
 *
 *   A. `chatModify({ delete: true, ... })` is called with a VALID lastMessages
 *      entry (jid + id + seconds timestamp), one element (the newest).
 *   B. on success the local caches are CLEARED — otherwise the next chat
 *      discovery re-creates the chat we just deleted (the delete would undo
 *      itself).
 *   C. a provider failure reports `success: false` and leaves the caches
 *      ALONE (a chat we failed to delete must not vanish from our own view).
 *   D. a group entry never ships without `participant`: the unusable entry is
 *      skipped rather than sent, because Baileys would throw on it.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-delete-chat-'));
const sm = createSessionManager({ sessionsDir: dir, mediaDir: dir, aesKey: '0'.repeat(64), backendWsUrl: '' });
const sid = (await sm.createSession('delete-chat-test', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';

const JID = '905551112233@s.whatsapp.net';
const GROUP_JID = '120363000000000001@g.us';
const PEER = '905559998877@s.whatsapp.net';
const NOW_S = Math.floor(Date.now() / 1000);

let captured = null;
let shouldThrow = null;
session.sock = {
  async chatModify(mod, jid) {
    captured = { mod, jid };
    if (shouldThrow) throw new Error(shouldThrow);
  },
};

const ingest = (key, ts = NOW_S) =>
  sm._ingestUpsertMessage(
    { key, message: { conversation: 'merhaba' }, messageTimestamp: ts },
    null,
    sid,
  );

const checks = [];
function check(label, fn) {
  try {
    fn();
    checks.push({ label, ok: true });
  } catch (err) {
    checks.push({ label, ok: false, err: err.message });
  }
}

try {
  // --- A. Valid payload ------------------------------------------------------
  await ingest({ remoteJid: JID, fromMe: false, id: 'IN_1' }, NOW_S - 60);
  await ingest({ remoteJid: JID, fromMe: true, id: 'OUT_2' }, NOW_S);

  captured = null;
  const ok = await sm.deleteConversationRemote(sid, JID);

  check('A1 chatModify is actually called', () =>
    assert.ok(captured, 'chatModify must be called — this is the whole fix'));
  check('A2 it is a delete modification for the resolved jid', () => {
    assert.equal(captured.mod.delete, true);
    assert.equal(captured.jid, JID);
    assert.equal(captured.mod.lastMessages.length, 1, 'one element (the newest) removes ordering ambiguity');
  });
  check('A3 the entry carries the fields Baileys validates', () => {
    const e = captured.mod.lastMessages[0];
    assert.equal(e.key.remoteJid, JID, 'key.remoteJid is required (Incomplete key)');
    assert.ok(e.key.id, 'key.id is required (Incomplete key)');
    assert.equal(e.key.fromMe, true, 'the newest message is the OUTBOUND one');
    assert.equal(
      typeof e.messageTimestamp,
      'number',
      'messageTimestamp must be convertible (Missing timestamp)',
    );
    assert.ok(e.messageTimestamp > 0);
  });
  check('A4 success is reported explicitly', () => {
    assert.equal(ok.success, true);
    assert.equal(ok.remote_deleted, true);
  });

  // --- B. Local caches cleared ---------------------------------------------
  check('B1 the chat leaves the local chat cache', () =>
    assert.equal(session.store.chats.has(JID), false));
  check('B2 its messages leave the local message cache', () =>
    assert.equal(session.store.messagesByChat.has(JID), false));

  // --- C. Provider failure is honest and non-destructive --------------------
  await ingest({ remoteJid: JID, fromMe: false, id: 'IN_3' }, NOW_S);
  shouldThrow = 'simulated provider failure';
  const failed = await sm.deleteConversationRemote(sid, JID);
  shouldThrow = null;

  check('C1 a provider failure is not reported as success', () => {
    assert.equal(failed.success, false);
    assert.match(String(failed.error), /simulated provider failure/);
  });
  check('C2 the failure reason is surfaced', () =>
    assert.equal(failed.remote_deleted, undefined, 'no success flag on a failure'));
  check('C3 a chat we failed to delete stays in OUR view', () =>
    assert.equal(session.store.messagesByChat.has(JID), true));

  // --- D. Group entries: participant rules ----------------------------------
  // D1: an inbound group entry with no `participant` is UNUSABLE — Baileys
  // rejects it ("Expected not from me message to have participant"). It must
  // be skipped, and the delete must still be attempted with what is left.
  await ingest({ remoteJid: GROUP_JID, fromMe: false, id: 'GRP_IN_NO_PART' }, NOW_S - 10);
  captured = null;
  const grpNoPart = await sm.deleteConversationRemote(sid, GROUP_JID);
  check('D1 an inbound group entry without participant is skipped', () => {
    assert.equal(captured.mod.delete, true, 'the delete is still attempted');
    assert.equal(captured.mod.lastMessages.length, 0, 'no invalid entry is shipped');
    assert.equal(grpNoPart.success, true);
  });

  // D2: a group whose newest message is OURS needs no participant.
  await ingest({ remoteJid: GROUP_JID, fromMe: true, id: 'GRP_OUT' }, NOW_S);
  captured = null;
  await sm.deleteConversationRemote(sid, GROUP_JID);
  check('D2 a group entry from us needs no participant', () => {
    const e = captured.mod.lastMessages[0];
    assert.ok(e, 'a usable entry exists, so it must be shipped');
    assert.equal(e.key.fromMe, true);
    assert.equal(e.key.participant, undefined);
  });

  // D3: an inbound group entry WITH a participant is valid and must carry it.
  await ingest(
    { remoteJid: GROUP_JID, fromMe: false, id: 'GRP_IN_PART', participant: PEER },
    NOW_S,
  );
  captured = null;
  await sm.deleteConversationRemote(sid, GROUP_JID);
  check('D3 an inbound group entry carries its participant', () => {
    const e = captured.mod.lastMessages[0];
    assert.ok(e, 'a usable entry exists, so it must be shipped');
    assert.equal(e.key.fromMe, false);
    assert.equal(e.key.participant, PEER, 'Baileys requires participant on group inbound keys');
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

let failed = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`PASS ${c.label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${c.label}: ${c.err}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
