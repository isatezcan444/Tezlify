/**
 * Phase 6.6 §3 — the ephemeral/lease fix against REAL PostgreSQL.
 *
 * `test-phase6-5-ephemeral-lease.mjs` proves the fix against a fake pool that
 * imitates the adapter's three statements. That is a good unit test but it is
 * NOT primary evidence: a fake pool cannot catch a wrong SQL predicate, a
 * column type mismatch, or a constraint. This file runs the REAL
 * `createPostgresSessionLease` against a REAL PostgreSQL server, so the
 * `rowCount` values that drive `loseLease()` are the server's own.
 *
 * It also documents a constraint the fake pool provably cannot model:
 * `socket_leases.session_id` has a FOREIGN KEY to
 * `whatsapp_private.gateway_sessions(session_id)`. `INSERT` (acquire) therefore
 * fails with SQLSTATE 23503 for a session with no `gateway_sessions` row, while
 * `UPDATE` (renew) is simply a no-op returning rowCount 0 — which is exactly
 * why the ephemeral bug surfaced as a silent lease loss rather than a loud FK
 * error.
 *
 * Gate it on a connection string; without one the file skips:
 *
 *   GATEWAY_LEASE_TEST_URL=postgresql://user@localhost:5432/db \
 *     node scripts/test-phase6-6-lease-real-pg.mjs
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHarness, settle, cleanupHarness } from './pairing-harness.mjs';
import { createPostgresSessionLease } from '../src/lease/postgres-session-lease.js';

const CONNECTION = (process.env.GATEWAY_LEASE_TEST_URL || '').trim();
if (!CONNECTION) {
  console.log('[test-phase6-6-lease-real-pg] SKIPPED (set GATEWAY_LEASE_TEST_URL)');
  process.exit(0);
}

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = new pg.Pool({ connectionString: CONNECTION, max: 2 });

// The adapter clamps ttl to [30,120] -> renewal interval max(10_000, ttl/3) = 10s.
const TTL_SECONDS = 30;
const RENEWAL_MS = 10_000;
const lease = createPostgresSessionLease({ connectionString: CONNECTION, ttlSeconds: TTL_SECONDS });

const RUN = Date.now().toString(36);
const sid = (n) => `realpg-${RUN}-${n}`;

const leaseRow = async (id) => {
  const r = await admin.query(
    'SELECT session_id, instance_id, generation, expires_at FROM whatsapp_private.socket_leases WHERE session_id = $1',
    [String(id)],
  );
  return r.rows[0] || null;
};
const clearLease = async (id) => {
  await admin.query('DELETE FROM whatsapp_private.socket_leases WHERE session_id = $1', [String(id)]);
};
/**
 * What `authRepository.registerSession()` does when durable auth is configured
 * (production always has it). The harness runs with `authRepository: null`, so
 * the test stands in for it — otherwise `acquire` would fail the FK.
 */
const seedGatewaySession = async (id, name = 'realpg') => {
  await admin.query(
    `INSERT INTO whatsapp_private.gateway_sessions (session_id, session_name, is_active)
     VALUES ($1, $2, true) ON CONFLICT (session_id) DO NOTHING`,
    [String(id), name],
  );
};
const dropGatewaySession = async (id) => {
  await admin.query('DELETE FROM whatsapp_private.gateway_sessions WHERE session_id = $1', [String(id)]);
};

console.log(`[test-phase6-6-lease-real-pg] target: ${CONNECTION.replace(/:[^:@/]*@/, ':***@')}`);

// ------------------------------------------- the FK the fake pool cannot model
{
  const id = sid('fk');
  await clearLease(id);
  await dropGatewaySession(id);
  let err = null;
  try { await lease.acquire(id, 'inst-1', 1); } catch (e) { err = e; }
  assert.ok(err, 'acquire must FAIL when no gateway_sessions row exists (real FK)');
  assert.equal(err.code, '23503', `expected FK violation 23503, got ${err.code}`);
  assert.equal(
    await lease.renew(id, 'inst-1', 1), false,
    'renew on a missing row must be a silent false, never an error',
  );
  ok('socket_leases -> gateway_sessions FK is real; renew stays a silent false');
}

// ---------------------------------------------- the adapter, against real SQL
{
  const id = sid('contract');
  await clearLease(id);
  await seedGatewaySession(id, 'realpg-contract');
  assert.equal(await lease.renew(id, 'inst-1', 1), false, 'renew of a nonexistent row must be false');
  assert.equal(await lease.acquire(id, 'inst-1', 1), true, 'first acquire must win');
  assert.equal(await lease.acquire(id, 'inst-2', 1), false, 'a live lease must not be stolen');
  assert.equal(await lease.renew(id, 'inst-1', 1), true, 'the holder must be able to renew');
  assert.equal(await lease.renew(id, 'inst-1', 99), false, 'a stale generation must not renew');
  assert.equal((await leaseRow(id)).instance_id, 'inst-1');
  await lease.release(id, 'inst-1');
  assert.equal(await leaseRow(id), null, 'release must delete the row');
  await dropGatewaySession(id);
  ok('the real adapter acquire/renew/release round-trips against PostgreSQL');
}

// --------------------------- ephemeral pairing must survive one renewal interval
// Faithful to production: an ephemeral pairing has NO gateway_sessions row and
// therefore cannot hold a lease at all.
const ephId = sid('eph');
await clearLease(ephId);
await dropGatewaySession(ephId);

