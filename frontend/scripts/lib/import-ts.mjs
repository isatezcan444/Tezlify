/**
 * Load a TypeScript module from `src/` under plain node, with no bundler.
 *
 * WHY THIS EXISTS
 * ---------------
 * These verification scripts used to import transpiled code through
 * `data:text/javascript;base64,...`. That approach breaks as soon as the
 * module has a RELATIVE import: a data: URL has no base against which
 * `./whatsappOrdering` can be resolved, so node throws
 * `ERR_UNSUPPORTED_RESOLVE_REQUEST` and the suite cannot even start. That is
 * not a product failure but a broken harness, and it silently disabled the
 * message-merge and ordering tests in CI.
 *
 * The fix writes the transpiled output to a real temp file INSIDE `src/`, so
 * relative imports resolve exactly as they do in the app, and removes the
 * directory afterwards. No bundler, no config, no behaviour change.
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Transpile a `src/` TypeScript file to ESM JavaScript text. */
export function transpile(srcPath) {
  const source = fs.readFileSync(srcPath, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

/**
 * Import a `src/` module by path relative to the CALLING script.
 *
 * @param {string} relativeFromScript e.g. `'../src/features/whatsapp/lib/x'`,
 *   resolved against the directory of the script that calls this helper.
 * @param {string} [callerUrl] `import.meta.url` of the calling script.
 * @returns {Promise<Record<string, any>>} the module namespace
 */
export async function importTsModule(relativeFromScript, callerUrl) {
  const baseDir = path.dirname(new URL(callerUrl ?? import.meta.url).pathname);
  // Callers pass an extensionless specifier; accept .ts/.tsx too.
  const raw = path.resolve(baseDir, relativeFromScript);
  const abs = ['', '.ts', '.tsx'].map((ext) => raw + ext).find((p) => fs.existsSync(p));
  if (!abs) {
    throw new Error(`Module not found: ${raw}{.ts,.tsx}`);
  }

  // Transpile the module's whole source tree to sibling .harness.mjs files.
  // Node resolves extensionless relative specifiers (`./whatsappOrdering`)
  // against the real filesystem and will not try .mjs, so every specifier in
  // the emitted JS is rewritten to the .harness.mjs name we actually wrote.
  //
  // The walk covers the WHOLE src/ tree, not just the entry's folder: a leaf
  // module commonly reaches upwards (lib/ importing src/lib/utils), and a
  // partial walk would resolve some imports and not others.
  const written = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry.name)) {
        let out = transpile(p);
        // Point every relative specifier at the .harness.mjs sibling we are
        // about to write, so node resolves it against the real filesystem.
        out = out.replace(
          /(\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?)\2/gm,
          (m, kw, q, spec) => {
            const clean = spec.replace(/\.(mjs|js|json|css|ts|tsx)$/, '');
            if (/\.(json|css)$/.test(spec)) return m;
            return `${kw}${q}${clean}.harness.mjs${q}`;
          },
        );
        const dest = p.replace(/\.tsx?$/, '.harness.mjs');
        fs.writeFileSync(dest, out, 'utf8');
        written.push(dest);
      }
    }
  };
  walk(path.resolve(baseDir, '..', 'src'));

  try {
    return await import(pathToFileURL(abs.replace(/\.tsx?$/, '.harness.mjs')).href);
  } finally {
    for (const f of written) {
      try { fs.unlinkSync(f); } catch { /* best effort */ }
    }
  }
}
