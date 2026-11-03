/**
 * AŞAMA 5.3.10 — ÇOK SEKME SESSION SİLME TUTARLILIĞI (frontend yarısı).
 *
 * NEDEN BU DOSYA VAR
 * ------------------
 * 5.3.9 KONU B'de `deleteSession` bir `session_disconnected` olayı yayınlar
 * (`reason="DELETED"`, tenant-scoped, commit'ten SONRA). Backend yarısı
 * `test_whatsapp_session_delete_lifecycle.py` ile ölçülüyor. Ama olayın
 * DİĞER SEKMEDE işe yaradığı — yani sekmelerin session listesini gerçekten
 * yenilediği — hiçbir testle doğrulanmamıştı; yalnızca kod okumasıyla
 * ("`session_disconnected` → `fetchSessions(true)`") biliniyordu.
 *
 * Bu dosya GERÇEK `WhatsAppHubPage`'i jsdom'da mount eder, YALNIZCA ağ
 * katmanını (WhatsAppRepository/WhatsAppApi) stub'lar ve GERÇEK
 * `tezlify:ws_event` CustomEvent'i yayınlar. Ölçülen şey çağrı defteri ve
 * DOM'dur: silinen oturum listeden kayboluyor mu, yenileme kaç kez oluyor.
 *
 * Çalıştır: node scripts/verify-session-deleted-multitab.mjs
 * Çıkış kodu 0 = PASS.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
// Mutasyon kanıtı için kök geçersiz kılınabilir; VARSAYILAN gerçek `src/`'tir.
const SRC = process.env.TEZLIFY_SRC_ROOT
  ? path.resolve(process.env.TEZLIFY_SRC_ROOT)
  : path.join(frontendRoot, 'src');

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

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-multitab-'));
let exitCode = 0;
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');
const stub = path.join(tmp, 'stub.ts');

await writeFile(
  stub,
  `
const G: any = (globalThis as any).__mtStub ||= { calls: [], sessions: [], conversations: [] };
export const calls = G.calls;
export const state = G;
export function __reset() { G.calls.length = 0; }
const ok = (data: any) => Promise.resolve(data);
export const WhatsAppRepository = {
  async getWhatsAppSessions() { calls.push('getWhatsAppSessions'); return G.sessions.slice(); },
  async getConversationsPage() { calls.push('getConversationsPage'); return { items: G.conversations, has_more: false, total: G.conversations.length }; },
  async getConversation() { calls.push('getConversation'); return null; },
  async getConversationMessages(id: number) { calls.push('getConversationMessages:' + id); return { messages: [], has_more: false, oldest_message_id: null }; },
  async markConversationAsRead() { calls.push('markConversationAsRead'); return ok({}); },
  async updateConversationStatus() { calls.push('updateConversationStatus'); return ok({}); },
  async sendMessage() { return ok({}); },
  async retryMessage() { return ok({}); },
  async sendMedia() { return ok({}); },
  async sendMediaFile() { return ok({}); },
  async sendTemplate() { return ok({}); },
  async sendTyping() { return ok({}); },
  async subscribePresence() { return ok({}); },
  async disconnectSession() { return ok({}); },
  async deleteSession() { calls.push('deleteSession'); return ok({}); },
  async requestAvatarBackfill() { return { success: true }; },
  async refreshAvatar() { return { success: true }; },
  async getLidSplits() { return { items: [], total: 0, truncated: false }; },
  async mergeLidSplits() { return { merged: true }; },
};
export const WhatsAppApi = {
  async getConversations() { calls.push('getConversations'); return G.conversations; },
  async getSyncJob() { calls.push('getSyncJob'); return { state: 'IDLE' }; },
  async startSync() { return { sync_id: 'x' }; },
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
  'utf8',
);

await writeFile(
  entry,
  [
    `export { default as React } from 'react';`,
    `export { act as domAct } from 'react-dom/test-utils';`,
    `export { createRoot } from 'react-dom/client';`,
    `export { I18nProvider } from '${SRC}/context/I18nContext';`,
    `export { ToastProvider } from '${SRC}/context/ToastContext';`,
    `export { WhatsAppHubPage } from '${SRC}/pages/WhatsAppHubPage';`,
  ].join('\n'),
  'utf8',
);

const stubPlugin = {
  name: 'stub-network',
  setup(b) {
    b.onResolve({ filter: /features\/whatsapp\/data\/whatsappRepository$/ }, () => ({ path: stub }));
    b.onResolve({ filter: /features\/whatsapp\/api\/whatsappApi$/ }, () => ({ path: stub }));
    b.onResolve({ filter: /features\/whatsapp\/hooks\/useWhatsAppLoadingGate$/ }, () => ({ path: stub }));
  },
};

const results = [];
const record = (label, shown, extra = '') =>
  results.push({ label: label + (extra ? ` (${extra})` : ''), shown });

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
  const G = globalThis.__mtStub;
  const h = React.createElement;

  const SESSION_A = {
    id: 1, session_name: 'Sekme-A Oturumu', phone_number: '+905550000001',
    status: 'CONNECTED', is_active: true, is_phone_online: true, qr_code: undefined,
  };
  const SESSION_B = {
    id: 2, session_name: 'Sekme-B Silinecek', phone_number: '+905550000002',
    status: 'CONNECTED', is_active: true, is_phone_online: true, qr_code: undefined,
  };

  let active = null;
  const mount = async () => {
    if (active) {
      await domAct(async () => { active.r.unmount(); });
      active.c.remove();
    }
    G.sessions = [SESSION_A, SESSION_B];
    G.conversations = [];
    G.calls.length = 0;
    const c = window.document.createElement('div');
    window.document.body.appendChild(c);
    const r = createRoot(c);
    await domAct(async () => {
      r.render(h(I18nProvider, null, h(ToastProvider, null, h(WhatsAppHubPage, { onRefreshStats: () => {} }))));
      await new Promise((x) => setTimeout(x, 120));
    });
    active = { c, r };
    return active;
  };

  const leaves = () =>
    Array.from(active.c.querySelectorAll('*'))
      .filter((n) => n.children.length === 0)
      .map((n) => (n.textContent || '').trim())
      .filter((t) => t && t.length < 80);

  // Oturum kartları "QR Sessions" sekmesinde yaşar; varsayılan sekme
  // "Live Conversations". Sekmeyi GERÇEK bir tıklamayla açıyoruz.
  const openSessionsTab = async () => {
    const label = leaves().find((t) => t === 'QR Sessions' || t === 'QR Oturumları');
    if (!label) throw new Error('QR Sessions sekmesi bulunamadı');
    const node = Array.from(active.c.querySelectorAll('*')).find(
      (n) => n.children.length === 0 && (n.textContent || '').trim() === label,
    );
    const clickable = node.closest('button, [role="tab"], [role="button"]') || node;
    await domAct(async () => {
      clickable.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((x) => setTimeout(x, 150));
    });
    // Sekme içeriği asenkron boyanabilir: kısa bir bekleme turu.
    for (let i = 0; i < 4 && !leaves().includes(SESSION_A.session_name); i += 1) {
      await domAct(async () => { await new Promise((x) => setTimeout(x, 80)); });
    }
  };

  const fire = async (event) => {
    G.calls.length = 0;
    await domAct(async () => {
      window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', { detail: event }));
      await new Promise((x) => setTimeout(x, 120));
    });
  };

  const sessionFetches = () => G.calls.filter((x) => x === 'getWhatsAppSessions').length;
  const rendered = (name) => leaves().some((t) => t === name);

  // -------------------------------------------------------------------------
  // 0. ÖN KOŞUL: iki oturum da listelendi
  // -------------------------------------------------------------------------
  await mount();
  await openSessionsTab();
  record('T0 ön koşul: iki oturum da listede',
    rendered(SESSION_A.session_name) && rendered(SESSION_B.session_name),
    `leaves=${JSON.stringify(leaves().filter((t) => t.includes('Oturum') || t.includes('Silinecek')))}`);

  // -------------------------------------------------------------------------
  // 1. DİĞER SEKMEDE SİLME: `session_disconnected(reason=DELETED)` listeyi
  //    yeniler ve silinen oturum satırı KAYBOLUR.
  // -------------------------------------------------------------------------
  await mount();
  await openSessionsTab();
  G.sessions = [SESSION_A];                    // "diğer sekme" backend'de sildi
  await fire({
    event: 'session_disconnected', user_id: 'u1',
    session_id: SESSION_B.id, gateway_session_id: 'gw-b',
    reason: 'DELETED',
  });
  record('T1 session_disconnected(DELETED) session listesini yeniler',
    sessionFetches() >= 1, `getWhatsAppSessions=${sessionFetches()}`);
  record('T1b silinen oturum satırı listeden kalkar',
    !rendered(SESSION_B.session_name) && rendered(SESSION_A.session_name),
    `leaves=${JSON.stringify(leaves().filter((t) => t.includes('Oturum') || t.includes('Silinecek')))}`);

  // -------------------------------------------------------------------------
  // 2. Tek olay = tek yenileme (olay fırtınası yok)
  // -------------------------------------------------------------------------
  await mount();
  G.sessions = [SESSION_A];
  await fire({ event: 'session_disconnected', user_id: 'u1', session_id: SESSION_B.id, gateway_session_id: 'gw-b', reason: 'DELETED' });
  record('T2 tek olay tam olarak bir session yenilemesi üretir',
    sessionFetches() === 1, `getWhatsAppSessions=${sessionFetches()}`);

  // -------------------------------------------------------------------------
  // 3. KONTROL: alakasız olay session listesini yenilemez
  // -------------------------------------------------------------------------
  await mount();
  await fire({ event: 'message_new', user_id: 'u1', conversation_id: 7, message: { id: 1, body: 'x' } });
  record('T3 message_new session listesini yenilemez (kontrol)',
    sessionFetches() === 0, `getWhatsAppSessions=${sessionFetches()}`);

  // -------------------------------------------------------------------------
  // 4. KONTROL: mevcut oturum yaşam döngüsü sinyalleri bozulmadı
  // -------------------------------------------------------------------------
  await mount();
  await fire({ event: 'session_connected', user_id: 'u1', session_id: 1, gateway_session_id: 'gw-a' });
  const connectedFetches = sessionFetches();
  await mount();
  await fire({ event: 'session_updated', user_id: 'u1', session_id: 1 });
  const updatedFetches = sessionFetches();
  record('T4 session_connected hâlâ yeniliyor', connectedFetches >= 1, `n=${connectedFetches}`);
  record('T4b session_updated hâlâ yeniliyor', updatedFetches >= 1, `n=${updatedFetches}`);

  // -------------------------------------------------------------------------
  // 5. DELETED olayı bir "bağlantı koptu" hatası olarak SUNULMAZ:
  //    silinen oturumun adı hata metniyle birlikte geri gelmez.
  // -------------------------------------------------------------------------
  await mount();
  await openSessionsTab();
  G.sessions = [SESSION_A];
  await fire({ event: 'session_disconnected', user_id: 'u1', session_id: SESSION_B.id, gateway_session_id: 'gw-b', reason: 'DELETED' });
  const revived = rendered(SESSION_B.session_name);
  record('T5 DELETED olayı silinen oturumu geri getirmez', !revived, `revived=${revived}`);
} catch (err) {
  console.error(`\nFAIL: ${err?.stack || err?.message || err}`);
  exitCode = 1;
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log('\n============ SCENARIO RESULTS ============');
for (const r of results) console.log(`${r.shown ? 'ok  ' : 'FAIL'}  ${r.label}`);
const fails = results.filter((r) => !r.shown);
console.log(`\n${results.length - fails.length}/${results.length} scenarios passed`);
if (fails.length) {
  console.error('\nMULTI-TAB SESSION DELETE REGRESSION:');
  for (const f of fails) console.error('  - ' + f.label);
  exitCode = 1;
}
// jsdom + React zamanlayıcıları olay döngüsünü canlı tutar.
process.exit(exitCode);
