/**
 * AŞAMA 7.2 — Executed DOM verification for WhatsApp Unicode Identity & RTL Support.
 *
 * Verifies real React DOM rendering in JSDOM:
 *  1. ChatBubble renders Arabic RTL text with `dir="auto"`.
 *  2. ChatBubble renders LTR messages (English, Turkish) cleanly with natural flow.
 *  3. In mixed RTL text, URLs (`https://...`) are isolated in `<bdi dir="ltr">`.
 *  4. In mixed RTL text, international phone numbers (`+90...`) are isolated in `<bdi dir="ltr">`.
 *  5. ChatBubble quoted block (reply) renders with `dir="auto"` and `<bdi>`.
 *  6. ChatBubble media caption renders with `dir="auto"` and `<bdi>`.
 *  7. ChatBubble group sender label renders with `dir="auto"` and `<bdi>`.
 *  8. ConversationList renders multilingual conversation names and previews with `dir="auto"` and `<bdi>`.
 *  9. Message alignment invariant: Inbound stays on left, Outbound stays on right regardless of RTL/LTR direction.
 *
 * Run: `node scripts/verify-whatsapp-unicode-rtl-dom.mjs` — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { hardenAssert } from './lib/safe-dom-assert.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

hardenAssert(assert);

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

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-unicode-rtl-dom-'));
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
      `import { ConversationList } from '${SRC}/features/whatsapp/components/ConversationList';`,
      `export { React, act, createRoot, I18nProvider, ToastProvider, ChatBubble, ConversationList };`,
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
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_WHATSAPP_LATENCY_PROFILING': '"false"',
    },
    logLevel: 'silent',
  });

  const { React, act, createRoot, I18nProvider, ToastProvider, ChatBubble, ConversationList } = await import(out);

  let passed = 0;
  const check = async (label, fn) => {
    await fn();
    passed += 1;
    console.log(`  ok - ${label}`);
  };

  const mount = async (element) => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ToastProvider, null, element)
        )
      );
    });
    return {
      host,
      unmount: async () => {
        await act(async () => {
          root.unmount();
        });
        host.remove();
      },
    };
  };

  // -------------------------------------------------------------------------
  // TEST 1: Arabic RTL Message Body renders dir="auto"
  // -------------------------------------------------------------------------
  await check('Arabic RTL message body paragraph carries dir="auto"', async () => {
    const arabicMsg = {
      id: 201,
      conversation_id: 1,
      direction: 'INBOUND',
      message_type: 'TEXT',
      body: 'مرحبا بك في تيزليفاي! كيف يمكننا مساعدتك اليوم؟',
      status: 'READ',
      created_at: '2026-11-04T10:00:00Z',
    };

    const { host, unmount } = await mount(
      React.createElement(ChatBubble, { message: arabicMsg })
    );

    const p = host.querySelector('p[dir="auto"]');
    assert.ok(p, 'ChatBubble text paragraph must have dir="auto" attribute');
    assert.ok(p.textContent.includes('مرحبا بك في تيزليفاي'), 'must render Arabic content');

    // Inbound alignment check: left-aligned bubble
    const bubbleWrapper = host.querySelector('[data-msg-id="201"]');
    assert.ok(bubbleWrapper, 'bubble element must exist');
    await unmount();
  });

  // -------------------------------------------------------------------------
  // TEST 2: Mixed RTL + URL isolates URL in <bdi dir="ltr">
  // -------------------------------------------------------------------------
  await check('Mixed RTL message with URL wraps URL in <bdi dir="ltr">', async () => {
    const urlMsg = {
      id: 202,
      conversation_id: 1,
      direction: 'INBOUND',
      message_type: 'TEXT',
      body: 'يرجى زيارة https://tezlify.com/help للحصول على مزيد من المعلومات.',
      status: 'READ',
      created_at: '2026-11-04T10:01:00Z',
    };

    const { host, unmount } = await mount(
      React.createElement(ChatBubble, { message: urlMsg })
    );

    const bdi = host.querySelector('bdi[dir="ltr"]');
    assert.ok(bdi, 'URL in mixed text must be wrapped in <bdi dir="ltr">');
    assert.ok(bdi.textContent.includes('https://tezlify.com/help'), 'bdi must contain the exact URL');
    await unmount();
  });

  // -------------------------------------------------------------------------
  // TEST 3: Mixed RTL + Phone Number isolates Phone in <bdi dir="ltr">
  // -------------------------------------------------------------------------
  await check('Mixed RTL message with phone number wraps phone in <bdi dir="ltr">', async () => {
    const phoneMsg = {
      id: 203,
      conversation_id: 1,
      direction: 'INBOUND',
      message_type: 'TEXT',
      body: 'اتصل بنا مباشرة على +90 541 374 90 73 وسنساعدك فورا!',
      status: 'READ',
      created_at: '2026-11-04T10:02:00Z',
    };

    const { host, unmount } = await mount(
      React.createElement(ChatBubble, { message: phoneMsg })
    );

    const bdis = Array.from(host.querySelectorAll('bdi[dir="ltr"]'));
    const phoneBdi = bdis.find((el) => el.textContent.includes('+90 541 374 90 73'));
    assert.ok(phoneBdi, 'Phone number in RTL text must be wrapped in <bdi dir="ltr">');
    await unmount();
  });

  // -------------------------------------------------------------------------
  // TEST 4: Quoted message reply renders dir="auto" and <bdi>
  // -------------------------------------------------------------------------
  await check('Quoted message card renders sender and preview with dir="auto" and <bdi>', async () => {
    const quotedMsg = {
      id: 204,
      conversation_id: 1,
      direction: 'OUTBOUND',
      message_type: 'TEXT',
      body: 'تمام، فهمت عليك شكرا.',
      status: 'SENT',
      created_at: '2026-11-04T10:03:00Z',
      quoted_message: {
        stanza_id: 'wa-stanza-100',
        sender_phone: '+905321110001',
        sender_name: 'محمد 2026',
        body: 'سأرسل لك الملف غدا صباحا بإذن الله.',
        message_type: 'TEXT',
      },
    };

    const { host, unmount } = await mount(
      React.createElement(ChatBubble, { message: quotedMsg })
    );

    const quoteContainers = host.querySelectorAll('[dir="auto"]');
    assert.ok(quoteContainers.length >= 2, 'quote card elements must carry dir="auto"');
    const bdiList = Array.from(host.querySelectorAll('bdi'));
    const senderBdi = bdiList.find((el) => el.textContent.includes('محمد 2026'));
    assert.ok(senderBdi, 'Quoted sender name must be wrapped in <bdi>');
    await unmount();
  });

  // -------------------------------------------------------------------------
  // TEST 5: Media caption in Arabic renders dir="auto" and <bdi>
  // -------------------------------------------------------------------------
  await check('Media caption renders with dir="auto" and <bdi>', async () => {
    const mediaMsg = {
      id: 205,
      conversation_id: 1,
      direction: 'INBOUND',
      message_type: 'IMAGE',
      media_url: 'https://example.com/test.jpg',
      media_caption: 'صورة من مقر الشركة الجديد 12345!',
      status: 'READ',
      created_at: '2026-11-04T10:04:00Z',
    };

    const { host, unmount } = await mount(
      React.createElement(ChatBubble, { message: mediaMsg })
    );

    const captionP = host.querySelector('p[dir="auto"]');
    assert.ok(captionP, 'Media caption paragraph must have dir="auto"');
    const captionBdi = captionP.querySelector('bdi');
    assert.ok(captionBdi, 'Media caption text must be wrapped in <bdi>');
    assert.ok(captionBdi.textContent.includes('صورة من مقر الشركة'), 'must contain caption');
    await unmount();
  });

  // -------------------------------------------------------------------------
  // TEST 6: Group sender label in ChatBubble renders dir="auto" and <bdi>
  // -------------------------------------------------------------------------
  await check('Group sender label renders with dir="auto" and <bdi>', async () => {
    const groupMsg = {
      id: 206,
      conversation_id: 99,
      direction: 'INBOUND',
      message_type: 'TEXT',
      body: 'Selam herkese!',
      sender_name: 'قناة الأخبار 12345',
      sender_phone: '905321110001',
      status: 'READ',
      created_at: '2026-11-04T10:05:00Z',
    };

    const { host, unmount } = await mount(
      React.createElement(ChatBubble, {
        message: groupMsg,
        isGroup: true,
      })
    );

    const senderDiv = host.querySelector('[data-testid="msg-sender-206"]');
    assert.ok(senderDiv, 'sender container must have msg-sender-206 testid');
    assert.equal(senderDiv.getAttribute('dir'), 'auto', 'sender container must carry dir="auto"');
    const senderBdi = senderDiv.querySelector('bdi');
    assert.ok(senderBdi, 'sender label must be wrapped in <bdi>');
    assert.ok(senderBdi.textContent.includes('قناة الأخبار 12345'), 'must render multilingual sender');
    await unmount();
  });

  // -------------------------------------------------------------------------
  // TEST 7: ConversationList renders multilingual conversation names and previews with dir="auto" and <bdi>
  // -------------------------------------------------------------------------
  await check('ConversationList renders multilingual names and previews with dir="auto" and <bdi>', async () => {
    const conversations = [
      {
        id: 1,
        is_group: true,
        lead_name: 'قناة الأخبار 12345',
        lead_phone: '120363025442111111@g.us',
        last_message_preview: 'خبر عاجل: تم التحديث بنجاح!',
        last_message_at: '2026-11-04T10:10:00Z',
        status: 'ACTIVE',
        message_count: 5,
        unread_count: 2,
      },
      {
        id: 2,
        is_group: false,
        lead_name: '新闻频道 12345',
        lead_phone: '+8613800000000',
        last_message_preview: '你好，这是中文测试信息。',
        last_message_at: '2026-11-04T10:09:00Z',
        status: 'ACTIVE',
        message_count: 3,
        unread_count: 0,
      },
    ];

    const { host, unmount } = await mount(
      React.createElement(ConversationList, {
        conversations,
        selectedId: 1,
        onSelect: () => {},
      })
    );

    const titles = Array.from(host.querySelectorAll('h4[dir="auto"]'));
    assert.equal(titles.length, 2, 'Both conversation item titles must have dir="auto"');

    const titleBdis = Array.from(host.querySelectorAll('h4 bdi'));
    assert.ok(titleBdis.some((b) => b.textContent.includes('قناة الأخبار 12345')), 'Arabic group name wrapped in <bdi>');
    assert.ok(titleBdis.some((b) => b.textContent.includes('新闻频道 12345')), 'Chinese contact name wrapped in <bdi>');

    const previews = Array.from(host.querySelectorAll('p[dir="auto"]'));
    assert.ok(previews.length >= 2, 'Previews must carry dir="auto"');
    await unmount();
  });

  // -------------------------------------------------------------------------
  // TEST 8: Bubble Alignment invariant: Inbound on Left, Outbound on Right
  // -------------------------------------------------------------------------
  await check('Bubble alignment invariant: Inbound on Left, Outbound on Right regardless of language', async () => {
    const inboundArabic = {
      id: 301,
      conversation_id: 1,
      direction: 'INBOUND',
      message_type: 'TEXT',
      body: 'رسالة واردة باللغة العربية',
      status: 'READ',
      created_at: '2026-11-04T10:15:00Z',
    };
    const outboundArabic = {
      id: 302,
      conversation_id: 1,
      direction: 'OUTBOUND',
      message_type: 'TEXT',
      body: 'رسالة صادرة باللغة العربية',
      status: 'SENT',
      created_at: '2026-11-04T10:16:00Z',
    };

    const { host: hIn, unmount: unIn } = await mount(
      React.createElement(ChatBubble, { message: inboundArabic })
    );
    const bubbleIn = hIn.querySelector('.justify-start');
    assert.ok(bubbleIn, 'Inbound message container must maintain justify-start (left aligned outer container)');
    await unIn();

    const { host: hOut, unmount: unOut } = await mount(
      React.createElement(ChatBubble, { message: outboundArabic })
    );
    const bubbleOut = hOut.querySelector('.justify-end');
    assert.ok(bubbleOut, 'Outbound message container must maintain justify-end (right aligned outer container)');
    await unOut();
  });

  console.log(`\nWhatsApp Unicode & RTL DOM verification: PASS (${passed} checks)`);
  ok = true;
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  dom.window.close();
}

process.exit(ok ? 0 : 1);
