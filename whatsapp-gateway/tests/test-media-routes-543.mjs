/**
 * AŞAMA 5.4.3 — REAL HTTP route tests for both gateway media routes.
 *
 * Mounts the actual `registerMediaRoutes` handlers on an isolated native
 * `http` server (Express-compatible `app.get`/`req`/`res` surface) and drives
 * them over HTTP. No production server, no Baileys session, no network.
 *
 *   node --import ./tests/media-test-register.mjs tests/test-media-routes-543.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createMediaStore } from '../src/media/media-store.js';
import { registerMediaRoutes } from '../src/media/media-routes.js';
import { requireGatewayToken } from '../src/security/gateway-auth.js';

const SECRET = 'x'.repeat(48);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz543-routes-'));
  tempDirs.push(dir);
  return dir;
}

function readMeta(dir, mediaId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${mediaId}.meta.json`), 'utf8'));
}

// ---------------------------------------------------------------------------
// Minimal Express-compatible host that mounts the REAL route module.
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

function createHost(sessionManager) {
  const routes = [];
  const app = { get: (pattern, handler) => routes.push({ pattern: pattern.split('/').filter(Boolean), handler }) };
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
    req.query = Object.fromEntries(url.searchParams.entries());
    const parts = url.pathname.split('/').filter(Boolean);

    // Same ordering as production: the shared token middleware protects every
    // route registered after /health.
    requireGatewayToken(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: 'Method not allowed' });
      }
      for (const route of routes) {
        const params = segmentMatch(route.pattern, parts);
        if (!params) continue;
        req.params = params;
        Promise.resolve(route.handler(req, res)).catch(() => {
          if (!res.headersSent) res.status(500).json({ error: 'handler failed' });
          else res.destroy();
        });
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

async function request(port, pathname, { method = 'GET', token = SECRET } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body, text: body.toString('utf8') };
}

function makeSessionManager(store, overrides = {}) {
  return {
    getSession: (id) => (id === 'sess-1' ? { id } : null),
    resolveMediaPath: (sessionId, mediaId) => store.resolveMediaPath(sessionId, mediaId),
    downloadMediaOnDemand: async () => null,
    openVerifiedMedia: (mediaId, filePath) => store.openVerifiedMedia(mediaId, filePath),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const dir = makeDir();
const store = createMediaStore({ mediaDir: dir, logger: null, MEDIA_INDEX_MAX: 1 });
const payload = Buffer.from('ROUTE-LEVEL-MEDIA-BYTES');
const stored = store.storeMediaBuffer('sess-1', payload, {
  mimeType: 'text/plain',
  filename: 'note.txt',
  waMessageId: 'WA-ROUTE-1',
});
const storedMeta = readMeta(dir, stored.media_id);
const expectedHash = createHash('sha256').update(payload).digest('hex');

// Evict the entry from RAM so the HTTP route must resolve it asynchronously.
store.storeMediaBuffer('sess-1', Buffer.from('newer'), {
  mimeType: 'text/plain',
  waMessageId: 'WA-ROUTE-NEWER',
});
eq(store.mediaIndex.has(stored.media_id), false, 'fixture media is out of the RAM index');

const server = createHost(makeSessionManager(store));
const port = await listen(server);

// ---------------------------------------------------------------------------
// 1. Authorized unscoped route serves the verified bytes
// ---------------------------------------------------------------------------
{
  const res = await request(port, `/media/${stored.media_id}`);
  eq(res.status, 200, 'authorized unscoped GET returns 200');
  eq(res.body.toString(), payload.toString(), 'response body equals stored bytes');
  eq(res.headers.get('content-type'), 'text/plain', 'mime type comes from the sidecar');
  eq(res.headers.get('content-length'), String(payload.length), 'content-length matches');
  eq(res.headers.get('x-media-integrity'), 'verified', 'verified file is reported as verified');
  const servedHash = createHash('sha256').update(res.body).digest('hex');
  eq(servedHash, expectedHash, 'served bytes hash equals the stored sidecar hash');
}

// ---------------------------------------------------------------------------
// 2. Session-scoped route (out-of-index) also serves the bytes
// ---------------------------------------------------------------------------
{
  const res = await request(port, `/sessions/sess-1/media/${stored.media_id}`);
  eq(res.status, 200, 'authorized session route returns 200');
  eq(res.body.toString(), payload.toString(), 'session route body equals stored bytes');
}

// ---------------------------------------------------------------------------
// 3. Authentication is enforced by the real middleware
// ---------------------------------------------------------------------------
{
  const missing = await request(port, `/media/${stored.media_id}`, { token: null });
  eq(missing.status, 401, 'missing token is rejected with 401');
  const wrong = await request(port, `/media/${stored.media_id}`, { token: 'y'.repeat(48) });
  eq(wrong.status, 401, 'wrong token is rejected with 401');
  const wrongSession = await request(port, `/sessions/sess-1/media/${stored.media_id}`, { token: 'y'.repeat(48) });
  eq(wrongSession.status, 401, 'session route requires the token too');
}

// ---------------------------------------------------------------------------
// 4. Unknown session and unknown media are 404 with distinct codes
// ---------------------------------------------------------------------------
{
  const noSession = await request(port, `/sessions/does-not-exist/media/${stored.media_id}`);
  eq(noSession.status, 404, 'unknown session returns 404');
  eq(noSession.text.includes('Session not found'), true, 'unknown session does not fall through to a default line');

  const unknown = await request(port, `/media/unknown-media-id`);
  eq(unknown.status, 404, 'unknown media returns 404');
  eq(JSON.parse(unknown.text).code, 'MEDIA_EXPIRED', 'unknown media uses MEDIA_EXPIRED');
}

// ---------------------------------------------------------------------------
// 5. Tampered bytes and corrupt sidecars map to 422, never to a body
// ---------------------------------------------------------------------------
{
  const tamperDir = makeDir();
  const tamperStore = createMediaStore({ mediaDir: tamperDir, logger: null });
  const target = tamperStore.storeMediaBuffer('s', Buffer.from('tamper-target'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-TAMPER-ROUTE',
  });
  const tamperMeta = readMeta(tamperDir, target.media_id);
  fs.writeFileSync(tamperMeta.filePath, 'tamper-REPLACED');
  const tamperServer = createHost(makeSessionManager(tamperStore));
  const tamperPort = await listen(tamperServer);
  try {
    const res = await request(tamperPort, `/media/${target.media_id}`);
    eq(res.status, 422, 'hash mismatch maps to HTTP 422');
    eq(JSON.parse(res.text).code, 'MEDIA_CORRUPTED', 'hash mismatch uses MEDIA_CORRUPTED');
    eq(res.body.includes(Buffer.from('tamper-REPLACED')), false, 'corrupted bytes are never returned');

    fs.writeFileSync(path.join(tamperDir, `${target.media_id}.meta.json`), '{broken', 'utf8');
    // Fresh store AFTER corruption: nothing in RAM can mask the bad sidecar.
    const corruptStore = createMediaStore({ mediaDir: tamperDir, logger: null, MEDIA_INDEX_MAX: 0 });
    const corruptServer = createHost(makeSessionManager(corruptStore));
    const corruptPort = await listen(corruptServer);
    try {
      const corrupt = await request(corruptPort, `/media/${target.media_id}`);
      eq(corrupt.status, 422, 'corrupt sidecar maps to HTTP 422');
      eq(JSON.parse(corrupt.text).code, 'MEDIA_CORRUPTED', 'corrupt sidecar uses MEDIA_CORRUPTED');
      eq(corrupt.body.includes(Buffer.from('tamper-target')), false, 'corrupt-sidecar bytes are never returned');
    } finally {
      await close(corruptServer);
    }
  } finally {
    await close(tamperServer);
  }
}

// ---------------------------------------------------------------------------
// 6. File disappearing between resolve and verify is a 404, not a 500
// ---------------------------------------------------------------------------
{
  const vanishDir = makeDir();
  const vanishStore = createMediaStore({ mediaDir: vanishDir, logger: null });
  const target = vanishStore.storeMediaBuffer('s', Buffer.from('vanishing'), {
    mimeType: 'text/plain',
    waMessageId: 'WA-VANISH',
  });
  const targetMeta = readMeta(vanishDir, target.media_id);
  const manager = makeSessionManager(vanishStore, {
    resolveMediaPath: async (sessionId, mediaId) => {
      const resolved = await vanishStore.resolveMediaPath(sessionId, mediaId);
      if (resolved) fs.rmSync(resolved, { force: true });
      return resolved;
    },
  });
  const vanishServer = createHost(manager);
  const vanishPort = await listen(vanishServer);
  try {
    const res = await request(vanishPort, `/media/${target.media_id}`);
    eq(res.status, 404, 'file disappearing after resolution maps to 404');
    eq(JSON.parse(res.text).code, 'MEDIA_EXPIRED', 'vanished file uses MEDIA_EXPIRED');
    eq(fs.existsSync(targetMeta.filePath), false, 'the file really was removed by the harness');
  } finally {
    await close(vanishServer);
  }
}

// ---------------------------------------------------------------------------
// 7. Verification exception maps to 500 without leaking a file path
// ---------------------------------------------------------------------------
{
  const leakPath = '/secret/location/media-file.bin';
  const manager = makeSessionManager(store, {
    openVerifiedMedia: async () => {
      const err = new Error(`EACCES: permission denied, open '${leakPath}'`);
      err.code = 'EACCES';
      throw err;
    },
  });
  const errorServer = createHost(manager);
  const errorPort = await listen(errorServer);
  try {
    const res = await request(errorPort, `/media/${stored.media_id}`);
    eq(res.status, 500, 'verification exception maps to HTTP 500');
    eq(JSON.parse(res.text).code, 'MEDIA_VERIFY_ERROR', 'verification exception uses MEDIA_VERIFY_ERROR');
    eq(res.text.includes(leakPath), false, 'error response does not leak the file path');
  } finally {
    await close(errorServer);
  }
}

// ---------------------------------------------------------------------------
// 8. HEAD returns headers only; legacy files report legacy
// ---------------------------------------------------------------------------
{
  const head = await request(port, `/media/${stored.media_id}`, { method: 'HEAD' });
  eq(head.status, 200, 'HEAD returns 200');
  eq(head.body.length, 0, 'HEAD returns no body');
  eq(head.headers.get('content-length'), String(payload.length), 'HEAD keeps content-length');
  eq(head.headers.get('x-media-integrity'), 'verified', 'HEAD reports integrity');

  const legacyDir = makeDir();
  const legacyFile = path.join(legacyDir, 'legacy-route.bin');
  fs.writeFileSync(legacyFile, 'legacy-route-bytes');
  fs.writeFileSync(
    path.join(legacyDir, 'legacy-route.meta.json'),
    JSON.stringify({ filePath: legacyFile, mimeType: 'text/plain', filename: 'legacy.bin', sizeBytes: 18 }),
    'utf8'
  );
  const legacyStore = createMediaStore({ mediaDir: legacyDir, logger: null });
  const legacyServer = createHost(makeSessionManager(legacyStore));
  const legacyPort = await listen(legacyServer);
  try {
    const res = await request(legacyPort, `/media/legacy-route`);
    eq(res.status, 200, 'legacy file without hash is still served');
    eq(res.headers.get('x-media-integrity'), 'legacy', 'legacy file is reported as legacy, not verified');
    eq(res.body.toString(), 'legacy-route-bytes', 'legacy bytes intact');
  } finally {
    await close(legacyServer);
  }
}

// ---------------------------------------------------------------------------
// 9. A stream failure is never reported as success
// ---------------------------------------------------------------------------
{
  const failing = new Readable({
    read() {
      const err = new Error('disk read failed');
      err.code = 'EIO';
      this.destroy(err);
    },
  });
  const manager = makeSessionManager(store, {
    openVerifiedMedia: async () => ({
      ok: true,
      legacy: false,
      size: 10,
      mimeType: 'text/plain',
      filename: null,
      stream: failing,
    }),
  });
  const failServer = createHost(manager);
  const failPort = await listen(failServer);
  try {
    const res = await request(failPort, `/media/${stored.media_id}`);
    eq(res.status, 500, 'stream error before any byte maps to 500');
    eq(JSON.parse(res.text).code, 'MEDIA_STREAM_ERROR', 'stream failure uses MEDIA_STREAM_ERROR');
  } finally {
    await close(failServer);
  }
}

// ---------------------------------------------------------------------------
// 10. Zero-byte media serves an empty 200, not a hang or a 404
// ---------------------------------------------------------------------------
{
  const emptyDir = makeDir();
  const emptyStore = createMediaStore({ mediaDir: emptyDir, logger: null });
  const empty = emptyStore.storeMediaBuffer('s', Buffer.alloc(0), {
    mimeType: 'text/plain',
    waMessageId: 'WA-EMPTY',
  });
  const emptyServer = createHost(makeSessionManager(emptyStore));
  const emptyPort = await listen(emptyServer);
  try {
    const res = await Promise.race([
      request(emptyPort, `/media/${empty.media_id}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('zero-byte response hung')), 5000)),
    ]);
    eq(res.status, 200, 'zero-byte media returns 200');
    eq(res.body.length, 0, 'zero-byte body is empty');
    eq(res.headers.get('content-length'), '0', 'zero-byte content-length is 0');
  } finally {
    await close(emptyServer);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await close(server);
for (const tempDir of tempDirs) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(`[test-media-routes-543] ${assertions} assertions passed`);
