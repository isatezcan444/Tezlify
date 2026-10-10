import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bindSocketEvents } from '../src/socket/socket-events.js';

console.log('[test-pending-notifications-sync] starting tests...');

const ev = new EventEmitter();
const emittedEvents = [];

const sock = {
  ev,
  user: { id: '905413749073:1@s.whatsapp.net' },
  sendPresenceUpdate: async () => {},
};

const session = {
  id: 'test-session-123',
  session_name: 'Test Hat',
  lifecycle: {
    generation: 1,
    isCurrent: (gen, s) => gen === 1 && s === sock,
  },
  status: 'CONNECTED',
  sync: {
    phase: 'syncing',
    progress: 10,
    chats_synced: 3,
    messages_synced: 12,
  },
  _diagnosticAuthUpdates: 0,
};

import { createSessionStore } from '../src/messages/message-store.js';

const store = createSessionStore({
  sessionDir: '/tmp/test-session-dir',
  sessionPhone: '905413749073',
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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
  sessionDir: '/tmp/test-session-dir',
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

// Initial state check
assert.equal(session.sync.phase, 'syncing');

// Trigger receivedPendingNotifications from Baileys
ev.emit('connection.update', { receivedPendingNotifications: true });

// Check that notifications received event was emitted
const notifEvent = emittedEvents.find((e) => e.event === 'session_notifications_received');
assert.ok(notifEvent, 'session_notifications_received event should be emitted');
assert.equal(notifEvent.session_id, session.id);
console.log('ok - 1: session_notifications_received emitted on Baileys signal');

// Check that quiet timer was accelerated (is active)
assert.ok(session._historyQuietTimer, 'Quiet timer should be scheduled for rapid completion');
console.log('ok - 2: quiet timer scheduled with accelerated window');

// Wait for the accelerated timer (1600ms)
await new Promise((r) => setTimeout(r, 1600));

// Check that history sync finalized
assert.equal(session.sync.phase, 'ready', 'Sync phase should be finalized to ready');
assert.equal(session.sync.progress, 100, 'Sync progress should be 100%');

const completedEvent = emittedEvents.find((e) => e.event === 'session_sync_completed');
assert.ok(completedEvent, 'session_sync_completed event should be emitted');
console.log('ok - 3: history sync transitioned to ready and session_sync_completed emitted');

console.log('[test-pending-notifications-sync] ALL 3 checks passed successfully!');
