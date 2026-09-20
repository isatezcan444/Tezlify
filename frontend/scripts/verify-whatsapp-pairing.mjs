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
      if (opts.startFails) return json({ detail: 'gateway unavailable' }, 503);
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
    if (u.includes('/whatsapp/pairing/') && u.endsWith('/pair')) {
      calls.pair += 1;
      if (opts.pairFails) return json({ detail: opts.pairErrorMessage || 'WhatsApp soketi hazırlanamadı.' }, 500);
      return json({ success: true, pairing_code: opts.pairingCode || '12345678', phone: '+905413749073' });
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
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { WhatsAppQrConnectModal } from ${JSON.stringify(path.join(SRC, 'features/whatsapp/components/WhatsAppQrConnectModal.tsx'))};
import { I18nProvider } from ${JSON.stringify(path.join(SRC, 'context/I18nContext.tsx'))};
import { ToastProvider } from ${JSON.stringify(path.join(SRC, 'context/ToastContext.tsx'))};

// Phase 6.8 harness: a parent that ACTUALLY honours onClose, so the modal's own
// lifecycle runs exactly as it does in the app (isOpen -> false -> effect
// cleanup). The plain mount() below pins isOpen=true and can never reproduce
// the production race.
function ConnectHarness(props) {
  const [isOpen, setIsOpen] = useState(true);
  window.__closeModal = () => setIsOpen(false);
  return React.createElement(WhatsAppQrConnectModal, {
    ...props,
    isOpen,
    onClose: () => setIsOpen(false),
  });
}

window.__P = { React, createRoot, act, WhatsAppQrConnectModal, I18nProvider, ToastProvider, ConnectHarness };
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
const { React, createRoot, act, WhatsAppQrConnectModal, I18nProvider, ToastProvider, ConnectHarness } = window.__P;
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
  // The modal portals into document.body; stale portals from a previous
  // scenario would make every query ambiguous.
  while (window.document.body.firstChild) window.document.body.removeChild(window.document.body.firstChild);
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

/**
 * Phase 6.8 — mount inside a parent that honours `onClose`.
 *
 * `mount()` pins `isOpen: true`, so the modal's lifecycle effect can never
 * re-run and its cleanup can never fire — which is precisely the production
 * trigger. This variant closes for real, so the cancellation path is exercised.
 */
async function mountHarness(props = {}) {
  while (window.document.body.firstChild) window.document.body.removeChild(window.document.body.firstChild);
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  let latest = props;
  const render = async (next = latest) => {
    latest = { ...latest, ...next };
    await act(async () => {
      root.render(h(I18nProvider, null, h(ToastProvider, null, h(ConnectHarness, latest))));
    });
  };
  await render();
  for (let i = 0; i < 40 && backend.calls.start === 0; i += 1) await tick(50);
  await tick(50);
  const view = { host, root, render, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
  currentView = view;
  return view;
}

/** Deliver a gateway WS event the way `wsManager` does in the app. */
const emitWs = async (detail) => {
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', { detail }));
  });
};

// The modal renders through createPortal(..., document.body), so every query
// must run against the document — not the React root host.
const body = () => window.document.body;
const qrImg = () => body().querySelector('img[alt="WhatsApp QR Code"]');
// Only the 8 CODE cells count. The modal header also uses `font-mono` for the
// session name ("Hat 1"), which would otherwise be concatenated into the code.
const codeDigits = () => Array.from(body().querySelectorAll('span.font-mono'))
  .map((s) => (s.textContent || '').trim())
  .filter((txt) => txt.length === 1 && /\d/.test(txt))
  .join('');

// The tab labels and the submit label differ per locale ("8 Haneli Kodu Al" in
// tr, "Get 8-Digit Code" in en), so match BOTH. The tab button must be
// excluded: "Link with Phone Number" / "Telefon No ile Bağlan" is not a submit.
const buttonByText = (re) => Array.from(body().querySelectorAll('button'))
  .find((b) => b.getAttribute('role') !== 'tab' && !b.disabled && re.test((b.textContent || '').trim()));

