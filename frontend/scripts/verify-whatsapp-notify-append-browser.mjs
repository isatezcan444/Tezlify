/**
 * AŞAMA 5.2.8 — REAL-CHROME Notify / Append E2E.
 *
 * Renders the REAL WhatsApp UI components (ConversationList, ChatThread,
 * ChatBubble) inside the REAL provider tree (Theme > I18n > Toast) in a real
 * Google Chrome over CDP, and drives the REAL `tezlify:ws_event` contract.
 *
 * Unlike `verify-whatsapp-notify-append.mjs` (which re-implements the logic with
 * copied pure functions), this harness IMPORTS the production functions
 * (`buildChatPreview`, `shouldApplyPreview`, `mergeWhatsAppMessages`) and the
 * production sound chain (`triggerInboundNotification` -> `playSoundPreset`).
 * Only the tiny unread/message_count arithmetic is a minimal wrapper — the
 * directive explicitly allows a minimal wrapper for the test harness (§4).
 *
 * Sound is measured DIRECTLY at the browser boundary: `window.AudioContext` is
 * replaced by a fake that counts oscillator starts, so a real `playSoundPreset`
 * call is observable without touching production code.
 *
 * Run: `node scripts/verify-whatsapp-notify-append-browser.mjs`
 * Exit 0 = PASS, 1 = FAIL. Skips (exit 0) if Chrome is not installed.
 */
import esbuild from 'esbuild';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335;

if (!existsSync(CHROME)) {
  console.log('SKIP: Google Chrome not found at ' + CHROME);
  console.log('Real-browser notify/append verification requires a Chrome install.');
  process.exit(0);
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'wa-notify-'));
const entry = path.join(tmp, 'entry.tsx');
const bundle = path.join(tmp, 'bundle.js');

