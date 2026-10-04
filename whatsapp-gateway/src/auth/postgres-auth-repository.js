import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { createEncryptedCodec } from './encrypted-codec.js';
import { attachPoolErrorHandler } from '../database/postgres-pool.js';

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
  onLidMappingDiscovered = null,
}) {
  if (!connectionString && !injectedPool) {
    throw new Error('GATEWAY_DATABASE_URL is required for durable WhatsApp auth.');
  }
  const pool = injectedPool || attachPoolErrorHandler(new Pool({
    connectionString,
    max: poolMax,
    min: 0,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  }), 'auth');
  const ownsPool = !injectedPool;
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
         FROM (
           SELECT gs.session_id, gs.session_name, gs.created_at
           FROM whatsapp_private.gateway_sessions gs
           INNER JOIN whatsapp_private.session_credentials sc ON sc.session_id = gs.session_id
           INNER JOIN public.whatsapp_sessions ws ON ws.gateway_id::text = gs.session_id
           WHERE gs.is_active = TRUE AND ws.is_active = TRUE
         ) restorable
         ORDER BY created_at ASC`,
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

    async getSignalKeys(sessionId, keyType, ids, sessionDir = null) {
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
        let value = parse(codec.decrypt(
          row,
          context(['signal-key', sessionId, keyType, row.key_hash]),
        ));
        if (keyType === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        values[id] = value;
      }

      if (sessionDir && fs.existsSync(sessionDir)) {
        const missingIds = ids.filter((id) => values[id] === undefined);
        if (missingIds.length > 0) {
          const backfill = {};
          for (const id of missingIds) {
            const fileName = `${keyType}-${id}.json`.replace(/\//g, '__').replace(/:/g, '-');
            const filePath = path.join(sessionDir, fileName);
            if (fs.existsSync(filePath)) {
              try {
                const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'), BufferJSON.reviver);
                if (raw) {
                  values[id] = keyType === 'app-state-sync-key'
                    ? proto.Message.AppStateSyncKeyData.fromObject(raw)
                    : raw;
                  backfill[id] = raw;
                }
              } catch { /* best-effort disk read */ }
            }
          }
          if (Object.keys(backfill).length > 0) {
            void repository.setSignalKeys(sessionId, { [keyType]: backfill }).catch(() => {});
          }
        }
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

            if (keyType === 'lid-mapping' && value && typeof value === 'string') {
              let pnUser = null;
              let lidUser = null;
              if (id.endsWith('_reverse')) {
                lidUser = id.replace('_reverse', '');
                pnUser = value;
              } else {
                pnUser = id;
                lidUser = value;
              }
              if (pnUser && lidUser && !pnUser.includes('@') && !lidUser.includes('@')) {
                const lidJid = `${lidUser}@lid`;
                const phoneJid = `${pnUser}@s.whatsapp.net`;
                await client.query(
                  `INSERT INTO whatsapp_private.lid_mappings (session_id, lid_jid, phone_jid, created_at)
                   VALUES ($1, $2, $3, NOW())
                   ON CONFLICT (session_id, lid_jid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid, created_at = NOW()`,
                  [String(sessionId), lidJid, phoneJid],
                );
                if (typeof onLidMappingDiscovered === 'function') {
                  try {
                    onLidMappingDiscovered(sessionId, lidJid, phoneJid);
                  } catch (cbErr) {
                    // non-fatal callback failure
                  }
                }
              }
            }
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

    async syncFromFilesystem(sessionId, sessionDir) {
      if (!sessionDir || !fs.existsSync(sessionDir)) return;
      try {
        const credsFile = path.join(sessionDir, 'creds.json');
        if (fs.existsSync(credsFile)) {
          const fileCreds = JSON.parse(fs.readFileSync(credsFile, 'utf8'), BufferJSON.reviver);
          if (fileCreds) {
            let dbCreds = await repository.loadCredentials(sessionId);
            let needsCredsSave = false;
            if (!dbCreds) {
              dbCreds = fileCreds;
              needsCredsSave = true;
            } else if (!dbCreds.myAppStateKeyId && fileCreds.myAppStateKeyId) {
              dbCreds.myAppStateKeyId = fileCreds.myAppStateKeyId;
              needsCredsSave = true;
            }
            if (needsCredsSave) {
              await repository.saveCredentials(sessionId, dbCreds);
            }
          }
        }

        const files = fs.readdirSync(sessionDir);
        const categories = {};
        for (const file of files) {
          if (!file.endsWith('.json') || file === 'creds.json' || file === 'auth.json' || file === 'keys.json' || file.startsWith('app-state-sync-version-')) {
            continue;
          }
          const dashIdx = file.indexOf('-');
          if (dashIdx <= 0) continue;
          const keyType = file.slice(0, dashIdx);
          const id = file.slice(dashIdx + 1, -5).replace(/__/g, '/').replace(/-/g, ':');
          if (!keyType || !id) continue;
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'), BufferJSON.reviver);
            if (raw) {
              if (!categories[keyType]) categories[keyType] = {};
              categories[keyType][id] = raw;
            }
          } catch { /* skip corrupted file */ }
        }

        for (const [keyType, entries] of Object.entries(categories)) {
          const allIds = Object.keys(entries);
          for (let i = 0; i < allIds.length; i += 50) {
            const batchIds = allIds.slice(i, i + 50);
            const batchEntries = {};
            for (const bid of batchIds) batchEntries[bid] = entries[bid];
            await repository.setSignalKeys(sessionId, { [keyType]: batchEntries });
          }
        }
      } catch {
        // non-fatal best effort sync
      }
    },

    async createAuthState(sessionId, sessionDir = null) {
      let creds = (await repository.loadCredentials(sessionId)) || initAuthCreds();
      if (sessionDir && fs.existsSync(sessionDir)) {
        const credsFile = path.join(sessionDir, 'creds.json');
        if (fs.existsSync(credsFile)) {
          try {
            const fileCreds = JSON.parse(fs.readFileSync(credsFile, 'utf8'), BufferJSON.reviver);
            if (!creds.myAppStateKeyId && fileCreds?.myAppStateKeyId) {
              creds.myAppStateKeyId = fileCreds.myAppStateKeyId;
              await repository.saveCredentials(sessionId, creds);
            }
          } catch { /* best effort */ }
        }
        void repository.syncFromFilesystem(sessionId, sessionDir).catch(() => {});
      }
      return {
        state: {
          creds,
          keys: {
            get: (type, ids) => repository.getSignalKeys(sessionId, type, ids, sessionDir),
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
      if (ownsPool) await pool.end();
    },
  };

  return repository;
}
