import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

console.log('[test-history-resilience] starting tests...');

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-resilience-'));
try {
  const sm = createSessionManager({ sessionsDir: dir, mediaDir: dir, aesKey: '0'.repeat(64), backendWsUrl: '' });
  const sid = (await sm.createSession('resilience-test', { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  const chatJid = '905551112233@s.whatsapp.net';

  // 1. Verify _historyMessageToRecord with documentMessage (the crash site at line 3098)
  const docHistoryMsg = {
    key: { id: 'doc_msg_1', remoteJid: chatJid, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      documentMessage: {
        fileName: 'contract.pdf',
        mimetype: 'application/pdf',
        fileLength: 12345,
      },
    },
  };

  const docRecord = sm._historyMessageToRecord(session, docHistoryMsg, chatJid);
  assert.ok(docRecord, 'Document history message should return a valid record');
  assert.equal(docRecord.message_type, 'DOCUMENT');
  assert.equal(docRecord.media_mime_type, 'application/pdf');
  assert.equal(docRecord.media_filename, 'contract.pdf');
  assert.equal(docRecord.wa_message_id, 'doc_msg_1');
  console.log('ok - 1: _historyMessageToRecord handles documentMessage without ReferenceError');

  // 2. Verify _historyMessageToRecord with fallback content (no media, unrecognized type)
  const emptyHistoryMsg = {
    key: { id: 'empty_msg_1', remoteJid: chatJid, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {},
  };
  const emptyRecord = sm._historyMessageToRecord(session, emptyHistoryMsg, chatJid);
  assert.equal(emptyRecord, null, 'Empty history message should return null');
  console.log('ok - 2: _historyMessageToRecord returns null for empty message');

  // 3. Verify _ingestUpsertMessage rejects protocolMessage (historySyncNotification / type 6)
  const historySyncProtocolMsg = {
    key: { id: '3A04C688A65A0527347A', remoteJid: chatJid, fromMe: true },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      protocolMessage: {
        type: 6, // HISTORY_SYNC_NOTIFICATION
        historySyncNotification: {
          fileSha256: 'abc',
          chunkOrder: 1,
        },
      },
    },
  };
  const ingestedProtocol = await sm._ingestUpsertMessage(historySyncProtocolMsg, null, sid);
  assert.equal(ingestedProtocol, null, 'Protocol message should return null and not be ingested');
  const store = sm._storeOf(session);
  const msgs = store.messagesByChat.get(chatJid) || [];
  assert.equal(msgs.length, 0, 'No messages should be stored for protocolMessage');
  console.log('ok - 3: _ingestUpsertMessage ignores protocolMessage (history sync notification)');

  // 4. Verify _ingestUpsertMessage rejects empty/unrecognized message
  const ghostMsg = {
    key: { id: 'ghost_123', remoteJid: chatJid, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {},
  };
  const ingestedGhost = await sm._ingestUpsertMessage(ghostMsg, null, sid);
  assert.equal(ingestedGhost, null, 'Ghost message without recognized content should return null');
  assert.equal((store.messagesByChat.get(chatJid) || []).length, 0);
  console.log('ok - 4: _ingestUpsertMessage ignores empty ghost messages');

  // 5. Verify _ingestUpsertMessage accepts valid text message
  const validTextMsg = {
    key: { id: 'valid_text_1', remoteJid: chatJid, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      conversation: 'Merhaba, bu geçerli bir mesajdır.',
    },
  };
  const ingestedValid = await sm._ingestUpsertMessage(validTextMsg, null, sid);
  assert.ok(ingestedValid, 'Valid text message should be ingested');
  assert.equal(ingestedValid.body, 'Merhaba, bu geçerli bir mesajdır.');
  assert.equal((store.messagesByChat.get(chatJid) || []).length, 1);
  console.log('ok - 5: _ingestUpsertMessage successfully ingests valid user message');

  console.log('[test-history-resilience] ALL 5 tests passed successfully!');
} finally {
  await rm(dir, { recursive: true, force: true });
}
