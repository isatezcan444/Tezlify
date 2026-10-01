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
 *
 * 2026-10-01 — the QR-window contract got STRONGER. "No doomed INSERT" is still
 * required, but "best effort only" is not: a best-effort event that the backend
 * could not receive was simply gone, and during a pairing the backend cannot
 * resolve an owner anyway (no session row). Such events are now HELD in a
 * bounded buffer and flushed into the durable queue at promotion. So step 2 now
 * expects the held event to be written — before the event that unblocked it.
 * Step 1's assertion (no write DURING the window) is unchanged and still the
 * point of the FK guard.
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
// The row exists now, so the event held from step 1 is flushed into the durable
// queue — and BEFORE the current event, preserving the original order.
sessions.set('eph-1', { id: 'eph-1', ephemeral: false, session_name: 'Hat 1' });
await emit({ event: 'session_connected', gateway_session_id: 'eph-1' });
assert.equal(
  enqueued.length,
  2,
  'promotion must flush the QR-window buffer into the durable path',
);
assert.deepEqual(
  enqueued.map((e) => e.event),
  ['session_qr_updated', 'session_connected'],
  'the held event must be written before the event that unblocked it',
);

// 3) Persistent sessions are unaffected.
sessions.set('per-1', { id: 'per-1', ephemeral: false, session_name: 'Hat 2' });
await emit({ event: 'message_new', gateway_session_id: 'per-1', message: { wa_message_id: 'w1' } });
assert.equal(enqueued.length, 3, 'a persistent session must use the durable path');

// 4) An unknown session id is still dropped before any write.
await emit({ event: 'conversation_updated', gateway_session_id: 'ghost' });
assert.equal(enqueued.length, 3, 'events for unknown/deleted sessions must not enqueue');

// 5) Several held events flush LOSSLESSLY and in order — the delivery gap this
// buffer exists to close is only closed if nothing is quietly dropped.
sessions.set('eph-2', { id: 'eph-2', ephemeral: true, session_name: 'Hat 3' });
for (const waId of ['a', 'b', 'c']) {
  await emit({
    event: 'message_new',
    gateway_session_id: 'eph-2',
    message: { wa_message_id: waId },
  });
}
assert.equal(enqueued.length, 3, 'no durable write for a session without a row');
sessions.set('eph-2', { id: 'eph-2', ephemeral: false, session_name: 'Hat 3' });
await emit({ event: 'session_connected', gateway_session_id: 'eph-2' });
assert.equal(enqueued.length, 7, 'three held events plus the promotion event');
assert.deepEqual(
  enqueued.slice(3).map((e) => e.event),
  ['message_new', 'message_new', 'message_new', 'session_connected'],
  'held events must flush in their original order, before the unblocking event',
);
assert.deepEqual(
  enqueued.slice(3, 6).map((e) => e.message.wa_message_id),
  ['a', 'b', 'c'],
  'not one held event may be lost in the flush',
);

bridge.close();
console.log(
  '[test-ephemeral-outbox-gate] ok - QR-window events are held (never written while unregistered) and flushed in order on promotion',
);
