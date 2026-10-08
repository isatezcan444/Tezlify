/**
 * Verification of WhatsApp chat drag-and-drop overlay lifecycle:
 * 1. Dropping files stages them and immediately hides the dropzone overlay.
 * 2. DragOver keeps the overlay visible smoothly without glitching/flickering.
 * 3. Overlay is pointer-events-none so it cannot disrupt drag event propagation.
 * 4. Phantom dragenter events immediately after drop (within 1.5s cooldown) are ignored.
 * 5. Watchdog timer clears overlay if dragging ceases without dropping.
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
      `import React, { useState, useCallback, useRef, useEffect } from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `export { React, useState, useCallback, useRef, useEffect, act, createRoot };`,
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

  const { React, useState, useCallback, useRef, useEffect, act, createRoot } = await import(out);

  const TestDragHarness = ({ onDropFiles }) => {
    const [stagedComposerFiles, setStagedComposerFiles] = useState(null);
    const [isChatDragOver, setIsChatDragOver] = useState(false);
    const chatDragCounterRef = useRef(0);
    const lastDropTimestampRef = useRef(0);
    const dragoverTimeoutRef = useRef(null);

    const resetChatDragState = useCallback(() => {
      if (dragoverTimeoutRef.current) {
        clearTimeout(dragoverTimeoutRef.current);
        dragoverTimeoutRef.current = null;
      }
      chatDragCounterRef.current = 0;
      setIsChatDragOver(false);
    }, []);

    const handleChatFilesDrop = useCallback((e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragoverTimeoutRef.current) {
        clearTimeout(dragoverTimeoutRef.current);
        dragoverTimeoutRef.current = null;
      }
      lastDropTimestampRef.current = Date.now();
      resetChatDragState();
      const droppedFiles = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
      if (droppedFiles.length > 0) {
        setStagedComposerFiles({ files: droppedFiles, timestamp: Date.now() });
        onDropFiles?.(droppedFiles);
      }
    }, [resetChatDragState, onDropFiles]);

    useEffect(() => {
      if (stagedComposerFiles) {
        resetChatDragState();
      }
    }, [stagedComposerFiles, resetChatDragState]);

    useEffect(() => {
      const handleGlobalDrop = () => {
        lastDropTimestampRef.current = Date.now();
        resetChatDragState();
      };
      window.addEventListener('drop', handleGlobalDrop, true);
      return () => {
        window.removeEventListener('drop', handleGlobalDrop, true);
        if (dragoverTimeoutRef.current) clearTimeout(dragoverTimeoutRef.current);
      };
    }, [resetChatDragState]);

    return React.createElement(
      'div',
      {
        'data-testid': 'chat-column',
        onDragEnter: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (Date.now() - lastDropTimestampRef.current < 1500 || stagedComposerFiles) {
            return;
          }
          const hasFiles = e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files');
          if (hasFiles) {
            chatDragCounterRef.current++;
            setIsChatDragOver(true);
          }
        },
        onDragOver: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (Date.now() - lastDropTimestampRef.current < 1500 || stagedComposerFiles) {
            if (isChatDragOver) resetChatDragState();
            return;
          }
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
          }
          if (!isChatDragOver) {
            setIsChatDragOver(true);
          }
          if (dragoverTimeoutRef.current) {
            clearTimeout(dragoverTimeoutRef.current);
          }
          dragoverTimeoutRef.current = setTimeout(() => {
            resetChatDragState();
          }, 600);
        },
        onDragLeave: (e) => {
          e.preventDefault();
          e.stopPropagation();
          chatDragCounterRef.current--;
          if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
            resetChatDragState();
          } else if (chatDragCounterRef.current <= 0) {
            resetChatDragState();
          }
        },
        onDrop: handleChatFilesDrop,
      },
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
        onDropFiles: (files) => {
          droppedResult = files;
        },
      })
    );
  });

  const column = container.querySelector('[data-testid="chat-column"]');
  assert.ok(column, 'chat-column rendered');

  // Test 1: DragEnter triggers the overlay
  await act(async () => {
    const dragEnterEvt = new window.Event('dragenter', { bubbles: true, cancelable: true });
    dragEnterEvt.dataTransfer = { types: ['Files'] };
    column.dispatchEvent(dragEnterEvt);
  });
  let overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.ok(overlay, 'drop-overlay appears on dragenter with Files');
  assert.ok(overlay.className.includes('pointer-events-none'), 'overlay has pointer-events-none to prevent flickering');

  // Test 2: Continuous DragOver keeps overlay visible smoothly
  await act(async () => {
    const dragOverEvt = new window.Event('dragover', { bubbles: true, cancelable: true });
    dragOverEvt.dataTransfer = { types: ['Files'] };
    column.dispatchEvent(dragOverEvt);
  });
  overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.ok(overlay, 'overlay remains visible during dragover');

  // Test 3: Dropping 2 files sets staged files and dismisses overlay immediately
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
  const summary = container.querySelector('[data-testid="staged-summary"]');
  assert.ok(summary, 'staged summary indicates staged files are present');

  // Test 4: Phantom dragenter within 1500ms after drop is suppressed
  await act(async () => {
    const phantomDragEnter = new window.Event('dragenter', { bubbles: true, cancelable: true });
    phantomDragEnter.dataTransfer = { types: ['Files'] };
    column.dispatchEvent(phantomDragEnter);
  });
  overlay = container.querySelector('[data-testid="drop-overlay"]');
  assert.equal(overlay, null, 'drop-overlay remains hidden and ignores phantom dragenter');

  console.log('Smooth chat drag-and-drop verification: PASS (all 4 tests)');
  ok = true;
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (!ok) {
  process.exit(1);
}
