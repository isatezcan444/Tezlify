import ts from 'typescript';
import fs from 'node:fs';
import assert from 'node:assert/strict';

console.log('[test-whatsapp-chat-order] Starting WhatsApp Web conversation order test suite...');

// Extract parseServerTime implementation directly from utils.ts to avoid bundling react/tailwind dependencies
const utilsContent = fs.readFileSync(new URL('../src/lib/utils.ts', import.meta.url), 'utf8');
const parseServerTimeMatch = utilsContent.match(/export function parseServerTime[\s\S]*?\n\}/);
if (!parseServerTimeMatch) {
  throw new Error('Could not extract parseServerTime from utils.ts');
}

let orderSource = fs.readFileSync(new URL('../src/features/whatsapp/lib/whatsappOrdering.ts', import.meta.url), 'utf8');
// Remove the imports
orderSource = orderSource
  .replace("import { Conversation } from '../../../types';", '')
  .replace("import { parseServerTime } from '../../../lib/utils';", '');

// Combine parseServerTime with orderSource
const combinedSource = `
${parseServerTimeMatch[0]}
${orderSource}
`;

const js = ts.transpileModule(combinedSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;

const { getConversationActivityTimestamp, compareConversationsByActivityDesc } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
);

// Base mock conversations
const convA = {
  id: 1,
  contact_name: 'Lead Alice',
  phone_number: '+905551112233',
  last_message: 'Hello Alice',
  last_message_at: '2026-09-17T14:00:00Z',
  updated_at: '2026-09-17T14:00:00Z',
  created_at: '2026-09-17T13:00:00Z',
  unread_count: 0
};

const convB = {
  id: 2,
  contact_name: 'Lead Bob',
  phone_number: '+905554445566',
  last_message: 'Hello Bob',
  last_message_at: '2026-09-17T14:05:00Z',
  updated_at: '2026-09-17T14:05:00Z',
  created_at: '2026-09-17T13:05:00Z',
  unread_count: 0
};

// TEST-CHAT-ORDER-01: A < B -> B üstte
console.log('Running TEST-CHAT-ORDER-01: A < B -> B on top');
let list = [convA, convB];
list.sort(compareConversationsByActivityDesc);
assert.equal(list[0].id, 2, 'B must be on top because 14:05 > 14:00');
assert.equal(list[1].id, 1, 'A must be second');
console.log('✓ TEST-CHAT-ORDER-01 passed');

// TEST-CHAT-ORDER-02: A'ya yeni inbound gelir -> A üstte
console.log("Running TEST-CHAT-ORDER-02: Inbound to A -> A on top");
const convAInbound = {
  ...convA,
  last_message: 'Inbound from Alice',
  last_message_at: '2026-09-17T14:10:00Z',
  unread_count: 1
};
list = [convB, convAInbound];
list.sort(compareConversationsByActivityDesc);
assert.equal(list[0].id, 1, 'A must be on top after inbound message at 14:10');
assert.equal(list[1].id, 2, 'B must be second');
console.log('✓ TEST-CHAT-ORDER-02 passed');

// TEST-CHAT-ORDER-03: A'dan outbound gider -> A üstte
console.log("Running TEST-CHAT-ORDER-03: Outbound from A -> A on top");
const convBNewer = {
  ...convB,
  last_message_at: '2026-09-17T14:15:00Z'
};
// Now outbound sent in A
const convAOutbound = {
  ...convAInbound,
  last_message: 'Reply to Alice',
  last_message_at: '2026-09-17T14:20:00Z'
};
list = [convBNewer, convAOutbound];
list.sort(compareConversationsByActivityDesc);
assert.equal(list[0].id, 1, 'A must be on top after outbound message at 14:20');
assert.equal(list[1].id, 2, 'B must be second');
console.log('✓ TEST-CHAT-ORDER-03 passed');

// TEST-CHAT-ORDER-04: A mesajının READ/DELIVERED status'u değişir -> ordering değişmez
console.log("Running TEST-CHAT-ORDER-04: Status update (READ/DELIVERED) -> ordering unchanged");
const convAStatusUpdated = {
  ...convAOutbound,
  // Delivery status changed, but last_message_at does NOT change
  last_message_status: 'READ'
};
list = [convAStatusUpdated, convBNewer];
list.sort(compareConversationsByActivityDesc);
assert.equal(list[0].id, 1, 'Order must remain unchanged on delivery status update');
assert.equal(list[1].id, 2, 'Order must remain unchanged on delivery status update');
console.log('✓ TEST-CHAT-ORDER-04 passed');

// TEST-CHAT-ORDER-05: A sohbetinde eski history scroll edilir -> ordering değişmez
console.log("Running TEST-CHAT-ORDER-05: Scroll older history -> ordering unchanged");
// Simulating older messages being prepended to message store: conversation's last_message_at is unchanged
const convAAfterHistoryScroll = {
  ...convAStatusUpdated
  // last_message_at remains 2026-09-17T14:20:00Z
};
list = [convAAfterHistoryScroll, convBNewer];
list.sort(compareConversationsByActivityDesc);
assert.equal(list[0].id, 1, 'A must still be on top when older messages are loaded');
console.log('✓ TEST-CHAT-ORDER-05 passed');

