// 5 kritik bug-fix regresyon testleri (Issue 1 + Issue 3, gateway tarafi).
// `node scripts/test-issue-fixes.mjs` ile calisir, exit code 0 = PASS.
//
// Issue 3 (metin -> medya sinifi): alintili/iletilmis/link-onizlemeli mesajlar
// Baileys'te `extendedTextMessage` tasir; eski parser bunu tanimayip
// `conversation` da olmadigi icin medyaya düsürüyordu (ya da stub sanip
// atliyordu). Simdi `classifyMessageType` hem `conversation` hem
// `extendedTextMessage` icin TEXT döndürür; govdesiz stub'lar (reaction/
// protocol) ise `hasRecognizedContent` ile eskiden olduğu gibi atlanır.
//
// Issue 1 (initial-sync maliyeti): `listAllMessages({ perChatLimit })` her
// sohbet icin yalnizca EN YENI N kaydi döndürür (kaydirma sirasinda lazy
// hydration ile tamamlanir). `total`/sayfalama bu sinirli kume üzerinden
// tutarli kalmalidir.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager, classifyMessageType, hasRecognizedContent, summarizeWaMessage } from '../src/session-manager.js';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// ---------------------------------------------------------------------------
// Issue 3: classifyMessageType / hasRecognizedContent / summarizeWaMessage
// ---------------------------------------------------------------------------

check('Issue 3: extendedTextMessage (reply/quote) classifies as TEXT, not media', () => {
  const quoted = classifyMessageType({
    extendedTextMessage: {
      text: 'Bakiniz',
      contextInfo: { quotedMessage: { conversation: 'orijinal' } },
    },
  });
  assert.equal(quoted, 'TEXT');
  const forwarded = classifyMessageType({
    extendedTextMessage: { text: 'iletildi', contextInfo: { isForwarded: true } },
  });
  assert.equal(forwarded, 'TEXT');
  const linkPreview = classifyMessageType({
    extendedTextMessage: {
      text: 'https://example.com',
      matchedManagedLink: { linkIndex: { startIndex: 0 } },
    },
  });
  assert.equal(linkPreview, 'TEXT');
});

check('Issue 3: plain conversation stays TEXT; real media keeps its type', () => {
  assert.equal(classifyMessageType({ conversation: 'merhaba' }), 'TEXT');
  assert.equal(classifyMessageType({ imageMessage: { caption: 'selam' } }), 'IMAGE');
  assert.equal(classifyMessageType({ videoMessage: {} }), 'VIDEO');
  assert.equal(classifyMessageType({ documentMessage: {} }), 'DOCUMENT');
  assert.equal(classifyMessageType({ audioMessage: {} }), 'AUDIO');
  assert.equal(classifyMessageType({ stickerMessage: {} }), 'STICKER');
  assert.equal(classifyMessageType({ locationMessage: {} }), 'LOCATION');
});

check('Issue 3: extendedTextMessage counts as recognized content (never skipped as stub)', () => {
  assert.equal(hasRecognizedContent({ extendedTextMessage: { text: 'x' } }), true);
  assert.equal(hasRecognizedContent({ conversation: 'x' }), true);
  // Govdesiz stub'lar (reaction/protocol/ephemeral-set) eski davranisla atlanir:
  assert.equal(hasRecognizedContent({ reactionMessage: { key: {} } }), false);
  assert.equal(hasRecognizedContent({ protocolMessage: { type: 0 } }), false);
  assert.equal(hasRecognizedContent({}), false);
});

check('Issue 3: summarizeWaMessage extracts extendedTextMessage body as TEXT', () => {
  const s = summarizeWaMessage({ message: { extendedTextMessage: { text: 'alintili yanit' } } });
  assert.equal(s.message_type, 'TEXT');
  assert.equal(s.body, 'alintili yanit');
});

// ---------------------------------------------------------------------------
// Issue 1: listAllMessages perChatLimit (en yeni N / sohbet)
// ---------------------------------------------------------------------------

const sm = createSessionManager({
  sessionsDir: path.join(os.tmpdir(), 'issue-fix-sessions'),
  mediaDir: path.join(os.tmpdir(), 'issue-fix-media'),
  aesKey: '0'.repeat(64),
  backendWsUrl: '',
});

const JID_A = '905321002030@s.whatsapp.net';
const JID_B = '905339998877@s.whatsapp.net';

check('Issue 1: perChatLimit keeps only the NEWEST N per chat (insertion order)', () => {
  for (let i = 0; i < 7; i += 1) {
    sm._recordOutbound(JID_A, { body: `a${i}`, wa_message_id: `wamid_a${i}`, message_type: 'TEXT', status: 'SENT' });
  }
  for (let i = 0; i < 4; i += 1) {
    sm._recordOutbound(JID_B, { body: `b${i}`, wa_message_id: `wamid_b${i}`, message_type: 'TEXT', status: 'SENT' });
  }
  const res = sm.listAllMessages({ limit: 1000, offset: 0, perChatLimit: 3 });
  // A'dan en yeni 3 (a4,a5,a6), B'den en yeni 3 (b1,b2,b3) — toplam 6.
  assert.equal(res.total, 6);
  const ids = res.messages.map((m) => m.wa_message_id).sort();
  assert.deepEqual(ids, ['wamid_a4', 'wamid_a5', 'wamid_a6', 'wamid_b1', 'wamid_b2', 'wamid_b3']);
  // Kronolojik akis korunuyor: id (ms) sirali sayfa.
  const idNums = res.messages.map((m) => m.id);
  const sorted = [...idNums].sort((x, y) => x - y);
  assert.deepEqual(idNums, sorted);
});

check('Issue 1: chats at/below the limit pass through untouched; null limit = full history', () => {
  const full = sm.listAllMessages({ limit: 1000, offset: 0 });
  assert.equal(full.total, 11); // 7 + 4 — perChatLimit yoksa eski davranis
  const big = sm.listAllMessages({ limit: 1000, offset: 0, perChatLimit: 100 });
  assert.equal(big.total, 11); // limit > sohbet boyutu -> kesim yok
  const zero = sm.listAllMessages({ limit: 1000, offset: 0, perChatLimit: 0 });
  assert.equal(zero.total, 11); // 0/negatif/NaN = devre disi (geriye uyumlu)
});

check('Issue 1: since + perChatLimit compose (delta window first, then newest N)', () => {
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const sinceEpoch = Math.floor(Date.now() / 1000) + 60; // hepsi geçmişte kalir
  // `since` gelecek zamani -> hicbir sey donmemeli; perChatLimit bunu degistirmez.
  const res = sm.listAllMessages({ limit: 1000, offset: 0, since: sinceEpoch, perChatLimit: 3 });
  assert.equal(res.total, 0);
  assert.deepEqual(res.messages, []);
  // `since` 0 (epoch) -> sinir yok, perChatLimit yine sohbet basina 3 uygular.
  const res2 = sm.listAllMessages({ limit: 1000, offset: 0, since: 1, perChatLimit: 3 });
  assert.equal(res2.total, 6);
  void future;
});

console.log(`\nPASS: ${passed} issue-fix gateway checks`);
