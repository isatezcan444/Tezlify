/**
 * REGRESSION TEST — realtime inbound message must reach the OPEN ChatThread.
 *
 * Regression guard for the "inbox updates, thread does not" defect: the
 * conversation list and the active chat resolved the event's conversation
 * identity with two DIFFERENT (and mutually incompatible) matchers, so an
 * inbound event could update the list row and then be dropped before the
 * message merge. This test drives the REAL `WhatsAppHubPage` and fails if that
 * asymmetry ever comes back.
 *
 * Mounts the REAL `WhatsAppHubPage` in jsdom, stubbing ONLY the network layer
 * (WhatsAppRepository / WhatsAppApi), then dispatches a REAL `tezlify:ws_event`
 * exactly the way `App.tsx` does, and reports whether the incoming bubble is
 * rendered. Repository calls are recorded so we can tell a realtime merge apart
 * from a refetch.
 *
 * Run: node scripts/verify-whatsapp-realtime-inbound.mjs
 */
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
setGlobal('CustomEvent', window.CustomEvent);
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('localStorage', window.localStorage);
setGlobal('sessionStorage', window.sessionStorage);
setGlobal('location', window.location);
setGlobal('history', window.history);
setGlobal('matchMedia', window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
setGlobal('ResizeObserver', window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} });
setGlobal('IntersectionObserver', window.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} });
setGlobal('MutationObserver', window.MutationObserver);
setGlobal('fetch', async () => new Response('{}', { status: 200 }));

// jsdom has no layout engine: install a usable box model on scrollers.
const isScroller = (el) => typeof el.matches === 'function' && el.matches('.overflow-y-auto');
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get() { return isScroller(this) ? this.children.length * 40 : 0; },
});
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() { return isScroller(this) ? 320 : 0; },
});
const scrollerTops = new WeakMap();
Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', {
  configurable: true,
  get() { return scrollerTops.get(this) ?? 0; },
  set(v) { scrollerTops.set(this, Number(v) || 0); },
});
window.Element.prototype.scrollIntoView = function scrollIntoView() {};


// ------------------------------------------------------------------- bundling
const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-diag-'));
let exitCode = 0;
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');
const stub = path.join(tmp, 'stub.ts');

// Network-layer stub. The REAL component + REAL handler run against this.
// State lives on globalThis so the bundled copy and the test share one instance.
await writeFile(
  stub,
  `

const G: any = (globalThis as any).__diagStub ||= { calls: [], conversations: [], messages: {} };
export const calls = G.calls;
export function __seed(convRow: any, msgs: any[]) {
  G.conversations = [convRow];
  G.messages = { [convRow.id]: msgs };
}
export function __reset() { G.calls.length = 0; }
const ok = (data: any) => Promise.resolve(data);
export const WhatsAppRepository = {
  async getWhatsAppSessions() { calls.push('getWhatsAppSessions'); return []; },
  async getConversationsPage() { calls.push('getConversationsPage'); return { items: G.conversations, has_more: false, total: G.conversations.length }; },
  async getConversation(id: number) { calls.push('getConversation'); return G.conversations.find((c: any) => c.id === id) || null; },
  async getConversationMessages(id: number) {
    calls.push('getConversationMessages:' + id);
    if (G.messagesDelay) await new Promise((r) => setTimeout(r, G.messagesDelay));
    return { messages: G.messages[id] || [], has_more: false, oldest_message_id: null };
  },
  async markConversationAsRead() { calls.push('markConversationAsRead'); return ok({}); },
  async updateConversationStatus() { calls.push('updateConversationStatus'); return ok({}); },
  async sendMessage() { calls.push('sendMessage'); return ok({}); },
  async retryMessage() { calls.push('retryMessage'); return ok({}); },
  async sendMedia() { calls.push('sendMedia'); return ok({}); },
  async sendMediaFile() { calls.push('sendMediaFile'); return ok({}); },
  async sendTemplate() { calls.push('sendTemplate'); return ok({}); },
  async sendTyping() { calls.push('sendTyping'); return ok({}); },
  async disconnectSession() { calls.push('disconnectSession'); return ok({}); },
  async deleteSession() { calls.push('deleteSession'); return ok({}); },
  async requestAvatarBackfill() { calls.push('requestAvatarBackfill'); return { success: true }; },
  async refreshAvatar() { calls.push('refreshAvatar'); return { success: true }; },
  async getLidSplits() { calls.push('getLidSplits'); return { items: [], total: 0, truncated: false }; },
  async mergeLidSplits() { calls.push('mergeLidSplits'); return { merged: true }; },
};
export const WhatsAppApi = {
  async getConversations() { calls.push('getConversations'); return G.conversations; },
  async getSyncJob() { calls.push('getSyncJob'); return { state: 'IDLE' }; },
  async startSync() { calls.push('startSync'); return { sync_id: 'x' }; },
};
export function probeLive() { return Promise.resolve(true); }
export function invalidateLiveProbe() {}
export function isLiveCached() { return true; }
export function useLiveMode() { return { status: 'LIVE_CONNECTED', probe: async () => 'LIVE_CONNECTED' }; }
export function mapConversationItem(x: any) { return x; }
export function mapMessageItem(x: any) { return x; }
export function buildConversationUpdatedPayload(x: any) { return x; }
export class WhatsAppApiError extends Error {}
export function subscribeGatewayEvents() { return () => {}; }
export function useWhatsAppLoadingGate() {
  return {
    gate: { phase: 'ready', session_id: 1, counts: {}, gateway_available: true },
    dismiss: () => {},
    refresh: async () => {},
  };
}
`,
  'utf8'
);

