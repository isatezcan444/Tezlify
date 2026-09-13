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
import { createSessionManager, classifyMessageType, hasRecognizedContent, summarizeWaMessage, resolveDownloadableMedia } from '../src/session-manager.js';

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

// Oturum kapsamli API (guvenlik duzeltmesi): her cagri hangi hatta ait
// oldugunu acikca soyler. Testler icin soketsiz bir oturum kaydi acilir.
const SID = (await sm.createSession('test-hat', { autoStart: false })).id;

const JID_A = '905321002030@s.whatsapp.net';
const JID_B = '905339998877@s.whatsapp.net';

check('Issue 1: perChatLimit keeps only the NEWEST N per chat (insertion order)', () => {
  for (let i = 0; i < 7; i += 1) {
    sm._recordOutbound(JID_A, { body: `a${i}`, wa_message_id: `wamid_a${i}`, message_type: 'TEXT', status: 'SENT' }, SID);
  }
  for (let i = 0; i < 4; i += 1) {
    sm._recordOutbound(JID_B, { body: `b${i}`, wa_message_id: `wamid_b${i}`, message_type: 'TEXT', status: 'SENT' }, SID);
  }
  const res = sm.listAllMessages(SID, { limit: 1000, offset: 0, perChatLimit: 3 });
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
  const full = sm.listAllMessages(SID, { limit: 1000, offset: 0 });
  assert.equal(full.total, 11); // 7 + 4 — perChatLimit yoksa eski davranis
  const big = sm.listAllMessages(SID, { limit: 1000, offset: 0, perChatLimit: 100 });
  assert.equal(big.total, 11); // limit > sohbet boyutu -> kesim yok
  const zero = sm.listAllMessages(SID, { limit: 1000, offset: 0, perChatLimit: 0 });
  assert.equal(zero.total, 11); // 0/negatif/NaN = devre disi (geriye uyumlu)
});

check('Issue 1: since + perChatLimit compose (delta window first, then newest N)', () => {
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const sinceEpoch = Math.floor(Date.now() / 1000) + 60; // hepsi geçmişte kalir
  // `since` gelecek zamani -> hicbir sey donmemeli; perChatLimit bunu degistirmez.
  const res = sm.listAllMessages(SID, { limit: 1000, offset: 0, since: sinceEpoch, perChatLimit: 3 });
  assert.equal(res.total, 0);
  assert.deepEqual(res.messages, []);
  // `since` 0 (epoch) -> sinir yok, perChatLimit yine sohbet basina 3 uygular.
  const res2 = sm.listAllMessages(SID, { limit: 1000, offset: 0, since: 1, perChatLimit: 3 });
  assert.equal(res2.total, 6);
  void future;
});

// ---------------------------------------------------------------------------
// Issue 4 (Render log: "Failed to store incoming media | err=No message
// present"): `downloadMediaMessage` TAM WAMessage bekler; eskiden IC medya
// dugumu gecilirdi -> `message.message` undefined -> Boom('No message present')
// -> medya HIC kaydedilmezdi. `resolveDownloadableMedia` dogru sozlesmeyi
// uygular ve indirilebilir medya yoksa `null` doner (cagri yapilmaz).
// ---------------------------------------------------------------------------

check('Issue 4: plain imageMessage resolves as downloadable media', () => {
  const r = resolveDownloadableMedia({ imageMessage: { mimetype: 'image/jpeg', url: 'https://x/y.enc' } });
  assert.ok(r, 'duz imageMessage indirilebilir olmali');
  assert.equal(r.contentType, 'imageMessage');
  assert.equal(r.media.mimetype, 'image/jpeg');
});

check('Issue 4: viewOnce wrapper is unwrapped to the inner media node', () => {
  const r = resolveDownloadableMedia({
    viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/png', url: 'https://x/z.enc' } } },
  });
  assert.ok(r, 'sarmalayici icindeki medya bulunmali');
  assert.equal(r.contentType, 'imageMessage');
  assert.equal(r.media.mimetype, 'image/png');
});

check('Issue 4: ephemeral + documentWithCaption wrappers unwrap correctly', () => {
  const eph = resolveDownloadableMedia({
    ephemeralMessage: { message: { videoMessage: { mimetype: 'video/mp4', url: 'https://x/v.enc' } } },
  });
  assert.ok(eph);
  assert.equal(eph.contentType, 'videoMessage');

  const doc = resolveDownloadableMedia({
    documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', url: 'https://x/d.enc' } } },
  });
  assert.ok(doc);
  assert.equal(doc.contentType, 'documentMessage');
});

check('Issue 4: non-media content returns null (no doomed download attempt)', () => {
  // Duz metin: `conversation` bir STRING'dir, medya dugumu degil.
  assert.equal(resolveDownloadableMedia({ conversation: 'selam' }), null);
  assert.equal(resolveDownloadableMedia({ extendedTextMessage: { text: 'alinti' } }), null);
  // Sifre cozulemeyen / govdesiz stub (pkmsg sonrasi tipik hal).
  assert.equal(resolveDownloadableMedia({ senderKeyDistributionMessage: { groupId: 'g' } }), null);
  assert.equal(resolveDownloadableMedia({ protocolMessage: { type: 0 } }), null);
  assert.equal(resolveDownloadableMedia(undefined), null);
  assert.equal(resolveDownloadableMedia({}), null);
});

check('Issue 4: location/contact are not treated as downloadable media', () => {
  assert.equal(resolveDownloadableMedia({ locationMessage: { degreesLatitude: 1 } }), null);
  assert.equal(resolveDownloadableMedia({ contactMessage: { displayName: 'A' } }), null);
});

console.log(`\nPASS: ${passed} issue-fix gateway checks`);
