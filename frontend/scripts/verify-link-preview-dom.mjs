/**
 * Executed DOM verification of the link/media preview contract in ChatBubble.
 *
 * Why this is a DOM gate and not a data test: everything that can go wrong
 * here is a RENDER decision. A card that never appears, a preview that replaces
 * the text instead of sitting under it, an iframe that loads before the user
 * asks, or — the one that matters most — an image whose `src` is the REMOTE
 * address instead of the authenticated proxy, which silently leaks the
 * reader's IP to a third-party site.
 *
 * THE CONTRACT (asserted against the REAL component in jsdom)
 *   1. a text message with `link_preview` renders the card AND keeps the text;
 *   2. the card's image `src` is the server-issued proxy path, never the
 *      remote URL — asserted by the hash being present and the remote host
 *      being absent from the attribute;
 *   3. a preview carrying `embed_url` shows a play affordance and creates NO
 *      iframe until it is clicked (click-to-load);
 *   4. a preview WITHOUT `embed_url` never creates an iframe at all, however
 *      often its image is clicked;
 *   5. a message with no `link_preview` renders no card (absence is not an
 *      error state — no skeleton is shown for something never promised);
 *   6. a DOCUMENT message renders the document card with its type badge and
 *      BOTH open and download actions;
 *   7. a DOCUMENT with no media URL offers no actions and says so;
 *   8. a STICKER renders an image rather than the generic media placeholder;
 *   9. a VIDEO's `src` carries the `#t=0.1` fragment, which is what makes the
 *      bubble show a frame instead of a black rectangle.
 *
 * Run: node scripts/verify-link-preview-dom.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { hardenAssert } from './lib/safe-dom-assert.mjs';
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
// jsdom `window.open`'i uygulamaz; cagrildigini sayabilmek icin kaydedilir.
// `defineProperty` ile zorlanir ve hemen dogrulanir — sessizce basarisiz olan
// bir yama, gercek jsdom `open`ini calistirir ve gate teshissiz olur.
const openedUrls = [];
Object.defineProperty(window, 'open', {
  configurable: true,
  writable: true,
  value: (url) => { openedUrls.push(url); return null; },
});
if (window.open !== Object.getOwnPropertyDescriptor(window, 'open').value) {
  throw new Error('window.open could not be patched; the click contract would be unverifiable');
}

// Teshis sigortasi: gate'in sessizce olmesini engeller.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err && err.stack ? err.stack : err);
  process.exit(1);
});

/**
 * Bir assertion'in `actual`/`expected` degeri CANLI bir DOM elemani olursa
 * Node mesaji uretmek icin `util.inspect(v, { depth: 1000, customInspect: false })`
 * cagirir. `customInspect: false` jsdom'un ucuz inspect'ini devre disi birakir
 * ve elemani React fiber geri referanslariyla birlikte bastan sona yurur:
 * olculen deger tek bir iframe icin 137.861.117 karakter / 509MB RSS. Sonuc
 * sessiz bir SIGKILL (exit 137, stderr bos) ve makinede RAM tukenmesi.
 *
 * Koruma paylasilan modulde yasar ki tum jsdom kapanlari ayni kurali kullansin.
 */
