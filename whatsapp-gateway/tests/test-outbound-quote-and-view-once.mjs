import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

console.log('Testing outbound quote and view-once gateway contracts...');

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-quote-test-'));
try {
  const sm = createSessionManager({
    sessionsDir: dir,
    mediaDir: dir,
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });

  const sid = (await sm.createSession('quote-viewonce', { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  session.ephemeral = true;

  const ev = new EventEmitter();
  const dispatchedCalls = [];

  const sock = {
    ev,
    isClosed: false,
    async readMessages() { return true; },
    async sendMessage(jid, content, options) {
      dispatchedCalls.push({ method: 'sendMessage', jid, content, options });
      return {
        key: { id: options?.messageId || 'OUT_STANZA_1', remoteJid: jid, fromMe: true },
        message: content,
      };
    },
    async chatModify() { return true; },
    async star() { return true; },
  };

  session.sock = sock;
  const gen = session.lifecycle.beginAttempt();
  session.lifecycle.attach(gen, sock);
  bindSocketEvents({ manager: sm, session, sock, id: sid, generation: gen });

  const store = sm._storeOf(session);
  const jid = '905551234567@s.whatsapp.net';

  // 1. Test _resolveQuotedOption from rawMessagesByChat
  store.rawMessagesByChat = new Map([
    [
      jid,
      new Map([
        [
          'WA_ORIG_1',
          {
            key: { id: 'WA_ORIG_1', remoteJid: jid, fromMe: false },
            message: { conversation: 'Merhaba dünya' },
          },
        ],
      ]),
    ],
  ]);

  const resolvedOpt1 = sm._resolveQuotedOption(session, jid, {
    quoted_wa_message_id: 'WA_ORIG_1',
  });
  assert.ok(resolvedOpt1, 'Should resolve raw message from chat store');
  assert.equal(resolvedOpt1.key.id, 'WA_ORIG_1');
  assert.equal(resolvedOpt1.message.conversation, 'Merhaba dünya');

  // 2. Test _resolveQuotedOption synthesized from metadata
  const resolvedOpt2 = sm._resolveQuotedOption(session, jid, {
    quoted: {
      stanza_id: 'SYNTH_1',
      participant: '+905411112233', // unnormalized phone with plus
      message_type: 'IMAGE',
      body: 'Görsel açıklaması',
    },
  });
  assert.ok(resolvedOpt2, 'Should synthesize quoted option');
  assert.equal(resolvedOpt2.key.id, 'SYNTH_1');
  assert.equal(resolvedOpt2.key.participant, '905411112233@s.whatsapp.net', 'Participant should be normalized with @s.whatsapp.net');
  assert.ok(resolvedOpt2.message.imageMessage, 'Should build imageMessage protobuf structure');
  assert.equal(resolvedOpt2.message.imageMessage.caption, 'Görsel açıklaması');

  // 2b. Test cross-chat quote isolation (message stored in another chat is NOT resolved)
  const otherJid = '905329998877@s.whatsapp.net';
  store.rawMessagesByChat.set(otherJid, new Map([
    ['WA_OTHER_CHAT_1', { key: { id: 'WA_OTHER_CHAT_1', remoteJid: otherJid }, message: { conversation: 'Gizli chat B' } }],
  ]));
  const crossChatResolve = sm._resolveQuotedOption(session, jid, {
    quoted_wa_message_id: 'WA_OTHER_CHAT_1',
  });
  // Since it belongs to otherJid and not jid, and no synthetic quoted object was passed, it must return null!
  assert.equal(crossChatResolve, null, 'Cross-chat raw message lookup must return null (isolated per chat)');

  // 3. Test sendTextMessage with quote
  dispatchedCalls.length = 0;
  const textRes = await sm.sendTextMessage(
    sid,
    jid,
    'Bu bir yanıttır',
    'client_msg_1',
    { quoted_wa_message_id: 'WA_ORIG_1' }
  );
  assert.equal(dispatchedCalls.length, 1);
  assert.equal(dispatchedCalls[0].content.text, 'Bu bir yanıttır');
  assert.ok(dispatchedCalls[0].options.quoted, 'Sock should receive quoted option');
  assert.equal(dispatchedCalls[0].options.quoted.key.id, 'WA_ORIG_1');
  assert.ok(textRes.quoted_message, 'Outbound record should include quoted_message');
  assert.equal(textRes.quoted_message.stanza_id, 'WA_ORIG_1');

  // 4. Test sendMediaMessage with view_once and quote
  dispatchedCalls.length = 0;
  const mediaRes = await sm.sendMediaMessage(
    sid,
    jid,
    {
      media_type: 'IMAGE',
      media_base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64'),
      caption: 'Tek seferlik bak',
      client_message_id: 'client_media_1',
      view_once: true,
      quoted_wa_message_id: 'WA_ORIG_1',
    }
  );
  assert.equal(dispatchedCalls.length, 1);
  assert.equal(dispatchedCalls[0].content.viewOnce, true, 'Content should have viewOnce: true');
  assert.ok(dispatchedCalls[0].options.quoted, 'Sock should receive quoted option');
  assert.equal(mediaRes.is_view_once, true, 'Outbound record should have is_view_once: true');
  assert.ok(mediaRes.quoted_message, 'Outbound record should include quoted_message');

  // 5. Test downloadMediaOnDemand blocks View Once
  store.rawMessagesByChat.set(
    jid,
    new Map([
      [
        'VO_MSG_1',
        {
          viewOnceMessage: {
            message: {
              imageMessage: { url: 'https://mmg.whatsapp.net/vo' },
            },
          },
        },
      ],
    ])
  );
  const dlResult = await sm.downloadMediaOnDemand(sid, 'VO_MSG_1');
  assert.equal(dlResult, null, 'downloadMediaOnDemand MUST return null for View Once messages');

  console.log('✅ All outbound quote and view-once gateway contracts passed successfully!');
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
