#!/usr/bin/env node
/**
 * Localization + typography audit for the admin surfaces.
 *
 * WHY A SCRIPT
 * -------------
 * The project rules forbid hardcoded user-facing strings, require TR/EN key
 * parity, and (from experience) fonts drift silently: a weight is used that the
 * loaded family does not provide, or a family is referenced that is never
 * loaded, and the page simply looks "a bit off" with nothing in the diff.
 *
 * Hand-grepping is unreliable — the misses are exactly the cases that matter.
 * This reads the actual source and the actual dictionaries.
 *
 * Run: node scripts/audit-admin-i18n.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

const ADMIN_FILES = [
  'pages/admin/AdminOperationsPage.tsx',
  'pages/admin/AdminDeploymentPage.tsx',
  'pages/admin/AdminOverviewPage.tsx',
  'pages/admin/AdminMonitoringPage.tsx',
  'pages/admin/AdminBackupsPage.tsx',
  'pages/admin/AdminSecurityPage.tsx',
  'pages/admin/AdminWhatsAppPage.tsx',
  ...fs.readdirSync(path.join(SRC, 'components/admin/ops'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `components/admin/ops/${f}`),
].filter((f) => fs.existsSync(path.join(SRC, f)));

let problems = 0;
const fail = (scope, msg) => {
  problems += 1;
  console.log(`  FAIL [${scope}] ${msg}`);
};
const pass = (msg) => console.log(`  ok   ${msg}`);

/** Flatten a nested dictionary to `a.b.c` -> value. */
const flatten = (obj, prefix = '', out = new Map()) => {
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, next, out);
    else out.set(next, v);
  }
  return out;
};

const { tr } = await import(path.join(SRC, 'locales/tr.ts'));
const { en } = await import(path.join(SRC, 'locales/en.ts'));
const trFlat = flatten(tr);
const enFlat = flatten(en);

// --- dictionary parity ------------------------------------------------------
console.log('\nLocalization');
{
  const missingEn = [...trFlat.keys()].filter((k) => !enFlat.has(k));
  const missingTr = [...enFlat.keys()].filter((k) => !trFlat.has(k));
  if (missingEn.length) fail('parity', `EN missing ${missingEn.length}: ${missingEn.slice(0, 6).join(', ')}`);
  if (missingTr.length) fail('parity', `TR missing ${missingTr.length}: ${missingTr.slice(0, 6).join(', ')}`);
  if (!missingEn.length && !missingTr.length) {
    pass(`TR/EN key sets are identical (${trFlat.size} keys)`);
  }
}

// --- empty values -----------------------------------------------------------
{
  const empties = [...trFlat.entries()]
    .filter(([, v]) => typeof v === 'string' && v.trim() === '')
    .map(([k]) => k);
  if (empties.length) fail('empty', `TR has empty value(s): ${empties.slice(0, 5).join(', ')}`);
  else pass('no empty translation values');
}

// --- no hardcoded user-facing text -----------------------------------------
console.log('\nHardcoded strings');
{
  // Turkish words that would only appear if a string bypassed t().
  const turkish = /\b(ve|veya|için|ile|bağlı|yeniden|dışa|içe|aktar|hata|başarılı|çalışıyor|çalışmıyor|oturum|mesaj|kaydedilmiyor|bulunamadı|görüntülenemedi|yüklenemedi|onayla|iptal|sil|düzenle|kapat|evet|hayır|tümü|hiçbiri|oldu|olacak|olduğu|olarak|üzerinde|göre)\b/;
  let hardcoded = 0;
  for (const f of ADMIN_FILES) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const node of line.match(/>([^<>{}\n]{3,})</g) || []) {
        const inner = node.replace(/^>|<$/g, '').trim();
        if (!inner || /^[0-9/.:%()\-]+$/.test(inner)) continue;
        if (turkish.test(inner)) {
          fail(f, `line ${i + 1} hardcoded TR text: "${inner.slice(0, 60)}"`);
          hardcoded += 1;
        }
      }
    });
  }
  if (!hardcoded) pass('no Turkish text bypasses t() in the admin surfaces');
}

