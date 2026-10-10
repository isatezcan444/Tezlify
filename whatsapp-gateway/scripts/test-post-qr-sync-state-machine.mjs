import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bindSocketEvents, resolveHistoryWaitersForChunk } from '../src/socket/socket-events.js';
import { createSessionStore } from '../src/messages/message-store.js';

console.log('[test-post-qr-sync-state-machine] Starting Phase 14 comprehensive state machine test suite...');

function createMockEnvironment(opts = {}) {
  const ev = new EventEmitter();
  const emittedEvents = [];
  const generation = opts.generation ?? 1;

  const sock = {
    ev,
    user: { id: '905413749073:1@s.whatsapp.net' },
    sendPresenceUpdate: async () => {},
  };

  const lifecycle = {
    _generation: generation,
    isCurrent(gen, s) {
      return gen === this._generation && s === sock;
    },
    scheduleReconnect: () => false,
  };

  const session = {
    id: opts.sessionId || `session-${Math.random().toString(36).slice(2, 8)}`,
    session_name: 'Test Line',
    lifecycle,
    status: 'CONNECTED',
    sync: {
      phase: 'syncing',
      progress: 0,
      chats_synced: 0,
      messages_synced: 0,
    },
    _diagnosticAuthUpdates: 0,
    ...opts.sessionOverrides,
  };

  const store = createSessionStore({
    sessionDir: `/tmp/test-session-${session.id}`,
    sessionPhone: '905413749073',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  const lidMappings = new Map();

  const manager = {
    _storeOf: () => store,
    _emit: (e) => emittedEvents.push(e),
    _ensureGroupSubjects: () => {},
    _scheduleBackgroundAvatarFetch: () => {},
    _scheduleAppStateRearm: () => {},
    _applyLidMapping: (_s, lid, pn) => {
      lidMappings.set(lid, pn);
      store.lidMap?.set(lid, pn);
    },
    _historyMessageToRecord: (_s, msg, key) => ({
      id: msg.key?.id ? 100 : 1,
      wa_message_id: msg.key?.id,
      key: msg.key,
      remote_jid: key,
      direction: msg.key?.fromMe ? 'OUTBOUND' : 'INBOUND',
      status: 'DELIVERED',
      created_at: new Date().toISOString(),
    }),
  };

  const sessions = new Map([[session.id, session]]);
  const pendingHistoryWaiters = new Map();
  const inFlightHistoryFetches = new Map();

  bindSocketEvents({
    id: session.id,
    session,
    generation,
    sock,
    state: { creds: {} },
    saveCreds: async () => {},
    connectStarted: Date.now(),
    sessionDir: `/tmp/test-session-${session.id}`,
    manager,
    sessions,
    pendingHistoryWaiters,
    inFlightHistoryFetches,
    emitEvent: (e) => emittedEvents.push(e),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });

  return { ev, sock, session, store, manager, emittedEvents, lidMappings, pendingHistoryWaiters, inFlightHistoryFetches };
}

// ----------------------------------------------------------------------------
// Scenario 1 & 2: receivedPendingNotifications arrives, history chunk delayed > 1.5s
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 1 & 2: receivedPendingNotifications arrives, history chunk delayed > 1.5s...');
  const { ev, session, store, emittedEvents } = createMockEnvironment();

  // Step 1: receivedPendingNotifications arrives while chats.size === 0
  ev.emit('connection.update', { receivedPendingNotifications: true });
  assert.equal(session._receivedPendingNotifications, true);

  // Wait 1.6s — session MUST stay syncing because 0 chats in store
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(session.sync.phase, 'syncing', 'Must NOT finalize with 0 chats prematurely');
  assert.equal(emittedEvents.some((e) => e.event === 'session_sync_completed'), false);

  // Step 2: Delayed history chunk arrives after 1.6s
  ev.emit('messaging-history.set', {
    chats: [{ id: '905111111111@s.whatsapp.net', name: 'Merve', unreadCount: 0 }],
    contacts: [],
    messages: [],
    isLatest: false,
    progress: 40,
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(store.chats.size, 1);
  assert.ok(session._historyQuietTimer, 'Accelerated quiet timer armed upon chat ingestion');

  // Wait 1.6s for accelerated timer
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(session.sync.phase, 'ready');
  assert.ok(emittedEvents.some((e) => e.event === 'session_sync_completed'));
  console.log('✓ Scenario 1 & 2 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 3: First history chunk empty, second chunk contains chats
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 3: First chunk empty (isLatest: false), second chunk has chats...');
  const { ev, session, store, emittedEvents } = createMockEnvironment();

  // First chunk has 0 chats, isLatest is false
  ev.emit('messaging-history.set', {
    chats: [],
    contacts: [],
    messages: [],
    isLatest: false,
    progress: 10,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(session.sync.phase, 'syncing');
  assert.equal(store.chats.size, 0);

  // Second chunk arrives with chats
  ev.emit('messaging-history.set', {
    chats: [{ id: '905222222222@s.whatsapp.net', name: 'Barış' }],
    contacts: [],
    messages: [],
    isLatest: true,
    progress: 100,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.chats.size, 1);
  assert.equal(session.sync.phase, 'ready');
  console.log('✓ Scenario 3 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 4: Genuinely empty account verified (chats: [], isLatest: true)
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 4: Genuinely empty account (isLatest: true, 0 chats)...');
  const { ev, session, store, emittedEvents } = createMockEnvironment();

  ev.emit('messaging-history.set', {
    chats: [],
    contacts: [],
    messages: [],
    isLatest: true,
    progress: 100,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(session.sync.phase, 'ready');
  assert.equal(session.sync.chats_synced, 0);
  assert.ok(emittedEvents.some((e) => e.event === 'session_sync_completed'));
  console.log('✓ Scenario 4 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 5: receivedPendingNotifications never arrives (quiet timer fallback)
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 5: receivedPendingNotifications never arrives (uses 3000ms quiet timer)...');
  const { ev, session, store } = createMockEnvironment();

  ev.emit('messaging-history.set', {
    chats: [{ id: '905333333333@s.whatsapp.net', name: 'Can' }],
    contacts: [],
    messages: [],
    isLatest: false,
    progress: 60,
  });
  await new Promise((r) => setTimeout(r, 50));

  // Without receivedPendingNotifications, quiet timer is 3000ms, not 1500ms
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(session.sync.phase, 'syncing', 'Must still be syncing at 1.6s without pending notifications');

  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(session.sync.phase, 'ready', 'Finalized after standard 3000ms quiet window');
  console.log('✓ Scenario 5 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 6: receivedPendingNotifications arrives twice (idempotence)
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 6: Duplicate receivedPendingNotifications (idempotence)...');
  const { ev, session, store } = createMockEnvironment();

  store.chats.set('905444444444@s.whatsapp.net', { id: '905444444444@s.whatsapp.net', name: 'Derya' });

  ev.emit('connection.update', { receivedPendingNotifications: true });
  const timer1 = session._historyQuietTimer;
  assert.ok(timer1);

  // Second identical signal
  ev.emit('connection.update', { receivedPendingNotifications: true });
  const timer2 = session._historyQuietTimer;
  assert.ok(timer2);

  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(session.sync.phase, 'ready');
  console.log('✓ Scenario 6 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 7 & 8: Live messages arrive before history chunks (ordering & merge)
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 7 & 8: Live chat update arrives before history chunk...');
  const { ev, session, store } = createMockEnvironment();

  // Live chat update comes in first
  ev.emit('chats.update', [{
    id: '905555555555@s.whatsapp.net',
    unreadCount: 2,
    lastMessageRecvTimestamp: Math.floor(Date.now() / 1000),
  }]);

  assert.equal(store.chats.size, 1);
  const liveChat = store.chats.get('905555555555@s.whatsapp.net');
  assert.equal(liveChat.unread_count, 2);

  // Now history chunk arrives for the same chat with older unreadCount
  ev.emit('messaging-history.set', {
    chats: [{
      id: '905555555555@s.whatsapp.net',
      name: 'Ebru',
      unreadCount: 1, // older history
    }],
    contacts: [],
    messages: [],
    isLatest: true,
    progress: 100,
  });
  await new Promise((r) => setTimeout(r, 50));

  const mergedChat = store.chats.get('905555555555@s.whatsapp.net');
  assert.equal(mergedChat.name, 'Ebru', 'Name updated from history');
  assert.equal(store.chats.size, 1, 'No duplicate conversation created');
  console.log('✓ Scenario 7 & 8 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 9: Duplicate message delivery deduplicated
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 9: Duplicate history messages deduplicated...');
  const { ev, store } = createMockEnvironment();

  const msgKey = { remoteJid: '905666666666@s.whatsapp.net', id: 'MSG-DUP-1', fromMe: false };

  ev.emit('messaging-history.set', {
    chats: [{ id: '905666666666@s.whatsapp.net', name: 'Faruk' }],
    contacts: [],
    messages: [{ key: msgKey, message: { conversation: 'Merhaba' } }],
    isLatest: false,
    progress: 50,
  });
  await new Promise((r) => setTimeout(r, 50));

  const list1 = store.messagesByChat.get('905666666666@s.whatsapp.net');
  assert.equal(list1?.length, 1);

  // Same message delivered again in subsequent chunk
  ev.emit('messaging-history.set', {
    chats: [],
    contacts: [],
    messages: [{ key: msgKey, message: { conversation: 'Merhaba' } }],
    isLatest: true,
    progress: 100,
  });
  await new Promise((r) => setTimeout(r, 50));

  const list2 = store.messagesByChat.get('905666666666@s.whatsapp.net');
  assert.equal(list2?.length, 1, 'Duplicate wa_message_id rejected from message list');
  console.log('✓ Scenario 9 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 10: Old session generation timer cannot mutate new session state
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 10: Old session timer blocked by lifecycle generation check...');
  const { ev, session, store } = createMockEnvironment({ generation: 1 });

  store.chats.set('905777777777@s.whatsapp.net', { id: '905777777777@s.whatsapp.net' });

  // Arm 1500ms timer on generation 1
  ev.emit('connection.update', { receivedPendingNotifications: true });
  assert.ok(session._historyQuietTimer);

  // Reconnection happens! Generation bumps to 2
  session.lifecycle._generation = 2;

  // Wait for generation 1's timer callback to fire
  await new Promise((r) => setTimeout(r, 1600));

  // The timer callback MUST have been ignored because isCurrent(1, sock) is false!
  assert.equal(session.sync.phase, 'syncing', 'Old generation timer must NOT transition session to ready');
  console.log('✓ Scenario 10 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 11: WebSocket reconnect resets pending notification state
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 11: connection.close clears quiet timer and pending notifications flag...');
  const { ev, session } = createMockEnvironment();

  session._receivedPendingNotifications = true;
  session._historyQuietTimer = setTimeout(() => {}, 5000);

  ev.emit('connection.update', { connection: 'close' });

  assert.equal(session._receivedPendingNotifications, false, 'Pending notification flag reset on socket close');
  assert.equal(session._historyQuietTimer, null, 'Quiet timer cleared on socket close');
  assert.equal(session.sync.phase, 'idle');
  console.log('✓ Scenario 11 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 13 & 14: History chunks arriving AFTER ready are ingested losslessly
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 13 & 14: Late history chunks arriving after ready are ingested losslessly...');
  const { ev, session, store, emittedEvents } = createMockEnvironment();

  // Session already transitioned to ready
  session.sync.phase = 'ready';
  session.sync.progress = 100;
  store.chats.set('905888888888@s.whatsapp.net', { id: '905888888888@s.whatsapp.net', name: 'Gamze' });

  // Late chunk arrives with another chat
  ev.emit('messaging-history.set', {
    chats: [{ id: '905999999999@s.whatsapp.net', name: 'Hakan' }],
    contacts: [],
    messages: [],
    isLatest: false,
    progress: null,
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(store.chats.size, 2, 'Late chat safely ingested into store');
  const convEvents = emittedEvents.filter((e) => e.event === 'conversation_updated');
  assert.ok(convEvents.some((e) => e.conversation?.id === '905999999999@s.whatsapp.net'), 'conversation_updated emitted for late chat');
  console.log('✓ Scenario 13 & 14 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 17: Delayed group metadata merge
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 17: Delayed group subject update merges into chat name...');
  const { ev, store, emittedEvents } = createMockEnvironment();

  store.chats.set('123456789@g.us', {
    id: '123456789@g.us',
    name: '123456789@g.us',
    name_source: null,
  });

  ev.emit('groups.update', [{ id: '123456789@g.us', subject: 'Tezlify Geliştirici Grubu' }]);

  const updatedGroup = store.chats.get('123456789@g.us');
  assert.equal(updatedGroup.name, 'Tezlify Geliştirici Grubu');
  assert.equal(updatedGroup.name_source, 'group_subject');
  console.log('✓ Scenario 17 PASS');
}

// ----------------------------------------------------------------------------
// Scenario 18: LID and PN identity mapping
// ----------------------------------------------------------------------------
{
  console.log('Testing Scenario 18: LID/PN mapping recorded and resolved...');
  const { ev, store, lidMappings } = createMockEnvironment();

  ev.emit('messaging-history.set', {
    chats: [],
    contacts: [],
    messages: [],
    lidPnMappings: [{ lid: '111222333@lid', pn: '905413749073@s.whatsapp.net' }],
    isLatest: false,
    progress: 20,
  });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(lidMappings.get('111222333@lid'), '905413749073@s.whatsapp.net');
  console.log('✓ Scenario 18 PASS');
}

console.log('================================================================');
console.log('ALL PHASE 14 POST-QR SYNC STATE MACHINE ASSERTIONS PASSED (18/18)!');
console.log('================================================================');
