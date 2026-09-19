/**
 * Phase 6.5 — an ephemeral pairing must never lose a lease it never acquired.
 *
 * THE DEFECT THIS LOCKS DOWN
 * --------------------------
 * `_connectSocket` deliberately skips `leaseRepository.acquire()` for an
 * ephemeral pairing (`if (leaseRepository && !session.ephemeral)`), because the
 * lease belongs to the *persistent* session that a completed pairing is
 * promoted into. But the renewal timer was armed with a bare
 * `if (leaseRepository)`, so it also ran for sessions holding no row.
 *
 * The first tick then called `renew()` on a nonexistent row; the adapter's
 * `return result.rowCount === 1` yielded false; `loseLease()` invalidated the
 * socket lifecycle and set `status = 'UNAVAILABLE'`,
 * `error_message = 'WHATSAPP_SESSION_LEASE_LOST'`. At the production TTL of 45s
 * the interval is TTL/3 = 15s, so the pairing died ~15s after the socket opened
 * — BEFORE WhatsApp ever emitted a QR.
 *
 * Production evidence (gateway revision f6ec68d, 2026-09-19): four ephemeral
 * pairings, zero `session_qr_updated` events, four `socket_lease_lost`, and
 * socket_connect_started -> socket_lease_lost gaps of 15040 / 15058 / 15042 ms
 * (i.e. exactly one interval). `socket_leases` held a row for the CONNECTED
 * session only.
 *
 * Only `makeWASocket` is faked. The session manager, its socket lifecycle /
 * generation guard, the lease adapter and the in-memory pool are all real.
 */
import assert from 'node:assert/strict';
import { createHarness, settle, cleanupHarness } from './pairing-harness.mjs';
import { createFakeLeasePool } from './fake-lease-pool.mjs';
import { createPostgresSessionLease } from '../src/lease/postgres-session-lease.js';

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TTL 15s -> renewal interval = max(10_000, TTL/3) = 10_000ms.
// The floor is a production constant, so the wait below is one interval + margin.
const pool = createFakeLeasePool();
const lease = createPostgresSessionLease({ pool, ttlSeconds: 15 });
const RENEWAL_MS = 10_000;
const PAST_ONE_INTERVAL_MS = RENEWAL_MS + 1_500;

// ---------------------------------------------------------------- mechanism
// The premise of the whole defect: renewing a lease that was never acquired
// reports false. If this ever became true, the defect could not exist.
{
  assert.equal(
    await lease.renew('never-acquired', 'test-instance', 1), false,
    'renewing a session with no lease row must report false',
  );
  assert.equal(pool.calls.renew, 1);
  ok('the lease adapter reports renew() === false for a row that does not exist');
}

// ------------------------------------------- ephemeral pairing + live lease
// The harnesses are created SEQUENTIALLY, and each session is driven to a
// presenting QR before the next harness exists. `createHarness` seeds its
// socket cursor from the global registry length at construction time, so two
// harnesses built before any socket exists would both start at cursor 0 and
// `nextSocket()` would hand the SAME socket to each — silently testing one
// session twice.
const hEph = await createHarness({ leaseRepository: lease });
const ephSession = await hEph.manager.createSession('eph-lease', { ephemeral: true });
const ephSock = await hEph.nextSocket('ephemeral pairing socket');
await hEph.connectionUpdate(ephSock, { qr: 'QR-EPHEMERAL' });
await settle();

const hPer = await createHarness({ leaseRepository: lease });
const perSession = await hPer.manager.createSession('per-lease', { ephemeral: false });
const perSock = await hPer.nextSocket('persistent session socket');
await hPer.connectionUpdate(perSock, { qr: 'QR-PERSISTENT' });
await settle();

assert.notEqual(ephSock, perSock, 'each harness must be driving its own socket');
// A presenting QR proves the socket was attached and its handlers registered,
// which happens AFTER the renewal decision — so the timer state below is final.
assert.ok(hEph.manager.getSession(ephSession.id).qr_code, 'precondition: ephemeral QR painted');
assert.ok(hPer.manager.getSession(perSession.id).qr_code, 'precondition: persistent QR painted');

