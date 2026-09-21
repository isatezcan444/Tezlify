/**
 * WhatsApp Socket Connector and Auth State Resolver.
 *
 * Encapsulates Baileys socket instantiation, encrypted file auth snapshots,
 * and signal keystore caching.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { createBaileysLogger, logger as defaultLogger } from '../utils/baileys-logger.js';
import { lookupRawMessage } from '../messages/message-store.js';
import { rememberLidPair, resolveJidKey, jidToPhone } from '../utils/whatsapp-identity.js';
import { diagnostic, sessionRef, latency } from '../observability.js';

export function encryptBuffer(buf, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

export function decryptBuffer(buf, key) {
  const iv = buf.subarray(0, 16);
  const encrypted = buf.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function safeWriteEncrypted(filePath, data, key) {
  const encrypted = encryptBuffer(Buffer.from(JSON.stringify(data)), key);
  fs.writeFileSync(filePath, encrypted);
}

export function safeReadEncrypted(filePath, key, log = defaultLogger) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const encrypted = fs.readFileSync(filePath);
    const decrypted = decryptBuffer(encrypted, key);
    return JSON.parse(decrypted.toString('utf-8'));
  } catch (err) {
    log.warn({ err }, 'Failed to decrypt session file, ignoring');
    return null;
  }
}

export async function createSocketForSession({
  id,
  session,
  generation,
  sessionsDir,
  aesKey,
  authRepository,
  logger = defaultLogger,
  retryCounterCacheFor,
  onLidMappingDiscovered,
}) {
  const connectStarted = performance.now();
  const sessionDir = path.join(sessionsDir, id);
  fs.mkdirSync(sessionDir, { recursive: true });

  const authFilesBefore = fs.readdirSync(sessionDir).filter((name) => name.endsWith('.json'));
  diagnostic('socket_connect_started', {
    session_ref: sessionRef(id),
    generation,
    previous_socket_present: Boolean(session.sock),
    auth_json_files: authFilesBefore.length,
  });

  const persisted = authRepository
    ? null
    : safeReadEncrypted(path.join(sessionDir, 'auth.json'), aesKey, logger);
  const authLoadStarted = performance.now();
  const { state, saveCreds } = (authRepository && !session.ephemeral)
    ? await authRepository.createAuthState(id)
    : await useMultiFileAuthState(sessionDir);
  latency('auth_state_load_ms', authLoadStarted, id);

  if (state?.keys?.set) {
    const origKeysSet = state.keys.set.bind(state.keys);
    state.keys.set = async (data) => {
      await origKeysSet(data);
      try {
        const lidData = data && data['lid-mapping'];
        if (lidData && typeof lidData === 'object') {
          for (const [k, val] of Object.entries(lidData)) {
            if (!val || typeof val !== 'string') continue;
            let pnUser = null;
            let lidUser = null;
            if (k.endsWith('_reverse')) {
              lidUser = k.replace('_reverse', '');
              pnUser = val;
            } else {
              pnUser = k;
              lidUser = val;
            }
            if (pnUser && lidUser && !pnUser.includes('@') && !lidUser.includes('@')) {
              const lidJid = `${lidUser}@lid`;
              const phoneJid = `${pnUser}@s.whatsapp.net`;
              if (typeof onLidMappingDiscovered === 'function') {
                onLidMappingDiscovered(lidJid, phoneJid);
              }
            }
          }
        }
      } catch (interceptErr) {
        logger.warn({ err: interceptErr?.message }, 'Failed to intercept lid-mapping in state.keys.set');
      }
    };
  }

  diagnostic('auth_state_loaded', {
    session_ref: sessionRef(id),
    generation,
    encrypted_snapshot_present: Boolean(persisted),
    creds_file_present: authFilesBefore.includes('creds.json'),
    signal_key_files: authFilesBefore.filter((name) => !['auth.json', 'creds.json', 'keys.json'].includes(name)).length,
    registered: Boolean(state?.creds?.registered),
    key_store_get: typeof state?.keys?.get === 'function',
    key_store_set: typeof state?.keys?.set === 'function',
  });

  session._isRegistered = Boolean(state?.creds?.registered || session.phone_number);

  if (!authRepository && persisted?.creds) {
    if (!session._diagnosticLegacyRestoreLogged) {
      session._diagnosticLegacyRestoreLogged = true;
      diagnostic('legacy_auth_restore_after_state_load', {
        session_ref: sessionRef(id),
        generation,
        snapshot_keys_type: typeof persisted.keys,
      });
    }
    try {
      const restored = {
        creds: persisted.creds,
        keys: persisted.keys || {},
      };
      fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(restored.creds));
      fs.writeFileSync(path.join(sessionDir, 'keys.json'), JSON.stringify(restored.keys));
    } catch (err) {
      logger.warn({ err }, 'Failed to restore session state');
    }
  }

  const store = session.store;
  if (state?.creds?.me?.id) {
    const cleanJid = resolveJidKey(store, state.creds.me.id);
    session.self_jid = cleanJid;
    session.phone_number = jidToPhone(cleanJid) || session.phone_number;
  }
  if (state?.creds?.me?.lid) {
    session.self_lid = resolveJidKey(store, state.creds.me.lid);
  }
  if (session.self_lid && session.self_jid) {
    rememberLidPair(store, session.self_lid, session.self_jid);
    if (typeof onLidMappingDiscovered === 'function') {
      onLidMappingDiscovered(session.self_lid, session.self_jid);
    }
  }

  const versionStarted = performance.now();
  const { version } = await fetchLatestBaileysVersion();
  latency('provider_version_lookup_ms', versionStarted, id);
  const baileysAuth = authRepository
    ? { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }
    : state;
  const socketStarted = performance.now();
  const sock = makeWASocket({
    version,
    logger: createBaileysLogger(logger),
    browser: Browsers.macOS('Chrome'),
    auth: baileysAuth,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreviews: false,
    shouldSyncHistoryMessage: () => true,
    getMessage: async (key) => lookupRawMessage(store, key),
    msgRetryCounterCache: retryCounterCacheFor(id),
  });

  return {
    sock,
    state,
    saveCreds,
    connectStarted,
    socketStarted,
    sessionDir,
  };
}
