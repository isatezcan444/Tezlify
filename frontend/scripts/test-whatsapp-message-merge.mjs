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

// --- resolveMediaUrl and isWhatsAppUrlExpired tests ---
const { resolveMediaUrl, isWhatsAppUrlExpired } = await importTsModule('../src/lib/mediaUrl', import.meta.url);
assert.equal(resolveMediaUrl(undefined), undefined);
assert.equal(resolveMediaUrl(null), undefined);
assert.equal(resolveMediaUrl(''), undefined);
assert.equal(resolveMediaUrl('blob:http://localhost/vid'), 'blob:http://localhost/vid');
assert.equal(resolveMediaUrl('data:image/png;base64,abc'), 'data:image/png;base64,abc');
const fromRawId = resolveMediaUrl('44710c36-2e6a-4786-8724-738eccae781d');
assert.ok(fromRawId?.includes('/api/v1/whatsapp/media/44710c36-2e6a-4786-8724-738eccae781d'));
const fromRelative = resolveMediaUrl('/api/v1/whatsapp/media/44710c36-2e6a-4786-8724-738eccae781d');
assert.ok(fromRelative?.includes('/api/v1/whatsapp/media/44710c36-2e6a-4786-8724-738eccae781d'));

// Expired WhatsApp signed CDN URL (oe=6AD8EB1C -> Oct 21, 2026, past)
const expiredUrl = 'https://pps.whatsapp.net/v/t61.24694-24/566638859_788599220678526_3305792808332190461_n.jpg?stp=dst-jpg_s96x96_tt6&ccb=11-4&oh=01_Q5Aa5wHRekH3lcK4WwmvD9Y9gyx9IMoqYmwcrKwQGt5q0bm2lg&oe=6AD8EB1C&_nc_sid=5e03e0&_nc_cat=107';
assert.equal(isWhatsAppUrlExpired(expiredUrl), true);
assert.equal(resolveMediaUrl(expiredUrl), undefined, 'Expired WhatsApp CDN URL must resolve to undefined to avoid 403 network failures');

// Future WhatsApp signed CDN URL (oe=7FFFFFFF -> year 2038)
const futureUrl = 'https://pps.whatsapp.net/v/t61.24694-24/test.jpg?oe=7FFFFFFF';
assert.equal(isWhatsAppUrlExpired(futureUrl), false);
assert.equal(resolveMediaUrl(futureUrl), futureUrl);

// --- Message Actions: Revoke, Edit, Delete For Me, Star ---
const originalMsg = { ...base, id: 50, wa_message_id: 'wa_act_50', body: 'Sensitive message', status: 'DELIVERED' };
const revokedUpdate = { ...base, id: 50, wa_message_id: 'wa_act_50', body: '', is_revoked: true, revoked_at: '2026-11-06T12:00:00Z', status: 'DELIVERED' };
const mergedRevoked = mergeWhatsAppMessages([originalMsg], [revokedUpdate]);
assert.equal(mergedRevoked.length, 1);
assert.equal(mergedRevoked[0].is_revoked, true);
assert.equal(mergedRevoked[0].body, '');

const editedUpdate = { ...base, id: 51, wa_message_id: 'wa_act_51', body: 'Updated text', is_edited: true, edited_at: '2026-11-06T12:05:00Z', status: 'DELIVERED' };
const mergedEdited = mergeWhatsAppMessages([{ ...base, id: 51, wa_message_id: 'wa_act_51', body: 'Old text', status: 'DELIVERED' }], [editedUpdate]);
assert.equal(mergedEdited.length, 1);
assert.equal(mergedEdited[0].body, 'Updated text');
assert.equal(mergedEdited[0].is_edited, true);

const deleteForMeUpdate = { ...base, id: 52, wa_message_id: 'wa_act_52', is_deleted_for_me: true, status: 'DELIVERED' };
const mergedDeletedForMe = mergeWhatsAppMessages([{ ...base, id: 52, wa_message_id: 'wa_act_52', body: 'To hide', status: 'DELIVERED' }], [deleteForMeUpdate]);
assert.equal(mergedDeletedForMe.length, 0, 'Message with is_deleted_for_me must be filtered out');

const starUpdate = { ...base, id: 53, wa_message_id: 'wa_act_53', is_starred: true, starred_at: '2026-11-06T12:10:00Z', status: 'DELIVERED' };
const mergedStarred = mergeWhatsAppMessages([{ ...base, id: 53, wa_message_id: 'wa_act_53', is_starred: false, status: 'DELIVERED' }], [starUpdate]);
assert.equal(mergedStarred.length, 1);
assert.equal(mergedStarred[0].is_starred, true);

console.log('Identity/status/reconnect retention PASS; 1200+pending merge ms:', performance.now() - start);
console.log('Media retention and resolveMediaUrl PASS');
console.log('Message actions (revoke, edit, delete_for_me, star) merge PASS');