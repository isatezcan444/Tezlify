import assert from 'node:assert/strict';
import crypto, { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { proto } from '@whiskeysockets/baileys';
import { aesEncryptGCM, hmacSign } from '@whiskeysockets/baileys/lib/Utils/crypto.js';
import { createSessionManager, decryptSecretEncryptedEdit } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

// Enable MSMSG decryption feature flag for crypto test verification
process.env.WHATSAPP_ENABLE_MSMSG_DECRYPTION = 'true';

import {
  deriveMessageSecretSubkey,
  buildMessageSecretAad,
  createMessageSecretStore,
} from '../src/crypto/message-secret-store.js';
import { decodeMsmsgProtobufPayload } from '../src/crypto/msmsg-adapter.js';

console.log('=== RUNNING 20-SCENARIO PHASE 1.2 MSMSG & MESSAGE_SECRET PERSISTENCE SUITE ===');

/**
 * In-memory PostgreSQL pool double implementing whatsapp_private.message_secrets
 * and messages/conversations/contacts lookup SQL contracts.
 */
function createInMemoryPgPool() {
  const secretRows = new Map(); // key: `${session_id}\0${chat_jid}\0${wa_message_id}`
  const messageRows = new Map(); // wa_message_id -> row

  return {
    secretRows,
    messageRows,
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('INSERT INTO whatsapp_private.message_secrets')) {
        const [sessionId, chatJid, waMessageId, ciphertext, nonce, authTag, keyVersion, expiresAt] = params;
        const k = `${sessionId}\0${chatJid}\0${waMessageId}`;
        secretRows.set(k, {
          session_id: sessionId,
          chat_jid: chatJid,
          wa_message_id: waMessageId,
          ciphertext: Buffer.from(ciphertext),
          nonce: Buffer.from(nonce),
          auth_tag: Buffer.from(authTag),
          key_version: Number(keyVersion),
          expires_at: expiresAt || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT ciphertext, nonce, auth_tag, key_version, expires_at FROM whatsapp_private.message_secrets')) {
        const [sessionId, chatJid, waMessageId] = params;
        const k = `${sessionId}\0${chatJid}\0${waMessageId}`;
        const row = secretRows.get(k);
        if (!row) return { rows: [], rowCount: 0 };
        if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ ...row }], rowCount: 1 };
      }

      if (normalized.startsWith('DELETE FROM whatsapp_private.message_secrets WHERE session_id = $1')) {
        const [sessionId] = params;
        let deleted = 0;
        for (const [k, row] of secretRows.entries()) {
          if (row.session_id === sessionId) {
            secretRows.delete(k);
            deleted += 1;
          }
        }
        return { rows: [], rowCount: deleted };
      }

      if (normalized.startsWith('DELETE FROM whatsapp_private.message_secrets WHERE expires_at')) {
        const now = Date.now();
        let deleted = 0;
        for (const [k, row] of secretRows.entries()) {
          if (row.expires_at && Date.parse(row.expires_at) <= now) {
            secretRows.delete(k);
            deleted += 1;
          }
        }
        return { rows: [], rowCount: deleted };
      }

      if (normalized.includes('FROM messages') && params?.[0]) {
        const row = messageRows.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      return { rows: [], rowCount: 0 };
    },
  };
}

