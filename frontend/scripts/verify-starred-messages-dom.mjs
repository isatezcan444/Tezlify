/**
 * Executed DOM verification of Starred Messages (Yıldızlı Mesajlar) parity.
 *
 * Verifies:
 * 1. ChatBubble renders star action trigger and updates gold star icon on click.
 * 2. Star status is persisted in localStorage via `starredMessages` state module.
 * 3. ChatInfoDrawer displays dynamic starred messages count.
 * 4. Clicking Starred Messages section opens the sub-view list with sender, body, and timestamp.
 * 5. Starred sub-view allows unstarring a message, updating the count reactively.
 * 6. Back button returns to the main drawer view.
 *
 * Run: node frontend/scripts/verify-starred-messages-dom.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { hardenAssert } from './lib/safe-dom-assert.mjs';

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
  } catch {
    globalThis[name] = value;
  }
};
setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('navigator', window.navigator);
setGlobal('HTMLElement', window.HTMLElement);
setGlobal('KeyboardEvent', window.KeyboardEvent);
setGlobal('MouseEvent', window.MouseEvent);
setGlobal('Element', window.Element);
setGlobal('localStorage', window.localStorage);
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-starred-dom-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

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
      `import { ChatInfoDrawer } from '${SRC}/features/whatsapp/components/ChatInfoDrawer';`,
      `import { isMessageStarred, toggleMessageStar, clearStarredMessages } from '${SRC}/features/whatsapp/lib/starredMessages';`,
      `export { React, act, createRoot, I18nProvider, ToastProvider, ChatBubble, ChatInfoDrawer, isMessageStarred, toggleMessageStar, clearStarredMessages };`,
    ].join('\n'),
    'utf8'
  );

  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    absWorkingDir: frontendRoot,
    nodePaths: [path.join(frontendRoot, 'node_modules')],
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env': '{}',
    },
    logLevel: 'silent',
  });

  const {
    React,
    act,
    createRoot,
    I18nProvider,
    ToastProvider,
    ChatBubble,
    ChatInfoDrawer,
    isMessageStarred,
    toggleMessageStar,
    clearStarredMessages,
  } = await import(out);
  const h = React.createElement;

  let passed = 0;
  const roots = new Set();

  const cleanup = async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots.clear();
    window.document.body.innerHTML = '';
    clearStarredMessages();
  };

  const mount = async (element) => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    await act(async () => {
      root.render(
        h(I18nProvider, null,
          h(ToastProvider, null, element)
        )
      );
    });
    return host;
  };

  console.log('Running Starred Messages DOM Verification...');

  // Test 1: ChatBubble star toggle and icon rendering
  {
    await cleanup();
    const testMsg = {
      id: 501,
      conversation_id: 10,
      direction: 'INBOUND',
      message_type: 'TEXT',
      body: 'Acil teklif detaylarini bu mesaja ekledim, lütfen inceleyin.',
      created_at: '2026-10-03T14:30:00Z',
    };

    const host = await mount(h(ChatBubble, { message: testMsg }));

    // Star trigger must be rendered
    const starTrigger = host.querySelector(`[data-testid='star-trigger-${testMsg.id}']`);
    assert(starTrigger !== null, 'ChatBubble hover bar must contain star trigger button');

    // Initially unstarred
    assert.equal(isMessageStarred(testMsg.id), false, 'Message should initially not be starred');
    assert.equal(
      host.querySelector(`[data-testid='msg-starred-icon-${testMsg.id}']`),
      null,
      'Message bubble footer must NOT show star icon when unstarred'
    );

    // Click star button
    await act(async () => {
      starTrigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    // Should now be starred in storage and DOM
    assert.equal(isMessageStarred(testMsg.id), true, 'Message should now be marked starred');
    const starIcon = host.querySelector(`[data-testid='msg-starred-icon-${testMsg.id}']`);
    assert(starIcon !== null, 'Message bubble footer must render gold star icon when starred');

    passed++;
    console.log('  ok - ChatBubble toggles star state and renders star indicator');
  }

  // Test 2: ChatInfoDrawer dynamic starred count and sub-view navigation
  {
    await cleanup();
    const conv = {
      id: 10,
      lead_name: 'Ahmet Yılmaz',
      lead_phone: '+905551234567',
      is_group: false,
      status: 'ACTIVE',
    };

    const messages = [
      {
        id: 101,
        conversation_id: 10,
        direction: 'INBOUND',
        message_type: 'TEXT',
        body: 'Yıldızlanacak ilk önemli mesaj',
        created_at: '2026-10-03T10:00:00Z',
      },
      {
        id: 102,
        conversation_id: 10,
        direction: 'OUTBOUND',
        message_type: 'TEXT',
        body: 'Yıldızlanacak ikinci mesaj',
        created_at: '2026-10-03T11:00:00Z',
      },
      {
        id: 103,
        conversation_id: 10,
        direction: 'INBOUND',
        message_type: 'TEXT',
        body: 'Normal mesaj',
        created_at: '2026-10-03T12:00:00Z',
      },
    ];

    // Star message 101 and 102
    toggleMessageStar(101, 10);
    toggleMessageStar(102, 10);

    let jumpedMessageId = null;
    const host = await mount(
      h(ChatInfoDrawer, {
        isOpen: true,
        onClose: () => {},
        conversation: conv,
        messages: messages,
        onJumpToMessage: (id) => {
          jumpedMessageId = id;
        },
      })
    );

    // Verify count badge
    const countBadge = host.querySelector("[data-testid='drawer-starred-count']");
    assert(countBadge !== null, 'ChatInfoDrawer must display starred messages count badge');
    assert.equal(countBadge.textContent.trim(), '2', 'Count badge must display 2');

    // Click Starred Messages section to enter sub-view
    const starredSection = host.querySelector("[data-testid='drawer-starred-section']");
    assert(starredSection !== null, 'Starred Messages section trigger must be present');
    await act(async () => {
      starredSection.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    // Sub-view list must be present
    const starredList = host.querySelector("[data-testid='drawer-starred-list']");
    assert(starredList !== null, 'Starred messages sub-view list must be mounted');

    // Check cards
    const card101 = host.querySelector("[data-testid='starred-card-101']");
    const card102 = host.querySelector("[data-testid='starred-card-102']");
    assert(card101 !== null, 'Card for message 101 must be rendered');
    assert(card102 !== null, 'Card for message 102 must be rendered');
    assert(card101.textContent.includes('Yıldızlanacak ilk önemli mesaj'), 'Card must contain message body');

    // Test Jump To Message click
    await act(async () => {
      card101.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(jumpedMessageId, 101, 'Clicking card must invoke onJumpToMessage with id 101');

    // Test Unstar from drawer
    const unstarBtn = host.querySelector("[data-testid='unstar-btn-101']");
    assert(unstarBtn !== null, 'Unstar button must be rendered on card');
    await act(async () => {
      unstarBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    assert.equal(isMessageStarred(101), false, 'Message 101 must now be unstarred');
    assert.equal(host.querySelector("[data-testid='starred-card-101']"), null, 'Card 101 should be removed');

    // Test Back button
    const backBtn = host.querySelector("[data-testid='back-info-drawer-btn']");
    assert(backBtn !== null, 'Back button must be present in sub-view');
    await act(async () => {
      backBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    // Must return to main drawer view
    assert(host.querySelector("[data-testid='drawer-starred-section']") !== null, 'Must return to main drawer view');
    const updatedCount = host.querySelector("[data-testid='drawer-starred-count']");
    assert.equal(updatedCount.textContent.trim(), '1', 'Count must reflect remaining starred message');

    passed++;
    console.log('  ok - ChatInfoDrawer displays live count, opens Starred Messages sub-view, and handles unstar/back');
  }

  await cleanup();
  console.log('\n===========================================');
  console.log(`All ${passed}/${passed} Starred Messages DOM tests passed cleanly!`);
  console.log('===========================================\n');
  process.exit(0);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
