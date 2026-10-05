/**
 * Executed DOM verification of the composer's Enter-to-send contract.
 *
 * REPORTED SYMPTOMS
 *   (a) After typing a message and pressing Enter, the cursor no longer sat in
 *       the draft field, so the next message could not be typed without clicking
 *       back into the composer. WhatsApp Web keeps the cursor there.
 *   (b) The composer had no emoji panel at all. When one was added, the wiring
 *       is where it can go wrong: stealing focus from the draft, appending to
 *       the end of the draft instead of the caret, or closing after one pick.
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
import { hardenAssert } from './lib/safe-dom-assert.mjs';

// CANLI DOM elemani uzerinde esitlik iddiasi kurmak Node'un mesaj uretimini
// tetikler ve util.inspect tum DOM grafigini yuruyerek RAM'i tuketir
// (olculdu: tek iframe icin 137MB string -> SIGKILL, teshis yok). Kural:
// eleman yerine boolean veya attribute string karsilastir.
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
      `import { ToastProvider } from '${SRC}/context/ToastContext';`,
      `import { ChatComposer } from '${SRC}/features/whatsapp/components/ChatComposer';`,
      `export { React, act, createRoot, I18nProvider, ToastProvider, ChatComposer };`,
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

  const { React, act, createRoot, I18nProvider, ToastProvider, ChatComposer } = await import(out);

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

  /**
   * Wait for a real macrotask, so `requestAnimationFrame` callbacks scheduled by
   * a handler actually run. The caret is restored inside rAF — after React has
   * committed the new value — so asserting without this would only ever see the
   * caret a browser leaves at the end of a programmatically assigned value.
   */
  const settle = () => act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });

  const mount = async (onSend) => {
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
            React.createElement(ChatComposer, { onSend }),
          ),
        ),
      );
    });
    const input = host.querySelector('textarea, input[type="text"]');
    assert.ok(input, 'the draft input must render');
    return { host, input, root };
  };

  /** Set a value the way React sees it (native setter + bubbling input event). */
  const typeInto = async (el, value) => {
    const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
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

  // ---------------------------------------------------------------- emoji panel

  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  const panelOf = (host) => host.querySelector('[data-testid="emoji-grid"]')?.parentElement ?? null;

  await check('the emoji button opens the panel on a non-empty category', async () => {
    const send = deferredSend();
    const { host } = await mount(send.onSend);

    const toggle = host.querySelector('button[aria-expanded]');
    assert.ok(toggle, 'the composer must render an emoji toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');

    await click(toggle);

    assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the panel must open');
    const panel = panelOf(host);
    assert.ok(panel, 'the panel must render');
    // A first-time user has no recents; the panel must not open empty.
    const emojis = panel.querySelectorAll('button[title]');
    assert.ok(emojis.length > 20, `the grid must be populated (got ${emojis.length})`);
  });

  await check('picking an emoji inserts it at the caret and keeps the draft focused', async () => {
    const send = deferredSend();
    const { host, input } = await mount(send.onSend);

    await typeInto(input, 'merhaba dunya');
    // Put the caret in the middle: the emoji must land THERE, not at the end.
    await act(async () => { input.setSelectionRange(8, 8); });
    input.focus();

    await click(host.querySelector('button[aria-expanded]'));
    const panel = panelOf(host);
    const first = panel.querySelectorAll('button[title]')[0];
    const picked = first.textContent;

    await click(first);
    await flush();
    await settle();

    assert.equal(input.value, `merhaba ${picked}dunya`, 'inserted at the caret, not appended');
    assert.equal(window.document.activeElement, input, 'the draft keeps focus after a pick');
    assert.ok(
      panelOf(host), 'the panel stays open so several emoji can be added in a row',
    );
    assert.equal(input.selectionStart, 8 + picked.length, 'the caret follows the emoji');

    // Pick a second emoji: panel must REMAIN open
    const second = panel.querySelectorAll('button[title]')[1];
    const picked2 = second.textContent;
    await click(second);
    await flush();
    await settle();
    assert.equal(input.value, `merhaba ${picked}${picked2}dunya`, 'second emoji also inserted at caret');
    assert.ok(panelOf(host), 'the panel STILL stays open after multiple consecutive picks');

    // Textarea must have scrollbar-none to prevent visible scrollbar track
    assert.ok(input.className.includes('scrollbar-none'), 'textarea must have scrollbar-none class');
  });

  await check('Escape closes the emoji panel', async () => {
    const send = deferredSend();
    const { host } = await mount(send.onSend);

    const toggle = host.querySelector('button[aria-expanded]');
    await click(toggle);
    assert.ok(panelOf(host), 'the panel must be open first');

    await act(async () => {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    assert.equal(panelOf(host), null, 'Escape must close the panel');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  });

  await check('clicking outside closes the emoji panel', async () => {
    const send = deferredSend();
    const { host } = await mount(send.onSend);

    const toggle = host.querySelector('button[aria-expanded]');
    await click(toggle);
    assert.ok(panelOf(host), 'the panel must be open first');

    await act(async () => {
      window.document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    });

    assert.equal(panelOf(host), null, 'clicking outside body must close the panel');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  });

  console.log(`\n${passed}/8 composer focus + emoji checks passed`);
  ok = passed === 8;
} catch (err) {
  console.error(`\nFAIL: ${err?.message ?? err}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
  // The bundled React/jsdom graph leaves handles behind that keep the event
  // loop alive, so the process would hang after the checks had already
  // finished. The result is already reported, so exit explicitly.
  process.exit(ok ? 0 : 1);
}
