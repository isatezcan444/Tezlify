import pg from 'pg';

const { Pool } = pg;

export function createPostgresSessionLease({
  connectionString,
  pool: injectedPool = null,
  ttlSeconds = 45,
}) {
  if (!connectionString && !injectedPool) throw new Error('PostgreSQL is required for socket leases.');
  const ownsPool = !injectedPool;
  const pool = injectedPool || new Pool({ connectionString, max: 1, min: 0 });
  const ttl = Math.max(30, Math.min(120, Number(ttlSeconds) || 45));

  return {
    ttlSeconds: ttl,

    async acquire(sessionId, instanceId, generation) {
      const result = await pool.query(
        `INSERT INTO whatsapp_private.socket_leases
           (session_id, instance_id, generation, expires_at, updated_at)
         VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'), NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           instance_id = EXCLUDED.instance_id,
           generation = EXCLUDED.generation,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()
         WHERE whatsapp_private.socket_leases.expires_at <= NOW()
            OR whatsapp_private.socket_leases.instance_id = EXCLUDED.instance_id
         RETURNING session_id`,
        [sessionId, instanceId, generation, ttl],
      );
      return result.rowCount === 1;
    },

    async renew(sessionId, instanceId, generation) {
      const result = await pool.query(
        `UPDATE whatsapp_private.socket_leases
         SET expires_at = NOW() + ($4 * INTERVAL '1 second'), updated_at = NOW()
         WHERE session_id = $1 AND instance_id = $2 AND generation = $3
         RETURNING session_id`,
        [sessionId, instanceId, generation, ttl],
      );
      return result.rowCount === 1;
    },

    async release(sessionId, instanceId) {
      await pool.query(
        `DELETE FROM whatsapp_private.socket_leases
         WHERE session_id = $1 AND instance_id = $2`,
        [sessionId, instanceId],
      );
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}