await writeFile(
  entry,
  [
    `export { default as React, act } from 'react';`,
    `export { act as domAct } from 'react-dom/test-utils';`,
    `export { createRoot } from 'react-dom/client';`,
    `export { I18nProvider } from '${SRC}/context/I18nContext';`,
    `export { ToastProvider } from '${SRC}/context/ToastContext';`,
    `export { WhatsAppHubPage } from '${SRC}/pages/WhatsAppHubPage';`,
  ].join('\n'),
  'utf8'
);

// Redirect the data / API modules to the stub.
const stubPlugin = {
  name: 'stub-network',
  setup(b) {
    b.onResolve({ filter: /features\/whatsapp\/data\/whatsappRepository$/ }, () => ({ path: stub }));
    b.onResolve({ filter: /features\/whatsapp\/api\/whatsappApi$/ }, () => ({ path: stub }));
    b.onResolve({ filter: /features\/whatsapp\/hooks\/useWhatsAppLoadingGate$/ }, () => ({ path: stub }));
  },
};

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: out,
    format: 'esm',
    platform: 'browser',
    absWorkingDir: frontendRoot,
    nodePaths: [path.join(frontendRoot, 'node_modules')],
    define: {
      'import.meta.env.VITE_API_URL': '"/api/v1"',
      'import.meta.env.VITE_WHATSAPP_LATENCY_PROFILING': '"false"',
      'import.meta.env': '{"VITE_API_URL":"/api/v1","VITE_WHATSAPP_LATENCY_PROFILING":"false","DEV":false,"PROD":false,"MODE":"test"}',
      'process.env.NODE_ENV': '"development"',
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'text' },
    plugins: [stubPlugin],
    logLevel: 'error',
  });

  const mod = await import(out);
  const { React, domAct, createRoot, I18nProvider, ToastProvider, WhatsAppHubPage } = mod;
  const G = (globalThis).__diagStub;
  const stubMod = { calls: G.calls, __seed: null };
  const h = React.createElement;

  const convRow = {
    id: 7, session_id: 1, contact_id: 3, lead_id: null, status: 'ACTIVE',
    is_group: false, is_archived: false, lead_name: 'Ayse Demir',
    lead_phone: '+905550000777', last_message_preview: 'merhaba',
    last_message_at: '2026-01-01T10:00:00Z', last_message_state: 'RESOLVED',
    unread_count: 0, message_count: 1,
    created_at: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T10:00:00Z',
  };
  const history = [
    { id: 1, conversation_id: 7, direction: 'INBOUND', message_type: 'TEXT', status: 'READ', body: 'merhaba', created_at: '2026-01-01T10:00:00Z' },
  ];
  G.conversations = [convRow];
  G.messages = { 7: history };

  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);


  // Each scenario gets a FRESH root; `texts()` is scoped to that root's own
  // container so an earlier scenario's DOM can never produce a false pass.
  const results = [];
  let active = null;

  const mount = async (convOverride) => {
    if (active) { await domAct(async () => { active.r.unmount(); }); active.c.remove(); }
    G.conversations = [convOverride || convRow];
    G.messages = { 7: history };
    G.calls.length = 0;
    const c = window.document.createElement('div');
    window.document.body.appendChild(c);
    const r = createRoot(c);
    await domAct(async () => {
      r.render(h(I18nProvider, null, h(ToastProvider, null, h(WhatsAppHubPage, { onRefreshStats: () => {} }))));
      await new Promise((x) => setTimeout(x, 100));
    });
    // The list paints asynchronously; retry so a slow first paint can never be
    // mistaken for a product failure.
    let node = null;
    for (let attempt = 0; attempt < 5 && !node; attempt += 1) {
      await domAct(async () => { await new Promise((x) => setTimeout(x, 60)); });
      node = Array.from(c.querySelectorAll('*')).find(
        (n) => n.children.length === 0 && (n.textContent || '').includes('Ayse Demir'),
      ) || null;
    }
    if (node) {
      const clickable = node.closest('button, [role="button"], div');
      domAct(() => { clickable.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
      await domAct(async () => { await new Promise((x) => setTimeout(x, 80)); });
    }
    active = { c, r };
    return active;
  };

  // LEAF text nodes only. A container div also "contains" the bubble text, so
  // counting every element double-counts and would mask a real failure.
  const texts = () =>
    Array.from(active.c.querySelectorAll('*'))
      .filter((n) => n.children.length === 0)
      .map((n) => (n.textContent || '').trim())
      .filter((t) => t && t.length < 80);

  const fire = async (event) => {
    G.calls.length = 0;
    await domAct(async () => {
      window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', { detail: event }));
      await new Promise((x) => setTimeout(x, 60));
    });
  };
  const countOf = (needle) => new Set(texts().filter((t) => t === needle)).size;
  const dumpLeaves = () => JSON.stringify(texts().filter((t) => /INBOUND-XYZ|merhaba|MSG/.test(t)));
  const record = (label, shown, extra = '') =>
    results.push({ label: label + (extra ? ` (${extra})` : ''), shown });

  const base = { direction: 'INBOUND', message_type: 'TEXT', status: 'RECEIVED' };
  const msgNew = (over) => ({
    event: 'message_new', user_id: 'u1', conversation_id: 7,
    jid: '905550000777@s.whatsapp.net', lead_phone: '+905550000777',
    message: { id: 900, conversation_id: 7, ...base, body: 'INBOUND-XYZ', wa_message_id: 'WA1', created_at: '2026-01-01T10:05:00Z', ...over },
  });

  // TEST 1 - basic inbound realtime with the backend's numeric conversation_id.
  await mount();
  await fire(msgNew({}));
  record('T1 basic inbound (numeric conv id)', countOf('INBOUND-XYZ') > 0,
    `leaves=${dumpLeaves()}, refetch=${G.calls.includes('getConversationMessages:7')}`);

  // TEST 2 - three sequential inbound messages, ordering preserved.
  await mount();
  for (let i = 1; i <= 3; i += 1) {
    await fire(msgNew({ id: 900 + i, body: `MSG${i}`, wa_message_id: `WA${i}`, created_at: `2026-01-01T10:0${i + 4}:00Z` }));
  }
  // Order must be judged INSIDE the thread pane only: the conversation list
  // row also renders the latest preview and would otherwise pollute the check.
  const threadPane = () => {
    const scrollers = Array.from(active.c.querySelectorAll('.overflow-y-auto'));
    return scrollers.find((el) => (el.textContent || '').includes('merhaba')) || active.c;
  };
  const threadTexts = () =>
    Array.from(threadPane().querySelectorAll('*'))
      .filter((n) => n.children.length === 0)
      .map((n) => (n.textContent || '').trim())
      .filter((t) => t && t.length < 80);
  const t2 = threadTexts();
  record('T2 three inbound, no loss, chronological',
    ['MSG1', 'MSG2', 'MSG3'].every((m) => t2.includes(m)) &&
    t2.indexOf('MSG1') < t2.indexOf('MSG2') && t2.indexOf('MSG2') < t2.indexOf('MSG3'),
    `thread=${JSON.stringify(t2)}`);

  // TEST 3a - a @lid event matches a LID-keyed conversation row.
  await mount({ ...convRow, lead_phone: '123456789:12@lid', phone: undefined });
  await fire({ event: 'message_new', user_id: 'u1',
    conversation_id: '123456789:12@lid', jid: '123456789:12@lid',
    message: { id: 950, ...base, body: 'INBOUND-XYZ', wa_message_id: 'WALID1', created_at: '2026-01-01T10:06:00Z' } });
  record('T3a LID event matches LID row', countOf('INBOUND-XYZ') > 0, `leaves=${dumpLeaves()}`);

  // TEST 3b - a @lid event must NOT be collapsed onto a phone row: LID -> PN
  // reconciliation stays owned by the backend, which broadcasts the already
  // reconciled numeric conversation_id.
  await mount();
  await fire({ event: 'message_new', user_id: 'u1',
    conversation_id: '123456789:12@lid', jid: '123456789:12@lid',
    message: { id: 951, ...base, body: 'LID-MUST-NOT-LEAK', wa_message_id: 'WALID2', created_at: '2026-01-01T10:06:30Z' } });
  record('T3b LID does not hijack phone row', !texts().includes('LID-MUST-NOT-LEAK'), `leaves=${dumpLeaves()}`);

  // TEST 4 - JID-only payload, no numeric conversation_id at all.
  await mount();
  await fire({ event: 'message_new', user_id: 'u1',
    conversation_id: '905550000777@s.whatsapp.net', jid: '905550000777@s.whatsapp.net',
    message: { id: 960, ...base, body: 'INBOUND-XYZ', wa_message_id: 'WAJID1', created_at: '2026-01-01T10:07:00Z' } });
  record('T4 jid-only payload (no numeric id)', countOf('INBOUND-XYZ') > 0, `leaves=${dumpLeaves()}`);

  // TEST 5 - replay of the same wa_message_id must not duplicate.
  await mount();
  await fire(msgNew({ id: 970, wa_message_id: 'WADUP1' }));
  await fire(msgNew({ id: 970, wa_message_id: 'WADUP1' }));
  record('T5 replay does not duplicate', countOf('INBOUND-XYZ') === 1, `leaves=${dumpLeaves()}`);

  // TEST 6 - an event for a DIFFERENT conversation must never leak into the
  // open thread. Guards the fix against over-matching.
  await mount();
  await fire({ event: 'message_new', user_id: 'u1', conversation_id: 99,
    jid: '905550009999@s.whatsapp.net', lead_phone: '+905550009999',
    message: { id: 990, conversation_id: 99, ...base, body: 'OTHER-CHAT-MSG', wa_message_id: 'WAOTHER', created_at: '2026-01-01T10:10:00Z' } });
  record('T6 other-conversation event not shown in open thread',
    !texts().includes('OTHER-CHAT-MSG'), `leaves=${dumpLeaves()}`);

  // TEST 7 - history/realtime race. A slow hydration that resolves AFTER the
  // inbound event must not wipe the realtime bubble (Test 6 of the brief).
  await mount();
  G.messagesDelay = 150;                       // make the next GET slow
  const slowHydration = fire(msgNew({ id: 995, wa_message_id: 'WARACE' }));
  await new Promise((x) => setTimeout(x, 260)); // let the slow GET resolve
  await slowHydration;
  G.messagesDelay = 0;
  record('T7 realtime message survives slow history hydration',
    countOf('INBOUND-XYZ') > 0, `leaves=${dumpLeaves()}`);

  // TEST 8 - the invariant that was broken: whenever an inbound event updates
  // the ACTIVE conversation's list preview, the open thread must contain it.
  await mount();
  await fire(msgNew({ id: 996, wa_message_id: 'WAINV' }));
  const threadHas = countOf('INBOUND-XYZ') > 0;
  const listHas = texts().some((t) => t === 'INBOUND-XYZ');
  record('T8 list and thread agree (no list-only update)', threadHas && listHas,
    `list=${listHas} thread=${threadHas}`);

  console.log('\n============ SCENARIO RESULTS ============');
  for (const r of results) console.log(`${r.shown ? 'ok  ' : 'FAIL'}  ${r.label}`);
  const fails = results.filter((r) => !r.shown);
  console.log(`\n${results.length - fails.length}/${results.length} scenarios passed`);
  if (fails.length) {
    console.error('\nREALTIME INBOUND REGRESSION: active ChatThread did not receive:');
    for (const f of fails) console.error('  - ' + f.label);
  }
  exitCode = fails.length ? 1 : 0;
} catch (err) {
  console.error(`\nFAIL: ${err?.stack || err?.message || err}`);
  exitCode = 1;
} finally {
  await rm(tmp, { recursive: true, force: true });
  // The bundled React/jsdom graph leaves handles behind that keep the event
  // loop alive. The result is already reported above, so exit explicitly:
  // without this the process never terminates, the script looks like it hung,
  // and a caller (or CI) can never read its exit code.
  process.exit(exitCode);
}
