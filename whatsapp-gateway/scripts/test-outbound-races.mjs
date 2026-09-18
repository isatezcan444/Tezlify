import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { createSessionManager } from '../src/session-manager.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-races-'));
const sm = createSessionManager({ sessionsDir: dir, mediaDir: dir, aesKey: '0'.repeat(64), backendWsUrl: '' });
const sid = (await sm.createSession('race-test', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';
const jid = '905551112233@s.whatsapp.net';
const events = [];
sm.onEvent((event) => events.push(event));
try {
  for (const media of [false, true]) {
    for (const ackFirst of [false, true]) {
      const clientId = `client-${media}-${ackFirst}`;
      session.sock = { async sendMessage(remoteJid, content, options) {
        assert.ok(options.messageId);
        const key = { remoteJid, id: options.messageId, fromMe: true };
        const pending = (await sm.getMessages(sid, jid)).find((m) => m.client_message_id === clientId);
        assert.equal(pending.status, 'PENDING');
        sm._applyMessageAck(sid, key, { status: proto.WebMessageInfo.Status.PENDING });
        assert.equal(pending.status, 'PENDING');
        const echo = () => sm._ingestUpsertMessage({ key, message: { conversation: 'body' } }, null, sid);
        if (!ackFirst) await echo();
        sm._applyMessageAck(sid, key, { status: proto.WebMessageInfo.Status.READ });
        if (ackFirst) await echo();
        sm._applyMessageAck(sid, key, { status: proto.WebMessageInfo.Status.SERVER_ACK });
        sm._applyMessageAck(sid, key, { status: proto.WebMessageInfo.Status.READ });
        return { key };
      } };
      const result = media
        ? await sm.sendMediaMessage(sid, jid, { media_type: 'image', media_url: 'https://example.invalid/image', client_message_id: clientId })
        : await sm.sendTextMessage(sid, jid, 'body', clientId);
      assert.equal(result.status, 'READ');
      assert.equal((await sm.getMessages(sid, jid)).filter((m) => m.client_message_id === clientId).length, 1);
      assert.equal(events.filter((e) => e.event === 'message_status_updated' && e.client_message_id === clientId).length, 1);
    }
  }
  session.sock = { async sendMessage(remoteJid, content, options) { return { key: { id: options.messageId } }; } };
  assert.equal((await sm.sendTextMessage(sid, jid, 'body', 'no-ack')).status, 'SENT');
  session.sock = { async sendMessage() { throw new Error('provider unavailable'); } };
  await assert.rejects(sm.sendTextMessage(sid, jid, 'body', 'failed'), /provider unavailable/);
  assert.equal((await sm.getMessages(sid, jid)).find((m) => m.client_message_id === 'failed').status, 'FAILED');
  console.log('Outbound text/media ACK/echo permutations, duplicate ACKs, promise-only and failure: PASS');
} finally {
  await rm(dir, { recursive: true, force: true });
}