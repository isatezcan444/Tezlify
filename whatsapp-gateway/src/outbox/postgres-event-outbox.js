import crypto from 'crypto';
import pg from 'pg';
import { createEncryptedCodec } from '../auth/encrypted-codec.js';

const { Pool } = pg;

function eventContext(sessionId, eventId) {
  return `tezlify-wa-v1:event:${sessionId}:${eventId}`;
}

export function createPostgresEventOutbox({
  connectionString,
  encryptionKey,
  poolMax = 1,
  pool: injectedPool = null,
}) {
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
      await pool.query(
        `INSERT INTO whatsapp_private.event_outbox
           (event_id, session_id, event_type, ciphertext, nonce, auth_tag, key_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, sessionId, eventType, encrypted.ciphertext, encrypted.nonce,
          encrypted.authTag, encrypted.keyVersion],
      );
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
