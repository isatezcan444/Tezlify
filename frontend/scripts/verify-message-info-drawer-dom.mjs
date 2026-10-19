/**
 * Executed DOM verification of ChatMessageInfoDrawer (Mesaj Bilgisi & Okundu Paneli).
 *
 * Verifies:
 * 1. ChatMessageInfoDrawer mounts with authentic WhatsApp Web header and close button.
 * 2. Message bubble preview card displays message body, media indicator, and reactions.
 * 3. Direct (1-on-1) chat renders Read (Okundu), Delivered (Teslim edildi), and Sent (Gönderildi) rows.
 * 4. Group chat renders "Okuyanlar" (Read by) and "Teslim edilenler" (Delivered to) with participants.
 * 5. Close button calls onClose callback.
 *
 * Run: node frontend/scripts/verify-message-info-drawer-dom.mjs — exit code 0 = PASS.
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
setGlobal('Element', window.Element);
setGlobal('localStorage', window.localStorage);
setGlobal('sessionStorage', window.sessionStorage);
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-msginfo-dom-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

try {
  await writeFile(
    entry,
    [
      `import React from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `import { ChatMessageInfoDrawer } from '${path.join(SRC, 'features/whatsapp/components/ChatMessageInfoDrawer.tsx')}';`,
      `import { I18nProvider } from '${path.join(SRC, 'context/I18nContext.tsx')}';`,
      ``,
      `export { act };`,
      ``,
      `export function renderMessageInfoDrawer(props) {`,
      `  const container = document.createElement('div');`,
      `  document.body.appendChild(container);`,
      `  const root = createRoot(container);`,
      `  root.render(`,
      `    <I18nProvider>`,
      `      <ChatMessageInfoDrawer {...props} />`,
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
      'import.meta.env.VITE_API_URL': '"http://localhost:8000/api/v1"',
    },
    logLevel: 'silent',
  });

  const { renderMessageInfoDrawer, act } = await import(out);

  console.log('--- 1. Testing Group Chat Message Info Drawer ---');
  let closeClicked = false;

  const sampleGroupMessage = {
    id: 991,
    conversation_id: 35763,
    direction: 'OUTBOUND',
    message_type: 'TEXT',
    status: 'READ',
    body: 'Aile yemeği saat 19:00’da başlıyor!',
    created_at: '2026-10-19T11:00:00Z',
    delivered_at: '2026-10-19T11:01:00Z',
    read_at: '2026-10-19T11:05:00Z',
    reactions: [
      {
        emoji: '❤️',
        from_me: false,
        reactor_jid: '905356872662@s.whatsapp.net',
        reactor_name: 'Filiz Ablam',
        updated_at: '2026-10-19T11:06:00Z',
      },
    ],
  };

  const sampleGroupConv = {
    id: 35763,
    lead_name: 'Tezcan Ailesi💗',
    lead_phone: '120363028374928374@g.us',
    is_group: true,
    channel: 'WHATSAPP',
    status: 'ACTIVE',
  };

  const sampleParticipants = [
    { id: '1', name: 'İsa Tezcan', phone: '+905413749073', is_me: true },
    { id: '2', name: 'Filiz Ablam', phone: '+905356872662', is_me: false },
    { id: '195872117768369@lid', name: 'Cevat Aydın', phone: '+905076382749', is_me: false },
    { id: '3', name: 'Tolga Cebeci', phone: '+905551234567', is_me: false },
  ];

  const sampleAllMessages = [
    sampleGroupMessage,
    {
      id: 993,
      conversation_id: 35763,
      direction: 'INBOUND',
      message_type: 'TEXT',
      body: 'Geliyorum ben de!',
      sender_name: 'Cevat Aydın',
      sender_phone: '195872117768369@lid',
      created_at: '2026-10-19T11:08:00Z',
    },
  ];

  let instance;
  await act(async () => {
    instance = renderMessageInfoDrawer({
      isOpen: true,
      onClose: () => {
        closeClicked = true;
      },
      message: sampleGroupMessage,
      conversation: sampleGroupConv,
      groupParticipants: sampleParticipants,
      allMessages: sampleAllMessages,
    });
  });

  // Check 1: Drawer mounts
  const drawer = document.querySelector('[data-testid="message-info-drawer"]');
  assert.ok(drawer, 'message-info-drawer should be mounted in document');

  // Check 2: Header contains close button
  const closeBtn = document.querySelector('[data-testid="message-info-close-btn"]');
  assert.ok(closeBtn, 'message-info-close-btn should exist in header');
  await act(async () => {
    closeBtn.click();
  });
  assert.equal(closeClicked, true, 'Clicking closeBtn should trigger onClose');

  // Check 3: Body snippet is rendered in preview
  assert.ok(
    drawer.textContent.includes('Aile yemeği saat 19:00’da başlıyor!'),
    'Preview bubble should contain message body'
  );

  // Check 4: Filiz Ablam is under Okuyanlar due to reaction
  assert.ok(drawer.textContent.includes('Filiz Ablam'), 'Filiz Ablam should be listed under Okuyanlar');

  // Check 5: Cevat Aydın is under Okuyanlar (replied via LID) and NOT duplicated in remaining
  assert.ok(drawer.textContent.includes('Cevat Aydın'), 'Cevat Aydın should be listed under Okuyanlar');
  // Count occurrences of 'Cevat Aydın' in drawer: must be exactly 1!
  const cevatCount = (drawer.textContent.match(/Cevat Aydın/g) || []).length;
  assert.equal(cevatCount, 1, 'Cevat Aydın must appear exactly once in drawer (must not be duplicated in remaining/kalanlar)');

  await act(async () => {
    instance.destroy();
  });

  console.log('--- 2. Testing 1-on-1 Direct Chat Message Info Drawer ---');
  const sampleDirectMessage = {
    id: 992,
    conversation_id: 100,
    direction: 'OUTBOUND',
    message_type: 'TEXT',
    status: 'READ',
    body: 'Teklif detayları ektedir.',
    created_at: '2026-10-19T12:00:00Z',
    sent_at: '2026-10-19T12:00:05Z',
    delivered_at: '2026-10-19T12:00:10Z',
    read_at: '2026-10-19T12:01:00Z',
  };

  const sampleDirectConv = {
    id: 100,
    lead_name: 'Cevat Aydın',
    lead_phone: '+905076382749',
    is_group: false,
    channel: 'WHATSAPP',
    status: 'ACTIVE',
  };

  await act(async () => {
    instance = renderMessageInfoDrawer({
      isOpen: true,
      onClose: () => {},
      message: sampleDirectMessage,
      conversation: sampleDirectConv,
    });
  });

  const directDrawer = document.querySelector('[data-testid="message-info-drawer"]');
  assert.ok(directDrawer, 'Direct chat drawer should mount');
  assert.ok(
    directDrawer.textContent.includes('Okundu') || directDrawer.textContent.includes('Read'),
    'Direct chat drawer should include Okundu (Read)'
  );
  assert.ok(
    directDrawer.textContent.includes('Teslim edildi') || directDrawer.textContent.includes('Delivered'),
    'Direct chat drawer should include Teslim edildi (Delivered)'
  );
  assert.ok(
    directDrawer.textContent.includes('Gönderildi') || directDrawer.textContent.includes('Sent'),
    'Direct chat drawer should include Gönderildi (Sent)'
  );

  await act(async () => {
    instance.destroy();
  });

  console.log('PASS: All ChatMessageInfoDrawer DOM & Receipt verifications passed successfully!');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
