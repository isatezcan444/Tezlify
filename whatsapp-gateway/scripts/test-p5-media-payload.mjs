// Phase 5 / §4 — outbound IMAGE (base64 upload) payload shape.
//
// Production evidence (read-only query, 2026-09-19): two outbound IMAGE
// messages are stuck at status=FAILED with
//
//   Gateway hatasi 500: {"error":"The argument 'path' must be a string,
//   Uint8Array, or URL without null bytes. Received <Buffer 89 50 4e 47 ...>"}
//
// `89 50 4e 47` is the PNG magic and `ff d8 ff e0` the JPEG magic — i.e. the
// frontend file upload (client_message_id "file_*") reached the gateway as
// base64 and the raw bytes were handed to Node's `fs`.
//
// Root cause (verified against the installed Baileys source,
// lib/Utils/messages-media.js:249 `getStream`):
//
//   Buffer.isBuffer(item)  -> stream from buffer          [OK]
//   'stream' in item       -> readable                    [OK]
//   item.url.toString()    -> data: / http(s): handled
//   otherwise              -> createReadStream(item.url)  <-- Buffer -> throws
//
// So `{ image: { url: <Buffer> } }` always falls through to
// `createReadStream(<Buffer>)`. A Buffer must be passed DIRECTLY.
//
// These tests assert against the REAL Baileys `getStream` — no stubs.
// Run: `node scripts/test-p5-media-payload.mjs` (exit 0 = PASS).

import assert from 'node:assert/strict';

import { buildMediaContent } from '../src/session-manager.js';
import { getStream } from '@whiskeysockets/baileys/lib/Utils/messages-media.js';

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// A tiny but structurally valid 1x1 PNG (real magic bytes).
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');

// Drain a stream to a Buffer so "streamable" means something observable.
async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// --- 1. The exact production failure -----------------------------------------
await check('base64 IMAGE payload is streamable by Baileys (production FAILED case)', async () => {
  const content = buildMediaContent({
    media_type: 'image',
    media_base64: PNG_B64,
    mime_type: 'image/png',
    caption: '',
  });
  const { stream, type } = await getStream(content.image);
  assert.equal(type, 'buffer', 'a base64 upload must take Baileys’ buffer path');
  const got = await drain(stream);
  assert.equal(got.length, PNG_BYTES.length, 'streamed bytes must be the uploaded bytes');
  assert.ok(got.equals(PNG_BYTES), 'streamed bytes must equal the uploaded bytes');
});

// --- 2. Same for the other base64 media types --------------------------------
for (const media_type of ['video', 'audio', 'document']) {
  await check(`base64 ${media_type.toUpperCase()} payload is streamable`, async () => {
    const content = buildMediaContent({
      media_type,
      media_base64: PNG_B64,
      mime_type: 'image/png',
      filename: 'x.png',
    });
    const { type } = await getStream(content[media_type]);
    assert.equal(type, 'buffer');
  });
}

// --- 3. URL path must stay a URL (no regression) -----------------------------
// NOTE: deliberately offline. An `https://` URL would make Baileys perform a
// real fetch; this suite must not depend on the network, so the remote path is
// asserted structurally and the `data:` path (decoded in-process) end-to-end.
await check('media_url is still passed through as a string URL, not a Buffer', async () => {
  const url = 'https://example.com/photo.png';
  const content = buildMediaContent({ media_type: 'image', media_url: url });
  assert.equal(typeof content.image.url, 'string');
  assert.equal(content.image.url, url);
  assert.equal(Buffer.isBuffer(content.image), false);
});

await check('data: URL is decoded by Baileys without touching the network', async () => {
  const content = buildMediaContent({
    media_type: 'image',
    media_url: `data:image/png;base64,${PNG_B64}`,
  });
  const { stream, type } = await getStream(content.image);
  assert.equal(type, 'buffer');
  assert.ok((await drain(stream)).equals(PNG_BYTES));
});

// --- 4. mimetype must be a sibling key (Baileys reads uploadData.mimetype) ---
await check('mime_type is honoured as a sibling key, not nested in the source', async () => {
  const content = buildMediaContent({
    media_type: 'image',
    media_base64: PNG_B64,
    mime_type: 'image/png',
  });
  assert.equal(content.mimetype, 'image/png');
  // Nested mimetype is silently ignored by prepareWAMessageMedia, so the
  // builder must not rely on it.
  assert.equal(content.image?.mimetype, undefined);
});

// --- 5. document keeps its filename -----------------------------------------
await check('document keeps fileName and mimetype', async () => {
  const content = buildMediaContent({
    media_type: 'document',
    media_base64: PNG_B64,
    mime_type: 'application/pdf',
    filename: 'rapor.pdf',
  });
  assert.equal(content.fileName, 'rapor.pdf');
  assert.equal(content.mimetype, 'application/pdf');
});

// --- 6. Source guard: no Buffer ever reaches a `url` field -------------------
await check('source guard: builder never wraps a Buffer in { url }', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/session-manager.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function buildMediaContent'), src.indexOf('// Faz 8: birim testleri'));
  assert.ok(
    !/url:\s*buffer/.test(fn),
    'buildMediaContent must not put a Buffer into { url }',
  );
});

console.log(`\n  ${passed} assertions passed`);
process.exit(0);
