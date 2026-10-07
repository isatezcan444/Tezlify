/**
 * Executed DOM verification of Quick Reply conversation isolation.
 *
 * Checks that inserting a quick reply into Chat A does not leak into Chat B
 * when the user switches conversations without sending.
 *
 * Invariants:
 * 1. Quick reply inserted in Chat A populates Chat A's composer.
 * 2. Switching to Chat B mounts a clean ChatComposer whose draft is empty.
 * 3. Switching back to Chat A does not re-insert stale Quick Reply text.
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
  } catch { /* already provided */ }
};
for (const n of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'MutationObserver']) {
  setGlobal(n, window[n]);
}
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('localStorage', window.localStorage);
setGlobal('matchMedia', window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-qr-isolation-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

let ok = false;
try {
  await writeFile(
    entry,
    [
      `import React, { useState, useCallback } from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `import { I18nProvider } from '${SRC}/context/I18nContext';`,
      `import { ToastProvider } from '${SRC}/context/ToastContext';`,
      `import { ChatComposer } from '${SRC}/features/whatsapp/components/ChatComposer';`,
      `export { React, useState, useCallback, act, createRoot, I18nProvider, ToastProvider, ChatComposer };`,
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
    jsx: 'automatic',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const { React, useState, useCallback, act, createRoot, I18nProvider, ToastProvider, ChatComposer } = await import(out);

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

  const settle = () => act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });

  // Harness replicating WhatsAppHubPage's conversation selection and composer mounting
  function ConversationHarness({ onSend = async () => {} }) {
    const [selectedConv, setSelectedConv] = useState({ id: 101, name: 'Chat A' });
    const [insertedComposerText, setInsertedComposerText] = useState(null);

    const handleSelectConversation = useCallback((c) => {
      setSelectedConv(c);
      setInsertedComposerText(null); // The fix: reset quick reply insertion state
    }, []);

    return React.createElement(
      'div',
      { id: 'harness' },
      React.createElement('button', {
        id: 'btn-select-a',
        onClick: () => handleSelectConversation({ id: 101, name: 'Chat A' }),
      }, 'Chat A'),
      React.createElement('button', {
        id: 'btn-select-b',
        onClick: () => handleSelectConversation({ id: 202, name: 'Chat B' }),
      }, 'Chat B'),
      React.createElement('button', {
        id: 'btn-insert-qr',
        onClick: () => setInsertedComposerText({ text: 'Quick Reply Template for Chat A', timestamp: Date.now() }),
      }, 'Insert Quick Reply'),
      React.createElement(ChatComposer, {
        key: selectedConv.id,
        insertedText: insertedComposerText,
        onSend,
      }),
    );
  }

  const mountHarness = async () => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(
            ToastProvider,
            null,
            React.createElement(ConversationHarness, null),
          ),
        ),
      );
    });
    return { host, root };
  };

  console.log('Testing Quick Reply Conversation Isolation:');

  await check('Chat A quick reply does not leak into Chat B when switching conversations', async () => {
    const { host } = await mountHarness();

    const btnInsert = host.querySelector('#btn-insert-qr');
    const btnSelectB = host.querySelector('#btn-select-b');
    const btnSelectA = host.querySelector('#btn-select-a');

    // Step 1: Insert quick reply into Chat A
    await act(async () => {
      btnInsert.click();
    });
    await settle();

    const inputA = host.querySelector('textarea, input[type="text"]');
    assert.ok(inputA, 'Chat A composer input must be present');
    assert.equal(inputA.value, 'Quick Reply Template for Chat A', 'Chat A composer must contain inserted quick reply');

    // Step 2: Switch to Chat B
    await act(async () => {
      btnSelectB.click();
    });
    await settle();

    const inputB = host.querySelector('textarea, input[type="text"]');
    assert.ok(inputB, 'Chat B composer input must be present');
    assert.equal(inputB.value, '', 'Chat B composer MUST be empty (no quick reply leak from Chat A)');

    // Step 3: Switch back to Chat A
    await act(async () => {
      btnSelectA.click();
    });
    await settle();

    const inputA2 = host.querySelector('textarea, input[type="text"]');
    assert.ok(inputA2, 'Chat A composer input must be present on return');
    // Stale quick reply event was cleared so newly mounted composer doesn't auto-reinsert
    assert.equal(inputA2.value, '', 'Chat A composer does not re-insert unconsumed stale quick reply');
  });

  console.log(`\nAll ${passed} isolation checks passed.`);
  ok = true;
} catch (err) {
  console.error(`\nFAIL: ${err?.message ?? err}`);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(ok ? 0 : 1);
}
