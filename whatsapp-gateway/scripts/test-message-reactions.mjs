/**
 * Mesaj reaksiyonlari (gateway tarafi) — siniflandirma ve gonderim sozlesmesi.
 *
 * Eski davranis: `reactionMessage` genel mesaj kayit yoluna dusuyor, orada
 * `systemContentMarker` ona `[REACTION]` yer tutucu govdesini veriyordu. Sonuc:
 * sohbette cop bir balon, listede yanlis `last_message` onizlemesi ve gercek
 * reaksiyonun kaybi. Bu test o siniflandirmayi LOCKLAR:
 *
 * A. reaksiyon `message_reaction` olayi uretir, `message_new` DEGIL
 * B. yerel mesaj kaydi OLUSMAZ (reaksiyon mesaj degildir)
 * C. hedef `reactionMessage.key.id`dir (olayin kendi `msg.key.id`si degil)
 * D. `text: ''` = geri cekme (`removed: true`)
 * E. `sendReaction` Baileys `react` govdesini hedef anahtarla kurar ve yerel
 *    kayit YAZMAZ; normal metin mesaji hala `message_new` uretir
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-reactions-'));
const sm = createSessionManager({ sessionsDir: dir, mediaDir: dir, aesKey: '0'.repeat(64), backendWsUrl: '' });
const sid = (await sm.createSession('reaction-test', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';

const JID = '905551112233@s.whatsapp.net';
const PEER = '905559998877@s.whatsapp.net';
const TARGET_WA_ID = '3A1F_TARGET';
const events = [];
sm.onEvent((event) => events.push(event));

// `getMessages` ASYNC: await edilmezse dizi yerine Promise dondurur ve
// `length` NaN olur — sayim assert'leri sessizce bos gecerdi.
const countMessages = async () => (await sm.getMessages(sid, JID) || []).length;
const reactionEvents = () => events.filter((e) => e.event === 'message_reaction');

try {
  // --- A/B/C. Yerinde reaksiyon: kendi olayi, mesaj satiri YOK -----------------
  const before = await countMessages();
  const inbound = {
    key: { remoteJid: JID, fromMe: false, id: 'RX_OWN_ID', participant: PEER },
    message: {
      reactionMessage: {
        text: '❤️',
        key: { remoteJid: JID, fromMe: true, id: TARGET_WA_ID },
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  const result = await sm._ingestUpsertMessage(inbound, null, sid);

  assert.equal(result?.event, 'message_reaction', 'reaksiyon kendi olayina yonlenmeli');
  assert.equal(result.conversation_id, JID);
  assert.equal(result.target_wa_message_id, TARGET_WA_ID, 'hedef, reactionMessage.key.id olmali');
  assert.notEqual(result.target_wa_message_id, 'RX_OWN_ID');
  assert.equal(result.emoji, '❤️');
  assert.equal(result.removed, false);
  assert.equal(result.from_me, false);
  assert.equal(result.reactor_jid, PEER);
  assert.equal(await countMessages(), before, 'reaksiyon yerel mesaj kaydi URETMEMELI');
  assert.equal(
    events.filter((e) => e.event === 'message_new' && e.conversation_id === JID).length,
    0,
    'reaksiyon message_new olarak yayinlanmamali',
  );

  // --- C. Kendi reaksiyonumuz (fromMe) ---------------------------------------
  const mine = await sm._ingestUpsertMessage(
    {
      key: { remoteJid: JID, fromMe: true, id: 'RX_OWN_ID_2' },
      message: {
        reactionMessage: { text: '🔥', key: { remoteJid: JID, fromMe: false, id: TARGET_WA_ID } },
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    null,
    sid,
  );
  assert.equal(mine.from_me, true);
  assert.equal(mine.reactor_jid, null, 'kendi hattimiz icin reactor_jid null (backend ME sentinelini yazar)');

  // --- D. Geri cekme ---------------------------------------------------------
  const withdrawn = await sm._ingestUpsertMessage(
    {
      key: { remoteJid: JID, fromMe: false, id: 'RX_OWN_ID_3', participant: PEER },
      message: {
        reactionMessage: { text: '', key: { remoteJid: JID, fromMe: true, id: TARGET_WA_ID } },
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    null,
    sid,
  );
  assert.equal(withdrawn.removed, true, 'bos metin geri cekmedir');
  assert.equal(withdrawn.emoji, '');
  assert.equal(await countMessages(), before);

  // --- E. Gonderim: react govdesi ve yerel kayit yok -------------------------
  const sent = [];
  session.sock = {
    async sendMessage(remoteJid, content) {
      sent.push({ remoteJid, content });
      return { key: { id: TARGET_WA_ID, remoteJid, fromMe: true } };
    },
  };
  const sendResult = await sm.sendReaction(sid, JID, {
    target_wa_message_id: TARGET_WA_ID,
    target_from_me: true,
    emoji: '🎉',
  });
  assert.equal(sendResult.success, true);
  assert.equal(sendResult.removed, false);
  assert.equal(sent.length, 1, 'tek provider cagrisi');
  assert.equal(sent[0].remoteJid, JID);
  assert.deepEqual(sent[0].content, {
    react: {
      text: '🎉',
      key: { remoteJid: JID, fromMe: true, id: TARGET_WA_ID },
    },
  });
  assert.equal(await countMessages(), before, 'giden reaksiyon da mesaj kaydi URETMEMELI');

  // Geri cekme gonderimi de ayni yoldan gider (bos metin).
  await sm.sendReaction(sid, JID, {
    target_wa_message_id: TARGET_WA_ID,
    target_from_me: true,
    emoji: '',
  });
  assert.deepEqual(sent[1].content.react, {
    text: '',
    key: { remoteJid: JID, fromMe: true, id: TARGET_WA_ID },
  });

  // --- F. Normal mesaj hala message_new --------------------------------------
  session.sock = { async sendMessage() { return { key: { id: 'x' } }; } };
  const normal = await sm._ingestUpsertMessage(
    {
      key: { remoteJid: JID, fromMe: false, id: 'MSG_1', participant: PEER },
      message: { conversation: 'merhaba' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    session.sock,
    sid,
  );
  // `_ingestUpsertMessage` normal mesajda kaydi doner ve `message_new` yayinlar.
  assert.equal(normal?.wa_message_id, 'MSG_1', 'normal mesaj yolu bozulmamali');
  assert.equal(await countMessages(), before + 1);
  assert.equal(
    events.filter((e) => e.event === 'message_new' && e.message?.wa_message_id === 'MSG_1').length,
    1,
  );

  assert.ok(reactionEvents().length >= 3);
  console.log('Gateway message reactions: classification, target key, withdrawal, send: PASS');
} finally {
  await rm(dir, { recursive: true, force: true });
}
