/**
 * AŞAMA 5.4.5 — real HTTP media routes, Express 4 semantics (M-2).
 *
 * The host below mounts the REAL `registerMediaRoutes` handlers and, like
 * Express 4, does NOT await or `.catch()` the promise they return. A rejected
 * handler therefore becomes an unhandledRejection and the request hangs —
 * exactly the production failure mode. The route module must terminate every
 * path by itself.
 *
 * There is no `node_modules` in this worktree, so real Express 4 cannot be
 * installed (and must not be). This host emulates Express 4's documented async
 * behavior; it is NOT reported as a real Express 4 E2E test. The wrapper is
 * additionally unit-tested directly.
 *
 *   node --import ./tests/media-test-register.mjs tests/test-media-routes-545.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createMediaStore } from '../src/media/media-store.js';
import { asyncHandler, registerMediaRoutes } from '../src/media/media-routes.js';
import { requireGatewayToken } from '../src/security/gateway-auth.js';

const SECRET = 'z'.repeat(48);
process.env.WHATSAPP_GATEWAY_SECRET = SECRET;

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

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz545-routes-'));
  tempDirs.push(dir);
  return dir;
}

function readMeta(dir, mediaId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${mediaId}.meta.json`), 'utf8'));
}

function listMediaFiles(dir) {
  return fs.readdirSync(dir).filter((f) => !f.endsWith('.meta.json'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Express-compatible host. `faithful: true` reproduces Express 4: the promise
// returned by an async handler is ignored (no implicit catch).
// ---------------------------------------------------------------------------
function segmentMatch(pattern, actual) {
  if (pattern.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i].startsWith(':')) {
      params[pattern[i].slice(1)] = decodeURIComponent(actual[i]);
    } else if (pattern[i] !== actual[i]) {
      return null;
    }
  }
  return params;
}

function createHost(sessionManager, { faithful = true } = {}) {
  const routes = [];
  const app = {
    get: (pattern, handler) => routes.push({ pattern: pattern.split('/').filter(Boolean), handler }),
  };
  registerMediaRoutes(app, { sessionManager, logger: null });

  const server = http.createServer((req, res) => {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload) => {
      if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
      return res;
    };

    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('__throw_query') === '1') {
      Object.defineProperty(req, 'query', {
        configurable: true,
        get() {
          throw new Error('query getter exploded');
        },
      });
    } else {
      req.query = Object.fromEntries(url.searchParams.entries());
    }
    const parts = url.pathname.split('/').filter(Boolean);

    requireGatewayToken(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: 'Method not allowed' });
      }
      for (const route of routes) {
        const params = segmentMatch(route.pattern, parts);
        if (!params) continue;
        req.params = params;
        if (faithful) {
          // Express 4: returned promise is ignored on purpose.
          route.handler(req, res);
        } else {
          Promise.resolve(route.handler(req, res)).catch(() => {
            if (!res.headersSent) res.status(500).json({ error: 'handler failed' });
            else res.destroy();
          });
        }
        return;
      }
      return res.status(404).json({ error: 'Not found' });
    });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function start(sessionManager) {
  const server = createHost(sessionManager);
  const port = await listen(server);
  return { server, port, close: () => close(server) };
}

async function request(port, pathname, { method = 'GET', token = SECRET, timeoutMs = 3000 } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers,
      signal: controller.signal,
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body, text: body.toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

function makeManager(store, overrides = {}) {
  return {
    getSession: (id) => (id === 'sess-1' ? { id } : null),
    resolveMediaPath: (sessionId, mediaId) => store.resolveMediaPath(sessionId, mediaId),
    downloadMediaOnDemand: async () => null,
    openVerifiedMedia: (mediaId, filePath) => store.openVerifiedMedia(mediaId, filePath),
    ...overrides,
  };
}

// Count explicit open/close calls made by the store (stream autoClose is
// verified separately through `stream.destroyed`).
function trackFds() {
  const state = { opened: 0, closed: 0 };
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  fs.openSync = function trackedOpen(...args) {
    const fd = originalOpen.apply(fs, args);
    state.opened += 1;
    return fd;
  };
  fs.closeSync = function trackedClose(...args) {
    state.closed += 1;
    return originalClose.apply(fs, args);
  };
  return {
    state,
    restore() {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
    },
  };
}

const unhandled = [];
function onUnhandled(reason) {
  unhandled.push(reason);
}
process.on('unhandledRejection', onUnhandled);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const dir = makeDir();
const store = createMediaStore({ mediaDir: dir, logger: null, MEDIA_INDEX_MAX: 50 });
const payload = Buffer.from('ROUTE-545-VERIFIED-BYTES');
const stored = store.storeMediaBuffer('sess-1', payload, {
  mimeType: 'text/plain',
  filename: 'note.txt',
  waMessageId: 'WA-545-1',
});
const storedHash = createHash('sha256').update(payload).digest('hex');

const main = await start(makeManager(store));

// ---------------------------------------------------------------------------
// 1. Invalid MIME + existing media: rejected BEFORE any FD is opened
// ---------------------------------------------------------------------------
{
  const badDir = makeDir();
  const writer = createMediaStore({ mediaDir: badDir, logger: null });
  const target = writer.storeMediaBuffer('sess-bad', Buffer.from('bad-mime-bytes'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-BAD-MIME',
  });
  const meta = readMeta(badDir, target.media_id);
  meta.mimeType = 'text/plain\r\nX-Injected: yes';
  fs.writeFileSync(path.join(badDir, `${target.media_id}.meta.json`), JSON.stringify(meta), 'utf8');

  // Fresh store: RAM must not mask the sidecar on disk.
  const fresh = createMediaStore({ mediaDir: badDir, logger: null, MEDIA_INDEX_MAX: 0 });
  const host = await start(makeManager(fresh));
  const tracker = trackFds();
  try {
    const res = await request(host.port, `/media/${target.media_id}`);
    eq(res.status, 422, 'invalid MIME maps to HTTP 422');
    eq(JSON.parse(res.text).code, 'MEDIA_INVALID_METADATA', 'invalid MIME uses MEDIA_INVALID_METADATA');
    eq(tracker.state.opened, 0, 'invalid MIME is rejected before any FD is opened');
    eq(res.headers.get('x-injected'), null, 'CRLF in metadata is never emitted as a header');
    eq(res.body.includes(Buffer.from('bad-mime-bytes')), false, 'invalid-metadata media is never served');

    const scoped = await request(host.port, `/sessions/sess-1/media/${target.media_id}`);
    eq(scoped.status, 422, 'session-scoped route rejects invalid MIME too');
    eq(tracker.state.opened, 0, 'session route also rejects before opening an FD');
  } finally {
    tracker.restore();
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 2. Invalid MIME path + nonexistent media: 404, no FD
// ---------------------------------------------------------------------------
{
  const tracker = trackFds();
  try {
    const res = await request(main.port, '/media/does-not-exist-545');
    eq(res.status, 404, 'unknown media is 404');
    eq(JSON.parse(res.text).code, 'MEDIA_EXPIRED', 'unknown media uses MEDIA_EXPIRED');
    eq(tracker.state.opened, 0, 'unknown media opens no FD');
  } finally {
    tracker.restore();
  }
}

// ---------------------------------------------------------------------------
// 3. Valid MIME + corrupt sidecar: 422 inside the integrity gate, no FD
// ---------------------------------------------------------------------------
{
  const corruptDir = makeDir();
  const writer = createMediaStore({ mediaDir: corruptDir, logger: null });
  const target = writer.storeMediaBuffer('sess-1', Buffer.from('corrupt-target'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-CORRUPT-545',
  });
  fs.writeFileSync(path.join(corruptDir, `${target.media_id}.meta.json`), '{broken', 'utf8');
  const fresh = createMediaStore({ mediaDir: corruptDir, logger: null, MEDIA_INDEX_MAX: 0 });
  const host = await start(makeManager(fresh));
  const tracker = trackFds();
  try {
    const res = await request(host.port, `/media/${target.media_id}`);
    eq(res.status, 422, 'corrupt sidecar maps to HTTP 422');
    eq(JSON.parse(res.text).code, 'MEDIA_CORRUPTED', 'corrupt sidecar uses MEDIA_CORRUPTED');
    eq(res.body.includes(Buffer.from('corrupt-target')), false, 'corrupt-sidecar bytes are never served');
    eq(tracker.state.opened, 0, 'corrupt metadata is rejected before opening an FD');
  } finally {
    tracker.restore();
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 4. Valid MIME + hash mismatch: 422, FD opened and closed
// ---------------------------------------------------------------------------
{
  const tamperDir = makeDir();
  const writer = createMediaStore({ mediaDir: tamperDir, logger: null });
  const target = writer.storeMediaBuffer('sess-1', Buffer.from('hash-target'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-HASH-545',
  });
  const meta = readMeta(tamperDir, target.media_id);
  fs.writeFileSync(meta.filePath, 'hash-REPLACED');
  const fresh = createMediaStore({ mediaDir: tamperDir, logger: null, MEDIA_INDEX_MAX: 0 });
  const host = await start(makeManager(fresh));
  const tracker = trackFds();
  try {
    const res = await request(host.port, `/media/${target.media_id}`);
    eq(res.status, 422, 'hash mismatch maps to HTTP 422');
    eq(JSON.parse(res.text).code, 'MEDIA_CORRUPTED', 'hash mismatch uses MEDIA_CORRUPTED');
    eq(tracker.state.opened, 1, 'hash verification opened the file');
    eq(tracker.state.closed, 1, 'the FD was closed on the hash-mismatch path');
    eq(res.body.includes(Buffer.from('hash-REPLACED')), false, 'tampered bytes are never served');
  } finally {
    tracker.restore();
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 5. FD opened, then the file is rejected (not a regular file)
// ---------------------------------------------------------------------------
{
  const tracker = trackFds();
  try {
    const result = await store.openVerifiedMedia('dev-null-545', '/dev/null');
    eq(result.ok, false, 'a non-regular file is rejected');
    eq(result.reason, 'MISSING', 'non-regular file reports MISSING');
    eq(tracker.state.opened, 1, 'the FD really was opened');
    eq(tracker.state.closed, 1, 'the FD was closed after the post-open rejection');
  } finally {
    tracker.restore();
  }
}

// ---------------------------------------------------------------------------
// 5b. Header failure after the FD is opened: 500, stream released, no stale headers
// ---------------------------------------------------------------------------
{
  const stream = new Readable({ read() {} });
  const host = await start(makeManager(store, {
    openVerifiedMedia: async () => ({
      ok: true,
      legacy: false,
      size: 3,
      mimeType: 'text/plain',
      filename: null,
      stream,
    }),
  }));
  const originalSetHeader = http.ServerResponse.prototype.setHeader;
  http.ServerResponse.prototype.setHeader = function patchedSetHeader(name, value) {
    if (name === 'X-Media-Integrity') throw new Error('header write failed');
    return originalSetHeader.call(this, name, value);
  };
  try {
    const res = await request(host.port, `/media/${stored.media_id}`);
    eq(res.status, 500, 'header failure maps to 500');
    eq(JSON.parse(res.text).code, 'MEDIA_RESPONSE_ERROR', 'header failure uses MEDIA_RESPONSE_ERROR');
    eq(res.headers.get('content-length') === '3', false, 'stale media Content-Length is not reused');
    await waitFor(() => stream.destroyed === true, 2000, 'stream was not released after a header failure');
    eq(stream.destroyed, true, 'header failure releases the stream/FD');
  } finally {
    http.ServerResponse.prototype.setHeader = originalSetHeader;
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 6. Stream errors before any byte: 500 with no stale success headers
// ---------------------------------------------------------------------------
{
  const failing = new Readable({
    read() {
      const err = new Error('disk read failed');
      err.code = 'EIO';
      this.destroy(err);
    },
  });
  const host = await start(makeManager(store, {
    openVerifiedMedia: async () => ({
      ok: true,
      legacy: false,
      size: 10,
      mimeType: 'text/plain',
      filename: null,
      stream: failing,
    }),
  }));
  try {
    const res = await request(host.port, `/media/${stored.media_id}`);
    eq(res.status, 500, 'stream failure before any byte maps to 500');
    eq(JSON.parse(res.text).code, 'MEDIA_STREAM_ERROR', 'stream failure uses MEDIA_STREAM_ERROR');
    eq(res.headers.get('content-length'), null, 'Content-Length is not carried into the error response');
    eq(res.headers.get('x-media-integrity'), null, 'integrity header is not carried into the error response');
  } finally {
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 7. Stream errors after bytes: the client sees a broken response, not success
// ---------------------------------------------------------------------------
{
  // `_read` only runs once the stream is being consumed by the response, so
  // the product's error listener is guaranteed to be attached before destroy.
  let reads = 0;
  const partial = new Readable({
    read() {
      reads += 1;
      if (reads === 1) {
        this.push(Buffer.from('PARTIAL'));
        setTimeout(() => {
          const err = new Error('mid-stream disk failure');
          err.code = 'EIO';
          this.destroy(err);
        }, 20);
      }
    },
  });
  const host = await start(makeManager(store, {
    openVerifiedMedia: async () => ({
      ok: true,
      legacy: false,
      size: 100,
      mimeType: 'text/plain',
      filename: null,
      stream: partial,
    }),
  }));
  try {
    let result = null;
    let failure = null;
    try {
      result = await request(host.port, `/media/${stored.media_id}`, { timeoutMs: 4000 });
    } catch (err) {
      failure = err;
    }
    ok(reads > 0, 'the stream really was consumed by the response');
    ok(
      failure !== null || (result && result.body.length < 100),
      'a mid-stream failure never looks like a complete successful response'
    );
  } finally {
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 8. Client disconnect while streaming: stream and FD are released
// ---------------------------------------------------------------------------
{
  const bigDir = makeDir();
  const bigStore = createMediaStore({ mediaDir: bigDir, logger: null });
  const bigPayload = Buffer.alloc(8 * 1024 * 1024, 7);
  const storedBig = bigStore.storeMediaBuffer('sess-1', bigPayload, {
    mimeType: 'application/octet-stream',
    waMessageId: 'WA-BIG-545',
  });
  const captured = [];
  const host = await start(makeManager(bigStore, {
    openVerifiedMedia: async (id, filePath) => {
      const result = await bigStore.openVerifiedMedia(id, filePath);
      captured.push(result);
      return result;
    },
  }));
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${host.port}/media/${storedBig.media_id}`, {
      headers: { authorization: `Bearer ${SECRET}` },
      signal: controller.signal,
    });
    eq(res.status, 200, 'large media starts streaming');
    ok(captured.length === 1, 'the verified stream was captured');
    controller.abort();
    await waitFor(
      () => captured[0]?.stream?.destroyed === true,
      2000,
      'stream was not destroyed after the client disconnected'
    );
    eq(captured[0].stream.destroyed, true, 'client disconnect releases the stream/FD');
  } finally {
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 9. HEAD returns headers only and releases the FD
// ---------------------------------------------------------------------------
{
  const captured = [];
  const host = await start(makeManager(store, {
    openVerifiedMedia: async (id, filePath) => {
      const result = await store.openVerifiedMedia(id, filePath);
      captured.push(result);
      return result;
    },
  }));
  try {
    const res = await request(host.port, `/media/${stored.media_id}`, { method: 'HEAD' });
    eq(res.status, 200, 'HEAD returns 200');
    eq(res.body.length, 0, 'HEAD returns no body');
    eq(res.headers.get('content-length'), String(payload.length), 'HEAD keeps content-length');
    eq(res.headers.get('x-media-integrity'), 'verified', 'HEAD reports integrity');
    await waitFor(() => captured[0]?.stream?.destroyed === true, 2000, 'HEAD did not release the stream');
    eq(captured[0].stream.destroyed, true, 'HEAD destroys the stream (closing the FD)');
  } finally {
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 10. Zero-byte media returns an empty 200
// ---------------------------------------------------------------------------
{
  const emptyDir = makeDir();
  const emptyStore = createMediaStore({ mediaDir: emptyDir, logger: null });
  const empty = emptyStore.storeMediaBuffer('sess-1', Buffer.alloc(0), {
    mimeType: 'text/plain',
    waMessageId: 'WA-EMPTY-545',
  });
  const host = await start(makeManager(emptyStore));
  try {
    const res = await request(host.port, `/media/${empty.media_id}`);
    eq(res.status, 200, 'zero-byte media returns 200');
    eq(res.body.length, 0, 'zero-byte body is empty');
    eq(res.headers.get('content-length'), '0', 'zero-byte content-length is 0');
  } finally {
    await host.close();
  }
}

// ---------------------------------------------------------------------------
// 11/12. Both routes serve verified bytes; unknown session is 404
// ---------------------------------------------------------------------------
{
  const unscoped = await request(main.port, `/media/${stored.media_id}`);
  eq(unscoped.status, 200, 'unscoped route serves verified media');
  eq(createHash('sha256').update(unscoped.body).digest('hex'), storedHash, 'unscoped bytes match the sidecar hash');

  const scoped = await request(main.port, `/sessions/sess-1/media/${stored.media_id}`);
  eq(scoped.status, 200, 'session route serves verified media');
  eq(scoped.body.toString(), payload.toString(), 'session route bytes match');

  const missingSession = await request(main.port, '/sessions/nope/media/x');
  eq(missingSession.status, 404, 'unknown session returns 404');
}

// ---------------------------------------------------------------------------
// 13. Wrong/missing token is rejected on both routes
// ---------------------------------------------------------------------------
{
  const missing = await request(main.port, `/media/${stored.media_id}`, { token: null });
  eq(missing.status, 401, 'missing token is rejected');
  const wrong = await request(main.port, `/media/${stored.media_id}`, { token: 'y'.repeat(48) });
  eq(wrong.status, 401, 'wrong token is rejected');
  const wrongSession = await request(main.port, `/sessions/sess-1/media/${stored.media_id}`, {
    token: 'y'.repeat(48),
  });
  eq(wrongSession.status, 401, 'session route also requires the token');
}

// ---------------------------------------------------------------------------
// 14. Express 4 async rejections are caught by the route module itself
// ---------------------------------------------------------------------------
{
  // 14a. Session route: getSession throws synchronously.
  const throwingSession = await start(makeManager(store, {
    getSession: () => {
      throw new Error('session lookup exploded');
    },
  }));
  try {
    const res = await request(throwingSession.port, '/sessions/sess-1/media/anything');
    eq(res.status, 500, 'a thrown session lookup becomes a 500, not a hanging request');
    eq(JSON.parse(res.text).code, 'MEDIA_REQUEST_ERROR', 'unexpected rejection uses MEDIA_REQUEST_ERROR');
  } finally {
    await throwingSession.close();
  }

  // 14b. Unscoped route: an unexpected throw escapes serveVerifiedMedia.
  const res = await request(main.port, `/media/${stored.media_id}?__throw_query=1`);
  eq(res.status, 500, 'an unexpected throw in the unscoped route becomes a 500');
  eq(JSON.parse(res.text).code, 'MEDIA_REQUEST_ERROR', 'unscoped unexpected rejection uses MEDIA_REQUEST_ERROR');

  // 14c. Wrapper itself: resolves (never rejects) and answers exactly once.
  const fake = {
    headersSent: false,
    statusCode: 0,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      this.headersSent = true;
      return this;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const wrapped = asyncHandler(async () => {
    throw new Error('boom');
  });
  const returned = wrapped({}, fake);
  ok(returned && typeof returned.then === 'function', 'wrapper returns a promise (which Express 4 ignores)');
  await returned; // must not reject
  eq(fake.statusCode, 500, 'direct wrapper call answers 500');
  eq(fake.payload.code, 'MEDIA_REQUEST_ERROR', 'direct wrapper call uses MEDIA_REQUEST_ERROR');

  const fakeSent = {
    headersSent: true,
    destroy() {
      this.destroyed = true;
    },
    status() {
      throw new Error('must not send a second response');
    },
    json() {
      throw new Error('must not send a second response');
    },
  };
  await asyncHandler(async () => {
    throw new Error('late failure');
  })({}, fakeSent);
  eq(fakeSent.destroyed, true, 'a response that was already sent is terminated, never answered twice');
}

// ---------------------------------------------------------------------------
// No handler rejection may escape as an unhandledRejection
// ---------------------------------------------------------------------------
await sleep(150);
eq(unhandled.length, 0, 'no unhandled promise rejections were emitted by any route');

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await main.close();
process.off('unhandledRejection', onUnhandled);
for (const tempDir of tempDirs) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(`[test-media-routes-545] ${assertions} assertions passed`);
