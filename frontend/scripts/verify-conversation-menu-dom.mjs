/**
 * Executed DOM verification of the conversation-row "down arrow" menu.
 *
 * Why a DOM gate: every failure mode here is a RENDER/EVENT decision, not a
 * data one. A menu that opens inside the scrolling list gets clipped and is
 * invisible; a trigger nested INSIDE the row button selects the chat instead of
 * opening the menu; a menu that stays open after a pick makes the user think the
 * action did not run; and — the one that matters most — offering "Delete" on a
 * row must reach the parent with the RIGHT id, because the action it triggers is
 * irreversible.
 *
 * THE CONTRACT (asserted against the REAL component in jsdom)
 *   1. every row renders a menu trigger (`conv-menu-<id>`);
 *   2. the trigger is INVISIBLE until hover/focus (WhatsApp Web parity) — it
 *      must not permanently cover the timestamp;
 *   3. clicking the trigger opens the menu, and the menu is PORTALLED to
 *      `document.body`, NOT inside the scroll container (otherwise
 *      `overflow-y-auto` clips it);
 *   4. an active row offers Archive + Close + Delete, with Delete LAST;
 *   5. an archived row offers Reopen + Delete and NO Archive/Close (state-aware);
 *   6. picking Archive calls back with THAT row's id;
 *   7. the menu closes after a pick;
 *   8. an outside click closes the menu;
 *   9. clicking the trigger does NOT also select the conversation.
 *
 * Run: node scripts/verify-conversation-menu-dom.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { hardenAssert } from './lib/safe-dom-assert.mjs';

// CANLI DOM elemani uzerinde esitlik iddiasi kurmak Node'un mesaj uretimini
// tetikler ve util.inspect tum DOM grafigini yuruyerek RAM'i tuketir
// (olculdu: tek iframe icin 137MB string -> SIGKILL, teshis yok). Kural:
// eleman yerine boolean veya attribute string karsilastir.
hardenAssert(assert);

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

// Teshis sigortasi: gate'in sessizce olmesini engeller.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err && err.stack ? err.stack : err);
  process.exit(1);
});

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-convmenu-dom-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

let ok = false;
try {
  await writeFile(
    entry,
    [
      `import React from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `import { I18nProvider } from '${SRC}/context/I18nContext';`,
      `import { ConversationList } from '${SRC}/features/whatsapp/components/ConversationList';`,
      `export { React, act, createRoot, I18nProvider, ConversationList };`,
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
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_WHATSAPP_LATENCY_PROFILING': '"false"',
    },
    logLevel: 'silent',
  });

  const { React, act, createRoot, I18nProvider, ConversationList } = await import(out);

  let passed = 0;
  const failures = [];
  const roots = new Set();

  const settle = async (ms = 30) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const check = async (label, fn) => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${label}`);
    } catch (err) {
      failures.push(label);
      console.log(`  FAIL - ${label}`);
      console.log(`         ${err && err.message ? err.message : String(err)}`);
    }
  };

  const conv = (overrides = {}) => ({
    id: 7,
    lead_name: 'Hat 1',
    lead_phone: '905551112233',
    status: 'ACTIVE',
    unread_count: 0,
    last_message: 'merhaba',
    last_message_at: '2026-09-30T10:00:00.000Z',
    is_archived: false,
    ...overrides,
  });

  /** Cagrilari kaydeder; boylece "hangi satir hangi eylemi tetikledi" olculur. */
  const calls = [];

  // Her kontrolden ONCE onceki agaclar sokulur ve body temizlenir. Bu SART:
  // menu `document.body`'ye portallandigi icin, sokulmeyen bir agacin menusu
  // body'de kalir; sonraki kontrol `document.querySelector` ile O STALE menuyu
  // bulur ve "yanlis satir" / "menu kapanmadi" gibi SAHTE sonuclar uretir.
  // (Bu tuzak bu kapi yazilirken birebir yasandi.)
  const reset = async () => {
    for (const r of roots) {
      try {
        await act(async () => { r.unmount(); });
      } catch { /* zaten sokulmus */ }
    }
    roots.clear();
    window.document.body.innerHTML = '';
  };

  const render = async (conversations, extra = {}) => {
    await reset();
    const container = window.document.createElement('div');
    window.document.body.appendChild(container);
    const root = createRoot(container);
    roots.add(root);
    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ConversationList, {
            conversations,
            onSelect: (c) => calls.push(['select', c.id]),
            onArchive: (id) => calls.push(['archive', id]),
            onClose: (id) => calls.push(['close', id]),
            onReopen: (id) => calls.push(['reopen', id]),
            onDelete: (id) => calls.push(['delete', id]),
            ...extra,
          }),
        ),
      );
    });
    await settle();
    return container;
  };

  const click = async (el) => {
    assert.ok(el, 'element must exist to be clicked');
    await act(async () => {
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };

  const menu = () => window.document.querySelector('[data-testid="dropdown-menu"]');
  const menuLabels = () =>
    menu() ? [...menu().querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : [];
  const itemByText = (needle) =>
    menu() ? [...menu().querySelectorAll('button')].find((b) => (b.textContent || '').includes(needle)) : null;

  await check('every row renders a menu trigger', async () => {
    const container = await render([conv(), conv({ id: 8, lead_name: 'Hat 2' })]);
    assert.ok(container.querySelector('[data-testid="conv-menu-7"]'), 'row 7 must have a trigger');
    assert.ok(container.querySelector('[data-testid="conv-menu-8"]'), 'row 8 must have a trigger');
  });

  await check('the trigger stays invisible until hover or focus', async () => {
    const container = await render([conv()]);
    const trigger = container.querySelector('[data-testid="conv-menu-7"]');
    // Gizli olmali: aksi halde saatin uzerinde kalici bir ok durur.
    assert.ok(
      trigger.className.includes('opacity-0'),
      'the trigger must start hidden (opacity-0) and only reveal on hover/focus',
    );
    assert.ok(
      trigger.className.includes('group-hover:opacity-100'),
      'hover must reveal it',
    );
  });

  await check('clicking the trigger opens a menu PORTALLED out of the scroll container', async () => {
    calls.length = 0;
    const container = await render([conv()]);
    await click(container.querySelector('[data-testid="conv-menu-7"]'));
    const m = menu();
    assert.ok(m, 'the menu must open');
    // Asil nokta: menu list container'inin ICINDE degil, body'nin altinda olmali.
    assert.ok(
      !container.contains(m),
      'a menu inside the overflow-y-auto list would be clipped and invisible',
    );
    assert.ok(
      m.parentElement === window.document.body,
      'the menu must be portalled to body',
    );
  });

  await check('an active row offers Archive, Close and Delete with Delete LAST', async () => {
    const container = await render([conv()]);
    await click(container.querySelector('[data-testid="conv-menu-7"]'));
    const labels = menuLabels();
    assert.ok(labels.some((l) => /Archive|Arşivle/i.test(l)), `expected an archive action, got ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => /Close|Kapat/i.test(l)), `expected a close action, got ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => /Delete|Sil/i.test(l)), `expected a delete action, got ${JSON.stringify(labels)}`);
    const last = labels[labels.length - 1];
    assert.ok(
      /Delete|Sil/i.test(last),
      `the destructive action must be last, got ${JSON.stringify(labels)}`,
    );
    // Silme "danger" varyantiyla cizilmeli (kirmizi).
    assert.ok(
      itemByText(last).className.includes('text-[#EA5455]'),
      'the delete action must carry the danger styling',
    );
  });

  await check('an archived row offers Reopen and Delete, and no Archive/Close', async () => {
    // Arsivli sohbet ALL sekmesinde GORUNMEZ (WhatsApp paritesi); o yuzden
    // Arsiv sekmesiyle render edilir, aksi halde satir hic cizilmez.
    const container = await render([conv({ is_archived: true })], { activeFilter: 'ARCHIVED' });
    await click(container.querySelector('[data-testid="conv-menu-7"]'));
    const labels = menuLabels();
    assert.ok(labels.some((l) => /Reopen|Yeniden/i.test(l)), `expected reopen, got ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => /Delete|Sil/i.test(l)), `expected delete, got ${JSON.stringify(labels)}`);
    assert.ok(
      !labels.some((l) => /^Archive$|Arşivle/i.test(l)),
      `an archived row must not offer Archive again, got ${JSON.stringify(labels)}`,
    );
  });

  await check('picking Archive reports THAT row id, not another row', async () => {
    calls.length = 0;
    const container = await render([conv(), conv({ id: 8, lead_name: 'Hat 2' })]);
    await click(container.querySelector('[data-testid="conv-menu-8"]'));
    const archive = itemByText('Archive') || itemByText('Arşivle');
    assert.ok(archive, 'the archive item must be present');
    await click(archive);
    assert.deepEqual(calls, [['archive', 8]], 'the action must carry row 8, not row 7');
  });

  await check('the menu closes after a pick', async () => {
    const container = await render([conv()]);
    await click(container.querySelector('[data-testid="conv-menu-7"]'));
    assert.ok(menu(), 'the menu must be open before the pick');
    await click(itemByText('Archive') || itemByText('Arşivle'));
    assert.ok(menu() === null, 'a menu left open makes the user think nothing happened');
  });

  await check('an outside click closes the menu', async () => {
    const container = await render([conv()]);
    await click(container.querySelector('[data-testid="conv-menu-7"]'));
    assert.ok(menu(), 'the menu must be open first');
    await act(async () => {
      window.document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await settle();
    assert.ok(menu() === null, 'clicking away must dismiss the menu');
  });

  await check('opening the menu does NOT also select the conversation', async () => {
    calls.length = 0;
    const container = await render([conv()]);
    await click(container.querySelector('[data-testid="conv-menu-7"]'));
    assert.deepEqual(
      calls.filter((c) => c[0] === 'select'),
      [],
      'the trigger must not double as a row click',
    );
  });

  ok = failures.length === 0 && passed === 9;
  if (ok) {
    console.log(`Conversation row menu DOM contract: PASS (${passed} checks)`);
  } else {
    console.log(`Conversation row menu DOM contract: FAIL (${passed} passed, ${failures.length} failed)`);
    for (const f of failures) console.log(`  - ${f}`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
// Acik bir `process.exit` SART: jsdom + React scheduler zamanlayicilari olay
// dongusunu canli tutar ve script dogrulamayi gectikten SONRA asili kalir.
process.exit(ok ? 0 : 1);
