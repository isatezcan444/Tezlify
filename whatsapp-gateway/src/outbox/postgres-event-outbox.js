import crypto from 'crypto';
import pg from 'pg';
import { createEncryptedCodec } from '../auth/encrypted-codec.js';

const { Pool } = pg;

function eventContext(sessionId, eventId) {
  return `tezlify-wa-v1:event:${sessionId}:${eventId}`;
}

/**
 * PostgreSQL foreign-key error code. 23503 is raised when a referenced row does
 * not exist — for these tables that always means "the session row is gone".
 */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * Report that the gateway is writing rows for a session the database no longer
 * knows about.
 *
 * WHY THIS IS NOT JUST A LOG LINE
 * --------------------------------
 * The production symptom was an outbox that silently stayed empty while
 * PostgreSQL printed one foreign-key violation per event. Every caller caught
 * the error and fell back to the non-durable socket path, so the product looked
 * alive while losing every durability guarantee it claims. An operator reading
 * the logs had no way to connect "the queue never fills" with "this number was
 * re-paired and the old session row was deleted".
 *
 * So the diagnosis is reported ONCE per (table, session) rather than on every
 * event — a repeating foreign-key error is one problem, not thousands — and the
 * message names the cause and the remedy. Every OTHER error still propagates.
 */
const reportedOrphans = new Set();

export function reportOrphanedSession(table, sessionId, detail, logger) {
  const key = `${table}:${sessionId}`;
  if (reportedOrphans.has(key)) return false;
  reportedOrphans.add(key);
  // The logger is called through a bound reference, never as `logger.error(...)`.
  //
  // WHY THIS MATTERS MORE THAN IT LOOKS
  // -----------------------------------
  // A pino method invoked as `obj.error(args)` keeps `this` bound to the logger.
  // Destructuring or falling back to a bare `console.error` loses that, and
  // pino's tools.js then reads `this[Symbol(pino.msgPrefix)]` off `undefined`
  // and throws `TypeError: Cannot read properties of undefined`. That exception
  // escaped this reporting path, which runs from an async catch block, so it
  // was an UNHANDLED rejection: the whole gateway process exited, the restart
  // policy brought it back, and for those seconds every backend call failed
  // with a 10ms ConnectError. The user saw a 502 on the pairing QR and then a
  // wall of 404s once the in-memory session was gone.
  //
  // This function exists to REPORT a problem. It must never become one, so
  // every path is wrapped and nothing is allowed to throw out of here.
  const message =
    'Writing for a session that no longer exists in the database. Every durable ' +
    'write for this session is being DISCARDED — events reach the backend over ' +
    'the live socket only and are LOST on any restart. The usual cause is that ' +
    'the number was re-paired: the previous session row was deleted while this ' +
    'gateway session stayed connected. Re-pair the number (or restart this ' +
    'gateway) so a live session id is registered. Further writes for this ' +
    'session will not be reported again.';
  const payload = {
    table,
    session_id: sessionId,
    detail: detail ?? null,
    code: PG_FOREIGN_KEY_VIOLATION,
  };

  try {
    if (logger && typeof logger.error === 'function') {
      logger.error(payload, message);
    } else {
      // Plain string form: console.error with an object first would be
      // formatted by the object, which is exactly what loses the context.
      console.error(`[orphan:${key}] ${JSON.stringify(payload)} ${message}`);
    }
  } catch {
    // Reporting is best-effort by definition. Swallow anything the logging
    // layer throws so an orphaned row can never take the process down.
  }
  return true;
}

/** Test seam: forget which orphans have been reported. */
export function resetOrphanReports() {
  reportedOrphans.clear();
}

/** Test seam: the orphans reported so far. */
export function orphanReports() {
  return [...reportedOrphans];
}