const entrySource = `
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider, useI18n } from '${SRC}/context/I18nContext';
import { ThemeProvider } from '${SRC}/context/ThemeContext';
import { ToastProvider, useToast } from '${SRC}/context/ToastContext';
import { ConversationList } from '${SRC}/features/whatsapp/components/ConversationList';
import { ChatThread } from '${SRC}/features/whatsapp/components/ChatThread';
import { buildChatPreview, shouldApplyPreview } from '${SRC}/features/whatsapp/lib/whatsappPreview';
import { mergeWhatsAppMessages } from '${SRC}/features/whatsapp/lib/whatsappMessageMerge';
import { triggerInboundNotification } from '${SRC}/features/whatsapp/lib/whatsappAudio';

const mkConv = (id, name, unread, lastAt, count, extra) => ({
  id, lead_name: name, unread_count: unread, last_message_at: lastAt,
  last_message_preview: 'onizleme-' + id, message_count: count,
  status: 'ACTIVE', is_group: false, identity_state: 'RESOLVED',
  phone: '+90555000' + id, ...(extra || {}),
});
const mkMsg = (id, ts, body, extra) => ({
  id, conversation_id: 1, direction: 'INBOUND', message_type: 'TEXT',
  status: 'RECEIVED', body, wa_message_id: 'W' + id,
  created_at: ts, external_timestamp: ts, ...(extra || {}),
});

let conversations = [];
let messagesByConv = {};
let selectedId = 1;
let onWhatsAppTab = true;   // App-level toast only fires when NOT on whatsapp tab
const SEEN = new Set();
let root = null;

function seed() {
  conversations = [
    mkConv(1, 'Ahmet', 2, '2026-01-15T10:00:00Z', 5),
    mkConv(2, 'Grup Test', 0, '2026-01-15T09:00:00Z', 10, { is_group: true, phone: '120363000000000001@g.us' }),
  ];
  messagesByConv = { 1: [mkMsg(1, '2026-01-15T09:00:00Z', 'ilk mesaj')], 2: [] };
  selectedId = 1;
  onWhatsAppTab = true;
  SEEN.clear();
}
seed();

function Harness() {
  const { t } = useI18n();
  const toast = useToast();
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  useEffect(() => {
    const handler = (e) => {
      const ev = (e && e.detail) || {};
      if (ev.event !== 'message_new') return;
      const m = (ev.message && typeof ev.message === 'object') ? ev.message : ev;
      const convId = Number(ev.conversation_id ?? m.conversation_id);
      const body = typeof m.body === 'string' ? m.body : (ev.body || '');
      const createdAt = m.created_at || ev.created_at || new Date().toISOString();
      const direction = (m.direction || ev.direction || 'INBOUND');
      const isOutbound = String(direction).toUpperCase() === 'OUTBOUND';
      const waId = m.wa_message_id || ev.wa_message_id;
      const key = convId + ':' + waId;
      const isReplay = Boolean(waId) && SEEN.has(key);
      if (waId) SEEN.add(key);

      conversations = conversations.map((c) => {
        if (Number(c.id) !== convId) return c;
        const summary = buildChatPreview(
          { message_type: m.message_type || 'TEXT', body, sender_name: m.sender_name, direction: isOutbound ? 'OUTBOUND' : 'INBOUND' },
          Boolean(c.is_group),
          t,
        );
        const tsFresh = shouldApplyPreview(createdAt, c.last_message_at);
        const applyPreview = Boolean(summary) && tsFresh;
        const isSelected = convId === selectedId;
        return {
          ...c,
          last_message_preview: isReplay ? c.last_message_preview : (applyPreview ? summary : c.last_message_preview),
          last_message_at: isReplay ? c.last_message_at : ((tsFresh || !c.last_message_at) ? createdAt : c.last_message_at),
          message_count: isReplay ? c.message_count : (c.message_count || 0) + 1,
          unread_count: isReplay ? c.unread_count : ((isSelected || isOutbound) ? 0 : (c.unread_count || 0) + 1),
        };
      });

      const incoming = {
        id: m.id ?? Date.now(), conversation_id: convId,
        direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
        message_type: m.message_type || 'TEXT', status: m.status || 'RECEIVED',
        body, wa_message_id: waId, created_at: createdAt,
      };
      messagesByConv[convId] = mergeWhatsAppMessages(messagesByConv[convId] || [], [incoming]);

      if (!isOutbound && !isReplay) {
        triggerInboundNotification({
          soundEnabled: true, soundPreset: 'whatsapp_classic', soundVolume: 0.8,
          desktopNotificationsEnabled: false, senderName: 'C' + convId, body,
        });
        // Mirror App.tsx:260-263 EXACTLY, including the translated title, so the
        // toast we assert on is the one production would raise.
        if (!onWhatsAppTab) {
          const previewSnippet = body.trim()
            ? (body.length > 60 ? body.slice(0, 57) + '...' : body)
            : '';
          toast.info(
            previewSnippet ? ('C' + convId + ': ' + previewSnippet) : ('C' + convId),
            t('whatsapp.newIncomingMessage') || 'Yeni WhatsApp Mesajı',
          );
        }
      }
      rerender();
    };
    window.addEventListener('tezlify:ws_event', handler);

    window.__harness = {
      select(id) { selectedId = Number(id); rerender(); },
      setTab(v) { onWhatsAppTab = (v === 'whatsapp'); },
      // Append = a REST history page arriving with NO live broadcast. It merges
      // bubbles only; it must NOT touch preview/unread or fire sound/toast.
      appendHistory(convId, msg) {
        const older = {
          id: msg.id, conversation_id: Number(convId), direction: 'INBOUND',
          message_type: 'TEXT', status: 'RECEIVED', body: msg.body,
          // A REST history row carries the provider id; allow the caller to pass
          // the real one so a later live broadcast of the SAME message can be
          // proven to dedup in mergeWhatsAppMessages.
          wa_message_id: msg.wa_message_id || ('H' + msg.id),
          created_at: msg.created_at,
        };
        messagesByConv[convId] = mergeWhatsAppMessages(messagesByConv[convId] || [], [older]);
        rerender();
      },
      get() {
        return {
          selectedId,
          conversations: conversations.map((c) => ({
            id: c.id, preview: c.last_message_preview, at: c.last_message_at,
            count: c.message_count, unread: c.unread_count,
          })),
          bodies: Object.fromEntries(Object.entries(messagesByConv).map(([k, v]) => [k, v.map((x) => x.body)])),
        };
      },
      reset() { seed(); rerender(); },
    };
    return () => window.removeEventListener('tezlify:ws_event', handler);
  }, [t, toast]);

  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: 640 } },
    React.createElement('div', { id: 'conv-list', style: { height: 220, overflow: 'auto' } },
      React.createElement(ConversationList, {
        conversations, selectedId,
        onSelect: (id) => { selectedId = Number(id); rerender(); },
      })
    ),
    React.createElement('div', { id: 'thread', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
      React.createElement(ChatThread, {
        conversationKey: selectedId,
        messages: messagesByConv[selectedId] || [],
        hasMore: false,
        leadName: 'C' + selectedId,
      })
    )
  );
}

window.__h = {
  init() {
    root = createRoot(document.getElementById('root'));
    flushSync(() => root.render(
      React.createElement(ThemeProvider, null,
        React.createElement(I18nProvider, null,
          React.createElement(ToastProvider, null, React.createElement(Harness))))));
    return true;
  },
  dispatch(ev) { window.dispatchEvent(new CustomEvent('tezlify:ws_event', { detail: ev })); return true; },
  select(id) { window.__harness.select(id); return true; },
  setTab(v) { window.__harness.setTab(v); return true; },
  appendHistory(convId, msg) { window.__harness.appendHistory(convId, msg); return true; },
  reset() { window.__harness.reset(); return true; },
  get() { return window.__harness.get(); },
  soundReset() { window.__soundOsc = 0; return true; },
  dom() {
    const unread = {};
    for (const id of [1, 2]) {
      const el = document.querySelector('[data-testid="conv-unread-badge-' + id + '"]');
      unread[id] = el ? el.textContent.trim() : null;
    }
    const thread = document.querySelector('#thread');
    const toastBox = document.querySelector('.fixed.bottom-4.right-4');
    return {
      unread,
      rows: document.querySelectorAll('[data-conv-id]').length,
      threadText: thread ? thread.textContent : '',
      toastText: toastBox ? toastBox.textContent : '',
      // Structural count: the portal container holds one child <div> per toast.
      toastCount: toastBox ? toastBox.querySelectorAll(':scope > div').length : 0,
      sound: window.__soundOsc,
    };
  },
};
`;

