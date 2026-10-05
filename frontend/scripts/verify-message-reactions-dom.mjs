/**
 * Executed DOM verification of the message-reaction contract in ChatBubble.
 *
 * A reaction is NOT a message, so most of what can go wrong here is invisible
 * to a data-layer test: a chip that never renders, a click that sends the wrong
 * emoji, a "withdraw" that sends the emoji again, or an optimistic (not yet
 * persisted) bubble that offers a reaction the backend would 404.
 *
 * THE CONTRACT (asserted against the REAL component in jsdom)
 *   1. chips group by emoji and carry a COUNT when several people reacted;
 *   2. a chip that includes MY reaction WITHDRAWS it when clicked (`''`);
 *   3. a chip that is only someone else's ADDS mine (same emoji);
 *   4. the hover trigger opens the quick bar with the six WhatsApp reactions;
 *   5. picking from the quick bar calls `onReact(messageId, emoji)`;
 *   6. an optimistic message (string id) offers NO reaction affordance at all —
 *      the `/reactions` endpoint only knows persisted rows;
 *   7. the full picker ("+") opens and picking from it reacts too.
 *
 * Run: node scripts/verify-message-reactions-dom.mjs — exit code 0 = PASS.
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

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-reactions-dom-'));
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
      `import { ToastProvider } from '${SRC}/context/ToastContext';`,
      `import { ChatBubble } from '${SRC}/features/whatsapp/components/ChatBubble';`,
      `export { React, act, createRoot, I18nProvider, ToastProvider, ChatBubble };`,
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
    // Vite'in `import.meta.env`'i duz node'da yok; latency modulu "kapali"
    // olarak sabitlenir (testin olctugu sey profil degil, davranis).
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_WHATSAPP_LATENCY_PROFILING': '"false"',
    },
    logLevel: 'silent',
  });

  const { React, act, createRoot, I18nProvider, ToastProvider, ChatBubble } = await import(out);

  let passed = 0;
  const roots = new Set();

  const settle = async (ms = 40) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const renderBubble = async (message, onReact) => {
    const container = window.document.createElement('div');
    window.document.body.appendChild(container);
    const root = createRoot(container);
    roots.add(root);
    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(
            ToastProvider,
            null,
            React.createElement(ChatBubble, { message, onReact }),
          ),
        ),
      );
    });
    await settle();
    return container;
  };

  const check = async (label, fn) => {
    await fn();
    passed += 1;
    console.log(`  ok - ${label}`);
  };

  const baseMessage = (overrides = {}) => ({
    id: 101,
    conversation_id: 7,
    direction: 'INBOUND',
    message_type: 'TEXT',
    status: 'RECEIVED',
    body: 'merhaba',
    created_at: '2026-09-30T10:00:00.000Z',
    ...overrides,
  });

  const click = async (el) => {
    assert.ok(el, 'element must exist');
    await act(async () => {
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };

  // --- 1. Rozetler gruplanir ve sayac tasir ---------------------------------
  await check('chips group by emoji and carry a count', async () => {
    const container = await renderBubble(
      baseMessage({
        reactions: [
          { message_id: 101, emoji: '👍', from_me: false, reactor_jid: 'peer' },
          { message_id: 101, emoji: '👍', from_me: true, reactor_jid: 'ME' },
        ],
      }),
      () => {},
    );
    const chips = container.querySelector('[data-testid="reaction-chips-101"]');
    assert.ok(chips, 'reaction chip row must render');
    const buttons = chips.querySelectorAll('button');
    assert.equal(buttons.length, 1, 'two reactors on the same emoji = ONE chip');
    assert.match(buttons[0].textContent, /👍/);
    assert.match(buttons[0].textContent, /2/, 'a multi-reactor chip shows the count');
  });

  // --- 2. Kendi rozetime tiklamak GERI CEKER --------------------------------
  await check('clicking a chip that includes my reaction withdraws it', async () => {
    const calls = [];
    const container = await renderBubble(
      baseMessage({
        reactions: [{ message_id: 101, emoji: '❤️', from_me: true, reactor_jid: 'ME' }],
      }),
      async (id, emoji) => { calls.push([id, emoji]); },
    );
    await click(container.querySelector('[data-testid="reaction-chips-101"] button'));
    assert.deepEqual(calls, [[101, '']], 'withdrawing must send an EMPTY emoji');
  });

  // --- 3. Baskasinin rozetine tiklamak BENIMKINI ekler -----------------------
  await check('clicking a peer-only chip adds my reaction', async () => {
    const calls = [];
    const container = await renderBubble(
      baseMessage({
        reactions: [{ message_id: 101, emoji: '😂', from_me: false, reactor_jid: 'peer' }],
      }),
      async (id, emoji) => { calls.push([id, emoji]); },
    );
    await click(container.querySelector('[data-testid="reaction-chips-101"] button'));
    assert.deepEqual(calls, [[101, '😂']]);
  });

  // --- 4/5. Hizli cubuk: altı ifade ve gercek geri cagri ---------------------
  await check('the hover trigger opens the quick bar and picking reacts', async () => {
    const calls = [];
    const container = await renderBubble(baseMessage(), async (id, emoji) => {
      calls.push([id, emoji]);
    });
    const trigger = container.querySelector('[data-testid="reaction-trigger-101"]');
    assert.ok(trigger, 'a persisted message offers the reaction trigger');
    assert.ok(container.querySelector('[data-testid="reaction-bar-101"]') === null, 'bar starts closed');
    await click(trigger);
    const bar = container.querySelector('[data-testid="reaction-bar-101"]');
    assert.ok(bar, 'the quick bar must open');
    const quick = [...bar.querySelectorAll('button')];
    assert.equal(quick.length, 7, 'six quick emojis + the "more" button');
    await click(quick[0]);
    assert.equal(calls.length, 1, 'picking calls onReact exactly once');
    assert.equal(calls[0][0], 101);
    assert.equal(calls[0][1], quick[0].textContent.trim(), 'the CLICKED emoji is the one sent');
  });

  // --- 6. Iyimser satir tepki sunmaz ----------------------------------------
  await check('an optimistic (string id) message offers no reaction affordance', async () => {
    const container = await renderBubble(baseMessage({ id: 'optimistic_cmsg_1' }), () => {});
    assert.ok(container.querySelector('[data-testid="reaction-trigger-optimistic_cmsg_1"]') === null, 'no trigger for an optimistic row');
    assert.ok(container.querySelector('[data-testid^="reaction-chips-"]') === null, 'no chips for an optimistic row');
  });

  // --- 7. Tam panel: "+" → EmojiPicker → gercek secim ------------------------
  await check('the "+" button opens the full picker and picking reacts', async () => {
    const calls = [];
    const container = await renderBubble(baseMessage(), async (id, emoji) => {
      calls.push([id, emoji]);
    });
    await click(container.querySelector('[data-testid="reaction-trigger-101"]'));
    const bar = container.querySelector('[data-testid="reaction-bar-101"]');
    await click([...bar.querySelectorAll('button')][6]); // "+"
    await settle(80);
    const grid = window.document.querySelector('[data-testid="emoji-grid"]');
    assert.ok(grid, 'the full emoji picker must open (grid present)');
    const gridButtons = [...grid.querySelectorAll('button')];
    assert.ok(gridButtons.length > 0, 'the picker grid must render emoji buttons');
    const chosen = gridButtons[0];
    const chosenEmoji = chosen.textContent.trim();
    await click(chosen);
    assert.equal(calls.length, 1, 'picking from the full panel reacts once');
    assert.equal(calls[0][1], chosenEmoji, 'the picked emoji is sent verbatim');
    assert.ok(window.document.querySelector('[data-testid="emoji-grid"]') === null, 'the panel closes after a pick');
  });

  // --- 8. İfade bırakılan mesaj altında yeterli boşluk (!mb-5 / !mb-6) bırakılır --
  await check('a message with reactions leaves generous bottom spacing (!mb-5 or !mb-6)', async () => {
    const reactedContainer = await renderBubble(
      baseMessage({ reactions: [{ emoji: '👍', sender: 'peer', is_from_me: false }] }),
      () => {},
    );
    const reactedDiv = reactedContainer.querySelector('div.relative.flex.w-full');
    assert.ok(reactedDiv, 'reacted row root must render');
    assert.ok(
      reactedDiv.className.includes('!mb-5') || reactedDiv.className.includes('!mb-6'),
      `reacted row must have !mb-5 or !mb-6 (got: ${reactedDiv.className})`,
    );

    const plainContainer = await renderBubble(baseMessage({ reactions: [] }), () => {});
    const plainDiv = plainContainer.querySelector('div.relative.flex.w-full');
    assert.ok(plainDiv, 'plain row root must render');
    assert.ok(
      !plainDiv.className.includes('!mb-5') && !plainDiv.className.includes('!mb-6'),
      `plain row must not have !mb-5 (got: ${plainDiv.className})`,
    );
  });

  ok = true;
  console.log(`Message reactions DOM contract: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
// Acik bir `process.exit` SART: jsdom + React scheduler zamanlayicilari olay
// dongusunu canli tutuyor ve script dogrulamayi gectikten SONRA asili kaliyordu
// (ayni sinif hata `verify-whatsapp-realtime-inbound.mjs`'de yasandi).
process.exit(ok ? 0 : 1);
