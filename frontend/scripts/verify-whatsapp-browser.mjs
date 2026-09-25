/**
 * Phase 6.3 — REAL BROWSER verification of the WhatsApp chat UI.
 *
 * The jsdom harness (`verify-whatsapp-dom.mjs`) has no layout engine, so scroll
 * metrics there are simulated. This harness renders the SAME real components in
 * real Google Chrome over CDP, where layout, `scrollHeight`, `scrollTop` and
 * `scroll-smooth` animation are genuine.
 *
 * No new test framework: Chrome is driven directly over the DevTools Protocol
 * using Node's built-in WebSocket. Nothing is installed into the repo.
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
const PORT = 9333;

if (!existsSync(CHROME)) {
  console.log('SKIP: Google Chrome not found at ' + CHROME);
  console.log('Real-browser verification requires a Chrome install; jsdom results stand.');
  process.exit(0);
}

// --- 1. build a browser bundle of the REAL components ---------------------
const tmp = await mkdtemp(path.join(os.tmpdir(), 'wa-browser-'));
const entry = path.join(tmp, 'entry.tsx');
const bundle = path.join(tmp, 'bundle.js');

const mkMsg = (id, ts) => ({
  id,
  conversation_id: 1,
  direction: 'INBOUND',
  message_type: 'TEXT',
  status: 'RECEIVED',
  body: `mesaj-${id}#`,
  wa_message_id: `W${id}`,
  client_message_id: null,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
  external_timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
  sender_name: undefined,
  sender_phone: '',
  media_id: undefined,
  media_mime_type: undefined,
  media_filename: undefined,
  media_caption: undefined,
});

await writeFile(
  entry,
  `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChatThread } from '${SRC}/features/whatsapp/components/ChatThread';
import { ChatComposer } from '${SRC}/features/whatsapp/components/ChatComposer';
import { I18nProvider } from '${SRC}/context/I18nContext';

const mkMsg = ${JSON.stringify(null)};
const make = (id) => ({
  id, conversation_id: 1, direction: 'INBOUND', message_type: 'TEXT',
  status: 'RECEIVED', body: 'mesaj-' + id + '#', wa_message_id: 'W' + id,
  client_message_id: null,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
  external_timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
});

let convId = 1;
let threads = null;
let nextId = 5000;
let sent = [];
let root = null;
let renders = 0;
let mountSeq = 0;

const seed = () => ({
  1: Array.from({ length: 30 }, (_, i) => make(i + 1)),
  2: Array.from({ length: 50 }, (_, i) => make(i + 1000)),
});
threads = seed();

function App() {
  const [, setTick] = useState(0);
  return React.createElement(I18nProvider, null,
    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: 420 } },
      React.createElement('div', { id: 'thread', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
        React.createElement(ChatThread, {
          // Production contract: the thread is NOT keyed by conversation id.
          // A switch reuses the instance and the conversationKey prop resets it,
          // so the pane can never accumulate one stale thread root per chat.
          // mountSeq still remounts, because a real remount here means "the pane
          // was unmounted and built again" (fresh scenario / tab change), which
          // is a different event from a conversation switch.
          key: mountSeq,
          conversationKey: convId,
          messages: threads[convId],
          hasMore: hasMoreState,
          loading: false,
          loadingOlder,
          // ChatThread only arms its prepend-restore guard inside its own
          // load-older handler, so an older page MUST arrive through this prop.
          onLoadOlder: () => { requestOlder(30); },
          leadName: 'C' + convId,
        })
      ),
      React.createElement(ChatComposer, {
        key: convId + ':' + mountSeq,
        onSend: async (text) => { sent.push({ convId, text }); },
        onSendMediaFile: async () => {},
      })
    )
  );
}

function draw() { flushSync(() => { root.render(React.createElement(App)); }); renders += 1; }

let loadingOlder = false;
let olderRequests = 0;
let hasMoreState = true;

// ChatThread calls this when the user scrolls near the top (scrollTop < 60).
// It mirrors the real app: the page is "in flight" while loadingOlder is true,
// which is what stops one scroll from requesting page after page.
function requestOlder(n) {
  if (loadingOlder || !hasMoreState) return;
  olderRequests += 1;
  loadingOlder = true;
  draw();
  setTimeout(() => {
    const first = threads[convId][0].id;
    const older = Array.from({ length: n }, (_, i) => make(first - n + i));
    threads[convId] = [...older, ...threads[convId]];
    loadingOlder = false;
    // One page per scenario, so the restore arithmetic is unambiguous.
    hasMoreState = false;
    draw();
  }, 40);
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const scroller = () => document.querySelector('#thread div.overflow-y-auto');

async function settle(maxMs) {
  const el = scroller();
  if (!el) return;
  let last = -1, stable = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < (maxMs || 3000)) {
    await frame();
    const cur = el.scrollTop;
    if (Math.abs(cur - last) < 0.5) { stable += 1; if (stable >= 6) break; } else { stable = 0; }
    last = cur;
  }
}

window.__h = {
  async init() {
    root = createRoot(document.getElementById('root'));
    draw();
    await settle();
    return true;
  },
  // Give each scenario a clean slate: fresh thread data, no pill, remounted.
  async reset() {
    threads = seed(); convId = 1; sent = []; nextId = 5000; mountSeq += 1;
    loadingOlder = false; olderRequests = 0; hasMoreState = true;
    draw(); await frame(); await frame(); await settle(); await settle(1500);
    return true;
  },
  async select(id) { convId = id; draw(); await frame(); await frame(); await settle(); return true; },
  async inject() {
    const m = make(nextId++);
    threads[convId] = [...threads[convId], m];
    draw(); await frame(); await frame(); await settle();
    return m.id;
  },
  // behavior:'instant' bypasses scroll-behavior:smooth so the harness can
  // position the viewport deterministically without altering the component.
  async scrollToInstant(top) {
    const el = scroller();
    el.scrollTo({ top, behavior: 'instant' });
    // Read it back BEFORE settling: near the top this triggers an older-page
    // load, and the restore then moves scrollTop by the prepended height.
    const immediate = el.scrollTop;
    await frame(); await frame(); await settle();
    return immediate;
  },
  async toBottom() {
    const el = scroller();
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    await frame(); await frame(); await settle();
    return el.scrollTop;
  },
  async scrollTo(top) {
    const el = scroller();
    el.scrollTop = top;
    await frame(); await frame(); await settle();
    return el.scrollTop;
  },
  async typeDraft(text) {
    const input = document.querySelector('input[type="text"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await frame(); await frame();
    return input.value;
  },
  async send() {
    const input = document.querySelector('input[type="text"]');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await frame(); await frame(); await wait(50);
    return sent.slice();
  },
  state() {
    const el = scroller();
    const input = document.querySelector('input[type="text"]');
    const pill = document.querySelector('.bottom-4.right-4');
    return {
      convId,
      hasScroller: !!el,
      scrollTop: el ? el.scrollTop : null,
      scrollHeight: el ? el.scrollHeight : null,
      clientHeight: el ? el.clientHeight : null,
      atBottom: el ? (el.scrollHeight - el.clientHeight - el.scrollTop) <= 2 : null,
      pill: !!pill,
      // Anti-stacking counters: the pane must hold exactly one ChatThread root
      // and one scroller, no matter how many conversations were opened.
      threadRoots: document.querySelectorAll('#thread > div').length,
      scrollers: document.querySelectorAll('#thread div.overflow-y-auto').length,
      composerValue: input ? input.value : null,
      rows: el ? el.children.length : null,
      // The scroller can carry a trailing non-message element (pill anchor /
      // spacer), so take the LAST child that actually has text.
      lastMessage: el
        ? (Array.from(el.children)
            .map((c) => c.textContent || '')
            .filter((t) => t.trim().length > 0)
            .pop() || null)
        : null,
      threadText: el ? el.textContent : null,
      sent: sent.slice(),
      renders,
      olderRequests,
    };
  },
  markEl() { window.__prevEl = scroller(); return !!window.__prevEl; },
  sameEl() { return window.__prevEl === scroller(); },
};
`
);

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  outfile: bundle,
  absWorkingDir: frontendRoot,
  nodePaths: [path.join(frontendRoot, 'node_modules'), path.resolve(frontendRoot, '..', 'node_modules')],
  // Vite injects `import.meta.env`; outside Vite it is undefined and
  // `whatsappLatency.ts` reads `import.meta.env.DEV` at module scope.
  define: {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env':
      '{"DEV":false,"PROD":true,"MODE":"production",' +
      '"VITE_API_URL":"","VITE_WS_URL":"","VITE_GATEWAY_URL":"",' +
      '"VITE_WHATSAPP_LATENCY_PROFILING":"false"}',
  },
  logLevel: 'error',
});

// Tailwind decides the layout: without the real stylesheet `flex-1` /
// `overflow-y-auto` / `min-h-0` are inert and the thread never becomes
// scrollable. Ship the CSS the app actually ships.
const distCssDir = path.join(frontendRoot, 'dist', 'assets');
let css = '';
if (existsSync(distCssDir)) {
  const file = (await readdir(distCssDir)).find((f) => f.endsWith('.css'));
  if (file) css = await readFile(path.join(distCssDir, file), 'utf8');
}
if (!css) {
  console.log('WARNING: no built CSS found (run `npm run build`) — using a minimal layout shim');
  css = `.relative{position:relative}.flex{display:flex}.flex-col{flex-direction:column}
.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.overflow-y-auto{overflow-y:auto}
.p-4{padding:1rem}.scroll-smooth{scroll-behavior:smooth}`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>wa browser harness</title>
<style>${css}</style>
<style>html,body{margin:0}#root{height:420px}</style></head>
<body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`;
await writeFile(path.join(tmp, 'index.html'), html);

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
    // Chrome's own sandbox cannot initialize inside this agent sandbox
    // ("Operation not permitted"), which killed the GPU + network services and
    // left CDP unresponsive. Standard CI flags; the page is a local fixture.
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-software-rasterizer',
    '--disable-gpu',
    '--hide-scrollbars=false',
    '--window-size=900,700',
    base,
  ],
  { stdio: 'ignore' }
);

const cleanup = async () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { await new Promise((r) => server.close(r)); } catch {}
  try { await rm(tmp, { recursive: true, force: true }); } catch {}
};

/**
 * `/json/version` gives the BROWSER-level endpoint, which only speaks a subset
 * of CDP (no Page/Runtime). We need a PAGE target's own endpoint.
 */
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

