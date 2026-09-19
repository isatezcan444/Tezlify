/**
 * In-memory stand-in for the PostgreSQL pool that
 * `src/lease/postgres-session-lease.js` issues its statements against.
 *
 * It implements exactly the three statements that adapter knows how to run
 * against `whatsapp_private.socket_leases`, and — importantly — reproduces the
 * one behaviour the ephemeral-pairing defect depends on: an UPDATE that matches
 * no row reports `rowCount: 0`, which the adapter turns into `renew() === false`.
 *
 * Shared by:
 *   - test-session-lease.mjs            (the adapter's own contract)
 *   - test-phase6-5-ephemeral-lease.mjs (the manager <-> lease interaction)
 */
export function createFakeLeasePool() {
  const leases = new Map();
  const calls = { acquire: 0, renew: 0, release: 0 };

  return {
    /** session_id -> { instanceId, generation } */
    leases,
    /** statement counters, for assertions about what actually happened */
    calls,
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO whatsapp_private.socket_leases')) {
        calls.acquire += 1;
        const current = leases.get(params[0]);
        if (current && current.instanceId !== params[1] && !current.expired) {
          return { rowCount: 0, rows: [] };
        }
        leases.set(params[0], { instanceId: params[1], generation: params[2], expired: false });
        return { rowCount: 1, rows: [{ session_id: params[0] }] };
      }
      if (normalized.startsWith('UPDATE whatsapp_private.socket_leases')) {
        calls.renew += 1;
        const current = leases.get(params[0]);
        const matches = current?.instanceId === params[1] && current?.generation === params[2];
        return { rowCount: matches ? 1 : 0, rows: matches ? [{ session_id: params[0] }] : [] };
      }
      if (normalized.startsWith('DELETE FROM whatsapp_private.socket_leases')) {
        calls.release += 1;
        const current = leases.get(params[0]);
        if (current?.instanceId === params[1]) leases.delete(params[0]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    async end() {},
  };
}
