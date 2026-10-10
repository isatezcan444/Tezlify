#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');

console.log('--- Tezlify ChatBubble Media Resolution Verification ---');

// 1. Static Contract Verification: Ensure ChatBubble.tsx does NOT fire speculative wa_message_id fetches
const chatBubbleCode = await readFile(
  path.join(frontendRoot, 'src/features/whatsapp/components/ChatBubble.tsx'),
  'utf8'
);

// Verify that wa_message_id fallback is strictly guarded with mediaRetryTs
assert.ok(
  chatBubbleCode.includes('mediaRetryTs && message.message_type !== \'TEXT\' && message.wa_message_id'),
  'ChatBubble MUST guard wa_message_id media resolution with mediaRetryTs to prevent unsolicited 404 network calls'
);

assert.ok(
  !chatBubbleCode.includes('(message.message_type !== \'TEXT\' && message.wa_message_id\n        ? `/api/v1/whatsapp/media/${message.wa_message_id}`'),
  'ChatBubble MUST NOT unconditionally resolve wa_message_id without mediaRetryTs'
);

console.log('  ok - 1. Static contract check passed: wa_message_id fallback guarded by mediaRetryTs');

// 2. Behavioral Verification: Test the media URL resolution logic
const { resolveMediaUrl } = await import('../src/lib/mediaUrl.ts');

function resolveBubbleMediaUrl(message, mediaRetryTs = null) {
  const raw =
    message.media_url ||
    (message.media_id
      ? `/api/v1/whatsapp/media/${message.media_id}`
      : undefined) ||
    (mediaRetryTs && message.message_type !== 'TEXT' && message.wa_message_id
      ? `/api/v1/whatsapp/media/${message.wa_message_id}`
      : undefined);

  const resolved = resolveMediaUrl(raw);
  if (!resolved) return undefined;
  if (mediaRetryTs) {
    const sep = resolved.includes('?') ? '&' : '?';
    return `${resolved}${sep}_retry=${mediaRetryTs}`;
  }
  return resolved;
}

// Case A: Message has media_id
const msgWithMediaId = {
  id: 1,
  message_type: 'IMAGE',
  media_id: 'med-abc-123',
  wa_message_id: 'WA_111',
};
const urlA = resolveBubbleMediaUrl(msgWithMediaId);
assert.ok(urlA, 'Message with media_id should resolve media URL immediately');
assert.ok(urlA.includes('/api/v1/whatsapp/media/med-abc-123'), 'URL should use media_id');
console.log('  ok - 2. Message with media_id resolves automatically');

// Case B: Message has media_url (e.g. data URL or external URL)
const msgWithMediaUrl = {
  id: 2,
  message_type: 'IMAGE',
  media_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY44YAAAAASUVORK5CYII=',
  wa_message_id: 'WA_222',
};
const urlB = resolveBubbleMediaUrl(msgWithMediaUrl);
assert.equal(urlB, msgWithMediaUrl.media_url, 'Data or blob URL should resolve immediately');
console.log('  ok - 3. Message with direct media_url resolves immediately');

// Case C: Historical message without media_id and mediaRetryTs is null
const historicalMsg = {
  id: 137661,
  message_type: 'IMAGE',
  media_id: null,
  wa_message_id: '32C5281D8FA8C4A7272C8F74C4569B57',
};
const urlC = resolveBubbleMediaUrl(historicalMsg, null);
assert.equal(urlC, undefined, 'Historical message with null media_id must NOT resolve a URL before user requests retry');
console.log('  ok - 4. Historical message with null media_id returns undefined (zero 404 network requests)');

// Case D: Historical message when user clicks retry
const retryTs = 1791660000000;
const urlD = resolveBubbleMediaUrl(historicalMsg, retryTs);
assert.ok(urlD, 'User click retry MUST resolve URL with wa_message_id and retry token');
assert.ok(urlD.includes('/api/v1/whatsapp/media/32C5281D8FA8C4A7272C8F74C4569B57'), 'URL should target wa_message_id');
assert.ok(urlD.includes(`_retry=${retryTs}`), 'URL should include _retry timestamp');
console.log('  ok - 5. Retry click successfully initiates on-demand media request');

console.log('All 5 ChatBubble media resolution checks PASSED!');
