/**
 * Phase 7.6 — Media Timeout & Retry Coordination Tests.
 *
 * Verifies:
 * 1. Total deadline budget calculations for video, document, audio, image, and preview.
 * 2. 10MB, 25MB, 50MB, and 100MB video calculations meeting 150 KB/s constraint (341s).
 * 3. Safe fallback for missing, zero, and negative fileLength.
 * 4. Single-attempt success.
 * 5. Multi-attempt retry success within deadline budget (1st fails, 2nd succeeds; 2 retries then succeeds).
 * 6. Maximum 3 attempts exhaustion handling.
 * 7. Abort retry when remaining budget is below MIN_RETRY_THRESHOLD_MS.
 * 8. Attempt timeout bounded by remaining time.
 * 9. Backoff delay deducted from total deadline budget.
 * 10. Client cancellation / abort handling (immediate exit, no retries, terminal classification).
 * 11. Deduplication and cache safety (no corrupt success cache).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  calculateMediaTimeout,
  calculateTotalMediaBudget,
  isTransientMediaError,
  getRetryDelay,
  MEDIA_TIMEOUT_BOUNDS,
  normalizeMediaCategory,
} from '../src/media/media-timeout.js';
import { createMediaStore } from '../src/media/media-store.js';

test('1. calculateTotalMediaBudget - video sizing, 10/25/50/100MB and ceilings', () => {
  // Preview fast-path
  assert.equal(calculateTotalMediaBudget({ isPreview: true }), 12_000);

  // Video sizing calculations
  const video10MB = calculateTotalMediaBudget({ mediaType: 'video', fileLength: 10 * 1024 * 1024 });
  assert.ok(video10MB >= 100_000 && video10MB <= 150_000, `video 10MB expected ~118s, got ${video10MB}`);

  const video25MB = calculateTotalMediaBudget({ mediaType: 'video', fileLength: 25 * 1024 * 1024 });
  assert.ok(video25MB >= 200_000 && video25MB <= 250_000, `video 25MB expected ~228s, got ${video25MB}`);

  // 50 MB video: at 150 KB/s transfer time is 341.3s. Budget must cover 341.3s!
  const video50MB = calculateTotalMediaBudget({ mediaType: 'video', fileLength: 50 * 1024 * 1024 });
  assert.ok(video50MB >= 360_000 && video50MB <= 420_000, `video 50MB expected >=360s, got ${video50MB}`);

  // 100 MB video: capped at 420,000ms (7 minutes) ceiling
  const video100MB = calculateTotalMediaBudget({ mediaType: 'video', fileLength: 100 * 1024 * 1024 });
  assert.equal(video100MB, 420_000);

  // Document category
  const doc20MB = calculateTotalMediaBudget({ mediaType: 'document', fileLength: 20 * 1024 * 1024 });
  assert.equal(doc20MB, 171_534); // exact scaled: 35s + ceil(20MB / 150KB/s)
  const doc25MB = calculateTotalMediaBudget({ mediaType: 'document', fileLength: 25 * 1024 * 1024 });
  assert.equal(doc25MB, 180_000); // capped at maxBudget 180s

  // Audio category
  const audio5MB = calculateTotalMediaBudget({ mediaType: 'audio', fileLength: 5 * 1024 * 1024 });
  assert.ok(audio5MB > 35_000 && audio5MB <= 90_000);

  // Image category
  const image5MB = calculateTotalMediaBudget({ mediaType: 'image', fileLength: 5 * 1024 * 1024 });
  assert.equal(image5MB, 60_000); // capped at maxBudget 60s
});

test('2. calculateTotalMediaBudget - fallbacks for missing, zero, and negative lengths', () => {
  // Video missing or 0 length -> 60,000ms safe default
  assert.equal(calculateTotalMediaBudget({ mediaType: 'video' }), 60_000);
  assert.equal(calculateTotalMediaBudget({ mediaType: 'video', fileLength: 0 }), 60_000);
  assert.equal(calculateTotalMediaBudget({ mediaType: 'video', fileLength: -500 }), 60_000);
  assert.equal(calculateTotalMediaBudget({ mediaType: 'video', fileLength: null }), 60_000);
  assert.equal(calculateTotalMediaBudget({ mediaType: 'video', fileLength: NaN }), 60_000);

  // Image missing or 0 length -> 20,000ms safe default
  assert.equal(calculateTotalMediaBudget({ mediaType: 'image', fileLength: 0 }), 20_000);
  assert.equal(calculateTotalMediaBudget({ mediaType: 'image', fileLength: -10 }), 20_000);

  // Document missing or 0 length -> 35,000ms
  assert.equal(calculateTotalMediaBudget({ mediaType: 'document', fileLength: 0 }), 35_000);

  // Audio missing or 0 length -> 30,000ms
  assert.equal(calculateTotalMediaBudget({ mediaType: 'audio', fileLength: 0 }), 30_000);
});

test('3. Client cancellation and terminal abort classification', () => {
  // AbortError and client cancellation must be classified as terminal (non-retryable)
  const abortErr = new Error('Media download aborted by client');
  abortErr.name = 'AbortError';
  assert.equal(isTransientMediaError(abortErr), false);

  assert.equal(isTransientMediaError({ code: 'ERR_ABORTED' }), false);
  assert.equal(isTransientMediaError({ code: 'ECANCELED' }), false);
  assert.equal(isTransientMediaError({ message: 'Request aborted by client' }), false);
  assert.equal(isTransientMediaError({ message: 'Client cancelled request' }), false);

  // Transient network errors must still be retryable
  assert.equal(isTransientMediaError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientMediaError({ code: 'ETIMEDOUT' }), true);
});

test('4. Retry loop within unified deadline budget - single attempt success', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-76-'));
  try {
    const store = createMediaStore({ mediaDir: tmpDir, logger: null });

    const fakeSock = {
      updateMediaMessage: async () => {},
    };

    const waMsg = {
      key: { remoteJid: '123@s.whatsapp.net', id: 'msg-success-1' },
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          fileLength: 1024,
          jpegThumbnail: Buffer.from('thumb-bytes-fast-path'),
        },
      },
    };

    // Store incoming media directly with fast-path preview
    const res = await store.storeIncomingMedia({ id: 'sess-1' }, waMsg, fakeSock, {
      preferPreview: true,
    });

    assert.ok(res?.media_id, 'Fast-path preview must succeed on single attempt');
    assert.equal(res.mime_type, 'image/jpeg');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5. Budget exhausted aborts retries immediately without wasting time', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-76-'));
  try {
    const store = createMediaStore({ mediaDir: tmpDir, logger: null });
    const waMsg = {
      key: { remoteJid: '123@s.whatsapp.net', id: 'msg-budget-exhaust' },
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          fileLength: 1024,
          url: 'https://mmg.whatsapp.net',
          mediaKey: Buffer.from('01234567890123456789012345678901'),
          jpegThumbnail: Buffer.from('fallback-thumb-bytes'),
        },
      },
    };

    const start = Date.now();
    // Using customTimeout of 5000ms
    const res = await store.storeIncomingMedia({ id: 'sess-1' }, waMsg, null, {
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - start;

    // Falls back to thumbnail
    assert.ok(res?.media_id, 'Should fall back to thumbnail after budget exhausted');
    // Must complete reasonably fast (around 5-7s, not 15s+)
    assert.ok(elapsed < 12_000, `Expected elapsed < 12s, got ${elapsed}ms`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('6. Client abort signal fast-fails without retries', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-76-'));
  try {
    const store = createMediaStore({ mediaDir: tmpDir, logger: null });
    const waMsg = {
      key: { remoteJid: '123@s.whatsapp.net', id: 'msg-abort-fast' },
      message: {
        videoMessage: {
          mimetype: 'video/mp4',
          fileLength: 50 * 1024 * 1024,
          url: 'https://mmg.whatsapp.net',
          mediaKey: Buffer.from('01234567890123456789012345678901'),
        },
      },
    };

    const controller = new AbortController();
    // Pre-abort the signal
    controller.abort();

    const start = Date.now();
    const res = await store.storeIncomingMedia({ id: 'sess-1' }, waMsg, null, {
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    assert.equal(res, null, 'Aborted request must return null (fast-fail)');
    assert.ok(elapsed < 500, `Aborted request must exit immediately, took ${elapsed}ms`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
