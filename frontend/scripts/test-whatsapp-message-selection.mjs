/**
 * Unit & Regression test suite for WhatsApp Message Selection & Forwarding.
 * Verifies toggleSelectedMessageId, resolveSelectedMessages, formatMessagesForCopy,
 * and useChatSelectionAndForward hook lifecycle.
 *
 * Run: `node scripts/test-whatsapp-message-selection.mjs` — exit code 0 = PASS.
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

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-msg-select-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

let ok = false;
try {
  await writeFile(
    entry,
    `export {
      toggleSelectedMessageId,
      resolveSelectedMessages,
      formatMessagesForCopy
    } from '${SRC}/features/whatsapp/lib/whatsappChatSelection';
    export {
      useChatSelectionAndForward
    } from '${SRC}/features/whatsapp/hooks/useChatSelectionAndForward';`,
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
    toggleSelectedMessageId,
    resolveSelectedMessages,
    formatMessagesForCopy,
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

  console.log('--- WhatsApp Message Selection & Forwarding Regression Suite ---');

  // Test 1: toggleSelectedMessageId adds item when absent
  test('1. toggleSelectedMessageId: adds ID when absent without mutating original set', () => {
    const s1 = new Set([1, 2]);
    const s2 = toggleSelectedMessageId(s1, 3);
    assert.equal(s1.has(3), false, 'original set must not be mutated');
    assert.equal(s2.has(3), true, 'new set must contain added ID');
    assert.equal(s2.size, 3);
  });

  // Test 2: toggleSelectedMessageId removes item when already present
  test('2. toggleSelectedMessageId: removes ID when already present (toggle-off)', () => {
    const s1 = new Set([1, 2, 3]);
    const s2 = toggleSelectedMessageId(s1, 2);
    assert.equal(s1.has(2), true, 'original set unchanged');
    assert.equal(s2.has(2), false, 'ID removed from new set');
    assert.equal(s2.size, 2);
  });

  // Test 3: Supports numeric and string/optimistic IDs
  test('3. toggleSelectedMessageId: supports mixed number and string (optimistic) IDs', () => {
    let s = new Set();
    s = toggleSelectedMessageId(s, 101);
    s = toggleSelectedMessageId(s, 'optimistic_mid_abc');
    assert.equal(s.has(101), true);
    assert.equal(s.has('optimistic_mid_abc'), true);
    assert.equal(s.size, 2);

    s = toggleSelectedMessageId(s, 'optimistic_mid_abc');
    assert.equal(s.has('optimistic_mid_abc'), false);
    assert.equal(s.size, 1);
  });

  // Test 4: resolveSelectedMessages handles empty/null inputs
  test('4. resolveSelectedMessages: handles null, undefined, empty array or empty set safely', () => {
    assert.deepEqual(resolveSelectedMessages(null, new Set([1])), []);
    assert.deepEqual(resolveSelectedMessages(undefined, new Set([1])), []);
    assert.deepEqual(resolveSelectedMessages([], new Set([1])), []);
    assert.deepEqual(resolveSelectedMessages([{ id: 1 }], new Set()), []);
  });

  // Test 5: resolveSelectedMessages preserves strict chronological order of conversation
  test('5. resolveSelectedMessages: strictly preserves chronological order regardless of selection order', () => {
    const msgs = [
      { id: 10, body: 'First' },
      { id: 20, body: 'Second' },
      { id: 30, body: 'Third' },
      { id: 40, body: 'Fourth' },
    ];
    // User selected 30, then 10, then 40
    const selectedIds = new Set([30, 10, 40]);
    const resolved = resolveSelectedMessages(msgs, selectedIds);
    assert.equal(resolved.length, 3);
    assert.equal(resolved[0].id, 10, 'Earliest message must be first');
    assert.equal(resolved[1].id, 30, 'Middle message must be second');
    assert.equal(resolved[2].id, 40, 'Latest message must be third');
  });

  // Test 6: resolveSelectedMessages filters out unselected IDs and unknown IDs
  test('6. resolveSelectedMessages: ignores unknown IDs not in conversation', () => {
    const msgs = [{ id: 1, body: 'Msg 1' }, { id: 2, body: 'Msg 2' }];
    const selectedIds = new Set([1, 999, 'random_id']);
    const resolved = resolveSelectedMessages(msgs, selectedIds);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, 1);
  });

  // Test 7: formatMessagesForCopy formats plaintext bodies
  test('7. formatMessagesForCopy: formats multiple messages joined by newlines', () => {
    const msgs = [
      { id: 1, body: 'Teklif detayları:' },
      { id: 2, body: '1. Web sitesi yenileme' },
      { id: 3, body: '2. SEO optimizasyonu' },
    ];
    const text = formatMessagesForCopy(msgs);
    assert.equal(text, 'Teklif detayları:\n1. Web sitesi yenileme\n2. SEO optimizasyonu');
  });

  // Test 8: formatMessagesForCopy media caption and filename fallback
  test('8. formatMessagesForCopy: falls back to media_caption or [filename] when body is empty', () => {
    const msgs = [
      { id: 1, body: null, media_caption: 'Fatura fotoğrafı' },
      { id: 2, body: '', media_caption: null, media_filename: 'sozlesme.pdf' },
    ];
    const text = formatMessagesForCopy(msgs);
    assert.equal(text, 'Fatura fotoğrafı\n[sozlesme.pdf]');
  });

  // Test 9: formatMessagesForCopy handles empty or null lists
  test('9. formatMessagesForCopy: returns empty string on empty or null array', () => {
    assert.equal(formatMessagesForCopy([]), '');
    assert.equal(formatMessagesForCopy(null), '');
    assert.equal(formatMessagesForCopy(undefined), '');
  });

  // Test 10: formatMessagesForCopy filters out empty lines
  test('10. formatMessagesForCopy: ignores empty messages and skips blank lines', () => {
    const msgs = [
      { id: 1, body: 'Merhaba' },
      { id: 2, body: null, media_caption: null, media_filename: null },
      { id: 3, body: 'Görüşmek üzere' },
    ];
    const text = formatMessagesForCopy(msgs);
    assert.equal(text, 'Merhaba\nGörüşmek üzere');
  });

  console.log(`\nAll ${passed} WhatsApp message selection regression tests PASSED!`);
  ok = true;
} catch (err) {
  console.error('\nFAIL in Message Selection test suite:', err);
  process.exit(1);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (!ok) process.exit(1);
}
