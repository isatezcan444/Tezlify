/**
 * Unit & Regression test suite for WhatsApp in-thread search.
 * Verifies filterMatchingMessageIds, resolveActiveSearchMessageId,
 * getNextSearchMatchIndex, and getPrevSearchMatchIndex.
 *
 * Run: `node scripts/test-whatsapp-chat-search.mjs` — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-chat-search-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  `export {
    filterMatchingMessageIds,
    resolveActiveSearchMessageId,
    getNextSearchMatchIndex,
    getPrevSearchMatchIndex
  } from '${SRC}/features/whatsapp/lib/whatsappChatSearch';`,
  'utf8'
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile: out,
  platform: 'node',
  target: 'node20',
});

const {
  filterMatchingMessageIds,
  resolveActiveSearchMessageId,
  getNextSearchMatchIndex,
  getPrevSearchMatchIndex,
} = await import(out);

let passed = 0;
const test = (label, fn) => {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    throw err;
  }
};

console.log('--- WhatsApp In-Thread Search Regression Suite ---');

const sampleMessages = [
  { id: 101, body: 'Merhaba nasılsınız?', media_caption: null, media_filename: null },
  { id: 102, body: 'Toplantı notları ektedir.', media_caption: 'Fatura özeti', media_filename: null },
  { id: 103, body: null, media_caption: null, media_filename: 'teklif_dokumani.pdf' },
  { id: 104, body: 'İyi günler dilerim, teklif hazır.', media_caption: null, media_filename: null },
  { id: 105, body: 'Merhaba tekrar, kontrol ettiniz mi?', media_caption: null, media_filename: null },
];

// Scenario 1: Eşleşen sonuçların doğru indisleri
test('1. filterMatchingMessageIds: returns correct IDs in collection order', () => {
  const matches = filterMatchingMessageIds(sampleMessages, 'teklif');
  assert.deepEqual(matches, [103, 104]);
});

// Scenario 2: Hiç eşleşme olmaması
test('2. filterMatchingMessageIds: returns empty array when no matches found', () => {
  const matches = filterMatchingMessageIds(sampleMessages, 'bilinmeyen_kelime_xyz');
  assert.deepEqual(matches, []);
  assert.equal(resolveActiveSearchMessageId(matches, 0), null);
});

// Scenario 3: Boş sorgu
test('3. filterMatchingMessageIds: returns empty array for empty, whitespace, null query', () => {
  assert.deepEqual(filterMatchingMessageIds(sampleMessages, ''), []);
  assert.deepEqual(filterMatchingMessageIds(sampleMessages, '   '), []);
  assert.deepEqual(filterMatchingMessageIds(sampleMessages, null), []);
  assert.deepEqual(filterMatchingMessageIds(sampleMessages, undefined), []);
  assert.deepEqual(filterMatchingMessageIds([], 'merhaba'), []);
  assert.deepEqual(filterMatchingMessageIds(null, 'merhaba'), []);
});

// Scenario 4: Büyük/küçük harf davranışı
test('4. filterMatchingMessageIds: case-insensitive matching across uppercase/lowercase queries', () => {
  const lowerMatches = filterMatchingMessageIds(sampleMessages, 'merhaba');
  const upperMatches = filterMatchingMessageIds(sampleMessages, 'MERHABA');
  const mixedMatches = filterMatchingMessageIds(sampleMessages, 'MerHaBa');
  assert.deepEqual(lowerMatches, [101, 105]);
  assert.deepEqual(upperMatches, [101, 105]);
  assert.deepEqual(mixedMatches, [101, 105]);
});

// Scenario 5: Eşleşme alanları (body, media_caption, media_filename)
test('5. filterMatchingMessageIds: matches body, caption, or filename correctly', () => {
  // Matches caption
  const captionMatches = filterMatchingMessageIds(sampleMessages, 'fatura');
  assert.deepEqual(captionMatches, [102]);

  // Matches filename
  const filenameMatches = filterMatchingMessageIds(sampleMessages, 'pdf');
  assert.deepEqual(filenameMatches, [103]);

  // Matches body
  const bodyMatches = filterMatchingMessageIds(sampleMessages, 'toplantı');
  assert.deepEqual(bodyMatches, [102]);
});

// Scenario 6: Birden fazla eşleşme ve sonuçlar arasında dairesel gezinme
test('6. getNextSearchMatchIndex and getPrevSearchMatchIndex: circular wrap-around', () => {
  const total = 3;
  // Next
  assert.equal(getNextSearchMatchIndex(total, 0), 1);
  assert.equal(getNextSearchMatchIndex(total, 1), 2);
  assert.equal(getNextSearchMatchIndex(total, 2), 0); // wrap to start

  // Prev
  assert.equal(getPrevSearchMatchIndex(total, 0), 2); // wrap to end
  assert.equal(getPrevSearchMatchIndex(total, 2), 1);
  assert.equal(getPrevSearchMatchIndex(total, 1), 0);
});

// Scenario 7: Sınır durumları: 0 veya 1 eşleşme varken gezinme
test('7. getNext/PrevSearchMatchIndex: boundary condition with <= 1 matches returns unchanged index', () => {
  assert.equal(getNextSearchMatchIndex(1, 0), 0);
  assert.equal(getPrevSearchMatchIndex(1, 0), 0);
  assert.equal(getNextSearchMatchIndex(0, 0), 0);
  assert.equal(getPrevSearchMatchIndex(0, 0), 0);
});

// Scenario 8: Mesaj listesinin değişmesi veya daralması (out-of-bounds fallback)
test('8. resolveActiveSearchMessageId: falls back to matchingIds[0] if index is out of bounds', () => {
  const matches = [101, 102];
  assert.equal(resolveActiveSearchMessageId(matches, 0), 101);
  assert.equal(resolveActiveSearchMessageId(matches, 1), 102);
  // Index 5 was previously held, but new search only has 2 items -> fallback to first match
  assert.equal(resolveActiveSearchMessageId(matches, 5), 101);
});

// Scenario 9: Tek bir eşleşmenin aktif sonuç olarak seçilmesi
test('9. resolveActiveSearchMessageId: resolves single match at index 0', () => {
  const single = [200];
  assert.equal(resolveActiveSearchMessageId(single, 0), 200);
});

// Scenario 10: Yinelenen mesaj içerikleri
test('10. filterMatchingMessageIds: duplicate message bodies return distinct sequential IDs', () => {
  const duplicates = [
    { id: 1, body: 'Tekrar mesajı', media_caption: null, media_filename: null },
    { id: 2, body: 'Farklı mesaj', media_caption: null, media_filename: null },
    { id: 3, body: 'Tekrar mesajı', media_caption: null, media_filename: null },
  ];
  const matches = filterMatchingMessageIds(duplicates, 'tekrar');
  assert.deepEqual(matches, [1, 3]);
});

// Scenario 11: Türkçe karakter davranışı (.toLowerCase uyumu)
test('11. filterMatchingMessageIds: preserves Turkish character lowercase compatibility', () => {
  const turkishMsgs = [
    { id: 301, body: 'Şirket analizi', media_caption: null, media_filename: null },
    { id: 302, body: 'Örnek raporlama', media_caption: null, media_filename: null },
    { id: 303, body: 'Çözüm ortakları', media_caption: null, media_filename: null },
    { id: 304, body: 'Doğru ve dürüst', media_caption: null, media_filename: null },
  ];
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'şirket'), [301]);
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'ŞİRKET'), []); // Standard JS toLowerCase behavior: 'İ'.toLowerCase() != 'i'
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'analizi'), [301]);
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'çözüm'), [303]);
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'ÇÖZÜM'), [303]);
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'örnek'), [302]);
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'ÖRNEK'), [302]);
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'doğru'), [304]);
  assert.deepEqual(filterMatchingMessageIds(turkishMsgs, 'DOĞRU'), [304]);
});

// Scenario 12: Boş ve tanımsız alanlar toleransı
test('12. filterMatchingMessageIds: handles completely empty message objects gracefully', () => {
  const emptyMsgs = [
    { id: 401 },
    { id: 402, body: '' },
    { id: 403, body: 'Hedef bulundu' },
  ];
  assert.deepEqual(filterMatchingMessageIds(emptyMsgs, 'hedef'), [403]);
});

console.log(`\nAll ${passed} WhatsApp in-thread search tests PASSED!`);