// --- placeholder parity -----------------------------------------------------
console.log('\nPlaceholders');
{
  const names = (v) => [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  let mismatch = 0;
  for (const [k, v] of trFlat) {
    if (!names(v) || !enFlat.has(k)) continue;
    if (names(v) !== names(enFlat.get(k))) {
      fail('placeholder', `${k}: TR {${names(v)}} vs EN {${names(enFlat.get(k))}}`);
      mismatch += 1;
    }
  }
  if (!mismatch) pass('every {placeholder} matches between TR and EN');
}

// --- typography -------------------------------------------------------------
console.log('\nTypography');
{
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
  const html = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');

  // 1. Every quoted family used in CSS must actually be loaded.
  const GENERIC = /^(system-ui|-apple-system|BlinkMacSystemFont|Segoe UI|Roboto|sans-serif|serif|monospace|ui-sans-serif|ui-serif|ui-monospace|Inter)$/;
  const quoted = [...new Set(
    [...css.matchAll(/font-family:\s*([^;]+);/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
      .filter((f) => !GENERIC.test(f)),
  )];
  let unloaded = 0;
  for (const family of quoted) {
    const inLink = html.includes(family) || html.includes(family.replace(/\s+/g, '+'));
    const local = fs.existsSync(path.join(SRC, '..', 'public', family));
    if (!inLink && !local) {
      fail('font', `family "${family}" is used in CSS but never loaded`);
      unloaded += 1;
    }
  }
  if (!unloaded) pass(`every quoted font-family is loaded (${quoted.join(', ') || 'none'})`);

  // 2. Every weight used in the admin surfaces must exist in the loaded family.
  // The link lists weights as `wght@300;400;...` (and sometimes `wght@400;500`
  // for the mono family). Each group must be split BEFORE parsing: parseInt on
  // the joined string would silently keep only the first weight of each family
  // and report a real, loaded weight as missing.
  const available = new Set(
    [...html.matchAll(/wght@([^&'"]+)/g)]
      .flatMap((m) => m[1].replace(/%5B/g, ';').replace(/%5D/g, '').split(/[;,]/))
      .map((w) => parseInt(w.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n >= 100 && n <= 900),
  );
  const TAILWIND = {
    'font-light': 300, 'font-normal': 400, 'font-medium': 500,
    'font-semibold': 600, 'font-bold': 700, 'font-extrabold': 800,
  };
  const used = new Set();
  for (const f of ADMIN_FILES) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const [cls, w] of Object.entries(TAILWIND)) {
      if (new RegExp(`\\b${cls}\\b`).test(text)) used.add(w);
    }
  }
  if (available.size) {
    const missing = [...used].filter((w) => !available.has(w)).sort();
    if (missing.length) {
      fail('font', `admin uses weight(s) ${missing.join(', ')} that the loaded family does not provide (has ${[...available].sort((a, b) => a - b).join(', ')})`);
    } else {
      pass(`all used weights (${[...used].sort((a, b) => a - b).join(', ')}) exist in the loaded family`);
    }
  }

  // 3. The webfont MUST eventually be applied.
  //
  //    `display=optional` looks like it removes the first-paint reflow, and it
  //    does — by never loading the font at all. On a cold cache the browser
  //    silently keeps the fallback, so every panel is drawn in the system font
  //    and stays that way. For a design built around Plus Jakarta Sans that is
  //    far worse than the brief reflow, and it looks like the whole UI broke.
  //    Verified by hand: switching to `optional` visibly degraded the admin
  //    panels and was reverted.
  //
  //    `swap` is correct here. The reflow is one frame on first load; a
  //    permanently wrong typeface is not.
  const display = html.match(/display=([a-z]+)/)?.[1];
  if (display === 'optional') {
    fail('font', 'the webfont uses display=optional: on a cold cache the font is never applied and the whole UI falls back to the system typeface');
  } else if (display === 'swap') {
    pass('the webfont is display=swap (applied after load, with a brief first-paint fallback)');
  } else if (display) {
    fail('font', `the webfont uses display=${display}, which hides text or delays it in a way the admin panels were not designed for`);
  } else {
    fail('font', 'the webfont link declares no display strategy');
  }
}

console.log(`\n${problems === 0 ? 'Admin i18n + typography audit: PASS' : `Admin i18n + typography audit: ${problems} problem(s)`}`);
process.exit(problems === 0 ? 0 : 1);
