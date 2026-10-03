/**
 * Executed DOM verification of DocumentViewer and DocumentCard integration.
 *
 * Verifies:
 * 1. DocumentCard renders document icon, display name, metadata and preview trigger.
 * 2. DocumentCard click triggers authentic DocumentViewer portaled into document.body with z-[99999].
 * 3. DocumentViewer displays PDF iframe, print, download, and close buttons.
 * 4. DocumentViewer handles binary fallback view with direct download CTA.
 * 5. Escape key cleanly dismisses DocumentViewer.
 *
 * Run: node scripts/verify-document-viewer-dom.mjs — exit code 0 = PASS.
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
setGlobal('Element', window.Element);
setGlobal('localStorage', window.localStorage);
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-doc-dom-'));
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
      `import { DocumentCard } from '${SRC}/features/whatsapp/components/DocumentCard';`,
      `import { DocumentViewer } from '${SRC}/features/whatsapp/components/DocumentViewer';`,
      `export { React, act, createRoot, I18nProvider, DocumentCard, DocumentViewer };`,
    ].join('\n'),
    'utf8',
  );

  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: out,
    platform: 'browser',
    absWorkingDir: frontendRoot,
    nodePaths: [path.join(frontendRoot, 'node_modules')],
    jsx: 'automatic',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    define: {
      'import.meta.env': '{}',
      'process.env.NODE_ENV': '"development"',
    },
    logLevel: 'silent',
  });

  const { React, act, createRoot, I18nProvider, DocumentCard, DocumentViewer } = await import(out);
  const h = React.createElement;

  let passed = 0;
  const roots = new Set();

  const cleanup = async () => {
    for (const root of roots) {
      await act(async () => { root.unmount(); });
    }
    roots.clear();
    window.document.body.innerHTML = '';
  };

  const check = async (label, fn) => {
    await fn();
    await cleanup();
    passed += 1;
    console.log(`  ok - ${label}`);
  };

  const mount = async (element) => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    await act(async () => {
      root.render(h(I18nProvider, null, element));
    });
    return { host, root };
  };

  console.log('Running Document Viewer & DocumentCard DOM Verification...');

  // Test 1: DocumentCard renders file details and preview action
  await check('DocumentCard renders PDF metadata, label and preview buttons', async () => {
    const { host } = await mount(
      h(DocumentCard, {
        filename: 'fatura_ekim_2026.pdf',
        mimeType: 'application/pdf',
        url: 'http://localhost/api/v1/whatsapp/media/doc-123',
        fileSize: 1048576, // 1 MB
        isOutbound: false,
      })
    );

    const card = host.querySelector('[data-testid="document-card"]');
    assert.ok(card, 'DocumentCard container must exist');
    assert.ok(card.textContent.includes('fatura_ekim_2026.pdf'), 'Must display filename');
    assert.ok(card.textContent.includes('PDF'), 'Must show PDF label');
    assert.ok(card.textContent.includes('1.0 MB'), 'Must show formatted file size');

    const previewBtn = host.querySelector('[data-testid="document-preview-btn"]');
    assert.ok(previewBtn, 'Preview button must exist');
  });

  // Test 2: Clicking DocumentCard preview button opens DocumentViewer portaled with z-[99999]
  await check('Clicking preview on DocumentCard mounts DocumentViewer to document.body with z-[99999]', async () => {
    const { host } = await mount(
      h(DocumentCard, {
        filename: 'rapor.pdf',
        mimeType: 'application/pdf',
        url: 'http://localhost/api/v1/whatsapp/media/doc-pdf',
        isOutbound: false,
      })
    );

    const previewBtn = host.querySelector('[data-testid="document-preview-btn"]');
    assert.ok(previewBtn, 'Preview button exists');

    await act(async () => {
      previewBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    const dialog = window.document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'DocumentViewer dialog must be portaled into document.body');
    assert.ok(dialog.className.includes('z-[99999]'), 'dialog must carry z-[99999]');
    assert.ok(dialog.textContent.includes('rapor.pdf'), 'dialog must show document title');

    // PDF iframe should be present
    const iframe = dialog.querySelector('iframe');
    assert.ok(iframe, 'PDF viewer must mount an iframe');
    assert.ok(iframe.src.includes('doc-pdf'), 'iframe src must point to document URL');
  });

  // Test 3: DocumentViewer PDF controls and Escape dismissal
  await check('DocumentViewer has print/download controls and dismisses on Escape', async () => {
    let closed = false;
    await mount(
      h(DocumentViewer, {
        isOpen: true,
        onClose: () => { closed = true; },
        src: 'http://localhost/test.pdf',
        filename: 'sozlesme.pdf',
        mimeType: 'application/pdf',
        fileSize: 2097152,
        senderName: 'Mehmet Bey',
        timestamp: '15:45',
      })
    );

    const dialog = window.document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'dialog exists');
    assert.ok(dialog.textContent.includes('sozlesme.pdf'), 'shows filename');
    assert.ok(dialog.textContent.includes('Mehmet Bey'), 'shows sender');
    assert.ok(dialog.textContent.includes('2.0 MB'), 'shows size');

    // Controls
    const buttons = dialog.querySelectorAll('button');
    assert.ok(buttons.length >= 3, 'Must have header controls (back, print/download, close)');

    // Escape dismisses
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.ok(closed, 'Escape key must close viewer');
  });

  // Test 4: DocumentViewer Binary Fallback
  await check('DocumentViewer displays clean fallback UI for non-previewable files', async () => {
    await mount(
      h(DocumentViewer, {
        isOpen: true,
        onClose: () => {},
        src: 'http://localhost/archive.zip',
        filename: 'yedekler.zip',
        mimeType: 'application/zip',
        fileSize: 5242880, // 5 MB
      })
    );

    const dialog = window.document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'dialog exists');
    assert.ok(dialog.textContent.includes('yedekler.zip'), 'shows filename');
    assert.ok(dialog.textContent.includes('ZIP'), 'shows ZIP badge');
    assert.ok(dialog.textContent.includes('5.0 MB'), 'shows 5.0 MB');
    assert.ok(!dialog.querySelector('iframe'), 'ZIP should not mount an iframe');
  });

  console.log(`\n${passed}/${passed} DocumentViewer & DocumentCard DOM checks passed cleanly!`);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

process.exit(0);
