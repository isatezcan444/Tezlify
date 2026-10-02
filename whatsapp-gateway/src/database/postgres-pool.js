import pg from 'pg';
import { logger } from '../utils/baileys-logger.js';

const { Pool } = pg;

/**
 * Give a `pg` Pool an `'error'` listener so an idle-client failure cannot kill
 * the process.
 *
 * WHY THIS EXISTS (measured in production, 2026-10-01)
 * ---------------------------------------------------
 * `pg` emits `'error'` on the POOL when one of its IDLE clients dies — a
 * Postgres restart, an admin shutdown, or a network reset. `docker restart
 * tezlify-db` does exactly this: Postgres terminates every client with
 * `57P01 terminating connection due to administrator command`, and pg-pool's
 * `Client.idleListener` re-emits that on the Pool.
 *
 * Node's EventEmitter treats an `'error'` event with NO listener as fatal: it
 * throws, and because the emit happens inside a socket callback the throw is an
 * uncaught exception and THE WHOLE GATEWAY PROCESS EXITS. Observed live as
 * `restarts` +1 with the stack
 *   `Emitted 'error' event on BoundPool instance at: Client.idleListener (pg-pool/index.js:62:10)`.
 *
 * The cost was pure loss. The pool had ALREADY discarded the broken client and
 * would have opened a fresh one on the next query, so the crash bought nothing:
 * a database blip that the gateway could have ridden out instead dropped every
 * linked WhatsApp line, and recovery took a full lease TTL (~45 s) because the
 * restarted gateway had to wait out the previous instance's socket lease.
 *
 * This is NOT "swallowing an error" (see AGENTS.md §1.1). The failure is real
 * and is logged at error level; the operation that hit it still fails and is
 * still reported. What is prevented is an unhandled event taking down unrelated
 * work.
 */
export function attachPoolErrorHandler(pool, label = 'gateway') {
  pool.on('error', (error) => {
    // Reporting must never become the failure it reports: a throw out of an
    // 'error' handler would reintroduce exactly the uncaught exception this
    // listener exists to prevent.
    try {
      if (logger && typeof logger.error === 'function') {
        logger.error(
          {
            pool: label,
            code: error?.code ?? null,
            severity: error?.severity ?? null,
            err: error?.message ?? String(error),
          },
          'PostgreSQL pool client error — the client was discarded and will be ' +
            'replaced on the next query. The gateway keeps running.',
        );
      }
    } catch {
      // Intentionally empty — see above.
    }
  });
  return pool;
}

export function createGatewayPostgresPool(connectionString, max = 3) {
  if (!connectionString) throw new Error('Gateway PostgreSQL connection string is required.');
  return attachPoolErrorHandler(
    new Pool({
      connectionString,
      max: Math.max(1, Math.min(5, Number(max) || 3)),
      min: 0,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    }),
    'gateway',
  );
}
