/**
 * LID identity resolved at INGEST time from the key's alternate address.
 *
 * PRODUCTION SYMPTOM (2026-10-01, "Syafira bana QR ile baglanti yaptigim sirada
 * yazdi, diyaloglarda gorunmuyor"): messages that arrive while the phone is
 * still linking are addressed by LID, and no LID→phone mapping has been learned
 * yet. `_ingestUpsertMessage` holds such a message (`lidHold`) and only emits it
 * if a mapping event arrives LATER — so at pairing time it is held indefinitely.
 *
 * Baileys already hands us the answer on the key: `WAMessageKey` declares
 * `remoteJidAlt` / `participantAlt`, the same entity's other address. Reading it
 * resolves identity immediately.
 *
 * A is the pure contract; B is the behavioural proof, and B2 is its own control:
 * the SAME message WITHOUT the alt field must still be held. If B2 ever emits,
 * the gate is measuring something other than the alt field.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';
import { lidPairsFromMessageKey } from '../src/utils/whatsapp-identity.js';

const LID = '111111111111111@lid';
const LID2 = '222222222222222@lid';
const PN = '905551112233@s.whatsapp.net';
const PN2 = '905559998877@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

const checks = [];
function check(label, fn) {
  try {
    fn();
    checks.push({ label, ok: true });
  } catch (err) {
    checks.push({ label, ok: false, err: err.message });
  }
}

// ---------------------------------------------------------------------------
// A. Pure contract
// ---------------------------------------------------------------------------
check('A1 LID remoteJid + phone alt yields the pair', () => {
  const pairs = lidPairsFromMessageKey({ remoteJid: LID, remoteJidAlt: PN });
  assert.deepEqual(pairs, [[LID, PN]]);
});

check('A2 phone remoteJid + LID alt yields the reversed pair', () => {
  const pairs = lidPairsFromMessageKey({ remoteJid: PN, remoteJidAlt: LID });
  assert.deepEqual(pairs, [[LID, PN]]);
});

check('A3 a participant alt is read too (group senders)', () => {
  const pairs = lidPairsFromMessageKey({
    remoteJid: GROUP,
    participant: LID2,
    participantAlt: PN2,
  });
  assert.deepEqual(pairs, [[LID2, PN2]]);
});

check('A4 a GROUP is never accepted as the phone half', () => {
  // Otherwise `lidToJid` would map a LID onto a group and every message from
  // that sender would be filed under the group.
  const pairs = lidPairsFromMessageKey({ remoteJid: LID, remoteJidAlt: GROUP });
  assert.deepEqual(pairs, [], 'a group jid must not become a LID mapping target');
});

check('A5 a bare number is not promoted to a LID', () => {
  const pairs = lidPairsFromMessageKey({ remoteJid: '905551112233', remoteJidAlt: PN });
  assert.deepEqual(pairs, []);
});

check('A6 both sides LID yields nothing', () => {
  const pairs = lidPairsFromMessageKey({ remoteJid: LID, remoteJidAlt: LID2 });
  assert.deepEqual(pairs, []);
});

check('A7 a junk key never throws', () => {
  assert.deepEqual(lidPairsFromMessageKey(null), []);
  assert.deepEqual(lidPairsFromMessageKey(undefined), []);
  assert.deepEqual(lidPairsFromMessageKey({}), []);
});

// ---------------------------------------------------------------------------
// B. Behavioural proof
// ---------------------------------------------------------------------------
const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-lid-alt-'));
const sm = createSessionManager({ sessionsDir: dir, mediaDir: dir, aesKey: '0'.repeat(64), backendWsUrl: '' });
const sid = (await sm.createSession('lid-alt-test', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';
// No durable session row in this harness; the LID write-through would be a
// no-op against a database that is not configured here.
session.ephemeral = true;

const NOW_S = Math.floor(Date.now() / 1000);
const events = [];
sm.onEvent((event) => events.push(event));
const newMessages = () =>
  events.filter((e) => e.event === 'message_new').map((e) => e.conversation_id);

try {
  // B1: with the alt field, the message lands on the PHONE identity.
  await sm._ingestUpsertMessage(
    {
      key: { remoteJid: LID, remoteJidAlt: PN, fromMe: false, id: 'ALT_1' },
      message: { conversation: 'merhaba' },
      messageTimestamp: NOW_S,
    },
    null,
    sid,
  );

  check('B1 a LID message with an alt phone jid is emitted, not held', () => {
    assert.ok(
      newMessages().includes(PN),
      `message_new must be emitted for ${PN} (got ${JSON.stringify(newMessages())})`,
    );
  });
  check('B2 it is NOT emitted under the LID identity', () =>
    assert.equal(newMessages().includes(LID), false));
  check('B3 the LID mapping is now remembered', () =>
    assert.equal(session.store.lidToJid.get(LID), PN));

  // B4: the CONTROL. Same message, no alt field -> still held (the old
  // behaviour). This is what makes B1 attributable to the alt field.
  const before = newMessages().length;
  await sm._ingestUpsertMessage(
    {
      key: { remoteJid: LID2, fromMe: false, id: 'NO_ALT_1' },
      message: { conversation: 'merhaba' },
      messageTimestamp: NOW_S,
    },
    null,
    sid,
  );
  check('B4 control: without an alt field the message is still held', () => {
    assert.equal(
      newMessages().length,
      before,
      'an unresolvable LID must still be held — otherwise this gate proves nothing',
    );
    assert.equal(newMessages().includes(LID2), false);
  });

  // B5: once the mapping IS known, a later LID message resolves normally —
  // which is the behaviour the hold exists for.
  await sm._ingestUpsertMessage(
    {
      key: { remoteJid: LID, remoteJidAlt: PN, fromMe: false, id: 'ALT_2' },
      message: { conversation: 'tekrar' },
      messageTimestamp: NOW_S + 1,
    },
    null,
    sid,
  );
  check('B5 repeated messages stay on the phone identity', () =>
    assert.deepEqual(newMessages(), [PN, PN]));
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
