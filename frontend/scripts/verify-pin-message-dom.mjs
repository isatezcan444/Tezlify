/**
 * Executed DOM verification of Message Pinning (Mesaj Sabitleme) feature.
 *
 * Verifies:
 * 1. ChatBubble renders pinned badge and icon when message is pinned.
 * 2. ChatBubble renders pin/unpin hover triggers and triggers onPin / onUnpin callbacks.
 * 3. PinnedMessagesBar renders sticky header with snippet, jump button, unpin button, and multi-pin counter.
 * 4. PinDurationModal renders duration options (24h, 7d, 30d) and calls onConfirm with chosen duration.
 *
 * Run: node frontend/scripts/verify-pin-message-dom.mjs — exit code 0 = PASS.
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
setGlobal('sessionStorage', window.sessionStorage);
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-pin-dom-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

try {
  await writeFile(
    entry,
    [
      `import React from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `import { ChatBubble } from '${path.join(SRC, 'features/whatsapp/components/ChatBubble.tsx')}';`,
      `import { PinnedMessagesBar } from '${path.join(SRC, 'features/whatsapp/components/PinnedMessagesBar.tsx')}';`,
      `import { PinDurationModal } from '${path.join(SRC, 'features/whatsapp/components/PinDurationModal.tsx')}';`,
      `import { ToastProvider } from '${path.join(SRC, 'context/ToastContext.tsx')}';`,
      `import { I18nProvider } from '${path.join(SRC, 'context/I18nContext.tsx')}';`,
      ``,
      `export { act };`,
      ``,
      `export function renderPinComponents({`,
      `  unpinnedMsg,`,
      `  pinnedMsg,`,
      `  onPin,`,
      `  onUnpin,`,
      `  onJump,`,
      `  onConfirmDuration,`,
      `  isModalOpen,`,
      `  pinnedList,`,
      `}) {`,
      `  const container = document.createElement('div');`,
      `  document.body.appendChild(container);`,
      `  const root = createRoot(container);`,
      `  root.render(`,
      `    <I18nProvider>`,
      `      <ToastProvider>`,
      `        <div id="test-wrapper">`,
      `          <PinnedMessagesBar`,
      `            pinnedMessages={pinnedList}`,
      `            onJumpToMessage={onJump}`,
      `            onUnpinMessage={onUnpin}`,
      `          />`,
      `          <ChatBubble`,
      `            message={unpinnedMsg}`,
      `            onPin={onPin}`,
      `            onUnpin={onUnpin}`,
      `          />`,
      `          <ChatBubble`,
      `            message={pinnedMsg}`,
      `            onPin={onPin}`,
      `            onUnpin={onUnpin}`,
      `          />`,
      `          <PinDurationModal`,
      `            isOpen={isModalOpen}`,
      `            onClose={() => {}}`,
      `            onConfirm={onConfirmDuration}`,
      `            message={unpinnedMsg}`,
      `          />`,
      `        </div>`,
      `      </ToastProvider>`,
      `    </I18nProvider>`,
      `  );`,
      `  return {`,
      `    destroy: () => {`,
      `      root.unmount();`,
      `      container.remove();`,
      `    },`,
      `  };`,
      `}`,
    ].join('\n')
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
      'process.env.NODE_ENV': '"test"',
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_WHATSAPP_LATENCY_PROFILING': '""',
      'import.meta.env.VITE_API_URL': '"http://localhost:8000/api/v1"',
    },
    logLevel: 'silent',
  });

  const { renderPinComponents, act } = await import(out);

  let pinnedCalledWith = null;
  let unpinnedCalledWith = null;
  let jumpCalledWith = null;
  let confirmDurationCalledWith = null;

  const sampleUnpinned = {
    id: 101,
    conversation_id: 1,
    direction: 'INBOUND',
    message_type: 'TEXT',
    status: 'RECEIVED',
    body: 'Acil teklif dosyasını inceleyin lütfen',
    is_pinned: false,
    created_at: new Date().toISOString(),
  };

  const samplePinned = {
    id: 102,
    conversation_id: 1,
    direction: 'OUTBOUND',
    message_type: 'TEXT',
    status: 'READ',
    body: 'İşte toplantı notları ve sabitlenen maddeler',
    is_pinned: true,
    pinned_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const samplePinned2 = {
    id: 103,
    conversation_id: 1,
    direction: 'INBOUND',
    message_type: 'DOCUMENT',
    status: 'RECEIVED',
    media_filename: 'sozlesme.pdf',
    is_pinned: true,
    pinned_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  let instance;
  await act(async () => {
    instance = renderPinComponents({
      unpinnedMsg: sampleUnpinned,
      pinnedMsg: samplePinned,
      onPin: (msg) => { pinnedCalledWith = msg; },
      onUnpin: (msg) => { unpinnedCalledWith = msg; },
      onJump: (msg) => { jumpCalledWith = msg; },
      onConfirmDuration: (dur) => { confirmDurationCalledWith = dur; },
      isModalOpen: true,
      pinnedList: [samplePinned, samplePinned2],
    });
  });

  console.log('--- 1. Testing ChatBubble Pinned Indicators & Triggers ---');

  // Check 1: Pinned badge on pinned message
  const pinnedBadge = document.querySelector('[data-testid="msg-pinned-badge-102"]');
  assert.ok(pinnedBadge, 'msg-pinned-badge-102 should be rendered on pinned message');
  const pinnedIcon = document.querySelector('[data-testid="msg-pinned-icon-102"]');
  assert.ok(pinnedIcon, 'msg-pinned-icon-102 should be rendered in footer');

  // Check 2: Unpinned message does not have badge
  const unpinnedBadge = document.querySelector('[data-testid="msg-pinned-badge-101"]');
  assert.ok(!unpinnedBadge, 'msg-pinned-badge-101 should NOT be rendered on unpinned message');

  // Check 3: Pin trigger on unpinned message (inside message dropdown menu)
  const menuBtn101 = document.querySelector('[data-testid="msg-menu-btn-101"]');
  assert.ok(menuBtn101, 'msg-menu-btn-101 should exist on message');
  await act(async () => {
    menuBtn101.click();
  });
  const pinTrigger = document.querySelector('[data-testid="pin-trigger-101"]');
  assert.ok(pinTrigger, 'pin-trigger-101 should exist in menu for unpinned message');
  await act(async () => {
    pinTrigger.click();
  });
  assert.equal(pinnedCalledWith?.id, 101, 'Clicking pin-trigger-101 should trigger onPin with msg 101');

  // Check 4: Unpin trigger on pinned message (inside message dropdown menu)
  const menuBtn102 = document.querySelector('[data-testid="msg-menu-btn-102"]');
  assert.ok(menuBtn102, 'msg-menu-btn-102 should exist on message');
  await act(async () => {
    menuBtn102.click();
  });
  const unpinTrigger = document.querySelector('[data-testid="unpin-trigger-102"]');
  assert.ok(unpinTrigger, 'unpin-trigger-102 should exist in menu for pinned message');
  await act(async () => {
    unpinTrigger.click();
  });
  assert.equal(unpinnedCalledWith?.id, 102, 'Clicking unpin-trigger-102 should trigger onUnpin with msg 102');

  console.log('--- 2. Testing PinnedMessagesBar Component ---');

  // Check 5: Pinned bar is rendered
  const pinnedBar = document.querySelector('[data-testid="pinned-messages-bar"]');
  assert.ok(pinnedBar, 'pinned-messages-bar should be rendered');

  // Check 6: Counter exists for multiple pinned messages (1/2)
  const prevBtn = document.querySelector('[data-testid="pinned-bar-prev-btn"]');
  const nextBtn = document.querySelector('[data-testid="pinned-bar-next-btn"]');
  assert.ok(prevBtn && nextBtn, 'Previous and Next navigation buttons should exist for multiple pins');

  // Check 7: Jump button triggers onJumpToMessage
  const jumpBtn = document.querySelector('[data-testid="pinned-bar-jump-btn"]');
  assert.ok(jumpBtn, 'pinned-bar-jump-btn should exist');
  await act(async () => {
    jumpBtn.click();
  });
  assert.equal(jumpCalledWith?.id, 102, 'Jump button should call onJumpToMessage with current pinned msg');

  // Check 8: Unpin button on bar triggers onUnpinMessage
  unpinnedCalledWith = null;
  const barUnpinBtn = document.querySelector('[data-testid="pinned-bar-unpin-btn"]');
  assert.ok(barUnpinBtn, 'pinned-bar-unpin-btn should exist');
  await act(async () => {
    barUnpinBtn.click();
  });
  assert.equal(unpinnedCalledWith?.id, 102, 'Bar unpin button should call onUnpinMessage');

  console.log('--- 3. Testing PinDurationModal Component ---');

  // Check 9: Modal exists
  const modal = document.querySelector('[data-testid="pin-duration-modal"]');
  assert.ok(modal, 'pin-duration-modal should be mounted');

  // Check 10: Duration options (24h, 7d, 30d) exist
  const opt24h = document.querySelector('[data-testid="pin-duration-24h"]');
  const opt7d = document.querySelector('[data-testid="pin-duration-7d"]');
  const opt30d = document.querySelector('[data-testid="pin-duration-30d"]');
  assert.ok(opt24h, 'pin-duration-24h option should exist');
  assert.ok(opt7d, 'pin-duration-7d option should exist');
  assert.ok(opt30d, 'pin-duration-30d option should exist');

  // Check 11: Choosing 7 days and clicking confirm
  await act(async () => {
    opt7d.click();
  });
  const confirmBtn = document.querySelector('[data-testid="pin-duration-confirm-btn"]');
  assert.ok(confirmBtn, 'pin-duration-confirm-btn should exist');
  await act(async () => {
    confirmBtn.click();
  });
  assert.equal(confirmDurationCalledWith, 604800, 'onConfirm should be called with 604800 seconds (7 days)');

  await act(async () => {
    instance.destroy();
  });
  console.log('PASS: All 11 Pin Message DOM & Interaction verifications passed successfully!');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
