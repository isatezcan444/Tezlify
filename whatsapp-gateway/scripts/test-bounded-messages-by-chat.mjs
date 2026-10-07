import assert from 'node:assert/strict';
import {
  createSessionStore,
  boundMessagesByChat,
  MESSAGES_BY_CHAT_MAX_CHATS,
} from '../src/messages/message-store.js';

const store = createSessionStore();
assert.equal(typeof MESSAGES_BY_CHAT_MAX_CHATS, 'number');
assert.ok(MESSAGES_BY_CHAT_MAX_CHATS > 0);

// 1. Add chats beyond capacity
for (let i = 0; i < MESSAGES_BY_CHAT_MAX_CHATS + 20; i += 1) {
  const key = `chat_${i}@s.whatsapp.net`;
  store.messagesByChat.set(key, [{ id: i }]);
  boundMessagesByChat(store, key);
}

// Map size must be bounded
assert.equal(store.messagesByChat.size, MESSAGES_BY_CHAT_MAX_CHATS);

// Oldest chat_0 must have been pruned
assert.equal(store.messagesByChat.has('chat_0@s.whatsapp.net'), false);
assert.equal(store.messagesByChat.has('chat_19@s.whatsapp.net'), false);

// Recent chats must be present
assert.equal(store.messagesByChat.has(`chat_${MESSAGES_BY_CHAT_MAX_CHATS + 19}@s.whatsapp.net`), true);

// 2. Refresh LRU recency of chat_20
const touchKey = 'chat_20@s.whatsapp.net';
assert.equal(store.messagesByChat.has(touchKey), true);
boundMessagesByChat(store, touchKey);

// Add another new chat
const newKey = 'chat_new@s.whatsapp.net';
store.messagesByChat.set(newKey, [{ id: 9999 }]);
boundMessagesByChat(store, newKey);

// chat_20 was touched, so it must survive; chat_21 was older and should be evicted
assert.equal(store.messagesByChat.has(touchKey), true);
assert.equal(store.messagesByChat.has('chat_21@s.whatsapp.net'), false);

console.log('Bounded messagesByChat memory verification: PASS');
