// Faz 10 (P3): telefondan gönderilen mesajlar (messages.upsert fromMe=true)
// artık gateway'de kaydedilir, yayınlanır ve sohbet önizlemesini günceller.
// `node scripts/test-faz10-p3-fromme.mjs` ile çalışır, exit code 0 = PASS.
import assert from 'node:assert/strict';
import { createSessionManager } from '../src/session-manager.js';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const sm = createSessionManager({
  sessionsDir: path.join(os.tmpdir(), 'faz10-p3-sessions'),
  mediaDir: path.join(os.tmpdir(), 'faz10-p3-media'),
  aesKey: '0'.repeat(64),
  backendWsUrl: '',
});

const events = [];
sm.onEvent((e) => {
  if (e.event === 'message_new') events.push(e);
});

const findChat = (jid) => sm.listConversations().items.find((c) => c.jid === jid);
const msgsOf = async (jid) => sm.getMessages(jid, { limit: 500 });

const PN = '905525372434@s.whatsapp.net'; // Ali Ekincioğlu örneği
const TS = Math.floor(Date.now() / 1000);

// --- 1. fromMe upsert: OUTBOUND kayıt + message_new + preview 'Sg' ---

await check('fromMe upsert kaydedilir: OUTBOUND/SENT/sender ME, preview "Sg", event yayin', async () => {
  const rec = await sm._ingestUpsertMessage(
    { key: { remoteJid: PN, id: 'SGID1', fromMe: true }, message: { conversation: 'Sg' }, messageTimestamp: TS },
    null,
  );
  assert.ok(rec, 'fromMe mesaj record döndürmeli (eskiden continue ile atiliyordu)');
  assert.equal(rec.direction, 'OUTBOUND');
  assert.equal(rec.status, 'SENT');
  assert.equal(rec.sender_name, 'ME');
  assert.equal(rec.sender_phone, 'ME');
  assert.equal(rec.recipient_phone, '+905525372434');
  assert.equal(rec.body, 'Sg');
  assert.equal(rec.wa_message_id, 'SGID1');
  // event yayinlandi ve govde 'Sg'
  assert.equal(events.length, 1);
  assert.equal(events[0].conversation_id, PN);
  assert.equal(events[0].message.body, 'Sg');
  assert.equal(events[0].message.direction, 'OUTBOUND');
  // sohbet önizlemesi son mesajı gösterir
  const chat = findChat(PN);
  assert.ok(chat, 'sohbet _touchChat ile olusmali');
  assert.equal(chat.last_message_preview, 'Sg');
  // kendi gönderdiğimiz mesaj OKUNMAMIŞ sayılmaz
  assert.equal(chat.unread_count ?? 0, 0);
  // mesaj listesinde de görünmeli
  assert.equal((await msgsOf(PN)).filter((m) => m.wa_message_id === 'SGID1').length, 1);
});

// --- 2. INBOUND regresyon: unread +1, pushName çözülür, preview yazar ---

await check('inbound upsert regresyon: INBOUND/RECEIVED, unread +1, preview guncellenir', async () => {
  const before = events.length;
  const rec = await sm._ingestUpsertMessage(
    { key: { remoteJid: PN, id: 'IN1' }, pushName: 'Ali Ekincioğlu', message: { conversation: 'Selam' }, messageTimestamp: TS + 10 },
    null,
  );
  assert.equal(rec.direction, 'INBOUND');
  assert.equal(rec.status, 'RECEIVED');
  assert.equal(rec.sender_name, 'Ali Ekincioğlu');
  assert.equal(events.length, before + 1);
  const chat = findChat(PN);
  assert.equal(chat.last_message_preview, 'Selam');
  assert.equal(chat.unread_count, 1);
});

// --- 3. Dedup (ileri yön): önce _recordOutbound, sonra aynı id ile upsert ---

const PN2 = '905321002030@s.whatsapp.net';

