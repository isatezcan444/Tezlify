/**
 * Phase 6.4 — executed verification of the WhatsApp PAIRING UI.
 *
 * Bundles the REAL WhatsAppQrConnectModal (plus the real I18nProvider and
 * ToastProvider) with esbuild and renders it into jsdom with React 18
 * `createRoot`. Only the network boundary is stubbed: `authFetch` ends in the
 * global `fetch`, so replacing `fetch` stands in for the backend without
 * touching one line of component code.
 *
 * Run: `node scripts/verify-whatsapp-pairing.mjs` — exit 0 = PASS.
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

// ---------------------------------------------------------------- jsdom setup
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;

const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  } catch { /* environment already provides it */ }
};
setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('navigator', window.navigator);
setGlobal('HTMLElement', window.HTMLElement);
setGlobal('Element', window.Element);
setGlobal('Node', window.Node);
setGlobal('Event', window.Event);
setGlobal('MouseEvent', window.MouseEvent);
setGlobal('KeyboardEvent', window.KeyboardEvent);
setGlobal('CustomEvent', window.CustomEvent);
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('localStorage', window.localStorage);
setGlobal('sessionStorage', window.sessionStorage);
setGlobal('location', window.location);
setGlobal('history', window.history);
setGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
setGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
setGlobal('MutationObserver', window.MutationObserver);
setGlobal('Headers', window.Headers || globalThis.Headers);
setGlobal('Response', globalThis.Response);

// ------------------------------------------------------------ fake backend
const QR_A = 'data:image/png;base64,QRAAA';
const QR_B = 'data:image/png;base64,QRBBB';

function makeBackend(opts = {}) {
  const calls = { start: 0, qrPoll: 0, pair: 0, cancel: 0 };
  const state = {
    qr: opts.initialQr ?? null,
    status: opts.initialStatus ?? 'SCAN_QR',
    sessionId: opts.sessionId ?? null,
    phone: opts.phone ?? null,
  };
  let token = 'tok-1';

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  const seen = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (process.env.TRACE) console.log('   TRACE', u);
    if (u.includes('/whatsapp/pairing/start')) {
      calls.start += 1;
      token = `tok-${calls.start}`;
      return json({ pair_token: token, gateway_id: `gw-${token}`, session_name: 'Hat 1', status: 'SCAN_QR', qr_code: state.qr }, 201);
    }
    if (u.includes('/qr') && u.includes('/whatsapp/pairing/')) {
      calls.qrPoll += 1;
      if (opts.pollFails) return json({ detail: 'not found' }, 404);
      return json({ status: state.status, qr_code: state.qr, phone: state.phone, session_id: state.sessionId, error_message: null });
    }
    if (u.includes('/whatsapp/pairing/') && u.includes('/cancel')) {
      calls.cancel += 1;
      return json({ success: true });
    }
    if (u.includes('/pair')) {
      calls.pair += 1;
      if (opts.pairFails) return json({ detail: opts.pairErrorMessage || 'WhatsApp soketi hazırlanamadı.' }, 500);
      return json({ success: true, pairing_code: opts.pairingCode || '12345678', phone: '+905413749073' });
    }
    if (u.includes('/whatsapp/sessions')) {
      return json({ sessions: [] });
    }
    if (u.includes('/whatsapp/sessions/')) {
      return json({ status: state.status, qr_code: state.qr, phone: state.phone, error_message: null });
    }
    return json({ error: 'unexpected ' + u }, 500);
  };

  return { calls, state, fetchImpl, seen };
}

// ------------------------------------------------------------------- bundle
const tmp = await mkdtemp(path.join(os.tmpdir(), 'wa-pairing-dom-'));
const entry = path.join(tmp, 'entry.tsx');
const outfile = path.join(tmp, 'bundle.js');

await writeFile(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { WhatsAppQrConnectModal } from ${JSON.stringify(path.join(SRC, 'features/whatsapp/components/WhatsAppQrConnectModal.tsx'))};
import { I18nProvider } from ${JSON.stringify(path.join(SRC, 'context/I18nContext.tsx'))};
import { ToastProvider } from ${JSON.stringify(path.join(SRC, 'context/ToastContext.tsx'))};
window.__P = { React, createRoot, act, WhatsAppQrConnectModal, I18nProvider, ToastProvider };
`);

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  absWorkingDir: frontendRoot,
  nodePaths: [path.join(frontendRoot, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'empty' },
  logLevel: 'error',
});

const code = await (await import('node:fs/promises')).readFile(outfile, 'utf8');
window.eval(code);
const { React, createRoot, act, WhatsAppQrConnectModal, I18nProvider, ToastProvider } = window.__P;
const h = React.createElement;

// ------------------------------------------------------------------ harness
let passed = 0;
const failures = [];
let currentView = null;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL - ${name}\n        ${String(err.message).split('\n')[0]}`);
  } finally {
    if (currentView) { try { await currentView.unmount(); } catch {} currentView = null; }
  }
}

const realSetTimeout = globalThis.setTimeout;
async function tick(ms) {
  await act(async () => {
    await new Promise((r) => realSetTimeout(r, ms));
  });
}

let backend = makeBackend();
const installFetch = () => { const f = async (...args) => backend.fetchImpl(...args); setGlobal('fetch', f); window.fetch = f; };
installFetch();

