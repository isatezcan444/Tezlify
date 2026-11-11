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
  isViewOnceMessage,
} from '../src/messages/message-classifier.js';
import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

console.log('=== RUNNING 10-SCENARIO MESSAGE EDIT DEVICE SENT HOTFIX TEST SUITE ===');

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
  const sock = { ev, async readMessages() { return true; } };
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

  console.log('=== ALL 13 SCENARIOS PASSED WITH FULL ACCEPTANCE EVIDENCE ===');
} finally {
  await rm(dir, { recursive: true, force: true });
}

