/**
 * Metinsiz sistem mesajlari (arama / ifade / silinmis mesaj / grup bildirimi) —
 * onizleme ve siralama regresyonu.
 *
 * WhatsApp Web'de bir sohbetin son mesaji bir ARAMA KAYDI, bir IFADE, "Bu
 * mesaji sildiniz", "X gruba eklendi", "... ayarlarini degistirdiniz" veya
 * "kullanici adini olusturdu" gibi bir sistem bildirimi olabilir. Bu mesajlar
 * METIN TASIMAZ: `classifyMessageType` onlari 'TEXT'e dusurur ve govdeleri
 * bostur, dolayisiyla `normalizePreviewText('TEXT','')` BOS doner.
 *
 * Bos onizleme kozmetik bir eksik degildi. Backend `last_message_at`
 * guncellemesini onizleme dolu mu diye kapiladigi icin bu sohbetlerin SIRALAMA
 * damgasi da ilerlemiyordu; `NULLS LAST` ile listenin dibine dusuyorlardi.
 *
 * Canli olcum 2026-09-26 (113 sohbet):
 *   - 21 sohbetin onizlemesi bos
 *   - 5 sohbetin aktivite damgasi hic yok
 *   - "Hat 1" 09:35:56'da kilitli kaldi, en yeni mesaji 09:44:25
 *
 * Bu test isaret uretimini (`systemContentMarker`), isaret -> etiket cevirisini
 * (`normalizePreviewText`) ve canli yolun onizleme ifadesini kilitler.
 */
import assert from 'node:assert/strict';
import { summarizeWaMessage, systemContentMarker } from '../src/messages/message-classifier.js';
import {
  normalizePreviewText,
  buildChatPreview,
  TYPE_PREVIEW_LABELS,
} from '../src/utils/whatsapp-formatting.js';

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  console.log(`ok - ${name}`);
}

// Kullanicinin saydigi turlerin tamami.
const SYSTEM_KINDS = [
  ['A. protocolMessage REVOKE -> [REVOKED]', { message: { protocolMessage: { type: 0 } } }, '[REVOKED]'],
  ['B. protocolMessage diger -> [SYSTEM]', { message: { protocolMessage: { type: 14 } } }, '[SYSTEM]'],
  ['C. reactionMessage -> [REACTION]', { message: { reactionMessage: { key: {}, text: '❤️' } } }, '[REACTION]'],
  ['D. call -> [CALL]', { message: { call: { callKey: 'x' } } }, '[CALL]'],
  ['E. callLogMessage -> [CALL]', { message: { callLogMessage: { isVideo: true } } }, '[CALL]'],
  ['F. pollCreationMessage -> [POLL]', { message: { pollCreationMessage: { name: 'q' } } }, '[POLL]'],
  ['G. pollUpdateMessage -> [POLL]', { message: { pollUpdateMessage: {} } }, '[POLL]'],
  ['H. eventMessage -> [EVENT]', { message: { eventMessage: {} } }, '[EVENT]'],
];

for (const [name, waMsg, expected] of SYSTEM_KINDS) {
  check(name, () => {
    assert.equal(systemContentMarker(waMsg), expected);
    // Ve isaret gercekten okunabilir bir etikete cevrilmeli.
    const label = normalizePreviewText('TEXT', expected);
    assert.equal(label, TYPE_PREVIEW_LABELS[expected.slice(1, -1)]);
    assert.notEqual(label, '', 'isaret bos etikete dusmemeli');
  });
}

// --- I. Grup bildirimleri tur WRAPPER'daki `messageStubType` alanindadir ---
check('I. messageStubType > 0 (grup ayari / eklendi / kullanici adi) -> [SYSTEM]', () => {
  // "Bu grubun ayarlarini ... degistirdiniz.", "Muktedir kisilere eklendi",
  // "Barkin Semruk, @barkinirgen kullanici adini olusturdu."
  assert.equal(systemContentMarker({ message: {}, messageStubType: 1 }), '[SYSTEM]');
  assert.equal(systemContentMarker({ message: {}, messageStubType: 32 }), '[SYSTEM]');
  // long.js / protobufjs Long sarmalayicisi da kabul edilmeli.
  assert.equal(systemContentMarker({ message: {}, messageStubType: { toNumber: () => 7 } }), '[SYSTEM]');
});

