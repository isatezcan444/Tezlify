/**
 * Executed DOM verification of the dialog accessibility contract.
 *
 * Renders the REAL Modal and Drawer into jsdom with React 18 and asserts the
 * three behaviours a keyboard or screen-reader user depends on:
 *
 *   1. focus moves into the dialog when it opens;
 *   2. Tab is TRAPPED inside it — without this, Tab walks straight out of the
 *      open dialog and into the page it is covering;
 *   3. focus returns to the element that opened the dialog when it closes,
 *      otherwise it jumps back to the top of the document.
 *
 * It also checks the close button exposes an accessible name, since a bare
 * icon button announces as "button" and nothing else.
 *
 * Run: node scripts/verify-dialog-a11y-dom.mjs — exit code 0 = PASS.
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

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-dialog-a11y-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  [
    `import React, { useState } from 'react';`,
    `import { createRoot } from 'react-dom/client';`,
    `import { act } from 'react';`,
    `import { I18nProvider } from '${SRC}/context/I18nContext';`,
    `import { Modal } from '${SRC}/components/ui/Modal';`,
    `import { Drawer } from '${SRC}/components/ui/Drawer';`,
    `export { React, act, createRoot, I18nProvider, Modal, Drawer };`,
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

const { React, act, createRoot, I18nProvider, Modal, Drawer } = await import(out);

let passed = 0;
const mounted = new Set();

/**
 * Each case mounts its own root, and Modal/Drawer portal into document.body —
 * so without this the dialogs from earlier cases stay in the document and
 * querySelector keeps finding a stale one. Unmount first, then remove anything
 * the portal left behind.
 */
const cleanup = async () => {
  for (const root of mounted) {
    await act(async () => { root.unmount(); });
  }
  mounted.clear();
  for (const el of Array.from(window.document.querySelectorAll('[role="dialog"]'))) {
    el.parentElement?.remove();
  }
};

const check = async (label, fn) => {
  await fn();
  await cleanup();
  passed += 1;
  console.log(`  ok - ${label}`);
};

/** Mounts a harness and hands back a setter for the open flag. */
async function mount(Component, props) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  let setOpen = null;

  function Harness() {
    const [open, set] = React.useState(false);
    setOpen = set;
    return React.createElement(I18nProvider, null,
      React.createElement(Component, { ...props, isOpen: open }));
  }

  mounted.add(root);
  await act(async () => { root.render(React.createElement(Harness)); });
  return { host, act, setOpen: (v) => act(async () => { setOpen(v); }) };
}

/**
 * jsdom does not implement `offsetParent`, which the trap uses to skip hidden
 * elements. Returning null for everything would filter out every node and make
 * the assertions meaningless, so it is stubbed to "attached to a rendered tree"
 * for the duration of these checks.
 */
const withLayoutAsync = async (fn) => {
  const proto = window.HTMLElement.prototype;
  const had = Object.getOwnPropertyDescriptor(proto, 'offsetParent');
  Object.defineProperty(proto, 'offsetParent', {
    configurable: true,
    get() { return this.isConnected ? window.document.body : null; },
  });
  try { return await fn(); } finally {
    if (had) Object.defineProperty(proto, 'offsetParent', had);
    else delete proto.offsetParent;
  }
};

const withLayout = (fn) => {
  const proto = window.HTMLElement.prototype;
  const had = Object.getOwnPropertyDescriptor(proto, 'offsetParent');
  Object.defineProperty(proto, 'offsetParent', {
    configurable: true,
    get() { return this.isConnected ? window.document.body : null; },
  });
  try { return fn(); } finally {
    if (had) Object.defineProperty(proto, 'offsetParent', had);
    else delete proto.offsetParent;
  }
};

const key = (k, shiftKey = false) => {
  const e = new window.KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true });
  window.document.dispatchEvent(e);
  return e;
};

// Modal/Drawer portal to document.body, so the panel is NOT inside the mount
// host. Searching the host would miss it entirely.
const panelOf = () => window.document.querySelector('[role="dialog"]');
const active = () => window.document.activeElement;
const twoButtons = () => React.createElement('div', null,
  React.createElement('button', { type: 'button' }, 'first'),
  React.createElement('button', { type: 'button' }, 'last'));

// ---------------------------------------------------------------- Modal

await check('modal exposes dialog role and aria-modal', async () => {
  const { host, setOpen } = await mount(Modal, { onClose: () => {} });
  await setOpen(true);
  const panel = panelOf();
  assert.ok(panel, 'no element with role="dialog"');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.equal(panel.getAttribute('tabindex'), '-1', 'panel must be programmatically focusable');
});

