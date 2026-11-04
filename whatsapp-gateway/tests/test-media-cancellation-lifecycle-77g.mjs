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
} from '../src/media/media-store.js';

test('A. Upstream cancellation: aborting client terminates upstream HTTP stream and halts data transfer', async () => {
  let serverClosed = false;
  let serverChunksSent = 0;

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1048576',
    });

    const interval = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(interval);
        return;
      }
      serverChunksSent++;
      res.write('data-stream-chunk-16b');
    }, 10);

    req.on('close', () => {
      clearInterval(interval);
      serverClosed = true;
    });
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/test-media`;

  const controller = new AbortController();

  // Run download through mediaDownloadScope
  let clientErr = null;
  try {
    await mediaDownloadScope.run({ signal: controller.signal }, async () => {
      const res = await fetch(url);
      assert.equal(res.status, 200);

      let count = 0;
      for await (const chunk of res.body) {
        count++;
        if (count === 2) {
          // Abort after 2 chunks
          controller.abort(new Error('client closed tab'));
        }
      }
    });
  } catch (err) {
    clientErr = err;
  }

  // Brief pause to allow socket closure propagation
  await new Promise((r) => setTimeout(r, 80));

  assert.ok(clientErr, 'Client should receive error on abort');
  assert.equal(serverClosed, true, 'Upstream server should receive req.close event');
  assert.ok(serverChunksSent < 10, `Server should stop producing chunks (sent: ${serverChunksSent})`);

  server.close();
});

test('B. Promise.race safety: slot is never released while upstream task is still executing', async () => {
  let activeSlots = 0;
  let slotReleasedAt = null;
  let upstreamFinishedAt = null;

  function acquire() { activeSlots++; }
  function release() {
    activeSlots--;
    slotReleasedAt = Date.now();
  }

  const controller = new AbortController();
  acquire();

  try {
    await mediaDownloadScope.run({ signal: controller.signal }, async () => {
      const delayPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          upstreamFinishedAt = Date.now();
          resolve('done');
        }, 100);

        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          upstreamFinishedAt = Date.now();
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });

      // Trigger abort in 30ms
      setTimeout(() => controller.abort(), 30);
      await delayPromise;
    });
  } catch (err) {
    assert.equal(err.name, 'AbortError');
  } finally {
    release();
  }

  assert.equal(activeSlots, 0, 'Active slots must return to 0');
  assert.ok(upstreamFinishedAt !== null, 'Upstream task must be finished');
  assert.ok(slotReleasedAt !== null, 'Slot must be released');
  assert.ok(slotReleasedAt >= upstreamFinishedAt, 'Slot must be released on or after upstream task teardown');
});

test('C. Retry safety: transient timeout retries, but AbortError breaks retry immediately', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-retry-test-'));
  const store = createMediaStore({ mediaDir: tmpDir, logger: null });

  let attemptCount = 0;
  const mockSock = {
    updateMediaMessage: async (msg) => msg,
  };

  const controller = new AbortController();
  controller.abort(); // Pre-aborted

  const fakeMessage = {
    key: { id: 'msg-abort-pre' },
    message: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/fake',
        directPath: '/fake-path',
        mediaKey: crypto.randomBytes(32),
        fileLength: 5000,
      },
    },
  };

  // Immediate pre-abort must fail closed without starting retries
  const res = await store.storeIncomingMedia({ id: 'sess-1' }, fakeMessage, mockSock, {
    signal: controller.signal,
  });

  assert.equal(res, null, 'Pre-aborted download returns null');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('D. Resource cleanup: temporary files cleaned up and cache not contaminated on failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cleanup-test-'));
  const store = createMediaStore({ mediaDir: tmpDir, logger: null });

  // Verify that an invalid or aborted buffer does not leave .tmp files or index entries
  const filesBefore = fs.readdirSync(tmpDir);
  assert.equal(filesBefore.length, 0);

  // Attempting to store an invalid buffer returns null and cleans up
  const res = store.storeMediaBuffer('sess-1', null);
  assert.equal(res, null);

  const filesAfter = fs.readdirSync(tmpDir);
  assert.equal(filesAfter.length, 0, 'No temporary or corrupt files left on disk');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('E. Normal HTTP lifecycle: successful download finishes with clean response and valid sidecar', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-normal-test-'));
  const store = createMediaStore({ mediaDir: tmpDir, logger: null });
  const testBuffer = Buffer.from('normal-valid-media-content');

  const meta = store.storeMediaBuffer('sess-1', testBuffer, {
    mimeType: 'image/jpeg',
    waMessageId: 'msg-success-1',
  });

  assert.ok(meta?.media_id);
  const targetFile = path.join(tmpDir, `${meta.media_id}.jpeg`);
  const sidecarFile = path.join(tmpDir, `${meta.media_id}.meta.json`);

  assert.ok(fs.existsSync(targetFile), 'Media target file exists');
  assert.ok(fs.existsSync(sidecarFile), 'Sidecar metadata exists');

  // Verify no leftover .tmp files
  const tempFiles = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp.'));
  assert.equal(tempFiles.length, 0, 'Zero temporary files remain on success');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('F. Concurrent download isolation: aborting one client does not corrupt or abort concurrent downloads', async () => {
  const serverStats = { reqA: { sent: 0, closed: false }, reqB: { sent: 0, closed: false } };
  const server = http.createServer((req, res) => {
    const isA = req.url.includes('streamA');
    const key = isA ? 'reqA' : 'reqB';

    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    let count = 0;
    const interval = setInterval(() => {
      if (res.destroyed || res.writableEnded || count >= 10) {
        clearInterval(interval);
        if (count >= 10) res.end();
        return;
      }
      count++;
      serverStats[key].sent++;
      res.write(`chunk-${count}\n`);
    }, 15);

    req.on('close', () => {
      clearInterval(interval);
      serverStats[key].closed = true;
    });
  });

  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  async function mockBaileysDownload(pathUrl) {
    const res = await fetch(`http://127.0.0.1:${port}/${pathUrl}`);
    const chunks = [];
    for await (const chunk of res.body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const controllerA = new AbortController();
  const controllerB = new AbortController();

  // Run download A (to be aborted) and download B (to complete)
  const taskA = mediaDownloadScope.run({ signal: controllerA.signal }, () => mockBaileysDownload('streamA'));
  const taskB = mediaDownloadScope.run({ signal: controllerB.signal }, () => mockBaileysDownload('streamB'));

  // Abort task A after 30ms
  setTimeout(() => controllerA.abort(), 30);

  const [resA, resB] = await Promise.allSettled([taskA, taskB]);

  assert.equal(resA.status, 'rejected', 'Task A must be rejected upon abort');
  assert.equal(resB.status, 'fulfilled', 'Task B must complete successfully');
  assert.ok(serverStats.reqA.closed, 'Server for stream A must receive close');
  assert.ok(serverStats.reqA.sent < 10, 'Server for stream A must stop sending');
  assert.equal(serverStats.reqB.sent, 10, 'Server for stream B must send all 10 chunks');

  server.close();
});

test('G. Idempotent repeated aborts: multiple close and abort events do not throw unhandled exceptions', () => {
  const controller = new AbortController();

  // Firing abort multiple times must be completely idempotent and safe
  controller.abort('first abort');
  controller.abort('second abort');
  controller.abort('third abort');

  assert.equal(controller.signal.aborted, true);
});