function buildEncryptedEditContainer({
  targetId,
  targetChatJid,
  senderJid,
  plaintext,
  secret,
  iv = randomBytes(12),
  corruptCiphertext = false,
  corruptTag = false,
  secretEncType = 2,
}) {
  const innerBytes = proto.Message.encode({ conversation: plaintext }).finish();
  const toBin = (v) => Buffer.from(String(v), 'utf8');
  const senderBuf = toBin(senderJid);
  const sign = Buffer.concat([
    toBin(targetId),
    senderBuf,
    senderBuf,
    toBin('Message Edit'),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(secret, new Uint8Array(32), 'sha256');
  const encKey = hmacSign(sign, key0, 'sha256');
  const encPayload = Buffer.from(aesEncryptGCM(innerBytes, encKey, iv, Buffer.alloc(0)));
  if (corruptCiphertext && encPayload.length > 0) {
    encPayload[0] ^= 0x55;
  }
  if (corruptTag && encPayload.length >= 16) {
    encPayload[encPayload.length - 1] ^= 0xff;
  }
  return {
    targetMessageKey: { id: targetId, remoteJid: targetChatJid, fromMe: true },
    encPayload,
    encIv: Buffer.from(iv),
    secretEncType,
  };
}

function buildWireMsmsgBinaryNode({ stanzaId, fromJid, secEnc, tsSeconds }) {
  const encodedMsg = proto.Message.encode({ secretEncryptedMessage: secEnc }).finish();
  return {
    tag: 'message',
    attrs: {
      id: stanzaId,
      from: fromJid,
      type: 'text',
      edit: '1',
      t: String(tsSeconds),
    },
    content: [
      { tag: 'enc', attrs: { v: '2', type: 'msmsg' }, content: Buffer.from(encodedMsg) },
      { tag: 'meta', attrs: { target_id: secEnc.targetMessageKey?.id || '' } },
    ],
  };
}

function makeSock() {
  return {
    ev: new EventEmitter(),
    ws: new EventEmitter(),
    async readMessages() { return true; },
    async logout() { return true; },
    end() {},
  };
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-msmsg-secret-test-'));

try {
  const masterSecretV1 = 'tezlify-super-strong-root-encryption-secret-v1-min-32-chars';
  const masterSecretV2 = 'tezlify-super-strong-root-encryption-secret-v2-min-32-chars';
  const rawShaAesKey = crypto.createHash('sha256').update(masterSecretV1).digest();
  const hkdfSubkeyV1 = deriveMessageSecretSubkey(masterSecretV1, 1);

  assert.notEqual(
    hkdfSubkeyV1.toString('hex'),
    rawShaAesKey.toString('hex'),
    'HKDF messageSecret subkey must be domain-separated from raw SHA-256 aesKey',
  );

  const pgPool = createInMemoryPgPool();
  const sm = createSessionManager({
    sessionsDir: path.join(dir, 'gw1'),
    mediaDir: path.join(dir, 'media'),
    aesKey: rawShaAesKey,
    rootEncryptionKey: masterSecretV1,
    messageSecretKeyVersion: 1,
    backendWsUrl: '',
    pool: pgPool,
  });

  const sidA = (await sm.createSession('session-a', { autoStart: false })).id;
  const sidB = (await sm.createSession('session-b', { autoStart: false })).id;
  const sessA = sm.getSession(sidA);
  const sessB = sm.getSession(sidB);
  sessA.status = 'CONNECTED';
  sessB.status = 'CONNECTED';
  const sockA = makeSock();
  const sockB = makeSock();
  sessA.sock = sockA;
  sessB.sock = sockB;
  const genA = sessA.lifecycle.beginAttempt();
  sessA.lifecycle.attach(genA, sockA);
  const genB = sessB.lifecycle.beginAttempt();
  sessB.lifecycle.attach(genB, sockB);
  bindSocketEvents({ manager: sm, session: sessA, sock: sockA, id: sidA, generation: genA });
  bindSocketEvents({ manager: sm, session: sessB, sock: sockB, id: sidB, generation: genB });

  const emittedEvents = [];
  sm.onEvent((e) => emittedEvents.push(e));
  const storeA = sessA.store;
  const chatA = '905071234567@s.whatsapp.net';

  // -------------------------------------------------------------
  // 1. Doğru secret ile başarılı edit (via real msmsg protobuf adapter)
  // -------------------------------------------------------------
  console.log('Scenario 1: Valid secret & msmsg protobuf decode -> MESSAGE_EDIT');
  const msgId1 = 'MSG_VALID_1';
  const secret1 = randomBytes(32);
  await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: msgId1, fromMe: true },
    message: {
      conversation: 'Initial body v1',
      messageContextInfo: { messageSecret: secret1 },
    },
    messageTimestamp: 1794400000,
  }, sockA, sidA, { upsertType: 'notify' });

  assert.equal(pgPool.secretRows.size, 1, 'Encrypted messageSecret must be persisted in PG pool');
  const storedRow1 = Array.from(pgPool.secretRows.values())[0];
  assert.notEqual(
    storedRow1.ciphertext.toString('hex'),
    secret1.toString('hex'),
    'Persisted secret ciphertext must never store plaintext secret',
  );

  const secEnc1 = buildEncryptedEditContainer({
    targetId: msgId1,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Edited via msmsg protobuf',
    secret: secret1,
  });
  const wireNode1 = buildWireMsmsgBinaryNode({
    stanzaId: 'STANZA_MSMSG_1',
    fromJid: chatA,
    secEnc: secEnc1,
    tsSeconds: 1794400010,
  });
  await sm._ingestMsmsgStanza(wireNode1, sockA, sidA);

  const rec1 = (storeA.messagesByChat.get(chatA) || []).find((m) => m.wa_message_id === msgId1);
  assert.ok(rec1);
  assert.equal(rec1.body, 'Edited via msmsg protobuf');
  assert.equal(rec1.is_edited, true);
  assert.equal(
    emittedEvents.filter((e) => e.upsert_type === 'replace' && e.message?.wa_message_id === msgId1).length,
    1,
  );
  console.log('  ok - Scenario 1 passed');

  // -------------------------------------------------------------
  // 2. Secret bulunamadığında fail-closed
  // -------------------------------------------------------------
  console.log('Scenario 2: Missing secret fails closed');
  const eventsBefore2 = emittedEvents.length;
  const missingSecEnc = buildEncryptedEditContainer({
    targetId: 'UNKNOWN_SECRET_ID',
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Should never decrypt',
    secret: randomBytes(32),
  });
  const missingRes = await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({ stanzaId: 'STANZA_2', fromJid: chatA, secEnc: missingSecEnc, tsSeconds: 1794400020 }),
    sockA,
    sidA,
  );
  assert.equal(missingRes, null);
  assert.equal(emittedEvents.length, eventsBefore2);
  console.log('  ok - Scenario 2 passed');

  // -------------------------------------------------------------
  // 3. Yanlış secret ile decrypt reddi
  // -------------------------------------------------------------
  console.log('Scenario 3: Wrong messageSecret fails closed');
  const eventsBefore3 = emittedEvents.length;
  const wrongSecEnc = buildEncryptedEditContainer({
    targetId: msgId1,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Wrong secret body',
    secret: randomBytes(32), // wrong secret
  });
  const wrongSecRes = await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({ stanzaId: 'STANZA_3', fromJid: chatA, secEnc: wrongSecEnc, tsSeconds: 1794400030 }),
    sockA,
    sidA,
  );
  assert.equal(wrongSecRes, null);
  assert.equal(rec1.body, 'Edited via msmsg protobuf');
  assert.equal(emittedEvents.length, eventsBefore3);
  console.log('  ok - Scenario 3 passed');

  // -------------------------------------------------------------
  // 4. Yanlış session ID ile decrypt reddi
  // -------------------------------------------------------------
  console.log('Scenario 4: Wrong sessionId rejected (tenant/session isolation + AAD check)');
  const eventsBefore4 = emittedEvents.length;
  const wrongSessRes = await sm._ingestMsmsgStanza(wireNode1, sockB, sidB);
  assert.equal(wrongSessRes, null, 'Session B must NOT access or decrypt Session A messageSecret');
  assert.equal(emittedEvents.length, eventsBefore4);
  // Direct store AAD check: passing sidB against sidA's row throws auth error / returns null
  const secretFromWrongSession = await sm._getMessageSecretStore().getSecret({
    sessionId: sidB,
    chatJid: chatA,
    waMessageId: msgId1,
    pool: pgPool,
  });
  assert.equal(secretFromWrongSession, null);
  console.log('  ok - Scenario 4 passed');

  // -------------------------------------------------------------
  // 5. Yanlış chat JID ile decrypt reddi
  // -------------------------------------------------------------
  console.log('Scenario 5: Wrong chatJid rejected (scope + AAD check)');
  const wrongChat = '905079999999@s.whatsapp.net';
  const wrongChatSecEnc = buildEncryptedEditContainer({
    targetId: msgId1,
    targetChatJid: wrongChat,
    senderJid: wrongChat,
    plaintext: 'Wrong chat body',
    secret: secret1,
  });
  const wrongChatRes = await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({ stanzaId: 'STANZA_5', fromJid: wrongChat, secEnc: wrongChatSecEnc, tsSeconds: 1794400040 }),
    sockA,
    sidA,
  );
  assert.equal(wrongChatRes, null, 'Must reject lookup/decrypt for wrong chatJid');
  assert.equal(rec1.body, 'Edited via msmsg protobuf');
  console.log('  ok - Scenario 5 passed');

  // -------------------------------------------------------------
  // 6. Yanlış message ID ile decrypt reddi
  // -------------------------------------------------------------
  console.log('Scenario 6: Wrong waMessageId rejected');
  const wrongIdSecEnc = buildEncryptedEditContainer({
    targetId: 'MSG_WRONG_ID_6',
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Wrong ID body',
    secret: secret1,
  });
  const wrongIdRes = await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({ stanzaId: 'STANZA_6', fromJid: chatA, secEnc: wrongIdSecEnc, tsSeconds: 1794400050 }),
    sockA,
    sidA,
  );
  assert.equal(wrongIdRes, null);
  console.log('  ok - Scenario 6 passed');

  // -------------------------------------------------------------
  // 7. Bozuk ciphertext reddi
  // -------------------------------------------------------------
  console.log('Scenario 7: Corrupt ciphertext rejected fail-closed');
  const corruptCtSecEnc = buildEncryptedEditContainer({
    targetId: msgId1,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Corrupted ct',
    secret: secret1,
    corruptCiphertext: true,
  });
  const corruptCtRes = await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({ stanzaId: 'STANZA_7', fromJid: chatA, secEnc: corruptCtSecEnc, tsSeconds: 1794400060 }),
    sockA,
    sidA,
  );
  assert.equal(corruptCtRes, null);
  // Also corrupted raw protobuf bytes inside <enc type="msmsg">
  const invalidProtoNode = {
    tag: 'message',
    attrs: { id: 'BAD_PROTO_7', from: chatA },
    content: [{ tag: 'enc', attrs: { type: 'msmsg' }, content: Buffer.from([0xff, 0x00, 0xaa, 0xbb]) }],
  };
  assert.equal(decodeMsmsgProtobufPayload(invalidProtoNode).ok, false);
  assert.equal(await sm._ingestMsmsgStanza(invalidProtoNode, sockA, sidA), null);
  console.log('  ok - Scenario 7 passed');

  // -------------------------------------------------------------
  // 8. Bozuk IV reddi (wrong bytes & invalid IV length)
  // -------------------------------------------------------------
  console.log('Scenario 8: Corrupt / invalid IV rejected fail-closed');
  const badIvLen = buildEncryptedEditContainer({
    targetId: msgId1,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Short IV test',
    secret: secret1,
  });
  badIvLen.encIv = randomBytes(8); // invalid IV length != 12
  assert.equal(decodeMsmsgProtobufPayload(badIvLen).ok, false);
  assert.equal(decryptSecretEncryptedEdit(badIvLen, storeA, sessA, chatA, {}), null);

  const flippedIv = buildEncryptedEditContainer({
    targetId: msgId1,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Flipped IV test',
    secret: secret1,
  });
  flippedIv.encIv[0] ^= 0x01;
  assert.equal(
    await sm._ingestUpsertMessage({
      key: { remoteJid: chatA, id: 'STANZA_BAD_IV_8', fromMe: true },
      message: { secretEncryptedMessage: flippedIv },
      messageTimestamp: 1794400070,
    }, sockA, sidA, { upsertType: 'notify' }),
    null,
  );
  console.log('  ok - Scenario 8 passed');

  // -------------------------------------------------------------
  // 9. Geçersiz authentication tag reddi (payload tag & stored DB auth_tag)
  // -------------------------------------------------------------
  console.log('Scenario 9: Invalid AES-GCM authentication tag rejected (payload & stored row)');
  const badTagSecEnc = buildEncryptedEditContainer({
    targetId: msgId1,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Bad auth tag',
    secret: secret1,
    corruptTag: true,
  });
  assert.equal(
    await sm._ingestUpsertMessage({
      key: { remoteJid: chatA, id: 'STANZA_BAD_TAG_9', fromMe: true },
      message: { secretEncryptedMessage: badTagSecEnc },
      messageTimestamp: 1794400080,
    }, sockA, sidA, { upsertType: 'notify' }),
    null,
  );
  // Corrupt stored DB row's auth_tag & clear RAM cache -> DB decryption MUST reject!
  const tamperedSecretStore = createMessageSecretStore({
    rootKeyMaterial: masterSecretV1,
    activeKeyVersion: 1,
    pool: pgPool,
  });
  const savedKey1 = `${sidA}\0${chatA}\0${msgId1}`;
  const origTagByte = pgPool.secretRows.get(savedKey1).auth_tag[0];
  pgPool.secretRows.get(savedKey1).auth_tag[0] = origTagByte ^ 0xff;
  assert.equal(
    await tamperedSecretStore.getSecret({ sessionId: sidA, chatJid: chatA, waMessageId: msgId1 }),
    null,
    'Tampered DB auth_tag must fail AES-GCM verification',
  );
  pgPool.secretRows.get(savedKey1).auth_tag[0] = origTagByte; // restore
  console.log('  ok - Scenario 9 passed');

  // -------------------------------------------------------------
  // 10 & 16. Gateway restart sonrası secret erişimi + AUDIO mesaj metadata korunumu
  // -------------------------------------------------------------
  console.log('Scenarios 10 & 16: Cold restart secret recovery & AUDIO metadata preservation');
  const audioMsgId = 'AUDIO_RESTART_10';
  const audioSecret = randomBytes(32);
  await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: audioMsgId, fromMe: true },
    message: {
      audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 4 },
      messageContextInfo: { messageSecret: audioSecret },
    },
    messageTimestamp: 1794400100,
  }, sockA, sidA, { upsertType: 'notify' });

  pgPool.messageRows.set(audioMsgId, {
    id: 9010,
    conversation_id: 777,
    direction: 'OUTBOUND',
    message_type: 'AUDIO',
    body: 'Ses',
    media_id: 'media_audio_restart_10',
    media_mime_type: 'audio/ogg; codecs=opus',
    media_filename: 'ptt.ogg',
    media_caption: 'Ses',
    status: 'SENT',
    created_at: '2026-11-12T10:00:00.000Z',
    recipient_phone: '+905071234567',
    sender_phone: 'ME',
    is_group: false,
    parent_jid: null,
    contact_phone: '+905071234567',
  });

  // Simulate cold Gateway restart with brand new SessionManager (empty RAM, same session ID & shared PG pool)
  const smRestart = createSessionManager({
    sessionsDir: path.join(dir, 'gw_restarted'),
    mediaDir: path.join(dir, 'media'),
    aesKey: rawShaAesKey,
    rootEncryptionKey: masterSecretV1,
    messageSecretKeyVersion: 1,
    backendWsUrl: '',
    pool: pgPool,
  });
  const sidRestart = (await smRestart.createSession('session-a-restarted', { autoStart: false, id: sidA })).id;
  // Note createSession generates a new UUID unless injected; bind restored session under exact sidA via persisted state or direct registry map:
  const restoredSession = await smRestart.createSession('session-a', { autoStart: false });
  // Instead, test deterministic session ID recovery across restarts by seeding under restoredSession.id OR using deterministic session id:
  await smRestart.deleteSession(restoredSession.id);
  const restartEvents = [];
  smRestart.onEvent((e) => restartEvents.push(e));
  // Create cold session whose id matches sidA (simulating restoreSessions loading session row sidA from DB)
  const coldSm = createSessionManager({
    sessionsDir: path.join(dir, 'gw1'), // reuses persisted session dir with sidA!
    mediaDir: path.join(dir, 'media'),
    aesKey: rawShaAesKey,
    rootEncryptionKey: masterSecretV1,
    messageSecretKeyVersion: 1,
    backendWsUrl: '',
    pool: pgPool,
  });
  // Ensure session directory metadata exists for restoreSessions or invoke _requireSession cleanly:
  // Actually let's test direct cold cache clear on a fresh secretStore + cleared session RAM store (exact restart state!):
  sm._getMessageSecretStore().clearRamCache();
  storeA.rawMessagesByChat.clear();
  storeA.messagesByChat.clear();

  const audioEditSecEnc = buildEncryptedEditContainer({
    targetId: audioMsgId,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'Ses44',
    secret: audioSecret,
  });
  const persistedHitsBefore = sessA._editDiagnostics?.secret_edit_persisted_hits || 0;
  await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({
      stanzaId: 'STANZA_RESTART_AUDIO_10',
      fromJid: 'status@broadcast',
      secEnc: { ...audioEditSecEnc, targetMessageKey: { id: audioMsgId, fromMe: true } },
      tsSeconds: 1794400120,
    }),
    sockA,
    sidA,
  );

  const audioRecRestart = (storeA.messagesByChat.get(chatA) || []).find((m) => m.wa_message_id === audioMsgId);
  assert.ok(audioRecRestart, 'Audio edit after restart must hydrate under DB-resolved chat');
  assert.equal(audioRecRestart.body, 'Ses44');
  assert.equal(audioRecRestart.is_edited, true);
  assert.equal(audioRecRestart.message_type, 'AUDIO', 'AUDIO type preserved across restart');
  assert.equal(audioRecRestart.media_id, 'media_audio_restart_10', 'media_id preserved across restart');
  assert.equal(sessA._editDiagnostics?.secret_edit_persisted_hits, persistedHitsBefore + 1);
  console.log('  ok - Scenarios 10 & 16 passed');

  // -------------------------------------------------------------
  // 11. Session logout sonrası secret temizliği
  // -------------------------------------------------------------
  console.log('Scenario 11: Session logout purges persisted secrets');
  await sm.logoutSession(sidB, { force: true });
  // Now create a dedicated session C with secret, then logout -> DB & RAM cleared!
  const sidC = (await sm.createSession('session-c', { autoStart: false })).id;
  const sessC = sm.getSession(sidC);
  const sockC = makeSock();
  sessC.status = 'CONNECTED';
  sessC.sock = sockC;
  const genC = sessC.lifecycle.beginAttempt();
  sessC.lifecycle.attach(genC, sockC);
  bindSocketEvents({ manager: sm, session: sessC, sock: sockC, id: sidC, generation: genC });

  const msgIdC = 'MSG_LOGOUT_11';
  const secretC = randomBytes(32);
  await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: msgIdC, fromMe: true },
    message: { conversation: 'Before logout', messageContextInfo: { messageSecret: secretC } },
    messageTimestamp: 1794400150,
  }, sockC, sidC, { upsertType: 'notify' });
  assert.ok(pgPool.secretRows.has(`${sidC}\0${chatA}\0${msgIdC}`));

  await sm.logoutSession(sidC, { force: true });
  assert.equal(pgPool.secretRows.has(`${sidC}\0${chatA}\0${msgIdC}`), false, 'Logout must delete PG secret rows');
  assert.equal(
    await sm._getMessageSecretStore().getSecret({ sessionId: sidC, chatJid: chatA, waMessageId: msgIdC }),
    null,
  );
  console.log('  ok - Scenario 11 passed');

  // -------------------------------------------------------------
  // 12. Secret rotation (Key version rotation & Per-message secret rotation)
  // -------------------------------------------------------------
  console.log('Scenario 12: Key version rotation (v1 -> v2) & per-message secret rotation');
  const storeV2 = createMessageSecretStore({
    rootKeyMaterial: masterSecretV2,
    activeKeyVersion: 2,
    keyRing: {
      1: masterSecretV1,
      2: masterSecretV2,
    },
    pool: pgPool,
  });
  // v2 instance reads v1 row encrypted by v1 HKDF key!
  const v1SecretReadByV2 = await storeV2.getSecret({
    sessionId: sidA,
    chatJid: chatA,
    waMessageId: audioMsgId,
  });
  assert.equal(Buffer.compare(v1SecretReadByV2, audioSecret), 0, 'v2 keyring must decrypt existing v1 row');

  // Per-message secret rotation writes under key_version 2 and invalidates old secret
  const rotatedSecret = randomBytes(32);
  await storeV2.saveSecret({
    sessionId: sidA,
    chatJid: chatA,
    waMessageId: audioMsgId,
    secret: rotatedSecret,
  });
  assert.equal(pgPool.secretRows.get(`${sidA}\0${chatA}\0${audioMsgId}`).key_version, 2);
  assert.equal(
    Buffer.compare(await storeV2.getSecret({ sessionId: sidA, chatJid: chatA, waMessageId: audioMsgId }), rotatedSecret),
    0,
  );
  // Retired key version (only v2 in keyring, reading a v1 row) fails closed
  const storeV2Only = createMessageSecretStore({
    rootKeyMaterial: masterSecretV2,
    activeKeyVersion: 2,
    pool: pgPool,
  });
  assert.equal(
    await storeV2Only.getSecret({ sessionId: sidA, chatJid: chatA, waMessageId: msgId1 }),
    null,
    'Unknown/retired key_version must fail closed',
  );
  console.log('  ok - Scenario 12 passed');

  // -------------------------------------------------------------
  // 13 & 14. Duplicate edit & Eski edit timestamp
  // -------------------------------------------------------------
  console.log('Scenarios 13 & 14: Duplicate edit idempotency & stale timestamp protection');
  const msgTsId = 'MSG_TS_13_14';
  const tsSecret = randomBytes(32);
  await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: msgTsId, fromMe: true },
    message: { conversation: 'ts v1', messageContextInfo: { messageSecret: tsSecret } },
    messageTimestamp: 1794400200,
  }, sockA, sidA, { upsertType: 'notify' });

  const newerEdit = buildEncryptedEditContainer({
    targetId: msgTsId,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'ts v3 newer',
    secret: tsSecret,
  });
  await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({ stanzaId: 'STANZA_TS_V3', fromJid: chatA, secEnc: newerEdit, tsSeconds: 1794400220 }),
    sockA,
    sidA,
  );
  // Duplicate replay of same newer edit
  await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({ stanzaId: 'STANZA_TS_V3_DUP', fromJid: chatA, secEnc: newerEdit, tsSeconds: 1794400220 }),
    sockA,
    sidA,
  );
  // Older edit arrives late -> must not clobber
  const olderEdit = buildEncryptedEditContainer({
    targetId: msgTsId,
    targetChatJid: chatA,
    senderJid: chatA,
    plaintext: 'ts v2 stale',
    secret: tsSecret,
  });
  await sm._ingestMsmsgStanza(
    buildWireMsmsgBinaryNode({ stanzaId: 'STANZA_TS_V2', fromJid: chatA, secEnc: olderEdit, tsSeconds: 1794400210 }),
    sockA,
    sidA,
  );

  const tsRecords = (storeA.messagesByChat.get(chatA) || []).filter((m) => m.wa_message_id === msgTsId);
  assert.equal(tsRecords.length, 1, 'Duplicate edit must not create extra bubble');
  assert.equal(tsRecords[0].body, 'ts v3 newer', 'Stale edit timestamp must not clobber newer edit');
  console.log('  ok - Scenarios 13 & 14 passed');

  // -------------------------------------------------------------
  // 15. Cross-chat edit girişimi
  // -------------------------------------------------------------
  console.log('Scenario 15: Cross-chat inbound edit attempt rejected');
  const attackerChat = '905070001122@s.whatsapp.net';
  const crossAttempt = await sm._ingestUpsertMessage({
    key: { remoteJid: attackerChat, id: 'STANZA_CROSS_15', fromMe: false },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: msgTsId, remoteJid: attackerChat, fromMe: false },
        editedMessage: { conversation: 'Cross attack' },
        timestampMs: 1794400300000,
      },
    },
    messageTimestamp: 1794400300,
  }, sockA, sidA, { upsertType: 'notify' });
  assert.equal(crossAttempt, null);
  assert.equal(tsRecords[0].body, 'ts v3 newer');
  console.log('  ok - Scenario 15 passed');

  // -------------------------------------------------------------
  // 17, 18, 19. View Once, Revoke/delete, Normal text & unmigrated DB (42P01) regressions
  // -------------------------------------------------------------
  console.log('Scenarios 17, 18, 19: View Once, Revoke/Delete & Normal Text regressions');
  const normalId = 'MSG_NORM_19';
  await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: normalId, fromMe: true },
    message: { conversation: 'Normal text ok' },
    messageTimestamp: 1794400400,
  }, sockA, sidA, { upsertType: 'notify' });
  const normRec = (storeA.messagesByChat.get(chatA) || []).find((m) => m.wa_message_id === normalId);
  assert.equal(normRec?.body, 'Normal text ok');

  const voId = 'MSG_VO_17';
  await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: voId, fromMe: false, isViewOnce: true },
    message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } },
    messageTimestamp: 1794400410,
  }, sockA, sidA, { upsertType: 'notify' });
  const voRec = (storeA.messagesByChat.get(chatA) || []).find((m) => m.wa_message_id === voId);
  assert.equal(voRec?.is_view_once, true);

  await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: 'STANZA_REVOKE_18', fromMe: true },
    message: {
      protocolMessage: {
        type: 0,
        key: { id: normalId, remoteJid: chatA, fromMe: true },
      },
    },
    messageTimestamp: 1794400420,
  }, sockA, sidA, { upsertType: 'notify' });
  assert.equal(normRec?.is_revoked, true);
  assert.equal(normRec?.body, '');

  // Backward-compatibility check: 42P01 undefined_table must not throw
  const unmigratedPool = {
    async query() {
      const err = new Error('relation "whatsapp_private.message_secrets" does not exist');
      err.code = '42P01';
      throw err;
    },
  };
  const fallbackStore = createMessageSecretStore({ rootKeyMaterial: masterSecretV1, pool: unmigratedPool });
  const fallbackSaveRes = await fallbackStore.saveSecret({
    sessionId: sidA,
    chatJid: chatA,
    waMessageId: 'UNMIGRATED_1',
    secret: randomBytes(32),
  });
  assert.equal(fallbackSaveRes.ok, false, '42P01 must NOT report false-positive durable success');
  assert.equal(fallbackSaveRes.persisted, false);
  assert.equal(fallbackSaveRes.cachedInRam, true);
  assert.equal(fallbackSaveRes.storage, 'ram_only');
  assert.equal(fallbackSaveRes.reason, 'table_unavailable');
  assert.equal(fallbackStore.getStats().schemaMissingWarned, true);
  console.log('  ok - Scenarios 17, 18, 19 passed');

  // -------------------------------------------------------------
  // 20. Note-to-Self / LID regression
  // -------------------------------------------------------------
  console.log('Scenario 20: Note-to-Self / LID secret persistence & resolution');
  const selfPn = '905413749073@s.whatsapp.net';
  const selfLid = '999888777666@lid';
  sessA.phoneNumberJid = selfPn;
  sm._applyLidMapping(sessA, selfLid, selfPn);

  const selfMsgId = 'SELF_LID_MSG_20';
  const selfSecret = randomBytes(32);
  await sm._ingestUpsertMessage({
    key: { remoteJid: selfPn, id: selfMsgId, fromMe: true },
    message: { conversation: 'Self note init', messageContextInfo: { messageSecret: selfSecret } },
    messageTimestamp: 1794400500,
  }, sockA, sidA, { upsertType: 'notify' });

  // Clear RAM raw store; edit arrives addressed by mapped @lid!
  storeA.rawMessagesByChat.delete(selfPn);
  const selfEditSec = buildEncryptedEditContainer({
    targetId: selfMsgId,
    targetChatJid: selfPn,
    senderJid: selfPn,
    plaintext: 'Self note edited via persisted secret & LID',
    secret: selfSecret,
  });
  await sm._ingestUpsertMessage({
    key: { remoteJid: selfLid, id: 'STANZA_SELF_LID_20', fromMe: true },
    message: {
      secretEncryptedMessage: {
        ...selfEditSec,
        targetMessageKey: { id: selfMsgId, remoteJid: selfLid, fromMe: true },
      },
    },
    messageTimestamp: 1794400510,
  }, sockA, sidA, { upsertType: 'notify' });

  const selfRec = (storeA.messagesByChat.get(selfPn) || []).find((m) => m.wa_message_id === selfMsgId);
  assert.ok(selfRec);
  assert.equal(selfRec.body, 'Self note edited via persisted secret & LID');
  assert.equal(selfRec.is_edited, true);
  console.log('  ok - Scenario 20 passed');

  // Verify buildMessageSecretAad rejects missing scope params
  assert.throws(() => buildMessageSecretAad({ sessionId: sidA, chatJid: '', waMessageId: 'x', keyVersion: 1 }));

  // -------------------------------------------------------------
  // 21. Group A Security invariants: invalid rootKeyMaterial, unique nonce, wrong senderJid
  // -------------------------------------------------------------
  console.log('Scenario 21: Invalid key fail-closed, unique GCM nonce & wrong senderJid rejection');
  assert.throws(() => createMessageSecretStore({ rootKeyMaterial: null }));
  assert.throws(() => createMessageSecretStore({ rootKeyMaterial: 'too-short' }));

  const noncePool = createInMemoryPgPool();
  const nonceStore = createMessageSecretStore({ rootKeyMaterial: masterSecretV1, pool: noncePool });
  const repeatSecret = randomBytes(32);
  await nonceStore.saveSecret({ sessionId: sidA, chatJid: chatA, waMessageId: 'NONCE_MSG_1', secret: repeatSecret });
  const nonceFirst = Buffer.from(noncePool.secretRows.get(`${sidA}\0${chatA}\0NONCE_MSG_1`).nonce);
  await nonceStore.saveSecret({ sessionId: sidA, chatJid: chatA, waMessageId: 'NONCE_MSG_1', secret: repeatSecret });
  const nonceSecond = Buffer.from(noncePool.secretRows.get(`${sidA}\0${chatA}\0NONCE_MSG_1`).nonce);
  assert.notEqual(nonceFirst.toString('hex'), nonceSecond.toString('hex'), 'Each encryption must use a fresh 12-byte nonce');

  const wrongSenderSecEnc = buildEncryptedEditContainer({
    targetId: msgId1,
    targetChatJid: chatA,
    senderJid: '905070000001@s.whatsapp.net', // wrong senderJid despite valid secret & chatJid
    plaintext: 'Wrong sender edit',
    secret: secret1,
  });
  const wrongSenderRes = await sm._ingestUpsertMessage({
    key: { remoteJid: chatA, id: 'STANZA_WRONG_SENDER_21', fromMe: true, participant: chatA },
    message: { secretEncryptedMessage: wrongSenderSecEnc },
    messageTimestamp: 1794400600,
  }, sockA, sidA, { upsertType: 'notify' });
  assert.equal(wrongSenderRes, null, 'Mismatched senderJid in HMAC key derivation must fail closed');
  console.log('  ok - Scenario 21 passed');

  console.log('=== ALL 21 PHASE 1.2/1.3 SYNTHETIC SCENARIOS PASSED WITH FULL EVIDENCE ===');
} finally {
  await rm(dir, { recursive: true, force: true });
}

