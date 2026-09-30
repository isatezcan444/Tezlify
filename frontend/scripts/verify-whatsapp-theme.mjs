/**
 * Regression test: the WhatsApp loading surfaces must follow the app theme.
 *
 * The sync gate — the full-pane "Mesajlar yükleniyor" screen — was painted
 * with WhatsApp Web's fixed dark palette (#111b21 background, #8696a0 muted
 * text, #202c33 track) and had no `dark:` variant at all, so it stayed dark in
 * light mode and never changed when the user switched themes. It now uses the
 * project's own tokens.
 *
 * WhatsApp's brand green (#00a884) is deliberately exempt: it is the product
 * colour, not a surface, and must look identical in both themes.
 *
 * Run: node scripts/verify-whatsapp-theme.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok - ${label}`); };

/** Colour literals that are allowed without a dark: variant. */
const BRAND_OK = ['00a884'];

const read = (rel) => readFile(path.join(SRC, rel), 'utf8');

/**
 * Finds className attributes that set a background or text colour to a fixed
 * hex WITHOUT a dark: counterpart. Tailwind's dark variant only works if the
 * element declares both halves.
 */
function unthemedHexSurfaces(source) {
  const offenders = [];
  const classAttr = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  let m;
  while ((m = classAttr.exec(source)) !== null) {
    const value = m[1] || m[2] || '';
    if (!value.includes('#')) continue;
    const hasDark = /\bdark:bg-\[|dark:text-\[/.test(value);
    if (hasDark) continue;
    for (const token of value.split(/\s+/)) {
      if (!/^(bg|text|border)-\[#[0-9a-fA-F]{3,8}\]/.test(token)) continue;
      const hex = token.toLowerCase();
      if (BRAND_OK.some((b) => hex.includes(b))) continue;
      offenders.push(token);
    }
  }
  return offenders;
}

const gate = await read('features/whatsapp/components/WhatsAppSyncGate.tsx');

await check('the sync gate declares a light surface', () => {
  assert.match(
    gate,
    /bg-white[^\n]*dark:bg-\[#111b21\]/,
    'the sync gate root must be light in light mode and keep the WhatsApp dark in dark mode',
  );
});

await check('the sync gate title follows the theme', () => {
  assert.match(gate, /text-slate-800[^\n]*dark:text-\[#e9edef\]/, 'the title must not be fixed white');
});

await check('the sync gate progress track follows the theme', () => {
  assert.match(gate, /bg-slate-200[^\n]*dark:bg-\[#202c33\]/, 'the track must be visible in light mode');
});

await check('no fixed hex surface in the sync gate is missing a dark variant', () => {
  const offenders = unthemedHexSurfaces(gate);
  assert.deepEqual(
    offenders,
    [],
    `these colours are fixed and will not follow the theme: ${offenders.join(', ')}`,
  );
});

await check('WhatsApp brand green is exempt from theming', () => {
  assert.ok(gate.includes('#00a884'), 'the WhatsApp brand green must survive the theme pass');
});

await check('the chat loading skeleton follows the theme', async () => {
  const thread = await read('features/whatsapp/components/ChatThread.tsx');
  const loadingBlock = thread.slice(thread.indexOf('if (loading)'));
  const offenders = unthemedHexSurfaces(loadingBlock.slice(0, 1200));
  assert.deepEqual(
    offenders,
    [],
    `the in-thread loading skeleton must follow the theme: ${offenders.join(', ')}`,
  );
  assert.match(
    loadingBlock.slice(0, 1200),
    /dark:bg-/,
    'the loading skeleton must declare a dark variant',
  );
});

await check('the shared Skeleton primitive is theme-aware', async () => {
  const skeleton = await read('components/ui/Skeleton.tsx');
  assert.match(
    skeleton,
    /bg-slate-200[^\n]*dark:bg-/,
    'Skeleton is shared by every loading surface, so it must be themed',
  );
});

console.log(`\n${passed}/7 checks passed`);
process.exit(passed === 7 ? 0 : 1);
