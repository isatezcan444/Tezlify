import assert from 'node:assert/strict';
import { importTsModule } from './lib/import-ts.mjs';

const { mergeWhatsAppMessages, mergeDeliveryStatus } = await importTsModule(
  '../src/features/whatsapp/lib/whatsappMessageMerge',
  import.meta.url,
);
const base = { conversation_id: 1, direction: 'OUTBOUND', body: 'body', created_at: '2026-01-01T00:00:00Z' };
const pending = { ...base, id: -1, client_message_id: 'client', status: 'PENDING' };
const ack = { ...base, id: 1, client_message_id: 'client', wa_message_id: 'wa', status: 'READ' };
const stale = { ...ack, status: 'SENT' };
assert.equal(mergeDeliveryStatus('READ', 'FAILED'), 'READ');
assert.equal(mergeDeliveryStatus('FAILED', 'READ'), 'READ');
for (const batch of [[pending, ack, stale], [ack, pending, stale], [stale, ack, pending]]) {
  const result = mergeWhatsAppMessages([], batch);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'READ');
  assert.equal(result[0].id, 1);
  assert.equal(result[0].wa_message_id, 'wa');
}
const existing = Array.from({ length: 1200 }, (_, i) => ({ ...base, id: i + 1, wa_message_id: `w${i}`, status: 'READ' }));
const split = mergeWhatsAppMessages([pending, { ...ack, client_message_id: undefined }], [ack]);
assert.equal(split.length, 1);
assert.equal(split[0].status, 'READ');
let overlap = mergeWhatsAppMessages([], [pending]);
overlap = mergeWhatsAppMessages(overlap, [ack]);
overlap = mergeWhatsAppMessages(overlap, [{ ...base, id: 2, wa_message_id: 'incoming', status: 'RECEIVED' }]);
overlap = mergeWhatsAppMessages(overlap, [stale, pending]);
assert.equal(overlap.length, 2);
assert.equal(overlap.find((m) => m.id === 1).status, 'READ');
const start = performance.now();
const merged = mergeWhatsAppMessages([...existing, pending], existing.slice(-50).map((m) => ({ ...m, status: 'SENT' })));
assert.equal(merged.length, 1201);
assert.equal(merged.filter((m) => m.status === 'READ').length, 1200);

// --- Media & Link Preview retention across merges ---
const optimisticMedia = {
  ...base,
  id: -99,
  client_message_id: 'client_media_1',
  message_type: 'VIDEO',
  media_url: 'blob:http://localhost/temp-video',
  media_filename: 'video.mp4',
  media_mime_type: 'video/mp4',
  status: 'PENDING',
};
const serverEchoWithoutUrl = {
  ...base,
  id: 555,
  client_message_id: 'client_media_1',
  wa_message_id: 'wa_media_1',
  message_type: 'VIDEO',
  media_id: 'med_uuid_123',
  status: 'SENT',
};
const mergedMedia = mergeWhatsAppMessages([optimisticMedia], [serverEchoWithoutUrl]);
assert.equal(mergedMedia.length, 1);
assert.equal(mergedMedia[0].id, 555);
assert.equal(mergedMedia[0].media_id, 'med_uuid_123');
assert.equal(mergedMedia[0].media_url, 'blob:http://localhost/temp-video', 'optimistic media_url must NOT be wiped by server echo without url');
assert.equal(mergedMedia[0].media_filename, 'video.mp4');

// Now incoming realtime with real media_url
const realtimeWithUrl = {
  ...base,
  id: 555,
  wa_message_id: 'wa_media_1',
  message_type: 'VIDEO',
  media_id: 'med_uuid_123',
  media_url: '/api/v1/whatsapp/media/med_uuid_123',
  status: 'SENT',
};
const updatedMedia = mergeWhatsAppMessages(mergedMedia, [realtimeWithUrl]);
assert.equal(updatedMedia[0].media_url, '/api/v1/whatsapp/media/med_uuid_123');

// --- resolveMediaUrl tests ---
const { resolveMediaUrl } = await importTsModule('../src/lib/mediaUrl', import.meta.url);
assert.equal(resolveMediaUrl(undefined), undefined);
assert.equal(resolveMediaUrl(null), undefined);
assert.equal(resolveMediaUrl(''), undefined);
assert.equal(resolveMediaUrl('blob:http://localhost/vid'), 'blob:http://localhost/vid');
assert.equal(resolveMediaUrl('data:image/png;base64,abc'), 'data:image/png;base64,abc');
const fromRawId = resolveMediaUrl('44710c36-2e6a-4786-8724-738eccae781d');
assert.ok(fromRawId?.includes('/api/v1/whatsapp/media/44710c36-2e6a-4786-8724-738eccae781d'));
const fromRelative = resolveMediaUrl('/api/v1/whatsapp/media/44710c36-2e6a-4786-8724-738eccae781d');
assert.ok(fromRelative?.includes('/api/v1/whatsapp/media/44710c36-2e6a-4786-8724-738eccae781d'));

console.log('Identity/status/reconnect retention PASS; 1200+pending merge ms:', performance.now() - start);
console.log('Media retention and resolveMediaUrl PASS');