async function browserVersion() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok ? await r.json() : { Browser: 'chrome' };
  } catch {
    return { Browser: 'chrome' };
  }
}

let target;
try {
  target = await waitForPageTarget();
} catch (e) {
  await cleanup();
  console.log('SKIP: could not start Chrome — ' + e.message);
  process.exit(0);
}
const version = await browserVersion();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('websocket connect failed'));
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? a.type)
      .join(' ');
    console.log(`  [page:${msg.params.type}] ${text}`);
  }
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
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || 'page exception');
  }
  return r.result.value;
};

await send('Runtime.enable');
// Chrome was launched directly at `base`, so no Page.navigate is needed.
// (Page.enable / Runtime.enable are not required for Runtime.evaluate.)
await new Promise((r) => setTimeout(r, 2000));

const probe = await evaluate('1+1');
if (probe !== 2) throw new Error('CDP Runtime.evaluate is not working');

// --- 4. scenarios ---------------------------------------------------------
let passed = 0;
let failed = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push([name, 'PASS']);
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed += 1;
    results.push([name, `FAIL: ${e.message}`]);
    console.log(`  FAIL - ${name}\n        ${e.message}`);
  }
}

const state = () => evaluate('window.__h.state()');
const call = (expr) => evaluate(expr);

console.log('\n=== real browser (Chrome, CDP) ===');

