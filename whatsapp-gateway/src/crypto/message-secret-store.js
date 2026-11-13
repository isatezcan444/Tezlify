import crypto from 'node:crypto';
import { diagnostic, sessionRef } from '../observability.js';
import { jidKind } from '../utils/whatsapp-identity.js';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
export const HKDF_SALT = 'tezlify-whatsapp-private-hkdf-v1';
export const HKDF_INFO_PREFIX = 'tezlify-wa-message-secret-at-rest';
const DEFAULT_HKDF_SALT = Buffer.from(HKDF_SALT, 'utf8');
export const DEFAULT_MAX_RAM_ENTRIES = 10_000;

export function isProductionRuntime(env = process.env) {
  return (
    String(env?.NODE_ENV || '').toLowerCase() === 'production' ||
    String(env?.APP_ENV || '').toLowerCase() === 'production'
  );
}

/**
 * Rejects obvious placeholder / repeated-byte unit-test keys when enforcing
 * production key hygiene.
 */
export function isTrivialTestKeyMaterial(material) {
  if (!material) return true;
  if (typeof material === 'string') {
    const trimmed = material.trim();
    if (!trimmed) return true;
    if (/replace-with|changeme|example|test-only/i.test(trimmed)) return true;
    const first = trimmed[0];
    if (trimmed.split('').every((ch) => ch === first)) return true;
    return false;
  }
  if (Buffer.isBuffer(material) || material instanceof Uint8Array) {
    const buf = Buffer.from(material);
    if (buf.length === 0) return true;
    const first = buf[0];
    if (buf.every((b) => b === first)) return true;
    return false;
  }
  return true;
}

function normalizeIkm(rootKeyMaterial) {
  if (!rootKeyMaterial) return null;
  if (Buffer.isBuffer(rootKeyMaterial)) {
    return rootKeyMaterial.length >= 16 ? rootKeyMaterial : null;
  }
  if (rootKeyMaterial instanceof Uint8Array) {
    return rootKeyMaterial.length >= 16 ? Buffer.from(rootKeyMaterial) : null;
  }
  if (typeof rootKeyMaterial === 'string' && rootKeyMaterial.length >= 16) {
    return Buffer.from(rootKeyMaterial, 'utf8');
  }
  return null;
}

/**
 * Derives a domain-separated 32-byte AES-256-GCM key via HKDF-SHA256.
 * Prevents direct key reuse of GATEWAY_ENCRYPTION_KEY across unrelated tables.
 */
