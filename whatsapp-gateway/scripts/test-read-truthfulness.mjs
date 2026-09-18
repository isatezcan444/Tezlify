// Truthfulness regression test: "okundu" (read) must NOT be reported to the UI
// when WhatsApp never received the read receipt.
//
// Bug: `markConversationRead` set `gatewayOk = false` on provider failure but
// still zeroed `chat.unread_count` and emitted `conversation_read: 0`. The UI
// showed "read" while the counterparty still saw the message as unread —
// exactly the false-success class AGENTS.md §1.1 forbids.
//
// Run: `node scripts/test-read-truthfulness.mjs` — exit code 0 = PASS.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-read-'));
const sm = createSessionManager({
  sessionsDir: dir,
  mediaDir: dir,
  aesKey: '0'.repeat(64),
  backendWsUrl: '',
});
const sid = (await sm.createSession('read-truth-test', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';

const jid = '905551112233@s.whatsapp.net';
const events = [];
sm.onEvent((event) => events.push(event));

const readEvents = () => events.filter((e) => e.event === 'conversation_read');
const chat = () => sm._storeOf(session).chats.get(jid);

try {
  // -------------------------------------------------------------------------
  // 1. Provider rejects the read receipt -> honest failure, no state change
  // -------------------------------------------------------------------------
  sm._storeOf(session).chats.set(jid, { id: jid, unread_count: 4, last_message_at: null });
  session.sock = {
    async readMessages() {
      throw new Error('socket closed');
    },
  };

  const failed = await sm.markConversationRead(sid, jid);
  assert.equal(failed.success, false, 'read must report failure when the provider rejects');
  assert.ok(failed.error, 'the real provider error must be surfaced');
  assert.equal(readEvents().length, 0, 'a failed read must NOT emit conversation_read');
  assert.equal(chat().unread_count, 4, 'a failed read must NOT clear unread_count');
  console.log('  ok - failed read: success=false, no event, unread preserved');

  // -------------------------------------------------------------------------
  // 2. Provider accepts the read receipt -> honest success
  // -------------------------------------------------------------------------
  let providerCalls = 0;
  session.sock = {
    async readMessages() {
      providerCalls += 1;
    },
  };

  const ok = await sm.markConversationRead(sid, jid);
  assert.equal(ok.success, true, 'read must report success when the provider accepts');
  assert.equal(providerCalls, 1, 'the provider must be called exactly once');
  assert.equal(readEvents().length, 1, 'a successful read must emit conversation_read');
  assert.equal(readEvents()[0].unread_count, 0);
  assert.equal(chat().unread_count, 0, 'a successful read clears unread_count');
  console.log('  ok - successful read: success=true, event emitted, unread cleared');

  // -------------------------------------------------------------------------
  // 3. Not-connected session still fails closed (no fake success)
  // -------------------------------------------------------------------------
  session.status = 'DISCONNECTED';
  session.sock = null;
  await assert.rejects(
    () => sm.markConversationRead(sid, jid),
    /oturum|bagli|bağlı|connected|session/i,
    'a disconnected session must reject, never report success'
  );
  assert.equal(readEvents().length, 1, 'a rejected read must not emit a new event');
  console.log('  ok - disconnected session: rejects, no fake success');

  console.log('Mark-read truthfulness (failure / success / disconnected): PASS');
} finally {
  await rm(dir, { recursive: true, force: true });
}