await call('window.__h.init()');
const s0 = await state();
assert.ok(s0.hasScroller, 'the thread scroll container must exist');
assert.ok(s0.scrollHeight > s0.clientHeight, `thread must be scrollable (${s0.scrollHeight} vs ${s0.clientHeight})`);

// A — conversation switch
await check('A: switching conversations lands on the newest message', async () => {
  await call('window.__h.reset()');
  // Read history WITHOUT crossing the 60px older-page trigger, or the thread
  // paginates and restores instead of staying put.
  await call('window.__h.scrollToInstant(300)');
  const a = await state();
  assert.ok(a.scrollTop > 60, `precondition: reading history, got ${a.scrollTop}`);
  assert.ok(!a.atBottom, 'precondition: away from the bottom');

  await call('window.__h.select(2)');
  const b = await state();
  assert.equal(b.convId, 2);
  assert.ok(b.atBottom, `B must open at the newest message (scrollTop=${b.scrollTop}, max=${b.scrollHeight - b.clientHeight})`);
  assert.equal(b.pill, false, 'no spurious new-message pill on switch');
});

// B — draft isolation (P6-5)
await check('B: a draft does not follow the user into another conversation', async () => {
  await call('window.__h.select(1)');
  await call('window.__h.typeDraft("A icin mesaj")');
  const a = await state();
  assert.equal(a.composerValue, 'A icin mesaj', 'draft must be typed');

  await call('window.__h.select(2)');
  const b = await state();
  assert.equal(b.composerValue, '', 'the switched-to composer must be empty');

  await call('window.__h.typeDraft("B icin mesaj")');
  const sent = await call('window.__h.send()');
  const texts = sent.map((s) => s.text);
  assert.deepEqual(texts, ['B icin mesaj'], "A's draft must never be sent to B");
});

