import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bindSocketEvents } from '../src/socket/socket-events.js';
import { createSessionStore } from '../src/messages/message-store.js';

console.log('[test-pending-notifications-sync] starting tests...');

// ============================================================================
// TEST 1: When chats.size > 0, receivedPendingNotifications accelerates quiet timer (1500ms)
// ============================================================================
{
  const ev = new EventEmitter();
  const emittedEvents = [];

  const sock = {
    ev,
    user: { id: '905413749073:1@s.whatsapp.net' },
    sendPresenceUpdate: async () => {},
  };

  const session = {
    id: 'test-session-with-chats',
    session_name: 'Test Hat 1',
    lifecycle: {
      generation: 1,
      isCurrent: (gen, s) => gen === 1 && s === sock,
    },
    status: 'CONNECTED',
    sync: {
      phase: 'syncing',
      progress: 10,
      chats_synced: 1,
      messages_synced: 5,
    },
    _diagnosticAuthUpdates: 0,
  };

  const store = createSessionStore({
    sessionDir: '/tmp/test-session-dir-1',
    sessionPhone: '905413749073',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  // Pre-populate with 1 chat so chats.size > 0
  store.chats.set('905413749073@s.whatsapp.net', {
    id: '905413749073@s.whatsapp.net',
    name: 'Ahmet',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const manager = {
    _storeOf: () => store,
    _emit: (e) => emittedEvents.push(e),
    _ensureGroupSubjects: () => {},
    _scheduleBackgroundAvatarFetch: () => {},
    _scheduleAppStateRearm: () => {},
    _applyLidMapping: () => {},
  };

  const sessions = new Map([[session.id, session]]);

  bindSocketEvents({
    id: session.id,
    session,
    generation: 1,
    sock,
    state: { creds: {} },
    saveCreds: async () => {},
    connectStarted: Date.now(),
    sessionDir: '/tmp/test-session-dir-1',
    manager,
    sessions,
    emitEvent: (e) => emittedEvents.push(e),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });

  assert.equal(session.sync.phase, 'syncing');

  // Trigger receivedPendingNotifications from Baileys
  ev.emit('connection.update', { receivedPendingNotifications: true });

  const notifEvent = emittedEvents.find((e) => e.event === 'session_notifications_received');
  assert.ok(notifEvent, 'session_notifications_received event should be emitted');
  assert.equal(notifEvent.session_id, session.id);
  console.log('ok - 1a: session_notifications_received emitted on Baileys signal');

  // With chats.size > 0, quiet timer is scheduled for 1500ms rapid completion
  assert.ok(session._historyQuietTimer, 'Quiet timer should be scheduled for rapid completion when chats exist');
  console.log('ok - 1b: quiet timer scheduled with accelerated window when chats exist');

  // Wait for accelerated timer (1600ms)
  await new Promise((r) => setTimeout(r, 1600));

  assert.equal(session.sync.phase, 'ready', 'Sync phase should be finalized to ready');
  assert.equal(session.sync.progress, 100, 'Sync progress should be 100%');

  const completedEvent = emittedEvents.find((e) => e.event === 'session_sync_completed');
  assert.ok(completedEvent, 'session_sync_completed event should be emitted');
  console.log('ok - 1c: history sync transitioned to ready and session_sync_completed emitted');
}

// ============================================================================
// TEST 2: When chats.size === 0, receivedPendingNotifications does NOT finalize early with 0 chats
// ============================================================================
{
  const ev = new EventEmitter();
  const emittedEvents = [];

  const sock = {
    ev,
    user: { id: '905413749073:1@s.whatsapp.net' },
    sendPresenceUpdate: async () => {},
  };

  const session = {
    id: 'test-session-zero-chats',
    session_name: 'Test Hat 2',
    lifecycle: {
      generation: 1,
      isCurrent: (gen, s) => gen === 1 && s === sock,
    },
    status: 'CONNECTED',
    sync: {
      phase: 'syncing',
      progress: 0,
      chats_synced: 0,
      messages_synced: 0,
    },
    _diagnosticAuthUpdates: 0,
  };

  const store = createSessionStore({
    sessionDir: '/tmp/test-session-dir-2',
    sessionPhone: '905413749073',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  // store.chats is EMPTY (chats.size === 0)

  const manager = {
    _storeOf: () => store,
    _emit: (e) => emittedEvents.push(e),
    _ensureGroupSubjects: () => {},
    _scheduleBackgroundAvatarFetch: () => {},
    _scheduleAppStateRearm: () => {},
    _applyLidMapping: () => {},
  };

  const sessions = new Map([[session.id, session]]);

  bindSocketEvents({
    id: session.id,
    session,
    generation: 1,
    sock,
    state: { creds: {} },
    saveCreds: async () => {},
    connectStarted: Date.now(),
    sessionDir: '/tmp/test-session-dir-2',
    manager,
    sessions,
    emitEvent: (e) => emittedEvents.push(e),
    logger: {
      info: () => {},
      warn: (o, msg) => console.log('WARN:', o, msg),
      error: (o, msg) => console.log('ERROR:', o, msg),
      debug: () => {},
    },
  });

  // Trigger receivedPendingNotifications from Baileys
  ev.emit('connection.update', { receivedPendingNotifications: true });

  const notifEvent = emittedEvents.find((e) => e.event === 'session_notifications_received');
  assert.ok(notifEvent, 'session_notifications_received event should still be emitted');
  assert.equal(session._receivedPendingNotifications, true, '_receivedPendingNotifications flag is recorded');

  // Because chats.size === 0, session MUST NOT finalize after 1600ms!
  await new Promise((r) => setTimeout(r, 1600));

  assert.equal(session.sync.phase, 'syncing', 'Sync phase MUST remain syncing when 0 chats have arrived');
  const prematureEvent = emittedEvents.find((e) => e.event === 'session_sync_completed');
  assert.equal(prematureEvent, undefined, 'session_sync_completed must NEVER be emitted with 0 chats prematurely');
  console.log('ok - 2a: 0-chat session safely remained in syncing phase without premature empty finalization');

  // Now simulate WhatsApp delivering companion history chunk with 1 chat
  ev.emit('messaging-history.set', {
    chats: [{ id: '905555555555@s.whatsapp.net', name: 'Zeynep', unreadCount: 0 }],
    contacts: [],
    messages: [],
    isLatest: false,
    progress: 50,
  });

  // Wait for async handler microtasks to complete
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(store.chats.size, 1, 'Chat was ingested into store');
  assert.ok(session._historyQuietTimer, 'Quiet timer is now scheduled (1500ms) because chats arrived and pending notifications were ready');
  console.log('ok - 2b: history chunk arrival with pending notifications activated 1500ms quiet timer');

  // Wait for the accelerated timer (1600ms)
  await new Promise((r) => setTimeout(r, 1600));

  assert.equal(session.sync.phase, 'ready', 'Sync phase safely finalized to ready after chats arrived');
  const completedEvent = emittedEvents.find((e) => e.event === 'session_sync_completed');
  assert.ok(completedEvent, 'session_sync_completed emitted after chats were in place');
  console.log('ok - 2c: sync completed with chats intact');
}

console.log('[test-pending-notifications-sync] ALL checks passed successfully!');
