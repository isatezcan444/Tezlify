/**
 * Regression test for the P1 "no URL router" fix.
 *
 * The active section used to live in React state only, so a shared link always
 * landed on the dashboard, the Back button did nothing, and a refresh lost the
 * user's place. `useTabUrlSync` is the fix, and these are the three behaviours
 * it promises.
 *
 * Run: node scripts/verify-url-sync.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { hardenAssert } from './lib/safe-dom-assert.mjs';

// CANLI DOM elemani uzerinde esitlik iddiasi kurmak Node'un mesaj uretimini
// tetikler ve util.inspect tum DOM grafigini yuruyerek RAM'i tuketir
// (olculdu: tek iframe icin 137MB string -> SIGKILL, teshis yok). Kural:
// eleman yerine boolean veya attribute string karsilastir.
hardenAssert(assert);
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  } catch { /* already provided */ }
};
for (const n of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent']) setGlobal(n, window[n]);
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('localStorage', window.localStorage);
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('matchMedia', window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-url-sync-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

// The hook is extracted from the REAL App.tsx source rather than re-declared
// here: a copy would keep passing even after the shipped hook regressed.
const appSource = await readFile(path.join(SRC, 'App.tsx'), 'utf8');
// Start earlier so the TAB_PARAM const and the readTabFromUrl helper come
// along: the hook cannot be compiled without them.
const hookStart = appSource.indexOf("const TAB_PARAM = 'tab';");
if (hookStart === -1) {
  console.error('FAIL: the tab URL sync block is missing from App.tsx — the P1 fix was reverted');
  process.exit(1);
}
const hookEnd = appSource.indexOf('\nconst AppContent', hookStart);
if (hookEnd === -1) {
  console.error('FAIL: could not delimit useTabUrlSync in App.tsx');
  process.exit(1);
}
const hookSource = appSource.slice(hookStart, hookEnd);

// The VALID_TABS list is a hand-maintained copy of the render switch. If a page
// is added to one and not the other, its deep link silently stops working (or an
// unknown value starts rendering an empty shell), so the drift is caught here
// rather than discovered in production.
const rendered = new Set(
  [...appSource.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]),
);
const allowed = new Set(
  [...hookSource.matchAll(/^\s*'([a-z-]+)',?$/gm)].map((m) => m[1]),
);
const missing = [...rendered].filter((t) => !allowed.has(t)).sort();
const extra = [...allowed].filter((t) => !rendered.has(t)).sort();
if (missing.length || extra.length) {
  console.error('FAIL: VALID_TABS and the render switch have drifted.');
  for (const t of missing) {
    console.error(`  renderable but NOT in VALID_TABS (deep link silently falls back): ${t}`);
  }
  for (const t of extra) {
    console.error(`  in VALID_TABS but renders nothing: ${t}`);
  }
  process.exit(1);
}
console.log(`  ok - VALID_TABS matches the render switch (${rendered.size} sections)`);

await writeFile(
  path.join(tmp, 'hook.ts'),
  `import { useState, useEffect, useCallback } from 'react';\n${hookSource}`,
  'utf8',
);
await writeFile(
  path.join(tmp, 'harness.ts'),
  `export { act } from 'react';\nexport { createRoot } from 'react-dom/client';\n`,
  'utf8',
);
await writeFile(
  entry,
  [
    `export { act, createRoot } from './harness';`,
    `export { useTabUrlSync } from './hook';`,
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
  logLevel: 'silent',
});

const { useTabUrlSync, act, createRoot } = await import(out);
const React = (await import('react')).default;

let passed = 1;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const setUrl = (href) => window.history.replaceState(null, '', href);

/** Renders the real hook and exposes its current tab plus the navigate fn. */
async function render(initialUrl) {
  setUrl(initialUrl);
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  const seen = { current: null, navigate: null };

  function Harness() {
    const [tab, navigate] = useTabUrlSync('dashboard');
    seen.current = tab;
    seen.navigate = navigate;
    return React.createElement('div', null, tab);
  }
  await act(async () => { root.render(React.createElement(Harness)); });
  return {
    seen,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

await check('deep link opens the requested section', async () => {
  const { seen, unmount } = await render('/?tab=whatsapp');
  assert.equal(seen.current, 'whatsapp', 'a shared ?tab= link must land on that section');
  await unmount();
});

await check('missing or unknown tab falls back to the dashboard', async () => {
  const a = await render('/');
  assert.equal(a.seen.current, 'dashboard', 'no ?tab= must land on the default');
  await a.unmount();

  const b = await render('/?tab=does-not-exist');
  assert.equal(b.seen.current, 'dashboard', 'an unknown ?tab= must not render a blank screen');
  await b.unmount();
});

await check('navigating updates the URL', async () => {
  const { seen, unmount } = await render('/');
  await act(async () => { seen.navigate('campaigns'); });
  assert.equal(seen.current, 'campaigns', 'state must follow the navigation');
  assert.equal(
    new URLSearchParams(window.location.search).get('tab'),
    'campaigns',
    'the URL must record where the user is, so a refresh keeps their place',
  );
  await unmount();
});

await check('the default tab keeps the URL clean', async () => {
  const { seen, unmount } = await render('/');
  await act(async () => { seen.navigate('leads'); });
  await act(async () => { seen.navigate('dashboard'); });
  assert.equal(seen.current, 'dashboard');
  assert.equal(
    window.location.search,
    '',
    'returning to the default should drop ?tab= rather than leave ?tab=dashboard',
  );
  await unmount();
});

await check('browser Back returns to the previous section', async () => {
  const { seen, unmount } = await render('/');
  await act(async () => { seen.navigate('leads'); });
  await act(async () => { seen.navigate('whatsapp'); });
  assert.equal(seen.current, 'whatsapp');

  // A real Back: the history entry moves, then popstate fires.
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 50));
  });
  assert.equal(
    seen.current,
    'leads',
    'Back must restore the previous section — this was the original P1 bug',
  );
  await unmount();
});

console.log(`\n${passed}/6 checks passed`);
await rm(tmp, { recursive: true, force: true });
process.exit(passed === 6 ? 0 : 1);