// -- structural: the timer must not be armed for a lease we do not hold.
{
  const eph = hEph.manager.getSession(ephSession.id);
  assert.equal(
    eph._leaseRenewTimer, null,
    'an ephemeral pairing holds no lease, so no renewal timer may be armed',
  );
  assert.equal(eph.status, 'SCAN_QR');
  assert.equal(
    pool.leases.has(String(ephSession.id)), false,
    'an ephemeral pairing must not hold a socket_leases row',
  );
  ok('an ephemeral pairing arms no renewal timer and holds no lease row');
}

// -- structural: a session that DID take a lease must arm one.
{
  const per = hPer.manager.getSession(perSession.id);
  assert.notEqual(
    per._leaseRenewTimer, null,
    'a session that acquired a lease must arm its renewal',
  );
  assert.equal(
    pool.leases.get(String(perSession.id))?.instanceId, 'test-instance',
    'the persistent session must hold its own lease row',
  );
  ok('a persistent session arms renewal because it holds the lease');
}

// -- behavioural: wait past one renewal interval and check both survive.
await sleep(PAST_ONE_INTERVAL_MS);

{
  const eph = hEph.manager.getSession(ephSession.id);
  assert.notEqual(
    eph.status, 'UNAVAILABLE',
    'the ephemeral pairing was killed by a renewal it never should have run',
  );
  assert.notEqual(
    eph.error_message, 'WHATSAPP_SESSION_LEASE_LOST',
    'the ephemeral pairing lost a lease it never acquired',
  );
  assert.equal(ephSock.ended, false, 'the ephemeral socket must not be torn down');
  assert.ok(
    hEph.eventsOfType('session_qr_updated').length > 0,
    'the ephemeral pairing must have delivered a QR and still be alive',
  );
  ok(`an ephemeral pairing survives past one renewal interval (${RENEWAL_MS}ms)`);

  const per = hPer.manager.getSession(perSession.id);
  assert.notEqual(per.status, 'UNAVAILABLE', 'the persistent session must stay alive');
  assert.ok(
    pool.calls.renew >= 1,
    `the persistent session must actually renew (renew calls: ${pool.calls.renew})`,
  );
  ok('a persistent session renews its lease and survives the same interval');
}

// --------------------------------- promotion arms the renewal it just earned
// The socket of a promoted pairing was opened while the session was still
// ephemeral, so it armed nothing at attach time. Once the pairing connects and
// takes its lease, renewal must start — otherwise the lease silently expires
// while this instance keeps running.
{
  const h = await createHarness({ leaseRepository: lease });
  const session = await h.manager.createSession('promote-lease', { ephemeral: true });
  const sock = await h.nextSocket('promotion socket');
  await h.connectionUpdate(sock, { qr: 'QR-PROMOTE' });
  await settle();

  assert.equal(
    h.manager.getSession(session.id)._leaseRenewTimer, null,
    'precondition: an ephemeral pairing starts with no renewal timer',
  );

  sock.completePairing();
  await h.credsUpdate(sock);
  await h.connectionUpdate(sock, { connection: 'open' });
  await settle(10);

  const promoted = h.manager.getSession(session.id);
  assert.equal(promoted.status, 'CONNECTED', 'the pairing must complete');
  assert.equal(promoted.ephemeral, false, 'the session must be promoted to persistent');
  assert.notEqual(
    promoted._leaseRenewTimer, null,
    'promotion must arm renewal for the lease it just acquired',
  );
  assert.equal(
    pool.leases.get(String(session.id))?.instanceId, 'test-instance',
    'promotion must take the lease',
  );
  ok('a promoted pairing arms renewal for the lease it takes on connect');
}

console.log(`\n[test-phase6-5-ephemeral-lease] ${checks} checks passed`);
await cleanupHarness();
process.exit(0);