export function createPostgresEventOutbox({
  connectionString,
  encryptionKey,
  poolMax = 1,
  pool: injectedPool = null,
  /**
   * Called when a write fails because the session row no longer exists, so the
   * caller can mark the session and surface it. Reported once per session.
   */
  onOrphaned = null,
} = {}) {
  if (!connectionString && !injectedPool) {
    throw new Error('A PostgreSQL connection is required for the event outbox.');
  }
  const ownsPool = !injectedPool;
  const pool = injectedPool || new Pool({
    connectionString,
    max: poolMax,
    min: 0,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  const codec = createEncryptedCodec(encryptionKey);

  return {
    async enqueue(event) {
      const sessionId = String(event?.gateway_session_id || event?.session_id || '');
      if (!sessionId) throw new Error('Durable gateway event requires a session id.');
      const eventId = event?.event_id || crypto.randomUUID();
      const eventType = String(event?.event || event?.event_type || 'unknown');
      const payload = { ...event, event_id: eventId };
      const encrypted = codec.encrypt(JSON.stringify(payload), eventContext(sessionId, eventId));
      try {
        await pool.query(
          `INSERT INTO whatsapp_private.event_outbox
             (event_id, session_id, event_type, ciphertext, nonce, auth_tag, key_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (event_id) DO NOTHING`,
          [eventId, sessionId, eventType, encrypted.ciphertext, encrypted.nonce,
            encrypted.authTag, encrypted.keyVersion],
        );
      } catch (err) {
        // A foreign-key violation here means the session row is gone: the
        // operator re-paired the number, so this gateway session's id was
        // deleted while the in-memory session object kept emitting. Retrying
        // cannot succeed and, because the caller falls back to the best-effort
        // path, the error was previously invisible — it looked like a slow
        // queue. Say so explicitly and permanently, so the operator sees WHY
        // the durable outbox is empty instead of guessing.
        if (err?.code === PG_FOREIGN_KEY_VIOLATION) {
          reportOrphanedSession('event_outbox', sessionId, eventType);
          // Surface it on the session too, so the operator sees it in the UI
          // rather than only in a log they may never open.
          try { onOrphaned?.(sessionId, eventType); } catch { /* reporting only */ }
          // The event is not durable, but the socket path still delivers it,
          // so returning the payload keeps in-flight state correct.
          return payload;
        }
        throw err;
      }
      return payload;
    },

    async claimPending(limit = 50) {
      const result = await pool.query(
        `WITH claimed AS (
           SELECT sequence
           FROM whatsapp_private.event_outbox
            WHERE state IN ('PENDING', 'IN_FLIGHT')
              AND next_attempt_at <= NOW()
             ORDER BY sequence ASC
            FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE whatsapp_private.event_outbox AS outbox
         SET state = 'IN_FLIGHT',
             attempts = outbox.attempts + 1,
             next_attempt_at = NOW() + INTERVAL '30 seconds'
         FROM claimed
         WHERE outbox.sequence = claimed.sequence
         RETURNING outbox.sequence, outbox.event_id, outbox.session_id,
                   outbox.event_type, outbox.ciphertext, outbox.nonce,
                   outbox.auth_tag, outbox.key_version, outbox.attempts`,
        [Math.max(1, Math.min(100, Number(limit) || 50))],
      );
      // UPDATE RETURNING does not preserve the claimed CTE's ordering.
      result.rows.sort((a, b) => {
        const left = BigInt(a.sequence);
        const right = BigInt(b.sequence);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      return result.rows.map((row) => ({
        sequence: Number(row.sequence),
        attempts: Number(row.attempts),
        event: JSON.parse(codec.decrypt(row, eventContext(row.session_id, row.event_id))),
      }));
    },

    async acknowledge(eventId) {
      await pool.query(
        `UPDATE whatsapp_private.event_outbox
         SET state = 'DELIVERED', delivered_at = NOW()
         WHERE event_id = $1 AND state <> 'DELIVERED'`,
        [eventId],
      );
    },

    async reject(eventId, { permanent = false } = {}) {
      await pool.query(
        `UPDATE whatsapp_private.event_outbox
         SET state = CASE WHEN $2 OR attempts >= 10 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
             next_attempt_at = NOW() + LEAST(INTERVAL '5 minutes', INTERVAL '5 seconds' * GREATEST(attempts, 1))
         WHERE event_id = $1 AND state <> 'DELIVERED'`,
        [eventId, permanent],
      );
    },

    async nack(eventId, permanent = false) {
      return this.reject(eventId, { permanent });
    },

    async requeueInflight() {
      await pool.query(
        `UPDATE whatsapp_private.event_outbox
         SET state = 'PENDING', next_attempt_at = NOW()
         WHERE state = 'IN_FLIGHT'`,
      );
    },

    async cleanup() {
      const result = await pool.query(
        `WITH doomed AS (
           SELECT sequence FROM whatsapp_private.event_outbox
           WHERE (state = 'DELIVERED' AND delivered_at < NOW() - INTERVAL '24 hours')
              OR (state = 'DEAD_LETTER' AND created_at < NOW() - INTERVAL '7 days')
           ORDER BY sequence ASC LIMIT 1000
         )
         DELETE FROM whatsapp_private.event_outbox
         WHERE sequence IN (SELECT sequence FROM doomed)`,
      );
      const processed = await pool.query(
        `DELETE FROM whatsapp_private.processed_events
         WHERE processed_at < NOW() - INTERVAL '7 days'`,
      );
      return (result.rowCount || 0) + (processed.rowCount || 0);
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}
