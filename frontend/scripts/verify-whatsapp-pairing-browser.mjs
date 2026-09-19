/**
 * Phase 6.4 §13 — REAL BROWSER verification of the WhatsApp PAIRING UI.
 *
 * The jsdom harness (`verify-whatsapp-pairing.mjs`) has no layout engine, so it
 * cannot confirm that a QR is actually painted, that the 8-digit code is
 * legible, or that the modal really dismisses itself. This harness renders the
 * SAME real `WhatsAppQrConnectModal` in real Google Chrome over CDP with the
 * app's real built CSS, where layout and painting are genuine.
 *
 * No new test framework: Chrome is driven directly over the DevTools Protocol
 * using Node's built-in WebSocket. Nothing is installed into the repo.
 *
 * Scenarios (§13):
 *   A. QR pairing       — QR visible -> QR rotates -> connected -> modal closes
 *   B. Phone pair code  — "get code" -> 8 digits visible -> connected -> closes
 *   C. Failure          — real error visible -> retry still possible
 *
 * Where jsdom and Chrome disagree, the BROWSER result is authoritative.
 */
import esbuild from 'esbuild';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334; // distinct from verify-whatsapp-browser.mjs so they can coexist

if (!existsSync(CHROME)) {
  console.log('SKIP: Google Chrome not found at ' + CHROME);
  console.log('Real-browser pairing verification requires a Chrome install; jsdom results stand.');
  process.exit(0);
}

// --- 1. build a browser bundle of the REAL modal ---------------------------
const tmp = await mkdtemp(path.join(os.tmpdir(), 'wa-pairing-browser-'));
const entry = path.join(tmp, 'entry.tsx');
const bundle = path.join(tmp, 'bundle.js');

// NOTE: no backticks anywhere inside this template literal — they would
// silently terminate it.
await writeFile(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WhatsAppQrConnectModal } from '${path.join(SRC, 'features/whatsapp/components/WhatsAppQrConnectModal.tsx')}';
import { I18nProvider } from '${path.join(SRC, 'context/I18nContext.tsx')}';
import { ToastProvider } from '${path.join(SRC, 'context/ToastContext.tsx')}';

const QR_A = 'data:image/png;base64,QRAAA';
const QR_B = 'data:image/png;base64,QRBBB';

const calls = { start: 0, qrPoll: 0, pair: 0, cancel: 0 };
const st = { qr: null, status: 'SCAN_QR', sessionId: null, phone: null, pairingCode: '12345678', pairFails: false, startFails: false, qrFails: false };
let tokenSeq = 0;
let closes = 0;

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { 'Content-Type': 'application/json' },
});

// The network boundary. Everything above it (repository, api layer, component)
// is the real implementation.
const fetchImpl = async (url) => {
  const u = String(url);
  if (u.indexOf('/whatsapp/pairing/start') >= 0) {
    calls.start += 1;
    if (st.startFails) return json({ detail: 'WhatsApp soketi hazirlanamadi.' }, 500);
    tokenSeq += 1;
    const t = 'tok-' + tokenSeq;
    return json({ pair_token: t, gateway_id: 'gw-' + t, session_name: 'Hat 1', status: 'SCAN_QR', qr_code: st.qr }, 201);
  }
  if (u.indexOf('/whatsapp/pairing/') >= 0 && u.indexOf('/cancel') >= 0) {
    calls.cancel += 1;
    return json({ success: true });
  }
  if (u.indexOf('/whatsapp/pairing/') >= 0 && u.indexOf('/qr') >= 0) {
    calls.qrPoll += 1;
    if (st.qrFails) {
      return json({ status: 'ERROR', qr_code: null, phone: null, session_id: null, error_message: 'QR uretilemedi.' });
    }
    return json({ status: st.status, qr_code: st.qr, phone: st.phone, session_id: st.sessionId, error_message: null });
  }
  if (u.indexOf('/pair') >= 0) {
    calls.pair += 1;
    if (st.pairFails) return json({ detail: 'WhatsApp soketi hazirlanamadi.' }, 500);
    return json({ success: true, pairing_code: st.pairingCode, phone: '+905413749073' });
  }
  if (u.indexOf('/whatsapp/sessions') >= 0) return json({ sessions: [] });
  return json({ error: 'unexpected ' + u }, 500);
};

window.fetch = fetchImpl;
if (typeof globalThis !== 'undefined') globalThis.fetch = fetchImpl;

let root = null;
// isOpen lives in props so the harness can drive a real close -> reopen cycle
// through the component's own lifecycle effect (not a remount).
let props = { isOpen: true };

