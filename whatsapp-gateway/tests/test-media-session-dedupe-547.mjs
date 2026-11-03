/**
 * AŞAMA 5.4.7 — çapraz oturum dedupe izolasyonu (A-2).
 *
 * Gerçek `createMediaStore` + geçici dizin + indirilebilir Baileys stub.
 * Ağ yok, gerçek WhatsApp yok, üretim medya klasörüne dokunulmaz.
 *
 *   node --import ./tests/media-test-register-atomic.mjs \
 *     tests/test-media-session-dedupe-547.mjs
 *
 * Sözleşme:
 *   - Aynı session + aynı waMessageId (eşzamanlı/sıralı) → tek indirme,
 *     tek dosya, aynı media_id.
 *   - Farklı session + aynı waMessageId (eşzamanlı/sıralı) → bağımsız
 *     indirme, ayrı media_id, ayrı dosya/sidecar.
 *   - Bir oturumun başarısızlığı diğer oturumu veya kendi retry'sini kilitlemez.
 *   - Aynı session + farklı waMessageId → iki bağımsız kayıt.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMediaStore } from '../src/media/media-store.js';
import {
  downloadState,
  resetDownloadImpl,
  setDownloadImpl,
} from './stubs/baileys-atomic.mjs';

const tempDirs = [];
let assertions = 0;

function ok(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

function eq(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function ne(actual, unexpected, message) {
  assert.notEqual(actual, unexpected, message);
  assertions += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz547-dedupe-'));
  tempDirs.push(dir);
  const store = createMediaStore({ mediaDir: dir, logger: null });
  return { dir, store };
}

function listMediaFiles(dir) {
  return fs.readdirSync(dir).filter((f) => !f.endsWith('.meta.json')).sort();
}

function listSidecars(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')).sort();
}

function readMeta(dir, mediaId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${mediaId}.meta.json`), 'utf8'));
}

function mediaMessage(waMessageId) {
  return {
    key: { id: waMessageId },
    message: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/stub',
        mimetype: 'image/jpeg',
        mediaKey: Buffer.from('stub-media-key'),
      },
    },
  };
}

// 1. Aynı session + aynı ID, eşzamanlı
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  setDownloadImpl(async () => {
    await sleep(30);
    return Buffer.from('SAME-SESSION-CONCURRENT');
  });
  const message = mediaMessage('WA-SAME-CONCURRENT');

  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      store.storeIncomingMedia({ id: 'sess-a' }, message, null)
    )
  );

  eq(downloadState.calls, 1, 'aynı session eşzamanlı: tek indirme');
  eq(new Set(results.map((r) => r?.media_id)).size, 1, 'aynı session: tek media_id');
  ok(results.every((r) => r && r.media_id), 'tüm çağıranlar başarılı sonuç alır');
  eq(listMediaFiles(dir).length, 1, 'tek dosya');
  eq(listSidecars(dir).length, 1, 'tek sidecar');
  eq(readMeta(dir, results[0].media_id).sessionId, 'sess-a', 'sidecar session A');
  eq(readMeta(dir, results[0].media_id).waMessageId, 'WA-SAME-CONCURRENT', 'sidecar waMessageId');
}

// 2. Aynı session + aynı ID, sıralı
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  setDownloadImpl(async () => Buffer.from('SAME-SESSION-SEQUENTIAL'));
  const message = mediaMessage('WA-SAME-SEQUENTIAL');

  const first = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  const second = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);

  eq(downloadState.calls, 1, 'aynı session sıralı: mevcut kayıt yeniden kullanılır');
  eq(second.media_id, first.media_id, 'aynı media_id döner');
  eq(listMediaFiles(dir).length, 1, 'tek dosya');
  eq(listSidecars(dir).length, 1, 'tek sidecar');
}

// 3. Farklı session + aynı ID, sıralı
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  let n = 0;
  setDownloadImpl(async () => {
    n += 1;
    return Buffer.from(`CROSS-SESSION-SEQUENTIAL-${n}`);
  });
  const message = mediaMessage('WA-CROSS-SEQUENTIAL');

  const a = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  const b = await store.storeIncomingMedia({ id: 'sess-b' }, message, null);

  eq(downloadState.calls, 2, 'farklı session sıralı: iki bağımsız indirme');
  ne(a.media_id, b.media_id, 'farklı media_id');
  eq(listMediaFiles(dir).length, 2, 'iki ayrı dosya');
  eq(listSidecars(dir).length, 2, 'iki ayrı sidecar');
  eq(readMeta(dir, a.media_id).sessionId, 'sess-a', 'A sidecar kendi oturumunda');
  eq(readMeta(dir, b.media_id).sessionId, 'sess-b', 'B sidecar kendi oturumunda');
  ne(readMeta(dir, a.media_id).filePath, readMeta(dir, b.media_id).filePath, 'dosya yolları ayrı');
  eq(readMeta(dir, a.media_id).waMessageId, 'WA-CROSS-SEQUENTIAL', 'A waMessageId');
  eq(readMeta(dir, b.media_id).waMessageId, 'WA-CROSS-SEQUENTIAL', 'B waMessageId');
}

// 4. Farklı session + aynı ID, eşzamanlı
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  setDownloadImpl(async () => {
    await sleep(40);
    return Buffer.from('CROSS-SESSION-CONCURRENT');
  });
  const message = mediaMessage('WA-CROSS-CONCURRENT');

  const [a, b] = await Promise.all([
    store.storeIncomingMedia({ id: 'sess-a' }, message, null),
    store.storeIncomingMedia({ id: 'sess-b' }, message, null),
  ]);

  eq(downloadState.calls, 2, 'farklı session eşzamanlı: iki indirme');
  ne(a.media_id, b.media_id, 'farklı media_id');
  eq(listMediaFiles(dir).length, 2, 'iki ayrı dosya');
  eq(listSidecars(dir).length, 2, 'iki ayrı sidecar');
  eq(readMeta(dir, a.media_id).sessionId, 'sess-a', 'A sidecar kendi oturumunda');
  eq(readMeta(dir, b.media_id).sessionId, 'sess-b', 'B sidecar kendi oturumunda');
}

// 5. Session A başarısız, Session B başarılı; ardından A retry
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  let n = 0;
  setDownloadImpl(async () => {
    n += 1;
    if (n === 1) throw new Error('SESSION-A-DOWNLOAD-FAILED');
    return Buffer.from(`RETRY-${n}`);
  });
  const message = mediaMessage('WA-RETRY-ISOLATED');

  const aFailed = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  eq(aFailed, null, 'A başarısızlığı null olarak raporlanır');
  eq(listMediaFiles(dir).length, 0, 'A başarısızken dosya yok');

  const b = await store.storeIncomingMedia({ id: 'sess-b' }, message, null);
  ok(b && b.media_id, 'B, A başarısız olsa da başarılı olur');
  eq(downloadState.calls, 2, 'B kendi indirmesini yapar');
  eq(listMediaFiles(dir).length, 1, 'yalnız B dosyası var');
  eq(readMeta(dir, b.media_id).sessionId, 'sess-b', 'B sidecar kendi oturumunda');

  const aRetried = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  ok(aRetried && aRetried.media_id, 'A başarısız denemeden sonra retry edebilir (lock temiz)');
  eq(downloadState.calls, 3, 'A retry kendi indirmesini yapar');
  ne(aRetried.media_id, b.media_id, 'A retry B kaydını devralmaz');
  eq(listMediaFiles(dir).length, 2, 'iki bağımsız dosya');
  eq(readMeta(dir, aRetried.media_id).sessionId, 'sess-a', 'A sidecar kendi oturumunda');
  eq(readMeta(dir, b.media_id).sessionId, 'sess-b', 'B sidecar değişmez');
}

// 6. Session A retry, Session B mevcut → kayıtlar karışmaz
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  let n = 0;
  setDownloadImpl(async () => {
    n += 1;
    if (n === 1) throw new Error('SESSION-A-FIRST-FAIL');
    return Buffer.from(`A-OR-B-${n}`);
  });
  const message = mediaMessage('WA-RETRY-WITH-B');

  await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  const b = await store.storeIncomingMedia({ id: 'sess-b' }, message, null);
  const bMetaBefore = readMeta(dir, b.media_id);
  const a2 = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  eq(downloadState.calls, 3, 'A retry kendi indirmesini yapar');
  ne(a2.media_id, b.media_id, 'A retry B kaydını döndürmez');

  const a3 = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  eq(downloadState.calls, 3, 'A sonraki çağrı kendi mevcut kaydını kullanır');
  eq(a3.media_id, a2.media_id, 'A kaydı kararlı');
  eq(readMeta(dir, b.media_id).sessionId, bMetaBefore.sessionId, 'B sidecar oturumu değişmez');
  eq(bMetaBefore.sessionId, 'sess-b', 'B sidecar kendi oturumunda kalır');
  eq(listMediaFiles(dir).length, 2, 'A ve B için iki dosya');
}

// 7. Aynı session + farklı ID
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  setDownloadImpl(async () => Buffer.from('SAME-SESSION-DIFFERENT-IDS'));
  const first = await store.storeIncomingMedia({ id: 'sess-a' }, mediaMessage('WA-ID-1'), null);
  const second = await store.storeIncomingMedia({ id: 'sess-a' }, mediaMessage('WA-ID-2'), null);

  eq(downloadState.calls, 2, 'farklı ID: iki indirme');
  ne(first.media_id, second.media_id, 'farklı media_id');
  eq(listMediaFiles(dir).length, 2, 'iki dosya');
  eq(readMeta(dir, first.media_id).waMessageId, 'WA-ID-1', 'ilk sidecar ID-1');
  eq(readMeta(dir, second.media_id).waMessageId, 'WA-ID-2', 'ikinci sidecar ID-2');
}

// Temizlik
resetDownloadImpl();
for (const dir of tempDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(`[test-media-session-dedupe-547] ${assertions} assertions passed`);
