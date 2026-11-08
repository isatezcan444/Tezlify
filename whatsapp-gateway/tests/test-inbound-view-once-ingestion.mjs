import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';
import { summarizeWaMessage } from '../src/messages/message-classifier.js';

console.log('Testing inbound View Once ingestion contracts with companion key hints...');

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-vo-ingest-test-'));
try {
  const sm = createSessionManager({
    sessionsDir: dir,
    mediaDir: dir,
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });

  const sid = (await sm.createSession('vo-test', { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  session.ephemeral = true;

  const ev = new EventEmitter();
  const sock = {
    ev,
    isClosed: false,
    async readMessages() { return true; },
    async chatModify() { return true; },
  };

  session.sock = sock;
  const gen = session.lifecycle.beginAttempt();
  session.lifecycle.attach(gen, sock);
  bindSocketEvents({ manager: sm, session, sock, id: sid, generation: gen });

  const jid = '905413749073-1589570212@g.us';

  // 1. Companion stanza: key.isViewOnce = true, message = undefined
  const voCompanionMsg = {
    key: {
      remoteJid: jid,
      id: '3A3722FDB1BAA33AB219',
      fromMe: true,
      isViewOnce: true,
    },
    messageTimestamp: 1794086750,
  };

  const record1 = await sm._ingestUpsertMessage(voCompanionMsg, sock, sid, { upsertType: 'notify' });
  assert.ok(record1, 'View Once companion message must NOT be dropped as null');
  assert.equal(record1.wa_message_id, '3A3722FDB1BAA33AB219');
  assert.equal(record1.is_view_once, true, 'is_view_once must be true');
  assert.equal(record1.body, '[VIEW_ONCE_MEDIA]', 'Generic unknown View Once must have [VIEW_ONCE_MEDIA] placeholder');
  assert.equal(record1.message_type, 'UNKNOWN', 'Generic unknown View Once must have UNKNOWN message_type');
  assert.equal(record1.media_mime_type, null, 'Must not synthesize fake image/jpeg when media type is unknown');
  assert.equal(record1.media_id, null, 'Must not synthesize fake media_id');

  // 2. Ingesting duplicate of the same View Once message must be deduplicated
  const dupRecord = await sm._ingestUpsertMessage(voCompanionMsg, sock, sid, { upsertType: 'notify' });
  assert.equal(dupRecord, null, 'Duplicate View Once message must be deduplicated to null');

  // 3. Companion stanza with photo content: viewOnceMessage with imageMessage
  const voPhotoMsg = {
    key: {
      remoteJid: jid,
      id: '3A3722FDB1BAA33AB220',
      fromMe: false,
      participant: '905551234567@s.whatsapp.net',
      isViewOnce: true,
    },
    message: {
      viewOnceMessage: {
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            fileLength: 1024,
          },
        },
      },
    },
    messageTimestamp: 1794086755,
  };

  const record2 = await sm._ingestUpsertMessage(voPhotoMsg, sock, sid, { upsertType: 'notify' });
  assert.ok(record2, 'View Once photo must be ingested');
  assert.equal(record2.wa_message_id, '3A3722FDB1BAA33AB220');
  assert.equal(record2.is_view_once, true);
  assert.equal(record2.body, '[VIEW_ONCE_PHOTO]');
  assert.equal(record2.message_type, 'IMAGE');
  assert.equal(record2.media_mime_type, 'image/jpeg');

  // 4. Companion stanza with video content: viewOnceMessageV2 with videoMessage
  const voVideoMsg = {
    key: {
      remoteJid: jid,
      id: '3A3722FDB1BAA33AB221',
      fromMe: false,
      participant: '905551234567@s.whatsapp.net',
    },
    message: {
      viewOnceMessageV2: {
        message: {
          videoMessage: {
            mimetype: 'video/mp4',
            fileLength: 2048,
          },
        },
      },
    },
    messageTimestamp: 1794086760,
  };

  const record3 = await sm._ingestUpsertMessage(voVideoMsg, sock, sid, { upsertType: 'notify' });
  assert.ok(record3, 'View Once video must be ingested');
  assert.equal(record3.wa_message_id, '3A3722FDB1BAA33AB221');
  assert.equal(record3.is_view_once, true);
  assert.equal(record3.body, '[VIEW_ONCE_VIDEO]');
  assert.equal(record3.message_type, 'VIDEO');
  assert.equal(record3.media_mime_type, 'video/mp4');

  // 5. Test summarizeWaMessage with companion stanza (key.isViewOnce = true, no message)
  const summary = summarizeWaMessage(voCompanionMsg);
  assert.ok(summary, 'summarizeWaMessage must not drop key-only View Once');
  assert.equal(summary.body, '[VIEW_ONCE_MEDIA]');
  assert.equal(summary.message_type, 'UNKNOWN');

  // 6. Non-view-once empty stub message should still be dropped
  const emptyStubMsg = {
    key: {
      remoteJid: jid,
      id: 'STUB_DROP_1',
      fromMe: false,
      isViewOnce: false,
    },
    messageTimestamp: 1794086770,
  };
  const dropRecord = await sm._ingestUpsertMessage(emptyStubMsg, sock, sid, { upsertType: 'notify' });
  assert.equal(dropRecord, null, 'Non-view-once empty stub must be dropped as null');

  // 7. Test historyMessageToRecord
  const historyRecord = sm._historyMessageToRecord(session, voCompanionMsg, jid);
  assert.ok(historyRecord, '_historyMessageToRecord must not drop key-only View Once');
  assert.equal(historyRecord.is_view_once, true);
  assert.equal(historyRecord.body, '[VIEW_ONCE_MEDIA]');
  assert.equal(historyRecord.message_type, 'UNKNOWN');

  console.log('✅ Inbound View Once ingestion contracts verified successfully!');
} finally {
  await rm(dir, { recursive: true, force: true });
}
