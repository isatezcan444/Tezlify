// Faz 10 (P2): gateway birim testleri — son mesaj özeti kuralları.
// `node scripts/test-faz10-preview.mjs` ile çalışır, exit code 0 = PASS.
import assert from 'node:assert/strict';
import {
  normalizePreviewText,
  buildChatPreview,
  isPhoneLikeName,
  summarizeWaMessage,
} from '../src/session-manager.js';
import { createSessionManager } from '../src/session-manager.js';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// --- Tip normalizasyonu: medyada etiket, metinde gövde, '[IMAGE]' sızmez ---

check('normalizePreviewText: text body wins', () => {
  assert.equal(normalizePreviewText('TEXT', 'Görüşürüz'), 'Görüşürüz');
});

check('normalizePreviewText: media types -> labels', () => {
  assert.equal(normalizePreviewText('IMAGE', ''), '📷 Fotoğraf');
  assert.equal(normalizePreviewText('VIDEO', ''), '🎥 Video');
  assert.equal(normalizePreviewText('AUDIO', ''), '🎵 Sesli mesaj');
  assert.equal(normalizePreviewText('STICKER', ''), 'Sticker');
  assert.equal(normalizePreviewText('DOCUMENT', ''), '📄 Dosya');
});

check('normalizePreviewText: legacy bracket values normalized (no [IMAGE] leak)', () => {
  assert.equal(normalizePreviewText('TEXT', '[IMAGE]'), '📷 Fotoğraf');
  assert.equal(normalizePreviewText('IMAGE', '[IMAGE]'), '📷 Fotoğraf');
  assert.equal(normalizePreviewText('TEXT', '[object Object]'), 'Mesaj');
  assert.equal(normalizePreviewText('TEXT', '[Medya]'), 'Mesaj');
});

check('normalizePreviewText: empty text -> empty (never fake preview)', () => {
  assert.equal(normalizePreviewText('TEXT', ''), '');
  assert.equal(normalizePreviewText(null, null), '');
});

check('normalizePreviewText: media WITH caption keeps caption', () => {
  assert.equal(normalizePreviewText('IMAGE', 'Kedi fotosu'), 'Kedi fotosu');
});

// --- Grup gönderen ön eki: "Ahmet: ..." / ham JID veya telefon ASLA ---

check('buildChatPreview: group inbound with resolved name -> prefix', () => {
  assert.equal(
    buildChatPreview({ message_type: 'TEXT', body: 'Toplantıyı yarına aldık.', participant_name: 'Ahmet', direction: 'INBOUND' }, true),
    'Ahmet: Toplantıyı yarına aldık.',
  );
});

check('buildChatPreview: group inbound raw-JID participant -> plain body', () => {
  assert.equal(
    buildChatPreview({ message_type: 'TEXT', body: 'Selam', participant_name: '905321002030@s.whatsapp.net', direction: 'INBOUND' }, true),
    'Selam',
  );
  assert.equal(
    buildChatPreview({ message_type: 'TEXT', body: 'Selam', participant_name: 'jid:120363012345678901@g.us', direction: 'INBOUND' }, true),
    'Selam',
  );
});

check('buildChatPreview: group inbound phone-like name -> plain body', () => {
  assert.equal(
    buildChatPreview({ message_type: 'TEXT', body: 'Selam', participant_name: '+90 532 100 20 30', direction: 'INBOUND' }, true),
    'Selam',
  );
});

check('buildChatPreview: outbound group -> no prefix; 1:1 -> no prefix', () => {
  assert.equal(
    buildChatPreview({ message_type: 'TEXT', body: 'Tamamdır', participant_name: 'Ahmet', direction: 'OUTBOUND' }, true),
    'Tamamdır',
  );
  assert.equal(
    buildChatPreview({ message_type: 'TEXT', body: 'Tamamdır', sender_name: 'Ayşe', direction: 'INBOUND' }, false),
    'Tamamdır',
  );
});

check('buildChatPreview: group media from Ahmet -> "Ahmet: 📷 Fotoğraf"', () => {
  assert.equal(
    buildChatPreview({ message_type: 'IMAGE', body: '', participant_name: 'Ahmet', direction: 'INBOUND' }, true),
    'Ahmet: 📷 Fotoğraf',
  );
});

check('isPhoneLikeName guards', () => {
  assert.equal(isPhoneLikeName('+905321002030'), true);
  assert.equal(isPhoneLikeName('90 532 100 20 30'), true);
  assert.equal(isPhoneLikeName('Ahmet Yılmaz'), false);
});

// --- summarizeWaMessage: Baileys WAMessage -> {type, body} ---

check('summarizeWaMessage maps conversation/image/audio', () => {
  assert.deepEqual(summarizeWaMessage({ message: { conversation: 'Merhaba' } }), { message_type: 'TEXT', body: 'Merhaba' });
  assert.deepEqual(summarizeWaMessage({ message: { imageMessage: { caption: 'Manzara' } } }), { message_type: 'IMAGE', body: 'Manzara' });
  assert.deepEqual(summarizeWaMessage({ message: { audioMessage: {} } }), { message_type: 'AUDIO', body: '' });
});

// --- _touchChat: zaman-damgali kural (daha eski, yeniyi ezemez) ---

const sm = createSessionManager({
  sessionsDir: path.join(os.tmpdir(), 'faz10-test-sessions'),
  mediaDir: path.join(os.tmpdir(), 'faz10-test-media'),
  aesKey: '0'.repeat(64),
  backendWsUrl: '',
});

const findChat = (jid) => sm.listConversations().items.find((c) => c.jid === jid);

check('_touchChat: newer preview overwrites; older does not (retry-safe)', () => {
  const jid = '120363012345678901@g.us';
  sm._touchChat(jid, 'Ahmet: 18:25 mesajı', '2026-02-10T18:25:00.000Z');
  assert.equal(findChat(jid).last_message_preview, 'Ahmet: 18:25 mesajı');
  // daha eski zaman damgalı tekrar (duplicate/retry) -> ezmez
  sm._touchChat(jid, 'Eski mesaj', '2026-02-10T18:20:00.000Z');
  assert.equal(findChat(jid).last_message_preview, 'Ahmet: 18:25 mesajı');
  assert.equal(findChat(jid).last_message_at, '2026-02-10T18:25:00.000Z');
  // daha yeni -> yazar
  sm._touchChat(jid, 'Görüşürüz', '2026-02-10T18:31:00.000Z');
  assert.equal(findChat(jid).last_message_preview, 'Görüşürüz');
  assert.equal(findChat(jid).last_message_at, '2026-02-10T18:31:00.000Z');
});

check('_touchChat: empty preview never erases existing summary', () => {
  const jid = '905321002030@s.whatsapp.net';
  sm._touchChat(jid, 'İlk özet', '2026-02-10T10:00:00.000Z');
  sm._touchChat(jid, '', '2026-02-10T11:00:00.000Z');
  assert.equal(findChat(jid).last_message_preview, 'İlk özet');
});

console.log(`\nFaz 10 gateway preview tests: ${passed} passed.`);
