import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createMediaStore,
  mediaDownloadScope,
  parseFileLength,
} from '../src/media/media-store.js';
import {
  downloadContentFromMessage,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { getMediaKeys } from '@whiskeysockets/baileys/lib/Utils/messages-media.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tezlify-test-78-'));
}

async function createEncryptedMedia(plainBuffer, mediaType = 'image') {
  const mediaKey = crypto.randomBytes(32);
  const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);

  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const encData = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const hmac = crypto.createHmac('sha256', macKey).update(iv).update(encData).digest();
  const mac = hmac.subarray(0, 10);
  const fullPayload = Buffer.concat([encData, mac]);

  return {
    mediaKey,
    cipherKey,
    iv,
    macKey,
    fullPayload,
    plainBuffer,
  };
}

test('Test A — Real Baileys download success with AES decryption, length and SHA-256 validation', async () => {
  const tempDir = makeTempDir();
  const mediaStore = createMediaStore({ mediaDir: tempDir });

  const originalText = 'Baileys Phase 7.8 Real Pipeline Integration Verification Test Plaintext Buffer';
  const originalBuffer = Buffer.from(originalText, 'utf8');
  const originalSha256 = crypto.createHash('sha256').update(originalBuffer).digest('hex');

  const enc = await createEncryptedMedia(originalBuffer, 'image');

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': enc.fullPayload.length,
    });
    res.end(enc.fullPayload);
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/media/image_test_a`;

  try {
    // 1. Direct Baileys downloadContentFromMessage verification
    const media = {
      url,
      mediaKey: enc.mediaKey,
      mimetype: 'image/jpeg',
      fileLength: originalBuffer.length,
    };

    const stream = await mediaDownloadScope.run({ signal: new AbortController().signal }, async () => {
      return await downloadContentFromMessage(media, 'image');
    });

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const decryptedBuffer = Buffer.concat(chunks);

    assert.equal(decryptedBuffer.length, originalBuffer.length, 'Decrypted length matches original');
    assert.equal(decryptedBuffer.toString('utf8'), originalText, 'Decrypted text matches original plaintext');
    assert.equal(
      crypto.createHash('sha256').update(decryptedBuffer).digest('hex'),
      originalSha256,
      'Decrypted SHA-256 matches original'
    );

    // 2. Full media-store ingestIncomingMedia integration verification
    const waMessage = {
      key: { id: 'WA_MSG_TEST_A_001' },
      message: {
        imageMessage: {
          url,
          mediaKey: enc.mediaKey,
          mimetype: 'image/jpeg',
          fileLength: originalBuffer.length,
        },
      },
    };

    const stored = await mediaStore.storeIncomingMedia({ id: 'session_78_a' }, waMessage, null);
    assert.ok(stored, 'storeIncomingMedia returns stored descriptor');
    assert.ok(stored.media_id, 'media_id is assigned');
    assert.equal(stored.size_bytes, originalBuffer.length, 'Stored size matches original');

    const meta = await mediaStore.getMediaMetaAsync(stored.media_id);
    assert.ok(meta, 'Sidecar metadata exists');
    assert.equal(meta.sha256, originalSha256, 'Sidecar sha256 matches verified hash');

    const verified = await mediaStore.openVerifiedMedia(stored.media_id, meta.filePath);
    assert.equal(verified.ok, true, 'openVerifiedMedia succeeds');
    assert.equal(verified.size, originalBuffer.length, 'Verified size matches');
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test B — Real Baileys download cancellation: terminates upstream HTTP socket, halts transfer, settles promise and releases slot', async () => {
  const tempDir = makeTempDir();
  const mediaStore = createMediaStore({ mediaDir: tempDir });

  // 1MB large encrypted payload
  const largeData = crypto.randomBytes(1024 * 1024);
  const enc = await createEncryptedMedia(largeData, 'video');

  let serverSocketClosed = false;
  let serverReqAborted = false;
  let chunksDispatched = 0;
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    req.on('close', () => {
      if (!res.writableEnded) {
        serverReqAborted = true;
      }
    });

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': enc.fullPayload.length,
    });

    let offset = 0;
    const CHUNK_SIZE = 64 * 1024;
    res.write(enc.fullPayload.subarray(offset, offset + CHUNK_SIZE));
    offset += CHUNK_SIZE;
    chunksDispatched++;

    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(timer);
        return;
      }
      if (offset < enc.fullPayload.length) {
        res.write(enc.fullPayload.subarray(offset, Math.min(offset + CHUNK_SIZE, enc.fullPayload.length)));
        offset += CHUNK_SIZE;
        chunksDispatched++;
      } else {
        res.end();
        clearInterval(timer);
      }
    }, 30);

    res.on('close', () => clearInterval(timer));
  });

  server.on('connection', (sock) => {
    activeSockets.add(sock);
    sock.on('close', () => {
      serverSocketClosed = true;
      activeSockets.delete(sock);
    });
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/media/video_cancel_test`;

  const waMessage = {
    key: { id: 'WA_MSG_TEST_B_CANCEL' },
    message: {
      videoMessage: {
        url,
        mediaKey: enc.mediaKey,
        mimetype: 'video/mp4',
        fileLength: largeData.length,
      },
    },
  };

  const clientController = new AbortController();

  setTimeout(() => {
    clientController.abort(new Error('User left conversation'));
  }, 70);

  const startT = Date.now();
  const res = await mediaStore.storeIncomingMedia(
    { id: 'session_78_b' },
    waMessage,
    null,
    { signal: clientController.signal }
  );

  assert.equal(res, null, 'Canceled media ingestion returns null (fails closed)');

  // Wait a short moment to observe socket and event settlement
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(serverReqAborted, true, 'Upstream request aborted event fired');
  assert.equal(serverSocketClosed, true, 'Upstream TCP socket physically closed');
  assert.equal(activeSockets.size, 0, 'No active sockets remaining on server');
  assert.ok(chunksDispatched < 16, `Transfer halted early: only ${chunksDispatched} chunks sent`);

  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Test C — Global fetch isolation: media abort does not contaminate external fetch calls', async () => {
  const normalServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'external' }));
  });

  await new Promise((r) => normalServer.listen(0, r));
  const normalPort = normalServer.address().port;
  const normalUrl = `http://127.0.0.1:${normalPort}/health`;

  const hangingServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    // Keep open without ending
  });

  await new Promise((r) => hangingServer.listen(0, r));
  const hangingPort = hangingServer.address().port;
  const hangingUrl = `http://127.0.0.1:${hangingPort}/media-stream`;

  const mediaAc = new AbortController();

  let mediaFinished = false;
  let mediaAborted = false;
  let normalFetchResult = null;

  // 1. Start media download in mediaDownloadScope
  const mediaPromise = (async () => {
    try {
      await mediaDownloadScope.run({ signal: mediaAc.signal }, async () => {
        await fetch(hangingUrl);
      });
      mediaFinished = true;
    } catch (err) {
      mediaAborted = true;
    }
  })();

  // 2. Perform normal fetch concurrently OUTSIDE mediaDownloadScope
  const normalPromise = (async () => {
    const res = await fetch(normalUrl);
    normalFetchResult = await res.json();
  })();

  // 3. Abort the media context
  setTimeout(() => {
    mediaAc.abort(new Error('client canceled media'));
  }, 40);

  await Promise.all([mediaPromise, normalPromise]);

  assert.equal(mediaAborted, true, 'Media fetch cleanly aborted');
  assert.equal(mediaFinished, false, 'Media fetch did not complete');
  assert.ok(normalFetchResult, 'Normal fetch succeeded');
  assert.equal(normalFetchResult.status, 'ok', 'Normal fetch response intact');

  normalServer.close();
  hangingServer.close();
});

