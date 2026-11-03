/**
 * AŞAMA 5.3.7 — `tezlify:ws_connected` canlı mod regresyon testi.
 *
 * NEDEN BU DOSYA VAR
 * ------------------
 * `whatsappApi.ts` içindeki `useLiveMode`, canlılık yoklamasını İKİ gerçek
 * sinyalde tekrarlar:
 *   1. `/ws` üzerinden gelen `tezlify:ws_event` (yalnız `LIVE_SESSION_EVENTS`)
 *   2. WS yeniden bağlandığında `App.tsx`'in yaydığı `tezlify:ws_connected`
 *
 * İkincisi 5.3.1b/5.3.2'de yalnızca `grep` ile doğrulanmıştı: dinleyici
 * satırlarının varlığı görüldü, ama KAYIT/KALDIRMA davranışı hiç test
 * edilmedi. Bir `removeEventListener` unutulsa ya da effect iki kez bağlansa
 * (StrictMode) hiçbir test kırmızıya dönmüyordu.
 *
 * Bu dosya davranışı ölçer, kaynağı değil:
 *   - dinleyici kayıt ediliyor mu?          → olay yayılınca yoklama artar
 *   - doğru olayda mı tetikleniyor?          → alakasız olay yoklamayı artırmaz
 *   - çoğaltılıyor mu?                       → tek yayın = tek yoklama
 *   - cleanup çalışıyor mu?                  → unmount sonrası yoklama artmaz
 *   - StrictMode çift bağlamıyor mu?         → mount/unmount/mount = tek yoklama
 *   - `gateway_connected` hâlâ dışarıda mı?  → yoklamayı artırmaz
 *
 * Gerçek WebSocket veya ağ bağlantısı AÇILMAZ: `fetch` stub'lanır, olaylar
 * jsdom `window`'ı üzerinde yayılır.
 *
 * Run: node scripts/verify-live-mode-ws-connected.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
// Mutasyon kanıtı için: geçici bir `src` kopyasına karşı koşabilmek adına
// kök geçersiz kılınabilir. VARSAYILAN her zaman gerçek `frontend/src`'tir;
// bu değişken üretim kodunu değil yalnız bu testin girdisini etkiler.
const SRC = process.env.TEZLIFY_SRC_ROOT
  ? path.resolve(process.env.TEZLIFY_SRC_ROOT)
  : path.join(frontendRoot, 'src');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
const setGlobal = (n, v) => {
  try { Object.defineProperty(globalThis, n, { configurable: true, writable: true, value: v }); }
  catch { /* already provided */ }
};
for (const n of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MutationObserver', 'Headers']) setGlobal(n, window[n]);
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('localStorage', window.localStorage);

// ---------------------------------------------------------------------------
// Ağ stub'ı — yalnız gateway health yoklamasını sayar.
// ---------------------------------------------------------------------------
let healthProbes = 0;
setGlobal('fetch', async (url) => {
  const href = String(url);
  if (href.includes('/whatsapp/gateway/health')) healthProbes += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({ gateway_available: true }),
  };
});

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-live-mode-'));
const entry = path.join(tmp, 'entry.tsx');
const out = path.join(tmp, 'bundle.mjs');

let passed = 0;
let failures = 0;
const roots = new Set();

