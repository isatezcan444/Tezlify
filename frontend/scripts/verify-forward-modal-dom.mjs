/**
 * Executed DOM verification of Message Forwarding & Multi-Select Bulk Actions.
 *
 * Verifies:
 * 1. ChatBubble renders forward trigger button and fires `onForward` callback when clicked.
 * 2. ChatBubble renders selection checkbox in `isSelectMode` and fires `onToggleSelect`.
 * 3. ForwardModal renders conversation list, supports searching/filtering targets.
 * 4. ForwardModal allows selecting multiple targets with visual check indicators.
 * 5. Confirm button dispatches `onConfirmForward` with selected conversation IDs and messages.
 *
 * Run: node frontend/scripts/verify-forward-modal-dom.mjs — exit code 0 = PASS.
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

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-forward-dom-'));
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
      `import { ForwardModal } from '${SRC}/features/whatsapp/components/ForwardModal';`,
      `export { React, act, createRoot, I18nProvider, ToastProvider, ChatBubble, ForwardModal };`,
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
    ForwardModal,
  } = await import(out);

  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);

  const renderWithProviders = async (node) => {
    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ToastProvider, null, node)
        )
      );
    });
  };

  const sampleMessage = {
    id: 101,
    conversation_id: 1,
    direction: 'INBOUND',
    sender_phone: '+905551234567',
    body: 'Merhabalar, teklifinizi iletebilir misiniz?',
    message_type: 'TEXT',
    status: 'READ',
    created_at: new Date().toISOString(),
  };

  const sampleConversations = [
    {
      id: 1,
      lead_id: 10,
      lead_name: 'Atlas Danışmanlık',
      lead_phone: '+905551234567',
      unread_count: 0,
      status: 'ACTIVE',
      last_message_preview: 'Merhaba',
      last_message_at: new Date().toISOString(),
    },
    {
      id: 2,
      lead_id: 11,
      lead_name: 'Borusan Lojistik',
      lead_phone: '+905329876543',
      unread_count: 1,
      status: 'ACTIVE',
      last_message_preview: 'Fiyat aldık',
      last_message_at: new Date().toISOString(),
    },
    {
      id: 3,
      lead_id: 12,
      lead_name: 'Grup Sohbeti',
      lead_phone: '+905440001122',
      is_group: true,
      unread_count: 0,
      status: 'ACTIVE',
      last_message_preview: 'Toplantı notları',
      last_message_at: new Date().toISOString(),
    },
  ];

  // =========================================================================
  // TEST 1: ChatBubble Forward Trigger & Multi-Select Checkbox
  // =========================================================================
  console.log('[TEST 1] Testing ChatBubble Forward Trigger & Selection Checkbox...');
  let forwardedMessage = null;
  let toggledId = null;

  await renderWithProviders(
    React.createElement(ChatBubble, {
      message: sampleMessage,
      onForward: (msg) => {
        forwardedMessage = msg;
      },
      isSelectMode: true,
      isSelected: false,
      onToggleSelect: (id) => {
        toggledId = id;
      },
    })
  );

  const forwardBtn = window.document.querySelector('[data-testid="forward-trigger-101"]');
  assert.ok(forwardBtn, 'ChatBubble hover action bar must contain data-testid="forward-trigger-101"');

  await act(async () => {
    forwardBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(forwardedMessage?.id, 101, 'Clicking forward button should invoke onForward with message');

  const selectCheckbox = window.document.querySelector('[data-testid="select-checkbox-101"]');
  assert.ok(selectCheckbox, 'ChatBubble in select mode must render data-testid="select-checkbox-101"');

  await act(async () => {
    selectCheckbox.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(toggledId, 101, 'Clicking select checkbox must invoke onToggleSelect with message ID');
  console.log('✓ PASS: ChatBubble forward trigger and multi-select checkbox verified.');

  // =========================================================================
  // TEST 2: ForwardModal Target Selection & Dispatch
  // =========================================================================
  console.log('[TEST 2] Testing ForwardModal Target Selection & Dispatch...');
  let confirmedTargets = null;
  let confirmedMessages = null;
  let modalClosed = false;

  await renderWithProviders(
    React.createElement(ForwardModal, {
      isOpen: true,
      onClose: () => {
        modalClosed = true;
      },
      messagesToForward: [sampleMessage],
      conversations: sampleConversations,
      onConfirmForward: (targetIds, msgs) => {
        confirmedTargets = targetIds;
        confirmedMessages = msgs;
      },
    })
  );

  const modalRoot = window.document.querySelector('[data-testid="forward-modal"]');
  assert.ok(modalRoot, 'ForwardModal must render with data-testid="forward-modal"');

  // Verify all conversations are rendered initially
  const target1 = window.document.querySelector('[data-testid="forward-target-1"]');
  const target2 = window.document.querySelector('[data-testid="forward-target-2"]');
  const target3 = window.document.querySelector('[data-testid="forward-target-3"]');
  assert.ok(target1 && target2 && target3, 'ForwardModal must render all available conversation targets');

  // Search filter
  const searchInput = window.document.querySelector('[data-testid="forward-search-input"]');
  assert.ok(searchInput, 'ForwardModal must render search input');

  const setInputValue = (input, val) => {
    const proto = window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(input, val);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };

  await act(async () => {
    setInputValue(searchInput, 'Borusan');
  });

  const visibleTarget1 = window.document.querySelector('[data-testid="forward-target-1"]');
  const visibleTarget2 = window.document.querySelector('[data-testid="forward-target-2"]');
  assert.equal(visibleTarget1, null, 'Filtered out conversation 1 must not be visible');
  assert.ok(visibleTarget2, 'Matching conversation "Borusan" must remain visible');

  // Clear search
  await act(async () => {
    setInputValue(searchInput, '');
  });

  // Select target 1 and target 2
  await act(async () => {
    const t1 = window.document.querySelector('[data-testid="forward-target-1"]');
    t1.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });

  await act(async () => {
    const t2 = window.document.querySelector('[data-testid="forward-target-2"]');
    t2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });

  const confirmBtn = window.document.querySelector('[data-testid="confirm-forward-btn"]');
  assert.ok(confirmBtn, 'ForwardModal must have confirm button data-testid="confirm-forward-btn"');
  assert.equal(confirmBtn.disabled, false, 'Confirm button must be enabled when targets are selected');

  // Dispatch forward
  await act(async () => {
    confirmBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });

  assert.deepEqual(confirmedTargets?.sort(), [1, 2], 'Confirmed targets must include selected IDs [1, 2]');
  assert.equal(confirmedMessages?.length, 1, 'Confirmed messages must match messages to forward');
  assert.equal(confirmedMessages[0].id, 101, 'Forwarded message ID must be 101');
  assert.equal(modalClosed, true, 'ForwardModal must close upon successful forward confirmation');
  console.log('✓ PASS: ForwardModal selection, search filtering, and dispatch verified.');

  console.log('\n========================================');
  console.log('ALL FORWARD MODAL & MULTI-SELECT DOM TESTS PASSED!');
  console.log('========================================');
  process.exit(0);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
