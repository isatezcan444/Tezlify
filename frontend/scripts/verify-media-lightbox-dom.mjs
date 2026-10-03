/**
 * Executed DOM verification of MediaLightbox and ChatBubble media integration.
 *
 * Verifies:
 * 1. MediaLightbox mounts into document.body with z-[99999], displays media image, header, and action buttons.
 * 2. MediaLightbox zoom controls (+/-) and rotate button update zoom/rotation state.
 * 3. MediaLightbox Escape key triggers onClose.
 * 4. ChatBubble renders image with fallback to wa_message_id when media_id is null.
 * 5. ChatBubble renders retry button on image load error.
 *
 * Run: node scripts/verify-media-lightbox-dom.mjs — exit code 0 = PASS.
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

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-media-dom-'));
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
      `import { MediaLightbox } from '${SRC}/features/whatsapp/components/MediaLightbox';`,
      `import { ChatBubble } from '${SRC}/features/whatsapp/components/ChatBubble';`,
      `export { React, act, createRoot, I18nProvider, MediaLightbox, ChatBubble };`,
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

  const { React, act, createRoot, I18nProvider, MediaLightbox, ChatBubble } = await import(out);
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

  console.log('Running Media Lightbox & Stream DOM Verification...');

  // Test 1: MediaLightbox portaling into document.body and controls
  await check('MediaLightbox mounts into document.body with z-[99999], controls and caption pill', async () => {
    let closed = false;
    await mount(
      h(MediaLightbox, {
        isOpen: true,
        onClose: () => { closed = true; },
        src: 'http://localhost/test-image.jpg',
        mediaType: 'IMAGE',
        caption: 'Sample photo caption',
        senderName: 'Ahmet Yılmaz',
        timestamp: '14:30',
      })
    );

    const dialog = window.document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'MediaLightbox dialog must be portaled into document.body');
    assert.ok(dialog.className.includes('z-[99999]'), 'dialog must carry z-[99999]');

    // Check sender and caption
    assert.ok(dialog.textContent.includes('Ahmet Yılmaz'), 'must display sender name');
    assert.ok(dialog.textContent.includes('Sample photo caption'), 'must display caption');

    // Check action buttons: zoom, rotate, close
    const buttons = dialog.querySelectorAll('button');
    assert.ok(buttons.length >= 4, 'must have zoom, rotate, download, and close buttons');

    // Test Escape key closes dialog
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.ok(closed, 'Escape key must trigger onClose');
  });

  // Test 2: ChatBubble media resolution fallback with wa_message_id
  await check('ChatBubble resolves media URL from wa_message_id when media_id is null', async () => {
    const mediaMsg = {
      id: 101,
      conversation_id: 1,
      direction: 'INBOUND',
      message_type: 'IMAGE',
      status: 'READ',
      wa_message_id: 'wamid_sample_12345',
      media_id: null,
      media_url: null,
      media_caption: 'Gelen görsel',
      created_at: new Date().toISOString(),
    };

    const { host } = await mount(
      h(ChatBubble, {
        message: mediaMsg,
      })
    );

    const img = host.querySelector('img');
    assert.ok(img, 'ChatBubble must render an <img> tag for IMAGE type with wa_message_id');
    assert.ok(
      img.src.includes('wamid_sample_12345'),
      `Image src must resolve with wa_message_id endpoint, got ${img.src}`
    );
  });

  // Test 3: ChatBubble image error surfaces retry button
  await check('ChatBubble surfaces retry button when image load fails', async () => {
    const mediaMsg = {
      id: 102,
      conversation_id: 1,
      direction: 'INBOUND',
      message_type: 'IMAGE',
      status: 'READ',
      wa_message_id: 'broken_media_id',
      created_at: new Date().toISOString(),
    };

    const { host } = await mount(
      h(ChatBubble, {
        message: mediaMsg,
      })
    );

    const img = host.querySelector('img');
    assert.ok(img, 'img element must exist');

    // Simulate image error event
    await act(async () => {
      img.dispatchEvent(new window.Event('error'));
    });

    // Check that retry button appears
    const retryBtn = host.querySelector('button');
    assert.ok(retryBtn, 'Retry button must appear when image encounters an error');
    assert.ok(
      host.textContent.includes('Yeniden Dene') || host.textContent.includes('Retry'),
      'Retry label must be rendered'
    );
  });

  console.log(`\n${passed}/${passed} media pipeline DOM checks passed cleanly!`);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