const hEph = await createHarness({ leaseRepository: lease, instanceId: 'realpg-instance' });
const ephSession = await hEph.manager.createSession('realpg-eph', { id: ephId, ephemeral: true });
const ephSock = await hEph.nextSocket('realpg ephemeral socket');
await hEph.connectionUpdate(ephSock, { qr: 'QR-REALPG-EPH' });
await settle();

{
  assert.ok(hEph.manager.getSession(ephSession.id).qr_code, 'precondition: ephemeral QR painted');
  assert.equal(await leaseRow(ephSession.id), null, 'an ephemeral pairing must hold no lease row');
  assert.equal(
    hEph.manager.getSession(ephSession.id)._leaseRenewTimer, null,
    'an ephemeral pairing must arm no renewal timer',
  );
  ok('an ephemeral pairing with no gateway_sessions row holds no lease and arms no timer');
}

// A session that DID take a lease must arm renewal and keep the row alive.
const perId = sid('per');
await clearLease(perId);
await seedGatewaySession(perId, 'realpg-per');

const hPer = await createHarness({ leaseRepository: lease, instanceId: 'realpg-instance' });
const perSession = await hPer.manager.createSession('realpg-per', { id: perId, ephemeral: false });
const perSock = await hPer.nextSocket('realpg persistent socket');
await hPer.connectionUpdate(perSock, { qr: 'QR-REALPG-PER' });
await settle();

let expiresBefore = null;
{
  assert.ok(hPer.manager.getSession(perSession.id).qr_code, 'precondition: persistent QR painted');
  const row = await leaseRow(perSession.id);
  assert.ok(row, 'a persistent session must hold a real lease row');
  assert.equal(row.instance_id, 'realpg-instance');
  expiresBefore = row.expires_at;
  assert.notEqual(
    hPer.manager.getSession(perSession.id)._leaseRenewTimer, null,
    'a persistent session must arm renewal',
  );
  ok('a persistent session holds a real lease row and arms renewal');
}

await sleep(RENEWAL_MS + 1_500);

{
  // THE REGRESSION: with the pre-fix unconditional arming, the ephemeral
  // session is UNAVAILABLE / WHATSAPP_SESSION_LEASE_LOST by now.
  const eph = hEph.manager.getSession(ephSession.id);
  assert.notEqual(eph.status, 'UNAVAILABLE', 'the ephemeral pairing was killed by a phantom renewal');
  assert.notEqual(eph.error_message, 'WHATSAPP_SESSION_LEASE_LOST');
  assert.equal(ephSock.ended, false, 'the ephemeral socket must not be torn down');
  assert.equal(await leaseRow(ephSession.id), null, 'and it must still hold no lease row');
  ok(`an ephemeral pairing survives one real renewal interval (${RENEWAL_MS}ms)`);

  // The persistent session's row must have been RENEWED — expires_at advanced.
  const row = await leaseRow(perSession.id);
  assert.ok(row, 'the persistent lease row must still exist');
  assert.ok(
    new Date(row.expires_at) > new Date(expiresBefore),
    `renewal must advance expires_at in the real DB (before=${new Date(expiresBefore).toISOString()} after=${new Date(row.expires_at).toISOString()})`,
  );
  assert.notEqual(hPer.manager.getSession(perSession.id).status, 'UNAVAILABLE');
  ok('a persistent session renews its real lease row (expires_at advanced)');
}

// ------------------------------------- promotion takes and renews a REAL lease
{
  const id = sid('promote');
  await clearLease(id);
  // registerSession() would have created this row at promotion time; the harness
  // has no authRepository, so seed it as the equivalent precondition.
  await seedGatewaySession(id, 'realpg-promote');

  const h = await createHarness({ leaseRepository: lease, instanceId: 'realpg-instance' });
  const session = await h.manager.createSession('realpg-promote', { id, ephemeral: true });
  const sock = await h.nextSocket('realpg promotion socket');
  await h.connectionUpdate(sock, { qr: 'QR-REALPG-PROMOTE' });
  await settle();
  assert.equal(await leaseRow(session.id), null, 'precondition: no lease before promotion');
  assert.equal(h.manager.getSession(session.id)._leaseRenewTimer, null);

  sock.completePairing();
  await h.credsUpdate(sock);
  await h.connectionUpdate(sock, { connection: 'open' });
  await settle(10);

  const promoted = h.manager.getSession(session.id);
  assert.equal(promoted.status, 'CONNECTED', 'the pairing must complete');
  assert.equal(promoted.ephemeral, false, 'the session must be promoted');
  const row = await leaseRow(session.id);
  assert.ok(row, 'promotion must take a real lease row');
  assert.equal(row.instance_id, 'realpg-instance');
  assert.notEqual(
    promoted._leaseRenewTimer, null,
    'promotion must arm renewal for the lease it just acquired',
  );
  ok('a promoted pairing takes a real lease row and arms renewal');
  await clearLease(session.id);
  await dropGatewaySession(session.id);
}

// cleanup
await clearLease(ephSession.id);
await clearLease(perSession.id);
await dropGatewaySession(ephSession.id);
await dropGatewaySession(perSession.id);
await lease.close();
await admin.end();

console.log(`\n[test-phase6-6-lease-real-pg] ${checks} checks passed`);
await cleanupHarness();
process.exit(0);
