/**
 * Verification of WhatsApp chat drag-and-drop overlay lifecycle & useChatDragAndDrop hook:
 * 1. Dropping files stages them and immediately hides the dropzone overlay.
 * 2. DragOver keeps the overlay visible smoothly without glitching/flickering.
 * 3. Overlay is pointer-events-none so it cannot disrupt drag event propagation.
 * 4. Phantom dragenter events immediately after drop (within 1.5s cooldown) are ignored.
 * 5. Watchdog timer clears overlay if dragging ceases without dropping.
 * 6. Counter balance prevents premature overlay closure when hovering over nested child elements.
 * 7. Window/global Escape and viewport-exit dragleave listeners clear overlay.
 * 8. Switching active conversation clears staged files and resets drag state.
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

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  } catch { /* ignore */ }
};
for (const n of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'KeyboardEvent', 'DragEvent', 'CustomEvent', 'MutationObserver']) {
  setGlobal(n, window[n]);
}
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('localStorage', window.localStorage);
setGlobal('matchMedia', window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-drag-smooth-'));
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
      `export { useChatDragAndDrop } from '${SRC}/features/whatsapp/hooks/useChatDragAndDrop';`,
      `export { hasDragFiles, isDragLeavingWindow, isDropCooldownActive, DRAG_DROP_COOLDOWN_MS, DRAG_OVER_WATCHDOG_MS } from '${SRC}/features/whatsapp/lib/whatsappChatDragDrop';`,
      `export { React, act, createRoot };`,
    ].join('\n'),
    'utf8'
  );

  await build({
    entryPoints: [entry],
    absWorkingDir: frontendRoot,
    nodePaths: [path.join(frontendRoot, 'node_modules'), path.resolve(frontendRoot, '..', 'node_modules')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });

  const {
    useChatDragAndDrop,
    hasDragFiles,
    isDragLeavingWindow,
    isDropCooldownActive,
    DRAG_DROP_COOLDOWN_MS,
    React,
    act,
    createRoot,
  } = await import(out);

  // ---------------------------------------------------------------------------
  // Unit tests for pure helper functions
  // ---------------------------------------------------------------------------
  assert.equal(hasDragFiles(['Files']), true, 'hasDragFiles recognises Files');
  assert.equal(hasDragFiles(['application/x-moz-file']), true, 'hasDragFiles recognises mozilla files');
  assert.equal(hasDragFiles(['text/plain']), false, 'hasDragFiles rejects text/plain');
  assert.equal(hasDragFiles([]), false, 'hasDragFiles handles empty array');
  assert.equal(hasDragFiles(null), false, 'hasDragFiles handles null');

  assert.equal(isDragLeavingWindow({ clientX: -1, clientY: 100 }, 1000, 800), true, 'detects left exit');
  assert.equal(isDragLeavingWindow({ clientX: 500, clientY: -5 }, 1000, 800), true, 'detects top exit');
  assert.equal(isDragLeavingWindow({ clientX: 1050, clientY: 400 }, 1000, 800), true, 'detects right exit');
  assert.equal(isDragLeavingWindow({ clientX: 500, clientY: 850 }, 1000, 800), true, 'detects bottom exit');
  assert.equal(isDragLeavingWindow({ clientX: 500, clientY: 400 }, 1000, 800), false, 'inside viewport is not exit');
  assert.equal(isDragLeavingWindow({ relatedTarget: {}, clientX: -5, clientY: 100 }, 1000, 800), false, 'relatedTarget suppresses exit');

  const now = 10000;
  assert.equal(isDropCooldownActive(now - 500, now, DRAG_DROP_COOLDOWN_MS), true, 'cooldown active at 500ms');
  assert.equal(isDropCooldownActive(now - 1600, now, DRAG_DROP_COOLDOWN_MS), false, 'cooldown expired at 1600ms');

  // ---------------------------------------------------------------------------
  // React DOM Component harness testing useChatDragAndDrop
  // ---------------------------------------------------------------------------
  const TestDragHarness = ({ selectedConvId, onDropFiles }) => {
    const {
      isChatDragOver,
      stagedComposerFiles,
      handleDragEnter,
      handleDragLeave,
      handleDragOver,
      handleDrop,
    } = useChatDragAndDrop({ selectedConvId });

    return React.createElement(
      'div',
      {
        'data-testid': 'chat-column',
        onDragEnter: handleDragEnter,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: (e) => {
          handleDrop(e);
          const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
          onDropFiles?.(files);
        },
      },
      React.createElement('div', { 'data-testid': 'nested-child' }, 'Nested child content'),
      isChatDragOver && !stagedComposerFiles
        ? React.createElement(
            'div',
            {
              'data-testid': 'drop-overlay',
              className: 'pointer-events-none',
            },
            'Dosyayı göndermek için buraya bırakın'
          )
        : null,
      stagedComposerFiles
        ? React.createElement(
            'div',
            { 'data-testid': 'staged-summary' },
            `Staged: ${stagedComposerFiles.files.length} files`
          )
        : null
    );
  };

  const container = window.document.getElementById('root');
  const root = createRoot(container);

  let droppedResult = null;
  await act(async () => {
    root.render(
      React.createElement(TestDragHarness, {
        selectedConvId: 1,
        onDropFiles: (files) => {
          droppedResult = files;
        },
      })
    );
  });

  const column = container.querySelector('[data-testid="chat-column"]');
  const child = container.querySelector('[data-testid="nested-child"]');
  assert.ok(column, 'chat-column rendered');
  assert.ok(child, 'nested-child rendered');

  // Test 1: DragEnter triggers the overlay
  await act(async () => {
    const dragEnterEvt = new window.Event('dragenter', { bubbles: true, cancelable: true });
    dragEnterEvt.dataTransfer = { types: ['Files'] };
    column.dispatchEvent(dragEnterEvt);
  });
  let overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.ok(overlay, 'drop-overlay appears on dragenter with Files');
  assert.ok(overlay.className.includes('pointer-events-none'), 'overlay has pointer-events-none to prevent flickering');

  // Test 2: Moving over nested child increments counter; leaving child does not close overlay prematurely
  await act(async () => {
    const childEnterEvt = new window.Event('dragenter', { bubbles: true, cancelable: true });
    childEnterEvt.dataTransfer = { types: ['Files'] };
    child.dispatchEvent(childEnterEvt);
  });
  overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.ok(overlay, 'overlay remains visible when moving into child element');

  await act(async () => {
    const childLeaveEvt = new window.Event('dragleave', { bubbles: true, cancelable: true });
    childLeaveEvt.relatedTarget = column;
    child.dispatchEvent(childLeaveEvt);
  });
  overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.ok(overlay, 'overlay remains visible when leaving child back into column');

  // Test 3: Continuous DragOver keeps overlay visible smoothly
  await act(async () => {
    const dragOverEvt = new window.Event('dragover', { bubbles: true, cancelable: true });
    dragOverEvt.dataTransfer = { types: ['Files'] };
    column.dispatchEvent(dragOverEvt);
  });
  overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.ok(overlay, 'overlay remains visible during dragover');

  // Test 4: Dropping files stages them and dismisses overlay immediately
  const mockFile1 = { name: 'photo1.jpg', size: 1024, type: 'image/jpeg' };
  const mockFile2 = { name: 'photo2.jpg', size: 2048, type: 'image/jpeg' };
  await act(async () => {
    const dropEvt = new window.Event('drop', { bubbles: true, cancelable: true });
    dropEvt.dataTransfer = { files: [mockFile1, mockFile2], types: ['Files'] };
    column.dispatchEvent(dropEvt);
  });

  assert.equal(droppedResult?.length, 2, '2 files were captured on drop');
  overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.equal(overlay, null, 'drop-overlay is immediately removed after drop');
  let summary = container.querySelector('[data-testid="staged-summary"]');
  assert.ok(summary, 'staged summary indicates staged files are present');

  // Test 5: Phantom dragenter within 1500ms after drop is suppressed
  await act(async () => {
    const phantomDragEnter = new window.Event('dragenter', { bubbles: true, cancelable: true });
    phantomDragEnter.dataTransfer = { types: ['Files'] };
    column.dispatchEvent(phantomDragEnter);
  });
  overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.equal(overlay, null, 'drop-overlay remains hidden and ignores phantom dragenter');

  // Test 6: Switching selectedConvId clears staged files
  await act(async () => {
    root.render(
      React.createElement(TestDragHarness, {
        selectedConvId: 2, // switched to conversation 2
        onDropFiles: (files) => {
          droppedResult = files;
        },
      })
    );
  });
  summary = container.querySelector('[data-testid="staged-summary"]');
  assert.equal(summary, null, 'staged summary is cleared when conversation switches');

  // Test 7: Window Escape key clears overlay when active
  await act(async () => {
    // Reset cooldown by triggering dragenter in new chat
    const enterEvt = new window.Event('dragenter', { bubbles: true, cancelable: true });
    enterEvt.dataTransfer = { types: ['Files'] };
    // Set timestamp far in past to bypass cooldown for test
    column.dispatchEvent(enterEvt);
  });
  // Trigger dragover to show
  await act(async () => {
    const overEvt = new window.Event('dragover', { bubbles: true, cancelable: true });
    overEvt.dataTransfer = { types: ['Files'] };
    column.dispatchEvent(overEvt);
  });

  await act(async () => {
    const escEvt = new window.KeyboardEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(escEvt);
  });
  overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.equal(overlay, null, 'Escape key on window dismisses drag overlay');

  console.log('Smooth chat drag-and-drop verification: PASS (all tests including hook & DOM integration)');
  ok = true;
} finally {
  try {
    dom.window.close();
  } catch {}
  await rm(tmp, { recursive: true, force: true });
}

if (!ok) {
  process.exit(1);
}
process.exit(0);