// C — active chat, new inbound while at the bottom
await check('C: an inbound at the bottom stays pinned with no false pill', async () => {
  await call('window.__h.reset()');
  await call('window.__h.toBottom()');
  const before = await state();
  assert.ok(before.atBottom, 'precondition: at the bottom');
  const id = await call('window.__h.inject()');
  const after = await state();
  assert.ok((after.threadText || '').includes(`mesaj-${id}#`), 'the new message must be rendered');
  assert.ok(after.atBottom, 'must stay pinned to the bottom');
  assert.equal(after.pill, false, 'no new-message pill when already at the bottom');
});

// D — reading history + inbound
await check('D: reading history keeps the viewport and raises the pill', async () => {
  await call('window.__h.reset()');
  await call('window.__h.scrollTo(120)');
  const before = await state();
  assert.ok(!before.atBottom, 'precondition: away from the bottom');

  const id = await call('window.__h.inject()');
  const after = await state();
  assert.ok((after.threadText || '').includes(`mesaj-${id}#`), 'the inbound must be rendered');
  assert.equal(
    after.scrollTop,
    before.scrollTop,
    `the viewport must be preserved (${before.scrollTop} -> ${after.scrollTop})`
  );
  assert.equal(after.pill, true, 'the new-message pill must be raised');
});

// E — older history prepend keeps the visible anchor
await check('E: loading an older page keeps the same message in view', async () => {
  await call('window.__h.reset()');
  const before = await state();

  // Scrolling near the top is what makes ChatThread request an older page —
  // and what arms its restore guard.
  const landed = await call('window.__h.scrollToInstant(10)');
  assert.ok(landed < 60, `precondition: near the top (${landed})`);

  const after = await state();
  const diff = after.scrollHeight - before.scrollHeight;
  assert.ok(diff > 100, `an older page must add content (grew by ${diff}px)`);
  assert.equal(after.pill, false, 'a pure prepend must not raise the new-message pill');
  if (Math.abs(after.scrollTop - (landed + diff)) >= 8) {
    console.log(
      `        DEBUG rows ${before.rows}->${after.rows}, sh ${before.scrollHeight}->${after.scrollHeight}, ` +
        `diff ${diff}, landed ${landed}, got ${after.scrollTop}, olderRequests ${after.olderRequests}`
    );
  }
  assert.ok(
    Math.abs(after.scrollTop - (landed + diff)) < 8,
    'the viewport must be compensated by exactly the prepended height ' +
      `(expected ~${landed + diff}, got ${after.scrollTop})`
  );
});