await check('focus moves INTO the dialog on open', async () => {
  const { setOpen } = await mount(Modal, { onClose: () => {}, children: twoButtons() });
  // The trap only focuses VISIBLE controls, and visibility is decided via
  // offsetParent, which jsdom does not implement. It must be stubbed across the
  // open, not just around the assertion, or nothing is focusable.
  await withLayoutAsync(async () => {
    await setOpen(true);
    const panel = panelOf();
    assert.ok(panel, 'no panel to focus into');
    assert.ok(
      panel.contains(active()),
      `focus stayed outside the dialog (on ${active()?.tagName})`,
    );
  });
});

await check('Tab at the last control wraps to the first (trap holds)', async () => {
  const { host, setOpen } = await mount(Modal, { onClose: () => {}, children: twoButtons() });
  await setOpen(true);
  withLayout(() => {
    const focusable = panelOf().querySelectorAll('button');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    assert.equal(active(), last, 'precondition: focus should be on the last control');
    const e = key('Tab');
    assert.equal(e.defaultPrevented, true, 'Tab on the last control must be intercepted');
    assert.equal(active(), first, 'Tab must wrap to the FIRST control, not leave the dialog');
  });
});

await check('Shift+Tab on the first control wraps to the last', async () => {
  const { host, setOpen } = await mount(Modal, { onClose: () => {}, children: twoButtons() });
  await setOpen(true);
  withLayout(() => {
    const focusable = panelOf().querySelectorAll('button');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first.focus();
    const e = key('Tab', true);
    assert.equal(e.defaultPrevented, true, 'Shift+Tab on the first control must be intercepted');
    assert.equal(active(), last, 'Shift+Tab must wrap to the LAST control');
  });
});

await check('focus returns to the trigger on close', async () => {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  mounted.add(root);

  function Harness() {
    const [open, set] = React.useState(false);
    return React.createElement(I18nProvider, null,
      React.createElement(React.Fragment, null,
        React.createElement('button', { type: 'button', onClick: () => set(true) }, 'open'),
        React.createElement(Modal, { isOpen: open, onClose: () => set(false) })));
  }
  await act(async () => { root.render(React.createElement(Harness)); });
  const openBtn = host.querySelector('button');
  await act(async () => { openBtn.focus(); openBtn.click(); });
  await act(async () => {
    const closeBtn = window.document.querySelector('[role="dialog"] button[aria-label]');
    assert.ok(closeBtn, 'close button missing');
    closeBtn.click();
  });
  assert.equal(active(), openBtn, 'focus must go back to the control that opened the dialog');
});

await check('icon-only close button has an accessible name', async () => {
  const { host, setOpen } = await mount(Modal, { onClose: () => {} });
  await setOpen(true);
  const closeBtn = window.document.querySelector('[role="dialog"] button[aria-label]');
  assert.ok(closeBtn, 'close button has no aria-label');
  const name = closeBtn.getAttribute('aria-label');
  assert.ok(name && name.trim().length > 0, 'aria-label must not be empty');
  assert.ok(!/common\.|\bt\(/i.test(name), `aria-label is an untranslated key: ${name}`);
});

// ---------------------------------------------------------------- Drawer

await check('drawer exposes dialog role and traps focus the same way', async () => {
  const { host, setOpen } = await mount(Drawer, { onClose: () => {}, children: twoButtons() });
  await setOpen(true);
  const panel = panelOf();
  assert.ok(panel, 'drawer has no role="dialog"');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  withLayout(() => {
    const focusable = panel.querySelectorAll('button');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    const e = key('Tab');
    assert.equal(e.defaultPrevented, true, 'drawer must intercept Tab at the last control');
    assert.equal(active(), first, 'drawer must wrap Tab to the first control');
  });
});

await check('Escape closes the dialog', async () => {
  let closed = 0;
  const { setOpen } = await mount(Modal, { onClose: () => { closed += 1; } });
  await setOpen(true);
  key('Escape');
  assert.equal(closed, 1, 'Escape must call onClose exactly once');
});

console.log(`\n${passed}/8 checks passed`);
await cleanup();
await rm(tmp, { recursive: true, force: true });
// The bundled React/jsdom graph leaves handles behind that keep the event loop
// alive, so the process would hang after the checks had already finished.
// The result is already reported at this point, so exit explicitly.
process.exit(0);
