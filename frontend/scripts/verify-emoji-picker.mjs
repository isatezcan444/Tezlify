/**
 * Verification for the chat emoji picker's data layer.
 *
 * The panel itself is a thin render over these helpers, so this is where the
 * behaviour that users notice actually lives:
 *
 *   1. search must find an emoji by its ENGLISH name;
 *   2. …and by its TURKISH name — this app is Turkish-first, and someone
 *      looking for ❤️ types "kalp", not "heart";
 *   3. results must be RANKED, or the obvious match loses to a dataset-order
 *      accident (searching "ok" used to surface 🍳 before 👌);
 *   4. "recently used" is most-recent-first, deduplicated, capped, and must not
 *      throw when storage is blocked (private mode / quota);
 *   5. picking an emoji inserts it AT THE CARET, not at the end, so a draft
 *      edited in the middle keeps its shape;
 *   6. every category tab has a label in BOTH locales — a missing key renders
 *      the raw path ("whatsapp.emojiCategoryFood") into the UI.
 *
 * Run: node scripts/verify-emoji-picker.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-emoji-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

try {
  await writeFile(
    entry,
    [
      `import * as emoji from '${SRC}/features/whatsapp/lib/emojiData';`,
      `import { tr } from '${SRC}/locales/tr';`,
      `import { en } from '${SRC}/locales/en';`,
      `export { emoji, tr, en };`,
    ].join('\n'),
    'utf8',
  );

  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: out,
    platform: 'node',
    absWorkingDir: frontendRoot,
    nodePaths: [path.join(frontendRoot, 'node_modules')],
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const { emoji, tr, en } = await import(out);
  const {
    ALL_EMOJIS, EMOJI_BY_CATEGORY, EMOJI_CATEGORIES, EMOJI_RECENTS_KEY, EMOJI_RECENTS_MAX,
    searchEmojis, loadRecentEmojis, pushRecentEmoji, insertAtCaret,
  } = emoji;

  const resolve = (dict, key) =>
    key.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), dict);

  const inMemoryStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
    };
  };

  check('search finds an emoji by its English name', () => {
    const hits = searchEmojis('heart');
    assert.ok(hits.some((e) => e.char === '❤️'), '“heart” must find the red heart');
    const pizza = searchEmojis('pizza');
    assert.equal(pizza[0]?.char, '🍕', '“pizza” must put the pizza first');
  });

  check('search finds an emoji by its Turkish name', () => {
    const hits = searchEmojis('kalp');
    assert.ok(hits.some((e) => e.char === '❤️'), '“kalp” must find the red heart');
    assert.equal(searchEmojis('teşekkür')[0]?.char, '🙏', '“teşekkür” must find folded hands');
    assert.equal(searchEmojis('araba')[0]?.char, '🚗', '“araba” must find the car');
    assert.equal(searchEmojis('bayrak')[0]?.char, '🇹🇷', '“bayrak” must lead with the Turkish flag');
  });

  check('search results are ranked, not left in dataset order', () => {
    const ok = searchEmojis('ok');
    assert.equal(ok[0]?.char, '👌', 'an exact keyword match must outrank a substring match');
    assert.ok(
      ok.findIndex((e) => e.char === '👌') < ok.findIndex((e) => e.char === '🍳'),
      'the cooking pot must not beat the OK hand',
    );
    assert.deepEqual(searchEmojis('   '), [], 'a blank query has no results');
  });

  check('every category is non-empty and duplicate-free', () => {
    for (const [id, entries] of Object.entries(EMOJI_BY_CATEGORY)) {
      assert.ok(entries.length > 0, `category ${id} must not be empty`);
      const chars = entries.map((e) => e.char);
      assert.equal(new Set(chars).size, chars.length, `category ${id} has a duplicate emoji`);
      for (const e of entries) {
        assert.ok(e.char.length > 0 && e.keywords.length > 0, `category ${id} has an incomplete row`);
      }
    }
    assert.equal(
      ALL_EMOJIS.length,
      Object.values(EMOJI_BY_CATEGORY).reduce((n, list) => n + list.length, 0),
      'the flat list must contain every category entry exactly once',
    );
  });

  check('recently used is ordered, deduplicated and capped', () => {
    const storage = inMemoryStorage();
    assert.deepEqual(loadRecentEmojis(storage), [], 'recents start empty');

    pushRecentEmoji('😀', storage);
    pushRecentEmoji('🙏', storage);
    pushRecentEmoji('😀', storage);
    assert.deepEqual(loadRecentEmojis(storage), ['😀', '🙏'], 'most recent first, no duplicates');

    for (let i = 0; i < EMOJI_RECENTS_MAX + 6; i += 1) pushRecentEmoji(`#${i}`, storage);
    assert.equal(loadRecentEmojis(storage).length, EMOJI_RECENTS_MAX, 'the list is capped');

    storage.setItem(EMOJI_RECENTS_KEY, 'not json');
    assert.deepEqual(loadRecentEmojis(storage), [], 'corrupt storage must not throw');
  });

  check('recents survive blocked storage without throwing', () => {
    const hostile = {
      getItem() { throw new Error('storage disabled'); },
      setItem() { throw new Error('storage disabled'); },
    };
    assert.deepEqual(loadRecentEmojis(hostile), [], 'a blocked read degrades to empty');
    pushRecentEmoji('😀', hostile); // must not throw
  });

  check('a picked emoji lands at the caret', () => {
    assert.deepEqual(
      insertAtCaret('merhaba', '😀', 7, 7).text, 'merhaba😀',
      'at the end appends',
    );
    const middle = insertAtCaret('merhaba dunya', '🙏 ', 8, 8);
    assert.equal(middle.text, 'merhaba 🙏 dunya', 'in the middle inserts in place');
    // Index 11, not 10: the caret is a `setSelectionRange` offset, so it counts
    // UTF-16 code units (🙏 is a surrogate pair = 2) and not visible characters.
    assert.equal(middle.caret, 11, 'the caret sits right after the inserted emoji');

    const replaced = insertAtCaret('merhaba dunya', '🙏', 8, 13);
    assert.equal(replaced.text, 'merhaba 🙏', 'a selection is replaced, not appended to');

    // A caret reported outside the string (stale DOM) must clamp, not slice out
    // of range and drop the draft.
    assert.equal(insertAtCaret('abc', '😀', 99, 99).text, 'abc😀');
    assert.equal(insertAtCaret('abc', '😀', null, null).text, 'abc😀');
  });

  check('every category tab has a label in both locales', () => {
    for (const cat of EMOJI_CATEGORIES) {
      for (const [lang, dict] of [['tr', tr], ['en', en]]) {
        const label = resolve(dict, cat.labelKey);
        assert.equal(
          typeof label, 'string',
          `${cat.labelKey} is missing from ${lang} — the raw key would render in the panel`,
        );
        assert.ok(label.length > 0, `${cat.labelKey} is empty in ${lang}`);
      }
    }
  });

  console.log(`\n${passed}/8 emoji picker checks passed`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