// TEST-CHAT-ORDER-06: Realtime conversation_updated gelir -> conversation doğru yere taşınır
console.log("Running TEST-CHAT-ORDER-06: Realtime conversation_updated -> moves to top");
const convBRealtimeUpdate = {
  ...convBNewer,
  last_message: 'New message for Bob',
  last_message_at: '2026-09-17T14:30:00Z'
};
list = [convAAfterHistoryScroll, convBRealtimeUpdate];
list.sort(compareConversationsByActivityDesc);
assert.equal(list[0].id, 2, 'B must be moved to top after real-time update at 14:30');
assert.equal(list[1].id, 1, 'A must be second');
console.log('✓ TEST-CHAT-ORDER-06 passed');

// TEST-CHAT-ORDER-07: Duplicate websocket event -> tek conversation row kalır
console.log("Running TEST-CHAT-ORDER-07: Duplicate WS event -> single conversation row preserved");
function upsertConversation(currentList, updatedConv) {
  const next = [...currentList];
  const idx = next.findIndex(c => c.id === updatedConv.id);
  if (idx >= 0) {
    next[idx] = { ...next[idx], ...updatedConv };
  } else {
    next.push(updatedConv);
  }
  return next.sort(compareConversationsByActivityDesc);
}

let dedupeList = [convA, convB];
// Send duplicate event for convB twice
dedupeList = upsertConversation(dedupeList, convBRealtimeUpdate);
dedupeList = upsertConversation(dedupeList, convBRealtimeUpdate);
assert.equal(dedupeList.filter(c => c.id === 2).length, 1, 'Must only contain 1 row for convB');
assert.equal(dedupeList.length, 2, 'Total list length must remain 2');
assert.equal(dedupeList[0].id, 2, 'Updated B must be on top');
console.log('✓ TEST-CHAT-ORDER-07 passed');

// TEST-CHAT-ORDER-08: Page refresh -> ordering aynı kalır
console.log("Running TEST-CHAT-ORDER-08: Page refresh -> deterministic ordering identical");
// Simulate re-fetching data from server in arbitrary order
const rawFetchedFromServer = [convA, convBRealtimeUpdate];
const refreshedList = [...rawFetchedFromServer].sort(compareConversationsByActivityDesc);
assert.deepEqual(
  refreshedList.map(c => c.id),
  dedupeList.map(c => c.id),
  'Refreshed list ordering must deterministically match real-time state'
);
// TEST-CHAT-ORDER-09: Boş sohbet (last_message_at: null) bugün sync edilse bile aktif sohbetin üstüne ÇIKMAZ
console.log("Running TEST-CHAT-ORDER-09: Empty conversation (no messages) must never sort above active chats");
const activeConvYesterday = {
  id: 10,
  last_message_at: '2026-09-17T12:00:00Z',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-17T12:00:00Z',
};
const emptyConvJustCreated = {
  id: 11,
  last_message_at: null,
  created_at: '2026-09-18T00:05:00Z', // Today just now
  updated_at: '2026-09-18T00:05:00Z',
};
let emptyOrderList = [emptyConvJustCreated, activeConvYesterday];
emptyOrderList.sort(compareConversationsByActivityDesc);
assert.equal(emptyOrderList[0].id, 10, 'Active conversation from yesterday MUST stay above empty conversation');
assert.equal(emptyOrderList[1].id, 11, 'Empty conversation must sort to bottom');
console.log('✓ TEST-CHAT-ORDER-09 passed');

// TEST-CHAT-ORDER-10: Contact sync / avatar update updated_at'i değiştirir ama sohbet sırasını DEĞİŞTİRMEZ
console.log("Running TEST-CHAT-ORDER-10: Contact sync / avatar update (updated_at change) must NOT change order");
const olderChatWithNewAvatar = {
  id: 10,
  last_message_at: '2026-09-17T12:00:00Z',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-18T00:10:00Z', // avatar fetched now
};
const newerChat = {
  id: 12,
  last_message_at: '2026-09-17T15:00:00Z',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-17T15:00:00Z',
};
let avatarUpdateList = [olderChatWithNewAvatar, newerChat];
avatarUpdateList.sort(compareConversationsByActivityDesc);
assert.equal(avatarUpdateList[0].id, 12, 'Newer message chat must remain on top despite older chat having newer updated_at');
assert.equal(avatarUpdateList[1].id, 10, 'Older chat with avatar update must remain below');
console.log('✓ TEST-CHAT-ORDER-10 passed');

console.log('[test-whatsapp-chat-order] ALL TEST-CHAT-ORDER (01-10) ASSERTIONS PASSED SUCCESSFULLY.');