// remount semantics: a switch must never destroy the thread (a destroyed root is
// what used to be able to survive in the pane); it must reset in place instead.
await check('F: a switch resets the same thread instance, an update in the same chat does not even that', async () => {
  await call('window.__h.select(1)');
  await call('window.__h.markEl()');
  await call('window.__h.select(2)');
  assert.equal(await call('window.__h.sameEl()'), true, 'a switch must reuse the thread DOM node, never replace it');
  const b = await state();
  assert.ok(b.atBottom, `the reused thread must still open on the newest message (scrollTop=${b.scrollTop}, max=${b.scrollHeight - b.clientHeight})`);
  assert.ok((b.threadText || '').includes('mesaj-1049#'), 'the new chat content must be rendered');
  assert.ok(!(b.threadText || '').includes('mesaj-30#'), "the previous chat's messages must be gone");

  await call('window.__h.markEl()');
  await call('window.__h.inject()');
  assert.equal(await call('window.__h.sameEl()'), true, 'an update in the same chat must not remount');
});

// G — does merely opening a chat request an older page?
//
// `scroll-behavior: smooth` on the container makes `scrollIntoView({behavior:
// 'auto'})` ANIMATE (it defers to CSS). The initial jump to the newest message
// therefore starts at scrollTop 0 and sweeps upward through the < 60px
// pagination trigger. jsdom cannot see this: it has no scrollIntoView at all.
await check('G: opening a conversation must not fetch an older page', async () => {
  await call('window.__h.reset()');
  const afterReset = await state();
  // Absolute, not a delta: the very first mount must not paginate either.
  assert.equal(
    afterReset.olderRequests,
    0,
    `mounting a chat fired ${afterReset.olderRequests} older-page request(s) with no user scroll`
  );

  await call('window.__h.select(2)');
  await new Promise((r) => setTimeout(r, 800));
  const after = await state();
  assert.equal(
    after.olderRequests,
    0,
    `opening a chat fired ${after.olderRequests} older-page request(s) with no user scroll`
  );
});

// H — the production defect: opening several conversations in a row left ONE
// stale thread root in the pane per clicked conversation (stacked chats).
await check('H: opening 6 conversations in a row leaves exactly one thread root in the pane', async () => {
  await call('window.__h.reset()');
  for (const id of [2, 1, 2, 1, 2]) await call(`window.__h.select(${id})`);
  const s = await state();
  assert.equal(s.threadRoots, 1, `the pane must hold one thread root, found ${s.threadRoots}`);
  assert.equal(s.scrollers, 1, `the pane must hold one scroll container, found ${s.scrollers}`);
  const inputs = await call('document.querySelectorAll(\'input[type="text"]\').length');
  assert.equal(inputs, 1, `the composer must not stack either, found ${inputs}`);
  assert.equal(s.convId, 2);
  assert.ok((s.threadText || '').includes('mesaj-1049#'), 'the visible chat must be the selected one');
  assert.ok(!(s.threadText || '').includes('mesaj-30#'), 'no other conversation may stay rendered');
  assert.ok(s.atBottom, 'the last opened conversation must be on its newest message');
});

await cleanup();
ws.close();

console.log(`\nReal browser (Chrome ${version.Browser}): ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nJSDOM AND BROWSER DISAGREE — the browser result is authoritative.');
  process.exit(1);
}