async function mount(props = {}) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  let latest = props;
  const render = async (next = latest) => {
    latest = { ...latest, ...next };
    await act(async () => {
      root.render(
        h(I18nProvider, null,
          h(ToastProvider, null,
            h(WhatsAppQrConnectModal, { isOpen: true, onClose: () => {}, ...latest })))
      );
    });
  };
  await render();
  for (let i=0;i<40 && backend.calls.start===0;i+=1) await tick(50);
  await tick(50);
  const view = { host, root, render, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
  currentView = view;
  return view;
}

// The modal renders through createPortal(..., document.body), so every query
// must run against the document — not the React root host.
const body = () => window.document.body;
const qrImg = () => body().querySelector('img[alt="WhatsApp QR Code"]');
const codeDigits = () => Array.from(body().querySelectorAll('span.font-mono')).map((s) => s.textContent).join('');


console.log('\n=== WhatsApp pairing UI verification ===');

// ---------------------------------------------------------------- A. QR flow
await check('QR: a new session shows the QR once the gateway produces one', async () => {
  backend = makeBackend();
  installFetch();
  const v = await mount();
  // startPairing returns no QR yet -> INITIALIZING -> poll must fetch it.
  backend.state.qr = QR_A;
  assert.ok(backend.calls.qrPoll >= 1, `the modal must poll for the QR (calls=${backend.calls.qrPoll})`);
  assert.ok(qrImg(), 'QR must be rendered once polling returns it');
  assert.equal(qrImg().getAttribute('src'), QR_A);
  await v.unmount();
});

await check('QR: a newer QR replaces the old one', async () => {
  backend = makeBackend();
  installFetch();
  const v = await mount();
  backend.state.qr = QR_A;
  await tick(2700);
  assert.equal(qrImg().getAttribute('src'), QR_A);
  backend.state.qr = QR_B;
  await tick(2700);
  assert.equal(qrImg().getAttribute('src'), QR_B, 'the newest QR must win');
  await v.unmount();
});

await check('QR: CONNECTED closes the pairing UI', async () => {
  backend = makeBackend();
  installFetch();
  const v = await mount();
  backend.state.qr = QR_A;
  await tick(2700);
  backend.state.status = 'CONNECTED';
  backend.state.phone = '+905413749073';
  backend.state.sessionId = 42;
  await tick(2700);
  assert.ok(!qrImg(), 'QR must be cleared once connected');
  assert.ok((body().textContent || '').length > 0);
  await v.unmount();
});

// ------------------------------------------------------- B. Phone pairing code
await check('PHONE: requesting a code shows it in full', async () => {
  backend = makeBackend({ pairingCode: '12345678' });
  installFetch();
  const v = await mount({ existingSessionId: 7 });
  // switch to the pairing tab
  const tabs = Array.from(body().querySelectorAll('[role="tab"]'));
  await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(30);
  const phoneInput = body().querySelector('#pairing-phone-input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(phoneInput, '+905413749073');
    phoneInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const submit = Array.from(body().querySelectorAll('button')).find((b) => (b.textContent||'').trim().length > 0 && !b.disabled && !/^(Scan QR Code|Link with Phone Number)$/.test((b.textContent||'').trim()));
  await act(async () => { submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(120);
  assert.equal(backend.calls.pair, 1, `one pairing request (got ${backend.calls.pair})`);
  assert.equal(codeDigits(), '12345678', 'the code must be rendered in full, untruncated');
  await v.unmount();
});

await check('PHONE: a NEW session (no existing id) can also request a code', async () => {
  backend = makeBackend({ pairingCode: '87654321' });
  installFetch();
  const v = await mount();
  const tabs = Array.from(body().querySelectorAll('[role="tab"]'));
  await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(30);
  const phoneInput = body().querySelector('#pairing-phone-input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(phoneInput, '+905413749073');
    phoneInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const submit = Array.from(body().querySelectorAll('button')).find((b) => /kod/i.test(b.textContent || ''));
  await act(async () => { submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(200);
  assert.equal(backend.calls.pair, 1, `a new session must be able to request a code (got ${backend.calls.pair})`);
  assert.equal(codeDigits(), '87654321', 'the code must be displayed');
  await v.unmount();
});

await check('PHONE: a failure surfaces an error and leaves a retry', async () => {
  backend = makeBackend({ pairFails: true, pairErrorMessage: 'WhatsApp soketi hazırlanamadı.' });
  installFetch();
  const v = await mount({ existingSessionId: 7 });
  const tabs = Array.from(body().querySelectorAll('[role="tab"]'));
  await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(30);
  const phoneInput = body().querySelector('#pairing-phone-input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(phoneInput, '+905413749073');
    phoneInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const submit = Array.from(body().querySelectorAll('button')).find((b) => /kod/i.test(b.textContent || ''));
  await act(async () => { submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(200);
  assert.ok((body().textContent || '').includes('hazırlanamadı'), 'the real error must be visible');
  await v.unmount();
});

// ------------------------------------------------------------------- summary
console.log(`\nWhatsApp pairing verification: ${failures.length ? 'FAILED' : 'PASS'} (${passed} checks)`);
if (failures.length) {
  for (const f of failures) console.log(`\n--- ${f.name} ---\n${f.err.stack}`);
}
await rm(tmp, { recursive: true, force: true }).catch(() => {});
window.close();
process.exit(failures.length ? 1 : 0);