hardenAssert(assert);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-preview-dom-'));
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
      `import { ChatBubble } from '${SRC}/features/whatsapp/components/ChatBubble';`,
      `export { React, act, createRoot, I18nProvider, ChatBubble };`,
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

  const { React, act, createRoot, I18nProvider, ChatBubble } = await import(out);

  let passed = 0;
  const roots = new Set();

  const settle = async (ms = 40) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const renderBubble = async (message) => {
    const container = window.document.createElement('div');
    window.document.body.appendChild(container);
    const root = createRoot(container);
    roots.add(root);
    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ChatBubble, { message }),
        ),
      );
    });
    await settle();
    return container;
  };

  // Her kontrol kendi try/catch'ine sahip: bir assertion patlarsa etiketiyle
  // birlikte basilmali. Aksi halde hata dogrudan `finally`ye kacar ve gate
  // HICBIR teshis birakamaz.
  //
  // KRITIK: hicbir assertion'in `actual`i CANLI bir DOM elemani olmamali.
  // Node'un `assert`i basarisizlikta mesaji
  // `util.inspect(actual, { depth: 1000, customInspect: false })` ile uretir;
  // `customInspect: false` jsdom'un ucuz custom inspect'ini DEVRE DISI birakir
  // ve elemani (React fiber geri referanslari dahil) bastan sona yurur.
  // Olculdu: tek bir iframe icin 3391 karakter yerine 137.861.117 karakter ve
  // 186MB -> 509MB RSS. Bu, makinenin RAM'ini tuketip sureci SESSIZCE
  // oldurur (SIGKILL/137, hicbir stderr yok). Bu yuzden elemanlar daima
  // boolean'a cevrilerek karsilastirilir.
  const absent = (scope, selector) => scope.querySelector(selector) === null;

  const failures = [];
  const check = async (label, fn) => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${label}`);
    } catch (err) {
      failures.push(label);
      console.log(`  FAIL - ${label}`);
      console.log(`         ${err && err.message ? err.message : String(err)}`);
      if (err && err.actual !== undefined) {
        console.log(`         actual:   ${JSON.stringify(err.actual)}`);
        console.log(`         expected: ${JSON.stringify(err.expected)}`);
      }
    }
  };

  const baseMessage = (overrides = {}) => ({
    id: 501,
    conversation_id: 9,
    direction: 'INBOUND',
    message_type: 'TEXT',
    status: 'RECEIVED',
    body: 'su habere bak',
    created_at: '2026-09-30T10:00:00.000Z',
    ...overrides,
  });

  const click = async (el) => {
    assert.ok(el, 'element must exist to be clicked');
    await act(async () => {
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };

  const remoteImage = 'https://cdn.example.com/uzak-kapak.png';
  const proxyImage = '/api/v1/whatsapp/link-preview/image?u=deadbeefdeadbeef';

  const linkPreview = (overrides = {}) => ({
    url: 'https://example.com/haber',
    kind: 'LINK',
    title: 'Haber Basligi',
    description: 'Kisa aciklama',
    site_name: 'Ornek',
    image_url: proxyImage,
    embed_url: null,
    ...overrides,
  });

  await check('a text message with a preview renders the card and keeps the text', async () => {
    const container = await renderBubble(baseMessage({ link_preview: linkPreview() }));
    const card = container.querySelector('[data-testid="link-preview-card"]');
    assert.ok(card, 'the link preview card must render');
    assert.match(card.textContent, /Haber Basligi/, 'the title must appear');
    assert.match(card.textContent, /Ornek/, 'the site name must appear');
    assert.match(container.textContent, /su habere bak/, 'the message text must NOT be replaced by the card');
  });

  await check('the card image uses the authenticated proxy path, never the remote URL', async () => {
    const container = await renderBubble(baseMessage({ link_preview: linkPreview() }));
    const img = container.querySelector('[data-testid="link-preview-card"] img');
    assert.ok(img, 'the card must render its image');
    const src = img.getAttribute('src');
    assert.match(src, /\/api\/v1\/whatsapp\/link-preview\/image\?u=/, 'the image must come from the proxy route');
    assert.ok(!src.includes('cdn.example.com'), 'the remote host must NEVER appear in the rendered src');
    assert.equal(img.getAttribute('referrerpolicy') ?? img.getAttribute('referrerPolicy'), 'no-referrer');
  });

  await check('an embeddable preview creates NO iframe until it is clicked', async () => {
    const container = await renderBubble(
      baseMessage({
        link_preview: linkPreview({
          kind: 'VIDEO',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          site_name: 'YouTube',
          image_url: proxyImage,
          embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        }),
      }),
    );
    assert.ok(
      absent(container, '[data-testid="link-preview-embed"]'),
      'no iframe may exist before the user asks for it',
    );
    await click(container.querySelector('[data-testid="link-preview-media"]'));
    // Sorgu BILEREK konteynere kapsanir: onceki kontrollerden kalan balonlar
    // hala document.body'dedir ve belge genelinde aramak yanlis pozitif uretir.
    const embed = container.querySelector('[data-testid="link-preview-embed"]');
    assert.ok(embed, 'clicking the thumbnail must load the player');
    assert.match(embed.getAttribute('src'), /youtube-nocookie\.com\/embed\//, 'only the allowlisted embed host');
    assert.match(embed.getAttribute('src'), /dQw4w9WgXcQ/, 'the embed must target the right video');
  });

  await check('a preview without an embed URL never creates an iframe', async () => {
    openedUrls.length = 0;
    const container = await renderBubble(baseMessage({ link_preview: linkPreview() }));
    await click(container.querySelector('[data-testid="link-preview-media"]'));
    assert.ok(
      absent(container, '[data-testid="link-preview-embed"]'),
      'an arbitrary URL must never be placed in an iframe',
    );
    // Gomme yoksa gorsel linke goturur (WhatsApp Web davranisi).
    assert.deepEqual(openedUrls, ['https://example.com/haber']);
  });

  await check('a message without a preview renders no card and no skeleton', async () => {
    const container = await renderBubble(baseMessage({ body: 'https://example.com/haber' }));
    assert.ok(absent(container, '[data-testid="link-preview-card"]'), 'no card may be invented for a message with no preview');
    assert.match(container.textContent, /example\.com/, 'the raw text still renders');
  });

  await check('a document renders a typed card with BOTH open and download', async () => {
    const container = await renderBubble(
      baseMessage({
        message_type: 'DOCUMENT',
        body: undefined,
        media_filename: 'rapor.pdf',
        media_mime_type: 'application/pdf',
        media_url: '/api/v1/whatsapp/media/abc',
      }),
    );
    const card = container.querySelector('[data-testid="document-card"]');
    assert.ok(card, 'the document card must render');
    assert.match(card.textContent, /rapor\.pdf/, 'the filename must appear');
    assert.match(card.textContent, /PDF/, 'the type badge must appear');
    const anchors = [...card.querySelectorAll('a')];
    assert.equal(anchors.length, 2, 'open and download are separate actions');
    assert.ok(anchors.some((a) => a.hasAttribute('download')), 'one action downloads');
    assert.ok(anchors.some((a) => !a.hasAttribute('download')), 'one action opens');
  });

  await check('a document with no media URL offers no actions and says so', async () => {
    const container = await renderBubble(
      baseMessage({
        message_type: 'DOCUMENT',
        body: undefined,
        media_filename: 'yok.pdf',
        media_mime_type: 'application/pdf',
        media_url: undefined,
      }),
    );
    const card = container.querySelector('[data-testid="document-card"]');
    assert.ok(card, 'the card still identifies the document');
    assert.equal(card.querySelectorAll('a').length, 0, 'no dead actions may be offered');
    assert.ok(card.textContent.trim().length > 0, 'the card must state the file is unavailable');
  });

  await check('a sticker renders an image, not the generic media placeholder', async () => {
    const container = await renderBubble(
      baseMessage({
        message_type: 'STICKER',
        body: undefined,
        media_url: '/api/v1/whatsapp/media/sticker1',
      }),
    );
    const img = container.querySelector('img');
    assert.ok(img, 'the sticker must render as an image');
    assert.equal(img.getAttribute('src'), '/api/v1/whatsapp/media/sticker1');
  });

  await check('a video src carries the poster fragment', async () => {
    const container = await renderBubble(
      baseMessage({
        message_type: 'VIDEO',
        body: undefined,
        media_url: '/api/v1/whatsapp/media/vid1',
      }),
    );
    const video = container.querySelector('video');
    assert.ok(video, 'the video element must render');
    assert.match(
      video.getAttribute('src'),
      /\/api\/v1\/whatsapp\/media\/vid1#t=0\.1$/,
      'without #t=0.1 the bubble stays a black rectangle',
    );
  });

  ok = failures.length === 0 && passed === 9;
  if (ok) {
    console.log(`Link/media preview DOM contract: PASS (${passed} checks)`);
  } else {
    console.log(`Link/media preview DOM contract: FAIL (${passed} passed, ${failures.length} failed)`);
    for (const f of failures) console.log(`  - ${f}`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
// Acik bir `process.exit` SART: jsdom + React scheduler zamanlayicilari olay
// dongusunu canli tutuyor ve script dogrulamayi gectikten SONRA asili kaliyor.
process.exit(ok ? 0 : 1);
