import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import pg from 'pg';
import { createEncryptedCodec } from './encrypted-codec.js';

const { Pool } = pg;

function stringify(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function parse(value) {
  return JSON.parse(value, BufferJSON.reviver);
}

function context(parts) {
  return ['tezlify-wa-v1', ...parts].join(':');
}

export function createPostgresAuthRepository({
  connectionString,
  encryptionKey,
  poolMax = 2,
  pool: injectedPool = null,
}) {
  if (!connectionString && !injectedPool) {
    throw new Error('GATEWAY_DATABASE_URL is required for durable WhatsApp auth.');
  }
  const pool = injectedPool || new Pool({
    connectionString,
    max: poolMax,
    min: 0,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  const codec = createEncryptedCodec(encryptionKey);

  const repository = {
    async assertReady() {
      await pool.query('SELECT 1 FROM whatsapp_private.gateway_sessions LIMIT 1');
    },

    async registerSession(sessionId, sessionName, { active = true } = {}) {
      await pool.query(
        `INSERT INTO whatsapp_private.gateway_sessions
           (session_id, session_name, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           session_name = EXCLUDED.session_name,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()`,
        [sessionId, sessionName, active],
      );
    },

    async setSessionActive(sessionId, active) {
      await pool.query(
        `UPDATE whatsapp_private.gateway_sessions
         SET is_active = $2, updated_at = NOW() WHERE session_id = $1`,
        [sessionId, active],
      );
    },

    async listRestorableSessions() {
      const result = await pool.query(
        `SELECT session_id, session_name
         FROM whatsapp_private.gateway_sessions
         WHERE is_active = TRUE ORDER BY created_at ASC`,
      );
      return result.rows;
    },

    async loadCredentials(sessionId) {
      const result = await pool.query(
        `SELECT ciphertext, nonce, auth_tag, key_version
         FROM whatsapp_private.session_credentials WHERE session_id = $1`,
        [sessionId],
      );
      if (result.rowCount === 0) return null;
      return parse(codec.decrypt(result.rows[0], context(['credentials', sessionId])));
    },

    async saveCredentials(sessionId, credentials) {
      const encrypted = codec.encrypt(
        stringify(credentials),
        context(['credentials', sessionId]),
      );
      await pool.query(
        `INSERT INTO whatsapp_private.session_credentials
           (session_id, ciphertext, nonce, auth_tag, key_version, version, updated_at)
         VALUES ($1, $2, $3, $4, $5, 1, NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext,
           nonce = EXCLUDED.nonce,
           auth_tag = EXCLUDED.auth_tag,
           key_version = EXCLUDED.key_version,
           version = whatsapp_private.session_credentials.version + 1,
           updated_at = NOW()`,
        [
          sessionId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyVersion,
        ],
      );
    },

    async getSignalKeys(sessionId, keyType, ids) {
      if (!ids.length) return {};
      const hashesById = new Map(ids.map((id) => [id, codec.blindIndex(`${keyType}:${id}`)]));
      const idsByHash = new Map([...hashesById].map(([id, hash]) => [hash, id]));
      const result = await pool.query(
        `SELECT key_hash, ciphertext, nonce, auth_tag, key_version
         FROM whatsapp_private.signal_keys
         WHERE session_id = $1 AND key_type = $2 AND key_hash = ANY($3::text[])`,
        [sessionId, keyType, [...idsByHash.keys()]],
      );
      const values = {};
      for (const row of result.rows) {
        const id = idsByHash.get(row.key_hash);
        if (!id) continue;
        values[id] = parse(codec.decrypt(
          row,
          context(['signal-key', sessionId, keyType, row.key_hash]),
        ));
      }
      return values;
    },

    async setSignalKeys(sessionId, data) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [keyType, entries] of Object.entries(data || {})) {
          for (const [id, value] of Object.entries(entries || {})) {
            const keyHash = codec.blindIndex(`${keyType}:${id}`);
            if (value == null) {
              await client.query(
                `DELETE FROM whatsapp_private.signal_keys
                 WHERE session_id = $1 AND key_type = $2 AND key_hash = $3`,
                [sessionId, keyType, keyHash],
              );
              continue;
            }
            const encrypted = codec.encrypt(
              stringify(value),
              context(['signal-key', sessionId, keyType, keyHash]),
            );
            await client.query(
              `INSERT INTO whatsapp_private.signal_keys
                 (session_id, key_type, key_hash, ciphertext, nonce, auth_tag, key_version, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
               ON CONFLICT (session_id, key_type, key_hash) DO UPDATE SET
                 ciphertext = EXCLUDED.ciphertext,
                 nonce = EXCLUDED.nonce,
                 auth_tag = EXCLUDED.auth_tag,
                 key_version = EXCLUDED.key_version,
                 updated_at = NOW()`,
              [
                sessionId,
                keyType,
                keyHash,
                encrypted.ciphertext,
                encrypted.nonce,
                encrypted.authTag,
                encrypted.keyVersion,
              ],
            );
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async createAuthState(sessionId) {
      const creds = (await repository.loadCredentials(sessionId)) || initAuthCreds();
      return {
        state: {
          creds,
          keys: {
            get: (type, ids) => repository.getSignalKeys(sessionId, type, ids),
            set: (data) => repository.setSignalKeys(sessionId, data),
          },
        },
        saveCreds: () => repository.saveCredentials(sessionId, creds),
      };
    },

    async clearAuth(sessionId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM whatsapp_private.signal_keys WHERE session_id = $1',
          [sessionId],
        );
        await client.query(
          'DELETE FROM whatsapp_private.session_credentials WHERE session_id = $1',
          [sessionId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteSession(sessionId) {
      await pool.query(
        'DELETE FROM whatsapp_private.gateway_sessions WHERE session_id = $1',
        [sessionId],
      );
    },

    async close() {
      await pool.end();
    },
  };

  return repository;
}