try {
  await writeFile(
    entry,
    [
      `import React from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import { act } from 'react';`,
      `import { useLiveMode, invalidateLiveProbe, LiveModeStatus } from '${SRC}/features/whatsapp/api/whatsappApi';`,
      `export { React, act, createRoot, useLiveMode, invalidateLiveProbe, LiveModeStatus };`,
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

  const { React, act, createRoot, useLiveMode, invalidateLiveProbe } = await import(out);
  const h = React.createElement;

  const flush = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => { await Promise.resolve(); });
    }
  };

  const mountHarness = async () => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    const Harness = () => {
      const { status } = useLiveMode();
      return h('div', { 'data-status': status }, String(status));
    };
    await act(async () => { root.render(h(Harness)); });
    await flush();
    return { root, host };
  };

  const unmount = async (root) => {
    await act(async () => { root.unmount(); });
    roots.delete(root);
    await flush();
  };

  const dispatch = async (name, detail) => {
    await act(async () => {
      window.dispatchEvent(new window.CustomEvent(name, { detail }));
    });
    await flush();
  };

  const resetProbeState = () => {
    invalidateLiveProbe();
    healthProbes = 0;
  };

  const check = async (label, fn) => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${label}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL - ${label}: ${err.message}`);
    }
    for (const root of [...roots]) {
      await act(async () => { root.unmount(); });
      roots.delete(root);
    }
    window.document.body.innerHTML = '';
    resetProbeState();
  };

  // -------------------------------------------------------------------------
  // 1. Mount: effect çalışıyor ve ilk yoklamayı yapıyor (ön koşul)
  // -------------------------------------------------------------------------
  await check('mount tek canlılık yoklaması yapar (ön koşul)', async () => {
    resetProbeState();
    await mountHarness();
    assert.equal(healthProbes, 1, `mount sonrası yoklama=${healthProbes}`);
  });

  // -------------------------------------------------------------------------
  // 2. `tezlify:ws_connected` yoklamayı TETİKLER
  // -------------------------------------------------------------------------
  await check('tezlify:ws_connected yoklamayı yeniden tetikler', async () => {
    resetProbeState();
    await mountHarness();
    const before = healthProbes;
    await dispatch('tezlify:ws_connected');
    assert.equal(healthProbes, before + 1,
      `ws_connected sonrası yoklama=${healthProbes}, önce=${before}`);
  });

  // -------------------------------------------------------------------------
  // 3. Alakasız `ws_event` yoklamayı tetiklemez (dinleyici doğru olayda)
  // -------------------------------------------------------------------------
  await check('canlı olmayan ws_event yoklamayı tetiklemez', async () => {
    resetProbeState();
    await mountHarness();
    const before = healthProbes;
    await dispatch('tezlify:ws_event', { event: 'message_new' });
    await dispatch('tezlify:ws_event', { event: 'whatsapp_sync_progress' });
    assert.equal(healthProbes, before,
      `alakasız olaylar yoklamayı artırdı: ${healthProbes} > ${before}`);
  });

  // -------------------------------------------------------------------------
  // 4. `LIVE_SESSION_EVENTS` üyesi yoklamayı tetikler (kontrol grubu)
  // -------------------------------------------------------------------------
  await check('LIVE_SESSION_EVENTS üyesi ws_event yoklamayı tetikler', async () => {
    resetProbeState();
    await mountHarness();
    const before = healthProbes;
    await dispatch('tezlify:ws_event', { event: 'session_connected' });
    assert.equal(healthProbes, before + 1,
      `session_connected yoklamayı tetiklemedi: ${healthProbes}`);
  });

  // -------------------------------------------------------------------------
  // 5. `gateway_connected` HÂLÂ dışarıda (5.3.2 sözleşmesi)
  // -------------------------------------------------------------------------
  await check('gateway_connected frontend sinyali DEĞİL (yoklamayı tetiklemez)', async () => {
    resetProbeState();
    await mountHarness();
    const before = healthProbes;
    await dispatch('tezlify:ws_event', { event: 'gateway_connected' });
    assert.equal(healthProbes, before,
      `gateway_connected yoklamayı tetikledi — LIVE_SESSION_EVENTS'e geri sızmış`);
  });

  // -------------------------------------------------------------------------
  // 6. Dinleyici ÇOĞALTILMIYOR: mount/unmount/mount sonrası tek yayın = tek yoklama
  // -------------------------------------------------------------------------
  await check('mount/unmount/mount sonrası dinleyici çoğalmaz', async () => {
    resetProbeState();
    const first = await mountHarness();
    await unmount(first.root);
    await mountHarness();
    const before = healthProbes;
    await dispatch('tezlify:ws_connected');
    assert.equal(healthProbes, before + 1,
      `tek yayın ${healthProbes - before} yoklama üretti — dinleyici çoğalmış`);
  });

  // -------------------------------------------------------------------------
  // 7. Cleanup: unmount sonrası eski dinleyici ÇALIŞMAZ
  // -------------------------------------------------------------------------
  await check('unmount sonrası ws_connected yoklama üretmez (cleanup)', async () => {
    resetProbeState();
    const mounted = await mountHarness();
    const afterMount = healthProbes;
    await unmount(mounted.root);
    await dispatch('tezlify:ws_connected');
    assert.equal(healthProbes, afterMount,
      `unmount sonrası hâlâ ${healthProbes - afterMount} yoklama üretildi — listener sızmış`);
  });

  // -------------------------------------------------------------------------
  // 8. StrictMode çift mount: tek yayın hâlâ tek yoklama
  // -------------------------------------------------------------------------
  await check('StrictMode çift mount dinleyiciyi çoğaltmaz', async () => {
    resetProbeState();
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    const Harness = () => {
      const { status } = useLiveMode();
      return h('div', { 'data-status': status }, String(status));
    };
    await act(async () => {
      root.render(h(React.StrictMode, null, h(Harness)));
    });
    await flush();
    const before = healthProbes;
    await dispatch('tezlify:ws_connected');
    assert.equal(healthProbes, before + 1,
      `StrictMode altında tek yayın ${healthProbes - before} yoklama üretti`);
  });

  // -------------------------------------------------------------------------
  // 9. Durum güncelleniyor (sadece yoklama sayısı değil, sonuç da yayılıyor)
  // -------------------------------------------------------------------------
  await check('yoklama sonucu bileşene yansır (LIVE_CONNECTED)', async () => {
    resetProbeState();
    const { host } = await mountHarness();
    const status = host.querySelector('div')?.getAttribute('data-status');
    assert.ok(status && status !== 'LIVE_CONNECTING', `durum yayılmadı: ${status}`);
  });
} finally {
  for (const root of roots) {
    try { await act(async () => { root.unmount(); }); } catch { /* best effort */ }
  }
  await rm(tmp, { recursive: true, force: true });
  window.close();
}

console.log('');
if (failures > 0) {
  console.error(`[verify-live-mode-ws-connected] ${failures} kontrol BAŞARISIZ, ${passed} geçti`);
  process.exit(1);
}
console.log(`[verify-live-mode-ws-connected] Tüm kontroller geçti (${passed})`);
// jsdom (`pretendToBeVisual`) ve React zamanlayıcıları olay döngüsünü canlı
// tutar; süreç kendiliğinden sonlanmaz. Çıkış kodu sözleşmenin parçası
// olduğu için burada AÇIKÇA verilir.
process.exit(0);
