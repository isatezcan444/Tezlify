import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import { aesEncryptGCM, hmacSign } from '@whiskeysockets/baileys/lib/Utils/crypto.js';
import {
  unwrapMessageContent,
  extractProtocolMessage,
  systemContentMarker,
  classifyMessageType,
  isViewOnceMessage,
} from '../src/messages/message-classifier.js';
import { createSessionManager, decryptSecretEncryptedEdit, isMsmsgDecryptionEnabled } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

// Enable MSMSG decryption feature flag for crypto test verification
process.env.WHATSAPP_ENABLE_MSMSG_DECRYPTION = 'true';

console.log('=== RUNNING 26-SCENARIO MESSAGE EDIT PROTOCOL & DEVICE SENT HOTFIX TEST SUITE ===');

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-edit-device-sent-test-'));

try {
  const sm = createSessionManager({
    sessionsDir: dir,
    mediaDir: dir,
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });

  const sid = (await sm.createSession('test-edit-suite', { autoStart: false })).id;
  const session = sm.getSession(sid);
  session.status = 'CONNECTED';
  session.ephemeral = true;

  const ev = new EventEmitter();
  const ws = new EventEmitter();
  const sock = { ev, ws, async readMessages() { return true; } };
  session.sock = sock;
  const gen = session.lifecycle.beginAttempt();
  session.lifecycle.attach(gen, sock);

  bindSocketEvents({ manager: sm, session, sock, id: sid, generation: gen });

  const emittedEvents = [];
  sm.onEvent((event) => emittedEvents.push(event));

  const jid = '905076382749@s.whatsapp.net';
  const store = session.store;

  // -------------------------------------------------------------
  // Scenario 1: deviceSentMessage containing MESSAGE_EDIT (type 14) from phone
  // -------------------------------------------------------------
  console.log('Test 1: deviceSentMessage containing MESSAGE_EDIT (type 14)');
  const origMsg1 = {
    key: { remoteJid: jid, id: 'SCENARIO_1_ORIG', fromMe: true },
    message: { conversation: 'E2E Düzenleme Testi' },
    messageTimestamp: 1730889000,
  };
  await sm._ingestUpsertMessage(origMsg1, sock, sid, { upsertType: 'notify' });

  const chatMsgs1 = store.messagesByChat.get(jid) || [];
  assert.equal(chatMsgs1.length, 1);
  assert.equal(chatMsgs1[0].body, 'E2E Düzenleme Testi');
  assert.equal(chatMsgs1[0].is_edited, false);

  const editPhoneMsg = {
    key: { remoteJid: jid, id: 'STANZA_PHONE_EDIT_1', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: jid,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'SCENARIO_1_ORIG', remoteJid: jid, fromMe: true },
            editedMessage: { conversation: 'E2E Düzenleme Testi (Başarılı Düzenleme)' },
            timestampMs: 1730889050000,
          },
        },
      },
    },
    messageTimestamp: 1730889050,
  };
  await sm._ingestUpsertMessage(editPhoneMsg, sock, sid, { upsertType: 'notify' });

  assert.equal(chatMsgs1.length, 1, 'Should still have 1 message in chat (in-place update)');
  assert.equal(chatMsgs1[0].body, 'E2E Düzenleme Testi (Başarılı Düzenleme)');
  assert.equal(chatMsgs1[0].is_edited, true);
  assert.ok(chatMsgs1[0].edited_at);

  const rep1 = emittedEvents.filter((e) => e.upsert_type === 'replace' && e.message?.wa_message_id === 'SCENARIO_1_ORIG');
  assert.equal(rep1.length, 1, 'Emitted exactly 1 replace event for SCENARIO_1_ORIG');
  assert.equal(rep1[0].message.body, 'E2E Düzenleme Testi (Başarılı Düzenleme)');
  console.log('  ok - Test 1 passed');

  // -------------------------------------------------------------
  // Scenario 2: Direct protocolMessage containing MESSAGE_EDIT (type 14)
  // -------------------------------------------------------------
  console.log('Test 2: Direct protocolMessage containing MESSAGE_EDIT');
  const origMsg2 = {
    key: { remoteJid: jid, id: 'SCENARIO_2_ORIG', fromMe: false },
    message: { conversation: 'inbound text' },
    messageTimestamp: 1730889100,
  };
  await sm._ingestUpsertMessage(origMsg2, sock, sid, { upsertType: 'notify' });

  const editDirectMsg = {
    key: { remoteJid: jid, id: 'STANZA_DIRECT_EDIT_2', fromMe: false },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'SCENARIO_2_ORIG', remoteJid: jid, fromMe: false },
        editedMessage: { conversation: 'inbound text edited' },
        timestampMs: 1730889150000,
      },
    },
    messageTimestamp: 1730889150,
  };
  await sm._ingestUpsertMessage(editDirectMsg, sock, sid, { upsertType: 'notify' });

  const target2 = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === 'SCENARIO_2_ORIG');
  assert.ok(target2);
  assert.equal(target2.body, 'inbound text edited');
  assert.equal(target2.is_edited, true);
  console.log('  ok - Test 2 passed');

  // -------------------------------------------------------------
  // Scenario 3: Normal text message (regression test)
  // -------------------------------------------------------------
  console.log('Test 3: Normal text message regression');
  const origMsg3 = {
    key: { remoteJid: jid, id: 'SCENARIO_3_NORMAL', fromMe: false },
    message: { conversation: 'normal text message' },
    messageTimestamp: 1730889200,
  };
  await sm._ingestUpsertMessage(origMsg3, sock, sid, { upsertType: 'notify' });
  const target3 = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === 'SCENARIO_3_NORMAL');
  assert.ok(target3);
  assert.equal(target3.body, 'normal text message');
  assert.equal(target3.is_edited, false);
  console.log('  ok - Test 3 passed');

  // -------------------------------------------------------------
  // Scenario 4: Quoted/reply message (regression test)
  // -------------------------------------------------------------
  console.log('Test 4: Quoted/reply message regression');
  const quoteMsg = {
    key: { remoteJid: jid, id: 'SCENARIO_4_REPLY', fromMe: true },
    message: {
      extendedTextMessage: {
        text: 'reply text',
        contextInfo: {
          stanzaId: 'SCENARIO_3_NORMAL',
          participant: jid,
          quotedMessage: { conversation: 'normal text message' },
        },
      },
    },
    messageTimestamp: 1730889250,
  };
  await sm._ingestUpsertMessage(quoteMsg, sock, sid, { upsertType: 'notify' });
  const target4 = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === 'SCENARIO_4_REPLY');
  assert.ok(target4);
  assert.ok(target4.quoted_message);
  assert.equal(target4.quoted_message.stanza_id, 'SCENARIO_3_NORMAL');
  console.log('  ok - Test 4 passed');

  // -------------------------------------------------------------
  // Scenario 5: Duplicate edit replay idempotency
  // -------------------------------------------------------------
  console.log('Test 5: Duplicate edit replay idempotency');
  const repCountBefore = emittedEvents.filter((e) => e.upsert_type === 'replace' && e.message?.wa_message_id === 'SCENARIO_1_ORIG').length;
  // Re-ingest the exact same edit message
  await sm._ingestUpsertMessage(editPhoneMsg, sock, sid, { upsertType: 'notify' });
  const chatMsgs5 = store.messagesByChat.get(jid) || [];
  const matches1 = chatMsgs5.filter((m) => m.wa_message_id === 'SCENARIO_1_ORIG');
  assert.equal(matches1.length, 1, 'Still strictly 1 record for SCENARIO_1_ORIG');
  assert.equal(matches1[0].body, 'E2E Düzenleme Testi (Başarılı Düzenleme)');
  console.log('  ok - Test 5 passed');

  // -------------------------------------------------------------
  // Scenario 6: Original message not found in memory (synthesizes record)
  // -------------------------------------------------------------
  console.log('Test 6: Original message not found in memory (synth placeholder)');
  const missingEditMsg = {
    key: { remoteJid: jid, id: 'STANZA_MISSING_EDIT_6', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: jid,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'SCENARIO_6_HISTORICAL', remoteJid: jid, fromMe: true },
            editedMessage: { conversation: 'historical message edited' },
            timestampMs: 1730889300000,
          },
        },
      },
    },
    messageTimestamp: 1730889300,
  };
  await sm._ingestUpsertMessage(missingEditMsg, sock, sid, { upsertType: 'notify' });
  const target6 = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === 'SCENARIO_6_HISTORICAL');
  assert.ok(target6, 'Synthetic record created with target wa_message_id');
  assert.equal(target6.body, 'historical message edited');
  assert.equal(target6.is_edited, true);
  const rep6 = emittedEvents.filter((e) => e.upsert_type === 'replace' && e.message?.wa_message_id === 'SCENARIO_6_HISTORICAL');
  assert.equal(rep6.length, 1, 'Replace event emitted for historical edit');
  console.log('  ok - Test 6 passed');

  // -------------------------------------------------------------
  // Scenario 7: Mismatched remoteJid / ID handling (re-routes target chat)
  // -------------------------------------------------------------
  console.log('Test 7: Mismatched remoteJid in peer stanza');
  const otherJid = '905551234567@s.whatsapp.net';
  const origMsg7 = {
    key: { remoteJid: otherJid, id: 'SCENARIO_7_TARGET', fromMe: true },
    message: { conversation: 'target chat text' },
    messageTimestamp: 1730889400,
  };
  await sm._ingestUpsertMessage(origMsg7, sock, sid, { upsertType: 'notify' });

  // Stanza arrived addressed to me/companion JID, but deviceSentMessage points to otherJid
  const mismatchedEditMsg = {
    key: { remoteJid: 'status@broadcast', id: 'STANZA_BROADCAST_WRAP', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: otherJid,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'SCENARIO_7_TARGET', remoteJid: otherJid, fromMe: true },
            editedMessage: { conversation: 'target chat text edited via peer stanza' },
            timestampMs: 1730889450000,
          },
        },
      },
    },
    messageTimestamp: 1730889450,
  };
  await sm._ingestUpsertMessage(mismatchedEditMsg, sock, sid, { upsertType: 'notify' });

  const target7 = (store.messagesByChat.get(otherJid) || []).find((m) => m.wa_message_id === 'SCENARIO_7_TARGET');
  assert.ok(target7, 'Found in otherJid chat');
  assert.equal(target7.body, 'target chat text edited via peer stanza');
  assert.equal(target7.is_edited, true);
  console.log('  ok - Test 7 passed');

  // -------------------------------------------------------------
  // Scenario 8: Older edit timestamp does not clobber newer edit
  // -------------------------------------------------------------
  console.log('Test 8: Older edit timestamp does not clobber newer edit');
  const origMsg8 = {
    key: { remoteJid: jid, id: 'SCENARIO_8_SEQ', fromMe: true },
    message: { conversation: 'v1 initial' },
    messageTimestamp: 1730889500,
  };
  await sm._ingestUpsertMessage(origMsg8, sock, sid, { upsertType: 'notify' });

  // Newer edit (v3) arrives first (out of order network delivery)
  const newerEditMsg = {
    key: { remoteJid: jid, id: 'STANZA_V3', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: jid,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'SCENARIO_8_SEQ', remoteJid: jid, fromMe: true },
            editedMessage: { conversation: 'v3 newest' },
            timestampMs: 1730889600000, // newer timestamp
          },
        },
      },
    },
    messageTimestamp: 1730889600,
  };
  await sm._ingestUpsertMessage(newerEditMsg, sock, sid, { upsertType: 'notify' });

  const target8_v3 = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === 'SCENARIO_8_SEQ');
  assert.equal(target8_v3.body, 'v3 newest');

  // Older edit (v2) arrives later
  const olderEditMsg = {
    key: { remoteJid: jid, id: 'STANZA_V2', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: jid,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'SCENARIO_8_SEQ', remoteJid: jid, fromMe: true },
            editedMessage: { conversation: 'v2 older' },
            timestampMs: 1730889550000, // older than v3
          },
        },
      },
    },
    messageTimestamp: 1730889550,
  };
  await sm._ingestUpsertMessage(olderEditMsg, sock, sid, { upsertType: 'notify' });

  const target8_final = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === 'SCENARIO_8_SEQ');
  assert.equal(target8_final.body, 'v3 newest', 'Older edit must not overwrite newer edit body');
  console.log('  ok - Test 8 passed');

  // -------------------------------------------------------------
  // Scenario 9: View Once messages unaffected
  // -------------------------------------------------------------
  console.log('Test 9: View Once messages unaffected');
  const voMsg = {
    key: { remoteJid: jid, id: 'SCENARIO_9_VO', fromMe: false, isViewOnce: true },
    message: {
      viewOnceMessage: {
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            caption: 'secret photo',
          },
        },
      },
    },
    messageTimestamp: 1730889700,
  };
  assert.equal(isViewOnceMessage(voMsg.message, voMsg.key), true);
  assert.equal(extractProtocolMessage(voMsg.message), null, 'View once is not a protocol message');
  await sm._ingestUpsertMessage(voMsg, sock, sid, { upsertType: 'notify' });
  const target9 = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === 'SCENARIO_9_VO');
  assert.ok(target9);
  assert.equal(target9.is_view_once, true);
  console.log('  ok - Test 9 passed');

  // -------------------------------------------------------------
  // Scenario 10: Revoke and delete events unaffected
  // -------------------------------------------------------------
  console.log('Test 10: Revoke and delete events unaffected');
  const revokeMsg = {
    key: { remoteJid: jid, id: 'STANZA_REVOKE_10', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: jid,
        message: {
          protocolMessage: {
            type: 0, // REVOKE
            key: { id: 'SCENARIO_3_NORMAL', remoteJid: jid, fromMe: true },
          },
        },
      },
    },
    messageTimestamp: 1730889800,
  };
  await sm._ingestUpsertMessage(revokeMsg, sock, sid, { upsertType: 'notify' });
  const target10 = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === 'SCENARIO_3_NORMAL');
  assert.ok(target10);
  assert.equal(target10.is_revoked, true);
  assert.equal(target10.is_deleted, true);
  assert.equal(target10.body, '');

  const delEvents = emittedEvents.filter((e) => e.event === 'message_deleted' && e.wa_message_id === 'SCENARIO_3_NORMAL');
  assert.equal(delEvents.length, 1, 'Emitted exactly 1 message_deleted event');
  assert.equal(delEvents[0].is_revoked, true);
  console.log('  ok - Test 10 passed');

  // -------------------------------------------------------------
  // Scenario 11: Security & Defensive Boundaries (Circular, Loose, Depth)
  // -------------------------------------------------------------
  console.log('Test 11: Security & Defensive Boundaries (Circular, Loose, Depth)');
  // 11.1 Circular reference safety
  const circ = {};
  circ.deviceSentMessage = { message: circ };
  assert.equal(extractProtocolMessage(circ), null, 'Circular reference must safely terminate and return null');

  // 11.2 Arbitrary loose object with .message property must NOT be treated as wrapper
  const fakeMsg = { message: { randomField: 'value' } };
  assert.equal(extractProtocolMessage(fakeMsg), null, 'Arbitrary .message object must return null');

  // 11.3 Text message mentioning keywords must NOT be treated as protocol message
  const textWithKeywords = { conversation: 'This has protocolMessage and deviceSentMessage words' };
  assert.equal(extractProtocolMessage(textWithKeywords), null, 'Keyword-bearing text must return null');

  // 11.4 Max depth limit protection (> 8 wrappers must terminate)
  let deepWrap = { protocolMessage: { type: 14, key: { id: 'DEEP_ID' } } };
  for (let i = 0; i < 10; i++) {
    deepWrap = { ephemeralMessage: { message: deepWrap } };
  }
  assert.equal(extractProtocolMessage(deepWrap), null, 'Overly deep nesting (>8) must terminate safely');
  console.log('  ok - Test 11 passed');

  // -------------------------------------------------------------
  // Scenario 12: Production-derived Redacted Real Payload Fixture End-to-End
  // -------------------------------------------------------------
  console.log('Test 12: Production-derived Redacted Real Payload Fixture End-to-End');
  const realOrigWaId = '3A91994F5BDF9A2D736B';
  const realStanzaWaId = '3A375A93BE7E76B25848';
  const realChatJid = '905076382749@s.whatsapp.net';

  // 1. Initial message arrives from phone
  const prodInitialMsg = {
    key: { remoteJid: realChatJid, id: realOrigWaId, fromMe: true },
    message: { conversation: 'E2E Düzenleme Testi' },
    messageTimestamp: 1794388460,
  };
  await sm._ingestUpsertMessage(prodInitialMsg, sock, sid, { upsertType: 'notify' });

  // 2. User edits on phone - exact Baileys stanza structure observed in production
  const prodEditPeerStanza = {
    key: { remoteJid: realChatJid, id: realStanzaWaId, fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: realChatJid,
        message: {
          protocolMessage: {
            type: 14,
            key: {
              id: realOrigWaId,
              remoteJid: realChatJid,
              fromMe: true,
            },
            editedMessage: {
              conversation: 'E2E Düzenleme Testi (Canlı Telefon Düzenlemesi Başarılı)',
            },
            timestampMs: 1794388469000,
          },
        },
      },
    },
    messageTimestamp: 1794388469,
  };

  // Step 1 & 2: protocolMessage recognized with type 14 and original ID
  const extractedProdProto = extractProtocolMessage(prodEditPeerStanza.message);
  assert.ok(extractedProdProto, 'Must extract protocolMessage from production payload');
  assert.equal(extractedProdProto.type, 14, 'Protocol message type must be 14 (MESSAGE_EDIT)');
  assert.equal(extractedProdProto.key.id, realOrigWaId, 'Target key must be original message ID');

  // Step 3-6: Ingestion and event emission
  await sm._ingestUpsertMessage(prodEditPeerStanza, sock, sid, { upsertType: 'notify' });

  const prodChatList = store.messagesByChat.get(realChatJid) || [];
  const prodTargetMsg = prodChatList.find((m) => m.wa_message_id === realOrigWaId);
  assert.ok(prodTargetMsg, 'Original message must exist in chat list');
  // Step 4: Content updated in-place
  assert.equal(prodTargetMsg.body, 'E2E Düzenleme Testi (Canlı Telefon Düzenlemesi Başarılı)');
  assert.equal(prodTargetMsg.is_edited, true);
  assert.equal(prodTargetMsg.edited_at, new Date(1794388469000).toISOString());

  // Step 5: No new duplicate message created under stanza ID
  const accidentalStanzaMsg = prodChatList.find((m) => m.wa_message_id === realStanzaWaId);
  assert.equal(accidentalStanzaMsg, undefined, 'Stanza ID must NOT create a duplicate message');

  // Step 6: Emitted replace event
  const prodRepEvents = emittedEvents.filter((e) => e.upsert_type === 'replace' && e.message?.wa_message_id === realOrigWaId);
  assert.equal(prodRepEvents.length, 1, 'Must emit exactly 1 replace event for original message ID');
  assert.equal(prodRepEvents[0].conversation_id, realChatJid);
  assert.equal(prodRepEvents[0].message.body, 'E2E Düzenleme Testi (Canlı Telefon Düzenlemesi Başarılı)');
  console.log('  ok - Test 12 passed');

  // -------------------------------------------------------------
  // Scenario 13: Conflicting JID & Cross-Chat Isolation
  // -------------------------------------------------------------
  console.log('Test 13: Conflicting JID & Cross-Chat Isolation');
  const chatA = '905071111111@s.whatsapp.net';
  const chatB = '905072222222@s.whatsapp.net';

  // Seed original message in Chat A
  await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: 'ISOLATION_MSG_A', fromMe: true },
    message: { conversation: 'original in chat A' },
    messageTimestamp: 1730889900,
  }, sock, sid, { upsertType: 'notify' });

  // Seed message in Chat B
  await sm._ingestUpsertMessage({
    key: { remoteJid: chatB, id: 'ISOLATION_MSG_B', fromMe: true },
    message: { conversation: 'original in chat B' },
    messageTimestamp: 1730889901,
  }, sock, sid, { upsertType: 'notify' });

  // Edit arrives with conflicting JID: stanza destinationJid is Chat B, but protocol key targets Chat A message
  const conflictingEdit = {
    key: { remoteJid: chatB, id: 'STANZA_CONFLICT', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: chatB,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'ISOLATION_MSG_A', remoteJid: chatB, fromMe: true },
            editedMessage: { conversation: 'edited Chat A message via cross-lookup' },
            timestampMs: 1730889950000,
          },
        },
      },
    },
    messageTimestamp: 1730889950,
  };
  await sm._ingestUpsertMessage(conflictingEdit, sock, sid, { upsertType: 'notify' });

  // Chat A message must be updated
  const recA = (store.messagesByChat.get(chatA) || []).find((m) => m.wa_message_id === 'ISOLATION_MSG_A');
  assert.ok(recA);
  assert.equal(recA.body, 'edited Chat A message via cross-lookup');
  assert.equal(recA.is_edited, true);

  // Chat B message must remain untouched
  const recB = (store.messagesByChat.get(chatB) || []).find((m) => m.wa_message_id === 'ISOLATION_MSG_B');
  assert.ok(recB);
  assert.equal(recB.body, 'original in chat B', 'Chat B message must NOT be altered');
  assert.equal(recB.is_edited, false);
  console.log('  ok - Test 13 passed');

  // -------------------------------------------------------------
  // Scenario 14: Protobuf Long object for timestampMs
  // -------------------------------------------------------------
  console.log('Test 14: Protobuf Long object for timestampMs without RangeError');
  const origMsg14 = {
    key: { remoteJid: jid, id: 'SCENARIO_14_ORIG', fromMe: true },
    message: { conversation: 'long ts test' },
    messageTimestamp: 1730890000,
  };
  await sm._ingestUpsertMessage(origMsg14, sock, sid, { upsertType: 'notify' });

  // Simulate protobuf Long object
  const fakeLong = {
    low: -359487440,
    high: 417,
    unsigned: false,
    toNumber() {
      return 1794388469000;
    },
  };

  const editLongTsMsg = {
    key: { remoteJid: jid, id: 'STANZA_PHONE_EDIT_14', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: jid,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'SCENARIO_14_ORIG', remoteJid: jid, fromMe: true },
            editedMessage: { conversation: 'long ts test (edited with Long)' },
            timestampMs: fakeLong,
          },
        },
      },
    },
    messageTimestamp: 1794388469,
  };
  await sm._ingestUpsertMessage(editLongTsMsg, sock, sid, { upsertType: 'notify' });

  const chatMsgs14 = store.messagesByChat.get(jid) || [];
  const rec14 = chatMsgs14.find((m) => m.wa_message_id === 'SCENARIO_14_ORIG');
  assert.ok(rec14);
  assert.equal(rec14.body, 'long ts test (edited with Long)');
  assert.equal(rec14.is_edited, true);
  assert.equal(rec14.edited_at, new Date(1794388469000).toISOString());
  console.log('  ok - Test 14 passed');

  // -------------------------------------------------------------
  // Scenario 15: DB Pool Lookup Fallback for Target Chat across Restarts
  // -------------------------------------------------------------
  console.log('Test 15: DB Pool Lookup Fallback for Target Chat across Restarts');
  const mockDbChat = '905073333333@s.whatsapp.net';
  const mockTargetWaId = 'DB_FALLBACK_WA_ID';
  session.phoneNumberJid = '905413749073@s.whatsapp.net';
  sm._pool = {
    async query(sql, params) {
      if (params?.[0] === mockTargetWaId) {
        return { rows: [{ jid: mockDbChat }] };
      }
      return { rows: [] };
    },
  };

  const editMissingFromRam = {
    key: { remoteJid: '905413749073@s.whatsapp.net', id: 'STANZA_DB_FALLBACK', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: '905413749073@s.whatsapp.net',
        message: {
          protocolMessage: {
            type: 14,
            key: { id: mockTargetWaId, fromMe: true },
            editedMessage: { conversation: 'resolved via db pool' },
            timestampMs: 1794388500000,
          },
        },
      },
    },
    messageTimestamp: 1794388500,
  };
  await sm._ingestUpsertMessage(editMissingFromRam, sock, sid, { upsertType: 'notify' });

  const fallbackMsgs = store.messagesByChat.get(mockDbChat) || [];
  const rec15 = fallbackMsgs.find((m) => m.wa_message_id === mockTargetWaId);
  assert.ok(rec15, 'Target record must be created under DB-resolved chat');
  assert.equal(rec15.body, 'resolved via db pool');
  assert.equal(rec15.is_edited, true);
  console.log('  ok - Test 15 passed');

  // -------------------------------------------------------------
  // Scenario 16: Voice/Audio message edited with text ("Ses" -> "Ses44")
  // -------------------------------------------------------------
  console.log('Test 16: Voice/Audio message edited with text ("Ses" -> "Ses44")');
  const audioWaId = 'SCENARIO_16_AUDIO_ORIG';
  const origAudioRecord = {
    id: 1730890100000,
    timestamp_s: 1730890100,
    conversation_id: jid,
    direction: 'OUTBOUND',
    message_type: 'AUDIO',
    status: 'SENT',
    body: 'Ses',
    media_id: 'media_audio_ses_123',
    media_mime_type: 'audio/ogg; codecs=opus',
    media_filename: 'voice_note.ogg',
    media_caption: 'Ses',
    wa_message_id: audioWaId,
    sender_phone: 'ME',
    recipient_phone: jid,
    sender_name: 'ME',
    is_edited: false,
    edited_at: null,
    created_at: new Date(1730890100000).toISOString(),
  };
  const chatMsgs16 = store.messagesByChat.get(jid) || [];
  chatMsgs16.push(origAudioRecord);
  store.messagesByChat.set(jid, chatMsgs16);

  const editAudioMsg = {
    key: { remoteJid: jid, id: 'STANZA_AUDIO_EDIT_16', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: jid,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: audioWaId, remoteJid: jid, fromMe: true },
            editedMessage: { conversation: 'Ses44' },
            timestampMs: 1730890150000,
          },
        },
      },
    },
    messageTimestamp: 1730890150,
  };
  await sm._ingestUpsertMessage(editAudioMsg, sock, sid, { upsertType: 'notify' });

  const target16 = chatMsgs16.find((m) => m.wa_message_id === audioWaId);
  assert.ok(target16, 'Original audio message must exist in chat list');
  assert.equal(target16.body, 'Ses44', 'Body must be updated to Ses44');
  assert.equal(target16.is_edited, true, 'is_edited must be true');
  assert.equal(target16.message_type, 'AUDIO', 'AUDIO message_type must be preserved');
  assert.equal(target16.media_id, 'media_audio_ses_123', 'media_id must be preserved');
  assert.equal(target16.media_mime_type, 'audio/ogg; codecs=opus', 'media_mime_type must be preserved');

  const rep16 = emittedEvents.filter((e) => e.upsert_type === 'replace' && e.message?.wa_message_id === audioWaId);
  assert.equal(rep16.length, 1, 'Replace event emitted for audio message edit');
  assert.equal(rep16[0].message.body, 'Ses44');
  assert.equal(rep16[0].message.media_id, 'media_audio_ses_123');
  console.log('  ok - Test 16 passed');

  // -------------------------------------------------------------
  // Scenario 17: Voice/Audio message edited across restart (hydrated from DB)
  // -------------------------------------------------------------
  console.log('Test 17: Voice/Audio message edited across restart (hydrated from DB)');
  const dbAudioWaId = 'SCENARIO_17_DB_AUDIO_WA_ID';
  const mockAudioChat = '905074444444@s.whatsapp.net';
  sm._pool = {
    async query(sql, params) {
      if (params?.[0] === dbAudioWaId) {
        return {
          rows: [{
            id: 180001,
            conversation_id: 39999,
            direction: 'OUTBOUND',
            message_type: 'AUDIO',
            body: 'Ses',
            media_id: 'media_db_audio_456',
            media_mime_type: 'audio/ogg; codecs=opus',
            media_filename: 'ptt.ogg',
            media_caption: 'Ses',
            status: 'SENT',
            created_at: '2026-11-12T09:03:52.000Z',
            recipient_phone: '+905074444444',
            sender_phone: 'ME',
            is_group: false,
            parent_jid: null,
            contact_phone: '+905074444444',
          }],
        };
      }
      return { rows: [] };
    },
  };

  const editDbAudioMsg = {
    key: { remoteJid: 'status@broadcast', id: 'STANZA_DB_AUDIO_EDIT', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: mockAudioChat,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: dbAudioWaId, fromMe: true },
            editedMessage: { conversation: 'Ses44' },
            timestampMs: 1794388600000,
          },
        },
      },
    },
    messageTimestamp: 1794388600,
  };
  await sm._ingestUpsertMessage(editDbAudioMsg, sock, sid, { upsertType: 'notify' });

  const chatMsgs17 = store.messagesByChat.get(mockAudioChat) || [];
  const target17 = chatMsgs17.find((m) => m.wa_message_id === dbAudioWaId);
  assert.ok(target17, 'Hydrated audio record must be created under DB-resolved chat');
  assert.equal(target17.body, 'Ses44');
  assert.equal(target17.is_edited, true);
  assert.equal(target17.message_type, 'AUDIO', 'Hydrated record must preserve AUDIO type');
  assert.equal(target17.media_id, 'media_db_audio_456', 'Hydrated record must preserve media_id');
  console.log('  ok - Test 17 passed');

  // -------------------------------------------------------------
  // Scenario 18: Baileys messages.update with editedMessage wrapper
  // -------------------------------------------------------------
  console.log('Test 18: Baileys messages.update with editedMessage wrapper');
  const updateWaId = 'SCENARIO_18_BAILEYS_UPDATE_ORIG';
  const origUpdateMsg = {
    key: { remoteJid: jid, id: updateWaId, fromMe: true },
    message: { conversation: 'Önceki Mesaj' },
    messageTimestamp: 1730890300,
  };
  await sm._ingestUpsertMessage(origUpdateMsg, sock, sid, { upsertType: 'notify' });

  // Simulate Baileys messages.update event
  sock.ev.emit('messages.update', [{
    key: { id: updateWaId, remoteJid: jid, fromMe: true },
    update: {
      message: {
        editedMessage: {
          message: {
            conversation: 'Güncellenmiş Mesaj',
          },
        },
      },
      messageTimestamp: 1730890350,
    },
  }]);
  // Allow async handler to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  const chatMsgs18 = store.messagesByChat.get(jid) || [];
  const target18 = chatMsgs18.find((m) => m.wa_message_id === updateWaId);
  assert.ok(target18);
  assert.equal(target18.body, 'Güncellenmiş Mesaj', 'Body updated via messages.update');
  assert.equal(target18.is_edited, true, 'is_edited set via messages.update');

  const rep18 = emittedEvents.filter((e) => e.upsert_type === 'replace' && e.message?.wa_message_id === updateWaId);
  assert.equal(rep18.length, 1, 'Replace event emitted for messages.update');
  console.log('  ok - Test 18 passed');

  // -------------------------------------------------------------
  // Scenario 19: Note-to-Self / Self-Chat edit
  // -------------------------------------------------------------
  console.log('Test 19: Note-to-Self / Self-Chat edit');
  const selfChatJid = '905413749073@s.whatsapp.net';
  session.phoneNumberJid = selfChatJid;
  const selfWaId = 'SCENARIO_19_SELF_NOTE';

  await sm._ingestUpsertMessage({
    key: { remoteJid: selfChatJid, id: selfWaId, fromMe: true },
    message: { conversation: 'Ses' },
    messageTimestamp: 1730890400,
  }, sock, sid, { upsertType: 'notify' });

  const selfEditMsg = {
    key: { remoteJid: selfChatJid, id: 'STANZA_SELF_EDIT_19', fromMe: true },
    message: {
      deviceSentMessage: {
        destinationJid: selfChatJid,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: selfWaId, remoteJid: selfChatJid, fromMe: true },
            editedMessage: { conversation: 'Ses44' },
            timestampMs: 1730890450000,
          },
        },
      },
    },
    messageTimestamp: 1730890450,
  };
  await sm._ingestUpsertMessage(selfEditMsg, sock, sid, { upsertType: 'notify' });

  const selfChatList = store.messagesByChat.get(selfChatJid) || [];
  const target19 = selfChatList.find((m) => m.wa_message_id === selfWaId);
  assert.ok(target19, 'Self chat message must exist');
  assert.equal(target19.body, 'Ses44', 'Self chat message updated to Ses44');
  assert.equal(target19.is_edited, true);

  const rep19 = emittedEvents.filter((e) => e.upsert_type === 'replace' && e.message?.wa_message_id === selfWaId);
  assert.equal(rep19.length, 1, 'Replace event emitted for self chat edit');
  console.log('  ok - Test 19 passed');

  // -------------------------------------------------------------
  // Scenario 20: Real PostgreSQL schema compatibility (no c.jid column required)
  // -------------------------------------------------------------
  console.log('Test 20: Real PostgreSQL schema compatibility (no c.jid column required)');
  const { lookupMessageDbInfo } = await import('../src/database/message-lookup.js');
  const mockRealSchemaPool = {
    async query(sql, params) {
      assert.ok(!sql.includes('c.jid'), 'SQL query must NOT reference c.jid');
      assert.ok(sql.includes('ct.phone_e164 as contact_phone'), 'SQL query must join contacts');
      if (params?.[0] === 'TEST_1_ON_1') {
        return {
          rows: [{
            id: 1,
            is_group: false,
            parent_jid: null,
            contact_phone: '+905413749073',
            recipient_phone: '+905413749073',
            sender_phone: 'ME',
          }],
        };
      }
      if (params?.[0] === 'TEST_GROUP') {
        return {
          rows: [{
            id: 2,
            is_group: true,
            parent_jid: '123456789-987654@g.us',
            contact_phone: 'jid:123456789-987654@g.us',
            recipient_phone: '123456789-987654@g.us',
            sender_phone: 'ME',
          }],
        };
      }
      return { rows: [] };
    },
  };

  const res1On1 = await lookupMessageDbInfo(mockRealSchemaPool, 'TEST_1_ON_1', store);
  assert.equal(res1On1.chat_jid, '905413749073@s.whatsapp.net', '1-on-1 resolved to phone JID without c.jid');

  const resGroup = await lookupMessageDbInfo(mockRealSchemaPool, 'TEST_GROUP', store);
  assert.equal(resGroup.chat_jid, '123456789-987654@g.us', 'Group resolved to group JID without c.jid');
  console.log('  ok - Test 20 passed');

  // -------------------------------------------------------------
  // Scenario 21: Genuine status@broadcast story filtering (no leakage)
  // -------------------------------------------------------------
  console.log('Test 21: Genuine status@broadcast story filtering');
  const eventsBefore21 = emittedEvents.length;
  const genuineSkippedBefore = session._editDiagnostics?.broadcast_skipped_genuine || 0;
  const statusStoryRes = await sm._ingestUpsertMessage({
    key: {
      remoteJid: 'status@broadcast',
      id: 'STATUS_STORY_21',
      participant: '905559998877@s.whatsapp.net',
      fromMe: false,
    },
    message: {
      imageMessage: { caption: 'Happy Friday story!' },
    },
    messageTimestamp: 1794388700,
  }, sock, sid, { upsertType: 'notify' });

  assert.equal(statusStoryRes, null, 'Genuine status@broadcast must return null');
  assert.equal(store.messagesByChat.has('status@broadcast'), false, 'status@broadcast must not create a chat in RAM');
  assert.equal(emittedEvents.length, eventsBefore21, 'No event should be emitted for genuine status@broadcast');
  assert.equal(
    session._editDiagnostics?.broadcast_skipped_genuine,
    genuineSkippedBefore + 1,
    'broadcast_skipped_genuine metric must increment',
  );
  console.log('  ok - Test 21 passed');

  // -------------------------------------------------------------
  // Scenario 22: status@broadcast MESSAGE_EDIT without destinationJid (DB recovery & fail-closed)
  // -------------------------------------------------------------
  console.log('Test 22: status@broadcast MESSAGE_EDIT without destinationJid (DB recovery & fail-closed)');
  const bcastTargetId = 'BROADCAST_DB_EDIT_AUDIO_22';
  const bcastChat = '905078889900@s.whatsapp.net';
  sm._pool = {
    async query(sql, params) {
      if (params?.[0] === bcastTargetId) {
        return {
          rows: [{
            id: 220001,
            conversation_id: 42222,
            direction: 'OUTBOUND',
            message_type: 'AUDIO',
            body: 'Ses',
            media_id: 'media_bcast_audio_22',
            media_mime_type: 'audio/ogg; codecs=opus',
            media_filename: 'voice22.ogg',
            media_caption: 'Ses',
            status: 'SENT',
            created_at: '2026-11-12T09:10:00.000Z',
            recipient_phone: '+905078889900',
            sender_phone: 'ME',
            is_group: false,
            parent_jid: null,
            contact_phone: '+905078889900',
          }],
        };
      }
      return { rows: [] };
    },
  };

  // 22a: Recoverable via DB when protocolMessage lacks destinationJid & remoteJid is broadcast
  await sm._ingestUpsertMessage({
    key: { remoteJid: 'status@broadcast', id: 'STANZA_BCAST_DB_22', fromMe: true },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: bcastTargetId, remoteJid: 'status@broadcast', fromMe: true },
        editedMessage: { conversation: 'Broadcast DB Recovered' },
        timestampMs: 1794388710000,
      },
    },
    messageTimestamp: 1794388710,
  }, sock, sid, { upsertType: 'notify' });

  const bcastChatMsgs = store.messagesByChat.get(bcastChat) || [];
  const rec22 = bcastChatMsgs.find((m) => m.wa_message_id === bcastTargetId);
  assert.ok(rec22, 'status@broadcast edit without destinationJid must recover via DB');
  assert.equal(rec22.body, 'Broadcast DB Recovered');
  assert.equal(rec22.is_edited, true);
  assert.equal(rec22.message_type, 'AUDIO', 'Original AUDIO type preserved across broadcast DB recovery');
  assert.equal(rec22.media_id, 'media_bcast_audio_22', 'Original media_id preserved across broadcast DB recovery');
  assert.equal(store.messagesByChat.has('status@broadcast'), false, 'status@broadcast must never hold recovered edit');

  // 22b: Unresolved status@broadcast edit fails closed
  const eventsBefore22b = emittedEvents.length;
  const unresolvedSkippedBefore = session._editDiagnostics?.broadcast_skipped_unresolved || 0;
  const unresolvedRes = await sm._ingestUpsertMessage({
    key: { remoteJid: 'status@broadcast', id: 'STANZA_BCAST_UNRESOLVED_22', fromMe: true },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'UNKNOWN_TARGET_999', remoteJid: 'status@broadcast', fromMe: true },
        editedMessage: { conversation: 'Should Not Leak' },
        timestampMs: 1794388720000,
      },
    },
    messageTimestamp: 1794388720,
  }, sock, sid, { upsertType: 'notify' });

  assert.equal(unresolvedRes, null, 'Unresolved status@broadcast edit must fail closed');
  assert.equal(emittedEvents.length, eventsBefore22b, 'No event emitted for unresolved status@broadcast edit');
  assert.equal(store.messagesByChat.has('status@broadcast'), false);
  assert.equal(session._editDiagnostics?.broadcast_skipped_unresolved, unresolvedSkippedBefore + 1);

  // 22c: Unresolved status@broadcast revoke fails closed
  const eventsBefore22c = emittedEvents.length;
  const revokeUnresolvedRes = await sm._ingestUpsertMessage({
    key: { remoteJid: 'status@broadcast', id: 'STANZA_BCAST_REVOKE_22', fromMe: true },
    message: {
      protocolMessage: {
        type: 0,
        key: { id: 'UNKNOWN_REVOKE_999', remoteJid: 'status@broadcast', fromMe: true },
      },
    },
    messageTimestamp: 1794388730,
  }, sock, sid, { upsertType: 'notify' });

  assert.equal(revokeUnresolvedRes, null, 'Unresolved status@broadcast revoke must fail closed');
  assert.equal(emittedEvents.length, eventsBefore22c, 'No message_deleted emitted for unresolved broadcast revoke');
  console.log('  ok - Test 22 passed');

  // -------------------------------------------------------------
  // Scenario 23: secretEncryptedMessage decryption (valid secret, corrupt payload, missing secret on restart)
  // -------------------------------------------------------------
  console.log('Test 23: secretEncryptedMessage decryption & fail-closed guards');
  const secChat = '905077776655@s.whatsapp.net';
  const secOrigId = 'SEC_ENC_ORIG_23';
  const msgSecret23 = randomBytes(32);

  await sm._ingestUpsertMessage({
    key: { remoteJid: secChat, id: secOrigId, fromMe: true },
    message: {
      conversation: 'Initial Secret Msg',
      messageContextInfo: { messageSecret: msgSecret23 },
    },
    messageTimestamp: 1794388800,
  }, sock, sid, { upsertType: 'notify' });

  const buildSecretEncryptedEdit = (targetId, chatJid, senderJid, plaintext, secret, tamperCiphertext = false) => {
    const innerBytes = proto.Message.encode({ conversation: plaintext }).finish();
    const iv = randomBytes(12);
    const toBin = (s) => Buffer.from(String(s), 'utf8');
    const senderBuf = toBin(senderJid);
    const sign = Buffer.concat([toBin(targetId), senderBuf, senderBuf, toBin('Message Edit'), new Uint8Array([1])]);
    const key0 = hmacSign(secret, new Uint8Array(32), 'sha256');
    const encKey = hmacSign(sign, key0, 'sha256');
    const encPayload = Buffer.from(aesEncryptGCM(innerBytes, encKey, iv, Buffer.alloc(0)));
    if (tamperCiphertext && encPayload.length > 0) {
      encPayload[0] ^= 0xff;
    }
    return {
      targetMessageKey: { id: targetId, remoteJid: chatJid, fromMe: true },
      encPayload,
      encIv: iv,
      secretEncType: 2,
    };
  };

  // 23a: Valid secretEncryptedMessage wrapped in status@broadcast stanza without destinationJid
  const secSuccessBefore = session._editDiagnostics?.secret_edit_success || 0;
  const secEdit23 = buildSecretEncryptedEdit(secOrigId, secChat, secChat, 'Encrypted Edit Verified', msgSecret23);
  await sm._ingestUpsertMessage({
    key: { remoteJid: 'status@broadcast', id: 'STANZA_SEC_23A', fromMe: true },
    message: { secretEncryptedMessage: secEdit23 },
    messageTimestamp: 1794388810,
  }, sock, sid, { upsertType: 'notify' });

  const target23 = (store.messagesByChat.get(secChat) || []).find((m) => m.wa_message_id === secOrigId);
  assert.ok(target23);
  assert.equal(target23.body, 'Encrypted Edit Verified', 'secretEncryptedMessage edit must decrypt and update in RAM');
  assert.equal(target23.is_edited, true);
  assert.equal(session._editDiagnostics?.secret_edit_success, secSuccessBefore + 1);

  // 23b: Corrupted ciphertext or mismatched secret must fail closed
  const secFailedBefore = session._editDiagnostics?.secret_edit_decrypt_failed || 0;
  const eventsBefore23b = emittedEvents.length;
  const tamperedSecEdit = buildSecretEncryptedEdit(secOrigId, secChat, secChat, 'Tampered Body', msgSecret23, true);
  const failDecryptRes = await sm._ingestUpsertMessage({
    key: { remoteJid: secChat, id: 'STANZA_SEC_23B', fromMe: true },
    message: { secretEncryptedMessage: tamperedSecEdit },
    messageTimestamp: 1794388820,
  }, sock, sid, { upsertType: 'notify' });

  assert.equal(failDecryptRes, null, 'Corrupt secretEncryptedMessage must fail closed');
  assert.equal(target23.body, 'Encrypted Edit Verified', 'Original body must remain intact on failed decrypt');
  assert.equal(emittedEvents.length, eventsBefore23b, 'No event emitted on failed decrypt');
  assert.equal(session._editDiagnostics?.secret_edit_decrypt_failed, secFailedBefore + 1);

  // 23c: When secret is missing from both RAM and persistent store, fail closed
  store.rawMessagesByChat.delete(secChat);
  store.rawMediaCache?.delete?.(secOrigId);
  await sm._getMessageSecretStore()?.clearSessionSecrets(sid);
  const missingSecretBefore = session._editDiagnostics?.secret_edit_missing_secret || 0;
  const eventsBefore23c = emittedEvents.length;
  const restartSecEdit = buildSecretEncryptedEdit(secOrigId, secChat, secChat, 'After Restart No Secret', msgSecret23);
  const restartRes = await sm._ingestUpsertMessage({
    key: { remoteJid: secChat, id: 'STANZA_SEC_23C', fromMe: true },
    message: { secretEncryptedMessage: restartSecEdit },
    messageTimestamp: 1794388830,
  }, sock, sid, { upsertType: 'notify' });

  assert.equal(restartRes, null, 'secretEncryptedMessage without RAM/persisted messageSecret must fail closed');
  assert.equal(emittedEvents.length, eventsBefore23c, 'No false-positive event emitted when secret missing');
  assert.equal(session._editDiagnostics?.secret_edit_missing_secret, missingSecretBefore + 1);

  // Direct unit check on decryptSecretEncryptedEdit with non-MESSAGE_EDIT type
  assert.equal(
    decryptSecretEncryptedEdit({ secretEncType: 1, targetMessageKey: { id: secOrigId } }, store, session, secChat, {}),
    null,
    'Non-MESSAGE_EDIT secretEncType must return null',
  );
  console.log('  ok - Test 23 passed');

  // -------------------------------------------------------------
  // Scenario 24: CB:message raw msmsg stanza observer & corrupted stanza resilience
  // -------------------------------------------------------------
  console.log('Test 24: CB:message raw msmsg observer & malformed stanza resilience');
  const msmsgBefore = session._editDiagnostics?.msmsg_stanzas_observed || 0;
  ws.emit('CB:message', {
    tag: 'message',
    attrs: { from: '905076382749@s.whatsapp.net', to: '905413749073@s.whatsapp.net', type: 'text', edit: '1' },
    content: [
      { tag: 'enc', attrs: { v: '2', type: 'msmsg' }, content: Buffer.from('opaque') },
    ],
  });
  assert.equal(session._editDiagnostics?.msmsg_stanzas_observed, msmsgBefore + 1, 'Valid msmsg stanza must increment observer count');

  // Non-msmsg stanza should NOT increment msmsg counter
  ws.emit('CB:message', {
    tag: 'message',
    attrs: { from: '905076382749@s.whatsapp.net', type: 'text' },
    content: [{ tag: 'enc', attrs: { v: '2', type: 'pkmsg' }, content: Buffer.from('opaque') }],
  });
  assert.equal(session._editDiagnostics?.msmsg_stanzas_observed, msmsgBefore + 1, 'pkmsg must not increment msmsg counter');

  // Malformed / edge msmsg frames must not throw
  ws.emit('CB:message', { tag: 'message', attrs: null, content: [null, { tag: 'enc', attrs: { type: 'msmsg' } }] });
  ws.emit('CB:message', null);
  assert.equal(session._editDiagnostics?.msmsg_stanzas_observed, msmsgBefore + 2, 'Malformed msmsg frame observed safely without crash');

  // Stale socket generation must ignore CB:message events
  const newerGen = session.lifecycle.beginAttempt();
  session.lifecycle.attach(newerGen, { ev: new EventEmitter(), async readMessages() { return true; } });
  ws.emit('CB:message', {
    tag: 'message',
    attrs: { type: 'text' },
    content: [{ tag: 'enc', attrs: { type: 'msmsg' } }],
  });
  assert.equal(session._editDiagnostics?.msmsg_stanzas_observed, msmsgBefore + 2, 'Stale socket msmsg must be ignored');
  // Re-attach test sock for remaining scenarios
  const activeGen = session.lifecycle.beginAttempt();
  session.lifecycle.attach(activeGen, sock);
  bindSocketEvents({ manager: sm, session, sock, id: sid, generation: activeGen });
  console.log('  ok - Test 24 passed');

  // -------------------------------------------------------------
  // Scenario 25: Cross-conversation target mismatch & inbound-cannot-edit-outbound tamper rejection
  // -------------------------------------------------------------
  console.log('Test 25: Cross-conversation tamper & inbound-outbound edit rejection');
  const secChatX = '905071119988@s.whatsapp.net';
  const secChatY = '905072229988@s.whatsapp.net';
  await sm._ingestUpsertMessage({
    key: { remoteJid: secChatX, id: 'CHATX_OUT_25', fromMe: true },
    message: { conversation: 'My outbound message in X' },
    messageTimestamp: 1794388900,
  }, sock, sid, { upsertType: 'notify' });
  await sm._ingestUpsertMessage({
    key: { remoteJid: secChatX, id: 'CHATX_IN_25', fromMe: false },
    message: { conversation: 'Peer X original message' },
    messageTimestamp: 1794388901,
  }, sock, sid, { upsertType: 'notify' });

  const rejectedBefore25 = session._editDiagnostics?.edit_rejected_cross_chat || 0;
  const eventsBefore25 = emittedEvents.length;

  // 25a: Inbound peer from Chat Y tries to overwrite Peer X's message ID
  const crossSpoofRam = await sm._ingestUpsertMessage({
    key: { remoteJid: secChatY, id: 'STANZA_SPOOF_25A', fromMe: false },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'CHATX_IN_25', remoteJid: secChatY, fromMe: false },
        editedMessage: { conversation: 'Hacked from Y' },
        timestampMs: 1794388910000,
      },
    },
    messageTimestamp: 1794388910,
  }, sock, sid, { upsertType: 'notify' });
  assert.equal(crossSpoofRam, null, 'Cross-chat inbound edit via RAM must be rejected');
  assert.equal((store.messagesByChat.get(secChatX) || []).find((m) => m.wa_message_id === 'CHATX_IN_25')?.body, 'Peer X original message');

  // 25b: Inbound peer in Chat X tries to overwrite MY outbound message in Chat X
  const inboundOnOutbound = await sm._ingestUpsertMessage({
    key: { remoteJid: secChatX, id: 'STANZA_SPOOF_25B', fromMe: false },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'CHATX_OUT_25', remoteJid: secChatX, fromMe: false },
        editedMessage: { conversation: 'Peer spoofing outbound' },
        timestampMs: 1794388920000,
      },
    },
    messageTimestamp: 1794388920,
  }, sock, sid, { upsertType: 'notify' });
  assert.equal(inboundOnOutbound, null, 'Inbound edit targeting OUTBOUND message must be rejected');
  assert.equal((store.messagesByChat.get(secChatX) || []).find((m) => m.wa_message_id === 'CHATX_OUT_25')?.body, 'My outbound message in X');

  // 25c: Cross-chat DB mismatch fail-closed (message missing from RAM, DB owns it in Chat X, claimed by Chat Y)
  sm._pool = {
    async query(sql, params) {
      if (params?.[0] === 'CHATX_DB_ONLY_25') {
        return {
          rows: [{
            id: 250001,
            conversation_id: 52525,
            direction: 'INBOUND',
            message_type: 'TEXT',
            body: 'DB Original in X',
            status: 'RECEIVED',
            created_at: '2026-11-12T09:15:00.000Z',
            recipient_phone: 'ME',
            sender_phone: '+905071119988',
            is_group: false,
            parent_jid: null,
            contact_phone: '+905071119988',
          }],
        };
      }
      return { rows: [] };
    },
  };
  const crossSpoofDb = await sm._ingestUpsertMessage({
    key: { remoteJid: secChatY, id: 'STANZA_SPOOF_25C', fromMe: false },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'CHATX_DB_ONLY_25', remoteJid: secChatY, fromMe: false },
        editedMessage: { conversation: 'Hacked DB cross chat' },
        timestampMs: 1794388930000,
      },
    },
    messageTimestamp: 1794388930,
  }, sock, sid, { upsertType: 'notify' });
  assert.equal(crossSpoofDb, null, 'Cross-chat inbound edit via DB must be rejected');
  assert.equal(emittedEvents.length, eventsBefore25, 'Rejected tamper attempts must not emit events');
  assert.equal(session._editDiagnostics?.edit_rejected_cross_chat, rejectedBefore25 + 3);
  console.log('  ok - Test 25 passed');

  // -------------------------------------------------------------
  // Scenario 26: Duplicate secretEncryptedMessage replay idempotency
  // -------------------------------------------------------------
  console.log('Test 26: secretEncryptedMessage replay idempotency');
  const secReplayChat = '905076665544@s.whatsapp.net';
  const secReplayId = 'SEC_REPLAY_26';
  const msgSecret26 = randomBytes(32);
  await sm._ingestUpsertMessage({
    key: { remoteJid: secReplayChat, id: secReplayId, fromMe: true },
    message: {
      conversation: 'Replay Init',
      messageContextInfo: { messageSecret: msgSecret26 },
    },
    messageTimestamp: 1794388950,
  }, sock, sid, { upsertType: 'notify' });

  const secReplayPayload = buildSecretEncryptedEdit(secReplayId, secReplayChat, secReplayChat, 'Replay Final', msgSecret26);
  await sm._ingestUpsertMessage({
    key: { remoteJid: secReplayChat, id: 'STANZA_REPLAY_26A', fromMe: true },
    message: { secretEncryptedMessage: secReplayPayload },
    messageTimestamp: 1794388960,
  }, sock, sid, { upsertType: 'notify' });
  await sm._ingestUpsertMessage({
    key: { remoteJid: secReplayChat, id: 'STANZA_REPLAY_26B', fromMe: true },
    message: { secretEncryptedMessage: secReplayPayload },
    messageTimestamp: 1794388960,
  }, sock, sid, { upsertType: 'notify' });

  const chatList26 = store.messagesByChat.get(secReplayChat) || [];
  assert.equal(chatList26.length, 1, 'Duplicate secretEncryptedMessage replay must keep single record');
  assert.equal(chatList26[0].body, 'Replay Final');
  assert.equal(chatList26[0].is_edited, true);
  console.log('  ok - Test 26 passed');

  // -------------------------------------------------------------
  // Scenario 27: Full end-to-end CB:message wire stanza ingestion with valid msmsg payload & stored messageSecret
  // -------------------------------------------------------------
  console.log('Test 27: End-to-end CB:message wire stanza ingestion for Baileys-dropped msmsg');
  const wireChat27 = '905078887766@s.whatsapp.net';
  const wireOrigId27 = 'WIRE_ORIG_27';
  const msgSecret27 = randomBytes(32);
  await sm._ingestUpsertMessage({
    key: { remoteJid: wireChat27, id: wireOrigId27, fromMe: true },
    message: {
      conversation: 'Ses',
      messageContextInfo: { messageSecret: msgSecret27 },
    },
    messageTimestamp: 1794388970,
  }, sock, sid, { upsertType: 'notify' });

  const targetBefore27 = (store.messagesByChat.get(wireChat27) || []).find((m) => m.wa_message_id === wireOrigId27);
  assert.ok(targetBefore27);
  assert.equal(targetBefore27.body, 'Ses');
  assert.equal(Boolean(targetBefore27.is_edited), false);

  const secEdit27 = buildSecretEncryptedEdit(wireOrigId27, wireChat27, wireChat27, 'Ses44', msgSecret27);
  const wireEncBytes27 = proto.Message.encode({ secretEncryptedMessage: secEdit27 }).finish();
  const wireNode27 = {
    tag: 'message',
    attrs: {
      id: 'STANZA_WIRE_27_EDIT',
      from: 'status@broadcast', // typical companion device-sent envelope
      type: 'text',
      edit: '1',
      t: '1794388980',
    },
    content: [
      { tag: 'enc', attrs: { v: '2', type: 'msmsg' }, content: Buffer.from(wireEncBytes27) },
    ],
  };

  const eventsBefore27 = emittedEvents.length;
  ws.emit('CB:message', wireNode27);

  // Allow async ingestion microtasks to settle
  await new Promise((r) => setTimeout(r, 60));

  const targetAfter27 = (store.messagesByChat.get(wireChat27) || []).find((m) => m.wa_message_id === wireOrigId27);
  assert.ok(targetAfter27);
  assert.equal(targetAfter27.body, 'Ses44', 'Target message body must be updated to edited text via CB:message');
  assert.equal(targetAfter27.is_edited, true, 'Target message is_edited flag must be true');

  const replaceEvents27 = emittedEvents.filter(
    (e) => e.upsert_type === 'replace' && e.message?.wa_message_id === wireOrigId27 && e.message?.body === 'Ses44',
  );
  assert.equal(replaceEvents27.length, 1, 'Exactly one outbox replace event must be emitted for the edit');
  console.log('  ok - Test 27 passed');

  // -------------------------------------------------------------
  // Scenario 28: Concurrent / racing edits on the same target message
  // -------------------------------------------------------------
  console.log('Test 28: Concurrent / racing edits on the same target message');
  const concChat28 = '905079998877@s.whatsapp.net';
  const concOrigId28 = 'CONC_ORIG_28';
  const msgSecret28 = randomBytes(32);
  await sm._ingestUpsertMessage({
    key: { remoteJid: concChat28, id: concOrigId28, fromMe: true },
    message: {
      conversation: 'Initial Concurrent Text',
      messageContextInfo: { messageSecret: msgSecret28 },
    },
    messageTimestamp: 1794389000,
  }, sock, sid, { upsertType: 'notify' });

  const secEdit28Early = buildSecretEncryptedEdit(concOrigId28, concChat28, concChat28, 'Earlier Edit (ts=10)', msgSecret28);
  const secEdit28Late = buildSecretEncryptedEdit(concOrigId28, concChat28, concChat28, 'Later Edit (ts=20)', msgSecret28);

  const nodeEarly = {
    tag: 'message',
    attrs: { id: 'CONC_EARLY_STANZA', from: concChat28, type: 'text', edit: '1', t: '1794389010' },
    content: [{ tag: 'enc', attrs: { v: '2', type: 'msmsg' }, content: Buffer.from(proto.Message.encode({ secretEncryptedMessage: secEdit28Early }).finish()) }],
  };
  const nodeLate = {
    tag: 'message',
    attrs: { id: 'CONC_LATE_STANZA', from: concChat28, type: 'text', edit: '1', t: '1794389020' },
    content: [{ tag: 'enc', attrs: { v: '2', type: 'msmsg' }, content: Buffer.from(proto.Message.encode({ secretEncryptedMessage: secEdit28Late }).finish()) }],
  };

  // Dispatch both edits concurrently (racing in event loop)
  await Promise.all([
    sm._ingestMsmsgStanza(nodeEarly, sock, sid),
    sm._ingestMsmsgStanza(nodeLate, sock, sid),
  ]);

  const targetConc28 = (store.messagesByChat.get(concChat28) || []).find((m) => m.wa_message_id === concOrigId28);
  assert.ok(targetConc28);
  assert.equal(targetConc28.body, 'Later Edit (ts=20)', 'Newer edit timestamp must win despite concurrent dispatch');
  assert.equal(targetConc28.is_edited, true);
  console.log('  ok - Test 28 passed');

  console.log('=== ALL 28 SCENARIOS PASSED WITH FULL ACCEPTANCE EVIDENCE ===');
} finally {
  await rm(dir, { recursive: true, force: true });
}