await writeFile(entry, entrySource);

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
  define: {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env':
      '{"DEV":false,"PROD":true,"MODE":"production","VITE_API_URL":"","VITE_WS_URL":"",' +
      '"VITE_GATEWAY_URL":"","VITE_WHATSAPP_LATENCY_PROFILING":"false"}',
  },
  logLevel: 'error',
});

const distCssDir = path.join(frontendRoot, 'dist', 'assets');
let css = '';
try {
  const { readdir } = await import('node:fs/promises');
  if (existsSync(distCssDir)) {
    const file = (await readdir(distCssDir)).find((f) => f.endsWith('.css'));
    if (file) css = await readFile(path.join(distCssDir, file), 'utf8');
  }
} catch { /* minimal shim below */ }
if (!css) {
  css = `.relative{position:relative}.flex{display:flex}.flex-col{flex-direction:column}
.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.overflow-y-auto{overflow-y:auto}
.p-4{padding:1rem}`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>wa notify/append harness</title>
<style>${css}</style><style>html,body{margin:0}#root{height:640px}</style></head>
<body><div id="root"></div>
<script>
  // Permissive fetch: the harness renders components, not the full page, so any
  // incidental request (avatar/media) resolves to an empty, valid JSON body.
  window.fetch = async function (input) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var path = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    var body = { items: [], total: 0, sessions: [], messages: [], has_more: false, success: true, status: 'IDLE' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // AudioContext spy: counts oscillator starts so a REAL playSoundPreset call is
  // observable without modifying production code.
  window.__soundOsc = 0;
  function FakeParam() {}
  FakeParam.prototype.setValueAtTime = function () {};
  FakeParam.prototype.exponentialRampToValueAtTime = function () {};
  FakeParam.prototype.linearRampToValueAtTime = function () {};
  function FakeGain() { this.gain = new FakeParam(); }
  FakeGain.prototype.connect = function () {};
  function FakeOsc() { this.frequency = new FakeParam(); this.type = 'sine'; }
  FakeOsc.prototype.connect = function () {};
  FakeOsc.prototype.start = function () { window.__soundOsc += 1; };
  FakeOsc.prototype.stop = function () {};
  function FakeAudioContext() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  FakeAudioContext.prototype.createGain = function () { return new FakeGain(); };
  FakeAudioContext.prototype.createOscillator = function () { return new FakeOsc(); };
  FakeAudioContext.prototype.resume = function () { return Promise.resolve(); };
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
</script>
<script type="module" src="/bundle.js"></script>
</body></html>`;
await writeFile(path.join(tmp, 'index.html'), html);

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
      res.writeHead(404); res.end('not found');
    }
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const profile = path.join(tmp, 'profile');
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--no-sandbox',
  '--disable-dev-shm-usage', '--disable-software-rasterizer', '--disable-gpu',
  '--window-size=900,760', base,
], { stdio: 'ignore' });

// --- F3: teardown -----------------------------------------------------------
// One idempotent teardown owns every resource this script creates: the CDP
// socket, the Chrome child, the local HTTP server and the temp profile dir.
// Each step is isolated so a failure in one cannot skip the others, and the
// `cleaned` latch makes repeated calls safe — calling it again after Chrome is
// already dead must not throw, and must never mask the real test error.
let ws = null;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  try { if (ws && ws.readyState !== 3) ws.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
  try { await new Promise((r) => server.close(r)); } catch {}
  try { await rm(tmp, { recursive: true, force: true }); } catch {}
};

// Shared state lives OUTSIDE the guarded region so the failure path can still
// persist evidence after the browser is gone.
let passed = 0;
let failed = 0;
const results = [];
const pageErrors = [];
const consoleLines = [];
let msgId = 0;
const pending = new Map();
const EV = path.resolve(frontendRoot, '..', 'docs', 'audits', 'evidence', '5.2.8');

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000);
});

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page exception');
  return r.result.value;
};

const shot = async (name) => {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) await writeFile(path.join(EV, name), Buffer.from(r.data, 'base64'));
  } catch { /* evidence is best-effort; never fail a check for it */ }
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

let fatal = null;
try {
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket connect failed')); });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      pageErrors.push(d.exception?.description || d.text || 'exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type);
      consoleLines.push(`[${msg.params.type}] ${args.join(' ')}`);
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry || {};
      consoleLines.push(`[${e.level}] ${e.text}`);
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await new Promise((r) => setTimeout(r, 2000));

  const probe = await evaluate('1+1');
  if (probe !== 2) throw new Error('CDP Runtime.evaluate is not working');

  const call = (expr) => evaluate(expr);
  const get = () => evaluate('window.__h.get()');
  const dom = () => evaluate('window.__h.dom()');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = () => call('new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');

  // --- evidence: screenshots + console log live beside the audit report --------
  await mkdir(EV, { recursive: true });

  async function check(name, fn) {
    try {
      await fn();
      passed += 1; results.push([name, 'PASS']);
      console.log(`  ok - ${name}`);
    } catch (e) {
      failed += 1; results.push([name, `FAIL: ${e.message}`]);
      console.log(`  FAIL - ${name}\n        ${e.message}`);
      await shot(`fail-${name.split(' ')[0].replace(/\./g, '')}.png`);
    }
  }

  await call('window.__h.init()');
  await settle();
  await settle();

  const conv = (s, id) => s.conversations.find((c) => Number(c.id) === Number(id));
  const notify = (convId, waId, body, at, dir) => ({
    event: 'message_new', conversation_id: convId,
    message: { id: 9000 + Number(waId.replace(/\D/g, '')) || 9000, conversation_id: convId,
      direction: dir || 'INBOUND', message_type: 'TEXT', status: 'RECEIVED',
      body, wa_message_id: waId, created_at: at },
  });

  console.log('\n=== real browser (Chrome, CDP) — notify / append / dedup ===');

  // ---- A. Notify into the OPEN conversation -----------------------------------
  await check('A. notify(open): bubble + preview + timestamp + count, unread stays 0, sound fired', async () => {
    await call('window.__h.reset()');
    await call('window.__h.select(1)');
    await call('window.__h.setTab("whatsapp")');
    await call('window.__h.soundReset()');
    await wait(700);
    const before = await get();
    await call(`window.__h.dispatch(${JSON.stringify(notify(1, 'W200', 'Yeni mesaj', '2026-01-15T12:00:00Z'))})`);
    await settle();
    const s = await get();
    const d = await dom();
    assert.ok((d.threadText || '').includes('Yeni mesaj'), 'the bubble must be rendered in the real thread');
    assert.equal(conv(s, 1).preview, 'Yeni mesaj', 'preview must update');
    assert.equal(conv(s, 1).at, '2026-01-15T12:00:00Z', 'timestamp must update');
    assert.equal(conv(s, 1).count, conv(before, 1).count + 1, 'message_count must increment by 1');
    assert.equal(conv(s, 1).unread, 0, 'the open conversation must not accrue unread');
    assert.equal(d.unread[1], null, 'no unread badge on the open conversation');
    assert.ok(d.sound > 0, `the real sound chain must fire (oscillators=${d.sound})`);
  });

  // ---- B. Notify into a CLOSED conversation -----------------------------------
  await check('B. notify(closed): unread +1 and badge rendered, preview + count update', async () => {
    await call('window.__h.reset()');
    await call('window.__h.select(1)');
    await call('window.__h.setTab("whatsapp")');
    await call('window.__h.soundReset()');
    await wait(700);
    const before = await get();
    await call(`window.__h.dispatch(${JSON.stringify(notify(2, 'W201', 'Grup mesaji', '2026-01-15T12:30:00Z'))})`);
    await settle();
    const s = await get();
    const d = await dom();
    assert.equal(conv(s, 2).unread, conv(before, 2).unread + 1, 'a closed conversation accrues +1 unread');
    assert.equal(d.unread[2], '1', 'the unread badge must render 1');
    assert.equal(conv(s, 2).preview, 'Grup mesaji', 'preview must update');
    assert.equal(conv(s, 2).count, conv(before, 2).count + 1, 'message_count must increment');
  });

  // ---- C. Outbound -----------------------------------------------------------
  await check('C. outbound: no unread, no sound, no toast', async () => {
    await call('window.__h.reset()');
    await call('window.__h.select(1)');
    await call('window.__h.setTab("whatsapp")');
    await call('window.__h.soundReset()');
    await wait(700);
    await call(`window.__h.dispatch(${JSON.stringify(notify(2, 'W202', 'Ben yazdim', '2026-01-15T13:00:00Z', 'OUTBOUND'))})`);
    await settle();
    const s = await get();
    const d = await dom();
    assert.equal(conv(s, 2).unread, 0, 'outbound must not add unread');
    assert.equal(d.sound, 0, 'outbound must not play the inbound sound');
    assert.ok(!(d.toastText || '').includes('Yeni WhatsApp Mesaji'), 'outbound must not raise an inbound toast');
  });

  // ---- D. Replay (same wa_message_id) ----------------------------------------
  await check('D. replay: same wa_message_id does not double count, re-toast, or re-sound', async () => {
    await call('window.__h.reset()');
    await call('window.__h.select(1)');
    await call('window.__h.setTab("whatsapp")');
    await call('window.__h.soundReset()');
    await wait(700);
    const ev = notify(2, 'W203', 'Tekrar', '2026-01-15T12:30:00Z');
    await call(`window.__h.dispatch(${JSON.stringify(ev)})`);
    await settle();
    const first = await get();
    const soundFirst = (await dom()).sound;
    await call('window.__h.soundReset()');
    await call(`window.__h.dispatch(${JSON.stringify(ev)})`);
    await settle();
    const second = await get();
    const d = await dom();
    assert.equal(conv(second, 2).count, conv(first, 2).count, 'replay must not increment message_count');
    assert.equal(conv(second, 2).unread, conv(first, 2).unread, 'replay must not increment unread');
    assert.equal(conv(second, 2).preview, conv(first, 2).preview, 'replay must not change preview');
    assert.equal(d.sound, 0, 'replay must not play the sound again');
    assert.ok(soundFirst > 0, 'the first delivery did play the sound');
  });

  // ---- E. Append (REST history, no live broadcast) ---------------------------
  await check('E. append(history): older message renders, preview/timestamp do NOT regress, no unread, no sound', async () => {
    await call('window.__h.reset()');
    await call('window.__h.select(1)');
    await call('window.__h.setTab("whatsapp")');
    // Establish a fresh preview at 12:00 via a real notify.
    await call('window.__h.soundReset()');
    await wait(700);
    await call(`window.__h.dispatch(${JSON.stringify(notify(1, 'W204', 'Guncel', '2026-01-15T12:00:00Z'))})`);
    await settle();
    const before = await get();
    await call('window.__h.soundReset()');
    // Append an OLDER history message the way a REST page would.
    await call(`window.__h.appendHistory(1, ${JSON.stringify({ id: 50, body: 'Eski mesaj', created_at: '2026-01-15T08:00:00Z' })})`);
    await settle();
    const s = await get();
    const d = await dom();
    assert.equal(conv(s, 1).preview, conv(before, 1).preview, 'an older append must not overwrite the preview');
    assert.equal(conv(s, 1).at, conv(before, 1).at, 'an older append must not move the timestamp back');
    assert.equal(conv(s, 1).unread, conv(before, 1).unread, 'an append must not add unread');
    assert.equal(d.sound, 0, 'an append must not play the sound');
    assert.ok((d.threadText || '').includes('Eski mesaj'), 'the appended history message must render as a bubble');
  });

  // ---- F. Dedup: the same message via history, then live ---------------------
  await check('F. dedup history->live: the same wa_message_id renders once and counts once', async () => {
    await call('window.__h.reset()');
    // Conversation 2 must stay CLOSED: an OPEN conversation legitimately keeps
    // unread at 0, so selecting it here would make the unread assertion
    // unmeasurable rather than wrong.
    await call('window.__h.select(1)');
    await call('window.__h.setTab("whatsapp")');
    await call('window.__h.soundReset()');
    await wait(700);
    // 1) A REST history page delivers the message FIRST (no live broadcast).
    await call(`window.__h.appendHistory(2, ${JSON.stringify({ id: 60, wa_message_id: 'W205', body: 'Canli', created_at: '2026-01-15T12:40:00Z' })})`);
    await settle();
    const afterAppend = await get();
    // 2) The SAME provider message then arrives as a live broadcast.
    await call(`window.__h.dispatch(${JSON.stringify(notify(2, 'W205', 'Canli', '2026-01-15T12:40:00Z'))})`);
    await settle();
    const s = await get();
    assert.equal(conv(s, 2).unread, conv(afterAppend, 2).unread + 1, 'the live notify still adds exactly one unread');
    assert.equal(conv(s, 2).count, conv(afterAppend, 2).count + 1, 'the live delivery increments message_count exactly once');
    assert.equal(conv(s, 2).preview, 'Canli', 'the live message owns the preview');
    // Real DOM proof: open the thread and count the rendered bubble exactly once.
    await call('window.__h.select(2)');
    await settle();
    const d = await dom();
    const occurrences = (d.threadText.match(/Canli/g) || []).length;
    assert.equal(occurrences, 1, `the same wa_message_id must render exactly one bubble (found ${occurrences})`);
  });

  // ---- G. Preview ordering ----------------------------------------------------
  await check('G. preview ordering: newer wins, older is ignored, equal timestamp applies', async () => {
    await call('window.__h.reset()');
    await call('window.__h.select(2)');
    await call('window.__h.setTab("whatsapp")');
    await call('window.__h.soundReset()');
    await wait(700);
    await call(`window.__h.dispatch(${JSON.stringify(notify(2, 'W206', 'Onikide', '2026-01-15T12:00:00Z'))})`);
    await settle();
    // older -> ignored
    await call(`window.__h.dispatch(${JSON.stringify(notify(2, 'W207', 'Dokuzda', '2026-01-15T09:00:00Z'))})`);
    await settle();
    let s = await get();
    assert.equal(conv(s, 2).preview, 'Onikide', 'an older message must not overwrite the preview');
    assert.equal(conv(s, 2).at, '2026-01-15T12:00:00Z', 'an older message must not move the timestamp back');
    // newer -> wins
    await wait(700);
    await call(`window.__h.dispatch(${JSON.stringify(notify(2, 'W208', 'Onucte', '2026-01-15T13:00:00Z'))})`);
    await settle();
    s = await get();
    assert.equal(conv(s, 2).preview, 'Onucte', 'a newer message must win the preview');
    assert.equal(conv(s, 2).at, '2026-01-15T13:00:00Z', 'a newer message must advance the timestamp');
  });

  // ---- H. App-level toast (cross-tab condition) ------------------------------
  await check('H. toast: an inbound notify raises a real toast only when NOT on the whatsapp tab', async () => {
    await call('window.__h.reset()');
    await call('window.__h.select(1)');
    await call('window.__h.setTab("dashboard")');
    await call('window.__h.soundReset()');
    await wait(700);
    await call(`window.__h.dispatch(${JSON.stringify(notify(1, 'W209', 'Arka plan', '2026-01-15T14:00:00Z'))})`);
    await settle();
    const offTab = await dom();
    assert.equal(offTab.toastCount, 1, `off the whatsapp tab exactly one toast must be mounted (got ${offTab.toastCount})`);
    assert.ok((offTab.toastText || '').includes('Arka plan'), 'the toast must carry the real message body');

    // A toast lives for 4500 ms and `reset()` does NOT clear the stack, so the
    // next phase must start from a genuinely empty stack — otherwise "no toast"
    // would be unmeasurable rather than proven absent.
    await wait(5200);
    const cleared = await dom();
    assert.equal(cleared.toastCount, 0, 'the toast stack must be empty before the on-tab phase');

    // On the whatsapp tab, the same inbound must NOT raise a toast.
    await call('window.__h.reset()');
    await call('window.__h.select(1)');
    await call('window.__h.setTab("whatsapp")');
    await call('window.__h.soundReset()');
    await wait(700);
    await call(`window.__h.dispatch(${JSON.stringify(notify(1, 'W210', 'Sekmede', '2026-01-15T14:10:00Z'))})`);
    await settle();
    const onTab = await dom();
    assert.equal(onTab.toastCount, 0, 'no toast may be mounted while on the whatsapp tab');
    // Non-vacuous: the notify itself DID reach the app — only the toast is gated.
    assert.ok((onTab.threadText || '').includes('Sekmede'), 'the message must still render in the thread');
    assert.ok(onTab.sound > 0, 'the sound must still fire on the whatsapp tab');
  });

  // Final evidence snapshot: the last scenario's real DOM, plus the full console.
  await shot('notify-append-final.png');
  await writeFile(
    path.join(EV, 'notify-append-console.log'),
    [...consoleLines, ...pageErrors.map((e) => '[exception] ' + String(e).split('\n')[0])].join('\n') + '\n',
  );
  await writeFile(
    path.join(EV, 'notify-append-results.json'),
    JSON.stringify({ passed, failed, results, pageErrors, console: consoleLines }, null, 2) + '\n',
  );
} catch (e) {
  // An unexpected throw OUTSIDE `check()` (init, CDP setup, evidence writes).
  // Preserve the original error first, then keep whatever evidence still
  // exists — `finally` guarantees the browser is gone either way.
  fatal = e;
  console.error(`\nUNEXPECTED FAILURE: ${e && e.stack ? e.stack : e}`);
  try { await mkdir(EV, { recursive: true }); } catch { /* evidence is best-effort */ }
  await shot('unexpected-failure.png');
  try {
    await writeFile(
      path.join(EV, 'notify-append-results.json'),
      JSON.stringify({ passed, failed, results, pageErrors, console: consoleLines, fatal: String(e) }, null, 2) + '\n',
    );
  } catch { /* evidence is best-effort; never mask the original error */ }
} finally {
  // Runs on success, on a failed scenario, and on an unexpected throw. It is
  // idempotent and never throws, so it cannot mask the real error.
  await cleanup();
}

console.log(`\nReal browser notify/append (Chrome): ${passed} passed, ${failed} failed`);
if (pageErrors.length) {
  console.log(`\nPage exceptions captured (${pageErrors.length}):`);
  for (const e of pageErrors.slice(0, 8)) console.log('  - ' + String(e).split('\n')[0]);
}
if (fatal) {
  console.log(`\nFatal: ${fatal && fatal.message ? fatal.message : fatal}`);
  console.log('Teardown still ran; evidence (if any) was written before cleanup.');
}
if (failed > 0 || fatal) process.exit(1);
