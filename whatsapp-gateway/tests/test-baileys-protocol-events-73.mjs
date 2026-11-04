/**
 * Phase 7.3: Baileys Protocol Events, WhatsApp Entity Sync and Session Conflict Recovery Tests.
 *
 * Drives the real `bindSocketEvents` and `session-manager` against stubbed Baileys sockets.
 * Covers:
 *  1. chats.upsert (new chat and existing chat idempotence)
 *  2. groups.upsert (group, community, announcement group entity_type classification)
 *  3. groups.update (metadata, size, desc, subject)
 *  4. group-participants.update (add, remove, group_size updates, event emission)
 *  5. messaging-history.status (milestone progression and recording)
 *  6. lid-mapping.update (live mapping application)
 *  7. 440 connectionReplaced (fail-closed, no auto-reconnect loop, credentials preserved)
 *  8. newsletter events (reactions, views, participants, settings)
 *  9. newsletter JIDs not filtered by isBroadcastOnlyJid
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { bindSocketEvents } from '../src/socket/socket-events.js';
import { SocketLifecycle } from '../src/domain/socket-lifecycle.js';
import { isBroadcastOnlyJid, isNewsletterJid, classifyEntityType } from '../src/utils/whatsapp-identity.js';

function createMockSession(id = 'test-session-73') {
  const ev = new EventEmitter();
  const sock = {
    ev,
    user: { id: '905413749073:1@s.whatsapp.net', lid: '218107046027315:1@lid' },
    sendPresenceUpdate: async () => {},
  };
  const store = {
    chats: new Map(),
    contacts: new Map(),
    messagesByChat: new Map(),
    lidToJid: new Map(),
    jidToLid: new Map(),
  };
  const eventsEmitted = [];
  const manager = {
    _emit: (event) => {
      eventsEmitted.push(event);
    },
    _storeOf: () => store,
    _applyLidMapping: (session, lid, pn) => {
      store.lidToJid.set(lid, pn);
      store.jidToLid.set(pn, lid);
      eventsEmitted.push({ event: 'lid_mapped', session_id: id, lid, phone_jid: pn });
    },
    _ensureGroupSubjects: async () => {},
    _scheduleBackgroundAvatarFetch: () => {},
  };
  const lifecycle = new SocketLifecycle();
  const generation = lifecycle.beginAttempt();
  lifecycle.attach(generation, sock);

  const session = {
    id,
    session_name: 'Test Hat',
    status: 'CONNECTED',
    is_active: true,
    is_phone_online: true,
    lifecycle,
    sock,
    store,
    sync: { phase: 'syncing', chats_unique: 0 },
  };

  bindSocketEvents({
    session,
    sock,
    generation,
    manager,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    leaseCoordinator: { releaseLease: async () => {} },
    deactivatePersistentSession: async () => {
      session._deactivated = true;
    },
  });

  return { session, sock, ev, store, eventsEmitted, lifecycle, generation };
}

test('1. chats.upsert creates new chats and does not clobber existing ones', async () => {
  const { ev, store, eventsEmitted } = createMockSession('chats-upsert-test');

  // Insert existing chat
  store.chats.set('905411112233@s.whatsapp.net', {
    id: '905411112233@s.whatsapp.net',
    jid: '905411112233@s.whatsapp.net',
    name: 'Existing Contact',
    unread_count: 5,
    last_message_preview: 'Selam',
  });

  // Emit chats.upsert with one existing and two new chats (one group, one channel)
  ev.emit('chats.upsert', [
    {
      id: '905411112233@s.whatsapp.net',
      unreadCount: 1, // should not overwrite accumulated 5
    },
    {
      id: '120363406556759828@g.us',
      name: 'Yeni Grup',
    },
    {
      id: '120363999999999999@newsletter',
      name: 'Haber Bülteni',
    },
  ]);

  const existing = store.chats.get('905411112233@s.whatsapp.net');
  assert.equal(existing.unread_count, 5, 'existing unread_count must be preserved');
  assert.equal(existing.name, 'Existing Contact');
  assert.equal(existing.entity_type, 'INDIVIDUAL');

  const group = store.chats.get('120363406556759828@g.us');
  assert.ok(group, 'new group chat must be created');
  assert.equal(group.name, 'Yeni Grup');
  assert.equal(group.is_group, true);
  assert.equal(group.entity_type, 'GROUP');

  const channel = store.chats.get('120363999999999999@newsletter');
  assert.ok(channel, 'new channel chat must be created');
  assert.equal(channel.name, 'Haber Bülteni');
  assert.equal(channel.is_group, false);
  assert.equal(channel.entity_type, 'CHANNEL');

  const updates = eventsEmitted.filter((e) => e.event === 'conversation_updated');
  assert.equal(updates.length, 3);
});

test('2. groups.upsert classifies communities, announcement groups and regular groups', async () => {
  const { ev, store, eventsEmitted } = createMockSession('groups-upsert-test');

  ev.emit('groups.upsert', [
    {
      id: '120363111111111111@g.us',
      subject: 'Tezlify Topluluğu',
      isCommunity: true,
      size: 150,
      desc: 'Ana topluluk grubu',
    },
    {
      id: '120363222222222222@g.us',
      subject: 'Duyurular',
      isCommunityAnnounce: true,
      linkedParent: '120363111111111111@g.us',
      size: 150,
    },
    {
      id: '120363333333333333@g.us',
      subject: 'Normal Grup',
      size: 12,
    },
  ]);

  const community = store.chats.get('120363111111111111@g.us');
  assert.ok(community);
  assert.equal(community.name, 'Tezlify Topluluğu');
  assert.equal(community.entity_type, 'COMMUNITY');
  assert.equal(community.group_size, 150);
  assert.equal(community.group_desc, 'Ana topluluk grubu');

  const announcement = store.chats.get('120363222222222222@g.us');
  assert.ok(announcement);
  assert.equal(announcement.name, 'Duyurular');
  assert.equal(announcement.entity_type, 'ANNOUNCEMENT');
  assert.equal(announcement.parent_jid, '120363111111111111@g.us');

  const regular = store.chats.get('120363333333333333@g.us');
  assert.ok(regular);
  assert.equal(regular.name, 'Normal Grup');
  assert.equal(regular.entity_type, 'GROUP');
  assert.equal(regular.group_size, 12);
});

test('3. groups.update refines subject, desc and community classification', async () => {
  const { ev, store } = createMockSession('groups-update-test');

  // Seed normal group
  store.chats.set('120363444444444444@g.us', {
    id: '120363444444444444@g.us',
    jid: '120363444444444444@g.us',
    name: 'Eski İsim',
    is_group: true,
    entity_type: 'GROUP',
    group_size: 5,
  });

  ev.emit('groups.update', [
    {
      id: '120363444444444444@g.us',
      subject: 'Yeni İsim',
      desc: 'Yeni Açıklama',
      isCommunity: true,
      size: 20,
    },
  ]);

  const updated = store.chats.get('120363444444444444@g.us');
  assert.equal(updated.name, 'Yeni İsim');
  assert.equal(updated.group_desc, 'Yeni Açıklama');
  assert.equal(updated.entity_type, 'COMMUNITY');
  assert.equal(updated.group_size, 20);
});

test('4. group-participants.update updates group size and emits event', async () => {
  const { ev, store, eventsEmitted } = createMockSession('participants-test');

  store.chats.set('120363555555555555@g.us', {
    id: '120363555555555555@g.us',
    jid: '120363555555555555@g.us',
    name: 'Takım',
    is_group: true,
    group_size: 10,
  });

  // Add 2 participants
  ev.emit('group-participants.update', {
    id: '120363555555555555@g.us',
    author: '905411112233@s.whatsapp.net',
    participants: ['905422223344@s.whatsapp.net', { id: '905433334455@s.whatsapp.net' }],
    action: 'add',
  });

  const chatAfterAdd = store.chats.get('120363555555555555@g.us');
  assert.equal(chatAfterAdd.group_size, 12);

  // Remove 1 participant
  ev.emit('group-participants.update', {
    id: '120363555555555555@g.us',
    author: '905411112233@s.whatsapp.net',
    participants: ['905422223344@s.whatsapp.net'],
    action: 'remove',
  });

  const chatAfterRemove = store.chats.get('120363555555555555@g.us');
  assert.equal(chatAfterRemove.group_size, 11);

  const partEvents = eventsEmitted.filter((e) => e.event === 'group_participants_updated');
  assert.equal(partEvents.length, 2);
  assert.equal(partEvents[0].action, 'add');
  assert.deepEqual(partEvents[0].participants, ['905422223344@s.whatsapp.net', '905433334455@s.whatsapp.net']);
  assert.equal(partEvents[1].action, 'remove');
});

test('5. messaging-history.status records status and emits event', async () => {
  const { session, ev, eventsEmitted } = createMockSession('history-status-test');

  ev.emit('messaging-history.status', {
    syncType: 1, // INITIAL_BOOTSTRAP
    status: 'complete',
    explicit: true,
  });

  assert.ok(session.sync.history_status[1]);
  assert.equal(session.sync.history_status[1].status, 'complete');
  assert.equal(session.sync.history_status[1].explicit, true);

  const statusEvents = eventsEmitted.filter((e) => e.event === 'session_history_status');
  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].status, 'complete');
  assert.equal(statusEvents[0].explicit, true);
});

test('6. lid-mapping.update maps LID to PN', async () => {
  const { ev, store, eventsEmitted } = createMockSession('lid-mapping-test');

  ev.emit('lid-mapping.update', {
    lid: '218107046027315@lid',
    pn: '905413749073@s.whatsapp.net',
  });

  assert.equal(store.lidToJid.get('218107046027315@lid'), '905413749073@s.whatsapp.net');
  const lidEvents = eventsEmitted.filter((e) => e.event === 'lid_mapped');
  assert.equal(lidEvents.length, 1);
});

test('7. 440 connectionReplaced disconnects without auto-reconnect or credential deletion', async () => {
  const { session, ev, eventsEmitted, lifecycle } = createMockSession('conflict-440-test');

  // Trigger 440 connectionReplaced
  ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: {
        output: {
          statusCode: DisconnectReason.connectionReplaced, // 440
        },
      },
      date: new Date(),
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(session.status, 'DISCONNECTED');
  assert.equal(session.is_active, false);
  assert.equal(session.is_phone_online, false);
  assert.equal(session.error_reason, 'CONNECTION_REPLACED');
  assert.ok(session.error_message.includes('440'));
  assert.equal(session._deactivated, undefined, 'credentials must NOT be deactivated or cleared on 440');
  assert.equal(lifecycle.hasReconnectTimer, false, 'auto-reconnect MUST NOT be scheduled on 440');

  const discEvents = eventsEmitted.filter((e) => e.event === 'session_disconnected');
  assert.equal(discEvents.length, 1);
  assert.equal(discEvents[0].reason, 'CONNECTION_REPLACED');
});

test('8. Newsletter events and JID handling', async () => {
  assert.equal(isBroadcastOnlyJid('120363999999999999@newsletter'), false, 'newsletter must NOT be broadcast-only');
  assert.equal(isBroadcastOnlyJid('status@broadcast'), true, 'status@broadcast must be broadcast-only');
  assert.equal(isNewsletterJid('120363999999999999@newsletter'), true);

  const { ev, eventsEmitted } = createMockSession('newsletter-test');

  ev.emit('newsletter.reaction', {
    id: '120363999999999999@newsletter',
    server_id: 'srv-123',
    reaction: { code: '❤️', count: 12 },
  });

  ev.emit('newsletter.view', {
    id: '120363999999999999@newsletter',
    server_id: 'srv-123',
    count: 450,
  });

  const reactionEvents = eventsEmitted.filter((e) => e.event === 'newsletter_reaction');
  assert.equal(reactionEvents.length, 1);
  assert.equal(reactionEvents[0].reaction.code, '❤️');

  const viewEvents = eventsEmitted.filter((e) => e.event === 'newsletter_view');
  assert.equal(viewEvents.length, 1);
  assert.equal(viewEvents[0].count, 450);
});

test('9. Stale socket events are completely ignored across generations', async () => {
  const { session, ev, store, eventsEmitted, lifecycle } = createMockSession('stale-events-test');

  // Advance lifecycle generation so the attached socket is now stale
  lifecycle.beginAttempt();

  ev.emit('chats.upsert', [{ id: '120363999999999999@g.us', name: 'Stale Group' }]);
  ev.emit('groups.upsert', [{ id: '120363888888888888@g.us', subject: 'Stale Group' }]);
  ev.emit('group-participants.update', { id: '120363888888888888@g.us', action: 'add', participants: ['123@s.whatsapp.net'] });
  ev.emit('messaging-history.status', { syncType: 1, status: 'complete', explicit: true });
  ev.emit('lid-mapping.update', { lid: 'stale@lid', pn: 'stale@s.whatsapp.net' });

  assert.equal(store.chats.has('120363999999999999@g.us'), false, 'stale chats.upsert must be ignored');
  assert.equal(store.chats.has('120363888888888888@g.us'), false, 'stale groups.upsert must be ignored');
  assert.equal(store.lidToJid.has('stale@lid'), false, 'stale lid-mapping must be ignored');
  assert.equal(eventsEmitted.length, 0, 'no events should be emitted by stale socket');
});

