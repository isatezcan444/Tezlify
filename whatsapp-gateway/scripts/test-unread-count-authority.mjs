/**
 * The unread counter must describe what was actually PUBLISHED.
 *
 * PRODUCTION SYMPTOM (2026-10-01, "birisi whatsapptan mesaj gonderdiginde
 * mobilden okursam Tezlify'da bildirim kaliyor"): the gateway's chat list and
 * the CRM disagreed about how many messages were unread — measured live as
 * gateway `unread_count=2` against a database value of 1.
 *
 * Cause: `_ingestUpsertMessage` incremented the local chat counter for EVERY
 * inbound message, including ones it only HELD (a LID message whose mapping is
 * unknown is stored but deliberately never emitted). So the local counter
 * included a message that had never been published anywhere else — a second,
 * contradictory truth rather than a richer one.
 *
 * A2 is the control: a normally-published message MUST still increment, or the
 * badge would stop working entirely.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

const LID = '333333333333333@lid';
const PN = '905551112233@s.whatsapp.net';
const NOW_S = Math.floor(Date.now() / 1000);

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-unread-'));
const sm = createSessionManager({ sessionsDir: dir, mediaDir: dir, aesKey: '0'.repeat(64), backendWsUrl: '' });
const sid = (await sm.createSession('unread-test', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';
session.ephemeral = true;

const events = [];
sm.onEvent((event) => events.push(event));
const unreadOf = (key) => (session.store.chats.get(key) || {}).unread_count;
const emitted = (key) =>
  events.filter((e) => e.event === 'message_new' && e.conversation_id === key).length;

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
  // A1: a HELD message (unknown LID, no alt field) must not be counted.
  await sm._ingestUpsertMessage(
    {
      key: { remoteJid: LID, fromMe: false, id: 'HELD_1' },
      message: { conversation: 'gizli' },
      messageTimestamp: NOW_S,
    },
    null,
    sid,
  );

  check('A1 a held (unpublished) message is NOT counted as unread', () =>
    assert.equal(
      unreadOf(LID) ?? 0,
      0,
      'the counter must not include a message that was never published',
    ));
  check('A2 the held message emitted nothing (sanity)', () =>
    assert.equal(emitted(LID), 0));

  // B1: a published message DOES increment — the badge still works.
  await sm._ingestUpsertMessage(
    {
      key: { remoteJid: PN, fromMe: false, id: 'PUB_1' },
      message: { conversation: 'merhaba' },
      messageTimestamp: NOW_S,
    },
    null,
    sid,
  );
  check('B1 a published inbound message increments once', () =>
    assert.equal(unreadOf(PN), 1));
  check('B2 and it was published', () => assert.equal(emitted(PN), 1));

  // B3: a second one accumulates.
  await sm._ingestUpsertMessage(
    {
      key: { remoteJid: PN, fromMe: false, id: 'PUB_2' },
      message: { conversation: 'tekrar' },
      messageTimestamp: NOW_S + 1,
    },
    null,
    sid,
  );
  check('B3 published messages accumulate', () => assert.equal(unreadOf(PN), 2));

  // B4: our own outbound message never counts as unread.
  await sm._ingestUpsertMessage(
    {
      key: { remoteJid: PN, fromMe: true, id: 'OUT_1' },
      message: { conversation: 'cevap' },
      messageTimestamp: NOW_S + 2,
    },
    null,
    sid,
  );
  check('B4 an outbound message is not unread', () => assert.equal(unreadOf(PN), 2));
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
