#!/usr/bin/env node
/**
 * i18n key audit — the REQUIRED set is derived from the CONSUMER, not from the
 * other locale file.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old check compared `en` against `tr`. That check cannot see a key that is
 * missing from BOTH files, and it cannot see a key that exists in both but under
 * the WRONG PARENT. Both defects shipped: `ChatThread.tsx` calls
 * `t('whatsapp.loadOlderMessages')`, the key existed only as
 * `leads.loadOlderMessages`, and the UI rendered the raw string
 * `whatsapp.loadOlderMessages` — in English and Turkish alike. Two mirrors
 * agreed with each other and were both wrong.
 *
 * So this script reads `t('...')` call sites out of the source and requires
 * every one of them to resolve in every locale. That is the only direction that
 * can catch a missing key.
 *
 * The locale object is obtained by TRANSPILING the real module with esbuild and
 * evaluating it — not by re-parsing the file with a regex. A regex parser that
 * drifts from the real structure reports false keys, and a false key here is
 * worse than no check: it would "prove" a defect that does not exist (measured:
 * an indent-stack parser lost the `whatsapp.` prefix for 206 keys).
 *
 * Usage:  node scripts/verify-i18n-keys.mjs [--json]
 * Exit:   0 clean, 1 missing keys found
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const LOCALES_DIR = path.join(SRC, 'locales');
const LOCALES = ['en', 'tr'];

/** Flatten a locale object into dotted leaf paths. Arrays are leaves. */
export function flattenKeys(value, prefix = '', out = new Set()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out.add(prefix);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flattenKeys(child, next, out);
    } else {
      out.add(next);
    }
  }
  return out;
}

/** Transpile a locale module and read the real exported object. */
export function loadLocaleKeys(source) {
  const { code } = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
  });
  const mod = { exports: {} };
  // The locale module is a pure object literal — no imports, no side effects.
  new Function('module', 'exports', code)(mod, mod.exports);
  const exported = mod.exports;
  const root = exported.en || exported.tr || Object.values(exported)[0];
  if (!root || typeof root !== 'object') {
    throw new Error('locale modulu bir nesne disa aktarmiyor');
  }
  return flattenKeys(root);
}

/** Every literal `t('x.y')` call site under src, excluding the locale files. */
export function collectUsedKeys(root = SRC) {
  /** @type {Map<string, string[]>} */
  const used = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'locales' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const re = /\bt\(\s*(['"])([A-Za-z0-9_.]+)\1/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const key = m[2];
        if (!key.includes('.')) continue; // `t('Save')`-style is not a locale path
        if (!used.has(key)) used.set(key, []);
        used.get(key).push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return used;
}

function main() {
  const asJson = process.argv.includes('--json');
  const localeKeys = {};
  for (const lang of LOCALES) {
    const file = path.join(LOCALES_DIR, `${lang}.ts`);
    localeKeys[lang] = loadLocaleKeys(fs.readFileSync(file, 'utf8'));
  }
  const used = collectUsedKeys();

  const missing = [];
  for (const [key, files] of used) {
    for (const lang of LOCALES) {
      if (!localeKeys[lang].has(key)) {
        missing.push({ key, language: lang, usedIn: [...new Set(files)].slice(0, 3) });
      }
    }
  }

  const onlyIn = {};
  for (const lang of LOCALES) {
    const other = LOCALES.find((l) => l !== lang);
    onlyIn[lang] = [...localeKeys[lang]].filter((k) => !localeKeys[other].has(k));
  }

  const payload = {
    locales: LOCALES,
    used_keys: used.size,
    locale_key_counts: Object.fromEntries(LOCALES.map((l) => [l, localeKeys[l].size])),
    missing,
    only_in: onlyIn,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(
      `[i18n-audit] consumer call sites: ${used.size} keys | ` +
        LOCALES.map((l) => `${l}=${localeKeys[l].size}`).join(' ')
    );
    if (missing.length === 0) {
      console.log("[i18n-audit] PASS: her t('...') cagrisi her dilde cozumleniyor");
    } else {
      console.log(`[i18n-audit] FAIL: ${missing.length} eksik anahtar`);
      for (const item of missing) {
        console.log(`    MISSING ${item.language}: ${item.key}  (${item.usedIn.join(', ')})`);
      }
    }
    for (const lang of LOCALES) {
      if (onlyIn[lang].length) {
        console.log(
          `[i18n-audit] not: ${lang} icinde olup digerinde olmayan ${onlyIn[lang].length} anahtar`
        );
      }
    }
  }
  process.exit(missing.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
