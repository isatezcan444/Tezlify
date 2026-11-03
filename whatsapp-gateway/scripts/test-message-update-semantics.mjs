/**
 * AŞAMA 5.3.9 — `messages.update` içerik güncellemesi semantiği (gateway).
 *
 * Neden: `socket-events.js` `messages.update` içeriğini `_ingestUpsertMessage`'a
 * `upsertType` VERMEDEN gönderiyordu. Varsayılan `notify` olduğu için bir
 * mesajın retry-decrypt / edit güncellemesi CANLI YENİ MESAJ gibi işleniyordu:
 *   - rozet artıyordu (INBOUND + !fromMe),
 *   - zaman damgası yoksa `Date.now()` ile sohbet en üste taşınıyordu,
 *   - `upsert_type` 'notify' olarak yayınlanıyordu.
 *
 * Bu test 12 senaryoyu doğrular. `messages.update` içeriği artık açık
 * `upsertType: 'replace'` ile taşınır:
 *   - aynı `wa_message_id` GÜNCELLENİR, yeni satır OLUŞMAZ,
 *   - rozet ARTMAZ,
 *   - gerçek içerik değişikliği `message_new` (upsert_type=replace) ile yayınlanır,
 *   - içerik değişmemiş duplicate update YAYIN ÜRETMEZ,
 *   - eski/zamansız güncelleme önizlemeyi ve sıralamayı OYNATMAZ,
 *   - notify/append ve status ACK yolları DEĞİŞMEZ.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSessionManager } from '../src/session-manager.js';
import { bindSocketEvents } from '../src/socket/socket-events.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-msg-update-'));
const sm = createSessionManager({
  sessionsDir: dir,
  mediaDir: dir,
  aesKey: '0'.repeat(64),
  backendWsUrl: '',
});
const sid = (await sm.createSession('msg-update', { autoStart: false })).id;
const session = sm.getSession(sid);
session.status = 'CONNECTED';
session.ephemeral = true;

const ev = new EventEmitter();
const sock = { ev, async readMessages() { return true; } };
session.sock = sock;
const gen = session.lifecycle.beginAttempt();
session.lifecycle.attach(gen, sock);

bindSocketEvents({ manager: sm, session, sock, id: sid, generation: gen });

const emitted = [];
sm.onEvent((event) => emitted.push(event));

const PN = '905551112233@s.whatsapp.net';
const chatOf = () => session.store.chats.get(PN);
const listOf = () => session.store.messagesByChat.get(PN) || [];
const newEvents = (waId) => emitted.filter((e) => e.event === 'message_new' && e.message?.wa_message_id === waId);
const lastNew = (waId) => [...newEvents(waId)].reverse()[0];
const statusEvents = (waId) => emitted.filter((e) => e.event === 'message_status_updated' && e.wa_message_id === waId);

const mkUpsert = (id, body, ts, extra = {}) => ({
  key: { remoteJid: PN, fromMe: false, id, ...(extra.key || {}) },
  message: { conversation: body },
  messageTimestamp: ts,
});
const emitUpdate = async (item) => {
  ev.emit('messages.update', [item]);
  await new Promise((r) => setTimeout(r, 30));
};

const base = Math.floor(Date.now() / 1000);
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
};

console.log('[test-message-update-semantics] Starting...');

try {
  // --- Tohum: canlı bir mesaj (M1) + daha eski bir geçmiş mesaj (M2) ---
  await sm._ingestUpsertMessage(mkUpsert('UPD_SEED_1', 'Ilk icerik', base - 10), sock, sid, { upsertType: 'notify' });
  await sm._ingestUpsertMessage(mkUpsert('UPD_SEED_2', 'Eski icerik', base - 200), sock, sid, { upsertType: 'append' });
  const unreadAfterSeed = chatOf().unread_count;
  const previewAfterSeed = chatOf().last_message_preview;
  const tsAfterSeed = chatOf().last_message_at;

  // --- 1-2-3-4. İçerik değişikliği: güncelle, satır çoğaltma, rozet artırma, yayınla ---
  const beforeEvents = newEvents('UPD_SEED_1').length;
  await emitUpdate({
    key: { remoteJid: PN, fromMe: false, id: 'UPD_SEED_1' },
    update: { message: { conversation: 'Guncellenmis icerik' }, messageTimestamp: base - 5 },
  });
  check('1. content change updates the existing record body', () => {
    const rec = listOf().find((m) => m.wa_message_id === 'UPD_SEED_1');
    assert.ok(rec, 'kayit bulunmali');
    assert.equal(rec.body, 'Guncellenmis icerik');
  });
  check('2. no new record is created for the same wa_message_id', () => {
    assert.equal(listOf().filter((m) => m.wa_message_id === 'UPD_SEED_1').length, 1);
  });
  check('3. update does NOT increment unread', () => {
    assert.equal(chatOf().unread_count, unreadAfterSeed, 'rozet degismemeli');
  });
  check('4. real content change is broadcast as message_new upsert_type=replace', () => {
    assert.equal(newEvents('UPD_SEED_1').length, beforeEvents + 1, 'yeni yayin gelmeli');
    assert.equal(lastNew('UPD_SEED_1').upsert_type, 'replace');
  });

  // --- 5. Duplicate update (aynı içerik) yayın üretmez ---
  const dupBefore = newEvents('UPD_SEED_1').length;
  await emitUpdate({
    key: { remoteJid: PN, fromMe: false, id: 'UPD_SEED_1' },
    update: { message: { conversation: 'Guncellenmis icerik' }, messageTimestamp: base - 5 },
  });
  check('5. duplicate update (no content change) does NOT broadcast', () => {
    assert.equal(newEvents('UPD_SEED_1').length, dupBefore, 'gereksiz yayin olmamali');
  });

  // --- 6. Daha eski mesajın güncellemesi önizlemeyi ezmez ---
  // Baseline, senaryo 4'ün (en yeni mesajın içeriği) önizlemeyi meşru şekilde
  // değiştirmesinden SONRA alınır.
  const previewBeforeOld = chatOf().last_message_preview;
  const tsBeforeOld = chatOf().last_message_at;
  await emitUpdate({
    key: { remoteJid: PN, fromMe: false, id: 'UPD_SEED_2' },
    update: { message: { conversation: 'Eski icerik duzenlendi' }, messageTimestamp: base - 190 },
  });
  check('6. older timestamp update does not overwrite preview', () => {
    assert.equal(chatOf().last_message_preview, previewBeforeOld);
    assert.equal(String(chatOf().last_message_at), String(tsBeforeOld));
  });

  // --- 7. Zaman damgası eksik güncelleme sıralamayı bozmaz ---
  await emitUpdate({
    key: { remoteJid: PN, fromMe: false, id: 'UPD_SEED_2' },
    update: { message: { conversation: 'Zamansiz duzenleme' } },
  });
  check('7. missing timestamp update does not move chat to top', () => {
    assert.equal(chatOf().last_message_preview, previewBeforeOld, 'onizleme oynamamali');
    assert.equal(String(chatOf().last_message_at), String(tsBeforeOld), 'son aktivite oynamamali');
  });

  // --- 8. notify davranışı değişmedi ---
  const unreadBeforeNotify = chatOf().unread_count;
  ev.emit('messages.upsert', { messages: [mkUpsert('UPD_NOTIFY_2', 'Canli upsert', base + 50)], type: 'notify' });
  await new Promise((r) => setTimeout(r, 30));
  check('8. messages.upsert notify still increments unread and broadcasts', () => {
    assert.ok(lastNew('UPD_NOTIFY_2'), 'notify yayinlanmali');
    assert.equal(lastNew('UPD_NOTIFY_2').upsert_type, 'notify');
    assert.equal(chatOf().unread_count, unreadBeforeNotify + 1);
  });

  // --- 9. append davranışı değişmedi ---
  const unreadBeforeAppend = chatOf().unread_count;
  const previewBeforeAppend = chatOf().last_message_preview;
  ev.emit('messages.upsert', { messages: [mkUpsert('UPD_APPEND_1', 'Gecmis upsert', base - 500)], type: 'append' });
  await new Promise((r) => setTimeout(r, 30));
  check('9. messages.upsert append still does not bump unread or move preview', () => {
    assert.equal(lastNew('UPD_APPEND_1').upsert_type, 'append');
    assert.equal(chatOf().unread_count, unreadBeforeAppend);
    assert.equal(chatOf().last_message_preview, previewBeforeAppend);
  });

  // --- 10. Status ACK yolu etkilenmedi ---
  await sm._ingestUpsertMessage({
    key: { remoteJid: PN, fromMe: true, id: 'UPD_ACK_1' },
    message: { conversation: 'Giden mesaj' },
    messageTimestamp: base + 60,
  }, sock, sid, { upsertType: 'notify' });
  await emitUpdate({ key: { remoteJid: PN, fromMe: true, id: 'UPD_ACK_1' }, update: { status: 4 } });
  check('10. status ACK still routes to message_status_updated (not message_new)', () => {
    assert.ok(statusEvents('UPD_ACK_1').length >= 1, 'status olayi gelmeli');
    assert.equal(newEvents('UPD_ACK_1').length, 1, 'ACK icin ikinci message_new olmamali');
  });

  // --- 11. Revoke/delete korunur ---
  await sm._ingestUpsertMessage(mkUpsert('UPD_REVOKE_1', 'Silinecek', base + 70), sock, sid, { upsertType: 'notify' });
  const revokeEventsBefore = newEvents('UPD_REVOKE_1').length;
  await emitUpdate({
    key: { remoteJid: PN, fromMe: false, id: 'UPD_REVOKE_CHAT' },
    update: {
      message: { protocolMessage: { type: 0, key: { id: 'UPD_REVOKE_1' } } },
      messageTimestamp: base + 80,
    },
  });
  check('11. revoke marks target deleted and emits no new message', () => {
    const rec = listOf().find((m) => m.wa_message_id === 'UPD_REVOKE_1');
    assert.ok(rec);
    assert.equal(rec.is_deleted, true);
    assert.equal(rec.body, '');
    assert.equal(newEvents('UPD_REVOKE_1').length, revokeEventsBefore, 'revoke yayin uretmemeli');
  });

  // --- 12. Stale socket koruması korunur ---
  const staleBefore = newEvents('UPD_SEED_1').length;
  session.lifecycle.beginAttempt(); // mevcut generation'ı geçersiz kıl
  ev.emit('messages.update', [{
    key: { remoteJid: PN, fromMe: false, id: 'UPD_SEED_1' },
    update: { message: { conversation: 'Bayat soket' }, messageTimestamp: base + 90 },
  }]);
  await new Promise((r) => setTimeout(r, 30));
  check('12. stale socket update is ignored', () => {
    assert.equal(newEvents('UPD_SEED_1').length, staleBefore, 'bayat olay islenmemeli');
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`[test-message-update-semantics] FAILED (${failures} assertion)`);
  process.exit(1);
}
console.log('[test-message-update-semantics] All checks passed');
