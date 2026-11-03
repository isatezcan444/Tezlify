/**
 * AŞAMA 5.4.2 — media store durability + SHA-256 integrity harness (F-09 / F-12).
 *
 * Runs against the REAL `createMediaStore` with temporary directories only.
 * No WhatsApp connection, no real media directory, no network.
 *
 * Because the gateway's node_modules may be absent, this harness is executed with
 * local resolve stubs:
 *
 *   node --import ./tests/media-test-register.mjs tests/test-media-store-integrity.mjs
 *
 * Covered contract:
 *   - store-time SHA-256 + sizeBytes persisted in the existing .meta.json
 *   - correct file verifies; a single changed byte fails (HASH_MISMATCH)
 *   - legacy sidecar without sha256 stays valid (backward compatible)
 *   - corrupt sidecar / size mismatch produce controlled failures
 *   - index overflow keeps physical files and sidecars on disk
 *   - evicted entries remain resolvable by media_id and wa_message_id
 *   - restart re-indexes a bounded set without deleting anything
 *   - missing file and missing index are distinct outcomes
 *   - re-processing the same wa_message_id leaves valid, non-conflicting records
 *   - existing lookups (media_id, wa_message_id, session-agnostic) still work
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMediaStore } from '../src/media/media-store.js';

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

function makeStore(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz542-media-'));
  tempDirs.push(dir);
  const store = createMediaStore({ mediaDir: dir, logger: null, ...overrides });
  return { dir, store };
}

function readMeta(dir, mediaId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${mediaId}.meta.json`), 'utf8'));
}

function writeLegacy(dir, mediaId, content, extra = {}) {
  const filePath = path.join(dir, `${mediaId}.bin`);
  fs.writeFileSync(filePath, content);
  const meta = {
    sessionId: '',
    waMessageId: `WA-${mediaId}`,
    filePath,
    mimeType: 'application/octet-stream',
    filename: `${mediaId}.bin`,
    sizeBytes: content.length,
    savedAt: Date.now(),
    ...extra,
  };
  fs.writeFileSync(path.join(dir, `${mediaId}.meta.json`), JSON.stringify(meta), 'utf8');
  return { filePath, metaPath: path.join(dir, `${mediaId}.meta.json`) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. Store-time hash is persisted alongside the existing metadata
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const buffer = Buffer.from('hello media payload');
  const stored = store.storeMediaBuffer('session-1', buffer, {
    mimeType: 'image/jpeg',
    filename: 'photo.jpg',
    waMessageId: 'WA-HASH-1',
  });
  const meta = readMeta(dir, stored.media_id);
  const expectedHash = createHash('sha256').update(buffer).digest('hex');

  eq(meta.sha256, expectedHash, 'sidecar contains the SHA-256 of the stored bytes');
  eq(meta.sizeBytes, buffer.length, 'sidecar keeps sizeBytes');
  eq(meta.mimeType, 'image/jpeg', 'sidecar keeps MIME type');
  eq(meta.filename, 'photo.jpg', 'sidecar keeps filename');
  eq(meta.waMessageId, 'WA-HASH-1', 'sidecar keeps waMessageId');
  eq(fs.readFileSync(meta.filePath).toString(), 'hello media payload', 'file content is intact');

  const first = await store.verifyMediaIntegrity(stored.media_id, meta.filePath);
  eq(first.ok, true, 'freshly stored file verifies');
  eq(first.legacy, false, 'hashed file is not reported as legacy');
  eq(first.sha256, expectedHash, 'verification returns the computed digest');

  const second = await store.verifyMediaIntegrity(stored.media_id, meta.filePath);
  eq(second.ok, true, 'repeat verification succeeds');
  eq(second.cached, true, 'repeat verification uses the stat-keyed cache');
}

// ---------------------------------------------------------------------------
// 2. One changed byte fails; mismatch is never reported as healthy
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const buffer = Buffer.from('tamper-me');
  const stored = store.storeMediaBuffer('session-1', buffer, { mimeType: 'text/plain' });
  const meta = readMeta(dir, stored.media_id);

  eq((await store.verifyMediaIntegrity(stored.media_id, meta.filePath)).ok, true, 'baseline verifies');

  const tampered = Buffer.from(buffer);
  tampered[0] ^= 0xff;
  fs.writeFileSync(meta.filePath, tampered);

  const result = await store.verifyMediaIntegrity(stored.media_id, meta.filePath);
  eq(result.ok, false, 'tampered file is rejected');
  eq(result.reason, 'HASH_MISMATCH', 'tamper is reported as HASH_MISMATCH');
  eq(fs.statSync(meta.filePath).size, buffer.length, 'tamper kept the same length (not a size check)');
}

// ---------------------------------------------------------------------------
// 3. Legacy media without sha256 stays valid; size mismatch is controlled
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const legacyId = `legacy-${randomUUID()}`;
  const legacy = writeLegacy(dir, legacyId, Buffer.from('old-bytes'));

  const legacyResult = await store.verifyMediaIntegrity(legacyId, legacy.filePath);
  eq(legacyResult.ok, true, 'legacy sidecar without sha256 is served');
  eq(legacyResult.legacy, true, 'legacy result is flagged as legacy');

  const wrongSizeId = `legacy-size-${randomUUID()}`;
  const wrongSize = writeLegacy(dir, wrongSizeId, Buffer.from('short'), { sizeBytes: 999 });
  const wrongSizeResult = await store.verifyMediaIntegrity(wrongSizeId, wrongSize.filePath);
  eq(wrongSizeResult.ok, false, 'legacy size mismatch is rejected');
  eq(wrongSizeResult.reason, 'SIZE_MISMATCH', 'legacy mismatch is reported as SIZE_MISMATCH');
}

// ---------------------------------------------------------------------------
// 4. Corrupt sidecar is a controlled failure, not a silent success
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const corruptId = `corrupt-${randomUUID()}`;
  const filePath = path.join(dir, `${corruptId}.bin`);
  fs.writeFileSync(filePath, Buffer.from('bytes-with-bad-sidecar'));
  fs.writeFileSync(path.join(dir, `${corruptId}.meta.json`), '{not-json', 'utf8');

  const result = await store.verifyMediaIntegrity(corruptId, filePath);
  eq(result.ok, false, 'corrupt sidecar is rejected');
  eq(result.reason, 'META_CORRUPT', 'corrupt sidecar is reported as META_CORRUPT');
}

// ---------------------------------------------------------------------------
// 5. Index overflow keeps files + sidecars; evicted entries stay resolvable
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore({ MEDIA_INDEX_MAX: 2 });
  const first = store.storeMediaBuffer('session-1', Buffer.from('AAA'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-EVICT-1',
  });
  await sleep(5);
  const second = store.storeMediaBuffer('session-1', Buffer.from('BBB'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-EVICT-2',
  });
  await sleep(5);
  const third = store.storeMediaBuffer('session-1', Buffer.from('CCC'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-EVICT-3',
  });

  eq(store.mediaIndex.size, 2, 'RAM index stays bounded at MEDIA_INDEX_MAX');
  ok(!store.mediaIndex.has(first.media_id), 'oldest entry left the RAM index');

  for (const stored of [first, second, third]) {
    const meta = readMeta(dir, stored.media_id);
    ok(fs.existsSync(meta.filePath), `file for ${stored.media_id} is retained on disk`);
    ok(
      fs.existsSync(path.join(dir, `${stored.media_id}.meta.json`)),
      `sidecar for ${stored.media_id} is retained on disk`
    );
  }

  const byWaId = store.getMediaPath(null, 'WA-EVICT-1');
  eq(byWaId, readMeta(dir, first.media_id).filePath, 'evicted wa_message_id is found by scanning sidecars');

  const byMediaId = store.getMediaPath(null, first.media_id);
  eq(byMediaId, byWaId, 'evicted media_id re-hydrates from its sidecar');

  const verified = await store.verifyMediaIntegrity(first.media_id, byMediaId);
  eq(verified.ok, true, 'evicted media still verifies against its sidecar hash');

  const meta = readMeta(dir, third.media_id);
  eq(meta.sha256, createHash('sha256').update(Buffer.from('CCC')).digest('hex'), 'newest sidecar hash is correct');
}

// ---------------------------------------------------------------------------
// 5b. Prefix ids never alias another file; unknown lookups do not grow the index
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore({ MEDIA_INDEX_MAX: 2 });
  const stored = store.storeMediaBuffer('session-1', Buffer.from('prefix-victim'), {
    mimeType: 'text/plain',
  });
  const prefix = stored.media_id.slice(0, 6);
  eq(store.getMediaPath(null, prefix), null, 'a prefix of a stored id does not resolve to its file');
  eq(store.getMediaPath(null, 'two/parts'), null, 'path separators are rejected');
  eq(store.getMediaPath(null, '..'), null, 'dot-dot is rejected');

  for (let i = 0; i < 20; i += 1) {
    store.getMediaPath(null, `unknown-${i}`);
  }
  eq(store.mediaIndex.size, 1, 'unknown lookups add nothing to the RAM index');
  eq(store.getMediaPath(null, stored.media_id), readMeta(dir, stored.media_id).filePath, 'exact id still resolves');
}

// ---------------------------------------------------------------------------
// 6. Restart simulation: bounded index, nothing deleted
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore({ MEDIA_INDEX_MAX: 2 });
  const stored = [];
  for (const [i, body] of ['R1', 'R2', 'R3'].entries()) {
    stored.push(store.storeMediaBuffer('session-1', Buffer.from(body), {
      mimeType: 'text/plain',
      waMessageId: `WA-RESTART-${i}`,
    }));
    await sleep(5);
  }

  const restarted = createMediaStore({ mediaDir: dir, logger: null, MEDIA_INDEX_MAX: 2 });
  eq(restarted.mediaIndex.size, 2, 'restart re-indexes only MEDIA_INDEX_MAX entries');

  for (const entry of stored) {
    const meta = readMeta(dir, entry.media_id);
    ok(fs.existsSync(meta.filePath), `restart did not delete ${entry.media_id}`);
  }

  const oldest = stored[0];
  ok(!restarted.mediaIndex.has(oldest.media_id), 'oldest entry is not indexed after restart');
  const resolved = restarted.getMediaPath(null, oldest.media_id);
  eq(resolved, readMeta(dir, oldest.media_id).filePath, 'oldest media is reachable after restart');
  eq((await restarted.verifyMediaIntegrity(oldest.media_id, resolved)).ok, true, 'post-restart verification passes');
}

// ---------------------------------------------------------------------------
// 7. Missing file vs missing index are different outcomes
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('session-1', Buffer.from('gone'), { mimeType: 'text/plain' });
  const meta = readMeta(dir, stored.media_id);
  fs.rmSync(meta.filePath);

  eq(store.getMediaPath(null, stored.media_id), null, 'missing file yields no path');
  const result = await store.verifyMediaIntegrity(stored.media_id, meta.filePath);
  eq(result.ok, false, 'missing file is rejected');
  eq(result.reason, 'MISSING', 'missing file is reported as MISSING');
  ok(fs.existsSync(path.join(dir, `${stored.media_id}.meta.json`)), 'sidecar survives a missing file');
}

// ---------------------------------------------------------------------------
// 8. Re-processing the same wa_message_id leaves valid, non-conflicting records
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const first = store.storeMediaBuffer('session-1', Buffer.from('v1'), {
    mimeType: 'image/jpeg',
    waMessageId: 'WA-DUP',
  });
  const second = store.storeMediaBuffer('session-1', Buffer.from('v2'), {
    mimeType: 'image/jpeg',
    waMessageId: 'WA-DUP',
  });

  ok(first.media_id !== second.media_id, 're-processing creates a distinct media_id');
  const firstMeta = readMeta(dir, first.media_id);
  const secondMeta = readMeta(dir, second.media_id);
  ok(fs.existsSync(firstMeta.filePath), 'previous copy is not deleted');
  eq((await store.verifyMediaIntegrity(first.media_id, firstMeta.filePath)).ok, true, 'older copy verifies');
  eq((await store.verifyMediaIntegrity(second.media_id, secondMeta.filePath)).ok, true, 'newer copy verifies');
  eq(store.getMediaIdByWaId('WA-DUP'), second.media_id, 'wa_message_id resolves to the newest copy');
  eq(store.getMediaPath(null, 'WA-DUP'), secondMeta.filePath, 'path for wa_message_id points at the newest copy');

  store.clearSessionMedia('session-1');
  ok(fs.existsSync(firstMeta.filePath), 'clearSessionMedia never deletes files');
  ok(fs.existsSync(secondMeta.filePath), 'clearSessionMedia keeps the newest copy too');
}

// ---------------------------------------------------------------------------
// 9. Existing lookup behavior: session-agnostic path resolution is preserved
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('ephemeral-session', Buffer.from('loyal-file'), {
    mimeType: 'application/pdf',
    filename: 'contract.pdf',
  });
  const meta = readMeta(dir, stored.media_id);

  eq(store.getMediaPath('different-session', stored.media_id), meta.filePath, 'path resolution ignores session changes');
  eq(store.getMediaPath(null, stored.media_id), meta.filePath, 'unscoped lookup still resolves its own id');
  eq(stored.mime_type, 'application/pdf', 'MIME type is returned unchanged');
  eq(stored.filename, 'contract.pdf', 'filename is returned unchanged');
}

// ---------------------------------------------------------------------------
// 10. Large file: stored hash matches an independent SHA-256, verification passes
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const big = Buffer.alloc(4 * 1024 * 1024, 7);
  const stored = store.storeMediaBuffer('session-1', big, { mimeType: 'video/mp4' });
  const meta = readMeta(dir, stored.media_id);
  const expected = createHash('sha256').update(big).digest('hex');

  eq(meta.sha256, expected, 'large file hash matches an independent computation');
  eq(meta.sizeBytes, big.length, 'large file size is recorded');
  const result = await store.verifyMediaIntegrity(stored.media_id, meta.filePath);
  eq(result.ok, true, 'large file verifies through the streaming reader');
  eq(result.sha256, expected, 'streamed digest equals the stored digest');
}

for (const dir of tempDirs) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`[test-media-store-integrity] ${assertions} assertions passed`);
