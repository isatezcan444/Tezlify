import assert from 'node:assert/strict';
import { createSessionStore, countCachedMessages } from '../src/messages/message-store.js';

// The health endpoint and GET /sessions/:id report `messages_cached`. It used
// to be computed from `store.messages` — a property `createSessionStore` never
// defines — so the fallback was a permanent no-op and every reconnect (which
// replaces `session.sync` with an object that has no `messages_cached` key)
// reported 0 while the map still held the history.

const store = createSessionStore();

// 1. The bug's premise: there is no `store.messages`, and the map is empty.
assert.equal(store.messages, undefined, 'createSessionStore must not expose store.messages');
assert.equal(countCachedMessages(store), 0);

// 2. Sum across chats, ignoring a malformed (non-array) entry.
store.messagesByChat.set('a@s.whatsapp.net', [{ id: 1 }, { id: 2 }]);
store.messagesByChat.set('b@s.whatsapp.net', [{ id: 3 }, { id: 4 }, { id: 5 }]);
store.messagesByChat.set('c@s.whatsapp.net', []);
store.messagesByChat.set('d@s.whatsapp.net', null);
assert.equal(countCachedMessages(store), 5);

// 3. Reconnect shape: `connection.open` replaces session.sync without
//    `messages_cached`. The serializer must still report the real cache.
const syncAfterReconnect = { phase: 'ready', progress: 100 };
const reported = Math.max(countCachedMessages(store), syncAfterReconnect.messages_cached || 0);
assert.equal(reported, 5, 'reconnect must not report 0 while messages are cached');

// 4. The per-chunk counter can exceed the (bounded) map; keep the larger.
const staleChunkCounter = { messages_cached: 9 };
assert.equal(Math.max(countCachedMessages(store), staleChunkCounter.messages_cached || 0), 9);

// 5. A missing store must not throw.
assert.equal(countCachedMessages(undefined), 0);
assert.equal(countCachedMessages(null), 0);
assert.equal(countCachedMessages({}), 0);

console.log('messages_cached metric verification: PASS');
