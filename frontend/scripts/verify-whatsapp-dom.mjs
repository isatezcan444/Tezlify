/**
 * Executed DOM verification of the WhatsApp chat UI (Phase 6.2).
 *
 * The frontend has no test runner. This script bundles the REAL components with
 * esbuild, renders them into a REAL jsdom document with React 18 `createRoot`,
 * and asserts on the resulting DOM.
 *
 * Run: `node scripts/verify-whatsapp-dom.mjs` — exit code 0 = PASS.
 *
 * Layout model
 * ------------
 * jsdom has NO layout engine: `scrollHeight`, `clientHeight` are always 0 and
 * `scrollTop` is not observable. Scroll-anchoring logic therefore cannot be
 * measured without a model. This script installs an explicit, deterministic box
 * model on the scroll container:
 *
 *   row height   ROW_H      (uniform, per rendered child of the container)
 *   viewport     VIEWPORT   (container clientHeight)
 *   scrollTop    real, mutable state (clamped to [0, scrollHeight - clientHeight])
 *
 * The COMPONENT is real — its scroll handler, its useLayoutEffect restore, its
 * pill state and its auto-scroll decision all execute. Only the box metrics are
 * simulated. Every scroll invariant below is falsified in-script: the broken
 * variant is executed too and must throw.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');
const fixturesPath = path.join(here, 'fixtures', 'phase6-ws-payloads.json');

// ---------------------------------------------------------------- jsdom setup
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Node 22 defines some of these as getter-only globals, so assign defensively.
const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  } catch {
    /* ignore: the environment already provides a good-enough value */
  }
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

// --------------------------------------------------------------- layout model
const ROW_H = 40;
const VIEWPORT = 320;
const SIM = Symbol('scrollSim');

/**
 * Install a deterministic box model on every scroll container.
 *
 * Defined on the PROTOTYPE (not per element) so it exists from the moment an
 * element is created. Per-element installation is too late: React effects run
 * inside `act(...)` during the very update that creates a remounted container.
 */
const scrollerTops = new WeakMap();
const isScroller = (el) =>
  typeof el.matches === 'function' && el.matches('.overflow-y-auto');
const metricsOf = (el) => {
  const content = Array.from(el.children).length * ROW_H;
  return { content, viewport: VIEWPORT, max: Math.max(0, content - VIEWPORT) };
};

Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get() {
    return isScroller(this) ? metricsOf(this).content : 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return isScroller(this) ? VIEWPORT : 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', {
  configurable: true,
  get() {
    return scrollerTops.get(this) ?? 0;
  },
  set(v) {
    const max = isScroller(this) ? metricsOf(this).max : 0;
    scrollerTops.set(this, Math.max(0, Math.min(Number(v) || 0, max)));
  },
});

/** Metrics + call counter for a container (model is already prototype-wide). */
function installBoxModel(el) {
  if (!el[SIM]) {
    el[SIM] = {
      metrics: () => metricsOf(el),
      scrollIntoViewCalls: 0,
    };
  }
  return el[SIM];
}

/**
 * `scrollIntoView` is not implemented by jsdom. Our stub performs the real
 * effect: it scrolls the nearest simulated ancestor to the bottom.
 */
window.Element.prototype.scrollIntoView = function scrollIntoView() {
  let node = this;
  while (node && !isScroller(node)) node = node.parentElement;
  if (!node) return;
  node.scrollTop = metricsOf(node).max;
  const sim = installBoxModel(node);
  sim.scrollIntoViewCalls += 1;
};

