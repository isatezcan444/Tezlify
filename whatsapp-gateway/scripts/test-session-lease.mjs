import assert from 'node:assert/strict';
import { createPostgresSessionLease } from '../src/lease/postgres-session-lease.js';

function createFakePool() {
  const leases = new Map();
  return {
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO whatsapp_private.socket_leases')) {
        const current = leases.get(params[0]);
        if (current && current.instanceId !== params[1] && !current.expired) {
          return { rowCount: 0, rows: [] };
        }
        leases.set(params[0], { instanceId: params[1], generation: params[2], expired: false });
        return { rowCount: 1, rows: [{ session_id: params[0] }] };
      }
      if (normalized.startsWith('UPDATE whatsapp_private.socket_leases')) {
        const current = leases.get(params[0]);
        const matches = current?.instanceId === params[1] && current?.generation === params[2];
        return { rowCount: matches ? 1 : 0, rows: matches ? [{ session_id: params[0] }] : [] };
      }
      if (normalized.startsWith('DELETE FROM whatsapp_private.socket_leases')) {
        const current = leases.get(params[0]);
        if (current?.instanceId === params[1]) leases.delete(params[0]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    async end() {},
  };
}

const pool = createFakePool();
const lease = createPostgresSessionLease({ pool, ttlSeconds: 45 });

assert.equal(await lease.acquire('session-a', 'instance-1', 1), true);
assert.equal(await lease.acquire('session-a', 'instance-2', 1), false);
assert.equal(await lease.acquire('session-a', 'instance-1', 2), true);
assert.equal(await lease.renew('session-a', 'instance-1', 1), false);
assert.equal(await lease.renew('session-a', 'instance-1', 2), true);
await lease.release('session-a', 'instance-1');
assert.equal(await lease.acquire('session-a', 'instance-2', 1), true);
assert.equal(lease.ttlSeconds, 45);

console.log('[test-session-lease] 7 assertions passed');
