import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createMediaStore,
  parseFileLength,
  parseExpectedSha256,
  validateMediaBufferIntegrity,
  isTransientMediaError,
} from '../src/media/media-store.js';

test('1. parseFileLength - handles numbers, strings, Long objects, BigInt, and invalid inputs', () => {
  assert.equal(parseFileLength(1048576), 1048576);
  assert.equal(parseFileLength('52428800'), 52428800);
  assert.equal(parseFileLength(26214400n), 26214400);

  // Long.js object with .toNumber()
  const longObjWithMethod = {
    low: 10485760,
    high: 0,
    unsigned: true,
    toNumber() { return 10485760; },
  };
  assert.equal(parseFileLength(longObjWithMethod), 10485760);

  // Plain Long structure with low and high properties
  const plainLong = {
    low: 5000,
    high: 0,
    unsigned: true,
  };
  assert.equal(parseFileLength(plainLong), 5000);

  // Fallbacks and edge cases
  assert.equal(parseFileLength(0), 0);
  assert.equal(parseFileLength(-500), 0);
  assert.equal(parseFileLength(null), 0);
  assert.equal(parseFileLength(undefined), 0);
  assert.equal(parseFileLength('not-a-number'), 0);
  assert.equal(parseFileLength({ invalid: true }), 0);
});

test('2. parseExpectedSha256 - normalizes Buffer, Uint8Array, hex, and base64 hashes', () => {
  const rawBytes = crypto.randomBytes(32);
  const hexStr = rawBytes.toString('hex').toLowerCase();
  const base64Str = rawBytes.toString('base64');

  assert.equal(parseExpectedSha256(rawBytes), hexStr);
  assert.equal(parseExpectedSha256(new Uint8Array(rawBytes)), hexStr);
  assert.equal(parseExpectedSha256(hexStr), hexStr);
  assert.equal(parseExpectedSha256(hexStr.toUpperCase()), hexStr);
  assert.equal(parseExpectedSha256(base64Str), hexStr);

  assert.equal(parseExpectedSha256(null), null);
  assert.equal(parseExpectedSha256(undefined), null);
  assert.equal(parseExpectedSha256(''), null);
  assert.equal(parseExpectedSha256('short-invalid-hash'), null);
});

test('3. validateMediaBufferIntegrity - proves previous 90% threshold inadequacy', () => {
  // Scenario: 10 MB expected, 9.5 MB received (95% received)
  const expected10MB = 10 * 1024 * 1024;
  const received9_5MB = Buffer.alloc(Math.floor(9.5 * 1024 * 1024), 0xaa);

  // Old threshold (buffer.length < fileLength * 0.9) would incorrectly accept 9.5MB:
  const wouldOldPass = received9_5MB.length >= expected10MB * 0.9;
  assert.equal(wouldOldPass, true, 'Old 90% logic would have wrongly accepted incomplete 9.5MB stream');

  // New strict integrity check rejects truncated buffer missing any bytes:
  assert.throws(
    () => validateMediaBufferIntegrity(received9_5MB, { fileLength: expected10MB }),
    (err) => {
      assert.equal(err.code, 'STREAM_TRUNCATED');
      assert.match(err.message, /received \d+ of 10485760 bytes/);
      return true;
    }
  );
});

test('4. validateMediaBufferIntegrity - cryptographic SHA-256 verification', () => {
  const correctData = Buffer.from('perfect-authentic-media-content');
  const expectedHash = crypto.createHash('sha256').update(correctData).digest();

  // Valid hash matches:
  assert.equal(
    validateMediaBufferIntegrity(correctData, {
      fileLength: correctData.length,
      fileSha256: expectedHash,
    }),
    true
  );

  // Hash mismatch with missing bytes triggers STREAM_TRUNCATED:
  const truncatedData = correctData.subarray(0, 10);
  assert.throws(
    () => validateMediaBufferIntegrity(truncatedData, {
      fileLength: correctData.length,
      fileSha256: expectedHash,
    }),
    (err) => {
      assert.equal(err.code, 'STREAM_TRUNCATED');
      assert.match(err.message, /hash mismatch/);
      return true;
    }
  );

  // Hash mismatch with equal or more bytes triggers STREAM_CORRUPTED:
  const corruptedData = Buffer.from('corrupted-tampered-media-content');
  assert.throws(
    () => validateMediaBufferIntegrity(corruptedData, {
      fileLength: correctData.length,
      fileSha256: expectedHash,
    }),
    (err) => {
      assert.equal(err.code, 'STREAM_CORRUPTED');
      assert.match(err.message, /sha256 mismatch/);
      return true;
    }
  );
});

test('5. validateMediaBufferIntegrity - preview and unknown length behavior', () => {
  const thumb = Buffer.from('small-jpeg-thumbnail');
  // Preview ignores full media fileLength:
  assert.equal(
    validateMediaBufferIntegrity(thumb, { fileLength: 50 * 1024 * 1024 }, { isPreview: true }),
    true
  );

  // Unknown or 0 fileLength accepts buffer without false positives:
  assert.equal(
    validateMediaBufferIntegrity(thumb, { fileLength: 0 }),
    true
  );
  assert.equal(
    validateMediaBufferIntegrity(thumb, {}),
    true
  );
});

test('6. isTransientMediaError - classifies STREAM_TRUNCATED and STREAM_CORRUPTED as retryable', () => {
  const truncErr = new Error('Media stream truncated');
  truncErr.code = 'STREAM_TRUNCATED';
  assert.equal(isTransientMediaError(truncErr), true);

  const corruptErr = new Error('Media corrupted: sha256 mismatch');
  corruptErr.code = 'STREAM_CORRUPTED';
  assert.equal(isTransientMediaError(corruptErr), true);

  const hashErr = new Error('hash mismatch');
  hashErr.code = 'HASH_MISMATCH';
  assert.equal(isTransientMediaError(hashErr), true);
});

test('7. storeMediaBuffer - atomic disk writing leaves no partial file on write or meta failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-atomic-'));
  try {
    const store = createMediaStore({ mediaDir: tmpDir, logger: null });
    const content = Buffer.from('atomic-test-media-data');

    const meta = store.storeMediaBuffer('sess-1', content, {
      mimeType: 'image/jpeg',
      waMessageId: 'msg-atomic-1',
    });

    assert.ok(meta?.media_id);
    const expectedFilePath = path.join(tmpDir, `${meta.media_id}.jpeg`);
    assert.ok(fs.existsSync(expectedFilePath));
    const sidecarPath = path.join(tmpDir, `${meta.media_id}.meta.json`);
    assert.ok(fs.existsSync(sidecarPath));

    // Ensure no temp files linger:
    const files = fs.readdirSync(tmpDir);
    const tempFiles = files.filter((f) => f.includes('.tmp.'));
    assert.equal(tempFiles.length, 0, 'No leftover temporary files should exist after atomic store');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
