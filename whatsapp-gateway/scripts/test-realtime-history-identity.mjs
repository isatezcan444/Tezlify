import assert from 'node:assert/strict';
import { createSessionStore } from '../src/messages/message-store.js';
import { rememberLidPair } from '../src/utils/whatsapp-identity.js';
import { resolveHistoryWaitersForChunk } from '../src/socket/socket-events.js';
import { applyDiscoveredLidMapping } from '../src/socket/socket-connector.js';

// Concurrent on-demand history requests must only be completed by a chunk for
// their own chat.  A chunk for chat A used to resolve every session waiter,
// causing chat B to report an empty page before its provider response arrived.
{
  const chatA = '905551111111@s.whatsapp.net';
  const chatB = '905552222222@s.whatsapp.net';
  const messagesByChat = new Map([
    [chatA, [{ id: 1000, wa_message_id: 'a-1' }]],
    [chatB, []],
  ]);
  const resolved = [];
  const pendingHistoryWaiters = new Map([
    ['flight-a', { sessionId: 'sid-1', key: chatA, before: null, resolve: (rows) => resolved.push(['a', rows]) }],
    ['flight-b', { sessionId: 'sid-1', key: chatB, before: null, resolve: (rows) => resolved.push(['b', rows]) }],
  ]);
  const inFlightHistoryFetches = new Map([
    ['flight-a', Promise.resolve()],
    ['flight-b', Promise.resolve()],
  ]);

  resolveHistoryWaitersForChunk({
    pendingHistoryWaiters,
    inFlightHistoryFetches,
    sessionId: 'sid-1',
    messagesByChat,
    touchedChatKeys: new Set([chatA]),
  });

  assert.deepEqual(resolved, [['a', messagesByChat.get(chatA)]]);
  assert.equal(pendingHistoryWaiters.has('flight-a'), false);
  assert.equal(pendingHistoryWaiters.has('flight-b'), true);
  assert.equal(inFlightHistoryFetches.has('flight-b'), true);
}

// LID refreshes must remove both kinds of stale inverse cache entry.
{
  const store = createSessionStore();
  const lidA = '900000000000001@lid';
  const lidB = '900000000000002@lid';
  const phoneA = '905551111111@s.whatsapp.net';
  const phoneB = '905552222222@s.whatsapp.net';

  assert.equal(rememberLidPair(store, lidA, phoneA), true);
  assert.equal(rememberLidPair(store, lidA, phoneB), true);
  assert.equal(store.jidToLid.has(phoneA), false);
  assert.equal(store.lidToJid.get(lidA), phoneB);

  assert.equal(rememberLidPair(store, lidB, phoneB), true);
  assert.equal(store.lidToJid.has(lidA), false);
  assert.equal(store.jidToLid.get(phoneB), lidB);
}

// The connector must delegate a discovered mapping before mutating the cache.
// Otherwise SessionManager's idempotency guard sees an existing pair and skips
// migration of pending chats/messages plus the realtime lid_mapped event.
{
  const store = createSessionStore();
  const lid = '900000000000003@lid';
  const phone = '905553333333@s.whatsapp.net';
  let cacheWasEmptyInCallback = false;
  applyDiscoveredLidMapping(store, lid, phone, (seenLid, seenPhone) => {
    assert.equal(seenLid, lid);
    assert.equal(seenPhone, phone);
    cacheWasEmptyInCallback = !store.lidToJid.has(lid);
    rememberLidPair(store, seenLid, seenPhone);
  });
  assert.equal(cacheWasEmptyInCallback, true);
  assert.equal(store.lidToJid.get(lid), phone);
}

console.log('Realtime history waiter isolation and LID cache consistency: PASS');