await check('ayni wa_message_id: _recordOutbound sonrasi fromMe upsert NULL doner, tek kayit/tek event', async () => {
  const before = events.length;
  sm._recordOutbound(PN2, { body: 'Appden gonderdi', wa_message_id: 'DUP1' });
  assert.equal(events.length, before + 1);
  const dup = await sm._ingestUpsertMessage(
    { key: { remoteJid: PN2, id: 'DUP1', fromMe: true }, message: { conversation: 'Appden gonderdi' }, messageTimestamp: TS },
    null,
  );
  assert.equal(dup, null, 'duplicate upsert islenmemeli');
  assert.equal(events.length, before + 1, 'ikinci event yayinlanmali');
  assert.equal((await msgsOf(PN2)).filter((m) => m.wa_message_id === 'DUP1').length, 1);
});

// --- 4. Dedup (ters yön): önce upsert, sonra _recordOutbound ---

const PN3 = '905012345678@s.whatsapp.net';

await check('ayni wa_message_id: once fromMe upsert ise _recordOutbound mevcut kaydi doner, çift kayit yok', async () => {
  const before = events.length;
  await sm._ingestUpsertMessage(
    { key: { remoteJid: PN3, id: 'DUP2', fromMe: true }, message: { conversation: 'Telefondan' }, messageTimestamp: TS },
    null,
  );
  assert.equal(events.length, before + 1);
  const out = sm._recordOutbound(PN3, { body: 'Telefondan', wa_message_id: 'DUP2' });
  assert.equal(out.wa_message_id, 'DUP2');
  assert.equal(events.length, before + 1, '_recordOutbound dedup edince event YAYINLAMALI');
  assert.equal((await msgsOf(PN3)).filter((m) => m.wa_message_id === 'DUP2').length, 1);
});

// --- 5. History sync yolu (yeniden eşleştirme sonrası 'Sg' kurtarma) ---

await check('_historyMessageToRecord: fromMe history mesaji OUTBOUND/ME olarak cevrilir', () => {
  const rec = sm._historyMessageToRecord(
    { key: { remoteJid: PN, id: 'H1', fromMe: true }, message: { conversation: 'Sg' }, messageTimestamp: TS },
    PN,
  );
  assert.equal(rec.direction, 'OUTBOUND');
  assert.equal(rec.status, 'SENT');
  assert.equal(rec.sender_name, 'ME');
  assert.equal(rec.body, 'Sg');
});

// --- 6. Çözülmemiş LID: mesaj bellekte bekler, backend'e yayılmaz ---

await check('cozulmemis LID fromMe mesaj: record olusur ama message_new YAYINLANMAZ (lidHold)', async () => {
  const before = events.length;
  const rec = await sm._ingestUpsertMessage(
    { key: { remoteJid: '1234567890@lid', id: 'LID1', fromMe: true }, message: { conversation: 'lid mesaji' }, messageTimestamp: TS },
    null,
  );
  assert.ok(rec);
  assert.equal(rec.direction, 'OUTBOUND');
  assert.equal(events.length, before, 'lidHold event yayinlamali');
});

// --- 7. Medya (IMAGE) fromMe: tip etiketi preview, indirme YOK (sock null olsa da çökmez) ---

await check('fromMe IMAGE upsert: caption/etiket preview, media indirmesi atlaniyor', async () => {
  const before = events.length;
  const PN4 = '905551112233@s.whatsapp.net';
  const rec = await sm._ingestUpsertMessage(
    { key: { remoteJid: PN4, id: 'IMG1', fromMe: true }, message: { imageMessage: { caption: 'Bak' } }, messageTimestamp: TS },
    null,
  );
  assert.equal(rec.message_type, 'IMAGE');
  assert.equal(rec.body, 'Bak');
  assert.equal(rec.media_id, null);
  assert.equal(events.length, before + 1);
  assert.equal(findChat(PN4).last_message_preview, 'Bak');
});

console.log(`\nFaz 10 P3 fromMe gateway tests: ${passed} passed.`);
