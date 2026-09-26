/**
 * Chat-list activity ordering — regression cover for the "Tezlify's order does not
 * match WhatsApp Web" defect.
 *
 * WhatsApp Web orders its chat list by the ABSOLUTE last message in the chat.
 * The gateway used to derive the ordering stamp from `lastMessageRecvTimestamp`,
 * which is the last message RECEIVED FROM THE OTHER PARTY. Every chat whose newest
 * message was one WE sent therefore sank below where WhatsApp Web puts it.
 *
 * Measured on live production data before the fix: 24 of 113 chats carried a stamp
 * older than their own newest message, and 23 of those 24 had an OUTBOUND newest
 * message — the worst being 36 days stale.
 */
import assert from 'node:assert/strict';
import {
  resolveChatActivitySeconds,
  toPositiveSeconds,
  firstPositiveSeconds,
} from '../src/messages/message-store.js';

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  console.log(`ok - ${name}`);
}

const SEC = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// --- A. THE REGRESSION: the absolute stamp must beat the received-only stamp ---
check('A. conversationTimestamp beats lastMessageRecvTimestamp', () => {
  // We received a message on 2026-07-31, then WE sent the last message on 2026-09-05.
  const chat = {
    conversationTimestamp: SEC('2026-09-05T19:42:11Z'), // absolute last message (ours)
    lastMessageRecvTimestamp: SEC('2026-07-31T12:30:47Z'), // last received FROM them
  };
  const got = resolveChatActivitySeconds(chat, null);
  assert.equal(got, SEC('2026-09-05T19:42:11Z'),
    'the chat must be ranked by its absolute last message, not by the last one received');
  assert.notEqual(got, chat.lastMessageRecvTimestamp,
    'ranking by the received-only stamp is the defect this guards');
});

// --- B. Long coercion: `Number(Long)` is NaN, which would silently drop a value --
check('B. a protobuf Long stamp is coerced, not dropped', () => {
  // Shape of a long.js Long as protobufjs hands it back.
  const longLike = { low: 0, high: 0, unsigned: true, toNumber: () => SEC('2026-09-05T19:42:11Z') };
  assert.equal(toPositiveSeconds(longLike), SEC('2026-09-05T19:42:11Z'));
  assert.equal(resolveChatActivitySeconds({ conversationTimestamp: longLike }, null),
    SEC('2026-09-05T19:42:11Z'));
  // And the raw-object form, without toNumber().
  const raw = { low: SEC('2026-09-05T19:42:11Z') >>> 0, high: 0 };
  assert.equal(toPositiveSeconds(raw), SEC('2026-09-05T19:42:11Z'));
});

// --- C. string stamps (protobufjs often stringifies uint64) --------------------
check('C. a numeric string stamp is coerced', () => {
  assert.equal(resolveChatActivitySeconds({ conversationTimestamp: '1757101331' }, null), 1757101331);
});

// --- D. lastMsgTimestamp is the second choice ---------------------------------
check('D. lastMsgTimestamp is used when conversationTimestamp is absent', () => {
  const chat = { lastMsgTimestamp: SEC('2026-08-01T00:00:00Z'), lastMessageRecvTimestamp: SEC('2026-07-01T00:00:00Z') };
  assert.equal(resolveChatActivitySeconds(chat, null), SEC('2026-08-01T00:00:00Z'));
});

// --- E. the newest LOCAL message beats the received-only stamp -----------------
check('E. the newest locally known message beats the received-only stamp', () => {
  // No absolute chat stamp at all; the newest local message is one WE sent.
  const newest = { timestamp_s: SEC('2026-08-02T21:36:35Z') };
  const chat = { lastMessageRecvTimestamp: SEC('2026-08-02T21:24:35Z') };
  assert.equal(resolveChatActivitySeconds(chat, newest), SEC('2026-08-02T21:36:35Z'),
    'a locally known OUTBOUND message must outrank the received-only stamp');
});

// --- F. received-only is still the LAST resort, not a dead field ---------------
check('F. lastMessageRecvTimestamp is still used when nothing else exists', () => {
  const chat = { lastMessageRecvTimestamp: SEC('2026-07-31T12:30:47Z') };
  assert.equal(resolveChatActivitySeconds(chat, null), SEC('2026-07-31T12:30:47Z'));
});

// --- G. nothing usable -> null, so the caller falls back instead of inventing ---
check('G. no usable stamp yields null (never Date.now())', () => {
  assert.equal(resolveChatActivitySeconds({}, null), null);
  assert.equal(resolveChatActivitySeconds({ conversationTimestamp: 0, lastMsgTimestamp: null }, null), null);
  assert.equal(resolveChatActivitySeconds({ conversationTimestamp: -5 }, null), null);
  assert.equal(toPositiveSeconds(undefined), null);
  assert.equal(toPositiveSeconds('not-a-number'), null);
  // `firstPositiveSeconds` must skip falsy/invalid entries rather than short-circuit.
  assert.equal(firstPositiveSeconds(0, null, undefined, '', 42), 42);
});

// --- G2. a millisecond value must not latch a chat to the far future -----------
check('G2. a millisecond-scale stamp is normalised to seconds', () => {
  // The backend only moves last_message_at FORWARD, so an un-normalised millis
  // value would pin the chat to the top of the list permanently.
  const msValue = SEC('2026-09-05T19:42:11Z') * 1000;
  assert.equal(toPositiveSeconds(msValue), SEC('2026-09-05T19:42:11Z'),
    'a millisecond value must be divided down, not accepted as seconds');
  assert.equal(resolveChatActivitySeconds({ conversationTimestamp: msValue }, null),
    SEC('2026-09-05T19:42:11Z'));
  // And a genuine seconds value is left alone.
  assert.equal(toPositiveSeconds(SEC('2026-09-05T19:42:11Z')), SEC('2026-09-05T19:42:11Z'));
});

// --- H. end-to-end: the ORDER of two chats flips with the fix ------------------
check('H. a chat we replied to ranks above one we did not', () => {
  // "Ufuk Biber": we replied 2026-09-05; the last message we RECEIVED was 2026-07-31.
  const ufuk = {
    conversationTimestamp: SEC('2026-09-05T19:42:11Z'),
    lastMessageRecvTimestamp: SEC('2026-07-31T12:30:47Z'),
  };
  // "Adil Abi": last activity is a received message on 2026-08-24.
  const adil = {
    conversationTimestamp: SEC('2026-08-24T11:29:00Z'),
    lastMessageRecvTimestamp: SEC('2026-08-24T11:29:00Z'),
  };

  const stamp = (c) => resolveChatActivitySeconds(c, null);
  assert.ok(stamp(ufuk) > stamp(adil),
    'Ufuk Biber (we replied 09-05) must sort above Adil Abi (last activity 08-24)');

  // Under the OLD rule the order was inverted — this is the defect, pinned.
  const oldStamp = (c) => c.lastMessageRecvTimestamp;
  assert.ok(oldStamp(ufuk) < oldStamp(adil),
    'the old received-only rule really did invert this pair (guards against a no-op test)');
});

console.log(`\nChat activity ordering verification: PASS (${checks.length} checks)`);
