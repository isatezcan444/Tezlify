import assert from 'node:assert/strict';
import { createChatRepository, jidFromChatPhone } from '../src/chats/chat-repository.js';
import { createSessionStore } from '../src/messages/message-store.js';

const OWNER = 'f65642ab-4ae5-4d69-945c-8f30c8454bac';
const SESSION = '4c12f278-8246-4feb-8787-34826855738e';

const warnings = [];
const logger = { warn: (o) => warnings.push(o), info: () => {}, debug: () => {} };

// --- A. JID derivation -------------------------------------------------------
assert.equal(jidFromChatPhone('+905442767554'), '905442767554@s.whatsapp.net');
assert.equal(jidFromChatPhone('905442767554'), '905442767554@s.whatsapp.net');
assert.equal(jidFromChatPhone('jid:120363424890338512@g.us'), '120363424890338512@g.us');
assert.equal(jidFromChatPhone('120363424890338512@g.us'), '120363424890338512@g.us');
assert.equal(jidFromChatPhone('jid:62771114836011@lid'), null, 'unresolved LID is not a store key');
assert.equal(jidFromChatPhone('+0'), null, 'degenerate number rejected');
assert.equal(jidFromChatPhone(null), null);
assert.equal(jidFromChatPhone('   '), null);

// --- fake pool that records every call --------------------------------------
function makePool({ owner = OWNER, conversations = [], ownerThrows = false, convsThrow = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM public.whatsapp_sessions')) {
        if (ownerThrows) throw new Error('db down');
        return { rows: owner ? [{ user_id: owner }] : [] };
      }
      if (sql.includes('FROM public.conversations')) {
        if (convsThrow) throw new Error('db down');
        return { rows: conversations };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

// --- B. hydrates 1-on-1 and group chats into store.chats --------------------
{
  const pool = makePool({
    conversations: [
      {
        id: 38561,
        phone_e164: '+905442767554',
        display_name: 'Mehlika',
        last_message_at: '2026-11-06T07:51:11Z',
        last_message_preview: 'günaydın',
        unread_count: 0,
        is_archived: false,
        is_group: false,
        avatar_url: 'https://example.com/avatar.jpg',
        name_source: 'addressbook',
      },
      {
        id: 38562,
        phone_e164: 'jid:120363424890338512@g.us',
        display_name: 'Proje Grubu',
        last_message_at: '2026-11-06T08:00:00Z',
        last_message_preview: 'toplantı saat 10',
        unread_count: 2,
        is_archived: false,
        is_group: true,
        avatar_url: null,
        name_source: 'group_subject',
      },
      {
        id: 38563,
        phone_e164: 'jid:62771114836011@lid', // unresolved LID
        display_name: 'Bilinmeyen',
        last_message_at: null,
        last_message_preview: null,
        unread_count: 0,
        is_archived: false,
        is_group: false,
      },
    ],
  });
  const repo = createChatRepository({ pool, logger });
  const store = createSessionStore();
  const written = await repo.hydrateChats(SESSION, store);

  assert.equal(written, 2, '2 valid conversations written');
  const mehlikaChat = store.chats.get('905442767554@s.whatsapp.net');
  assert.ok(mehlikaChat, 'Mehlika is hydrated in store.chats');
  assert.equal(mehlikaChat.name, 'Mehlika');
  assert.equal(mehlikaChat.phone, '+905442767554');
  assert.equal(mehlikaChat.last_message_preview, 'günaydın');
  assert.equal(mehlikaChat.is_group, false);

  const groupChat = store.chats.get('120363424890338512@g.us');
  assert.ok(groupChat, 'Group chat is hydrated in store.chats');
  assert.equal(groupChat.name, 'Proje Grubu');
  assert.equal(groupChat.is_group, true);
  assert.equal(groupChat.unread_count, 2);

  assert.equal(store.chats.has('62771114836011@lid'), false, 'unresolved LID skipped');
}

// --- C. existing chat is preserved and missing fields backfilled -------------
{
  const pool = makePool({
    conversations: [
      {
        id: 38561,
        phone_e164: '+905442767554',
        display_name: 'Mehlika',
        last_message_at: '2026-11-06T07:51:11Z',
        last_message_preview: 'günaydın',
        unread_count: 0,
        is_archived: false,
        is_group: false,
      },
    ],
  });
  const repo = createChatRepository({ pool, logger });
  const store = createSessionStore();
  // Simulate live chat already present
  store.chats.set('905442767554@s.whatsapp.net', {
    id: '905442767554@s.whatsapp.net',
    name: 'Mehlika Canlı',
    last_message_preview: 'en yeni mesaj',
  });
  const written = await repo.hydrateChats(SESSION, store);
  assert.equal(written, 0, 'existing chat not counted as newly written');
  const chat = store.chats.get('905442767554@s.whatsapp.net');
  assert.equal(chat.name, 'Mehlika Canlı', 'live name preserved');
  assert.equal(chat.last_message_preview, 'en yeni mesaj', 'live preview preserved');
  assert.equal(chat.last_message_at, '2026-11-06T07:51:11.000Z', 'missing timestamp backfilled');
}

// --- D. fails soft if DB query throws ---------------------------------------
{
  const pool = makePool({ convsThrow: true });
  const repo = createChatRepository({ pool, logger });
  const store = createSessionStore();
  const written = await repo.hydrateChats(SESSION, store);
  assert.equal(written, 0, 'fails soft on db exception');
}

console.log('test-chat-hydration.mjs: All assertions passed!');

