import crypto from 'crypto';
import { PG_FOREIGN_KEY_VIOLATION, reportOrphanedSession } from '../outbox/postgres-event-outbox.js';

/**
 * Durable holding area for messages addressed by a LID whose phone mapping is
 * not known yet.
 *
 * The RAM store already holds such messages (`lidHold`) so they are not shown
 * under a raw LID, but RAM is not durability: a gateway restart or the
 * per-chat cap drops them before the mapping is learned. This table is the
 * durable copy. A row is deleted only after the message has been re-ingested
 * (and the resulting `message_new` was durably enqueued) with the correct
 * phone JID, or when a record for the same message already exists.
 *
 * The primary key is the natural identity of the message inside ONE gateway
 * session. That is the tenant/session boundary: no query in this module ever
 * looks outside the supplied `session_id`, so a pending message can never be
 * released into another session's conversation.
 */
const PENDING_SCOPE = 'tezlify-wa-v1:lid-pending';

function pendingContext(sessionId, lidJid, waMessageId) {
  return `${PENDING_SCOPE}:${sessionId}:${lidJid}:${waMessageId}`;
}

/**
 * Deterministic UUID for the `message_new` event that releases this row.
 *
 * A replay after a crash (between "event durably enqueued" and "row deleted")
 * MUST carry the same event id. The event outbox keys on event_id
 * (`ON CONFLICT (event_id) DO NOTHING`) and the backend's `processed_events`
 * table deduplicates it, so the message is delivered exactly once even when we
 * cannot prove whether the previous attempt reached the backend.
 */
export function pendingLidEventId(sessionId, lidJid, waMessageId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${PENDING_SCOPE}:event:${sessionId}:${lidJid}:${waMessageId}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5 (name-based) shape
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Baileys can hand `messageTimestamp` as a protobuf Long. Plain JSON would
 * turn it into `{ low, high }` and the replay would fall back to "now",
 * losing the original message time. Normalize it to epoch seconds before
 * serializing.
 */
function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toNumber === 'function') {
    const n = Number(value.toNumber());
    return Number.isFinite(n) ? n : value;
  }
  if (value && typeof value === 'object' && Number.isFinite(value.low)) {
    const low = Number(value.low) >>> 0;
    const high = Number(value.high) >>> 0;
    const n = high * 2 ** 32 + low;
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

function serializeMessage(message) {
  const clone = { ...(message || {}) };
  if (clone.messageTimestamp !== undefined) {
    clone.messageTimestamp = normalizeTimestamp(clone.messageTimestamp);
  }
  return JSON.stringify(clone);
}

/** Restore Buffers (thumbnails, media keys) that JSON turns into plain objects. */
function reviveBuffers(_key, value) {
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

export function createPendingLidRepository({
  pool = null,
  codec = null,
  logger = null,
  onOrphaned = null,
} = {}) {
  const enabled = Boolean(pool && codec);

  return {
    enabled,

    /**
     * Insert (or confirm) the durable copy of an unknown-LID message.
     *
     * Returns `{ persisted, reason?, eventId }`. A foreign-key violation means
     * the gateway session row is gone; that is reported once and returned as
     * non-durable instead of being retried forever. Every other failure is
     * thrown so the caller can log it and retry.
     */
    async persistPendingMessage({
      sessionId,
      lidJid,
      waMessageId,
      upsertType = 'notify',
      message,
      enabled: callEnabled = true,
    }) {
      const eventId = pendingLidEventId(sessionId, lidJid, waMessageId);
      if (!callEnabled || !enabled) {
        return { persisted: false, reason: 'disabled', eventId };
      }
      if (!sessionId || !lidJid || !waMessageId) {
        return { persisted: false, reason: 'invalid', eventId };
      }

      const encrypted = codec.encrypt(
        serializeMessage(message),
        pendingContext(sessionId, lidJid, waMessageId),
      );
      try {
        await pool.query(
          `INSERT INTO whatsapp_private.lid_pending_messages
             (session_id, lid_jid, wa_message_id, event_id, upsert_type,
              ciphertext, nonce, auth_tag, key_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
           ON CONFLICT (session_id, lid_jid, wa_message_id) DO NOTHING`,
          [sessionId, lidJid, waMessageId, eventId, String(upsertType || 'notify'),
            encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion],
        );
      } catch (err) {
        if (err?.code === PG_FOREIGN_KEY_VIOLATION) {
          reportOrphanedSession('lid_pending_messages', sessionId, waMessageId, logger);
          try { onOrphaned?.(sessionId, 'lid_pending_message'); } catch { /* reporting only */ }
          return { persisted: false, reason: 'orphaned', eventId };
        }
        throw err;
      }
      return { persisted: true, eventId };
    },

    /** Keys of every pending row for a session; no payload decryption needed. */
    async listPendingIndex(sessionId) {
      if (!enabled || !sessionId) return [];
      const result = await pool.query(
        `SELECT lid_jid, wa_message_id, event_id::text AS event_id
           FROM whatsapp_private.lid_pending_messages
          WHERE session_id = $1
          ORDER BY created_at ASC, wa_message_id ASC`,
        [sessionId],
      );
      return result.rows.map((row) => ({
        lidJid: row.lid_jid,
        waMessageId: row.wa_message_id,
        eventId: row.event_id,
      }));
    },

    /**
     * Decrypted pending rows, oldest first. A row that cannot be decrypted is
     * logged and LEFT IN PLACE: dropping it here would turn a key problem into
     * silent message loss.
     */
    async listPendingMessages(sessionId, { lidJid = null } = {}) {
      if (!enabled || !sessionId) return [];
      const params = [sessionId];
      let filter = '';
      if (lidJid) {
        params.push(lidJid);
        filter = 'AND lid_jid = $2';
      }
      const result = await pool.query(
        `SELECT lid_jid, wa_message_id, event_id::text AS event_id, upsert_type,
                ciphertext, nonce, auth_tag, key_version, created_at
           FROM whatsapp_private.lid_pending_messages
          WHERE session_id = $1 ${filter}
          ORDER BY created_at ASC, wa_message_id ASC`,
        params,
      );

      const rows = [];
      for (const row of result.rows) {
        try {
          const plaintext = codec.decrypt(
            row,
            pendingContext(sessionId, row.lid_jid, row.wa_message_id),
          );
          rows.push({
            lidJid: row.lid_jid,
            waMessageId: row.wa_message_id,
            eventId: row.event_id,
            upsertType: row.upsert_type || 'notify',
            message: JSON.parse(plaintext, reviveBuffers),
          });
        } catch (err) {
          try {
            logger?.error(
              {
                err,
                session_ref: String(sessionId).slice(0, 8),
                lid_present: Boolean(row.lid_jid),
                message_id_present: Boolean(row.wa_message_id),
              },
              'LID pending message could not be decrypted; row retained',
            );
          } catch { /* logging must never break release */ }
        }
      }
      return rows;
    },

    /**
     * Remove the row only after the release path proved durable delivery (or
     * found an already-delivered record). Returns the number of deleted rows.
     */
    async markPendingMessageProcessed(sessionId, lidJid, waMessageId) {
      if (!enabled || !sessionId || !lidJid || !waMessageId) return 0;
      const result = await pool.query(
        `DELETE FROM whatsapp_private.lid_pending_messages
          WHERE session_id = $1 AND lid_jid = $2 AND wa_message_id = $3`,
        [sessionId, lidJid, waMessageId],
      );
      return result.rowCount || 0;
    },
  };
}