// ------------------------------------------------------------------- bundling
// Build OUTSIDE the working tree: a crashed or killed run would otherwise
// leave `.tmp-dom-*` directories behind in the repo, ready to be committed.
const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-dom-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  [
    `export { default as React, act } from 'react';`,
    `export * as ReactNS from 'react';`,
    `export { act as domAct } from 'react-dom/test-utils';`,
    `export { createRoot } from 'react-dom/client';`,
    `export { I18nProvider } from '${SRC}/context/I18nContext';`,
    `export { ChatThread } from '${SRC}/features/whatsapp/components/ChatThread';`,
    `export { ConversationList } from '${SRC}/features/whatsapp/components/ConversationList';`,
    `export { ChatComposer } from '${SRC}/features/whatsapp/components/ChatComposer';`,
    `export { applyConversationEvent } from '${SRC}/features/whatsapp/lib/whatsappConversationPatch';`,
    `export { mergeWhatsAppMessages } from '${SRC}/features/whatsapp/lib/whatsappMessageMerge';`,
    `export { compareConversationsByActivityDesc } from '${SRC}/features/whatsapp/lib/whatsappOrdering';`,
  ].join('\n'),
  'utf8'
);

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};
/** Run a broken variant and require that the invariant actually catches it. */
const falsify = async (label, fn) => {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert.ok(threw, `${label}: the invariant did NOT catch the broken behaviour`);
  passed += 1;
  console.log(`  ok - ${label} (broken variant correctly rejected)`);
};

