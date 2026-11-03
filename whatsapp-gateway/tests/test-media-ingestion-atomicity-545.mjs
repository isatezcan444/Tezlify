/**
 * AŞAMA 5.4.5 — media ingestion atomicity (M-1).
 *
 * Runs against the REAL `createMediaStore` with temporary directories and a
 * controllable Baileys stub. Nothing is downloaded from WhatsApp, no network
 * is used, and the production media directory is never touched.
 *
 *   node --import ./tests/media-test-register-atomic.mjs \
 *     tests/test-media-ingestion-atomicity-545.mjs
 *
 * Covered contract:
 *   - N concurrent ingestions of one (session, wa_message_id) do ONE download
 *     and produce exactly ONE file + ONE sidecar
 *   - every successful caller returns the SAME media_id
 *   - the stored bytes hash matches the downloaded bytes
 *   - different message ids download in parallel (no global lock)
 *   - a failed attempt leaves no file and does not block the retry
 *   - a write failure releases the lock and leaves no partial file
 *   - pending callers settle (never hang) when the operation fails
 *   - different sessions are separate lock scopes, not wrongly merged
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

function makeStore(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz545-atomic-'));
  tempDirs.push(dir);
  const store = createMediaStore({ mediaDir: dir, logger: null, ...overrides });
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

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Every message carries a downloadable image so the real download path runs.
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

// ---------------------------------------------------------------------------
// 1. Two concurrent ingestions of the same message
// ---------------------------------------------------------------------------
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  const payload = Buffer.from('ATOMIC-TWO-CONCURRENT-PAYLOAD');
  setDownloadImpl(async () => {
    await sleep(30);
    return payload;
  });
  const message = mediaMessage('WA-ATOMIC-2');

  const [first, second] = await Promise.all([
    store.storeIncomingMedia({ id: 'sess-a' }, message, null),
    store.storeIncomingMedia({ id: 'sess-a' }, message, null),
  ]);

  ok(first && second, 'both concurrent calls succeed');
  eq(downloadState.calls, 1, 'only one download happened');
  eq(first.media_id, second.media_id, 'both calls return the same media_id');
  eq(listMediaFiles(dir).length, 1, 'exactly one media file exists');
  eq(listSidecars(dir).length, 1, 'exactly one sidecar exists');
  const meta = readMeta(dir, first.media_id);
  eq(sha256(fs.readFileSync(meta.filePath)), sha256(payload), 'stored bytes match the downloaded bytes');
}

// ---------------------------------------------------------------------------
// 2. Ten concurrent ingestions of the same message
// ---------------------------------------------------------------------------
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  const payload = Buffer.from('ATOMIC-TEN-CONCURRENT-PAYLOAD');
  setDownloadImpl(async () => {
    await sleep(40);
    return payload;
  });
  const message = mediaMessage('WA-ATOMIC-10');

  const results = await withTimeout(
    Promise.all(
      Array.from({ length: 10 }, () =>
        store.storeIncomingMedia({ id: 'sess-a' }, message, null)
      )
    ),
    5000,
    'concurrent ingestion hung'
  );

  eq(results.every((r) => r && r.media_id), true, 'all ten calls succeed');
  eq(downloadState.calls, 1, 'ten concurrent callers triggered one download');
  eq(new Set(results.map((r) => r.media_id)).size, 1, 'all callers share one media_id');
  eq(listMediaFiles(dir).length, 1, 'exactly one media file exists');
  eq(listSidecars(dir).length, 1, 'exactly one sidecar exists');
  const meta = readMeta(dir, results[0].media_id);
  eq(sha256(fs.readFileSync(meta.filePath)), sha256(payload), 'stored bytes hash matches');
}

// ---------------------------------------------------------------------------
// 3. Different message ids download in parallel and are not blocked
// ---------------------------------------------------------------------------
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  setDownloadImpl(async (waMessage) => {
    await sleep(30);
    return Buffer.from(`PAYLOAD-${waMessage.key.id}`);
  });

  const [a, b] = await Promise.all([
    store.storeIncomingMedia({ id: 'sess-a' }, mediaMessage('WA-PARALLEL-A'), null),
    store.storeIncomingMedia({ id: 'sess-a' }, mediaMessage('WA-PARALLEL-B'), null),
  ]);

  ok(a && b, 'both distinct ids ingest successfully');
  ne(a.media_id, b.media_id, 'distinct ids produce distinct media ids');
  eq(downloadState.calls, 2, 'each distinct id downloaded independently');
  eq(listMediaFiles(dir).length, 2, 'two distinct files exist');
  eq(
    sha256(fs.readFileSync(readMeta(dir, a.media_id).filePath)),
    sha256(Buffer.from('PAYLOAD-WA-PARALLEL-A')),
    'first file has its own bytes'
  );
  eq(
    sha256(fs.readFileSync(readMeta(dir, b.media_id).filePath)),
    sha256(Buffer.from('PAYLOAD-WA-PARALLEL-B')),
    'second file has its own bytes'
  );
}

// ---------------------------------------------------------------------------
// 4. First download fails, the retry succeeds (lock was released)
// ---------------------------------------------------------------------------
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  const payload = Buffer.from('ATOMIC-RETRY-PAYLOAD');
  let attempts = 0;
  setDownloadImpl(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('cdn link expired');
    return payload;
  });

  const first = await store.storeIncomingMedia({ id: 'sess-a' }, mediaMessage('WA-RETRY'), null);
  eq(first, null, 'failed download is reported as a failure, not a success');
  eq(listMediaFiles(dir).length, 0, 'failed attempt leaves no file');
  eq(attempts, 1, 'the first attempt really was made');

  const second = await store.storeIncomingMedia({ id: 'sess-a' }, mediaMessage('WA-RETRY'), null);
  ok(second && second.media_id, 'retry after failure succeeds');
  eq(listMediaFiles(dir).length, 1, 'retry creates exactly one file');
  const meta = readMeta(dir, second.media_id);
  eq(sha256(fs.readFileSync(meta.filePath)), sha256(payload), 'retry stored the downloaded bytes');
}

// ---------------------------------------------------------------------------
// 5. A write failure releases the lock and leaves no partial file
// ---------------------------------------------------------------------------
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  const payload = Buffer.from('ATOMIC-WRITE-FAILURE');
  setDownloadImpl(async () => payload);
  const message = mediaMessage('WA-WRITE-FAIL');

  const originalWriteFileSync = fs.writeFileSync;
  let remainingFailures = 1;
  fs.writeFileSync = function patchedWrite(target, ...rest) {
    const name = String(target);
    if (remainingFailures > 0 && name.startsWith(dir) && !name.endsWith('.meta.json')) {
      remainingFailures -= 1;
      // Simulate a real out-of-space failure: part of the buffer reaches the
      // file, then the write throws. The store must remove this partial file.
      originalWriteFileSync.call(fs, target, Buffer.from('PARTIAL-WRITE'));
      const err = new Error('no space left on device');
      err.code = 'ENOSPC';
      throw err;
    }
    return originalWriteFileSync.call(fs, target, ...rest);
  };
  let failed;
  try {
    failed = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  eq(failed, null, 'write failure is reported as a failure');
  eq(listMediaFiles(dir).length, 0, 'the partially written file is removed, not left behind');
  eq(listSidecars(dir).length, 0, 'no sidecar is written for a failed write');

  const retried = await store.storeIncomingMedia({ id: 'sess-a' }, message, null);
  ok(retried && retried.media_id, 'the same key succeeds after the failed write (lock cleaned)');
  eq(listMediaFiles(dir).length, 1, 'retry created exactly one file');
}

// ---------------------------------------------------------------------------
// 6. Pending callers settle when the operation fails (no hang, lock cleared)
// ---------------------------------------------------------------------------
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  const payload = Buffer.from('ATOMIC-AFTER-ERROR');
  setDownloadImpl(async () => payload);

  const exploding = {
    key: { id: 'WA-EXPLODE' },
    get message() {
      throw new Error('message access exploded');
    },
  };

  const results = await withTimeout(
    Promise.all(
      Array.from({ length: 5 }, () =>
        store.storeIncomingMedia({ id: 'sess-a' }, exploding, null)
      )
    ),
    3000,
    'pending callers hung after a failure'
  );
  eq(results.every((r) => r === null), true, 'every pending caller settles with a failure result');
  eq(listMediaFiles(dir).length, 0, 'a failed ingestion writes no file');

  const recovered = await store.storeIncomingMedia({ id: 'sess-a' }, mediaMessage('WA-EXPLODE'), null);
  ok(recovered && recovered.media_id, 'the same id is not blocked by the failed attempt');
  eq(listMediaFiles(dir).length, 1, 'recovery creates exactly one file');
}

// ---------------------------------------------------------------------------
// 7. Different sessions are separate lock scopes (not wrongly merged)
// ---------------------------------------------------------------------------
{
  resetDownloadImpl();
  const { dir, store } = makeStore();
  const payload = Buffer.from('ATOMIC-TENANT-SCOPE');
  setDownloadImpl(async () => {
    await sleep(40);
    return payload;
  });
  const message = mediaMessage('WA-SHARED-ID');

  const [sessionA, sessionB] = await Promise.all([
    store.storeIncomingMedia({ id: 'sess-a' }, message, null),
    store.storeIncomingMedia({ id: 'sess-b' }, message, null),
  ]);

  ok(sessionA && sessionB, 'both session scopes ingest successfully');
  ne(sessionA.media_id, sessionB.media_id, 'different sessions are not coalesced into one media id');
  eq(downloadState.calls, 2, 'each session scope performs its own download');
  eq(listMediaFiles(dir).length, 2, 'each session scope owns its own file');
  eq(readMeta(dir, sessionA.media_id).sessionId, 'sess-a', 'session A sidecar keeps its own scope');
  eq(readMeta(dir, sessionB.media_id).sessionId, 'sess-b', 'session B sidecar keeps its own scope');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
resetDownloadImpl();
for (const dir of tempDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(`[test-media-ingestion-atomicity-545] ${assertions} assertions passed`);
