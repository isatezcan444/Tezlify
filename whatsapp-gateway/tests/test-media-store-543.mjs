/**
 * AŞAMA 5.4.3 — media store: TOCTOU, async sidecar search, dedupe, disk safety.
 *
 * Runs against the REAL `createMediaStore` with temporary directories only.
 * No WhatsApp connection, no network, no production media folder.
 *
 *   node --import ./tests/media-test-register.mjs tests/test-media-store-543.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz543-store-'));
  tempDirs.push(dir);
  const store = createMediaStore({ mediaDir: dir, logger: null, ...overrides });
  return { dir, store };
}

function readMeta(dir, mediaId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${mediaId}.meta.json`), 'utf8'));
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function listMediaFiles(dir) {
  return fs.readdirSync(dir).filter((f) => !f.endsWith('.meta.json')).sort();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. Verified bytes === served bytes (same open FD, not a re-opened path)
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('session-1', Buffer.from('ORIGINAL-BYTES'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-TOCTOU-1',
  });
  const meta = readMeta(dir, stored.media_id);

  const opened = await store.openVerifiedMedia(stored.media_id, meta.filePath);
  eq(opened.ok, true, 'stored file opens and verifies');
  eq(opened.legacy, false, 'hash-verified file is not reported as legacy');
  eq(opened.size, Buffer.byteLength('ORIGINAL-BYTES'), 'reported size matches');

  // Swap the directory entry AFTER verification: a path-based re-open would
  // now read the impostor. The returned stream owns the original inode.
  const impostor = path.join(dir, 'impostor.bin');
  fs.writeFileSync(impostor, 'IMPOSTOR-BYTES');
  fs.renameSync(impostor, meta.filePath);
  eq(fs.readFileSync(meta.filePath, 'utf8'), 'IMPOSTOR-BYTES', 'path now points at impostor bytes');

  const served = await collect(opened.stream);
  eq(served.toString(), 'ORIGINAL-BYTES', 'served bytes come from the verified FD, not the swapped path');
}

// ---------------------------------------------------------------------------
// 2. In-place tampering is rejected before a single byte is returned
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('session-1', Buffer.from('good-payload'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-TAMPER',
  });
  const meta = readMeta(dir, stored.media_id);
  fs.writeFileSync(meta.filePath, 'evil-payload');

  const opened = await store.openVerifiedMedia(stored.media_id, meta.filePath);
  eq(opened.ok, false, 'tampered file is rejected');
  eq(opened.reason, 'HASH_MISMATCH', 'tampering is reported as HASH_MISMATCH');
  eq(opened.stream, undefined, 'no stream is handed out for a failed verification');
}

// ---------------------------------------------------------------------------
// 3. Corrupt sidecar, missing file, legacy file, zero-byte file
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('s', Buffer.from('corrupt-me'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-CORRUPT',
  });
  const meta = readMeta(dir, stored.media_id);
  fs.writeFileSync(path.join(dir, `${stored.media_id}.meta.json`), '{not-json', 'utf8');
  // Fresh store: a restart cannot re-index the corrupt sidecar and must fail
  // closed instead of serving the bytes unverified.
  const restarted = createMediaStore({ mediaDir: dir, logger: null });
  const corrupt = await restarted.openVerifiedMedia(stored.media_id, meta.filePath);
  eq(corrupt.ok, false, 'corrupt sidecar is rejected');
  eq(corrupt.reason, 'META_CORRUPT', 'corrupt sidecar is reported as META_CORRUPT');
}
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('s', Buffer.from('corrupt-resolve'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-CORRUPT-RESOLVE',
  });
  const meta = readMeta(dir, stored.media_id);
  fs.writeFileSync(path.join(dir, `${stored.media_id}.meta.json`), '{not-json', 'utf8');
  const restarted = createMediaStore({ mediaDir: dir, logger: null, MEDIA_INDEX_MAX: 0 });
  const resolved = await restarted.resolveMediaPath(null, stored.media_id);
  eq(resolved, meta.filePath, 'corrupt sidecar still locates the existing file');
  eq(
    restarted.mediaIndex.has(stored.media_id),
    false,
    'corrupt sidecar never becomes a metadata-less (legacy) index entry'
  );
  const opened = await restarted.openVerifiedMedia(stored.media_id, resolved);
  eq(opened.ok, false, 'corrupt sidecar fails closed after resolution');
  eq(opened.reason, 'META_CORRUPT', 'reason stays META_CORRUPT');
}
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('s', Buffer.from('gone'), { mimeType: 'text/plain' });
  const meta = readMeta(dir, stored.media_id);
  fs.rmSync(meta.filePath);
  const missing = await store.openVerifiedMedia(stored.media_id, meta.filePath);
  eq(missing.ok, false, 'missing file is rejected');
  eq(missing.reason, 'MISSING', 'missing file is reported as MISSING');
}
{
  const { dir, store } = makeStore();
  const filePath = path.join(dir, 'legacy-file.bin');
  fs.writeFileSync(filePath, 'legacy-bytes');
  fs.writeFileSync(
    path.join(dir, 'legacy-file.meta.json'),
    JSON.stringify({ filePath, mimeType: 'text/plain', filename: 'legacy.bin', sizeBytes: 12, savedAt: Date.now() }),
    'utf8'
  );
  const opened = await store.openVerifiedMedia('legacy-file', filePath);
  eq(opened.ok, true, 'legacy file without sha256 is still served');
  eq(opened.legacy, true, 'legacy file is flagged, not reported as hash-verified');
  eq((await collect(opened.stream)).toString(), 'legacy-bytes', 'legacy bytes stream intact');
}
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('s', Buffer.alloc(0), { mimeType: 'text/plain' });
  const meta = readMeta(dir, stored.media_id);
  const opened = await store.openVerifiedMedia(stored.media_id, meta.filePath);
  eq(opened.ok, true, 'zero-byte file verifies');
  eq(opened.size, 0, 'zero-byte size reported');
  eq((await collect(opened.stream)).length, 0, 'zero-byte stream terminates');
}

// ---------------------------------------------------------------------------
// 4. Post-hash stat guard catches a modification that races the read
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const stored = store.storeMediaBuffer('s', Buffer.from('race-me'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-RACE',
  });
  const meta = readMeta(dir, stored.media_id);

  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = function patched(target, options) {
    const stream = originalCreateReadStream.call(fs, target, options);
    // hashFd opens the verified FD with autoClose:false; append after its read
    // completes but before openVerifiedMedia's post-hash fstat runs.
    if (target === null && options && options.fd !== undefined && options.autoClose === false) {
      stream.once('end', () => {
        fs.appendFileSync(meta.filePath, '!');
      });
    }
    return stream;
  };
  let opened;
  try {
    opened = await store.openVerifiedMedia(stored.media_id, meta.filePath);
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
  eq(opened.ok, false, 'file changed during verification is rejected');
  eq(opened.reason, 'CHANGED_DURING_VERIFY', 'race is reported as CHANGED_DURING_VERIFY');
}

// ---------------------------------------------------------------------------
// 5. Out-of-index resolution is async, unbounded (>5000 sidecars) and exact
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz543-scan-'));
  tempDirs.push(dir);
  const TOTAL_OTHERS = 5100;
  for (let i = 0; i < TOTAL_OTHERS; i += 1) {
    const mediaId = `media-${String(i).padStart(5, '0')}`;
    const filePath = path.join(dir, `${mediaId}.bin`);
    fs.writeFileSync(filePath, `body-${i}`);
    fs.writeFileSync(
      path.join(dir, `${mediaId}.meta.json`),
      JSON.stringify({
        filePath,
        mimeType: 'application/octet-stream',
        filename: `${mediaId}.bin`,
        sizeBytes: Buffer.byteLength(`body-${i}`),
        waMessageId: `WA-${mediaId}`,
        savedAt: Date.now() - 100000 + i,
      }),
      'utf8'
    );
  }
  // Target placed LAST so an implementation that stops at SIDECAR_SCAN_MAX
  // (5000) cannot find it.
  const targetId = 'media-target-last';
  const targetPath = path.join(dir, `${targetId}.bin`);
  fs.writeFileSync(targetPath, 'target-body');
  fs.writeFileSync(
    path.join(dir, `${targetId}.meta.json`),
    JSON.stringify({
      filePath: targetPath,
      mimeType: 'text/plain',
      filename: 'target.txt',
      sizeBytes: Buffer.byteLength('target-body'),
      waMessageId: 'WA-TARGET-LAST',
      savedAt: Date.now(),
      sha256: createHash('sha256').update('target-body').digest('hex'),
    }),
    'utf8'
  );

  // MEDIA_INDEX_MAX 0: nothing is in RAM, so both lookups must hit disk.
  const store = createMediaStore({ mediaDir: dir, logger: null, MEDIA_INDEX_MAX: 0 });
  eq(store.mediaIndex.size, 0, 'RAM index is empty for this scenario');

  // Spy on synchronous fs entry points: the request path must not use them.
  const syncCalls = { readdirSync: 0, readFileSync: 0, existsSync: 0, statSync: 0 };
  const originals = {};
  for (const name of Object.keys(syncCalls)) {
    originals[name] = fs[name];
    fs[name] = function counted(...args) {
      syncCalls[name] += 1;
      return originals[name].apply(fs, args);
    };
  }
  // Directory order is kernel-defined; force the target to be the LAST sidecar
  // so the assertion proves the scan is unbounded rather than luckily early.
  const targetSidecar = `${targetId}.meta.json`;
  const originalReaddir = fs.promises.readdir;
  fs.promises.readdir = async function reordered(target, ...rest) {
    const entries = await originalReaddir.call(fs.promises, target, ...rest);
    if (target !== dir) return entries;
    const nonSidecars = entries.filter((e) => !e.endsWith('.meta.json'));
    const sidecars = entries.filter((e) => e.endsWith('.meta.json') && e !== targetSidecar);
    return [...nonSidecars, ...sidecars, targetSidecar];
  };
  let sidecarReads = 0;
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = function countedRead(...args) {
    sidecarReads += 1;
    return originalReadFile.apply(fs.promises, args);
  };
  let immediateTicks = 0;
  let ticking = true;
  const tick = () => {
    if (!ticking) return;
    immediateTicks += 1;
    setImmediate(tick);
  };
  setImmediate(tick);

  let byWaId;
  let byMediaId;
  try {
    byWaId = await store.resolveMediaPath(null, 'WA-TARGET-LAST');
    byMediaId = await store.resolveMediaPath(null, targetId);
  } finally {
    ticking = false;
    for (const name of Object.keys(syncCalls)) fs[name] = originals[name];
    fs.promises.readdir = originalReaddir;
    fs.promises.readFile = originalReadFile;
  }

  eq(byWaId, targetPath, 'wa_message_id beyond 5000 sidecars resolves');
  eq(byMediaId, targetPath, 'media_id resolves from its sidecar without RAM');
  ok(sidecarReads >= TOTAL_OTHERS + 1, 'scan passes the 5000-sidecar mark before finding the target');
  eq(
    syncCalls.readdirSync + syncCalls.readFileSync + syncCalls.existsSync + syncCalls.statSync,
    0,
    'resolution performs zero synchronous fs calls'
  );
  ok(immediateTicks > 0, 'event loop keeps turning during the sidecar scan');

  const prefix = await store.resolveMediaPath(null, targetId.slice(0, 8));
  eq(prefix, null, 'a prefix of a media id never resolves to the file');
  const traversal = await store.resolveMediaPath(null, '../etc/passwd');
  eq(traversal, null, 'path traversal is rejected');
}

// ---------------------------------------------------------------------------
// 6. Restart/eviction must not create a duplicate for the same wa_message_id
// ---------------------------------------------------------------------------
{
  const { dir, store: writer } = makeStore({ MEDIA_INDEX_MAX: 10 });
  const original = writer.storeMediaBuffer('s', Buffer.from('first-copy'), {
    mimeType: 'image/jpeg',
    waMessageId: 'WA-REPLAY-1',
  });
  writer.storeMediaBuffer('s', Buffer.from('newer-other'), {
    mimeType: 'image/jpeg',
    waMessageId: 'WA-OTHER-1',
  });
  const filesBefore = listMediaFiles(dir).length;

  // Fresh store == gateway restart. MEDIA_INDEX_MAX 1 evicts WA-REPLAY-1 from RAM.
  const restarted = createMediaStore({
    mediaDir: dir,
    logger: null,
    MEDIA_INDEX_MAX: 1,
    processStartedAtMs: Date.now() + 60_000,
  });

  const oldSeconds = Math.floor((Date.now() - 86_400_000) / 1000);
  const replayMessage = {
    key: { id: 'WA-REPLAY-1' },
    message: {},
    messageTimestamp: oldSeconds,
  };
  const [first, second] = await Promise.all([
    restarted.storeIncomingMedia({ id: 's' }, replayMessage, null),
    restarted.storeIncomingMedia({ id: 's' }, replayMessage, null),
  ]);

  eq(first?.media_id, original.media_id, 'replayed message returns the existing media');
  eq(second?.media_id, original.media_id, 'concurrent replay returns the same media');
  eq(listMediaFiles(dir).length, filesBefore, 'no duplicate file was written');
}

// ---------------------------------------------------------------------------
// 7. A live message (timestamp after process start) skips the disk scan
// ---------------------------------------------------------------------------
{
  const { dir, store: writer } = makeStore({ MEDIA_INDEX_MAX: 10 });
  writer.storeMediaBuffer('s', Buffer.from('old-copy'), {
    mimeType: 'image/jpeg',
    waMessageId: 'WA-LIVE-GATE',
  });

  const emptyIndexStore = createMediaStore({ mediaDir: dir, logger: null, MEDIA_INDEX_MAX: 0 });
  let sidecarReads = 0;
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = function counted(...args) {
    sidecarReads += 1;
    return originalReadFile.apply(fs.promises, args);
  };
  let result;
  try {
    result = await emptyIndexStore.storeIncomingMedia(
      { id: 's' },
      {
        key: { id: 'WA-LIVE-GATE' },
        message: {},
        messageTimestamp: Math.floor(Date.now() / 1000) + 3600,
      },
      null
    );
  } finally {
    fs.promises.readFile = originalReadFile;
  }
  eq(result, null, 'live message with no downloadable content returns null');
  eq(sidecarReads, 0, 'live message does not scan sidecars');
  eq(listMediaFiles(dir).length, 1, 'no duplicate was created');
}

// ---------------------------------------------------------------------------
// 8. Disk-full: only the just-created file is rolled back
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore();
  const existing = store.storeMediaBuffer('s', Buffer.from('existing-data'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-EXISTING',
  });
  const existingMeta = readMeta(dir, existing.media_id);
  const filesBefore = listMediaFiles(dir).length;
  const indexBefore = store.mediaIndex.size;

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function failing() {
    const err = new Error('no space left on device');
    err.code = 'ENOSPC';
    throw err;
  };
  let result;
  try {
    result = store.storeMediaBuffer('s', Buffer.from('cannot-persist'), {
      mimeType: 'text/plain',
      waMessageId: 'WA-NOSPACE',
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  eq(result, null, 'write failure returns null (never a false success)');
  eq(listMediaFiles(dir).length, filesBefore, 'failed write leaves no new file');
  eq(store.mediaIndex.size, indexBefore, 'failed write creates no index entry');
  ok(fs.existsSync(existingMeta.filePath), 'existing media file is untouched');
  eq(fs.readFileSync(existingMeta.filePath, 'utf8'), 'existing-data', 'existing bytes unchanged');

  // Sidecar failure after a successful file write must roll the new file back.
  fs.writeFileSync = function failingSidecar(target, ...rest) {
    if (String(target).endsWith('.meta.json')) {
      const err = new Error('no space left on device');
      err.code = 'ENOSPC';
      throw err;
    }
    return originalWriteFileSync.call(fs, target, ...rest);
  };
  let sidecarResult;
  try {
    sidecarResult = store.storeMediaBuffer('s', Buffer.from('orphan-candidate'), {
      mimeType: 'text/plain',
      waMessageId: 'WA-SIDECAR-FAIL',
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  eq(sidecarResult, null, 'sidecar failure returns null');
  eq(listMediaFiles(dir).length, filesBefore, 'file written before the sidecar failure is rolled back');
  eq(store.mediaIndex.size, indexBefore, 'no index entry after sidecar failure');
  ok(fs.existsSync(existingMeta.filePath), 'existing media survives a failed sidecar write');
}

// ---------------------------------------------------------------------------
// 9. Capacity observability is read-only
// ---------------------------------------------------------------------------
{
  const { dir, store } = makeStore({ MEDIA_INDEX_MAX: 2 });
  const stored = store.storeMediaBuffer('s', Buffer.from('cap'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-CAP',
  });
  const meta = readMeta(dir, stored.media_id);
  const summary = await store.mediaCapacitySummary();
  eq(summary.files, 1, 'capacity counts media files');
  eq(summary.sidecars, 1, 'capacity counts sidecars');
  eq(summary.bytes, 3, 'capacity sums media bytes');
  eq(summary.index_entries, 1, 'capacity reports RAM index size');
  eq(summary.index_max, 2, 'capacity reports the configured index bound');
  ok(typeof summary.free_bytes === 'number', 'free disk bytes are reported');
  ok(typeof summary.total_bytes === 'number', 'total disk bytes are reported');
  ok(fs.existsSync(meta.filePath), 'capacity summary deletes nothing');

  const originalStatfs = fs.promises.statfs;
  fs.promises.statfs = async () => {
    throw new Error('statfs unsupported');
  };
  let degraded;
  try {
    degraded = await store.mediaCapacitySummary();
  } finally {
    fs.promises.statfs = originalStatfs;
  }
  eq(degraded.free_bytes, null, 'statfs failure degrades to null free bytes');
  eq(degraded.total_bytes, null, 'statfs failure degrades to null total bytes');
  eq(degraded.files, 1, 'counts remain available when statfs fails');
  ok(fs.existsSync(meta.filePath), 'degraded capacity summary still deletes nothing');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await sleep(0);
for (const dir of tempDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(`[test-media-store-543] ${assertions} assertions passed`);