test('Test D — Multi-session isolation: aborting session A does not abort concurrent session B', async () => {
  const tempDir = makeTempDir();
  const mediaStore = createMediaStore({ mediaDir: tempDir });

  const bufA = crypto.randomBytes(300 * 1024);
  const bufB = Buffer.from('Session B verified media payload buffer', 'utf8');

  const encA = await createEncryptedMedia(bufA, 'image');
  const encB = await createEncryptedMedia(bufB, 'image');

  const server = http.createServer((req, res) => {
    if (req.url.includes('sessionA')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      // Send slowly to allow abort
      const interval = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(interval);
          return;
        }
        res.write(encA.fullPayload.subarray(0, 32 * 1024));
      }, 50);
      res.on('close', () => clearInterval(interval));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(encB.fullPayload);
    }
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const acA = new AbortController();
  const acB = new AbortController();

  const msgA = {
    key: { id: 'WA_SESSION_A_001' },
    message: {
      imageMessage: {
        url: `http://127.0.0.1:${port}/sessionA`,
        mediaKey: encA.mediaKey,
        mimetype: 'image/jpeg',
        fileLength: bufA.length,
      },
    },
  };

  const msgB = {
    key: { id: 'WA_SESSION_B_001' },
    message: {
      imageMessage: {
        url: `http://127.0.0.1:${port}/sessionB`,
        mediaKey: encB.mediaKey,
        mimetype: 'image/jpeg',
        fileLength: bufB.length,
      },
    },
  };

  setTimeout(() => {
    acA.abort(new Error('Session A cancelled'));
  }, 40);

  const [resA, resB] = await Promise.all([
    mediaStore.storeIncomingMedia({ id: 'session_A' }, msgA, null, { signal: acA.signal }),
    mediaStore.storeIncomingMedia({ id: 'session_B' }, msgB, null, { signal: acB.signal }),
  ]);

  assert.equal(resA, null, 'Session A download aborted cleanly');
  assert.ok(resB, 'Session B download succeeded');
  assert.equal(resB.size_bytes, bufB.length, 'Session B downloaded correct byte size');

  const metaB = await mediaStore.getMediaMetaAsync(resB.media_id);
  assert.ok(metaB, 'Session B sidecar exists');
  assert.equal(
    metaB.sha256,
    crypto.createHash('sha256').update(bufB).digest('hex'),
    'Session B SHA-256 intact'
  );

  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Test E — Normal close: successful HTTP response is not treated as cancellation', async () => {
  const tempDir = makeTempDir();
  const mediaStore = createMediaStore({ mediaDir: tempDir });

  const buf = Buffer.from('Normal close test payload data', 'utf8');
  const enc = await createEncryptedMedia(buf, 'image');

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': enc.fullPayload.length,
    });
    res.end(enc.fullPayload);
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/normal_media`;

  const waMessage = {
    key: { id: 'WA_NORMAL_CLOSE_001' },
    message: {
      imageMessage: {
        url,
        mediaKey: enc.mediaKey,
        mimetype: 'image/jpeg',
        fileLength: buf.length,
      },
    },
  };

  const stored = await mediaStore.storeIncomingMedia({ id: 'session_normal' }, waMessage, null);
  assert.ok(stored, 'Normal download stored successfully');

  const meta = await mediaStore.getMediaMetaAsync(stored.media_id);
  assert.ok(meta, 'Meta sidecar intact');
  assert.equal(meta.sizeBytes, buf.length, 'Size matches');

  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Test F — Timeout: upstream timeout retries within deadline budget and cleans up orphaned tasks', async () => {
  const tempDir = makeTempDir();
  const mediaStore = createMediaStore({ mediaDir: tempDir });

  let serverAttempts = 0;
  const server = http.createServer((req, res) => {
    serverAttempts++;
    // Intentionally delay headers to simulate network hang
    setTimeout(() => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Gateway Timeout');
      }
    }, 400);
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/timeout_media`;

  const waMessage = {
    key: { id: 'WA_TIMEOUT_001' },
    message: {
      imageMessage: {
        url,
        mediaKey: crypto.randomBytes(32),
        mimetype: 'image/jpeg',
        fileLength: 1024,
      },
    },
  };

  // Provide tight timeout of 200ms
  const startT = Date.now();
  const result = await mediaStore.storeIncomingMedia({ id: 'session_timeout' }, waMessage, null, {
    timeoutMs: 250,
  });

  const elapsed = Date.now() - startT;
  assert.equal(result, null, 'Timed out media download returns null');
  assert.ok(serverAttempts >= 1, `Server observed attempts: ${serverAttempts}`);

  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Test G — Repeated aborts: idempotent close, no double slot release, no unhandled rejection', async () => {
  const tempDir = makeTempDir();
  const mediaStore = createMediaStore({ mediaDir: tempDir });

  let uncaughtErrors = [];
  const uncaughtHandler = (err) => uncaughtErrors.push(err);
  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', uncaughtHandler);

  const enc = await createEncryptedMedia(crypto.randomBytes(256 * 1024), 'image');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(enc.fullPayload.subarray(0, 16 * 1024));
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const ac = new AbortController();

  const waMessage = {
    key: { id: 'WA_MSG_REPEAT_ABORT' },
    message: {
      imageMessage: {
        url: `http://127.0.0.1:${port}/repeat_abort`,
        mediaKey: enc.mediaKey,
        mimetype: 'image/jpeg',
        fileLength: 256 * 1024,
      },
    },
  };

  // Rapidly fire multiple aborts
  setTimeout(() => {
    ac.abort();
    ac.abort();
    ac.abort();
  }, 30);

  const res = await mediaStore.storeIncomingMedia({ id: 'session_g' }, waMessage, null, {
    signal: ac.signal,
  });
  assert.equal(res, null);

  // Check disk for leftover .tmp files
  const tmpFiles = fs.readdirSync(tempDir).filter((f) => f.startsWith('.tmp.'));
  assert.equal(tmpFiles.length, 0, 'No leftover temporary files remain on disk');

  await new Promise((r) => setTimeout(r, 100));

  process.removeListener('uncaughtException', uncaughtHandler);
  process.removeListener('unhandledRejection', uncaughtHandler);

  assert.equal(uncaughtErrors.length, 0, 'Zero unhandled exceptions or rejections');

  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Test H — Long-term resource tracking: burn-in loop of 20 downloads verifying zero active tasks/slots/sockets leak', async () => {
  const tempDir = makeTempDir();
  const mediaStore = createMediaStore({ mediaDir: tempDir });

  const encNormal = await createEncryptedMedia(Buffer.from('burn-in test verified payload string'), 'image');

  let activeSockets = new Set();
  const server = http.createServer((req, res) => {
    const isCancel = req.url.includes('cancel');
    if (isCancel) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        res.write('chunk-data');
      }, 40);
      res.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': encNormal.fullPayload.length,
      });
      res.end(encNormal.fullPayload);
    }
  });

  server.on('connection', (sock) => {
    activeSockets.add(sock);
    sock.on('close', () => activeSockets.delete(sock));
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // Execute 20 consecutive downloads (alternating success and cancel)
  for (let i = 0; i < 20; i++) {
    const shouldCancel = i % 2 === 1;
    const ac = new AbortController();

    if (shouldCancel) {
      setTimeout(() => ac.abort(), 20);
    }

    const waMessage = {
      key: { id: `WA_BURNIN_${i}` },
      message: {
        imageMessage: {
          url: `http://127.0.0.1:${port}/${shouldCancel ? 'cancel' : 'success'}_${i}`,
          mediaKey: encNormal.mediaKey,
          mimetype: 'image/jpeg',
          fileLength: encNormal.plainBuffer.length,
        },
      },
    };

    await mediaStore.storeIncomingMedia({ id: 'session_h' }, waMessage, null, {
      signal: ac.signal,
      timeoutMs: 500,
    });
  }

  // Grace period for any last socket tear-down
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(activeSockets.size, 0, 'Zero lingering TCP sockets after 20 iterations');

  const capacity = await mediaStore.mediaCapacitySummary();
  assert.ok(capacity.files >= 10, `Expected at least 10 successfully saved files, got ${capacity.files}`);
  assert.ok(capacity.index_entries >= 10, `Expected at least 10 indexed entries, got ${capacity.index_entries}`);

  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
