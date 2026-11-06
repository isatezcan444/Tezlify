import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  unwrapMessageContent,
  extractProtocolMessage,
  systemContentMarker,
  classifyMessageType,
  hasRecognizedContent,
} from '../src/messages/message-classifier.js';
import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

// --- A. Classifier & Unwrapping Tests ---

// 1. Unwrap editedMessage.message variants
const e1 = { editedMessage: { message: { conversation: 'günaydınlar' } } };
assert.deepEqual(unwrapMessageContent(e1), { conversation: 'günaydınlar' });
assert.equal(hasRecognizedContent(e1), true);
assert.equal(classifyMessageType(e1), 'TEXT');

const e2 = { editedMessage: { message: { extendedTextMessage: { text: 'günaydınlar 🌟' } } } };
assert.deepEqual(unwrapMessageContent(e2), { extendedTextMessage: { text: 'günaydınlar 🌟' } });
assert.equal(hasRecognizedContent(e2), true);
assert.equal(classifyMessageType(e2), 'TEXT');

const e3 = {
  editedMessage: {
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'ORIG_1' },
        editedMessage: { conversation: 'günaydınlar nested' },
      },
    },
  },
};
assert.deepEqual(unwrapMessageContent(e3), { conversation: 'günaydınlar nested' });

// 2. extractProtocolMessage
assert.equal(extractProtocolMessage(null), null);
assert.equal(extractProtocolMessage({}), null);

const p1 = {
  protocolMessage: {
    type: 14,
    key: { id: 'ORIG_1', remoteJid: '905442767554@s.whatsapp.net', fromMe: true },
    editedMessage: { conversation: 'günaydınlar' },
  },
};
assert.equal(extractProtocolMessage(p1)?.type, 14);
assert.equal(extractProtocolMessage(p1)?.key?.id, 'ORIG_1');

const pWrapped = {
  ephemeralMessage: {
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'ORIG_2' },
        editedMessage: { conversation: 'hello' },
      },
    },
  },
};
assert.equal(extractProtocolMessage(pWrapped)?.type, 14);
assert.equal(extractProtocolMessage(pWrapped)?.key?.id, 'ORIG_2');

// 3. systemContentMarker treats MESSAGE_EDIT (14) as real content (returns null), not [SYSTEM]
assert.equal(systemContentMarker({ message: p1 }), null);
assert.equal(systemContentMarker({ message: { protocolMessage: { type: 0 } } }), '[REVOKED]');
assert.equal(systemContentMarker({ message: { protocolMessage: { type: 3 } } }), '[SYSTEM]');

console.log('ok - Classifier and unwrapping assertions passed');

// --- B. SessionManager Ingestion of Edited Message ---
const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-edit-test-'));
try {
  const sm = createSessionManager({
    sessionsDir: dir,
    mediaDir: dir,
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });

  const sid = (await sm.createSession('msg-edit', { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  session.ephemeral = true;

  const ev = new EventEmitter();
  const sock = { ev, async readMessages() { return true; } };
  session.sock = sock;
  const gen = session.lifecycle.beginAttempt();
  session.lifecycle.attach(gen, sock);

  bindSocketEvents({ manager: sm, session, sock, id: sid, generation: gen });

  const emittedEvents = [];
  sm.onEvent((event) => emittedEvents.push(event));

  const jid = '905442767554@s.whatsapp.net';

  // 1. Ingest original message
  const origMsg = {
    key: { remoteJid: jid, id: 'WA_ORIG_MSG_1', fromMe: true },
    message: { conversation: 'günaydın' },
    messageTimestamp: 1730889000,
  };
  await sm._ingestUpsertMessage(origMsg, sock, sid, { upsertType: 'notify' });

  const store = session.store;
  const chatMsgs = store.messagesByChat.get(jid) || [];
  assert.equal(chatMsgs.length, 1);
  assert.equal(chatMsgs[0].body, 'günaydın');
  assert.equal(chatMsgs[0].wa_message_id, 'WA_ORIG_MSG_1');
  assert.equal(chatMsgs[0].is_edited, false);

  // 2. Ingest edit protocol message via messages.upsert
  const editMsg = {
    key: { remoteJid: jid, id: 'WA_EDIT_STANZA_1', fromMe: true },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'WA_ORIG_MSG_1', remoteJid: jid, fromMe: true },
        editedMessage: { conversation: 'günaydınlar' },
        timestampMs: 1730889050000,
      },
    },
    messageTimestamp: 1730889050,
  };
  await sm._ingestUpsertMessage(editMsg, sock, sid, { upsertType: 'notify' });

  // Verify original message was updated in-place with new text and is_edited flag
  assert.equal(chatMsgs.length, 1, 'Should still be 1 message (updated in-place)');
  assert.equal(chatMsgs[0].wa_message_id, 'WA_ORIG_MSG_1');
  assert.equal(chatMsgs[0].body, 'günaydınlar');
  assert.equal(chatMsgs[0].is_edited, true);
  assert.ok(chatMsgs[0].edited_at);

  // Verify event emitted to backend
  const replaceEvents = emittedEvents.filter((e) => e.upsert_type === 'replace');
  assert.equal(replaceEvents.length, 1, 'Emitted exactly 1 replace event');
  assert.equal(replaceEvents[0].message.wa_message_id, 'WA_ORIG_MSG_1');
  assert.equal(replaceEvents[0].message.body, 'günaydınlar');
  assert.equal(replaceEvents[0].message.is_edited, true);

  console.log('ok - In-place message edit ingestion and broadcast passed');
  console.log('ALL EDITED MESSAGE TESTS PASSED!');
} finally {
  await rm(dir, { recursive: true, force: true });
}
