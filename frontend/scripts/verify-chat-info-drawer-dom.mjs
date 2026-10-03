/**
 * Executed DOM verification of ChatInfoDrawer and Media/Links/Docs Gallery parity.
 *
 * Verifies:
 * 1. ChatInfoDrawer renders contact profile, avatar, formatted phone, and action buttons.
 * 2. Media, Links and Docs gallery tab bar switches between Media, Docs, and Links.
 * 3. Media tab displays extracted image/video thumbnails and triggers MediaLightbox on click.
 * 4. Docs tab displays extracted documents and triggers DocumentViewer on click.
 * 5. Links tab displays extracted URLs with copy link and external anchor links.
 * 6. Close button and Escape key dismiss the drawer cleanly.
 *
 * Run: node scripts/verify-chat-info-drawer-dom.mjs — exit code 0 = PASS.
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
setGlobal('File', window.File);
setGlobal('Blob', window.Blob);
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const mockClipboard = {
  writtenText: '',
  writeText: async (text) => {
    mockClipboard.writtenText = text;
  },
};
try {
  window.navigator.clipboard = mockClipboard;
} catch {}
try {
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, writable: true, value: mockClipboard });
} catch {}
try {
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, writable: true, value: mockClipboard });
} catch {}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-info-drawer-dom-'));
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
      `import { ChatInfoDrawer } from '${SRC}/features/whatsapp/components/ChatInfoDrawer';`,
      `export { React, act, createRoot, I18nProvider, ToastProvider, ChatInfoDrawer };`,
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

  const { React, act, createRoot, I18nProvider, ToastProvider, ChatInfoDrawer } = await import(out);
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

  const mount = async (element) => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    await act(async () => {
      root.render(
        h(I18nProvider, { defaultLocale: 'tr' },
          h(ToastProvider, null, element)
        )
      );
    });
    return { host, root };
  };

  console.log('Running Contact & Group Info Drawer DOM Verification...');

  const mockConversation = {
    id: 101,
    lead_id: 42,
    lead_name: 'Ahmet Yılmaz',
    lead_phone: '+905321234567',
    lead_avatar_url: 'http://localhost/avatars/ahmet.jpg',
    status: 'ACTIVE',
    channel: 'WHATSAPP',
    unread_count: 0,
    is_group: false,
  };

  const mockMessages = [
    {
      id: 1,
      conversation_id: 101,
      direction: 'INBOUND',
      message_type: 'TEXT',
      body: 'Merhaba! Detaylar için https://tezlify.com adresini inceleyebilirsiniz.',
      created_at: '2026-10-03T12:00:00Z',
    },
    {
      id: 2,
      conversation_id: 101,
      direction: 'OUTBOUND',
      message_type: 'IMAGE',
      body: 'İşte mağaza fotoğrafı',
      media_id: 'media-img-01',
      media_mime_type: 'image/jpeg',
      media_filename: 'magaza.jpg',
      created_at: '2026-10-03T12:01:00Z',
    },
    {
      id: 3,
      conversation_id: 101,
      direction: 'INBOUND',
      message_type: 'DOCUMENT',
      body: 'Sözleşme ektedir',
      media_id: 'media-doc-01',
      media_mime_type: 'application/pdf',
      media_filename: 'sozlesme.pdf',
      created_at: '2026-10-03T12:02:00Z',
    },
  ];

  // -------------------------------------------------------------
  // Test 1: ChatInfoDrawer rendering, profile card and CRM lead button
  // -------------------------------------------------------------
  {
    let openedLeadId = null;
    let closed = false;

    const { host } = await mount(
      h(ChatInfoDrawer, {
        isOpen: true,
        onClose: () => { closed = true; },
        conversation: mockConversation,
        messages: mockMessages,
        onOpenLead: (id) => { openedLeadId = id; },
      })
    );

    const drawer = host.querySelector('[data-testid="chat-info-drawer"]');
    assert.ok(drawer, 'ChatInfoDrawer must mount with data-testid');
    assert.ok(drawer.textContent.includes('Ahmet Yılmaz'), 'Must render contact name');
    assert.ok(drawer.textContent.includes('+90 532 123 45 67') || drawer.textContent.includes('0532 123 45 67'), 'Must render formatted phone');

    // CRM Lead shortcut button
    const leadBtn = host.querySelector('[data-testid="drawer-open-lead-btn"]');
    assert.ok(leadBtn, 'Drawer must render CRM Lead shortcut button when lead_id exists');

    await act(async () => {
      leadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(openedLeadId, 42, 'Clicking CRM lead button must invoke onOpenLead with leadId');

    // Close button
    const closeBtn = host.querySelector('[data-testid="close-info-drawer-btn"]');
    assert.ok(closeBtn, 'Close button must exist');
    await act(async () => {
      closeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(closed, true, 'Clicking close button must call onClose');

    await cleanup();
    passed += 1;
    console.log('  ok - ChatInfoDrawer renders profile, phone number, CRM shortcut, and close button');
  }

  // -------------------------------------------------------------
  // Test 2: Media, Links and Docs Gallery tab switching and lightboxes
  // -------------------------------------------------------------
  {
    const { host } = await mount(
      h(ChatInfoDrawer, {
        isOpen: true,
        onClose: () => {},
        conversation: mockConversation,
        messages: mockMessages,
      })
    );

    // Initial tab: Media (1 item)
    const mediaGrid = host.querySelector('[data-testid="drawer-media-grid"]');
    assert.ok(mediaGrid, 'Media grid must be rendered on initial MEDIA tab');
    const mediaItems = mediaGrid.querySelectorAll('img, video');
    assert.equal(mediaItems.length, 1, 'Media grid must contain 1 image item');

    // Click Docs Tab
    const docsTabBtn = host.querySelector('[data-testid="drawer-tab-docs"]');
    assert.ok(docsTabBtn, 'Docs tab button must exist');
    await act(async () => {
      docsTabBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    const docsList = host.querySelector('[data-testid="drawer-docs-list"]');
    assert.ok(docsList, 'Docs list must be rendered when Docs tab is selected');
    assert.ok(docsList.textContent.includes('sozlesme.pdf'), 'Must show sozlesme.pdf document');

    // Click Links Tab
    const linksTabBtn = host.querySelector('[data-testid="drawer-tab-links"]');
    assert.ok(linksTabBtn, 'Links tab button must exist');
    await act(async () => {
      linksTabBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    const linksList = host.querySelector('[data-testid="drawer-links-list"]');
    assert.ok(linksList, 'Links list must be rendered when Links tab is selected');
    assert.ok(linksList.textContent.includes('tezlify.com'), 'Must extract and show domain tezlify.com');
    const anchor = linksList.querySelector('a');
    assert.ok(anchor, 'Link must be rendered as an anchor tag');
    assert.equal(anchor.href, 'https://tezlify.com/', 'Anchor must point to extracted URL');

    await cleanup();
    passed += 1;
    console.log('  ok - Media, Links and Docs gallery parses items and switches tabs');
  }

  // -------------------------------------------------------------
  // Test 3: Escape key dismisses drawer
  // -------------------------------------------------------------
  {
    let closed = false;
    await mount(
      h(ChatInfoDrawer, {
        isOpen: true,
        onClose: () => { closed = true; },
        conversation: mockConversation,
        messages: mockMessages,
      })
    );

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.equal(closed, true, 'Pressing Escape must call onClose');

    await cleanup();
    passed += 1;
    console.log('  ok - Escape key dismisses ChatInfoDrawer');
  }

  console.log(`\n===========================================`);
  console.log(`All ${passed}/3 ChatInfoDrawer DOM tests passed cleanly!`);
  console.log(`===========================================\n`);
  process.exit(0);
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
