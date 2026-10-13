import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-unread-prog-'));
const sm = createSessionManager({ sessionsDir: dir, mediaDir: dir, aesKey: '0'.repeat(64), backendWsUrl: '' });
const sid = (await sm.createSession('unread-prog', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';
session.ephemeral = true;

const ev = new EventEmitter();
const sock = {
  ev,
  async readMessages() {
    return true;
  },
};
session.sock = sock;
const gen = session.lifecycle.beginAttempt();
session.lifecycle.attach(gen, sock);

bindSocketEvents({
  manager: sm,
  session,
  sock,
  id: sid,
  generation: gen,
});

const emittedEvents = [];
sm.onEvent((event) => emittedEvents.push(event));

const PN = '905551112233@s.whatsapp.net';
const chatOf = () => session.store.chats.get(PN);

console.log('[test-unread-count-progression] Starting tests...');

try {
  // --- 1. Test progressive unread increment from 1 to 7 ---
  for (let i = 1; i <= 7; i++) {
    const msgId = `MSG_PROG_${i}`;
    const now = Math.floor(Date.now() / 1000) + i;
    const isMedia = i === 3;
    const waMsg = {
      key: { remoteJid: PN, fromMe: false, id: msgId },
      message: isMedia
        ? { imageMessage: { caption: `Resim ${i}`, mimetype: 'image/jpeg' } }
        : { conversation: `Mesaj ${i}` },
      messageTimestamp: now,
    };

    if (i % 2 === 1) {
      // Order A: chats.update before messages.upsert
      ev.emit('chats.update', [{
        id: PN,
        unreadCount: 1, // Baileys standard delta
        lastMessage: waMsg,
      }]);
      await sm._ingestUpsertMessage(waMsg, sock, sid);
    } else {
      // Order B: messages.upsert before chats.update
      await sm._ingestUpsertMessage(waMsg, sock, sid);
      ev.emit('chats.update', [{
        id: PN,
        unreadCount: 1,
        lastMessage: waMsg,
      }]);
    }

    const currentCount = chatOf()?.unread_count;
    assert.equal(currentCount, i, `Message ${i} must yield unread_count = ${i}, got ${currentCount}`);
    console.log(`  ok - Message ${i}: unread_count = ${currentCount}`);
  }

  // --- 2. Outbound message must not change unread count ---
  const outMsg = {
    key: { remoteJid: PN, fromMe: true, id: 'OUT_1' },
    message: { conversation: 'Cevap' },
    messageTimestamp: Math.floor(Date.now() / 1000) + 10,
  };
  await sm._ingestUpsertMessage(outMsg, sock, sid);
  ev.emit('chats.update', [{
    id: PN,
    unreadCount: undefined,
    lastMessage: outMsg,
  }]);
  assert.equal(chatOf()?.unread_count, 7, 'Outbound message must preserve unread_count = 7');
  console.log('  ok - Outbound message preserves unread_count = 7');

  // --- 3. Phone marks conversation as read (unreadCount: 0) ---
  ev.emit('chats.update', [{
    id: PN,
    unreadCount: 0,
  }]);
  assert.equal(chatOf()?.unread_count, 0, 'Phone read must reset unread_count to 0');
  console.log('  ok - Phone read resets unread_count to 0');

  // --- 4. Phone marks conversation as unread (unreadCount: -1) ---
  ev.emit('chats.update', [{
    id: PN,
    unreadCount: -1,
  }]);
  assert.equal(chatOf()?.unread_count, 1, 'Phone mark-unread must set unread_count to 1');
  console.log('  ok - Phone mark-unread sets unread_count to 1');

  // --- 5. New message arriving after mark-unread accumulates to 2 ---
  const msgAfterMarkUnread = {
    key: { remoteJid: PN, fromMe: false, id: 'MSG_AFTER_UNREAD' },
    message: { conversation: 'Yeni mesaj' },
    messageTimestamp: Math.floor(Date.now() / 1000) + 20,
  };
  await sm._ingestUpsertMessage(msgAfterMarkUnread, sock, sid);
  ev.emit('chats.update', [{
    id: PN,
    unreadCount: 1,
    lastMessage: msgAfterMarkUnread,
  }]);
  assert.equal(chatOf()?.unread_count, 2, 'Message after mark-unread must increment to 2');
  console.log('  ok - Message after mark-unread increments to 2');

  // --- 6. Reading in Tezlify (markConversationRead) clears unread count ---
  const readRes = await sm.markConversationRead(sid, PN);
  assert.equal(readRes.success, true);
  assert.equal(chatOf()?.unread_count, 0, 'Tezlify read must reset unread_count to 0');
  console.log('  ok - Tezlify read resets unread_count to 0');

  // --- 7. Next messages continue accumulating cleanly: 1, 2, 3... ---
  for (let j = 1; j <= 3; j++) {
    const postMsg = {
      key: { remoteJid: PN, fromMe: false, id: `POST_MSG_${j}` },
      message: { conversation: `Sonraki mesaj ${j}` },
      messageTimestamp: Math.floor(Date.now() / 1000) + 30 + j,
    };
    await sm._ingestUpsertMessage(postMsg, sock, sid);
    ev.emit('chats.update', [{
      id: PN,
      unreadCount: 1,
      lastMessage: postMsg,
    }]);
    assert.equal(chatOf()?.unread_count, j);
    console.log(`  ok - Post-read Message ${j}: unread_count = ${j}`);
  }

  console.log('\n[test-unread-count-progression] ALL ASSERTIONS PASSED (1,2,3,4,5,6,7... progression verified)!');
} finally {
  await rm(dir, { recursive: true, force: true });
}