export function deriveMessageSecretSubkey(
  rootKeyMaterial,
  keyVersion = 1,
  { allowTestKey = !isProductionRuntime() } = {},
) {
  const ikm = normalizeIkm(rootKeyMaterial);
  if (!ikm) {
    throw new Error('HKDF messageSecret subkey derivation requires >= 16 bytes of key material.');
  }
  if (!allowTestKey) {
    if (ikm.length < 32 || isTrivialTestKeyMaterial(rootKeyMaterial)) {
      throw new Error(
        'Production messageSecret encryption requires strong, non-trivial root key material (>= 32 bytes).',
      );
    }
  }
  const versionNum = Number(keyVersion);
  if (!Number.isInteger(versionNum) || versionNum <= 0) {
    throw new Error('keyVersion must be a positive integer.');
  }
  const info = Buffer.from(`${HKDF_INFO_PREFIX}-v${versionNum}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, DEFAULT_HKDF_SALT, info, 32));
}

export function buildMessageSecretAad({ sessionId, chatJid, waMessageId, keyVersion }) {
  if (!sessionId || !chatJid || !waMessageId) {
    throw new Error('Message secret AAD requires sessionId, chatJid, and waMessageId.');
  }
  return Buffer.from(
    `tezlify-msg-secret:v${Number(keyVersion)}:${String(sessionId)}:${String(chatJid)}:${String(waMessageId)}`,
    'utf8',
  );
}

function buildRamKey(sessionId, chatJid, waMessageId) {
  return `${String(sessionId)}\0${String(chatJid)}\0${String(waMessageId)}`;
}

function isUndefinedTableError(err) {
  return err?.code === '42P01';
}

function isForeignKeyOrphanError(err) {
  return err?.code === '23503';
}

/**
 * Encrypted, HKDF-derived, AAD-scoped storage for WhatsApp messageContextInfo.messageSecret.
 * Stores only AES-256-GCM ciphertexts (never plaintext secrets) in memory (bounded LRU) and Postgres.
 */
export function createMessageSecretStore({
  rootKeyMaterial = null,
  activeKeyVersion = 1,
  keyRing = null,
  pool: initialPool = null,
  defaultTtlMs = null,
  maxEntries = DEFAULT_MAX_RAM_ENTRIES,
  allowTestKeys = !isProductionRuntime(),
  onOrphaned = null,
} = {}) {
  const version = Number(activeKeyVersion);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error('activeKeyVersion must be a positive integer.');
  }

  const resolvedMaxEntries = Number(maxEntries);
  if (!Number.isInteger(resolvedMaxEntries) || resolvedMaxEntries <= 0) {
    throw new Error('maxEntries must be a positive integer.');
  }

  let resolvedDefaultTtlMs = null;
  if (defaultTtlMs !== null && defaultTtlMs !== undefined) {
    const parsedTtl = Number(defaultTtlMs);
    if (!Number.isFinite(parsedTtl) || parsedTtl <= 0) {
      throw new Error('defaultTtlMs must be null or a positive finite number of milliseconds.');
    }
    resolvedDefaultTtlMs = parsedTtl;
  }

  const derivedKeys = new Map();
  try {
    if (keyRing && typeof keyRing === 'object') {
      const entries = keyRing instanceof Map ? Array.from(keyRing.entries()) : Object.entries(keyRing);
      for (const [verKey, rawMaterial] of entries) {
        const ver = Number(verKey);
        if (Number.isInteger(ver) && ver > 0) {
          const subkey = deriveMessageSecretSubkey(rawMaterial, ver, { allowTestKey: allowTestKeys });
          derivedKeys.set(ver, subkey);
        }
      }
    }
    if (!derivedKeys.has(version)) {
      const baseSubkey = deriveMessageSecretSubkey(rootKeyMaterial, version, { allowTestKey: allowTestKeys });
      derivedKeys.set(version, baseSubkey);
    }
  } catch (err) {
    diagnostic('message_secret_key_invalid', {
      production_mode: !allowTestKeys,
      key_version: version,
      error_name: err?.name || 'Error',
    });
    throw err;
  }

  // RAM store holds ENCRYPTED envelopes in insertion/access order for deterministic LRU eviction.
  const encryptedCache = new Map();
  let schemaMissingWarned = false;
  let ramEvictions = 0;

  function resolvePool(overridePool = null) {
    return overridePool || initialPool || null;
  }

  function putInRamCache(cacheKey, value) {
    if (encryptedCache.has(cacheKey)) {
      encryptedCache.delete(cacheKey);
    }
    encryptedCache.set(cacheKey, value);
    while (encryptedCache.size > resolvedMaxEntries) {
      const oldestKey = encryptedCache.keys().next().value;
      if (oldestKey === undefined) break;
      encryptedCache.delete(oldestKey);
      ramEvictions += 1;
    }
  }

  function encryptForScope(secretBytes, scope) {
    const subkey = derivedKeys.get(version);
    if (!subkey) throw new Error('Active messageSecret encryption key missing.');
    const plaintext = Buffer.isBuffer(secretBytes) ? secretBytes : Buffer.from(secretBytes);
    if (plaintext.length === 0) throw new Error('Empty messageSecret cannot be encrypted.');
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, subkey, nonce);
    cipher.setAAD(buildMessageSecretAad({ ...scope, keyVersion: version }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, nonce, authTag, keyVersion: version };
  }

  function decryptForScope(record, scope) {
    if (!record) return null;
    const recVersion = Number(record.key_version ?? record.keyVersion);
    const subkey = derivedKeys.get(recVersion);
    if (!subkey) {
      throw new Error(`Unsupported or retired messageSecret key_version: ${recVersion}`);
    }
    const nonce = Buffer.from(record.nonce || []);
    const authTag = Buffer.from(record.auth_tag ?? record.authTag ?? []);
    const ciphertext = Buffer.from(record.ciphertext || []);
    if (nonce.length !== NONCE_BYTES) {
      throw new Error('Invalid nonce length for stored messageSecret.');
    }
    if (authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('Invalid auth_tag length for stored messageSecret.');
    }
    if (ciphertext.length === 0) {
      throw new Error('Empty ciphertext for stored messageSecret.');
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, subkey, nonce);
    decipher.setAAD(buildMessageSecretAad({ ...scope, keyVersion: recVersion }));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  async function saveSecret({
    sessionId,
    chatJid,
    waMessageId,
    secret,
    ttlMs = resolvedDefaultTtlMs,
    pool = null,
  }) {
    if (!sessionId || !chatJid || !waMessageId || !secret) {
      return {
        ok: false,
        persisted: false,
        cachedInRam: false,
        storage: 'none',
        reason: 'invalid_input',
        keyVersion: null,
      };
    }
    const rawSecret = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
    if (rawSecret.length === 0) {
      return {
        ok: false,
        persisted: false,
        cachedInRam: false,
        storage: 'none',
        reason: 'invalid_input',
        keyVersion: null,
      };
    }

    const scope = {
      sessionId: String(sessionId),
      chatJid: String(chatJid),
      waMessageId: String(waMessageId),
    };
    const encrypted = encryptForScope(rawSecret, scope);
    let effectiveTtl = resolvedDefaultTtlMs;
    if (ttlMs !== undefined && ttlMs !== null) {
      const parsedTtl = Number(ttlMs);
      if (!Number.isFinite(parsedTtl) || parsedTtl <= 0) {
        throw new Error('ttlMs must be null or a positive finite number of milliseconds.');
      }
      effectiveTtl = parsedTtl;
    }
    const expiresAt = effectiveTtl ? new Date(Date.now() + effectiveTtl) : null;

    putInRamCache(buildRamKey(scope.sessionId, scope.chatJid, scope.waMessageId), {
      ...encrypted,
      expiresAtMs: expiresAt ? expiresAt.getTime() : null,
    });

    const dbPool = resolvePool(pool);
    if (!dbPool || typeof dbPool.query !== 'function') {
      return {
        ok: true,
        persisted: false,
        cachedInRam: true,
        storage: 'ram_only',
        reason: 'no_pool',
        keyVersion: encrypted.keyVersion,
      };
    }

    try {
      await dbPool.query(
        `INSERT INTO whatsapp_private.message_secrets
           (session_id, chat_jid, wa_message_id, ciphertext, nonce, auth_tag, key_version, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         ON CONFLICT (session_id, chat_jid, wa_message_id) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext,
           nonce = EXCLUDED.nonce,
           auth_tag = EXCLUDED.auth_tag,
           key_version = EXCLUDED.key_version,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [
          scope.sessionId,
          scope.chatJid,
          scope.waMessageId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyVersion,
          expiresAt ? expiresAt.toISOString() : null,
        ],
      );
      return {
        ok: true,
        persisted: true,
        cachedInRam: true,
        storage: 'postgres_and_ram',
        reason: 'persisted',
        keyVersion: encrypted.keyVersion,
      };
    } catch (err) {
      if (isUndefinedTableError(err)) {
        if (!schemaMissingWarned) {
          schemaMissingWarned = true;
          diagnostic('message_secret_table_unavailable', {
            session_ref: sessionRef(scope.sessionId),
            error_code: '42P01',
            fallback_storage: 'ram_only',
          });
        }
        return {
          ok: false,
          persisted: false,
          cachedInRam: true,
          storage: 'ram_only',
          reason: 'table_unavailable',
          keyVersion: encrypted.keyVersion,
        };
      }
      if (isForeignKeyOrphanError(err)) {
        onOrphaned?.(scope.sessionId);
        return {
          ok: false,
          persisted: false,
          cachedInRam: true,
          storage: 'ram_only',
          reason: 'orphan_session',
          keyVersion: encrypted.keyVersion,
        };
      }
      diagnostic('message_secret_persist_failed', {
        session_ref: sessionRef(scope.sessionId),
        chat_kind: jidKind(scope.chatJid),
        error_code: err?.code || 'ERR',
      });
      return {
        ok: false,
        persisted: false,
        cachedInRam: true,
        storage: 'ram_only',
        reason: 'persist_error',
        keyVersion: encrypted.keyVersion,
      };
    }
  }

  async function getSecret({ sessionId, chatJid, waMessageId, pool = null }) {
    if (!sessionId || !chatJid || !waMessageId) return null;
    const scope = {
      sessionId: String(sessionId),
      chatJid: String(chatJid),
      waMessageId: String(waMessageId),
    };
    const cacheKey = buildRamKey(scope.sessionId, scope.chatJid, scope.waMessageId);
    const cached = encryptedCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAtMs !== null && cached.expiresAtMs <= Date.now()) {
        encryptedCache.delete(cacheKey);
      } else {
        try {
          const plaintext = decryptForScope(cached, scope);
          // Refresh LRU position only after valid decryption
          encryptedCache.delete(cacheKey);
          encryptedCache.set(cacheKey, cached);
          return plaintext;
        } catch (err) {
          diagnostic('message_secret_decrypt_failed', {
            session_ref: sessionRef(scope.sessionId),
            chat_kind: jidKind(scope.chatJid),
            source: 'cache',
            error_name: err?.name || 'Error',
          });
          return null;
        }
      }
    }

    const dbPool = resolvePool(pool);
    if (!dbPool || typeof dbPool.query !== 'function') return null;

    try {
      const res = await dbPool.query(
        `SELECT ciphertext, nonce, auth_tag, key_version, expires_at
         FROM whatsapp_private.message_secrets
         WHERE session_id = $1
           AND chat_jid = $2
           AND wa_message_id = $3
           AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1`,
        [scope.sessionId, scope.chatJid, scope.waMessageId],
      );
      const row = res?.rows?.[0];
      if (!row) return null;
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        return null;
      }
      const plaintextSecret = decryptForScope(row, scope);
      putInRamCache(cacheKey, {
        ciphertext: Buffer.from(row.ciphertext),
        nonce: Buffer.from(row.nonce),
        authTag: Buffer.from(row.auth_tag),
        keyVersion: Number(row.key_version),
        expiresAtMs: row.expires_at ? Date.parse(row.expires_at) : null,
      });
      return plaintextSecret;
    } catch (err) {
      if (isUndefinedTableError(err)) {
        if (!schemaMissingWarned) {
          schemaMissingWarned = true;
          diagnostic('message_secret_table_unavailable', {
            session_ref: sessionRef(scope.sessionId),
            error_code: '42P01',
            fallback_storage: 'ram_only',
          });
        }
        return null;
      }
      diagnostic('message_secret_decrypt_failed', {
        session_ref: sessionRef(scope.sessionId),
        chat_kind: jidKind(scope.chatJid),
        source: 'db',
        error_name: err?.name || 'Error',
      });
      return null;
    }
  }

  async function clearSessionSecrets(sessionId, { pool = null } = {}) {
    if (!sessionId) return 0;
    const prefix = `${String(sessionId)}\0`;
    let clearedRam = 0;
    for (const k of encryptedCache.keys()) {
      if (k.startsWith(prefix)) {
        encryptedCache.delete(k);
        clearedRam += 1;
      }
    }
    const dbPool = resolvePool(pool);
    if (dbPool && typeof dbPool.query === 'function') {
      try {
        const res = await dbPool.query(
          'DELETE FROM whatsapp_private.message_secrets WHERE session_id = $1',
          [String(sessionId)],
        );
        return res?.rowCount ?? clearedRam;
      } catch (err) {
        if (!isUndefinedTableError(err)) {
          diagnostic('message_secret_clear_failed', {
            session_ref: sessionRef(String(sessionId)),
            error_code: err?.code || 'ERR',
          });
        }
      }
    }
    return clearedRam;
  }

  async function purgeExpired({ pool = null } = {}) {
    const now = Date.now();
    let purgedRam = 0;
    for (const [k, entry] of encryptedCache.entries()) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) {
        encryptedCache.delete(k);
        purgedRam += 1;
      }
    }
    let purgedDb = 0;
    const dbPool = resolvePool(pool);
    if (dbPool && typeof dbPool.query === 'function') {
      try {
        const res = await dbPool.query(
          'DELETE FROM whatsapp_private.message_secrets WHERE expires_at IS NOT NULL AND expires_at <= NOW()',
        );
        purgedDb = res?.rowCount ?? 0;
      } catch (err) {
        if (!isUndefinedTableError(err)) {
          diagnostic('message_secret_purge_failed', {
            error_code: err?.code || 'ERR',
          });
        }
      }
    }
    return { purgedRam, purgedDb };
  }

  function clearRamCache() {
    encryptedCache.clear();
  }

  function hasCachedSecret({ sessionId, chatJid, waMessageId }) {
    return encryptedCache.has(buildRamKey(sessionId, chatJid, waMessageId));
  }

  function getStats() {
    return {
      ramSize: encryptedCache.size,
      maxEntries: resolvedMaxEntries,
      ramEvictions,
      schemaMissingWarned,
      defaultTtlMs: resolvedDefaultTtlMs,
      activeKeyVersion: version,
      allowTestKeys: Boolean(allowTestKeys),
    };
  }

  return {
    activeKeyVersion: version,
    saveSecret,
    getSecret,
    clearSessionSecrets,
    purgeExpired,
    clearRamCache,
    hasCachedSecret,
    getStats,
    deriveSubkeyForTest: (ver) => derivedKeys.get(Number(ver)),
  };
}