// --- J. 0 = UNKNOWN, yani stub DEGIL; sahte isaret uretmemeli ---
check('J. messageStubType 0 / eksik / metinli mesaj -> isaret YOK', () => {
  assert.equal(systemContentMarker({ message: {}, messageStubType: 0 }), null);
  assert.equal(systemContentMarker({ message: {}, messageStubType: undefined }), null);
  assert.equal(systemContentMarker({ message: { conversation: 'selam' } }), null);
  assert.equal(systemContentMarker(undefined), null);
  assert.equal(systemContentMarker({}), null);
  // senderKeyDistributionMessage tek basina bir sistem bildirimi degildir.
  assert.equal(systemContentMarker({ message: { senderKeyDistributionMessage: { groupId: 'g' } } }), null);
});

// --- K. summarizeWaMessage: metin ve medya davranisi DEGISMEZ ---
check('K. summarizeWaMessage metin/medya davranisini korur', () => {
  assert.deepEqual(
    summarizeWaMessage({ message: { conversation: 'Merhaba' } }),
    { message_type: 'TEXT', body: 'Merhaba' },
  );
  assert.deepEqual(
    summarizeWaMessage({ message: { imageMessage: { caption: 'Manzara' } } }),
    { message_type: 'IMAGE', body: 'Manzara' },
  );
  // Medya: govde bos kalir, etiketi normalizePreviewText tip uzerinden uretir.
  assert.deepEqual(
    summarizeWaMessage({ message: { audioMessage: {} } }),
    { message_type: 'AUDIO', body: '' },
  );
  assert.deepEqual(
    summarizeWaMessage({ message: { extendedTextMessage: { text: 'alintili' } } }),
    { message_type: 'TEXT', body: 'alintili' },
  );
});

// --- L. summarizeWaMessage metinsiz sistem turleri icin isaret tasir ---
check('L. summarizeWaMessage metinsiz sistem turleri icin isaret tasir', () => {
  assert.equal(summarizeWaMessage({ message: { reactionMessage: { key: {} } } }).body, '[REACTION]');
  assert.equal(summarizeWaMessage({ message: { call: {} } }).body, '[CALL]');
  assert.equal(summarizeWaMessage({ message: { protocolMessage: { type: 0 } } }).body, '[REVOKED]');
  assert.equal(summarizeWaMessage({ message: {}, messageStubType: 4 }).body, '[SYSTEM]');
  // message_type DEGISMEZ: DB enum'unda SYSTEM/REACTION yok.
  assert.equal(summarizeWaMessage({ message: { reactionMessage: { key: {} } } }).message_type, 'TEXT');
});

// --- M. Canli yolun onizleme ifadesi (session-manager `_ingestUpsertMessage`) ---
check('M. canli yol metinsiz sistem mesajinda BOS OLMAYAN onizleme uretir', () => {
  // `_ingestUpsertMessage` kaydi: metinsiz sistem turleri 'TEXT' + body '' gelir.
  const record = { message_type: 'TEXT', body: '', direction: 'INBOUND', participant_name: null };
  const previewFor = (waMsg) =>
    buildChatPreview(record, false) || normalizePreviewText('TEXT', systemContentMarker(waMsg) || '');

  assert.equal(previewFor({ message: { call: {} } }), '📞 Arama');
  assert.equal(previewFor({ message: { reactionMessage: { key: {} } } }), '❤️ İfade');
  assert.equal(previewFor({ message: { protocolMessage: { type: 0 } } }), 'Silinmiş mesaj');
  assert.equal(previewFor({ message: {}, messageStubType: 1 }), 'Sistem mesajı');
  // Metinsiz ve sistem OLMAYAN bir mesaj yine bos kalir (uydurma yok).
  assert.equal(previewFor({ message: {} }), '');
});

// --- N. Her isaret icin etiket tablosunda kayit olmali ---
check('N. tum isaretlerin etiket karsiligi var (sessiz "Mesaj" dususu yok)', () => {
  for (const marker of ['CALL', 'REACTION', 'REVOKED', 'SYSTEM', 'POLL', 'EVENT']) {
    const label = normalizePreviewText('TEXT', `[${marker}]`);
    assert.ok(label, `${marker} etiketi eksik`);
    assert.notEqual(label, 'Mesaj', `${marker} genel "Mesaj" etiketine dusuyor`);
  }
});

console.log(`\nSystem-content preview verification: PASS (${checks.length} checks)`);
