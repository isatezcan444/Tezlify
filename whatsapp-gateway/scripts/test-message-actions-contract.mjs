import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

console.log('--- Starting WhatsApp Gateway Message Actions Contract Suite ---');

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-actions-test-'));
try {
  const sm = createSessionManager({
    sessionsDir: dir,
    mediaDir: dir,
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });

  const sid = (await sm.createSession('msg-actions', { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  session.ephemeral = true;

  const ev = new EventEmitter();
  const dispatchedCalls = [];

  const sock = {
    ev,
    async readMessages() { return true; },
    async sendMessage(jid, content, options) {
      dispatchedCalls.push({ method: 'sendMessage', jid, content, options });
      return { key: { id: 'OUT_STANZA_1', remoteJid: jid } };
    },
    async chatModify(mod, jid) {
      dispatchedCalls.push({ method: 'chatModify', mod, jid });
      return true;
    },
    async star(jid, keys, star) {
      dispatchedCalls.push({ method: 'star', jid, keys, star });
      return true;
    },
  };

  session.sock = sock;
  const gen = session.lifecycle.beginAttempt();
  session.lifecycle.attach(gen, sock);

  bindSocketEvents({ manager: sm, session, sock, id: sid, generation: gen });

  const emittedEvents = [];
  sm.onEvent((event) => emittedEvents.push(event));

  const jid = '905551234567@s.whatsapp.net';

  // Seed store with an outbound message and an inbound message
  const msg1 = {
    key: { remoteJid: jid, id: 'MSG_OUT_1', fromMe: true },
    message: { conversation: 'Original outbound text' },
    messageTimestamp: 1730889000,
  };
  const msg2 = {
    key: { remoteJid: jid, id: 'MSG_IN_1', fromMe: false },
    message: { conversation: 'Original inbound text' },
    messageTimestamp: 1730889010,
  };
  await sm._ingestUpsertMessage(msg1, sock, sid, { upsertType: 'notify' });
  await sm._ingestUpsertMessage(msg2, sock, sid, { upsertType: 'notify' });

  // 1. Outbound editMessage
  const editRes = await sm.editMessage(sid, jid, {
    target_wa_message_id: 'MSG_OUT_1',
    target_from_me: true,
    text: 'Revised outbound text',
  });
  assert.equal(editRes.success, true);
  assert.equal(editRes.body, 'Revised outbound text');
  const editCall = dispatchedCalls.find((c) => c.method === 'sendMessage' && c.content?.edit);
  assert.ok(editCall, 'Dispatched sendMessage with edit payload');
  assert.equal(editCall.content.text, 'Revised outbound text');
  assert.equal(editCall.content.edit.id, 'MSG_OUT_1');
  console.log('ok - Outbound editMessage dispatched correct Baileys payload');

  // Inbound editMessage rejected
  await assert.rejects(
    async () => {
      await sm.editMessage(sid, jid, {
        target_wa_message_id: 'MSG_IN_1',
        target_from_me: false,
        text: 'Forbidden inbound edit',
      });
    },
    /yalnızca kendi gönderdiğiniz/i
  );
  console.log('ok - Inbound editMessage rejected with fail-closed guard');

  // 2. Outbound deleteMessage for everyone (REVOKE)
  const delEveryoneRes = await sm.deleteMessage(sid, jid, {
    target_wa_message_id: 'MSG_OUT_1',
    target_from_me: true,
    delete_type: 'everyone',
  });
  assert.equal(delEveryoneRes.success, true);
  assert.equal(delEveryoneRes.delete_type, 'everyone');
  const delCall = dispatchedCalls.find((c) => c.method === 'sendMessage' && c.content?.delete);
  assert.ok(delCall, 'Dispatched sendMessage with delete payload');
  assert.equal(delCall.content.delete.id, 'MSG_OUT_1');
  console.log('ok - Outbound deleteMessage for everyone dispatched correct Baileys delete key');

  // 3. Outbound deleteMessage for me
  const delForMeRes = await sm.deleteMessage(sid, jid, {
    target_wa_message_id: 'MSG_IN_1',
    target_from_me: false,
    delete_type: 'for_me',
  });
  assert.equal(delForMeRes.success, true);
  assert.equal(delForMeRes.delete_type, 'for_me');
  const modifyCall = dispatchedCalls.find((c) => c.method === 'chatModify' && c.mod?.deleteForMe);
  assert.ok(modifyCall, 'Dispatched chatModify with deleteForMe payload');
  assert.equal(modifyCall.mod.deleteForMe.key.id, 'MSG_IN_1');
  console.log('ok - Outbound deleteMessage for me dispatched correct chatModify action');

  // 4. Outbound starMessage
  const starRes = await sm.starMessage(sid, jid, {
    target_wa_message_id: 'MSG_IN_1',
    target_from_me: false,
    star: true,
  });
  assert.equal(starRes.success, true);
  assert.equal(starRes.is_starred, true);
  const starCall = dispatchedCalls.find((c) => c.method === 'star');
  assert.ok(starCall, 'Dispatched star call');
  assert.equal(starCall.star, true);
  assert.equal(starCall.keys[0].id, 'MSG_IN_1');
  console.log('ok - Outbound starMessage dispatched correct Baileys star call');

  // 5. Inbound REVOKE via messages.upsert (protocolMessage type 0)
  const msgToRevoke = {
    key: { remoteJid: jid, id: 'MSG_TO_REVOKE', fromMe: false },
    message: { conversation: 'This message will be revoked' },
    messageTimestamp: 1730889015,
  };
  await sm._ingestUpsertMessage(msgToRevoke, sock, sid, { upsertType: 'notify' });

  const revokeMsg = {
    key: { remoteJid: jid, id: 'REVOKE_STANZA_1', fromMe: false },
    message: {
      protocolMessage: {
        type: 0, // REVOKE
        key: { id: 'MSG_TO_REVOKE', remoteJid: jid, fromMe: false },
      },
    },
    messageTimestamp: 1730889020,
  };
  await sm._ingestUpsertMessage(revokeMsg, sock, sid, { upsertType: 'notify' });

  // Store target message should be marked revoked
  const chatMsgs = session.store.messagesByChat.get(jid) || [];
  const targetInStore = chatMsgs.find((m) => m.wa_message_id === 'MSG_TO_REVOKE');
  assert.ok(targetInStore, 'Target message found in store');
  assert.equal(targetInStore.is_revoked, true);
  assert.ok(targetInStore.revoked_at);

  const revokeEvents = emittedEvents.filter((e) => e.event === 'message_deleted' && e.wa_message_id === 'MSG_TO_REVOKE');
  assert.equal(revokeEvents.length, 1, 'Emitted message_deleted event for revoke');
  assert.equal(revokeEvents[0].delete_type, 'everyone');
  assert.equal(revokeEvents[0].is_revoked, true);
  console.log('ok - Inbound REVOKE marked in store and emitted message_deleted');

  // 6. Inbound delete for me via messages.delete
  ev.emit('messages.delete', {
    keys: [{ remoteJid: jid, id: 'MSG_OUT_1', fromMe: true }],
  });
  // Wait a tick for event loop
  await new Promise((r) => setImmediate(r));
  const delForMeEvents = emittedEvents.filter((e) => e.event === 'messages_deleted' && e.delete_type === 'for_me');
  assert.equal(delForMeEvents.length, 1, 'Emitted messages_deleted with delete_type=for_me');
  console.log('ok - Inbound messages.delete event bridged as messages_deleted for_me');

  // 7. Inbound star update via messages.update
  ev.emit('messages.update', [
    {
      key: { remoteJid: jid, id: 'MSG_OUT_1', fromMe: true },
      update: { starred: true },
    },
  ]);
  await new Promise((r) => setImmediate(r));
  const starEvents = emittedEvents.filter((e) => e.event === 'message_starred' && e.wa_message_id === 'MSG_OUT_1');
  assert.equal(starEvents.length, 1, 'Emitted message_starred event');
  assert.equal(starEvents[0].is_starred, true);
  console.log('ok - Inbound messages.update starred bridged as message_starred');

  console.log('--- ALL WHATSAPP GATEWAY MESSAGE ACTIONS CONTRACT TESTS PASSED! ---');
} finally {
  await rm(dir, { recursive: true, force: true });
}