function draw() {
  root.render(React.createElement(I18nProvider, null,
    React.createElement(ToastProvider, null,
      React.createElement(WhatsAppQrConnectModal, Object.assign({
        onClose: function () { closes += 1; },
      }, props)))));
}

const bodyEl = () => document.body;
const digits = () => Array.from(bodyEl().querySelectorAll('span.font-mono'))
  .map(function (s) { return (s.textContent || '').trim(); })
  .filter(function (t) { return t.length === 1 && /[0-9]/.test(t); })
  .join('');

window.__h = {
  mount: function (next) {
    props = Object.assign({ isOpen: true }, next || {});
    if (root) { root.unmount(); }
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    draw();
    return true;
  },
  // Toggle isOpen on the SAME mounted instance: this is what a real user does
  // when they close the modal and reopen it, and it is the only path that
  // exercises the component's own reset-on-close logic.
  open: function (v) {
    props = Object.assign({}, props, { isOpen: !!v });
    draw();
    return true;
  },
  // Two distinct buckets: propsPatch goes to the REAL component, statePatch
  // configures the FAKE BACKEND. Mixing them silently feeds backend settings
  // into component props, where they are ignored.
  reset: function (propsPatch, statePatch) {
    calls.start = 0; calls.qrPoll = 0; calls.pair = 0; calls.cancel = 0;
    tokenSeq = 0; closes = 0;
    st.qr = null; st.status = 'SCAN_QR'; st.sessionId = null; st.phone = null;
    st.pairingCode = '12345678'; st.pairFails = false; st.startFails = false; st.qrFails = false;
    if (statePatch) Object.assign(st, statePatch);
    return this.mount(propsPatch);
  },
  set: function (patch) { Object.assign(st, patch); return true; },
  clickTab: function (i) {
    const tabs = Array.from(bodyEl().querySelectorAll('[role="tab"]'));
    if (tabs.length <= i) return false;
    tabs[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  },
  typePhone: function (v) {
    const input = bodyEl().querySelector('#pairing-phone-input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  clickButton: function (pattern) {
    const re = new RegExp(pattern, 'i');
    const btn = Array.from(bodyEl().querySelectorAll('button'))
      .find(function (b) { return b.getAttribute('role') !== 'tab' && !b.disabled && re.test((b.textContent || '').trim()); });
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  },
  // The header close button is icon-only (aria-label), so it has no text to match.
  clickAria: function (pattern) {
    const re = new RegExp(pattern, 'i');
    const btn = Array.from(bodyEl().querySelectorAll('button[aria-label]'))
      .find(function (b) { return re.test(b.getAttribute('aria-label') || ''); });
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  },
  state: function () {
    const img = bodyEl().querySelector('img[alt="WhatsApp QR Code"]');
    const input = bodyEl().querySelector('#pairing-phone-input');
    return {
      // Painting: a zero-size or unloaded QR is NOT "visible" to the user.
      qrSrc: img ? img.getAttribute('src') : null,
      qrPainted: !!img && img.getBoundingClientRect().width > 20 && img.getBoundingClientRect().height > 20,
      qrNaturalWidth: img ? img.naturalWidth : 0,
      code: digits(),
      hasPhoneInput: !!input,
      buttons: Array.from(bodyEl().querySelectorAll('button')).map(function (b) { return (b.textContent || '').trim(); }),
      text: (bodyEl().textContent || '').slice(0, 800),
      calls: JSON.parse(JSON.stringify(calls)),
      closes: closes,
      tokenSeq: tokenSeq,
      qrA: QR_A,
      qrB: QR_B,
    };
  },
};

window.__h.mount({});
`);

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'empty' },
  outfile: bundle,
  absWorkingDir: frontendRoot,
  nodePaths: [path.join(frontendRoot, 'node_modules'), path.resolve(frontendRoot, '..', 'node_modules')],
  define: {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env':
      '{"DEV":false,"PROD":true,"MODE":"production",' +
      '"VITE_API_URL":"","VITE_WS_URL":"","VITE_GATEWAY_URL":"",' +
      '"VITE_WHATSAPP_LATENCY_PROFILING":"false"}',
  },
  logLevel: 'error',
});

// The app's REAL stylesheet: Tailwind decides whether the modal is painted at
// a usable size at all. Without it `w-52 h-52` is inert and the QR has no box.
const distCssDir = path.join(frontendRoot, 'dist', 'assets');
let css = '';
if (existsSync(distCssDir)) {
  const file = (await readdir(distCssDir)).find((f) => f.endsWith('.css'));
  if (file) css = await readFile(path.join(distCssDir, file), 'utf8');
}
if (!css) {
  console.log('WARNING: no built CSS (run `npm run build`) — using a minimal layout shim');
  css = '.fixed{position:fixed}.inset-0{inset:0}.flex{display:flex}.w-52{width:13rem}.h-52{height:13rem}';
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>wa pairing browser harness</title>
<style>${css}</style>
<style>html,body{margin:0;min-height:100vh}</style></head>
<body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`;

// --- 2. serve it ----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    } else if (url === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(await readFile(bundle));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// --- 3. launch Chrome -----------------------------------------------------
const profile = path.join(tmp, 'profile');
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Chrome's own sandbox cannot initialize in this agent sandbox, which kills
    // the GPU/network services and leaves CDP unresponsive.
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-software-rasterizer',
    '--disable-gpu',
    '--window-size=900,800',
    base,
  ],
  { stdio: 'ignore' }
);

