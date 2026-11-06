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

// --- Quoted message and View Once retention across status updates ---
const optimisticReply = {
  ...base,
  id: -88,
  client_message_id: 'c_reply_1',
  body: 'Answering your question',
  status: 'PENDING',
  quoted_message: {
    stanza_id: 'STANZA_999',
    sender_name: 'Customer',
    body: 'How much does it cost?',
    message_type: 'TEXT',
  },
  is_view_once: true,
  is_forwarded: true,
  is_pinned: true,
};

// Bare status delivery ack from WebSocket or server
const deliveryAck = {
  ...base,
  id: 600,
  client_message_id: 'c_reply_1',
  wa_message_id: 'wa_reply_1',
  status: 'DELIVERED',
};

const mergedReply = mergeWhatsAppMessages([optimisticReply], [deliveryAck]);
assert.equal(mergedReply.length, 1);
assert.equal(mergedReply[0].status, 'DELIVERED');
assert.ok(mergedReply[0].quoted_message, 'quoted_message must NOT be stripped by status ack');
assert.equal(mergedReply[0].quoted_message.stanza_id, 'STANZA_999');
assert.equal(mergedReply[0].quoted_message.body, 'How much does it cost?');
assert.equal(mergedReply[0].is_view_once, true, 'is_view_once must be retained across status ack');
assert.equal(mergedReply[0].is_forwarded, true, 'is_forwarded must be retained');
assert.equal(mergedReply[0].is_pinned, true, 'is_pinned must be retained');

// --- History Pagination & Merge Stability: Edited Body & Reactions Retention ---
const editedMsg = {
  ...base,
  id: 701,
  wa_message_id: 'wa_edit_701',
  body: 'Edited New Text',
  is_edited: true,
  edited_at: '2026-11-06T15:00:00Z',
  reactions: [{ emoji: '👍', sender_jid: 'user1@s.whatsapp.net', count: 1 }],
  status: 'DELIVERED',
};

// Stale REST snapshot or history page that has the old body and empty reactions
const staleRestPageItem = {
  ...base,
  id: 701,
  wa_message_id: 'wa_edit_701',
  body: 'Original Old Text',
  is_edited: false,
  reactions: [],
  status: 'DELIVERED',
};

const mergedWithStaleRest = mergeWhatsAppMessages([editedMsg], [staleRestPageItem]);
assert.equal(mergedWithStaleRest.length, 1);
assert.equal(mergedWithStaleRest[0].body, 'Edited New Text', 'Edited message body must NOT be overwritten by stale REST snapshot');
assert.equal(mergedWithStaleRest[0].is_edited, true);
assert.equal(mergedWithStaleRest[0].reactions.length, 1, 'Reactions must NOT be wiped by stale REST snapshot returning empty array');
assert.equal(mergedWithStaleRest[0].reactions[0].emoji, '👍');

// --- Chronological Ordering & Keyset Tie-Breaker Alignment ---
const { compareMessagesChronological, isRealDbId } = await importTsModule(
  '../src/features/whatsapp/lib/whatsappOrdering',
  import.meta.url,
);

// Two messages with identical external_timestamp
const msgId10 = { ...base, id: 10, wa_message_id: 'wa_10', external_timestamp: '2026-11-06T10:00:00Z' };
const msgId20 = { ...base, id: 20, wa_message_id: 'wa_20', external_timestamp: '2026-11-06T10:00:00Z' };

assert.ok(compareMessagesChronological(msgId10, msgId20) < 0, 'When timestamps match, smaller DB ID must precede larger DB ID (backend keyset alignment)');
assert.ok(compareMessagesChronological(msgId20, msgId10) > 0);

// --- isRealDbId Validation (Preview fallback and optimistic filtering) ---
assert.equal(isRealDbId(1), true);
assert.equal(isRealDbId(500), true);
assert.equal(isRealDbId(998_999_999), true);
assert.equal(isRealDbId(999_000_005), false, 'Synthetic preview fallback ID 999000000 + convId must NOT be treated as real DB ID');
assert.equal(isRealDbId('preview-fallback'), false);
assert.equal(isRealDbId('optimistic_123'), false);
assert.equal(isRealDbId(1700000000000), false, 'Optimistic 13-digit millisecond timestamp ID must NOT be treated as real DB ID');
assert.equal(isRealDbId(null), false);
assert.equal(isRealDbId(undefined), false);

console.log('Identity/status/reconnect retention PASS; 1200+pending merge ms:', performance.now() - start);
console.log('Media retention and resolveMediaUrl PASS');
console.log('Message actions (revoke, edit, delete_for_me, star) merge PASS');
console.log('Quote, View Once, Forwarded, Pinned metadata retention across merge PASS');
console.log('Edited message and reactions retention against stale REST merge PASS');
console.log('Chronological ordering keyset tie-breaker and isRealDbId PASS');