const openPairTab = async () => {
  const tabs = Array.from(body().querySelectorAll('[role="tab"]'));
  if (tabs.length < 2) throw new Error(`pair tab not rendered; text=${(body().textContent || '').slice(0, 120)}`);
  await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(120);
};

const typePhone = async (value) => {
  const input = body().querySelector('#pairing-phone-input');
  if (!input) throw new Error(`pair tab did not render the phone input; text=${(body().textContent || '').slice(0, 120)}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  return input;
};


console.log('\n=== WhatsApp pairing UI verification ===');

// ---------------------------------------------------------------- A. QR flow
await check('QR: a new session shows the QR once the gateway produces one', async () => {
  backend = makeBackend();
  installFetch();
  const v = await mount();
  // startPairing returns no QR yet -> INITIALIZING -> the 2.5s fallback poll
  // must fetch it. One tick is not enough; wait past a full poll interval.
  backend.state.qr = QR_A;
  await tick(2700);
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
  await openPairTab();
  await typePhone('+905413749073');
  const submit = buttonByText(/kod|code/i);
  assert.ok(submit, `submit button not found; buttons=${JSON.stringify(Array.from(body().querySelectorAll('button')).map((b) => (b.textContent || '').trim()))}`);
  await act(async () => { submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(120);
  assert.equal(backend.calls.pair, 1, `one pairing request (got ${backend.calls.pair})`);
  assert.equal(codeDigits(), '12345678', 'the code must be rendered in full, untruncated');
  await v.unmount();
});

await check('PHONE: a NEW session (no existing id) can also request a code', async () => {
  // THE ORIGINAL P6-8 DEFECT: no numeric session id exists yet, so the old
  // code path returned before doing anything — "Kod Al" was a silent no-op.
  backend = makeBackend({ pairingCode: '87654321' });
  installFetch();
  const v = await mount();
  await openPairTab();
  await typePhone('+905413749073');
  const submit = buttonByText(/kod|code/i);
  assert.ok(submit, 'submit button not found');
  await act(async () => { submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(200);
  assert.equal(backend.calls.pair, 1, `a new session must be able to request a code (got ${backend.calls.pair})`);
  assert.equal(codeDigits(), '87654321', 'the code must be displayed');
  // And it must have gone through the pair_token route, not a numeric id.
  assert.equal(backend.calls.start, 1, 'the pairing must already exist from mount');
  await v.unmount();
});

await check('PHONE: three rapid clicks issue ONE request (§12 single-flight)', async () => {
  // `disabled={isPairingLoading}` is not enough on its own: React has not
  // re-rendered when the second click lands, so the guard must be a ref.
  backend = makeBackend({ pairingCode: '11223344' });
  installFetch();
  const v = await mount({ existingSessionId: 7 });
  await openPairTab();
  await typePhone('+905413749073');
  const submit = buttonByText(/kod|code/i);
  assert.ok(submit, 'submit button not found');
  await act(async () => {
    const ev = () => new window.MouseEvent('click', { bubbles: true });
    submit.dispatchEvent(ev());
    submit.dispatchEvent(ev());
    submit.dispatchEvent(ev());
  });
  await tick(200);
  assert.equal(backend.calls.pair, 1, `rapid clicks must collapse to one request (got ${backend.calls.pair})`);
  assert.equal(codeDigits(), '11223344');
  await v.unmount();
});

await check('PHONE: a failed init must not latch the single-flight guard', async () => {
  // §12 REGRESSION: the guard is armed BEFORE `initSession()` runs. If the
  // bail-out returned from inside the guarded region, `pairingInFlightRef`
  // would stay `true` and every later click would be swallowed — "Kod Al"
  // would be permanently dead after one failed start. The guard must be
  // released on every exit path, including this one.
  backend = makeBackend({ pairingCode: '43218765', startFails: true });
  installFetch();
  const v = await mount();
  await openPairTab();
  await typePhone('+905413749073');
  const first = buttonByText(/kod|code/i);
  assert.ok(first, 'submit button not found');
  await act(async () => { first.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(200);
  assert.equal(backend.calls.pair, 0, 'no code can be requested without a pairing');

  // The gateway recovers: the second attempt must actually go through.
  backend = makeBackend({ pairingCode: '43218765' });
  installFetch();
  await openPairTab();
  await typePhone('+905413749073');
  const second = buttonByText(/kod|code/i);
  assert.ok(second, 'submit button must still be live');
  await act(async () => { second.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(300);
  assert.equal(backend.calls.pair, 1, `the retry must issue a request (got ${backend.calls.pair})`);
  assert.equal(codeDigits(), '43218765', 'the code must be displayed after the retry');
  await v.unmount();
});

await check('PHONE: a failure surfaces the real error and leaves a retry', async () => {
  const ERR = 'WhatsApp soketi hazırlanamadı.';
  backend = makeBackend({ pairFails: true, pairErrorMessage: ERR });
  installFetch();
  const v = await mount({ existingSessionId: 7 });
  await openPairTab();
  await typePhone('+905413749073');
  const submit = buttonByText(/kod|code/i);
  assert.ok(submit, 'submit button not found');
  await act(async () => { submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await tick(200);
  assert.ok((body().textContent || '').includes(ERR), 'the real gateway error must be visible');
  assert.equal(backend.calls.pair, 1);
  // Retry must be possible: the input is still there and the button is live.
  assert.ok(body().querySelector('#pairing-phone-input'), 'the phone input must remain for a retry');
  assert.ok(buttonByText(/kod|code/i), 'the submit button must be live again for a retry');
  await v.unmount();
});

// ------------------------------------------- C. Phase 6.8 promotion race
await check('PROMOTION: auto-close after session_connected must NOT cancel the pairing', async () => {
  // THE PRODUCTION DEFECT. The real order was:
  //   real phone scans -> Baileys 515 -> connection.open -> gateway promotes
  //   -> `session_connected` -> modal flips to CONNECTED and schedules onClose
  //   -> 1.5 s later the modal closes -> effect cleanup cancels the pairing
  //   -> gateway socket deleted ~1.8 s after the phone connected
  //   -> no durable CONNECTED row, every later event "unknown gateway session".
  backend = makeBackend();
  installFetch();
  const v = await mountHarness();
  backend.state.qr = QR_A;
  await tick(2700);
  assert.ok(qrImg(), 'the QR must be rendered before the scan');

  await emitWs({ event: 'session_connected', session_name: 'Hat 1', phone: '+905413749073' });
  await tick(200);
  // The modal auto-closes 1.5 s after `session_connected`; the close is what
  // used to run the cleanup that destroyed the promotion.
  await tick(2200);

  assert.equal(
    backend.calls.cancel, 0,
    'closing the QR UI after the scan cancelled the pairing — this is the defect that lost real pairings',
  );
  await v.unmount();
});

await check('PROMOTION: a React effect re-run after the scan must NOT cancel the pairing', async () => {
  // The lifecycle effect cleanup fires on EVERY dependency change
  // (`isOpen, initSession, clearTimers, existingSessionId`), so an ordinary
  // re-render during the promotion window was enough to kill it.
  backend = makeBackend();
  installFetch();
  const v = await mountHarness();
  backend.state.qr = QR_A;
  await tick(2700);

  await emitWs({ event: 'session_connecting', session_name: 'Hat 1' });
  await tick(120);
  const before = backend.calls.cancel;

  await v.render({ existingSessionId: 9 }); // forces the lifecycle effect to re-run
  await tick(300);

  assert.equal(
    backend.calls.cancel, before,
    'an effect re-run cancelled a pairing whose socket is already progressing toward CONNECTED',
  );
  await v.unmount();
});

await check('CANCEL: a pairing still waiting for a scan IS still cancelled', async () => {
  // Regression guard for the fix itself: it must not turn cancel into a no-op,
  // or every abandoned ephemeral gateway session leaks forever.
  backend = makeBackend();
  installFetch();
  const v = await mountHarness();
  backend.state.qr = QR_A;
  await tick(2700);
  assert.ok(qrImg(), 'the QR must be rendered');

  await act(async () => { window.__closeModal(); });
  await tick(300);

  assert.equal(
    backend.calls.cancel, 1,
    `a genuinely waiting pairing must still be torn down (got ${backend.calls.cancel})`,
  );
  await v.unmount();
});

await check('CANCEL: the pairing is cancelled at most once', async () => {
  backend = makeBackend();
  installFetch();
  const v = await mountHarness();
  backend.state.qr = QR_A;
  await tick(2700);

  await act(async () => { window.__closeModal(); });
  await tick(150);
  await v.render({ existingSessionId: 3 }); // a second cleanup must be a no-op
  await tick(300);

  assert.equal(backend.calls.cancel, 1, `cancel must be idempotent (got ${backend.calls.cancel})`);
  await v.unmount();
});

// ------------------------------- C2. Phase 6.8 finding 7 — terminal gateway status
//
// These two checks were written during the §11 review, found VACUOUS (they passed
// under a deliberately-broken guard predicate), and removed — because at that time
// `applyTerminalGatewayStatus` was never reached for an ephemeral pairing, so the
// `FAILED` lifecycle was unreachable while a pair token was held and the guard's
// behaviour on it was unobservable. Finding 7 fixed exactly that: the ephemeral
// poll and the ephemeral refresh now both call `applyTerminalGatewayStatus`. The
// state is reachable now, so the checks are restored — and they are falsifiable.
await check('TERMINAL: an errored pairing is still torn down, not mistaken for a promotion', async () => {
  // Regression guard for the guard itself: a `!CANCELLABLE.includes(state)`
  // predicate classified FAILED as "promoted", so an errored pairing refused to
  // release its gateway socket and leaked it forever.
  backend = makeBackend();
  installFetch();
  const v = await mountHarness();
  backend.state.qr = QR_A;
  await tick(2700);
  assert.ok(qrImg(), 'the QR must be rendered before the gateway errors');

  // The gateway drops the socket: it has no QR any more, and reports a terminal
  // status. The ephemeral poll must learn this (finding 7).
  backend.state.qr = null;
  backend.state.status = 'RELINK_REQUIRED';
  await tick(3000);

  // Finding 7's own mechanism, pinned. Pre-finding-7 the poll reacted only to
  // `error_message`, so a terminal status carrying none was ignored and a QR
  // that could never work stayed on screen. This assertion is what fails when
  // the `applyTerminalGatewayStatus` call site is missing — the cancel guard
  // below alone would NOT have noticed (a never-terminal pairing stays
  // cancellable, so `cancel === 1` would still hold).
  assert.ok(!qrImg(), 'the dead QR must be removed once the gateway is terminal');

  await act(async () => { window.__closeModal(); });
  await tick(400);

  assert.equal(
    backend.calls.cancel, 1,
    `an errored pairing must still release its gateway socket (cancel=${backend.calls.cancel})`,
  );
  await v.unmount();
});

await check('TERMINAL: pressing Cancel on an errored pairing must not claim CONNECTED', async () => {
  // The same mis-classification from the other guard site: `handleCancel`
  // preserved the pairing, set modalState CONNECTED and skipped the cancel — so an
  // explicit Cancel on a failed pairing told the user their line had connected,
  // and left the gateway socket running.
  backend = makeBackend();
  installFetch();
  const v = await mountHarness();
  backend.state.qr = QR_A;
  await tick(2700);

  backend.state.qr = null;
  backend.state.status = 'RELINK_REQUIRED';
  await tick(3000);

  const closeBtn = body().querySelector('button[aria-label="Close"]');
  assert.ok(closeBtn, 'the modal must expose its Close control');
  await act(async () => { closeBtn.click(); });
  await tick(400);

  assert.equal(
    backend.calls.cancel, 1,
    `Cancel on an errored pairing must release the socket, not preserve it (cancel=${backend.calls.cancel})`,
  );
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
