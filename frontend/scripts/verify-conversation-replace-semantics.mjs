/**
 * AŞAMA 5.3.10 — `useWhatsAppConversation` REPLACE (update) semantiği regresyonu.
 *
 * NEDEN BU DOSYA VAR
 * ------------------
 * 5.3.9'da `messages.update` için üçüncü bir `upsert_type: 'replace'` semantiği
 * eklendi ve `useWhatsAppConversation` bu semantiği şu şekilde tüketiyor:
 *
 *   const isReplace = upsert_type === 'replace' || upsert_type === 'update';
 *   ...
 *   if (idx !== -1) {
 *     if (!isReplace) return prev;              // notify/append: mevcut satırı EZME
 *     messages[idx] = { ...prev[idx], ...incoming };
 *   }
 *
 * Bu davranışın HİÇBİR testi yoktu. Bir `if (!isReplace)` ters çevrilse ya da
 * `messages[idx] = incoming` (spread olmadan) yazılsa:
 *   - düzenlenen mesaj açık sohbette eski hâliyle kalır (güncelleme yutulur), VEYA
 *   - her güncelleme YENİ bir balon üretir (çift satır), VEYA
 *   - `created_at`/`id` kaybolur ve mesaj listenin en üstüne zıplar.
 * Üçü de kullanıcıya görünür ve hiçbiri kırmızıya dönmüyordu.
 *
 * NASIL TEST EDİLİYOR (kaynak taraması DEĞİL)
 * -------------------------------------------
 * Gerçek hook, gerçek `I18nProvider`, gerçek `WhatsAppRepository` ve gerçek
 * `mapMessageItem` çalışır. esbuild gerçek `src/` ağacını bundle eder; jsdom
 * `window` sağlar; olaylar gerçek `tezlify:ws_event` CustomEvent'i olarak
 * yayılır. Yalnızca AĞ SINIRI stub'lanır (`fetch`): hook'un veri kaynağı REST
 * olduğu için başka türlü deterministik tohum verilemez. Stub üç endpoint'i
 * karşılar (gateway health, sohbet listesi, mesaj listesi) ve HİÇBİR modül
 * mock'lanmaz — `mapMessage`/`compareMessagesChronological` gerçek koddur.
 *
 * Çalıştır: node scripts/verify-conversation-replace-semantics.mjs
 * Çıkış kodu 0 = PASS.
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
// Mutasyon kanıtı: geçici bir `src` kopyasına karşı koşabilmek için kök
// geçersiz kılınabilir. VARSAYILAN her zaman gerçek `frontend/src`'tir.
const SRC = process.env.TEZLIFY_SRC_ROOT
  ? path.resolve(process.env.TEZLIFY_SRC_ROOT)
  : path.join(frontendRoot, 'src');

const CONV_ID = 7;

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
// Tohum verisi — sunucudan gelen GERÇEK şekil (BackendConversation/BackendMessage)
// ---------------------------------------------------------------------------
const seedMessages = () => [
  {
    id: 101, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
    status: 'RECEIVED', body: 'birinci', wa_message_id: 'WA_1',
    created_at: '2026-10-01T09:00:00+00:00',
  },
  {
    id: 102, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
    status: 'RECEIVED', body: 'ikinci', wa_message_id: 'WA_2',
    created_at: '2026-10-01T09:05:00+00:00',
  },
  {
    id: 103, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
    status: 'RECEIVED', body: 'ucuncu', wa_message_id: 'WA_3',
    created_at: '2026-10-01T09:10:00+00:00',
  },
];

let apiCalls = [];
setGlobal('fetch', async (url) => {
  const href = String(url);
  apiCalls.push(href);
  const json = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  if (href.includes('/whatsapp/gateway/health')) {
    return json({ gateway_available: true });
  }
  // `/messages` kontrolü, genel `/conversations` kontrolünden ÖNCE gelmeli.
  if (/\/whatsapp\/conversations\/\d+\/messages/.test(href)) {
    return json({ messages: seedMessages(), has_more: false });
  }
  if (href.includes('/whatsapp/conversations')) {
    return json({
      items: [{
        id: CONV_ID, session_id: 1, contact_id: 1, lead_id: 1, status: 'ACTIVE',
        unread_count: 0, name: 'Test Kisi', phone: '+905320000000',
        is_group: false, last_message_preview: 'ucuncu',
        last_message_at: '2026-10-01T09:10:00+00:00',
        created_at: '2026-10-01T08:00:00+00:00',
      }],
      total: 1,
    });
  }
  throw new Error(`beklenmeyen fetch: ${href}`);
});

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-replace-'));
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
      `import { useWhatsAppConversation } from '${SRC}/features/whatsapp/hooks/useWhatsAppConversation';`,
      `import { I18nProvider } from '${SRC}/context/I18nContext';`,
      `export { React, act, createRoot, useWhatsAppConversation, I18nProvider };`,
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

  const { React, act, createRoot, useWhatsAppConversation, I18nProvider } = await import(out);
  const h = React.createElement;

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await Promise.resolve(); });
    }
  };

  // Hook'un son dönüş değerini render sırasında yakalıyoruz: testler state'in
  // KENDİSİNE bakar, DOM metnine değil.
  const latest = { value: null };

  const mount = async () => {
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = createRoot(host);
    roots.add(root);
    const Harness = () => {
      const api = useWhatsAppConversation({
        conversationId: CONV_ID,
        autoMarkAsRead: false,
      });
      latest.value = api;
      return h('div', { 'data-count': String(api.messages.length) }, String(api.messages.length));
    };
    await act(async () => {
      root.render(h(I18nProvider, null, h(Harness)));
    });
    await flush();
    return { root, host };
  };

  const unmount = async (root) => {
    await act(async () => { root.unmount(); });
    roots.delete(root);
    await flush();
  };

  const dispatch = async (detail) => {
    await act(async () => {
      window.dispatchEvent(new window.CustomEvent('tezlify:ws_event', { detail }));
    });
    await flush();
  };

  const msgs = () => latest.value.messages;
  const byWa = (waId) => msgs().filter((m) => m.wa_message_id === waId);
  const bodies = () => msgs().map((m) => m.body);
  const ids = () => msgs().map((m) => m.id);

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
    latest.value = null;
  };

  // -------------------------------------------------------------------------
  // 0. ÖN KOŞUL: tohum gerçekten yüklendi (test boş state üzerinde koşmasın)
  // -------------------------------------------------------------------------
  await check('ön koşul: REST tohumu hook state ine yüklendi', async () => {
    apiCalls = [];
    await mount();
    assert.ok(latest.value, 'hook hiç render olmadı');
    assert.deepEqual(bodies(), ['birinci', 'ikinci', 'ucuncu'],
      `tohum yüklenmedi: ${JSON.stringify(bodies())}`);
    assert.ok(apiCalls.some((u) => u.includes('/whatsapp/gateway/health')),
      'canlılık yoklaması yapılmadı');
  });

  // -------------------------------------------------------------------------
  // 1. Var olan mesajın gövdesi `replace` ile DEĞİŞİR
  // -------------------------------------------------------------------------
  await check('replace var olan mesajın gövdesini değiştirir', async () => {
    await mount();
    const before = byWa('WA_2')[0];
    assert.equal(before.body, 'ikinci');
    await dispatch({
      event: 'message_new', conversation_id: CONV_ID, upsert_type: 'replace',
      message: {
        id: 102, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'ikinci (duzeltildi)', wa_message_id: 'WA_2',
        created_at: '2026-10-01T09:05:00+00:00',
      },
    });
    assert.equal(byWa('WA_2').length, 1, 'WA_2 için satır sayısı 1 olmalı');
    assert.equal(byWa('WA_2')[0].body, 'ikinci (duzeltildi)',
      `gövde güncellenmedi: ${JSON.stringify(bodies())}`);
  });

  // -------------------------------------------------------------------------
  // 2. Aynı mesaj için İKİNCİ satır oluşmaz
  // -------------------------------------------------------------------------
  await check('replace ikinci bir satır oluşturmaz (çift balon yok)', async () => {
    await mount();
    const lenBefore = msgs().length;
    for (const body of ['rev1', 'rev2', 'rev3']) {
      await dispatch({
        event: 'message_new', conversation_id: CONV_ID, upsert_type: 'replace',
        message: {
          id: 102, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
          status: 'RECEIVED', body, wa_message_id: 'WA_2',
          created_at: '2026-10-01T09:05:00+00:00',
        },
      });
    }
    assert.equal(msgs().length, lenBefore,
      `satır sayısı ${lenBefore} -> ${msgs().length} (çift satır)`);
    assert.equal(byWa('WA_2').length, 1, `WA_2 satır sayısı ${byWa('WA_2').length}`);
    assert.equal(byWa('WA_2')[0].body, 'rev3', 'son güncelleme kazanmalı');
  });

  // -------------------------------------------------------------------------
  // 3. `created_at` ve SIRALAMA korunur
  // -------------------------------------------------------------------------
  await check('replace created_at ve kronolojik sırayı korur', async () => {
    await mount();
    const createdAtBefore = byWa('WA_2')[0].created_at;
    const idsBefore = ids();
    assert.deepEqual(idsBefore, [101, 102, 103], `başlangıç sırası: ${idsBefore}`);
    await dispatch({
      event: 'message_new', conversation_id: CONV_ID, upsert_type: 'replace',
      message: {
        id: 102, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'guncellendi', wa_message_id: 'WA_2',
        created_at: '2026-10-01T09:05:00+00:00',
      },
    });
    assert.deepEqual(ids(), idsBefore, `sıra değişti: ${ids()}`);
    assert.equal(byWa('WA_2')[0].created_at, createdAtBefore,
      `created_at bozuldu: ${byWa('WA_2')[0].created_at} != ${createdAtBefore}`);
    assert.equal(byWa('WA_2')[0].id, 102, 'numerik id korunmalı');
  });

  // -------------------------------------------------------------------------
  // 4. İçerik AYNIYSA gözlemlenebilir değişiklik olmaz
  //    (yayın bastırma BACKEND garantisidir: `_no_broadcast`; burada ölçülen
  //     şey, böyle bir olay yine de gelirse state in bozulmamasıdır.)
  // -------------------------------------------------------------------------
  await check('aynı içerikli replace state i bozmaz (no-op güvenli)', async () => {
    await mount();
    const snapshot = JSON.stringify(msgs());
    await dispatch({
      event: 'message_new', conversation_id: CONV_ID, upsert_type: 'replace',
      message: {
        id: 102, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'ikinci', wa_message_id: 'WA_2',
        created_at: '2026-10-01T09:05:00+00:00',
      },
    });
    assert.equal(JSON.stringify(msgs()), snapshot,
      `no-op replace state i değiştirdi: ${JSON.stringify(msgs())}`);
  });

  // -------------------------------------------------------------------------
  // 5. `notify` YENİ MESAJ davranışını korur
  // -------------------------------------------------------------------------
  await check('notify (upsert_type yok) yeni mesajı sona ekler', async () => {
    await mount();
    await dispatch({
      event: 'message_new', conversation_id: CONV_ID,
      message: {
        id: 104, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'dorduncu', wa_message_id: 'WA_4',
        created_at: '2026-10-01T09:20:00+00:00',
      },
    });
    assert.equal(msgs().length, 4, `satır sayısı: ${msgs().length}`);
    assert.deepEqual(bodies(), ['birinci', 'ikinci', 'ucuncu', 'dorduncu'],
      `sıra: ${JSON.stringify(bodies())}`);
    assert.equal(byWa('WA_4').length, 1);
  });

  // -------------------------------------------------------------------------
  // 6. `append` GEÇMİŞ mesaj davranışını korur: sona değil, TARİHSEL yerine
  // -------------------------------------------------------------------------
  await check('append geçmiş mesajı tarihsel yerine yerleştirir', async () => {
    await mount();
    await dispatch({
      event: 'message_new', conversation_id: CONV_ID, upsert_type: 'append',
      message: {
        id: 100, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'sifirinci', wa_message_id: 'WA_0',
        created_at: '2026-10-01T08:00:00+00:00',
      },
    });
    assert.equal(msgs().length, 4, `satır sayısı: ${msgs().length}`);
    assert.deepEqual(bodies(), ['sifirinci', 'birinci', 'ikinci', 'ucuncu'],
      `geçmiş mesaj yanlış yere düştü: ${JSON.stringify(bodies())}`);
  });

  // -------------------------------------------------------------------------
  // 7. ACK/status güncellemesi İÇERİK güncellemesi gibi işlenmez
  // -------------------------------------------------------------------------
  await check('message_status_updated gövdeye dokunmaz (ACK yolu ayrı)', async () => {
    await mount();
    const bodyBefore = byWa('WA_2')[0].body;
    const createdAtBefore = byWa('WA_2')[0].created_at;
    const lenBefore = msgs().length;
    await dispatch({
      event: 'message_status_updated', conversation_id: CONV_ID,
      message_id: 102, id: 102, status: 'READ',
    });
    assert.equal(byWa('WA_2')[0].status, 'READ', 'status güncellenmedi');
    assert.equal(byWa('WA_2')[0].body, bodyBefore,
      `ACK gövdeyi değiştirdi: ${byWa('WA_2')[0].body}`);
    assert.equal(byWa('WA_2')[0].created_at, createdAtBefore, 'ACK created_at i değiştirdi');
    assert.equal(msgs().length, lenBefore, 'ACK satır ekledi/sildi');
  });

  // -------------------------------------------------------------------------
  // 8. BİLİNMEYEN mesaj için `replace` gelirse: kaybolmaz, tek kez eklenir
  // -------------------------------------------------------------------------
  await check('bilinmeyen mesaj için replace kaybolmaz, tek kez eklenir', async () => {
    await mount();
    await dispatch({
      event: 'message_new', conversation_id: CONV_ID, upsert_type: 'replace',
      message: {
        id: 105, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'bilinmeyen', wa_message_id: 'WA_5',
        created_at: '2026-10-01T09:30:00+00:00',
      },
    });
    assert.equal(msgs().length, 4, `satır sayısı: ${msgs().length}`);
    assert.equal(byWa('WA_5').length, 1, 'replace bilinmeyen mesajı düşürdü veya çoğalttı');
    assert.equal(byWa('WA_5')[0].body, 'bilinmeyen');
    assert.equal(msgs()[3].wa_message_id, 'WA_5', 'yeni mesaj sona eklenmeli');
  });

  // -------------------------------------------------------------------------
  // 9. `notify` MEVCUT satırı EZMEZ (replace ile ayrımın kanıtı)
  // -------------------------------------------------------------------------
  await check('notify mevcut satırın gövdesini ezmez', async () => {
    await mount();
    await dispatch({
      event: 'message_new', conversation_id: CONV_ID,
      message: {
        id: 102, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'EZICI', wa_message_id: 'WA_2',
        created_at: '2026-10-01T09:05:00+00:00',
      },
    });
    assert.equal(byWa('WA_2')[0].body, 'ikinci',
      `notify mevcut satırı ezdi: ${byWa('WA_2')[0].body}`);
    assert.equal(msgs().length, 3, 'notify çift satır üretti');
  });

  // -------------------------------------------------------------------------
  // 10. Alakasız sohbetin olayı yok sayılır
  // -------------------------------------------------------------------------
  await check('başka sohbetin olayı bu sohbeti değiştirmez', async () => {
    await mount();
    const snapshot = JSON.stringify(msgs());
    await dispatch({
      event: 'message_new', conversation_id: 999, upsert_type: 'replace',
      message: {
        id: 102, conversation_id: 999, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'yanlis sohbet', wa_message_id: 'WA_2',
        created_at: '2026-10-01T09:05:00+00:00',
      },
    });
    assert.equal(JSON.stringify(msgs()), snapshot, 'tenant/sohbet kapsamı sızdı');
  });

  // -------------------------------------------------------------------------
  // 11. ÖLÇÜM: payload `created_at` taşımıyorsa ne olur?
  //     Üretimde `serialize_message` her zaman `created_at` gönderir; bu
  //     kontrol o sözleşme bozulursa sıralamanın nasıl etkilendiğini ölçer.
  // -------------------------------------------------------------------------
  await check('created_at taşımayan replace sıralamayı bozmuyor (sözleşme ölçümü)', async () => {
    await mount();
    await dispatch({
      event: 'message_new', conversation_id: CONV_ID, upsert_type: 'replace',
      message: {
        id: 102, conversation_id: CONV_ID, direction: 'INBOUND', message_type: 'TEXT',
        status: 'RECEIVED', body: 'zamansiz', wa_message_id: 'WA_2',
      },
    });
    assert.equal(byWa('WA_2').length, 1, 'çift satır');
    assert.equal(byWa('WA_2')[0].body, 'zamansiz', 'gövde uygulanmadı');
    assert.equal(msgs()[1].wa_message_id, 'WA_2',
      `zamansız replace mesajı listenin başına taşıdı: ${JSON.stringify(bodies())}`);
    assert.ok(byWa('WA_2')[0].created_at,
      `created_at silindi (${JSON.stringify(byWa('WA_2')[0].created_at)})`);
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
  console.error(`[verify-conversation-replace-semantics] ${failures} kontrol BAŞARISIZ, ${passed} geçti`);
  process.exit(1);
}
console.log(`[verify-conversation-replace-semantics] Tüm kontroller geçti (${passed})`);
// jsdom + React zamanlayıcıları olay döngüsünü canlı tutar; çıkış kodu
// sözleşmenin parçası olduğu için AÇIKÇA verilir.
process.exit(0);
