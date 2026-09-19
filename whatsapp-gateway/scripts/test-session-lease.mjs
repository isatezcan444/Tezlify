import assert from 'node:assert/strict';
import { createPostgresSessionLease } from '../src/lease/postgres-session-lease.js';
import { createFakeLeasePool } from './fake-lease-pool.mjs';

const pool = createFakeLeasePool();
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
