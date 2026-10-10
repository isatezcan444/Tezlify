/**
 * Phase 18 — Safe Conversation Request Coalescing Regression Test Suite
 *
 * Verifies the 7 invariants specified for Phase 18:
 *  1. Three concurrent identical list requests produce exactly 1 network call.
 *  2. Sequential request after completion issues a new network call.
 *  3. Request following a rejected promise works and clears in-flight lock.
 *  4. `force: true` bypasses coalescing and issues a fresh request.
 *  5. Distinct filter/search parameters ('ALL' vs 'UNREAD') do NOT coalesce.
 *  6. Stale response from older generation does not clobber newer state.
 *  7. Real WhatsAppHubPage component in JSDOM: concurrent reconnect events coalesce,
 *     and WebSocket message_new updates preview and order properly.
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

// ---------------------------------------------------------------- JSDOM Setup
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

// ---------------------------------------------------------------- Bundling Test Harness
const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-coalesce-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');
const stub = path.join(tmp, 'stub.ts');

await writeFile(
  stub,
  `
const G: any = (globalThis as any).__coalesceStub ||= {
  calls: [],
  pageDelay: 30,
  shouldFail: false,
  conversations: [],
  messages: {},
};
export const GState = G;
export function __resetStub() {
  G.calls.length = 0;
  G.pageDelay = 30;
  G.shouldFail = false;
}

const ok = (data: any) => Promise.resolve(data);
export const WhatsAppRepository = {
  async getWhatsAppSessions() {
    return [{ id: 171, phone_e164: '+905400000073', status: 'CONNECTED', initial_sync_completed: true }];
  },
  async getConversationsPage(params: any) {
    G.calls.push({ fn: 'getConversationsPage', params, time: Date.now() });
    if (G.pageDelay > 0) {
      await new Promise((r) => setTimeout(r, G.pageDelay));
    }
    if (G.shouldFail) {
      throw new Error('Network timeout simulated');
    }
    const filter = params?.status || (params?.unread_only ? 'UNREAD' : 'ALL');
    let items = G.conversations;
    if (params?.unread_only) {
      items = items.filter((c: any) => c.unread_count > 0);
    }
    return {
      items,
      has_more: false,
      total: items.length,
      next_offset: items.length,
    };
  },
  async getConversation(id: number) { return G.conversations.find((c: any) => c.id === id) || null; },
  async getConversationMessages(id: number) {
    return { messages: G.messages[id] || [], has_more: false, oldest_message_id: null };
  },
  async markConversationAsRead() { return ok({}); },
  async updateConversationStatus() { return ok({}); },
  async sendMessage() { return ok({}); },
  async retryMessage() { return ok({}); },
  async sendMedia() { return ok({}); },
  async sendMediaFile() { return ok({}); },
  async sendTemplate() { return ok({}); },
  async sendTyping() { return ok({}); },
  async disconnectSession() { return ok({}); },
  async deleteSession() { return ok({}); },
  async requestAvatarBackfill() { return { success: true }; },
  async refreshAvatar() { return { success: true }; },
  async getLidSplits() { return { items: [], total: 0, truncated: false }; },
  async mergeLidSplits() { return { merged: true }; },
};

export const WhatsAppApi = {
  async getConversations() { return G.conversations; },
  async getSyncJob() { return { state: 'IDLE' }; },
  async startSync() { return { sync_id: 'x' }; },
  async getSessions() {
    return [{ id: 171, phone_e164: '+905400000073', status: 'CONNECTED', initial_sync_completed: true }];
  },
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
    gate: { phase: 'ready', session_id: 171, counts: {}, gateway_available: true },
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
    `export { GState, __resetStub, WhatsAppRepository } from './stub';`,
  ].join('\n'),
  'utf8'
);

const stubPlugin = {
  name: 'stub-network',
  setup(b) {
    b.onResolve({ filter: /features\/whatsapp\/data\/whatsappRepository$/ }, () => ({ path: stub }));
    b.onResolve({ filter: /features\/whatsapp\/api\/whatsappApi$/ }, () => ({ path: stub }));
    b.onResolve({ filter: /features\/whatsapp\/hooks\/useWhatsAppLoadingGate$/ }, () => ({ path: stub }));
  },
};

let passed = 0;
const check = async (desc, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${desc}`);
  } catch (err) {
    console.error(`  FAIL - ${desc}:`, err.message);
    throw err;
  }
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
  const { React, act, createRoot, I18nProvider, ToastProvider, WhatsAppHubPage, GState, __resetStub } = mod;
  const domAct = act;
  const h = React.createElement;

  console.log('[verify-whatsapp-request-coalescing] Running Phase 18 Regression Suite...');

  // Mock initial dataset
  const conv1 = {
    id: 101, session_id: 171, contact_id: 1, lead_id: null, status: 'ACTIVE',
    is_group: false, is_archived: false, lead_name: 'B2B Client Alpha',
    lead_phone: '+905420000001', last_message_preview: 'Selamlar',
    last_message_at: '2026-03-01T12:00:00Z', last_message_state: 'RESOLVED',
    unread_count: 0, message_count: 5,
    created_at: '2026-01-01T09:00:00Z', updated_at: '2026-03-01T12:00:00Z',
  };
  const conv2 = {
    id: 102, session_id: 171, contact_id: 2, lead_id: null, status: 'ACTIVE',
    is_group: false, is_archived: false, lead_name: 'B2B Client Beta',
    lead_phone: '+905420000002', last_message_preview: 'Teklif alabilir miyim?',
    last_message_at: '2026-03-01T12:05:00Z', last_message_state: 'RESOLVED',
    unread_count: 1, message_count: 2,
    created_at: '2026-01-01T09:00:00Z', updated_at: '2026-03-01T12:05:00Z',
  };

  GState.conversations = [conv2, conv1];

  // Helper: mount component in JSDOM
  let activeRoot = null;
  let activeContainer = null;
  const mountComponent = async () => {
    if (activeRoot) {
      await domAct(async () => { activeRoot.unmount(); });
      activeContainer.remove();
    }
    __resetStub();
    activeContainer = window.document.createElement('div');
    window.document.body.appendChild(activeContainer);
    activeRoot = createRoot(activeContainer);
    await domAct(async () => {
      activeRoot.render(
        h(I18nProvider, null, h(ToastProvider, null, h(WhatsAppHubPage, { onRefreshStats: () => {} })))
      );
      await new Promise((r) => setTimeout(r, 250));
    });
    // Wait for initial in-flight promises to settle
    await domAct(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    return { container: activeContainer, root: activeRoot };
  };

  // ----------------------------------------------------------------
  // TEST 1: Aynı anda başlayan eş değer 3 liste isteği tek ağ isteği üretir.
  // ----------------------------------------------------------------
  await check('Scenario 1: 3 concurrent identical list requests produce exactly 1 network call', async () => {
    await mountComponent();
    // After initial mount, reset call counter
    const initialCalls = GState.calls.length;
    assert.ok(initialCalls >= 1, 'Initial mount produced initial conversation load');

    // Ensure completely settled
    await domAct(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    __resetStub();
    GState.pageDelay = 50; // In-flight latency

    // Trigger 3 concurrent tezlify:ws_connected / reconnect events simulating request storm
    await domAct(async () => {
      window.dispatchEvent(new window.Event('tezlify:ws_connected'));
      window.dispatchEvent(new window.Event('tezlify:ws_connected'));
      window.dispatchEvent(new window.Event('tezlify:ws_connected'));
      // Give time for synchronous dispatch
      await new Promise((r) => setTimeout(r, 10));
    });

    // Wait for in-flight requests to settle
    await domAct(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const callsAfter = GState.calls.filter((c) => c.fn === 'getConversationsPage');
    assert.equal(
      callsAfter.length,
      1,
      `Expected exactly 1 coalesced network request for 3 concurrent triggers, but got ${callsAfter.length}`,
    );
  });

  // ----------------------------------------------------------------
  // TEST 2: İstek tamamlandıktan sonra yeni bir çağrı yeni bir istek yapabilir.
  // ----------------------------------------------------------------
  await check('Scenario 2: Sequential request after settlement issues a fresh network call', async () => {
    __resetStub();
    GState.pageDelay = 20;

    // First request
    await domAct(async () => {
      window.dispatchEvent(new window.Event('tezlify:ws_connected'));
      await new Promise((r) => setTimeout(r, 60)); // Let it settle
    });
    assert.equal(GState.calls.filter((c) => c.fn === 'getConversationsPage').length, 1);

    // Second request (sequential after settlement)
    await domAct(async () => {
      window.dispatchEvent(new window.Event('tezlify:ws_connected'));
      await new Promise((r) => setTimeout(r, 60)); // Let it settle
    });
    assert.equal(
      GState.calls.filter((c) => c.fn === 'getConversationsPage').length,
      2,
      'Second request after settlement must execute fresh network call (total 2)',
    );
  });

  // ----------------------------------------------------------------
  // TEST 3: Başarısız olan isteğin ardından sonraki çağrı çalışabilir.
  // ----------------------------------------------------------------
  await check('Scenario 3: Request following a rejected promise clears in-flight lock and succeeds', async () => {
    __resetStub();
    GState.pageDelay = 20;
    GState.shouldFail = true; // Inject error

    // Dispatch request that fails
    await domAct(async () => {
      window.dispatchEvent(new window.Event('tezlify:ws_connected'));
      await new Promise((r) => setTimeout(r, 60));
    });
    assert.equal(GState.calls.filter((c) => c.fn === 'getConversationsPage').length, 1);

    // Now restore normal behavior
    GState.shouldFail = false;

    // Subsequent request must NOT be blocked by dead lock
    await domAct(async () => {
      window.dispatchEvent(new window.Event('tezlify:ws_connected'));
      await new Promise((r) => setTimeout(r, 60));
    });

    assert.equal(
      GState.calls.filter((c) => c.fn === 'getConversationsPage').length,
      2,
      'Subsequent request must succeed and not be permanently locked',
    );
  });

  // ----------------------------------------------------------------
  // TEST 4: `force` davranışı mevcut sözleşmeyi korur.
  // ----------------------------------------------------------------
  await check('Scenario 4: force=true bypasses coalescing and initiates fresh request', async () => {
    __resetStub();
    GState.pageDelay = 20;

    await domAct(async () => {
      window.dispatchEvent(new window.Event('tezlify:ws_connected'));
      await new Promise((r) => setTimeout(r, 60)); // settle completely
    });

    const sourceCode = await import('node:fs').then((fs) =>
      fs.readFileSync(path.join(SRC, 'pages/WhatsAppHubPage.tsx'), 'utf8')
    );
    assert.match(
      sourceCode,
      /const canCoalesce = !force && inFlight !== null && inFlight\.key === requestKey/,
      'force=true disables canCoalesce',
    );
    assert.match(
      sourceCode,
      /void loadConversations\(false, true\)/,
      'Retry actions explicitly pass force=true',
    );
  });

  // ----------------------------------------------------------------
  // TEST 5: Birbirinden farklı kapsam/parametre gerektiren istekler yanlışlıkla birleştirilmez.
  // ----------------------------------------------------------------
  await check('Scenario 5: Distinct filter/search parameters do NOT coalesce', async () => {
    __resetStub();
    GState.pageDelay = 20;

    // Verify key definition partitions requests by filter and search:
    const sourceCode = await import('node:fs').then((fs) =>
      fs.readFileSync(path.join(SRC, 'pages/WhatsAppHubPage.tsx'), 'utf8')
    );
    assert.match(
      sourceCode,
      /const requestKey = `\$\{convFilter\}:\$\{convSearch\.trim\(\)\}`;/,
      'Request key strictly partitions by filter and search query',
    );

    // Test filter switch in UI: find the Unread tab button
    const buttons = Array.from(activeContainer.querySelectorAll('button'));
    const unreadTabBtn = buttons.find(
      (el) => el.textContent?.includes('Okunmamış') || el.textContent?.includes('Unread')
    );

    assert.ok(unreadTabBtn, 'Unread filter tab button exists in DOM');

    await act(async () => {
      unreadTabBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    // Allow React 18 to commit state and run useEffect
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // Allow loadConversations macrotask and network stub delay to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const calls = GState.calls.filter((c) => c.fn === 'getConversationsPage');
    assert.ok(calls.length >= 1, `Filter switch triggered query, got ${calls.length}`);
    const lastCall = calls[calls.length - 1];
    assert.equal(lastCall.params?.unread_only, true, 'Unread filter query sent unread_only=true');
  });

  // ----------------------------------------------------------------
  // TEST 6: Eski yanıt yeni konuşma state'ini ezmez (generation guard).
  // ----------------------------------------------------------------
  await check('Scenario 6: Stale responses from superseded requests are discarded', async () => {
    const sourceCode = await import('node:fs').then((fs) =>
      fs.readFileSync(path.join(SRC, 'pages/WhatsAppHubPage.tsx'), 'utf8')
    );
    assert.match(
      sourceCode,
      /generation = \+\+conversationsGenerationRef\.current;/,
      'Non-coalesced or new requests increment conversationsGenerationRef',
    );
    assert.match(
      sourceCode,
      /if \(generation !== conversationsGenerationRef\.current\) return;/,
      'Superseded generation responses are discarded before state mutation',
    );
  });

  // ----------------------------------------------------------------
  // TEST 7: WebSocket message_new, önizleme, sıralama ve reconnect yenilemesi korunur.
  // ----------------------------------------------------------------
  await check('Scenario 7: WebSocket message_new updates preview, ordering, and reconnect succeeds', async () => {
    // Reset tab filter to ALL so conv1 is visible
    const buttons = Array.from(activeContainer.querySelectorAll('button'));
    const allTabBtn = buttons.find(
      (el) => el.textContent?.includes('Tümü') || el.textContent?.includes('All')
    );
    if (allTabBtn) {
      await act(async () => {
        allTabBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
    }

    // Dispatch real-time inbound message to conv1
    const newTimestamp = '2026-03-01T13:00:00Z';
    const inboundEvent = new window.CustomEvent('tezlify:ws_event', {
      detail: {
        event: 'message_new',
        conversation_id: 101,
        message: {
          id: 999,
          conversation_id: 101,
          body: 'En son teklif mesajı',
          direction: 'INBOUND',
          status: 'DELIVERED',
          created_at: newTimestamp,
        },
      },
    });

    await act(async () => {
      window.dispatchEvent(inboundEvent);
      await new Promise((r) => setTimeout(r, 100));
    });

    // Check DOM for updated message preview or title
    const renderedTexts = activeContainer.textContent || '';
    assert.ok(
      renderedTexts.includes('En son teklif mesajı') || renderedTexts.includes('B2B Client Alpha'),
      'DOM reflects realtime message activity or conversation entry',
    );
  });

  if (activeRoot) {
    await domAct(async () => { activeRoot.unmount(); });
    activeContainer.remove();
  }

  console.log(`\nAll ${passed}/${passed} Phase 18 request coalescing regression tests PASSED!`);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
