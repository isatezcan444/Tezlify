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
  BufferJSON,
} from '@whiskeysockets/baileys';
import { createBaileysLogger, logger as defaultLogger } from '../utils/baileys-logger.js';
import { lookupRawMessage } from '../messages/message-store.js';
import { rememberLidPair, resolveJidKey, jidToPhone } from '../utils/whatsapp-identity.js';

export function applyDiscoveredLidMapping(store, lidJid, phoneJid, onDiscovered) {
  if (typeof onDiscovered === 'function') {
    onDiscovered(lidJid, phoneJid);
    return;
  }
  rememberLidPair(store, lidJid, phoneJid);
}
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
  const authLoaded = (authRepository && !session.ephemeral)
    ? await authRepository.createAuthState(id, sessionDir)
    : await useMultiFileAuthState(sessionDir);
  const { state } = authLoaded;
  const rawSaveCreds = authLoaded.saveCreds;

  const diskSaveCreds = async () => {
    try {
      if (typeof rawSaveCreds === 'function') {
        await rawSaveCreds();
      } else if (state.creds) {
        fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(state.creds, BufferJSON.replacer));
      }
    } catch { /* best-effort disk write */ }
  };

  const saveCreds = async () => {
    if (authRepository && !session.ephemeral) {
      try {
        await authRepository.saveCredentials(id, state.creds);
      } catch (err) {
        logger.warn({ err: err?.message, session_ref: sessionRef(id) }, 'Failed to persist credentials to PostgreSQL');
      }
      await diskSaveCreds();
    } else {
      await diskSaveCreds();
    }
  };
  latency('auth_state_load_ms', authLoadStarted, id);

  if (state?.keys?.set) {
    const origKeysSet = state.keys.set.bind(state.keys);
    state.keys.set = async (data) => {
      await origKeysSet(data);
      if (authRepository && !session.ephemeral && typeof authRepository.setSignalKeys === 'function') {
        try {
          await authRepository.setSignalKeys(id, data);
        } catch (dbErr) {
          logger.warn({ err: dbErr?.message, session_ref: sessionRef(id) }, 'Failed to mirror signal keys to PostgreSQL');
        }
      }
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
              applyDiscoveredLidMapping(session.store, lidJid, phoneJid, onLidMappingDiscovered);
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
    // Stamp the persisted name cache with the number this session is actually
    // linked to, so a later re-link onto a DIFFERENT number on the same session
    // id discards stale names instead of showing another account's contacts.
    try { store?.contactCache?.setSessionPhone(session.phone_number); } catch { /* best-effort */ }
  }
  if (state?.creds?.me?.lid) {
    session.self_lid = resolveJidKey(store, state.creds.me.lid);
  }
  if (session.self_lid && session.self_jid) {
    applyDiscoveredLidMapping(store, session.self_lid, session.self_jid, onLidMappingDiscovered);
  }

  if (state?.creds?.me) {
    if (!state.creds.me.name) {
      state.creds.me.name = session.session_name || 'Tezlify';
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
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreviews: false,
    shouldSyncHistoryMessage: () => true,
    getMessage: async (key) => lookupRawMessage(store, key),
    msgRetryCounterCache: retryCounterCacheFor(id),
  });

  // Guard against Baileys creds.update partial update presence bug (WhiskeySockets/Baileys Issue #2553)
  // and prevent WhatsApp server from marking the companion device as online/active (which suppresses
  // push notifications on the user's primary mobile phone).
  //
  // 1. Intercept `sock.sendNode`: If any code emits a <presence> stanza that is not explicitly
  //    marked as `unavailable` or `subscribe`, convert it to `type="unavailable"`.
  // 2. Intercept `sock.ev.emit`: Ensure state.creds.me.name stays in sync with update.me.name so
  //    Baileys internal `creds.me?.name !== name` check never triggers rogue presence.
  if (sock.sendNode) {
    const originalSendNode = sock.sendNode.bind(sock);
    sock.sendNode = async (node) => {
      if (node?.tag === 'presence') {
        if (!node.attrs) node.attrs = {};
        if (node.attrs.type !== 'unavailable' && node.attrs.type !== 'subscribe') {
          logger.debug({ attrs: node.attrs }, 'Converting online presence stanza to unavailable to preserve mobile phone notifications');
          node.attrs.type = 'unavailable';
        }
      }
      return originalSendNode(node);
    };
  }

  const passThrough = sock.ev.emit.bind(sock.ev);
  sock.ev.emit = (event, data) => {
    if (event === 'creds.update' && data) {
      if (data.myAppStateKeyId && state.creds) {
        state.creds.myAppStateKeyId = data.myAppStateKeyId;
      }
      if (data.me?.name && state.creds?.me) {
        state.creds.me.name = data.me.name;
      }
      if (data.me === undefined && state.creds?.me) {
        if (!state.creds.me.name) {
          state.creds.me.name = session.session_name || 'Tezlify';
        }
        return passThrough(event, { ...data, me: state.creds.me });
      }
      if (data.me && !data.me.name && state.creds?.me?.name) {
        data.me.name = state.creds.me.name;
      }
    }
    return passThrough(event, data);
  };

  return {
    sock,
    state,
    saveCreds,
    connectStarted,
    socketStarted,
    sessionDir,
  };
}

/**
 * In WhatsApp Multi-Device protocol, linked companion devices send an active IQ stanza:
 *   <iq to="@s.whatsapp.net" xmlns="passive" type="set"><active/></iq>
 * to inform WhatsApp servers that the companion is actively listening for incoming messages
 * over the WebSocket stream.
 *
 * NOTE: Setting `<passive/>` causes WhatsApp servers to stop streaming incoming messages
 * over the WebSocket (routing them only as offline notifications/phone pushes). Therefore,
 * the connection MUST remain in `active` mode to receive real-time messages.
 *
 * Phone notifications on the primary mobile device are handled separately by PRESENCE:
 * keeping presence set to `type="unavailable"` tells WhatsApp servers that the user is not
 * actively viewing the companion on screen, which triggers push notifications to the phone.
 */
export async function setCompanionActive(sock, logger, sessionRef) {
  if (!sock?.query) return;
  try {
    await sock.query({
      tag: 'iq',
      attrs: {
        to: '@s.whatsapp.net',
        xmlns: 'passive',
        type: 'set',
      },
      content: [{ tag: 'active', attrs: {} }],
    });
    logger?.debug({ session_ref: sessionRef }, 'Companion client successfully set to active stream');
  } catch (err) {
    logger?.debug({ err: err?.message, session_ref: sessionRef }, 'Active IQ stanza announcement ignored or failed');
  }
}

