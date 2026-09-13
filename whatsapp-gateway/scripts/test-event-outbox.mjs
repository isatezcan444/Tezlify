import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresEventOutbox } from '../src/outbox/postgres-event-outbox.js';

function createFakePool() {
  const rows = [];
  return {
    rows,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO whatsapp_private.event_outbox')) {
        if (!rows.some((row) => row.event_id === params[0])) {
          rows.push({
            sequence: rows.length + 1,
            event_id: params[0], session_id: params[1], event_type: params[2],
            ciphertext: params[3], nonce: params[4], auth_tag: params[5], key_version: params[6],
            state: 'PENDING', attempts: 0,
          });
        }
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith('WITH claimed AS')) {
        const claimed = rows.filter((row) => row.state === 'PENDING').slice(0, params[0]);
        for (const row of claimed) { row.state = 'IN_FLIGHT'; row.attempts += 1; }
        return { rowCount: claimed.length, rows: claimed };
      }
      if (normalized.includes("SET state = 'DELIVERED'")) {
        const row = rows.find((item) => item.event_id === params[0]);
        if (row) row.state = 'DELIVERED';
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      if (normalized.includes("SET state = CASE WHEN")) {
        const row = rows.find((item) => item.event_id === params[0]);
        if (row) row.state = params[1] ? 'DEAD_LETTER' : 'PENDING';
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      if (normalized.includes("SET state = 'PENDING'")) {
        for (const row of rows) if (row.state === 'IN_FLIGHT') row.state = 'PENDING';
        return { rowCount: rows.length, rows: [] };
      }
      if (normalized.startsWith('WITH doomed AS')) return { rowCount: 0, rows: [] };
      if (normalized.startsWith('DELETE FROM whatsapp_private.processed_events')) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    async end() {},
  };
}

const pool = createFakePool();
const outbox = createPostgresEventOutbox({ encryptionKey: crypto.randomBytes(32), pool });
const event = {
  event: 'message_new',
  gateway_session_id: 'stable-session-id',
  message: { body: 'private message', wa_message_id: 'wa-1' },
};

const durable = await outbox.enqueue(event);
assert.match(durable.event_id, /^[0-9a-f-]{36}$/);
assert.equal(pool.rows.length, 1);
assert.equal(pool.rows[0].ciphertext.includes(Buffer.from('private message')), false);

const firstClaim = await outbox.claimPending(10);
assert.equal(firstClaim.length, 1);
assert.deepEqual(firstClaim[0].event, durable);
assert.equal(firstClaim[0].attempts, 1);

await outbox.reject(durable.event_id);
assert.equal(pool.rows[0].state, 'PENDING');
const replay = await outbox.claimPending(10);
assert.equal(replay[0].event.event_id, durable.event_id);
assert.equal(replay[0].attempts, 2);

await outbox.acknowledge(durable.event_id);
assert.equal(pool.rows[0].state, 'DELIVERED');
assert.deepEqual(await outbox.claimPending(10), []);

console.log('[test-event-outbox] 11 assertions passed');
