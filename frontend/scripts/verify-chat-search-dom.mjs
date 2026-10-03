/**
 * Executed DOM verification of the in-chat search and keyword highlighting.
 *
 * Verifies:
 * 1. ChatSearchBar mounts, displays query, occurrences counter, and next/prev controls.
 * 2. Keyboard shortcuts on input: Enter (next), Shift+Enter (prev), Escape (close).
 * 3. ChatBubble highlights matched keywords with <mark> tags.
 * 4. ChatBubble active search match has focus ring-2.
 *
 * Run: node scripts/verify-chat-search-dom.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { hardenAssert } from './lib/safe-dom-assert.mjs';

hardenAssert(assert);
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  } catch {
    globalThis[name] = value;
  }
};
setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('navigator', window.navigator);
setGlobal('HTMLElement', window.HTMLElement);
setGlobal('KeyboardEvent', window.KeyboardEvent);
setGlobal('Element', window.Element);
setGlobal('localStorage', window.localStorage);
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-search-dom-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

try {
  await writeFile(
    entry,
    [
      `import React from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `import { I18nProvider } from '${SRC}/context/I18nContext';`,
      `import { ChatSearchBar } from '${SRC}/features/whatsapp/components/ChatSearchBar';`,
      `import { ChatBubble } from '${SRC}/features/whatsapp/components/ChatBubble';`,
      `export { React, act, createRoot, I18nProvider, ChatSearchBar, ChatBubble };`,
    ].join('\n'),
    'utf8',
  );

  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: out,
    platform: 'browser',
    absWorkingDir: frontendRoot,
    nodePaths: [path.join(frontendRoot, 'node_modules')],
    jsx: 'automatic',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    define: {
      'import.meta.env': '{}',
      'process.env.NODE_ENV': '"development"',
    },
    logLevel: 'silent',
  });

  const { React, act, createRoot, I18nProvider, ChatSearchBar, ChatBubble } = await import(out);
  const h = React.createElement;

  let passed = 0;
  const roots = new Set();

  const cleanup = async () => {
    for (const root of roots) {
      await act(async () => { root.unmount(); });
    }
    roots.clear();
    window.document.body.innerHTML = '';
  };

  const check = async (label, fn) => {
    await fn();
    await cleanup();
    passed += 1;
    console.log(`  ok - ${label}`);
  };

  const mount = async (element) => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    await act(async () => {
      root.render(h(I18nProvider, null, element));
    });
    return { host, root };
  };

  console.log('Running In-Chat Search DOM Verification...');

  // Test 1: ChatSearchBar mounting & display
  await check('ChatSearchBar renders input, counter badge, and handles keyboard navigation', async () => {
    let nextCalled = false;
    let prevCalled = false;
    let closeCalled = false;
    let queryVal = 'merhaba';

    const { host } = await mount(
      h(ChatSearchBar, {
        query: queryVal,
        onQueryChange: (q) => { queryVal = q; },
        totalMatches: 5,
        currentMatchIndex: 1,
        onNextMatch: () => { nextCalled = true; },
        onPrevMatch: () => { prevCalled = true; },
        onClose: () => { closeCalled = true; },
      })
    );

    const input = host.querySelector('input');
    assert.ok(input, 'search input must exist');
    assert.equal(input.value, 'merhaba', 'input value must match query prop');

    // Occurrence counter
    const counter = host.textContent;
    assert.ok(counter.includes('2 / 5') || counter.includes('2 of 5'), 'occurrence counter must display current/total');

    // Test Enter key on input -> next match
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.ok(nextCalled, 'Enter must trigger next match');

    // Test Shift+Enter key on input -> prev match
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    assert.ok(prevCalled, 'Shift+Enter must trigger prev match');

    // Test Escape key on input -> close
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.ok(closeCalled, 'Escape must trigger close');
  });

  // Test 2: ChatBubble keyword highlighting with <mark>
  await check('ChatBubble highlights matching search keywords with <mark> tags and active focus ring', async () => {
    const sampleMsg = {
      id: 999,
      body: 'Selamlar, yarın toplantı saat kaçta?',
      direction: 'INBOUND',
      status: 'READ',
      created_at: new Date().toISOString(),
      message_type: 'TEXT',
    };

    const { host } = await mount(
      h(ChatBubble, {
        message: sampleMsg,
        searchQuery: 'toplantı',
        isSearchActiveMatch: true,
      })
    );

    const mark = host.querySelector('mark');
    assert.ok(mark, 'matching text must be wrapped in <mark> tag');
    assert.equal(mark.textContent, 'toplantı', 'mark tag must contain the matched keyword');

    // Active match focus ring check
    const bubbleEl = host.querySelector('[data-msg-id="999"]');
    assert.ok(bubbleEl, 'bubble must carry data-msg-id');
    assert.ok(bubbleEl.className.includes('ring-2'), 'active search match must have ring-2 highlight');
  });

  console.log(`\n${passed}/${passed} in-chat search DOM checks passed cleanly!`);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
