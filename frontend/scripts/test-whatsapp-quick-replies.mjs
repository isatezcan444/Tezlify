/**
 * Unit & Regression test suite for WhatsApp Quick Replies (Hızlı Yanıtlar).
 * Verifies normalizeQuickReplyQuery, matchesQuickReply, filterQuickReplies,
 * extractQuickReplyCategories, resolveQuickReplyVariables, and renderQuickReplyContent.
 *
 * Run: `node scripts/test-whatsapp-quick-replies.mjs` — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-qr-test-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

let ok = false;
try {
  await writeFile(
    entry,
    `export {
      normalizeQuickReplyQuery,
      matchesQuickReply,
      filterQuickReplies,
      extractQuickReplyCategories,
      resolveQuickReplyVariables,
      renderQuickReplyContent
    } from '${SRC}/features/whatsapp/lib/whatsappQuickReplies';
    export {
      useQuickReplyComposer,
      useQuickReplySelection
    } from '${SRC}/features/whatsapp/hooks/useQuickReplies';`,
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
    normalizeQuickReplyQuery,
    matchesQuickReply,
    filterQuickReplies,
    extractQuickReplyCategories,
    resolveQuickReplyVariables,
    renderQuickReplyContent,
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

  console.log('--- WhatsApp Quick Reply Regression Test Suite ---');

  // Sample data fixtures
  const sampleQrs = [
    {
      id: 1,
      shortcut: '/merhaba',
      title: 'Genel Selamlama',
      content: 'Merhaba {isim}, size nasıl yardımcı olabilirim?',
      category: 'GENEL',
      variables: null,
    },
    {
      id: 2,
      shortcut: '/fiyat',
      title: 'Fiyat Teklifi',
      content: 'Sayın {musteri}, {hizmet} paketimizin güncel fiyatı {tutar} TL dir.',
      category: 'SATIŞ',
      variables: [
        { key: 'musteri', label: 'Müşteri Adı', default_from: 'lead_name' },
        { key: 'hizmet', label: 'Hizmet Türü', default_value: 'Standart' },
        { key: 'tutar', label: 'Tutar', default_value: '5000' },
      ],
    },
    {
      id: 3,
      shortcut: '/randevu',
      title: 'Randevu Onayı',
      content: 'Randevunuz {tarih} saat {saat} için oluşturulmuştur.',
      category: 'DESTEK',
      variables: [
        { key: 'tarih', label: 'Tarih', default_value: 'Yarın' },
        { key: 'saat', label: 'Saat', default_value: '14:00' },
      ],
    },
    {
      id: 4,
      shortcut: '/tesekkur',
      title: 'İşlem Teşekkürü',
      content: 'Bizi tercih ettiğiniz için teşekkür ederiz.',
      category: 'GENEL',
      variables: [],
    },
  ];

  // 1. normalizeQuickReplyQuery
  test('1. normalizeQuickReplyQuery: trims whitespace and lowercases with Turkish support', () => {
    assert.equal(normalizeQuickReplyQuery('  MERHABA  '), 'merhaba');
    assert.equal(normalizeQuickReplyQuery('İSTANBUL'), 'istanbul');
    assert.equal(normalizeQuickReplyQuery('IŞIK'), 'ışık');
    assert.equal(normalizeQuickReplyQuery(''), '');
    assert.equal(normalizeQuickReplyQuery(null), '');
    assert.equal(normalizeQuickReplyQuery(undefined), '');
  });

  // 2. matchesQuickReply
  test('2. matchesQuickReply: matches across title, shortcut, and content', () => {
    const qr = sampleQrs[0]; // shortcut: /merhaba, title: Genel Selamlama, content: Merhaba {isim}...
    assert.equal(matchesQuickReply(qr, 'merhaba'), true);
    assert.equal(matchesQuickReply(qr, '/merhaba'), true);
    assert.equal(matchesQuickReply(qr, 'selamlama'), true);
    assert.equal(matchesQuickReply(qr, 'yardımcı'), true);
    assert.equal(matchesQuickReply(qr, 'olmayanKelime'), false);
  });

  // 3. Category filtering
  test('3. matchesQuickReply: filters by category correctly', () => {
    const qrSatis = sampleQrs[1]; // SATIŞ
    assert.equal(matchesQuickReply(qrSatis, '', 'ALL'), true);
    assert.equal(matchesQuickReply(qrSatis, '', 'SATIŞ'), true);
    assert.equal(matchesQuickReply(qrSatis, '', 'satış'), true);
    assert.equal(matchesQuickReply(qrSatis, '', 'DESTEK'), false);
    assert.equal(matchesQuickReply(qrSatis, '', 'GENEL'), false);
  });

  // 4. filterQuickReplies: empty query returns all items in category
  test('4. filterQuickReplies: empty query returns all items in category preserving order', () => {
    const all = filterQuickReplies(sampleQrs, '');
    assert.equal(all.length, 4);
    assert.deepEqual(all.map((q) => q.id), [1, 2, 3, 4]);

    const genel = filterQuickReplies(sampleQrs, '', 'GENEL');
    assert.equal(genel.length, 2);
    assert.deepEqual(genel.map((q) => q.id), [1, 4]);
  });

  // 5. filterQuickReplies: searches query within category
  test('5. filterQuickReplies: searches query within filtered category', () => {
    const res = filterQuickReplies(sampleQrs, 'teşekkür', 'GENEL');
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 4);

    const wrongCat = filterQuickReplies(sampleQrs, 'teşekkür', 'SATIŞ');
    assert.equal(wrongCat.length, 0);
  });

  // 6. filterQuickReplies: handles empty list and undefined parameters
  test('6. filterQuickReplies: handles empty, null or undefined input gracefully', () => {
    assert.deepEqual(filterQuickReplies([], 'test'), []);
    assert.deepEqual(filterQuickReplies(null, 'test'), []);
    assert.deepEqual(filterQuickReplies(undefined, 'test'), []);
    assert.deepEqual(filterQuickReplies(sampleQrs, 'nonexistent_query_xyz'), []);
  });

  // 7. extractQuickReplyCategories
  test('7. extractQuickReplyCategories: extracts unique categories', () => {
    const cats = extractQuickReplyCategories(sampleQrs);
    assert.ok(cats.includes('GENEL'));
    assert.ok(cats.includes('SATIŞ'));
    assert.ok(cats.includes('DESTEK'));
    assert.equal(cats.length, 3);
  });

  // 8. resolveQuickReplyVariables: default from lead_name
  test('8. resolveQuickReplyVariables: populates variables with defaults and lead_name', () => {
    const varsWithLead = resolveQuickReplyVariables(sampleQrs[1], 'Ahmet Yılmaz');
    assert.equal(varsWithLead['musteri'], 'Ahmet Yılmaz');
    assert.equal(varsWithLead['hizmet'], 'Standart');
    assert.equal(varsWithLead['tutar'], '5000');

    // Default {isim} when variables is null
    const varsDefault = resolveQuickReplyVariables(sampleQrs[0], 'Zeynep Kaya');
    assert.equal(varsDefault['isim'], 'Zeynep Kaya');

    // When leadName is empty
    const varsNoLead = resolveQuickReplyVariables(sampleQrs[0], '');
    assert.equal(varsNoLead['isim'], '');
  });

  // 9. renderQuickReplyContent: substitutes custom variables
  test('9. renderQuickReplyContent: correctly interpolates custom variables', () => {
    const rendered = renderQuickReplyContent(
      sampleQrs[1],
      { musteri: 'Mehmet Öz', hizmet: 'Premium', tutar: '7500' },
      'Mehmet Öz'
    );
    assert.equal(rendered, 'Sayın Mehmet Öz, Premium paketimizin güncel fiyatı 7500 TL dir.');
  });

  // 10. renderQuickReplyContent: substitutes default {isim} placeholder
  test('10. renderQuickReplyContent: correctly interpolates default {isim} placeholder', () => {
    const rendered = renderQuickReplyContent(sampleQrs[0], {}, 'Ayşe Demir');
    assert.equal(rendered, 'Merhaba Ayşe Demir, size nasıl yardımcı olabilirim?');
  });

  // 11. renderQuickReplyContent: handles special characters without crashing RegExp
  test('11. renderQuickReplyContent: escapes special regex characters in variable keys', () => {
    const qrSpecial = {
      id: 99,
      shortcut: '/test',
      title: 'Regex Test',
      content: 'Deger: {param.test$} ve {val[1]}',
      category: 'TEST',
      variables: [
        { key: 'param.test$', label: 'Param', default_value: 'OK1' },
        { key: 'val[1]', label: 'Val', default_value: 'OK2' },
      ],
    };
    const rendered = renderQuickReplyContent(qrSpecial, { 'param.test$': '123', 'val[1]': '456' });
    assert.equal(rendered, 'Deger: 123 ve 456');
  });

  // 12. renderQuickReplyContent: handles null or empty content
  test('12. renderQuickReplyContent: handles null or empty QR safely', () => {
    assert.equal(renderQuickReplyContent(null), '');
    assert.equal(renderQuickReplyContent({ content: '' }), '');
  });

  console.log(`\nAll ${passed} WhatsApp quick reply regression tests PASSED!`);
  ok = true;
} catch (err) {
  console.error('\nFAIL in WhatsApp Quick Reply test suite:', err);
  process.exit(1);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (!ok) process.exit(1);
}