const cleanup = async () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { await new Promise((r) => server.close(r)); } catch {}
  try { await rm(tmp, { recursive: true, force: true }); } catch {}
};

async function waitForPageTarget() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) {
        const targets = await r.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no page target appeared on the Chrome devtools port');
}

let target;
try {
  target = await waitForPageTarget();
} catch (e) {
  await cleanup();
  console.log('SKIP: could not start Chrome — ' + e.message);
  process.exit(0);
}
let version = { Browser: 'chrome' };
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  if (r.ok) version = await r.json();
} catch {}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('websocket connect failed'));
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    console.log(`  [page:exception] ${d.exception?.description || d.text}`);
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
  });

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || 'page exception');
  }
  return r.result.value;
};

await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 2000));
if ((await evaluate('1+1')) !== 2) throw new Error('CDP Runtime.evaluate is not working');

// --- 4. scenarios ---------------------------------------------------------
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL - ${name}\n        ${e.message}`);
  }
}
const state = () => evaluate('window.__h.state()');
const call = (expr) => evaluate(expr);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The modal's fallback poll runs every 2500ms; one full interval plus slack.
const settle = () => wait(2900);

console.log('\n=== real browser pairing (Chrome, CDP) ===');

// ------------------------------------------------------------------- A. QR
await check('A: a new pairing paints a real QR once the gateway produces one', async () => {
  await call('window.__h.reset({})');
  await wait(400);
  await call("window.__h.set({ qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' })");
  await settle();
  const s = await state();
  assert.equal(s.calls.start, 1, `startPairing must run exactly once (got ${s.calls.start})`);
  assert.ok(s.qrSrc, 'the QR image must be rendered');
  assert.ok(s.qrSrc.startsWith('data:image/png;base64,'), `the gateway data URI must be forwarded verbatim: ${s.qrSrc}`);
  assert.ok(s.qrPainted, `the QR must have a real painted box (got ${JSON.stringify(s)})`);
  assert.equal(s.qrNaturalWidth, 1, 'the PNG must actually decode in the browser');
});

await check('A: a rotated QR replaces the old one in the browser', async () => {
  const QR2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await call(`window.__h.set({ qr: ${JSON.stringify(QR2)} })`);
  await settle();
  const s = await state();
  assert.equal(s.qrSrc, QR2, 'the newest QR must win');
  assert.ok(s.qrPainted, 'the replacement QR must still be painted');
});

await check('A: CONNECTED clears the QR and dismisses the modal', async () => {
  await call('window.__h.set({ status: "CONNECTED", sessionId: 42, phone: "+905413749073" })');
  await settle();
  const afterConnect = await state();
  assert.equal(afterConnect.qrSrc, null, 'the QR must be cleared once connected');
  assert.ok(afterConnect.text.includes('+905413749073'), `the connected number must be shown: ${afterConnect.text}`);
  // The modal schedules onClose 1500ms after connecting.
  await wait(2000);
  const s = await state();
  assert.ok(s.closes >= 1, `the modal must dismiss itself after connecting (closes=${s.closes})`);
});

// ------------------------------------------------------- B. Phone pair code
await check('B: "Kod Al" for a NEW pairing shows all 8 digits', async () => {
  // THE P6-8 DEFECT: a new pairing has no numeric session id, so the old path
  // silently did nothing and no code ever appeared.
  await call("window.__h.reset({}, { pairingCode: '87654321' })");
  await wait(400);
  assert.equal(await call('window.__h.clickTab(1)'), true, 'the pair tab must be clickable');
  await wait(200);
  assert.equal(await call("window.__h.typePhone('+905413749073')"), true, 'the phone input must exist');
  assert.equal(await call("window.__h.clickButton('kod|code')"), true, 'the submit button must be clickable');
  await wait(600);
  const s = await state();
  assert.equal(s.calls.pair, 1, `exactly one pairing request (got ${s.calls.pair})`);
  assert.equal(s.code, '87654321', `all 8 digits must be rendered, got "${s.code}"`);
});

await check('B: the code digits are actually painted wide enough to read', async () => {
  const w = await evaluate(`(function () {
    var cells = Array.from(document.body.querySelectorAll('span.font-mono'))
      .filter(function (s) { return (s.textContent || '').trim().length === 1; });
    if (!cells.length) return 0;
    return Math.min.apply(null, cells.map(function (c) { return c.getBoundingClientRect().width; }));
  })()`);
  assert.ok(w >= 20, `each code cell must be laid out (>=20px), got ${w}px`);
});

await check('B: after the phone links, the modal reaches CONNECTED and dismisses', async () => {
  await call('window.__h.set({ status: "CONNECTED", sessionId: 77, phone: "+905413749073" })');
  await settle();
  const s = await state();
  assert.ok(s.text.includes('+905413749073'), `connected number must be shown: ${s.text}`);
  await wait(2000);
  const s2 = await state();
  assert.ok(s2.closes >= 1, `the modal must dismiss itself (closes=${s2.closes})`);
});

// ------------------------------------------------------------- C. Failure
await check('C: a gateway failure shows the real error and leaves a retry', async () => {
  await call("window.__h.reset({ existingSessionId: 7 }, { pairFails: true })");
  await wait(400);
  await call('window.__h.clickTab(1)');
  await wait(200);
  await call("window.__h.typePhone('+905413749073')");
  await call("window.__h.clickButton('kod|code')");
  await wait(600);
  const s = await state();
  assert.equal(s.calls.pair, 1, `the request must actually have been attempted (got ${s.calls.pair})`);
  assert.ok(
    s.text.includes('hazirlanamadi') || s.text.includes('hazırlanamadı'),
    `the real gateway error must be visible, got: ${s.text}`,
  );
  assert.equal(s.code, '', 'a failed request must NOT show a code (fail closed)');
  assert.equal(s.hasPhoneInput, true, 'the phone input must remain so the user can retry');
  assert.equal(await call("window.__h.clickButton('kod|code')"), true, 'the submit button must be live again for a retry');
});

// -------------------------------------------------- D. cancel / retry (§14)
await check('D: QR -> cancel -> reopen starts a FRESH pairing and paints a NEW QR', async () => {
  await call('window.__h.reset({})');
  await wait(400);
  await call(`window.__h.set({ qr: ${JSON.stringify('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')} })`);
  await settle();
  let s = await state();
  const firstQr = s.qrSrc;
  assert.equal(s.calls.start, 1, `the first open must start exactly one pairing (got ${s.calls.start})`);
  assert.ok(firstQr, 'the first pairing must have painted a QR');

  // The user closes the modal. `onClose` is what the app wires to isOpen=false,
  // so the harness must flip it too — otherwise the component never runs its
  // reset-on-close branch and the test would be proving nothing.
  assert.equal(await call("window.__h.clickAria('close|kapat')"), true, 'the header close button must exist');
  await wait(600);
  s = await state();
  assert.ok(s.calls.cancel >= 1, `cancelling must purge the ephemeral pairing so no orphan row survives (cancel=${s.calls.cancel})`);
  assert.ok(s.closes >= 1, 'the modal must ask to be dismissed');
  await call('window.__h.open(false)');
  await wait(300);

  // Reopen with a brand new pairing whose QR differs from the first.
  await call(`window.__h.set({ qr: ${JSON.stringify('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')} })`);
  await call('window.__h.open(true)');
  await settle();
  s = await state();
  assert.equal(s.calls.start, 2, `reopening must start a NEW pairing, not reuse the cancelled one (got ${s.calls.start})`);
  assert.equal(s.tokenSeq, 2, `the second pairing must carry a different pair_token (tokenSeq=${s.tokenSeq})`);
  assert.ok(s.qrSrc, 'the new pairing must paint a QR');
  assert.notEqual(s.qrSrc, firstQr, 'the stale QR from the cancelled pairing must never survive');
  assert.ok(s.qrPainted, 'the new QR must be really painted');
});

await check('D: cancelling twice never reuses the first pair_token', async () => {
  // Guards the `pairTokenRef.current = null` in handleCancel: a stale ref would
  // make the second cancel target a token the backend has already dropped.
  const s = await state();
  assert.equal(s.calls.cancel, 1, 'only the first cancel is expected so far');
  await call("window.__h.clickAria('close|kapat')");
  await wait(600);
  const s2 = await state();
  assert.ok(s2.calls.cancel >= 2, `the second pairing must also be purged (cancel=${s2.calls.cancel})`);
});

await check('E: a failed start shows the real error and leaves a working retry', async () => {
  await call('window.__h.reset({}, { startFails: true })');
  await wait(600);
  let s = await state();
  assert.equal(s.calls.start, 1, `the start must actually have been attempted (got ${s.calls.start})`);
  assert.equal(s.qrSrc, null, 'a failed start must NOT leave a QR on screen (fail closed)');
  assert.ok(
    /hazirlanamadi|hazırlanamadı|prepar|failed|error/i.test(s.text),
    `the real backend error must be visible, got: ${s.text}`,
  );

  // The gateway recovers; the user retries.
  await call(`window.__h.set({ startFails: false, qr: ${JSON.stringify('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')} })`);
  assert.equal(await call("window.__h.clickButton('retry|tekrar|dene')"), true, 'the retry button must be live');
  await wait(900);
  s = await state();
  assert.equal(s.calls.start, 2, `the retry must issue a fresh start (got ${s.calls.start})`);
  assert.ok(s.qrSrc, 'the retry must paint the QR');
  assert.ok(s.qrPainted, 'the retried QR must be really painted');
});

// ------------------------------------------- F. mode-aware single-flight (§13)
await check('F: a QR-side failure does not block the phone pairing-code path', async () => {
  // The QR endpoint reports a hard error, so the modal lands in ERROR. The
  // ephemeral pairing itself still exists, so "Kod Al" must still be attempted.
  await call('window.__h.reset({}, { qrFails: true })');
  await settle();
  let s = await state();
  assert.equal(s.calls.start, 1, 'the pairing must have been created');
  assert.ok(/uretilemedi|üretilemedi|error/i.test(s.text), `the QR error must be visible: ${s.text}`);

  assert.equal(await call('window.__h.clickTab(1)'), true, 'the phone tab must still be reachable after a QR failure');
  await wait(200);
  assert.equal(await call("window.__h.typePhone('+905413749073')"), true, 'the phone input must exist');
  assert.equal(await call("window.__h.clickButton('kod|code')"), true, 'the code button must be clickable');
  await wait(700);
  s = await state();
  assert.equal(s.calls.pair, 1, `a QR failure must not suppress the pairing-code request (got ${s.calls.pair})`);
  assert.equal(s.code, '12345678', `the code must be rendered, got "${s.code}"`);
});

await check('F: a failed pairing code does not destroy the QR state or latch the guard', async () => {
  await call('window.__h.reset({}, { pairFails: true })');
  await wait(400);
  await call(`window.__h.set({ qr: ${JSON.stringify('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')} })`);
  await settle();
  let s = await state();
  assert.ok(s.qrSrc, 'the QR must be present before the code attempt');

  await call('window.__h.clickTab(1)');
  await wait(200);
  await call("window.__h.typePhone('+905413749073')");
  await call("window.__h.clickButton('kod|code')");
  await wait(700);
  s = await state();
  assert.equal(s.calls.pair, 1, 'the code request must have been attempted');
  assert.equal(s.code, '', 'a failed code request must not show a code');

  // Back to the QR tab: the failed code request must not have wiped the QR.
  await call('window.__h.clickTab(0)');
  await wait(300);
  s = await state();
  assert.equal(s.qrSrc, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'the QR must survive a failed pairing-code request');
  assert.ok(s.qrPainted, 'the surviving QR must still be painted');

  // The guard must have been released: a retry now succeeds.
  await call('window.__h.clickTab(1)');
  await wait(200);
  await call('window.__h.set({ pairFails: false })');
  assert.equal(await call("window.__h.clickButton('kod|code')"), true, 'the code button must be live again after a failure');
  await wait(700);
  s = await state();
  assert.equal(s.calls.pair, 2, `the retry must reach the backend (got ${s.calls.pair})`);
  assert.equal(s.code, '12345678', `the retry must render the code, got "${s.code}"`);
});

await cleanup();
ws.close();
console.log(`\nReal browser pairing (Chrome ${version.Browser}): ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nJSDOM AND BROWSER DISAGREE — the browser result is authoritative.');
  process.exit(1);
}
