/**
 * An ephemeral (No-Create) pairing must never attempt a durable outbox write.
 *
 * PRODUCTION 2026-09-30: the PostgreSQL log held 24 ×
 *   ERROR: insert or update on table "event_outbox" violates foreign key
 *          constraint "event_outbox_session_id_fkey"
 * — every one of them a QR-window event of an ephemeral session, plus 8 × the
 * identical `lid_mappings_session_id_fkey` failure.
 *
 * Root cause: `createSession` deliberately skips `registerSession` (and the
 * lease) for an ephemeral pairing so a No-Create QR attempt writes no
 * `gateway_sessions` row until `connection.open` promotes it. The outbox had no
 * such guard, so its INSERT could never satisfy the FK. The catch already fell
 * back to `deliverBestEffort`, so nothing was lost while the bridge was up —
 * but each event paid a failed statement, and the log looked like a storage
 * outage. The gate now mirrors the registerSession / lease boundary.
 *
 * This drives the REAL `createEventBridge` with a fake session registry and a
 * counting outbox: ephemeral events must reach the non-durable path WITHOUT an
 * enqueue attempt, and the same session must use the durable path the moment
 * promotion flips `ephemeral` to false.
 */
import assert from 'node:assert/strict';
import { createEventBridge } from '../src/events.js';

const sessions = new Map();
const listeners = [];
const sessionManager = {
  getSession: (id) => sessions.get(String(id)) || null,
  onEvent: (fn) => {
    listeners.push(fn);
    return () => {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    };
  },
  listSessions: () => [...sessions.values()],
};

const enqueued = [];
const outbox = {
  async enqueue(event) {
    enqueued.push(event);
    return { ...event, event_id: `e${enqueued.length}` };
  },
  async claimPending() {
    return [];
  },
  async cleanup() {
    return 0;
  },
};

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// Port 1 is closed on purpose: the bridge fails to connect and buffers
// best-effort, which is exactly the non-durable path under test. `close()`
// below clears every timer, so the process exits.
const bridge = createEventBridge({
  backendWsUrl: 'ws://127.0.0.1:1/',
  sessionManager,
  eventOutbox: outbox,
});

const emit = async (event) => {
  for (const listener of listeners) listener(event);
  await settle();
};

// 1) Ephemeral: QR-window events must bypass the outbox entirely.
sessions.set('eph-1', { id: 'eph-1', ephemeral: true, session_name: 'Hat 1' });
await emit({ event: 'session_qr_updated', gateway_session_id: 'eph-1', qr_code: 'QR' });
assert.equal(enqueued.length, 0, 'an ephemeral session must not touch the outbox');

// 2) Promotion: session-manager sets `ephemeral = false` on connection.open.
sessions.set('eph-1', { id: 'eph-1', ephemeral: false, session_name: 'Hat 1' });
await emit({ event: 'session_connected', gateway_session_id: 'eph-1' });
assert.equal(enqueued.length, 1, 'a promoted session must use the durable path');

// 3) Persistent sessions are unaffected.
sessions.set('per-1', { id: 'per-1', ephemeral: false, session_name: 'Hat 2' });
await emit({ event: 'message_new', gateway_session_id: 'per-1', message: { wa_message_id: 'w1' } });
assert.equal(enqueued.length, 2, 'a persistent session must use the durable path');

// 4) An unknown session id is still dropped before any write.
await emit({ event: 'conversation_updated', gateway_session_id: 'ghost' });
assert.equal(enqueued.length, 2, 'events for unknown/deleted sessions must not enqueue');

bridge.close();
console.log(
  '[test-ephemeral-outbox-gate] ok - QR-window events bypass the outbox; promotion restores durability',
);