try {
  await build({
    entryPoints: [entry],
    // Resolve node_modules against the repo: the entry itself lives in the
    // OS temp dir so a crashed run cannot litter the working tree.
    absWorkingDir: frontendRoot,
    // The entry lives in the OS temp dir, so node_modules is not reachable by
    // walking up from it. Search the workspace roots explicitly.
    nodePaths: [
      path.join(frontendRoot, 'node_modules'),
      path.resolve(frontendRoot, '..', 'node_modules'),
    ],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'error',
    define: {
      'import.meta.env': '{}',
      'process.env.NODE_ENV': '"development"',
    },
    jsx: 'automatic',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
  });

  const mod = await import(out);
  const { React, ReactNS, domAct, createRoot, I18nProvider, ChatThread, ConversationList,
    ChatComposer,
    applyConversationEvent, mergeWhatsAppMessages, compareConversationsByActivityDesc } = mod;
  const act = typeof ReactNS.act === 'function' ? ReactNS.act : domAct;
  const h = React.createElement;

  // -------------------------------------------------------------- test plumbing
  const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);
  const ts = (n) => new Date(T0 + n * 1000).toISOString();
  const mkMsg = (n, extra = {}) => ({
    id: n,
    conversation_id: 1,
    // The trailing '#' prevents substring collisions: a bare `mesaj-6`
    // concatenated with its timestamp also contains `mesaj-61`.
    body: `mesaj-${n}#`,
    direction: 'INBOUND',
    status: 'RECEIVED',
    created_at: ts(n),
    external_timestamp: ts(n),
    wa_message_id: `W${n}`,
    ...extra,
  });

  let rootCount = 0;
  const mount = async (element) => {
    const host = window.document.createElement('div');
    host.id = `host-${++rootCount}`;
    window.document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(h(I18nProvider, null, element));
    });
    return {
      host,
      root,
      /** Re-render the same tree with new props. */
      update: async (next) => {
        await act(async () => {
          root.render(h(I18nProvider, null, next));
        });
      },
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  };

  /** The thread's scroll container, with a box model installed. */
  const threadContainer = (host) => {
    const el = host.querySelector('div.overflow-y-auto');
    assert.ok(el, 'scroll container not found in the rendered thread');
    installBoxModel(el);
    return el;
  };
  const pill = (host) => host.querySelector('.bottom-4.right-4');
  const rowsWithText = (container, text) =>
    Array.from(container.children).filter((c) => (c.textContent || '').includes(text)).length;
  const fireScroll = async (el) => {
    await act(async () => {
      el.dispatchEvent(new window.Event('scroll'));
    });
  };

  // React tracks the input's value internally, so assigning `el.value` directly
  // is invisible to it. Go through the prototype setter and fire `input`.
  const typeInto = async (input, text) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };

  const pressEnter = async (input) => {
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  };
  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
  };

  // =========================================================== SCENARIO G — bottom
  await check('G-bottom: a new inbound while at the bottom stays pinned and shows no pill', async () => {
    const msgs = Array.from({ length: 12 }, (_, i) => mkMsg(i + 1));
    const view = await mount(h(ChatThread, { messages: msgs, hasMore: true, onLoadOlder: () => {} }));
    const el = threadContainer(view.host);
    // The user is at the bottom.
    await act(async () => { el.scrollTop = el.scrollHeight - el.clientHeight; });
    await fireScroll(el);
    // Mounting a populated thread scrolls to the bottom once.
    assert.equal(el[SIM].scrollIntoViewCalls, 1, 'mount should auto-scroll once');

    await view.update(h(ChatThread, { messages: [...msgs, mkMsg(13)], hasMore: true, onLoadOlder: () => {} }));

    assert.ok((el.textContent || '').includes('mesaj-13#'), 'the new message must be in the DOM');
    assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight, 'viewport must stay at the bottom');
    assert.equal(pill(view.host), null, 'no new-message pill while the user is at the bottom');
    await view.unmount();
  });

  // ==================================================== SCENARIO G — reading older
  await check('G-reading-old: a new inbound preserves the position and raises the pill', async () => {
    const msgs = Array.from({ length: 40 }, (_, i) => mkMsg(i + 1));
    const view = await mount(h(ChatThread, { messages: msgs, hasMore: true, onLoadOlder: () => {} }));
    const el = threadContainer(view.host);
    // The user scrolled up into older content.
    await act(async () => { el.scrollTop = 40; });
    await fireScroll(el);
    const before = el.scrollTop;

    await view.update(h(ChatThread, { messages: [...msgs, mkMsg(41)], hasMore: true, onLoadOlder: () => {} }));

    assert.ok((el.textContent || '').includes('mesaj-41#'), 'the new message must be in the DOM');
    assert.equal(el.scrollTop, before, 'the user must NOT be yanked to the bottom');
    assert.ok(pill(view.host), 'the new-message pill must be visible');
    await view.unmount();
  });

  // ============================================================ SCROLL ANCHORING
  const anchorScenario = async (restoreImpl) => {
    const page1 = Array.from({ length: 30 }, (_, i) => mkMsg(i + 31)); // 31..60 newer
    const page2 = Array.from({ length: 30 }, (_, i) => mkMsg(i + 1)); // 1..30  older
    let messages = page1;
    const view = await mount(h(ChatThread, { messages, hasMore: true, onLoadOlder: () => {} }));
    const el = threadContainer(view.host);

    const anchorText = 'mesaj-35#';
    // Scrolling near the top triggers the older-page request; the component
    // captures (scrollTop, scrollHeight) at THIS moment, so the anchor offset
    // must be measured at this same position.
    await act(async () => { el.scrollTop = 10; });
    await fireScroll(el);
    const anchorIndexBefore = Array.from(el.children).findIndex((c) => (c.textContent || '').includes(anchorText));
    const offsetBefore = anchorIndexBefore * ROW_H - el.scrollTop;
    assert.ok(anchorIndexBefore > 0, 'anchor must be present before the prepend');
    // Provider answers: 30 older messages are prepended.
    messages = mergeWhatsAppMessages(page1, page2);
    await view.update(h(ChatThread, { messages, hasMore: true, onLoadOlder: () => {} }));

    if (restoreImpl === 'broken') {
      // FALSIFICATION: forget to compensate for the prepended height.
      el.scrollTop = 10;
    }

    const anchorIndexAfter = Array.from(el.children).findIndex((c) => (c.textContent || '').includes(anchorText));
    const offsetAfter = anchorIndexAfter * ROW_H - el.scrollTop;
    const result = { offsetBefore, offsetAfter, anchorIndexBefore, anchorIndexAfter, el, view };
    result.pillAfterPrepend = Boolean(pill(view.host));
    return result;
  };

  await check('scroll-anchor: prepending an older page keeps the same message in place', async () => {
    const r = await anchorScenario('real');
    assert.ok(r.anchorIndexAfter > r.anchorIndexBefore, 'the anchor must shift down by the prepended rows');
    assert.equal(r.offsetAfter, r.offsetBefore,
      `anchor moved within the viewport: ${r.offsetBefore} -> ${r.offsetAfter}`);
    await r.view.unmount();
  });

  await check('scroll-anchor: a pure older-page load must NOT raise the new-message pill', async () => {
    const r = await anchorScenario('real');
    try {
      // Nothing new arrived — the growth is the prepend the user asked for.
      assert.equal(r.pillAfterPrepend, false, 'loading older messages raised a spurious new-message pill');
    } finally {
      await r.view.unmount();
    }
  });

  await falsify('scroll-anchor: rejecting `scrollTop = previousScrollTop` (no height compensation)', async () => {
    const r = await anchorScenario('broken');
    try {
      assert.equal(r.offsetAfter, r.offsetBefore, 'anchor moved');
    } finally {
      await r.view.unmount();
    }
  });

  // ================================================ OLDER PAGE + NEW MESSAGE RACE
  await check('older-page-race: prepend + a live inbound keeps position, message and pill', async () => {
    const page1 = Array.from({ length: 30 }, (_, i) => mkMsg(i + 31));
    const page2 = Array.from({ length: 30 }, (_, i) => mkMsg(i + 1));
    const view = await mount(h(ChatThread, { messages: page1, hasMore: true, onLoadOlder: () => {} }));
    const el = threadContainer(view.host);
    // Scrolling near the top triggers the older-page request (the component
    // captures scrollTop/scrollHeight here).
    await act(async () => { el.scrollTop = 10; });
    await fireScroll(el);
    const before = el.scrollTop;

    // Prepend 30 older AND append 1 new live message in the same commit.
    const merged = mergeWhatsAppMessages(mergeWhatsAppMessages(page1, page2), [mkMsg(61)]);
    await view.update(h(ChatThread, { messages: merged, hasMore: true, onLoadOlder: () => {} }));

    assert.equal(rowsWithText(el, 'mesaj-61#'), 1, 'the live message must appear exactly once');
    assert.ok(el.scrollTop > before, 'the prepend must be compensated');
    assert.ok(el.scrollTop < el.scrollHeight - el.clientHeight, 'the user must NOT be thrown to the bottom');
    assert.ok(pill(view.host), 'the pill must be raised');
    await view.unmount();
  });

  // ============================================================== NEW MESSAGE PILL
  await check('pill: clicking it scrolls to the bottom and dismisses it', async () => {
    const msgs = Array.from({ length: 40 }, (_, i) => mkMsg(i + 1));
    const view = await mount(h(ChatThread, { messages: msgs, hasMore: true, onLoadOlder: () => {} }));
    const el = threadContainer(view.host);
    await act(async () => { el.scrollTop = 0; });
    await fireScroll(el);
    await view.update(h(ChatThread, { messages: [...msgs, mkMsg(41)], hasMore: true, onLoadOlder: () => {} }));
    assert.ok(pill(view.host), 'pill must be visible');

    const button = pill(view.host).querySelector('button');
    await click(button);
    assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight, 'must be at the bottom after the click');
    assert.equal(pill(view.host), null, 'the pill must disappear after the click');
    await view.unmount();
  });

  await check('pill: manually scrolling back to the bottom dismisses it', async () => {
    const msgs = Array.from({ length: 40 }, (_, i) => mkMsg(i + 1));
    const view = await mount(h(ChatThread, { messages: msgs, hasMore: true, onLoadOlder: () => {} }));
    const el = threadContainer(view.host);
    await act(async () => { el.scrollTop = 0; });
    await fireScroll(el);
    await view.update(h(ChatThread, { messages: [...msgs, mkMsg(41)], hasMore: true, onLoadOlder: () => {} }));
    assert.ok(pill(view.host), 'pill must be visible first');

    // The user scrolls to the bottom by hand.
    await act(async () => { el.scrollTop = el.scrollHeight - el.clientHeight; });
    await fireScroll(el);
    assert.equal(pill(view.host), null, 'the pill must clear once the user reaches the bottom');
    await view.unmount();
  });

  // ======================================================== PAGINATION DOM RETENTION
  const renderPagination = async (mergeFn) => {
    const page1 = Array.from({ length: 50 }, (_, i) => mkMsg(i + 51));
    const page2 = Array.from({ length: 50 }, (_, i) => mkMsg(i + 1));
    const loaded = mergeWhatsAppMessages(page1, page2);
    const view = await mount(h(ChatThread, { messages: loaded, hasMore: true, onLoadOlder: () => {} }));
    const el = threadContainer(view.host);
    const before = Array.from(el.children).length;
    // Refresh / sync: the newest page arrives again plus one live message.
    const after = mergeFn(loaded, [...page1, mkMsg(101)]);
    await view.update(h(ChatThread, { messages: after, hasMore: true, onLoadOlder: () => {} }));
    return { view, el, before, after, oldest: 'mesaj-1#', newest: 'mesaj-101#' };
  };

  await check('pagination-render: a refresh keeps both loaded pages in the DOM', async () => {
    const r = await renderPagination((cur, inc) => mergeWhatsAppMessages(cur, inc));
    const rows = Array.from(r.el.children).length;
    assert.ok(rows >= r.before, `rows must not shrink: ${r.before} -> ${rows}`);
    assert.ok((r.el.textContent || '').includes(r.oldest), 'page 2 must still be rendered');
    assert.equal(rowsWithText(r.el, r.newest), 1, 'the new message must appear exactly once');
    await r.view.unmount();
  });

  await falsify('pagination-render: rejecting `messages = incoming` (pages wiped)', async () => {
    const r = await renderPagination((_cur, inc) => inc);
    try {
      assert.ok((r.el.textContent || '').includes(r.oldest), 'page 2 was wiped');
    } finally {
      await r.view.unmount();
    }
  });

  // ====================================================== CONVERSATION LIST + ACTIVE
  const mkConv = (id, name, unread, lastAt, extra = {}) => ({
    id, lead_name: name, unread_count: unread, last_message_at: lastAt,
    last_message_preview: `onizleme-${id}`, status: 'ACTIVE', is_group: false,
    identity_state: 'RESOLVED', phone: `+90555000${id}`, avatar_url: null, ...extra,
  });

  await check('conversation-list: new activity reorders to the top without remounting the active chat', async () => {
    const convs = [
      mkConv(1, 'Ali', 0, ts(10)),
      mkConv(2, 'Veli', 3, ts(20)),
      mkConv(3, 'Ayse', 0, ts(30)),
    ];
    let selectedId = 1;
    const render = () =>
      h('div', null,
        h(ConversationList, { conversations: convs, selectedId, onSelect: () => {} }),
        h('div', { id: 'thread' },
          h(ChatThread, {
            key: selectedId,
            // Enough rows to be genuinely scrollable under the box model.
            messages: Array.from({ length: 30 }, (_, i) => mkMsg(i + 1)),
            leadName: 'Ali',
            hasMore: false,
          }))
      );

    const view = await mount(render());
    const threadBefore = view.host.querySelector('#thread div.overflow-y-auto');
    installBoxModel(threadBefore);
    await act(async () => { threadBefore.scrollTop = 30; });

    // Conversation 1 receives new activity -> must jump to the top.
    convs[0].last_message_at = ts(99);
    convs.sort(compareConversationsByActivityDesc);
    await view.update(render());

    const rows = Array.from(view.host.querySelectorAll('[class*="cursor-pointer"]'));
    const firstText = (rows[0]?.textContent || '') + (view.host.textContent || '');
    assert.ok(firstText.includes('Ali'), 'the conversation with new activity must be on top');

    const threadAfter = view.host.querySelector('#thread div.overflow-y-auto');
    assert.equal(threadAfter, threadBefore, 'the active chat must NOT be remounted');
    assert.equal(threadAfter.scrollTop, 30, 'its scroll position must be preserved');
    assert.equal(selectedId, 1, 'the selection must not change');
    await view.unmount();
  });

  // ================================================================== UNREAD DOM
  // Payloads produced by the REAL backend (`scratch/p6_dump_ws_payloads.py`),
  // so this is a genuine DB -> WS -> React assertion rather than a lookalike.
  const fx = JSON.parse(await readFile(fixturesPath, 'utf8'));

  await check('unread-render: a real external-read payload clears the badge in the DOM', async () => {
    let conv = mkConv(fx.conversation_id, 'Ayse Demir', fx.baseline.unread_count, fx.ws_external_read.conversation.last_message_at);
    const render = () => h(ConversationList, { conversations: [conv], selectedId: conv.id, onSelect: () => {} });
    const view = await mount(render());
    assert.ok((view.host.textContent || '').includes(String(fx.baseline.unread_count)), 'badge must render first');

    for (const key of ['ws_external_read', 'ws_stale_snapshot_older', 'ws_stale_snapshot_same_ts']) {
      const payload = fx[key].conversation;
      assert.equal(payload.unread_count, 0, `${key}: the backend must emit 0`);
      conv = applyConversationEvent(conv, payload);
      await view.update(render());
      assert.equal(conv.unread_count, 0, `${key}: merged state must stay 0`);
      assert.ok(
        !(view.host.textContent || '').includes(String(fx.baseline.unread_count)),
        `${key}: the badge must not be in the DOM`
      );
    }
    await view.unmount();
  });

  // ================================================================ IDENTITY DOM
  await check('identity-render: an unresolved LID shows the deterministic value, then the real identity', async () => {
    let conv = mkConv(9, null, 0, ts(10), { identity_state: 'UNRESOLVED', phone: null });
    const render = () =>
      h('div', null,
        h(ConversationList, { conversations: [conv], selectedId: 9, onSelect: () => {} }),
        h(ChatThread, { key: 9, messages: [mkMsg(1)], leadName: conv.lead_name, hasMore: false })
      );
    const view = await mount(render());
    const before = view.host.textContent || '';
    assert.ok(!before.includes('@lid') && !before.includes('@s.whatsapp.net'),
      'a raw technical JID must never be rendered');

    // The LID mapping arrives.
    conv = applyConversationEvent(conv, { id: 9, name: 'Mert Demir', phone: '+905551234567' });
    await view.update(render());
    const after = view.host.textContent || '';
    assert.ok(after.includes('Mert Demir'), 'the resolved name must be rendered everywhere');
    assert.equal(conv.id, 9, 'the conversation identity must not change');
    await view.unmount();
  });

  // =================================================================== GROUP DOM
  await check('group-render: late group metadata updates the title without disturbing the thread', async () => {
    let conv = mkConv(11, null, 0, ts(10), { is_group: true });
    const messages = [mkMsg(1), mkMsg(2)];
    const render = () =>
      h('div', null,
        h(ConversationList, { conversations: [conv], selectedId: 11, onSelect: () => {} }),
        h(ChatThread, { key: 11, messages, leadName: conv.lead_name, isGroup: true, hasMore: false })
      );
    const view = await mount(render());
    const previewBefore = conv.last_message_preview;
    const lastAtBefore = conv.last_message_at;
    const orderBefore = [conv];

    conv = applyConversationEvent(conv, { id: 11, name: 'Pazarlama Ekibi' });
    await view.update(render());

    assert.ok((view.host.textContent || '').includes('Pazarlama Ekibi'), 'the group subject must render');
    assert.equal(conv.last_message_preview, previewBefore, 'the preview must not change');
    assert.equal(conv.last_message_at, lastAtBefore, 'last_message_at must not move');
    assert.deepEqual(orderBefore.map((c) => c.id), [11], 'ordering must be unchanged');
    await view.unmount();
  });

  // Switching conversations must not inherit the previous thread's viewport.
  await check('conversation-switch: opening another chat lands on the newest message', async () => {
    const convA = Array.from({ length: 30 }, (_, i) => mkMsg(i + 1));
    const convB = Array.from({ length: 50 }, (_, i) => mkMsg(i + 1000));
    const view = await mount(h(ChatThread, { messages: convA, hasMore: false, leadName: 'A' }));
    const el = threadContainer(view.host);

    // The user scrolled up to read history in conversation A.
    await act(async () => { el.scrollTop = 0; });
    await fireScroll(el);
    assert.notEqual(el.scrollTop, el.scrollHeight - el.clientHeight, 'precondition: reading history');

    // Now switch to conversation B the way the hub page does: `ChatThread` is
    // keyed by conversation id, so React unmounts A and mounts a fresh B.
    await view.update(h(ChatThread, { key: 900, messages: convB, hasMore: false, leadName: 'B' }));
    const elB = threadContainer(view.host);

    assert.notEqual(elB, el, 'switching conversations must mount a fresh thread');
    assert.ok((elB.textContent || '').includes('mesaj-1049#'), 'the newest message must be rendered');
    assert.equal(
      elB.scrollTop,
      elB.scrollHeight - elB.clientHeight,
      'switching conversations must land at the bottom, not inherit A\'s viewport'
    );
    assert.equal(pill(view.host), null, 'no spurious new-message pill on switch');
    await view.unmount();
  });

  // A draft must never follow the user into another conversation: `onSend`
  // delivers to the *currently selected* chat.
  await check('composer-isolation: switching conversations must not carry the draft over', async () => {
    const render = (key) =>
      h(ChatComposer, { key, onSend: () => {}, onSendMediaFile: async () => {} });
    const view = await mount(render(1));
    const input = view.host.querySelector('input[type="text"]');
    assert.ok(input, 'composer input must render');

    // Type a draft intended for conversation 1.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, 'bu mesaj baskasina gitmemeli');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(input.value, 'bu mesaj baskasina gitmemeli', 'draft must be typed');

    // Switch conversation (the hub page keys the composer by conversation id).
    await view.update(render(2));
    const nextInput = view.host.querySelector('input[type="text"]');
    assert.notEqual(nextInput.value, 'bu mesaj baskasina gitmemeli',
      'the draft leaked into another conversation');
    assert.equal(nextInput.value, '', 'the composer must be empty after a switch');
    await view.unmount();
  });

  await falsify('composer-isolation: an unkeyed composer really does leak the draft', async () => {
    // FALSIFICATION: reuse the SAME instance (no key) — what an unkeyed
    // ChatComposer does today.
    const view = await mount(h(ChatComposer, { onSend: () => {}, onSendMediaFile: async () => {} }));
    const input = view.host.querySelector('input[type="text"]');
    try {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        ).set;
        setter.call(input, 'bu mesaj baskasina gitmemeli');
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await view.update(h(ChatComposer, { onSend: () => {}, onSendMediaFile: async () => {} }));
      const after = view.host.querySelector('input[type="text"]');
      assert.equal(after.value, '', 'expected the unkeyed composer to leak the draft');
    } finally {
      await view.unmount();
    }
  });

  // §7 — the P6-5 fix must not over-correct: keying the composer clears the
  // draft on a SWITCH, but a state update in the SAME conversation must not.
  await check('composer-persistence: an update in the same chat keeps the draft and delivers it', async () => {
    const sent = [];
    const render = (key, placeholder) =>
      h(ChatComposer, {
        key,
        placeholder,
        onSend: async (text) => { sent.push(text); },
        onSendMediaFile: async () => {},
      });

    const view = await mount(render(1, 'A'));
    const input = view.host.querySelector('input[type="text"]');
    assert.ok(input, 'composer input must render');
    await typeInto(input, 'A icin mesaj');

    // A WS patch, an inbound message or a sidebar reorder all re-render the hub
    // page. The key is unchanged, so the composer must survive.
    await view.update(render(1, 'A (updated)'));
    const same = view.host.querySelector('input[type="text"]');
    assert.equal(same, input, 'an update in the same conversation must not remount the composer');
    assert.equal(same.value, 'A icin mesaj', 'the draft must survive a same-conversation update');

    await pressEnter(same);
    assert.deepEqual(
      sent,
      ['A icin mesaj'],
      'the draft must be delivered to the conversation it was typed in'
    );
    await view.unmount();
  });

  // §7 — the end-to-end wrong-recipient scenario: type in A, switch to B, type
  // in B and send. Only B's text may be delivered.
  await check('composer-send: after a switch, only the newly typed text is sent', async () => {
    const sent = [];
    const render = (key) =>
      h(ChatComposer, {
        key,
        onSend: async (text) => { sent.push(text); },
        onSendMediaFile: async () => {},
      });

    const view = await mount(render(1));
    await typeInto(view.host.querySelector('input[type="text"]'), 'A icin mesaj');

    await view.update(render(2));
    const inputB = view.host.querySelector('input[type="text"]');
    assert.equal(inputB.value, '', 'the switched-to composer must be empty');
    await typeInto(inputB, 'B icin mesaj');
    await pressEnter(view.host.querySelector('input[type="text"]'));

    assert.deepEqual(sent, ['B icin mesaj'], "A's draft must never reach B");
    assert.ok(
      !sent.some((s) => s.includes('A icin')),
      "A's text leaked into the send for B"
    );
    await view.unmount();
  });

  // §8 — switch and reorder in ONE test: a switch must remount and land at the
  // newest message; a reorder of the SAME conversation must NOT remount.
  await check('conversation-switch-and-reorder: switch remounts, reorder does not', async () => {
    const convA = Array.from({ length: 30 }, (_, i) => mkMsg(i + 1));
    const convB = Array.from({ length: 50 }, (_, i) => mkMsg(i + 1000));
    const view = await mount(h(ChatThread, { key: 1, messages: convA, hasMore: false, leadName: 'A' }));
    const elA = threadContainer(view.host);

    // Read history in A.
    await act(async () => { elA.scrollTop = 0; });
    await fireScroll(elA);
    assert.notEqual(elA.scrollTop, elA.scrollHeight - elA.clientHeight, 'precondition: reading history');

    // --- switch to B ---
    await view.update(h(ChatThread, { key: 2, messages: convB, hasMore: false, leadName: 'B' }));
    const elB = threadContainer(view.host);
    assert.notEqual(elB, elA, 'a switch must mount a fresh thread');
    assert.equal(
      elB.scrollTop,
      elB.scrollHeight - elB.clientHeight,
      'switching must land at the newest message, not inherit A\'s viewport'
    );
    assert.equal(pill(view.host), null, 'no spurious pill on switch');

    // --- reorder: new activity in B moves it in the sidebar, id unchanged ---
    const withNew = [...convB, mkMsg(2000)];
    await view.update(h(ChatThread, { key: 2, messages: withNew, hasMore: false, leadName: 'B' }));
    const elB2 = threadContainer(view.host);
    assert.equal(elB2, elB, 'a reorder must NOT remount the active chat');
    assert.ok((elB2.textContent || '').includes('mesaj-2000#'), 'the new message must be rendered');
    await view.unmount();
  });

  console.log(`\nWhatsApp DOM verification: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
  // jsdom's `pretendToBeVisual` keeps a rAF timer alive, so the process would
  // otherwise never exit once the script reaches the end.
  dom.window.close();
}
// The jsdom event loop keeps handles open; exit explicitly with the result.
process.exit(0);
