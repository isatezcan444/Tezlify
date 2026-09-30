/**
 * Executed DOM verification of the composer's Enter-to-send contract.
 *
 * REPORTED SYMPTOM
 *   After typing a message and pressing Enter, the cursor no longer sat in the
 *   draft field, so the next message could not be typed without clicking back
 *   into the composer. WhatsApp Web keeps the cursor there.
 *
 * ROOT CAUSE
 *   The draft input was rendered `disabled` while a send was in flight
 *   (`isInputDisabled` included `sending`). A focused element that becomes
 *   disabled is blurred by the browser, and re-enabling it never restores
 *   focus. So every single send dropped the cursor.
 *
 * THE CONTRACT (all four asserted against the REAL component, in jsdom)
 *   1. the draft field is NOT disabled while a send is in flight;
 *   2. focus is back in the draft field once the send completes, even after the
 *      blur a browser performs when a field it owns becomes disabled;
 *   3. text typed while a send is in flight is a NEW draft and is never eaten
 *      by the completion of the previous send;
 *   4. the draft that was actually sent is cleared (including a draft with
 *      trailing whitespace, which `.trim()` used to make un-matchable).
 *
 * jsdom note: jsdom does not implement the browser's "disabling a focused
 * element blurs it" focus fixup, so check 2 drives the blur explicitly. That
 * keeps the assertion honest — it fails if the field is left disabled or if
 * nothing reclaims focus.
 *
 * Run: node scripts/verify-composer-focus-dom.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
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

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-composer-focus-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

let ok = false;
try {
  await writeFile(
    entry,
    [
      `import React from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `import { I18nProvider } from '${SRC}/context/I18nContext';`,
      `import { ChatComposer } from '${SRC}/features/whatsapp/components/ChatComposer';`,
      `export { React, act, createRoot, I18nProvider, ChatComposer };`,
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

  const { React, act, createRoot, I18nProvider, ChatComposer } = await import(out);

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

  const flush = () => act(async () => { /* let pending promises settle */ });

  const mount = async (onSend) => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    await act(async () => {
      root.render(
        React.createElement(I18nProvider, null,
          React.createElement(ChatComposer, { onSend })),
      );
    });
    const input = host.querySelector('input[type="text"]');
    assert.ok(input, 'the draft input must render');
    return { host, input, root };
  };

  /** Set a value the way React sees it (native setter + bubbling input event). */
  const typeInto = async (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await act(async () => {
      setter.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };

  const pressEnter = async (el) => {
    await act(async () => {
      el.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }));
    });
  };

  /** A send this script decides when to finish. */
  const deferredSend = () => {
    const calls = [];
    let resolve = null;
    const onSend = (text) => {
      calls.push(text);
      return new Promise((r) => { resolve = () => r(); });
    };
    return { calls, onSend, finish: () => act(async () => { resolve?.(); }) };
  };

  await check('the draft field is not disabled and keeps focus through a send', async () => {
    const send = deferredSend();
    const { input } = await mount(send.onSend);

    await typeInto(input, 'merhaba');
    input.focus();
    assert.equal(window.document.activeElement, input, 'typing must leave the cursor in the draft');

    await pressEnter(input);
    assert.equal(send.calls.length, 1, 'Enter must send once');
    assert.equal(input.disabled, false, 'the draft must stay writable while the send is in flight');

    // What a real browser does the instant a focused field is disabled. Without
    // the fix this is the state the user was left in.
    input.blur();
    assert.notEqual(window.document.activeElement, input, 'the blur must have taken effect');

    await send.finish();
    await flush();

    assert.equal(
      window.document.activeElement, input,
      'focus must return to the draft field once the send completes',
    );
  });

  await check('a draft typed during a send survives, and the sent draft is cleared', async () => {
    const send = deferredSend();
    const { input } = await mount(send.onSend);

    await typeInto(input, 'birinci');
    await pressEnter(input);
    assert.equal(send.calls[0], 'birinci');

    // The user keeps composing before the first message lands.
    await typeInto(input, 'ikinci');
    await send.finish();
    await flush();

    assert.equal(input.value, 'ikinci', 'the new draft must not be wiped by the previous send');
  });

  await check('the sent draft is cleared, including trailing whitespace', async () => {
    const send = deferredSend();
    const { input } = await mount(send.onSend);

    await typeInto(input, 'merhaba ');
    await pressEnter(input);
    assert.equal(send.calls[0], 'merhaba', 'the trimmed body is what gets sent');

    await send.finish();
    await flush();

    assert.equal(input.value, '', 'the field must be empty after a successful send');
  });

  await check('a second Enter during an in-flight send does not send again', async () => {
    const send = deferredSend();
    const { input } = await mount(send.onSend);

    await typeInto(input, 'tek');
    await pressEnter(input);
    await pressEnter(input);
    await flush();

    assert.equal(send.calls.length, 1, 'the send lock must reject the duplicate');

    await send.finish();
    await flush();
    assert.equal(send.calls.length, 1, 'and it stays rejected after the send completes');
  });

  console.log(`\n${passed}/4 composer focus checks passed`);
  ok = passed === 4;
} catch (err) {
  console.error(`\nFAIL: ${err?.message ?? err}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
  // The bundled React/jsdom graph leaves handles behind that keep the event
  // loop alive, so the process would hang after the checks had already
  // finished. The result is already reported, so exit explicitly.
  process.exit(ok ? 0 : 1);
}
