/**
 * Session Manager Facade & Orchestrator - Baileys WhatsApp Web session lifecycle.
 *
 * Adheres to Clean Architecture & SOLID (SRP):
 * Coordinates session persistence, distributed leases, multi-tenant LID scoping,
 * media storage, in-memory stores, and socket lifecycles through dedicated modules.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { performance } from 'perf_hooks';
import { diagnostic, sessionRef, latency } from './observability.js';
import { SocketLifecycle } from './domain/socket-lifecycle.js';
import { createBoundedCache, isAvatarUrlExpired } from './domain/bounded-cache.js';
import { expandAppStateKeys } from 'whatsapp-rust-bridge';
import { hmacSign } from '@whiskeysockets/baileys/lib/Utils/crypto.js';

// Utils
import {
  NAME_RANK,
  isLidJid,
  isStatusBroadcastJid,
  isNewsletterJid,
  isBroadcastOnlyJid,
  asLid,
  asPn,
  jidToPhone,
  isDegenerateJid,
  isRawIdentityName,
  isPhoneLikeName,
  isSavedContactName,
  contactPhoneJid,
  normalizePairingPhone,
  mergeContactName,
  rememberLidPair,
  resolveJidKey,
  lidPairsFromMessageKey,
} from './utils/whatsapp-identity.js';

import {
  TYPE_PREVIEW_LABELS,
  normalizePreviewText,
  buildChatPreview,
  sanitizeChatForEmit,
  sanitizeOutboundEvent,
  resolveSyncState,
  archivedPatch,
} from './utils/whatsapp-formatting.js';

import {
  logger,
  createBaileysLogger,
  extractBaileysErrorDetails,
} from './utils/baileys-logger.js';

// Messages & Media
import {
  resolveDownloadableMedia,
  classifyMessageType,
  hasRecognizedContent,
  summarizeWaMessage,
  systemContentMarker,
  buildMediaContent,
  extractLinkPreviewMetadata,
} from './messages/message-classifier.js';

import {
  RAW_MESSAGE_STORE_MAX,
  createSessionStore,
  rememberRawMessage,
  lookupRawMessage,
  messageTimestampMs,
} from './messages/message-store.js';

import { createMediaStore } from './media/media-store.js';
import { transcodeToOggOpus } from './media/audio-transcoder.js';

// Lease & LID
import { createLeaseCoordinator } from './lease/lease-coordinator.js';
import { createLidRepository, lidScopeSessionIds } from './lid/lid-repository.js';
import { createContactRepository } from './contacts/contact-repository.js';

// Socket
import {
  createSocketForSession,
  safeReadEncrypted,
  safeWriteEncrypted,
} from './socket/socket-connector.js';
import { bindSocketEvents } from './socket/socket-events.js';

// Baileys/WA ack rank and order.
//
// Baileys delivers `ERROR: 0` when WhatsApp REJECTS a message (block, not a
// contact, rate limit, a too-large attachment). That receipt is the only
// signal that the message will never arrive, and it used to be dropped: the
// rank table had no entry for 0, so `newStatus` was undefined and the handler
// returned early. The message stayed SENT forever, and because the terminal-ack
// short-circuit then returned that stored row, it was never retried either.
//
// The user saw a permanent, silent false positive — AGENTS.md 1.1 forbids
// exactly this.
const ACK_RANK = { 0: 'FAILED', 2: 'SENT', 3: 'DELIVERED', 4: 'READ', 5: 'READ' };
const ACK_ORDER = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 0 };

function resolveMessageStatus(msg, fromMe, reactions) {
  if (!fromMe) return 'RECEIVED';
  if (Array.isArray(reactions) && reactions.some((r) => r?.emoji || r?.text)) {
    return 'READ';
  }
  const rawStatus = msg?.status;
  if (typeof rawStatus === 'number') {
    if (rawStatus === 4 || rawStatus === 5) return 'READ';
    if (rawStatus === 3) return 'DELIVERED';
    if (rawStatus === 2) return 'SENT';
    if (rawStatus === 0) return 'FAILED';
  } else if (typeof rawStatus === 'string') {
    const s = rawStatus.toUpperCase();
    if (s === 'READ' || s === 'PLAYED') return 'READ';
    if (s === 'DELIVERED' || s === 'DELIVERY_ACK') return 'DELIVERED';
    if (s === 'SENT' || s === 'SERVER_ACK') return 'SENT';
    if (s === 'FAILED' || s === 'ERROR') return 'FAILED';
  }
  return 'SENT';
}

// Avatar sweep pacing.
//
// Canlı ölçüm (production gateway, 8 ardışık `profilePictureUrl` çağrısı):
//   min 55ms · medyan 149ms · max 248ms · 0 hata · 0 rate-limit
// Yani istek başına ~150ms; 94 sohbetlik bir tur teorik olarak ~14-30 saniye.
//
// Buradaki değerler iki deneyimden türetildi:
//  1) Eskiden 3'lük batch + 100ms tempo (~30 istek/sn) WhatsApp'ın tek
//     geçişli throttle'una takılıyor ve bu sohbetlerin avatarı KALICI eksik
//     kalıyordu. O yüzden istek/sn EŞZAMANLILIK artırılarak değil, tempo
//     düşürülerek yönetilir: batch 4 + 250ms ≈ 3.2 istek/sn, yani 30/sn'in
//     onda biri. Bu, ölçülen ~150ms istek süresinin üstünde bir taban bırakır
//     (asla boşta bekleyen batch üretmez) ama throttle eşiğinin altında kalır.
//  2) Gerçek gecikme pacing'de değil geri çekilmedeydi: ilk başarısız turdan
//     sonra 30sn+60sn+120sn+5dk×4 = ~23.5dk bekleniyordu. İlk turlar kısa
//     tutuldu; kalıcı eksikler ancak çok sonra (5dk) yeniden denenir.
const AVATAR_SWEEP_BATCH = 4;
const AVATAR_SWEEP_PAUSE_MS = 250;
const AVATAR_SWEEP_MAX_PASSES = 8;
// İlk turlar hızlı (bir tur ~30sn), sonra mesafeli. Toplam bekleme ~8dk yerine
// ilk turda 8sn: kullanıcı fotoğrafı dakikalarca beklemez.
const AVATAR_SWEEP_RETRY_DELAYS_MS = [8_000, 15_000, 30_000, 60_000, 300_000, 300_000, 300_000];
const AVATAR_QUERY_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Sweep re-arm while the store is still filling.
//
// The store is filled asynchronously by Baileys (`chats.update`, history sync).
// A sweep armed at that moment sees zero chats and exits, so nothing ever asks
// WhatsApp for the pictures unless an unrelated event re-triggers it. These two
// helpers keep the sweep alive across that window WITHOUT becoming a busy loop:
// a bounded number of re-arms, spaced by a growing delay, and only while the
// session is still connected with an empty store.
// ---------------------------------------------------------------------------
const AVATAR_REARM_MAX = 5;
const AVATAR_REARM_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

// ---------------------------------------------------------------------------
// App-state sync recovery
// ---------------------------------------------------------------------------
// WHY THIS IS NEEDED
// ------------------
// Baileys parks an app-state collection that is missing a decryption key:
//   "regular blocked on missing key from v0, parking after 2 attempts"
// It adds the collection to a module-level `blockedCollections` set and only
// retries it when `myAppStateKeyId` arrives via `creds.update`. In production
// that key never arrived (verified: zero "app state sync key arrived" lines in
// the gateway log), so `regular` stayed parked for the life of the process and
// the chat list never populated — the `chats: 0` symptom.
//
// Baileys clears the block on a full sync or on `connection.close`, but neither
// happens on a long-lived connected session. So we own the retry.
//
// MEASURED CORRECTION (production, session 73155bba, 2026-10-01). The earlier
// gate — "retry only while the store has no chats" — is WRONG, and a populated
// store is not evidence that app-state works:
//
//   park   regular_low                    1790841765872
//   write  app-state-sync-key-AAAAAPAM.json 1790841766000  (129 ms later)
//   frozen regular_low                    1790841766000  (never advanced again)
//   advanced regular_high                 1790842042000  (4.5 min later)
//
// The same session reported `chats: 118` from history sync while `regular_low`
// — the collection that carries chat-level actions (archive / markChatAsRead /
// chat delete) — stayed frozen. Stopping the retry the moment the store filled
// therefore left exactly the broken collection un-retried.
//
// The recovery now keys on APP-STATE health, never on chat-store size, and
// re-requests every collection rather than a subset.
const APPSTATE_PATCH_NAMES = [
  'critical_block',
  'critical_unblock_low',
  'regular',
  'regular_low',
  'regular_high',
];
const APPSTATE_REARM_MAX = 6;
const APPSTATE_REARM_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/**
 * Fingerprint of app-state progress: mtime+size of every collection's version
 * file. A resync that actually decoded patches advances the collection it
 * decoded, so a change in this string is positive evidence that the app-state
 * path is alive. This is a local `stat`, never a network call.
 */
export function readAppStateProgress(sessionDir) {
  if (!sessionDir) return null;
  const parts = [];
  for (const name of APPSTATE_PATCH_NAMES) {
    try {
      const st = fs.statSync(path.join(sessionDir, `app-state-sync-version-${name}.json`));
      parts.push(`${name}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${name}:-`);
    }
  }
  return parts.join('|');
}

/**
 * Retry the app-state sync until the collections are demonstrably alive.
 *
 * Stopping rule: POSITIVE evidence (`store.appStateHealthy`), not the absence of
 * chats. A populated store proves history sync worked; it says nothing about
 * app-state, and conflating the two is what stranded the parked collections.
 */
export function shouldRearmAppState(session, store) {
  if (!store || !session) return false;
  if (session._deleted || session._shuttingDown) return false;
  if (session.status !== 'CONNECTED' || !session.sock) return false;
  if (typeof session.sock.resyncAppState !== 'function') return false;
  if (store.appStateHealthy === true) return false;
  const attempts = Number(store._appStateRearmCount) || 0;
  return attempts < APPSTATE_REARM_MAX;
}

function scheduleAppStateRearm(manager, session, store, sessionDir) {
  const attempts = Number(store._appStateRearmCount) || 0;
  if (attempts >= APPSTATE_REARM_MAX) return;
  const delay = APPSTATE_REARM_DELAYS_MS[Math.min(attempts, APPSTATE_REARM_DELAYS_MS.length - 1)];
  store._appStateRearmCount = attempts + 1;
  const timer = setTimeout(async () => {
    if (!shouldRearmAppState(session, store)) {
      store._appStateRearmCount = 0;
      return;
    }
    const before = readAppStateProgress(sessionDir);
    try {
      await session.sock.resyncAppState(APPSTATE_PATCH_NAMES, false);
      logger.info(
        { session_ref: sessionRef(session.id), attempt: attempts + 1 },
        'App-state re-arm resync completed',
      );
    } catch (err) {
      logger.warn(
        { session_ref: sessionRef(session.id), attempt: attempts + 1, err: err?.message },
        'App-state re-arm resync failed; will retry',
      );
    }
    const after = readAppStateProgress(sessionDir);
    if (before !== null && after !== null && after !== before) {
      // The decode advanced a collection: app-state is alive, stop retrying.
      store.appStateHealthy = true;
      store._appStateRearmCount = 0;
      logger.info(
        { session_ref: sessionRef(session.id), attempt: attempts + 1 },
        'App-state collections advanced; recovery complete',
      );
      return;
    }
    if (shouldRearmAppState(session, store)) {
      scheduleAppStateRearm(manager, session, store, sessionDir);
    } else {
      store._appStateRearmCount = 0;
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Re-arm only while connected and the store has not produced chats yet. */
function shouldRearmWhenEmpty(store, session) {
  if (!store || !session) return false;
  if (session._deleted || session._shuttingDown) return false;
  if (session.status !== 'CONNECTED' || !session.sock) return false;
  // The avatar sweep DOES legitimately stop on a populated store: its job is to
  // fetch pictures for whatever the store already holds. App-state recovery is
  // the opposite — see `shouldRearmAppState` for why it must not use this rule.
  if (store.chats && store.chats.size > 0) return false;
  const attempts = Number(store._avatarRearmCount) || 0;
  return attempts < AVATAR_REARM_MAX;
}

function scheduleRearm(manager, session, store) {
  const attempts = Number(store._avatarRearmCount) || 0;
  if (attempts >= AVATAR_REARM_MAX) return;
  const delay = AVATAR_REARM_DELAYS_MS[Math.min(attempts, AVATAR_REARM_DELAYS_MS.length - 1)];
  store._avatarRearmCount = attempts + 1;
  const timer = setTimeout(() => {
    // Chats landed in the meantime -> the sweep will find them and this
    // re-arm chain is finished.
    if (shouldRearmWhenEmpty(store, session)) {
      logger.debug(
        { session_ref: sessionRef(session.id), attempt: attempts + 1 },
        'Re-arming avatar sweep: store still empty',
      );
      manager._scheduleBackgroundAvatarFetch(session);
    } else {
      store._avatarRearmCount = 0;
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

function getSessionDir(sessionsDir, sessionId) {
  return path.join(sessionsDir, sessionId);
}

// ---------------------------------------------------------------------------
// Backward-compatible named exports
// ---------------------------------------------------------------------------
export {
  logger,
  createBaileysLogger,
  extractBaileysErrorDetails,
  isRawIdentityName,
  sanitizeChatForEmit,
  sanitizeOutboundEvent,
  mergeContactName,
  NAME_RANK,
  jidToPhone,
  isDegenerateJid,
  resolveSyncState,
  normalizePreviewText,
  buildChatPreview,
  isPhoneLikeName,
  summarizeWaMessage,
  classifyMessageType,
  hasRecognizedContent,
  resolveDownloadableMedia,
  contactPhoneJid,
  normalizePairingPhone,
  resolveJidKey,
  lidScopeSessionIds,
  buildMediaContent,
};

// ---------------------------------------------------------------------------
// Session Manager Factory
// ---------------------------------------------------------------------------
export function createSessionManager({
  sessionsDir,
  mediaDir,
  aesKey,
  backendWsUrl,
  authRepository = null,
  leaseRepository = null,
  instanceId = 'local-instance',
  pool = null,
}) {
  const sessions = new Map();
  const pairingCodeInFlight = new Map();
  const msgRetryCounterCaches = new Map();
  const inFlightHistoryFetches = new Map();
  const pendingHistoryWaiters = new Map();

  const mediaStore = createMediaStore({ mediaDir, logger });
  const leaseCoordinator = createLeaseCoordinator({ leaseRepository, instanceId, logger });
  const lidRepository = createLidRepository({
    pool,
    sessionsDir,
    logger,
    // A LID write failing on a missing session row is the same orphan as an
    // outbox write failing: the whatsapp_sessions row is gone. Flag the session
    // so the UI can say the session is connected but not being stored.
    onOrphaned: (sessionId) => { manager.markOrphaned(sessionId, 'lid_mapping'); },
  });
  const contactRepository = createContactRepository({ pool, logger });

  function clearSessionHistoryFetches(sessionId) {
    for (const [flightKey, waiter] of pendingHistoryWaiters.entries()) {
      if (waiter.sessionId === sessionId) {
        clearTimeout(waiter.timer);
        waiter.resolve([]);
        pendingHistoryWaiters.delete(flightKey);
        inFlightHistoryFetches.delete(flightKey);
      }
    }
  }

  function retryCounterCacheFor(sessionId) {
    let cache = msgRetryCounterCaches.get(String(sessionId));
    if (!cache) {
      cache = createBoundedCache({ maxEntries: 10_000, ttlMs: 60 * 60 * 1000 });
      msgRetryCounterCaches.set(String(sessionId), cache);
    }
    return cache;
  }

  function resetRetryCounterCache(sessionId) {
    const cache = msgRetryCounterCaches.get(String(sessionId));
    cache?.close();
    msgRetryCounterCaches.delete(String(sessionId));
  }

  async function deactivatePersistentSession(sessionId) {
    if (!authRepository) return;
    try {
      await authRepository.clearAuth(sessionId);
      await authRepository.setSessionActive(sessionId, false);
    } catch (err) {
      logger.error({ err, session_ref: sessionRef(sessionId) }, 'Persistent auth cleanup failed');
    }
  }

  const persistedSessionDirectories = fs.existsSync(sessionsDir)
    ? fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    : 0;

  diagnostic('session_registry_initialized', {
    in_memory_sessions: sessions.size,
    persisted_session_directories: persistedSessionDirectories,
    restored_sessions: 0,
  });

  const sessionManager = {
    _listeners: new Set(),

    _emit(event) {
      const gwSid = event && (event.gateway_session_id || event.session_id);
      if (gwSid && !sessions.has(String(gwSid)) && !String(event.event || '').startsWith('session_deleted')) {
        return;
      }
      const sanitized = sanitizeOutboundEvent(event);
      for (const listener of this._listeners) {
        try { listener(sanitized); } catch (err) { logger.warn({ err }, 'Event listener error'); }
      }
    },

    onEvent(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    },

    async shutdown() {
      const leaseReleases = [];
      for (const session of sessions.values()) {
        session._shuttingDown = true;
        session.lifecycle.invalidate();
        if (session._historyQuietTimer) {
          clearTimeout(session._historyQuietTimer);
          session._historyQuietTimer = null;
        }
        if (session._presenceKeepaliveTimer) {
          clearInterval(session._presenceKeepaliveTimer);
          session._presenceKeepaliveTimer = null;
        }
        try { session.sock?.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { session.sock?.end(undefined); } catch (err) { /* ignore */ }
        session.sock = null;
        session.is_phone_online = false;
        // Persist any name learned since the last debounced write, otherwise a
        // restart loses exactly the names this cache exists to keep.
        try { session.store?.contactCache?.flush(); } catch (err) { /* ignore */ }
        if (leaseRepository) leaseReleases.push(leaseCoordinator.releaseLease(session));
      }
      await Promise.allSettled(leaseReleases);
      diagnostic('session_registry_shutdown', { sessions: sessions.size });
    },

    // -----------------------------------------------------------------------
    // Session CRUD
    // -----------------------------------------------------------------------
    listSessions() {
      return [...sessions.values()].map((s) => ({
        id: s.id,
        session_name: s.session_name,
        status: s.status,
        phone_number: s.phone_number || null,
        self_jid: s.self_jid || null,
        self_lid: s.self_lid || null,
        is_active: s.is_active,
        is_phone_online: s.is_phone_online || false,
        battery_level: s.battery_level ?? null,
        error_message: s.error_message || null,
        qr_code: s.status === 'SCAN_QR' ? s.qr_code : null,
        sync: s.sync || { phase: 'idle' },
        created_at: s.created_at,
        updated_at: s.updated_at,
        // Set when a durable write failed with a foreign-key violation, i.e.
        // the whatsapp_sessions row for this gateway session is gone. Surfaced
        // here so the operator SEES that the session is not being stored,
        // instead of discovering it later as missing history.
        orphaned: Boolean(s._orphaned),
        orphaned_since: s._orphaned_since || null,
      }));
    },

    /**
     * Mark a session as orphaned: its database row no longer exists.
     *
     * Called from the outbox/LID write paths when PostgreSQL reports a
     * foreign-key violation. The session stays CONNECTED — it really is — but
     * nothing it emits is being stored, so the UI must say so rather than
     * showing a healthy session whose data goes nowhere.
     */
    markOrphaned(sessionId, detail) {
      const session = sessions.get(String(sessionId));
      if (!session) return false;
      if (session._orphaned) return false;
      session._orphaned = true;
      session._orphaned_since = new Date().toISOString();
      session._orphaned_detail = detail || null;
      logger.error(
        { session_ref: sessionRef(session.id), detail: detail || null },
        'Session is orphaned: its database row no longer exists. Events from it ' +
        'reach the backend over the live socket only and are lost on restart. ' +
        'Re-pair the number to register a live session row.',
      );
      return true;
    },

    /** Sessions the database no longer knows about. */
    listOrphaned() {
      return [...sessions.values()]
        .filter((s) => s._orphaned)
        .map((s) => ({
          id: s.id,
          session_name: s.session_name,
          status: s.status,
          since: s._orphaned_since || null,
        }));
    },

    getSession(id) {
      return sessions.get(id) || null;
    },

    async restoreSessions({ concurrency = 2 } = {}) {
      if (!authRepository) return { discovered: 0, restored: 0 };
      const records = await authRepository.listRestorableSessions();
      let restored = 0;
      for (let offset = 0; offset < records.length; offset += concurrency) {
        const batch = records.slice(offset, offset + concurrency);
        await Promise.all(batch.map(async (record) => {
          const id = String(record.session_id);
          if (sessions.has(id)) return;
          const session = await this.createSession(record.session_name, {
            id,
            autoStart: false,
            persistRegistry: false,
          });
          session.status = 'RESTORING';
          this._startSocket(id);
          restored += 1;
        }));
      }
      diagnostic('session_registry_restored', {
        discovered: records.length,
        restored,
        concurrency,
      });
      return { discovered: records.length, restored };
    },

    async createSession(name, {
      autoStart = true,
      id: requestedId = null,
      persistRegistry = true,
      ephemeral = false,
    } = {}) {
      const id = requestedId ? String(requestedId) : uuidv4();
      if (sessions.has(id)) return this.getSession(id);
      if (authRepository && persistRegistry && !ephemeral) {
        await authRepository.registerSession(id, name, { active: true });
      }
      const session = {
        id,
        session_name: name,
        ephemeral: Boolean(ephemeral),
        status: 'SCAN_QR',
        qr_code: null,
        phone_number: null,
        self_jid: null,
        self_lid: null,
        is_active: true,
        is_phone_online: false,
        battery_level: null,
        error_message: null,
        error_reason: null,
        _connFailures: 0,
        _qrSeenForAttempt: false,
        _pairingPhone: null,
        _pairingRequestedAt: 0,
        _pairingSocket: null,
        sync: {
          phase: 'idle', progress: 0,
          chats_synced: 0, contacts_synced: 0, messages_synced: 0,
          chats_unique: 0, contacts_unique: 0, messages_cached: 0,
          started_at: null, completed_at: null,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sock: null,
        lifecycle: new SocketLifecycle(),
        _leaseRenewTimer: null,
        _leaseRetryTimer: null,
        _leaseRenewing: false,
        _leaseValidUntil: 0,
        store: createSessionStore({
          sessionDir: getSessionDir(sessionsDir, id),
          logger,
        }),
      };
      // An ephemeral pairing must not write LID mappings to PostgreSQL before
      // its gateway_sessions row exists (the FK would reject it).
      await lidRepository.loadLidMappingsFromDb(id, session.store, undefined, { persist: !ephemeral });
      // The backend `contacts` table is the durable record of the names this
      // gateway learned earlier. Without this the store starts empty on every
      // restart and sender labels degrade to raw phone numbers.
      await contactRepository.hydrateContactNames(id, session.store);
      sessions.set(id, session);
      if (autoStart) this._startSocket(id);
      return this.getSession(id);
    },

    async refreshQr(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      if (session.status === 'CONNECTED') return this.getSession(id);
      diagnostic('qr_refresh_requested', {
        session_ref: sessionRef(id),
        current_generation: session._diagnosticSocketGeneration || 0,
        socket_present: Boolean(session.sock),
      });
      session.status = 'SCAN_QR';
      session.qr_code = null;
      session.error_message = null;
      session.error_reason = null;
      session._connFailures = 0;
      session._qrSeenForAttempt = false;
      session.updated_at = new Date().toISOString();
      if (authRepository) {
        await authRepository.registerSession(id, session.session_name, { active: true });
      }
      session.lifecycle.invalidate();
      await leaseCoordinator.releaseLease(session);
      if (session.sock) {
        try { session.sock.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { session.sock.end(undefined); } catch (err) { /* ignore */ }
        session.sock = null;
      }
      this._startSocket(id);
      return this.getSession(id);
    },

    async requestPairingCode(id, phone) {
      if (pairingCodeInFlight.has(id)) return pairingCodeInFlight.get(id);
      const op = this._requestPairingCodeOnce(id, phone);
      pairingCodeInFlight.set(id, op);
      try {
        return await op;
      } finally {
        pairingCodeInFlight.delete(id);
      }
    },

    async _requestPairingCodeOnce(id, phone) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      if (session._deleted) throw new Error('Session was deleted');
      if (session.status === 'CONNECTED') {
        throw new Error('Bu oturum zaten bağlı. Kod istemek için önce oturumu ayırın.');
      }

      const digits = normalizePairingPhone(phone);

      if (!session.sock) {
        this._startSocket(id);
      }
      const deadline = Date.now() + 15000;
      // Phase 1 §1: exit early on three failure modes the original loop ignored:
      //   - the session was deleted / refreshed / logged out (no more work to do);
      //   - the lifecycle generation was invalidated (a new socket is in flight,
      //     this one is no longer the right one to issue a pairing code on);
      //   - the session transitioned to a terminal/error state (BANNED,
      //     DISCONNECTED) that can never produce a QR pairing code.
      const initialGeneration = session.lifecycle.generation;
      while (Date.now() < deadline) {
        const live = sessions.get(id);
        if (!live || live._deleted) {
          throw new Error('Eşleştirme iptal edildi.');
        }
        if (live.lifecycle.generation !== initialGeneration) {
          throw new Error('Soket yeniden başlatıldı, tekrar deneyin.');
        }
        if (live.status === 'SCAN_QR' && live.sock) break;
        if (live.status === 'BANNED') {
          throw new Error(live.error_message || 'Bu oturum WhatsApp tarafından engellenmiş.');
        }
        if (live.status === 'DISCONNECTED' && live.error_reason === 'LOGGED_OUT') {
          throw new Error('Bu oturum telefondan çıkış yapılmış.');
        }
        if (live.status === 'UNAVAILABLE' || live.status === 'FAILED' || live.status === 'DISCONNECTED') {
          throw new Error(
            live.error_message ||
            'WhatsApp bağlantısı henüz kurulamadı. Birkaç saniye sonra tekrar deneyin.'
          );
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!session.sock) {
        throw new Error('WhatsApp soketi hazırlanamadı. "QR\'ı Yenile" ile tekrar deneyin.');
      }
      if (session.status !== 'SCAN_QR') {
        throw new Error(
          session.error_message ||
          'WhatsApp bağlantısı henüz kurulamadı. Birkaç saniye sonra tekrar deneyin.'
        );
      }

      const pairingCode = await session.sock.requestPairingCode(digits);
      session.phone_number = `+${digits}`;
      session._pairingPhone = digits;
      session._pairingRequestedAt = Date.now();
      session._pairingSocket = session.sock;
      session.updated_at = new Date().toISOString();
      logger.warn({ session_ref: sessionRef(id) }, 'Pairing code generated');
      return { pairing_code: pairingCode, phone: session.phone_number };
    },

    async logoutSession(id, { force = false } = {}) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      session.lifecycle.invalidate();
      await leaseCoordinator.releaseLease(session);
      let providerError = null;
      try {
        if (session.sock) {
          await session.sock.logout();
          session.sock.end(undefined);
        }
      } catch (err) {
        providerError = err;
        logger.warn({ err: err?.message, session_ref: sessionRef(id) }, 'Logout provider error');
      }
      if (providerError && !force) {
        throw new Error(`WhatsApp provider logout failed: ${providerError.message || providerError}`);
      }
      session.status = 'DISCONNECTED';
      session.is_active = false;
      session.is_phone_online = false;
      session._pairingPhone = null;
      session._pairingRequestedAt = 0;
      session._pairingSocket = null;
      if (session._historyQuietTimer) {
        clearTimeout(session._historyQuietTimer);
        session._historyQuietTimer = null;
      }
      if (session._presenceKeepaliveTimer) {
        clearInterval(session._presenceKeepaliveTimer);
        session._presenceKeepaliveTimer = null;
      }
      session.updated_at = new Date().toISOString();
      // Logout means the next link may be a different WhatsApp account, so the
      // cached names must not survive onto it.
      session.store?.contactCache?.clear();
      session.store = createSessionStore({
        sessionDir: getSessionDir(sessionsDir, id),
        logger,
      });
      mediaStore.clearSessionMedia(id);
      clearSessionHistoryFetches(id);
      resetRetryCounterCache(id);
      if (authRepository) {
        await authRepository.clearAuth(id);
        await authRepository.setSessionActive(id, false);
      }
      const dir = getSessionDir(sessionsDir, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      this._emit({ event: 'session_disconnected', session_id: id, session_name: session.session_name });
      return this.getSession(id);
    },

    async deleteSession(id) {
      const session = sessions.get(id);
      if (session) {
        session._deleted = true;
        // Phase 2.1.A: stop any in-flight targeted group-discovery pass for
        // this dying session. The targeted loop checks the 'cancelled'
        // sentinel between groupMetadata calls; without this, a deleted
        // session's pass kept issuing doomed fetches (bounded, but wasted).
        session._groupSubjectsInFlight = 'cancelled';
        // Invalidate FIRST: this makes every socket event that `logout()` is
        // about to provoke (it emits a loggedOut `connection.update`) count as
        // stale, so the close handler cannot run recovery work on a session we
        // are in the middle of destroying.
        session.lifecycle.invalidate();
        await leaseCoordinator.releaseLease(session);
        // REMOVE THE LINKED DEVICE ON WHATSAPP'S SIDE.
        //
        // `sock.end()` only closes the socket locally — WhatsApp keeps the
        // companion device in the phone's "Linked devices" list, so removing a
        // line in Tezlify left the phone still showing it. `logout()` is the
        // only call that sends the remove-companion-device IQ. Measured
        // (2026-10-01, session 115): the UI trash button reaches this method
        // via `DELETE /sessions/{id}`, while the separate "Bağlantıyı Kes"
        // button reaches `logoutSession` (`POST /sessions/{id}/logout`) — which
        // is why only the second one unlinked anything.
        //
        // Best-effort on purpose: a provider failure must not leave the local
        // session undeletable. The local teardown below still runs.
        if (session.sock) {
          try {
            await session.sock.logout();
          } catch (err) {
            logger.warn(
              { err: err?.message, session_ref: sessionRef(id) },
              'Delete: provider logout failed; continuing with local teardown',
            );
          }
        }
        if (session.sock?.ev) {
          try { session.sock.ev.removeAllListeners(); } catch (err) { /* ignore */ }
        }
        if (session.sock) {
          try { session.sock.end(undefined); } catch (err) { /* ignore */ }
        }
      }
      if (session?._historyQuietTimer) {
        try { clearTimeout(session._historyQuietTimer); } catch (err) { /* ignore */ }
        session._historyQuietTimer = null;
      }
      if (session?._presenceKeepaliveTimer) {
        try { clearInterval(session._presenceKeepaliveTimer); } catch (err) { /* ignore */ }
        session._presenceKeepaliveTimer = null;
      }
      if (authRepository && !session?.ephemeral) {
        await authRepository.clearAuth(id);
        await authRepository.setSessionActive(id, false);
      }
      sessions.delete(id);
      resetRetryCounterCache(id);
      if (session) session.store = null;
      mediaStore.clearSessionMedia(id);
      clearSessionHistoryFetches(id);
      const dir = getSessionDir(sessionsDir, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    },

    // -----------------------------------------------------------------------
    // Contacts & Conversations
    // -----------------------------------------------------------------------
    listContacts(sessionId) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const { contacts, chats } = store;
      const result = new Map();

      // 1. WhatsApp contacts deposundaki yalnizca gercekten rehberde kayitli 1-e-1 kisiler
      for (const c of contacts.values()) {
        if (!c.id || isLidJid(c.id) || isBroadcastOnlyJid(c.id) || c.id.includes('@g.us')) continue;
        const phone = c.phone || jidToPhone(c.id);
        if (!phone) continue;
        const name = c.name || null;
        if (!isSavedContactName(name, phone)) continue;
        result.set(c.id, {
          id: c.id,
          phone,
          name,
          notify: c.notify || null,
          name_source: c.name_source || 'contacts',
          avatar_url: c.avatar_url || null,
        });
      }

      // 2. Sohbetlerdeki kisiler: yalnizca rehberde kayitli adi olanlar
      for (const ch of chats.values()) {
        if (!ch.jid || isLidJid(ch.jid) || isBroadcastOnlyJid(ch.jid) || ch.jid.includes('@g.us')) continue;
        const phone = ch.phone || jidToPhone(ch.jid);
        if (!phone) continue;
        if (result.has(ch.jid)) {
          const existing = result.get(ch.jid);
          if (!existing.avatar_url && ch.avatar_url) existing.avatar_url = ch.avatar_url;
        } else if (isSavedContactName(ch.name, phone) && (ch.name_source === 'addressbook' || ch.name_source === 'history')) {
          result.set(ch.jid, {
            id: ch.jid,
            phone,
            name: ch.name,
            notify: null,
            name_source: ch.name_source,
            avatar_url: ch.avatar_url || null,
          });
        }
      }

      return Array.from(result.values()).sort((a, b) => {
        const nameA = (a.name || '').toLowerCase();
        const nameB = (b.name || '').toLowerCase();
        return nameA.localeCompare(nameB, 'tr');
      });
    },

    listConversations(sessionId, { search, limit, offset } = {}) {
      const session = this._requireSession(sessionId);
      this._applyArchivedState(session);
      const store = this._storeOf(session);
      const { chats, contacts } = store;
      let list = [...chats.values()].sort((a, b) => {
        const tA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
        const tB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
        if (tB !== tA) return tB - tA;
        const cA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const cB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return cB - cA;
      });
      if (search) {
        const q = search.toLowerCase();
        list = list.filter((c) =>
          (c.name || '').toLowerCase().includes(q) ||
          (c.phone || '').toLowerCase().includes(q)
        );
      }
      const total = list.length;
      if (offset) list = list.slice(offset);
      if (limit) list = list.slice(0, limit);
      return {
        items: list.map((c) => {
          const contact = contacts.get(c.jid) || contacts.get(resolveJidKey(store, c.jid));
          if (contact?.name && contact.name !== c.name) {
            const rankNew = NAME_RANK[contact.name_source] || 0;
            const rankCur = NAME_RANK[c.name_source] || (c.name && /^\+\d+$/.test(c.name) ? 0 : NAME_RANK.history);
            if (!c.name || /^\+\d+$/.test(c.name) || rankNew >= rankCur) {
              return sanitizeChatForEmit({ ...c, name: contact.name, name_source: contact.name_source || null });
            }
          }
          return sanitizeChatForEmit(c);
        }),
        total,
      };
    },

    async requestOlderHistory(
      sessionId,
      jid,
      { count = 50, oldestMsgId, oldestMsgFromMe, oldestMsgTimestampMs, before, timeoutMs = 25000 } = {}
    ) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const key = resolveJidKey(store, jid);

      let targetId = oldestMsgId;
      let targetFromMe = oldestMsgFromMe;
      let targetTs = oldestMsgTimestampMs;

      if (!targetId) {
        const list = store.messagesByChat.get(key) || [];
        const candidates = before ? list.filter((m) => m.id < before) : list;
        const oldest = candidates[0] || list[0];
        if (oldest) {
          targetId = oldest.wa_message_id;
          targetFromMe = oldest.direction === 'OUTBOUND' || oldest.from_me;
          targetTs = oldest.timestamp_s ? oldest.timestamp_s * 1000 : (oldest.id ? Number(oldest.id) : Date.now());
        }
      }

      if (!targetId) {
        return { messages: [], count: 0, status: 'NO_ANCHOR' };
      }

      const flightKey = `${session.id}:${key}:${targetId}`;
      if (inFlightHistoryFetches.has(flightKey)) {
        logger.debug({ flightKey }, 'Reusing in-flight history request');
        return inFlightHistoryFetches.get(flightKey);
      }

      const sock = session.sock;
      if (!sock || typeof sock.fetchMessageHistory !== 'function') {
        return { messages: [], count: 0, status: 'SOCKET_UNAVAILABLE' };
      }

      const oldestMsgKey = {
        remoteJid: key,
        id: targetId,
        fromMe: Boolean(targetFromMe),
      };

      // The in-flight marker used to be registered AFTER `new Promise(...)`. A
      // SYNCHRONOUS throw from sock.fetchMessageHistory ran the catch (which
      // deletes the map entry) and then re-inserted a dead, already-resolved
      // promise that nothing ever removed — so every later request for the same
      // (session, chat, anchor) replayed {status:'ERROR'} forever, surviving
      // socket recovery. Registering from inside the executor cannot work
      // (the promise is still in its TDZ there), so the guard is a flag that
      // makes the catch the last writer, and the map entry is only published
      // for a run that is genuinely still in flight.
      let settled = false;
      const fetchPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingHistoryWaiters.delete(flightKey);
          inFlightHistoryFetches.delete(flightKey);
          logger.info({ flightKey, targetId }, 'Older history request timed out waiting for provider chunk');
          settled = true;
          resolve({ messages: [], count: 0, status: 'TIMEOUT' });
        }, timeoutMs);

        pendingHistoryWaiters.set(flightKey, {
          resolve: (newMsgs) => {
            clearTimeout(timer);
            pendingHistoryWaiters.delete(flightKey);
            inFlightHistoryFetches.delete(flightKey);
            settled = true;
            resolve({ messages: newMsgs, count: newMsgs.length, status: 'OK' });
          },
          timer,
          targetId,
          key,
          before,
          sessionId: session.id,
        });

        try {
          sock
            .fetchMessageHistory(count, oldestMsgKey, Number(targetTs) || Date.now())
            .then((msgId) => {
              logger.debug({ flightKey, msgId }, 'Sent HISTORY_SYNC_ON_DEMAND PDO');
            })
            .catch((err) => {
              clearTimeout(timer);
              pendingHistoryWaiters.delete(flightKey);
              inFlightHistoryFetches.delete(flightKey);
              logger.warn({ flightKey, err: err?.message }, 'Failed to send fetchMessageHistory PDO');
              settled = true;
              resolve({ messages: [], count: 0, status: 'ERROR', error: err?.message });
            });
        } catch (err) {
          clearTimeout(timer);
          pendingHistoryWaiters.delete(flightKey);
          inFlightHistoryFetches.delete(flightKey);
          logger.warn({ flightKey, err: err?.message }, 'Exception in sock.fetchMessageHistory');
          settled = true;
          resolve({ messages: [], count: 0, status: 'ERROR', error: err?.message });
        }
      });

      // Published only for a run that is genuinely still in flight. A
      // synchronous provider throw resolves inside the executor (settled=true),
      // so nothing is cached and the next call can retry a recovered socket.
      if (!settled) inFlightHistoryFetches.set(flightKey, fetchPromise);

      return fetchPromise;
    },

    async getMessages(
      sessionId,
      jid,
      { limit = 50, before, fetchProvider = false, oldestMsgId, oldestMsgFromMe, oldestMsgTimestampMs, timeoutMs = 25000 } = {}
    ) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const key = resolveJidKey(store, jid);
      let list = store.messagesByChat.get(key) || [];
      const getMsgTime = (m) => {
        if (typeof m.timestamp_s === 'number' && Number.isFinite(m.timestamp_s) && m.timestamp_s > 0) return m.timestamp_s * 1000;
        if (m.created_at) {
          const t = new Date(m.created_at).getTime();
          if (Number.isFinite(t)) return t;
        }
        return typeof m.id === 'number' && Number.isFinite(m.id) ? m.id : 0;
      };
      if (before) {
        const beforeMs = Number(before);
        if (Number.isFinite(beforeMs)) {
          list = list.filter((m) => getMsgTime(m) < beforeMs);
        }
      }
      list.sort((a, b) => getMsgTime(a) - getMsgTime(b));

      let providerStatus = 'NOT_REQUESTED';
      const providerFetchNeeded = fetchProvider && (list.length < limit || Boolean(oldestMsgId));
      if (providerFetchNeeded) {
        const sockUsable = Boolean(session.sock) && typeof session.sock.fetchMessageHistory === 'function';
        if (!sockUsable) {
          providerStatus = 'SOCKET_UNAVAILABLE';
        } else {
          const histResult = await this.requestOlderHistory(sessionId, jid, {
            count: limit,
            oldestMsgId: oldestMsgId || list[0]?.wa_message_id,
            oldestMsgFromMe: oldestMsgFromMe !== undefined ? oldestMsgFromMe : (list[0]?.direction === 'OUTBOUND' || list[0]?.from_me),
            oldestMsgTimestampMs: oldestMsgTimestampMs || (list[0]?.timestamp_s ? list[0].timestamp_s * 1000 : undefined),
            before,
            timeoutMs,
          });
          providerStatus = histResult?.status || 'OK';
          list = store.messagesByChat.get(key) || [];
          if (before) {
            list = list.filter((m) => m.id < before);
          }
          list.sort((a, b) => (a.id || 0) - (b.id || 0));
        }
      }

      const result = list.slice(-limit);
      result.provider_status = providerStatus;
      return result;
    },

    listAllMessages(sessionId, { limit = 1000, offset = 0, since = null, perChatLimit = null, jids = null } = {}) {
      const session = this._requireSession(sessionId);
      const { messagesByChat } = this._storeOf(session);
      const sinceMs = Number.isFinite(Number(since)) && since !== null && since !== ''
        ? Number(since) * 1000
        : null;
      const perChat = Number.isFinite(Number(perChatLimit)) && Number(perChatLimit) > 0
        ? Number(perChatLimit)
        : null;
      // Opsiyonel jid filtresi: backend, `since` suucunun disladigi (yani hic
      // satiri olmayan) sohbetler icin yalnizca O jid'leri sorar. Filtre
      // verilmezse davranis DEGISMEZ (tum sohbetler).
      const wanted = Array.isArray(jids) && jids.length > 0 ? new Set(jids.map(String)) : null;
      const all = [];
      for (const [chatKey, list] of messagesByChat.entries()) {
        if (wanted && !wanted.has(String(chatKey))) continue;
        let group = list;
        if (sinceMs !== null) {
          group = group.filter((m) => {
            const t = Date.parse(m.created_at || '');
            return Number.isFinite(t) && t >= sinceMs;
          });
        }
        if (perChat !== null && group.length > perChat) {
          group = [...group].sort((a, b) => (a.id || 0) - (b.id || 0)).slice(-perChat);
        }
        for (const m of group) all.push(m);
      }
      all.sort((a, b) => {
        const d = (a.id || 0) - (b.id || 0);
        if (d !== 0) return d;
        return String(a.wa_message_id || '') < String(b.wa_message_id || '') ? -1 : 1;
      });
      const page = all.slice(offset, offset + limit);
      return { messages: page, total: all.length, offset, limit };
    },

    // -----------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------
    async sendTextMessage(sessionId, jid, body, client_message_id) {
      const session = this._requireConnectedSession(sessionId);
      const key = resolveJidKey(this._storeOf(session), jid);
      const sendStarted = performance.now();
      const clientMessageId = client_message_id || uuidv4();
      const existing = (this._storeOf(session).messagesByChat.get(key) || [])
        .find((m) => m.client_message_id === clientMessageId);
      if (existing) {
        if (existing.body !== body || existing.message_type !== 'TEXT') {
          throw new Error('client_message_id cannot be reused for a different message');
        }
        // Yalnizca KESINLESMIS ack'ler (SENT/DELIVERED/READ) kisayoludur.
        // PENDING (soket asilmasi / backend timeout) ve FAILED satirlari
        // yeniden GONDERILMEK ZORUNDADIR: eskiden takili bir PENDING satir
        // geri donduruluyor ama yeniden gönderilMIYORDU — backend retry
        // akisi sonsuza kadar PENDING'e kilitleniyordu.
        const st = String(existing.status || '').toUpperCase();
        if (st === 'SENT' || st === 'DELIVERED' || st === 'READ') return { ...existing };
      }
      const messageId = crypto.createHash('sha256')
        .update(`${session.id}\0${key}\0${clientMessageId}`)
        .digest('hex').slice(0, 32).toUpperCase();
      const pending = this._recordOutbound(key, {
        body, message_type: 'TEXT', client_message_id: clientMessageId,
        wa_message_id: messageId, status: 'PENDING',
      }, session.id);
      let result;
      try {
        result = await session.sock.sendMessage(key, { text: body }, { messageId });
      } catch (error) {
        this._failOutbound(session.id, key, messageId, error);
        throw error;
      }
      latency('provider_send_promise_ms', sendStarted, sessionId);
      const resolvedWaId = result?.key?.id || messageId;
      const msg = this._confirmOutboundSent(session.id, key, resolvedWaId, pending.client_message_id);
      return msg;
    },

    /**
     * Bir mesaja tepki birakir (veya mevcut tepkiyi degistirir/kaldirir).
     *
     * Reaksiyon bilerek `_recordOutbound` uzerinden GECMEZ: yerel mesaj kaydi
     * uretmek, tepkiyi bir mesaj gibi gostermenin ta kendisidir ve bu tam da
     * duzeltilen hataydi. Kalici gercekligi backend tutar (mesaj satirina bagli
     * tek satirlik reaksiyon), gateway yalnizca WhatsApp'a iletir.
     */
    async sendReaction(sessionId, jid, { target_wa_message_id, target_from_me, emoji }) {
      const session = this._requireConnectedSession(sessionId);
      const key = resolveJidKey(this._storeOf(session), jid);
      if (!target_wa_message_id) throw new Error('target_wa_message_id is required');
      const text = typeof emoji === 'string' ? emoji : '';
      await session.sock.sendMessage(key, {
        react: {
          text,
          key: {
            remoteJid: key,
            fromMe: Boolean(target_from_me),
            id: target_wa_message_id,
          },
        },
      });
      return {
        success: true,
        conversation_id: key,
        wa_message_id: target_wa_message_id,
        emoji: text,
        removed: !text,
      };
    },

    async sendMediaMessage(sessionId, jid, { media_type, media_url, media_base64, mime_type, caption, filename, client_message_id }) {
      const session = this._requireConnectedSession(sessionId);
      const key = resolveJidKey(this._storeOf(session), jid);
      const type = (media_type || 'document').toLowerCase();
      const clientMessageId = client_message_id || uuidv4();
      const expectedBody = caption || filename || media_url || '';
      const existing = (this._storeOf(session).messagesByChat.get(key) || [])
        .find((m) => m.client_message_id === clientMessageId);
      if (existing) {
        if (existing.body !== expectedBody || existing.message_type !== type.toUpperCase()) {
          throw new Error('client_message_id cannot be reused for different media');
        }
        // sendTextMessage ile ayni kural: PENDING/FAILED yeniden gönderilir.
        const st = String(existing.status || '').toUpperCase();
        if (st === 'SENT' || st === 'DELIVERED' || st === 'READ') return { ...existing };
      }
      let effectiveBase64 = media_base64;
      let effectiveMimeType = mime_type;
      let effectiveFilename = filename;

      const isAudio = Boolean(
        type === 'audio' ||
        type === 'voice' ||
        type === 'ptt' ||
        (mime_type && mime_type.startsWith('audio/')) ||
        (filename && (filename.toLowerCase().startsWith('voice_') || filename.toLowerCase().endsWith('.ogg') || filename.toLowerCase().endsWith('.opus') || (filename.toLowerCase().endsWith('.webm') && (!media_type || media_type === 'audio' || media_type === 'voice'))))
      );

      if (isAudio && media_base64) {
        try {
          const rawBuf = Buffer.from(media_base64, 'base64');
          const { buffer: transcodedBuf, mimetype: targetMime } = await transcodeToOggOpus(rawBuf);
          effectiveBase64 = transcodedBuf.toString('base64');
          effectiveMimeType = targetMime || 'audio/ogg; codecs=opus';
          if (!effectiveFilename || effectiveFilename.endsWith('.webm')) {
            effectiveFilename = (effectiveFilename || 'voice.ogg').replace(/\.webm$/i, '.ogg');
          }
        } catch (tErr) {
          logger.warn({ err: tErr }, '[session-manager] Audio transcode error');
        }
      }

      let storedOutboundMedia = null;
      if (effectiveBase64 && typeof mediaStore?.storeMediaBuffer === 'function') {
        try {
          const buf = Buffer.from(effectiveBase64, 'base64');
          storedOutboundMedia = mediaStore.storeMediaBuffer(session.id, buf, {
            mimeType: effectiveMimeType,
            filename: effectiveFilename,
          });
        } catch (e) {
          logger.warn({ err: e }, 'Failed to store outbound media in mediaStore');
        }
      }
      const outboundMediaId = storedOutboundMedia?.media_id || null;
      const outboundMimeType = storedOutboundMedia?.mime_type || effectiveMimeType || null;
      const outboundFilename = storedOutboundMedia?.filename || effectiveFilename || null;

      const content = buildMediaContent({
        media_type: isAudio ? 'voice' : media_type,
        media_url,
        media_base64: effectiveBase64,
        mime_type: effectiveMimeType,
        caption,
        filename: effectiveFilename,
      });
      const messageId = crypto.createHash('sha256')
        .update(`${session.id}\0${key}\0${clientMessageId}`)
        .digest('hex').slice(0, 32).toUpperCase();
      const recordedType = isAudio ? 'AUDIO' : (type === 'image' ? 'IMAGE' : (type === 'video' ? 'VIDEO' : 'DOCUMENT'));
      const pending = this._recordOutbound(key, {
        body: expectedBody, message_type: recordedType,
        client_message_id: clientMessageId, wa_message_id: messageId, status: 'PENDING',
        media_id: outboundMediaId, media_mime_type: outboundMimeType,
        media_filename: outboundFilename, media_caption: caption,
      }, session.id);
      let result;
      try {
        result = await session.sock.sendMessage(key, content, { messageId });
      } catch (error) {
        this._failOutbound(session.id, key, messageId, error);
        throw error;
      }
      const resolvedWaId = result?.key?.id || messageId;
      const msg = this._confirmOutboundSent(session.id, key, resolvedWaId, pending.client_message_id);
      return msg;
    },

    async sendTyping(sessionId, jid, typing = true, durationMs = 4000) {
      const session = this._requireConnectedSession(sessionId);
      const key = resolveJidKey(this._storeOf(session), jid);
      try {
        await session.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', key);
      } catch (err) {
        logger.warn({ err }, 'Send typing presence error');
        return { success: false, error: err?.message || 'Presence update failed' };
      }
      return { success: true };
    },

    async markConversationRead(sessionId, jid) {
      const session = this._requireConnectedSession(sessionId);
      const { chats, messagesByChat } = this._storeOf(session);
      const key = resolveJidKey(this._storeOf(session), jid);
      const isGroup = key.includes('@g.us');
      let gatewayOk = true;
      let gatewayError = null;
      // Whether a read receipt actually reached WhatsApp, as opposed to there
      // being nothing cached to send one for. Kept explicit so the caller can
      // distinguish the two instead of reading a bare `success: true`.
      let receiptSent = false;
      try {
        const list = messagesByChat.get(key) || [];
        const inbound = list.filter((m) => m.direction === 'INBOUND' && m.wa_message_id);
        if (isGroup) {
          const keys = inbound.slice(-5).map((m) => ({
            remoteJid: key,
            id: m.wa_message_id,
            fromMe: false,
            participant: m.participant_jid || undefined,
          }));
          if (keys.length) {
            await session.sock.readMessages(keys);
            receiptSent = true;
          } else {
            // Okunacak bilinen gelen mesaj yok: gecersiz `{id: undefined}`
            // anahtari Baileys'i patlatir. Gonderilecek kanaat YOKTUR —
            // yerel sifirlama asagida yapilir, saglayiciya bayrak gitmez.
          }
        } else if (inbound.length) {
          const newest = inbound[inbound.length - 1];
          await session.sock.readMessages([{ remoteJid: key, id: newest.wa_message_id, fromMe: false }]);
          receiptSent = true;
        }
        // 1:1 sohbette bilinen gelen mesaj yoksa da saglayiciya gecersiz
        // anahtar gonderilmez (yukaridaki grup dalindaki ayni kural).
      } catch (err) {
        gatewayOk = false;
        gatewayError = err?.message || String(err);
        logger.warn({ err }, 'Mark read error');
      }
      if (gatewayOk) {
        const chat = chats.get(key);
        if (chat) chat.unread_count = 0;
        this._emit({
          event: 'conversation_read',
          conversation_id: key,
          unread_count: 0,
          gateway_session_id: session.id,
        });
      }
      return gatewayOk
        ? { success: true, receipt_sent: receiptSent }
        : { success: false, error: gatewayError };
    },

    /**
     * Sohbeti WhatsApp tarafinda siler (`deleteChatAction`).
     *
     * Neden gerekli: WhatsApp Web'de bir sohbeti silmek onu YALNIZCA O CIHAZIN
     * listesinden kaldirir; hesabin diger cihazlarinda (telefon) kalan kopya
     * icin app-state yamasi gerekir. Yamayi WhatsApp Web kendisi de gonderir.
     *
     * Neden `regular_high` onemli: `chatModify({delete:true})` yamasi
     * `regular_high` koleksiyonuna yazilir (Baileys chat-utils), okundu/arsiv
     * ise `regular_low`a. Ikisi AYRI koleksiyondur — yani bu islem, `regular_low`
     * parkli kalsa bile calisir.
     *
     * `lastMessages` sozlesmesi (Baileys `getMessageRange`): her ogenin
     * `key.remoteJid`, `key.id` ve `messageTimestamp` alani ZORUNLU; eksikse
     * Baileys `Incomplete key` / `Missing timestamp` ile FIRLATIR (sessizce
     * yutmaz). Bu yuzden yalnizca iki alani da tasiyan kayitlar secilir ve liste
     * TEK elemanlidir (en yeni mesaj): cok elemanli listede
     * `lastMessageTimestamp` SON elemandan okunur ve siralama yonu tartismali
     * oldugu icin tek eleman o belirsizligi tamamen kaldirir.
     */
    async deleteConversationRemote(sessionId, jid) {
      const session = this._requireConnectedSession(sessionId);
      const store = this._storeOf(session);
      const { chats, messagesByChat } = store;
      const key = resolveJidKey(store, jid);
      const isGroup = key.includes('@g.us');

      // Yerel onbellek bos olabilir: sohbet listesi mesaj gecmisi olmadan da
      // doluyor (history sync sirasinda). O durumda anahtar UYDURULMAZ, bos
      // `lastMessages` ile gonderilir — `getMessageRange` bos dizide firlatmaz
      // ve WhatsApp sohbeti yine siler. Kanit olmadan bir anahtar uretmek,
      // silme yerine yanlis bir mesaji isaret eden yama uretirdi.
      const list = messagesByChat.get(key) || [];
      let lastMessages = [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (!m?.wa_message_id) continue;
        const ts = Number(m.timestamp_s);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        const fromMe = m.direction === 'OUTBOUND';
        const entryKey = { remoteJid: key, id: m.wa_message_id, fromMe };
        // Grup sohbetinde "benden degil" bir mesajin `participant`i olmak
        // ZORUNDA (Baileys aksi halde firlatir). Katilimci bilinmiyorsa bu
        // kayit kullanilamaz; uydurmak yerine daha eski kayitlar da denenir.
        if (isGroup && !fromMe) {
          if (!m.participant_jid) continue;
          entryKey.participant = m.participant_jid;
        }
        lastMessages = [{ key: entryKey, messageTimestamp: ts }];
        break;
      }

      let providerOk = true;
      let providerError = null;
      try {
        await session.sock.chatModify({ delete: true, lastMessages }, key);
      } catch (err) {
        providerOk = false;
        providerError = err?.message || String(err);
        logger.warn(
          { err: providerError, session_ref: sessionRef(sessionId) },
          'Delete conversation provider error'
        );
      }

      // Yerel kopya YALNIZCA saglayici kabul ettiginde dusurulur. Birakilirsa
      // sonraki sohbet kesfi silinen sohbeti yeniden uretirdi — senkronu
      // "duzeltirken" silinen sohbeti geri getirmis olurduk.
      if (providerOk) {
        chats.delete(key);
        messagesByChat.delete(key);
        const raw = store.rawMessagesByChat?.get(key);
        if (raw) {
          store.rawMessageCount = Math.max(0, (store.rawMessageCount || 0) - raw.size);
          store.rawMessagesByChat.delete(key);
        }
      }
      return providerOk
        ? { success: true, remote_deleted: true, last_messages: lastMessages.length }
        : { success: false, error: providerError };
    },

    // -----------------------------------------------------------------------
    // Media delegation
    // -----------------------------------------------------------------------
    getMediaPath(sessionId, mediaId) {
      return mediaStore.getMediaPath(sessionId, mediaId);
    },

    async downloadMediaOnDemand(sessionId, mediaIdOrWaId) {
      if (!mediaIdOrWaId) return null;
      let filePath = mediaStore.getMediaPath(sessionId, mediaIdOrWaId);
      if (filePath && fs.existsSync(filePath)) return filePath;

      let strId = String(mediaIdOrWaId);
      const meta = mediaStore.mediaIndex?.get(strId);
      if (meta?.waMessageId) {
        strId = String(meta.waMessageId);
      }

      const targetSessions = [];
      if (sessionId && sessions.has(String(sessionId))) {
        targetSessions.push(sessions.get(String(sessionId)));
      }
      for (const [sId, sess] of sessions.entries()) {
        if (!sessionId || sId !== String(sessionId)) {
          targetSessions.push(sess);
        }
      }

      for (const session of targetSessions) {
        const store = this._storeOf(session);
        if (!store || !store.rawMessagesByChat) continue;

        let foundRaw = null;
        let foundJid = null;

        for (const [jid, byId] of store.rawMessagesByChat.entries()) {
          if (byId.has(strId)) {
            foundRaw = byId.get(strId);
            foundJid = jid;
            break;
          }
        }

        if (foundRaw && foundJid) {
          const waMsg = {
            key: { remoteJid: foundJid, id: strId },
            message: foundRaw,
          };
          const stored = await mediaStore.storeIncomingMedia(session, waMsg, session.sock);
          if (stored?.media_id) {
            return mediaStore.getMediaPath(session.id, stored.media_id);
          }
        }
      }
      return null;
    },

    async storeIncomingMedia(session, waMessage, sock) {
      return mediaStore.storeIncomingMedia(session, waMessage, sock);
    },

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------
    _requireSession(sessionId) {
      if (!sessionId) throw new Error('session_id is required');
      const session = sessions.get(String(sessionId));
      if (!session) throw new Error('Session not found');
      return session;
    },

    _requireConnectedSession(sessionId) {
      const session = this._requireSession(sessionId);
      if (session.status !== 'CONNECTED' || !session.sock) {
        throw new Error(
          'Bu WhatsApp oturumu bagli degil. Lutfen once QR ile eslestirin.'
        );
      }
      return session;
    },

    _sess(sessionOrId) {
      if (sessionOrId && typeof sessionOrId === 'object') return sessionOrId;
      return this._requireSession(sessionOrId);
    },

    _storeOf(sessionOrId) {
      const session = this._sess(sessionOrId);
      if (!session.store) {
        session.store = createSessionStore({
          sessionDir: getSessionDir(sessionsDir, session.id),
          sessionPhone: session.phone_number || null,
          logger,
        });
      }
      return session.store;
    },

    /**
     * Bir reaksiyonu kendi olayi olarak yayinlar — mesaj olarak DEGIL.
     *
     * Baileys'te `reactionMessage.key` HEDEF mesajin anahtaridir; olayin kendi
     * anahtari (`msg.key`) kimin, hangi sohbette tepki verdigini tasir. Ikisi
     * karistirilirsa tepki yanlis mesaja baglanir.
     *
     * `text === ''` WhatsApp sozlesmesinde "tepkiyi geri cek" demektir; ayrica
     * `removed` alanini da gondeririz ki backend bos metni yorumlamak zorunda
     * kalmasin ve iki taraf ayni sozlesmeyi okusun.
     */
    _ingestReactionMessage(sessionId, msg, key, reactionContent) {
      const targetWaId = reactionContent?.key?.id;
      if (!targetWaId) return null;
      const emoji = typeof reactionContent?.text === 'string' ? reactionContent.text : '';
      // "Kim tepki verdi" YALNIZCA olayin kendi anahtarina bakar (`msg.key`).
      // `reactionContent.key.fromMe` HEDEF mesajin kim tarafindan gonderildigini
      // soyler (bizim mesajimiza karsi taraf tepki verebilir); onu reaktor
      // kimligine karistirmak, karsi tarafin tepkisini "benim" gibi gosterip
      // herkese tek satir yazdirirdi.
      const fromMe = Boolean(msg.key?.fromMe);
      const reactorJid = fromMe ? null : (msg.key?.participant || msg.key?.remoteJid || null);
      const ts = messageTimestampMs(msg.messageTimestamp);

      // Memory store'daki hedef mesaja ve sohbete reaksiyonu ilistir
      const session = sessions.get(sessionId);
      if (session) {
        const store = this._storeOf(session);
        const list = store.messagesByChat.get(key) || [];
        const targetRecord = list.find((m) => m.wa_message_id === targetWaId);
        if (targetRecord) {
          targetRecord.reactions = targetRecord.reactions || [];
          targetRecord.reactions = targetRecord.reactions.filter((r) => r.reactor_jid !== reactorJid || r.from_me !== fromMe);
          if (emoji) {
            targetRecord.reactions.push({
              emoji,
              from_me: fromMe,
              reactor_jid: reactorJid,
              created_at: ts ? new Date(ts).toISOString() : null,
            });
          }
        }
        const chat = store.chats.get(key);
        if (chat && emoji) {
          const chatActivity = chat.last_message_at ? new Date(chat.last_message_at).getTime() : 0;
          chat.last_reaction = { emoji, from_me: fromMe, reactor_jid: reactorJid };
          chat.last_message_preview = fromMe
            ? `Şu mesaja ${emoji} ifadesini bıraktınız`
            : `Şu mesaja ${emoji} ifadesini bıraktı`;
          if (ts && ts >= chatActivity) {
            chat.last_message_at = new Date(ts).toISOString();
          }
          this._emit({ gateway_session_id: sessionId, event: 'conversation_updated', conversation: { ...chat } });
        }
      }

      const event = {
        event: 'message_reaction',
        conversation_id: key,
        target_wa_message_id: targetWaId,
        emoji,
        removed: !emoji,
        from_me: fromMe,
        reactor_jid: reactorJid,
        created_at: ts ? new Date(ts).toISOString() : null,
      };
      this._emit({ gateway_session_id: sessionId, ...event });
      return event;
    },

    async _ingestUpsertMessage(msg, sock, sessionId) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const { contacts, chats, messagesByChat } = store;
      const normalizeJid = (jid) => resolveJidKey(store, jid);
      const emitEvent = (event) => this._emit({ gateway_session_id: sessionId, ...event });

      const fromMe = Boolean(msg.key?.fromMe);
      const jid = msg.key?.remoteJid;
      if (!jid) return null;
      if (isBroadcastOnlyJid(jid)) return null;

      if (msg.key?.senderLid && msg.key?.senderPn) {
        this._applyLidMapping(session, msg.key.senderLid, msg.key.senderPn);
      }
      if (msg.key?.participantLid && msg.key?.participantPn) {
        this._applyLidMapping(session, msg.key.participantLid, msg.key.participantPn);
      }
      // Baileys carries the SAME entity's alternate address on the key
      // (`remoteJidAlt` / `participantAlt`). Learning from it here, BEFORE the
      // key is normalized, files the message under its phone identity straight
      // away instead of holding it as a LID until some later mapping event
      // happens to arrive. During a first QR pairing no mapping has been
      // learned yet, so without this the very messages the user sees on their
      // phone are the ones that get held.
      for (const [lidJid, phoneJid] of lidPairsFromMessageKey(msg.key)) {
        this._applyLidMapping(session, lidJid, phoneJid);
      }
      const key = normalizeJid(jid);
      if (isBroadcastOnlyJid(key)) return null;

      // Reaksiyonlar mesaj DEGILDIR ve asla mesaj satirina donusmemelidir.
      // Eskiden `reactionMessage` genel kayit ureticisine dusuyor, orada
      // `systemContentMarker` ona `[REACTION]` yer tutucu govdesini veriyordu
      // (amac onizlemeyi bos birakmamakti); bedeli sohbette cop bir balon ve
      // listede yanlis `last_message` onizlemesiydi. Kendi olayina yonlendirme
      // asagidaki mesaj/dedup muhasebesinden ONCE yapilir.
      const reactionContent = msg.message?.reactionMessage;
      if (reactionContent) {
        return this._ingestReactionMessage(sessionId, msg, key, reactionContent);
      }

      const existingRecord = msg.key?.id
        ? (messagesByChat.get(key) || []).find((m) => m.wa_message_id && m.wa_message_id === msg.key.id)
        : null;

      if (existingRecord) {
        // A duplicate is only a duplicate if it carries nothing new.
        //
        // chats.update synthesises a message-less record from `lastMessage` and
        // emits it, so the real messages.upsert for the same wa_message_id
        // arrives afterwards. The old check matched on the id alone and
        // returned null — discarding the record that actually carried the
        // media, while the synthesised one has media_id hardcoded to null.
        // The attachment was therefore lost permanently, not just delayed.
        //
        // So: an existing record that already has a media_id wins, and the
        // media-less placeholder is upgraded in place instead of dropped.
        const placeholder = !existingRecord.media_id;
        const incomingHasMedia = Boolean(msg.message?.imageMessage || msg.message?.videoMessage
          || msg.message?.audioMessage || msg.message?.documentMessage || msg.message?.stickerMessage);
        if (!placeholder) return null;
        if (!incomingHasMedia) return null;
        // Fall through: the incoming record replaces the placeholder below.
      }

      const lidHold = isLidJid(key);
      if (msg.key?.id && msg.message) {
        rememberRawMessage(store, key, msg.key.id, msg.message);
      }
      const contact = contacts.get(key);
      const isGroup = jid.includes('@g.us');
      const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || msg.message?.documentMessage?.caption || '';
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo || msg.message?.documentMessage?.contextInfo;
      const text = this._formatMentions(session, rawText, contextInfo);
      const mediaType = classifyMessageType(msg.message);
      let mediaInfo = null;
      if (mediaType !== 'TEXT' && mediaType !== 'LOCATION' && mediaType !== 'CONTACT' && typeof this.storeIncomingMedia === 'function' && sock) {
        if (existingRecord?.media_id) {
          mediaInfo = {
            media_id: existingRecord.media_id,
            mime_type: existingRecord.media_mime_type,
            filename: existingRecord.media_filename,
          };
        } else {
          mediaInfo = await this.storeIncomingMedia(session, msg, sock);
        }
      }

      let nativeLinkPreview = null;
      const previewMeta = extractLinkPreviewMetadata(msg.message);
      if (previewMeta) {
        let thumbMediaId = null;
        if (previewMeta.jpegThumbnailBuffer && typeof mediaStore?.storeMediaBuffer === 'function') {
          try {
            const storedThumb = mediaStore.storeMediaBuffer(session?.id, previewMeta.jpegThumbnailBuffer, {
              mimeType: 'image/jpeg',
              filename: `thumb_${msg.key?.id || Date.now()}.jpg`,
            });
            thumbMediaId = storedThumb?.media_id || null;
          } catch (tErr) {
            logger.debug({ tErr }, 'Failed to save link preview jpegThumbnail');
          }
        }
        nativeLinkPreview = {
          url: previewMeta.url,
          title: previewMeta.title,
          description: previewMeta.description,
          media_id: thumbMediaId,
        };
      }

      const ts = messageTimestampMs(msg.messageTimestamp);
      const timestampSeconds = Number(msg.messageTimestamp);
      const record = {
        id: ts,
        timestamp_s: Number.isFinite(timestampSeconds) && timestampSeconds > 0 ? timestampSeconds : null,
        conversation_id: key,
        direction: fromMe ? 'OUTBOUND' : 'INBOUND',
        message_type: mediaType,
        status: resolveMessageStatus(msg, fromMe, msg.reactions),
        body: text || '',
        media_id: mediaInfo?.media_id || existingRecord?.media_id || null,
        media_mime_type: mediaInfo?.mime_type || existingRecord?.media_mime_type || null,
        media_filename: mediaInfo?.filename || existingRecord?.media_filename || null,
        media_caption: text || existingRecord?.media_caption || null,
        native_link_preview: nativeLinkPreview,
        wa_message_id: msg.key?.id || null,
        sender_phone: fromMe ? 'ME' : (jidToPhone(key) || key),
        recipient_phone: fromMe ? (jidToPhone(key) || key) : 'ME',
        sender_name: fromMe ? 'ME' : this._resolveDisplayName(session, key, msg.pushName),
        sender_name_source: fromMe ? null : (contact?.name_source || null),
        participant_jid: msg.key?.participant || null,
        participant_name: isGroup ? this._resolveDisplayName(session, msg.key?.participant, msg.pushName) : null,
        created_at: new Date(ts).toISOString(),
      };
      if (!messagesByChat.has(key)) messagesByChat.set(key, []);
      const chatMsgs = messagesByChat.get(key);
      // Upgrading a media-less placeholder (see the duplicate check above):
      // drop the synthetic row so the chat keeps ONE record per wa_message_id
      // and the real media-bearing one takes its place.
      if (msg.key?.id) {
        const placeholderAt = chatMsgs.findIndex(
          (m) => m.wa_message_id === msg.key.id && !m.media_id
        );
        if (placeholderAt !== -1) chatMsgs.splice(placeholderAt, 1);
      }
      chatMsgs.push(record);
      if (chatMsgs.length > 2000) {
        chatMsgs.splice(0, chatMsgs.length - 2000);
      }
      // Metinsiz sistem turleri (arama / ifade / silinmis mesaj / grup bildirimi)
      // `buildChatPreview`ten BOS doner. Onizlemeyi bos birakmak satiri UI'da bos
      // gosterir VE backend'in aktivite damgasi kapisini tetikler.
      const chatPreview =
        buildChatPreview(record, isGroup) ||
        normalizePreviewText('TEXT', systemContentMarker(msg) || '');
      this._touchChat(session, key, chatPreview, record.created_at);
      // Only messages we actually PUBLISH may be counted. A held (LID) message
      // is not emitted at all, so counting it made this counter describe a
      // different set of messages than the rest of the system can ever see —
      // production showed gateway `unread_count=2` against a backend count of 1
      // for exactly this reason (the extra one was a held LID message). A local
      // counter that disagrees with what was published is not a richer truth;
      // it is a second, contradictory one.
      if (!lidHold) {
        const chat = chats.get(key);
        if (chat && !fromMe) chat.unread_count = (chat.unread_count || 0) + 1;
        emitEvent({
          event: 'message_new',
          conversation_id: key,
          message: record,
        });
      }
      return record;
    },

    _ingestContactUpdates(sessionOrId, updates) {
      const session = this._sess(sessionOrId);
      const store = this._storeOf(session);
      const { contacts } = store;
      const normalizeJid = (jid) => resolveJidKey(store, jid);
      const applyLidMapping = (lid, phoneJid) => this._applyLidMapping(session, lid, phoneJid);
      const emitEvent = (event) => this._emit({ gateway_session_id: session.id, ...event });

      for (const update of updates || []) {
        if (!update || !update.id) continue;
        if (isBroadcastOnlyJid(update.id)) continue;
        if (isDegenerateJid(update.id)) continue;
        const phoneJid = contactPhoneJid(update);
        if (phoneJid && isLidJid(update.id)) applyLidMapping(update.id, phoneJid);
        if (update.lid && !isLidJid(update.id)) applyLidMapping(update.lid, update.id);

        const jid = normalizeJid(update.id);
        if (!jid || isBroadcastOnlyJid(jid)) continue;

        const lidHold = isLidJid(jid);
        let merged = contacts.get(jid) || {};
        if (update.name) merged = mergeContactName(merged, update.name, 'addressbook');
        if (update.verifiedName) merged = mergeContactName(merged, update.verifiedName, 'verified');
        if (update.notify) merged = mergeContactName(merged, update.notify, 'push');
        contacts.set(jid, {
          ...merged,
          id: jid,
          jid,
          name: merged.name || jidToPhone(jid) || jid,
          phone: jidToPhone(jid) || merged.phone || '',
          avatar_url: update.imgUrl || merged.avatar_url || null,
          updated_at: new Date().toISOString(),
        });
        if (!lidHold) emitEvent({ event: 'contact_synced', contact: contacts.get(jid) });
      }
    },

    _recordOutbound(jid, data, sessionId) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const { messagesByChat } = store;
      const emitEvent = (event) => this._emit({ gateway_session_id: session.id, ...event });
      const key = resolveJidKey(store, jid);

      if (data.wa_message_id || data.client_message_id) {
        const dup = (messagesByChat.get(key) || []).find((m) =>
          (data.wa_message_id && m.wa_message_id === data.wa_message_id) ||
          (data.client_message_id && m.client_message_id === data.client_message_id));
        if (dup) {
          dup.client_message_id ||= data.client_message_id;
          dup.wa_message_id = data.wa_message_id || dup.wa_message_id;
          dup.media_id = data.media_id || dup.media_id;
          dup.media_mime_type = data.media_mime_type || dup.media_mime_type;
          dup.media_filename = data.media_filename || dup.media_filename;
          dup.media_caption = data.media_caption || dup.media_caption;
          if (data.status && (ACK_ORDER[data.status] ?? 0) > (ACK_ORDER[dup.status] ?? 0)) {
            dup.status = data.status;
          }
          return { ...dup };
        }
      }
      const msg = {
        id: Date.now(),
        conversation_id: key,
        direction: 'OUTBOUND',
        message_type: data.message_type || 'TEXT',
        status: data.status || 'PENDING',
        body: data.body || '',
        media_id: data.media_id || null,
        media_mime_type: data.media_mime_type || null,
        media_url: data.media_url,
        media_filename: data.media_filename,
        media_caption: data.media_caption,
        wa_message_id: data.wa_message_id,
        client_message_id: data.client_message_id,
        sender_phone: 'ME',
        recipient_phone: jidToPhone(key) || key,
        created_at: new Date().toISOString(),
      };
      if (!messagesByChat.has(key)) messagesByChat.set(key, []);
      const outList = messagesByChat.get(key);
      outList.push(msg);
      if (outList.length > 2000) {
        outList.splice(0, outList.length - 2000);
      }
      this._touchChat(session, key, buildChatPreview(msg, key.includes('@g.us')), msg.created_at);
      emitEvent({
        event: 'message_new',
        conversation_id: key,
        message: msg,
      });
      return { ...msg };
    },

    _confirmOutboundSent(sessionId, jid, waId, clientMessageId) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      const key = resolveJidKey(store, jid);
      const list = store.messagesByChat.get(key) || [];
      const msg = list.find((m) =>
        (waId && m.wa_message_id === waId) ||
        (clientMessageId && m.client_message_id === clientMessageId)
      );
      const nowIso = new Date().toISOString();
      const prevStatus = msg?.status || 'PENDING';
      const shouldAdvance = (ACK_ORDER['SENT'] ?? 1) > (ACK_ORDER[prevStatus] ?? 0);
      if (msg) {
        if (shouldAdvance) {
          msg.status = 'SENT';
        }
        msg.wa_message_id = waId || msg.wa_message_id;
        msg.client_message_id ||= clientMessageId;
        msg.sent_at = msg.sent_at || nowIso;
      }
      if (shouldAdvance || !msg) {
        this._emit({
          event: 'message_status_updated',
          gateway_session_id: session.id,
          conversation_id: key,
          wa_message_id: waId || msg?.wa_message_id,
          client_message_id: clientMessageId || msg?.client_message_id,
          status: msg?.status || 'SENT',
          timestamp: nowIso,
        });
      }
      return msg ? { ...msg } : {
        wa_message_id: waId,
        client_message_id: clientMessageId,
        status: 'SENT',
        sent_at: nowIso,
      };
    },

    _failOutbound(sessionId, jid, waId, error) {
      const store = this._storeOf(this._requireSession(sessionId));
      const msg = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === waId);
      if (!msg || msg.status !== 'PENDING') return;
      msg.status = 'FAILED';
      this._emit({
        event: 'message_status_updated',
        gateway_session_id: sessionId,
        conversation_id: jid,
        wa_message_id: waId,
        client_message_id: msg.client_message_id,
        status: 'FAILED',
        error_message: String(error?.message || error).slice(0, 300),
      });
    },

    _applyMessageAck(sessionId, key, update) {
      const newStatus = ACK_RANK[update?.status];
      if (!key?.fromMe || !key.id || !key.remoteJid || !newStatus) return;
      const store = this._storeOf(this._requireSession(sessionId));
      const jid = resolveJidKey(store, key.remoteJid);
      const msg = (store.messagesByChat.get(jid) || []).find((m) => m.wa_message_id === key.id);
      // FAILED is terminal and must win over any earlier status, so it is
      // checked before the monotonic guard. Ranking it alongside PENDING (0)
      // meant a rejected message was silently discarded once it was SENT —
      // which is the case that matters, since WhatsApp rejects after accept.
      if (newStatus === 'FAILED') {
        if (msg && msg.status === 'FAILED') return;
        if (msg) {
          msg.status = 'FAILED';
          msg.error_message = 'WhatsApp reddetti (blok, hız sınırı veya ek biçimi).';
        }
        this._emit({
          event: 'message_status_updated',
          gateway_session_id: sessionId,
          conversation_id: jid,
          wa_message_id: key.id,
          client_message_id: msg?.client_message_id,
          status: 'FAILED',
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (msg && ACK_ORDER[newStatus] <= (ACK_ORDER[msg.status] ?? 0)) return;
      if (msg) msg.status = newStatus;
      this._emit({
        event: 'message_status_updated',
        gateway_session_id: sessionId,
        conversation_id: jid,
        wa_message_id: key.id,
        client_message_id: msg?.client_message_id,
        status: newStatus,
        timestamp: new Date().toISOString(),
      });
    },

    _applyLidMapping(session, lid, phoneJid) {
      session = this._sess(session);
      const store = this._storeOf(session);
      const { contacts, chats, messagesByChat } = store;
      const emitEvent = (event) => this._emit({ gateway_session_id: session.id, ...event });
      if (!rememberLidPair(store, lid, phoneJid)) return;
      // No-Create ephemeral sessions have no gateway_sessions row yet, so the
      // lid_mappings FK would reject the write. The pair is already remembered
      // in memory; persistence resumes once the pairing promotes the session.
      void lidRepository.persistLidMappingToDb(session.id, lid, phoneJid, { enabled: !session.ephemeral });
      const lidKey = asLid(lid);
      const phoneKey = asPn(phoneJid);

      const pending = contacts.get(lidKey);
      if (pending) {
        contacts.delete(lidKey);
        const merged = mergeContactName(contacts.get(phoneKey) || {}, pending.name, pending.name_source || 'addressbook');
        const avatarMerged = {
          ...merged,
          avatar_url: merged.avatar_url || pending.avatar_url || null,
          lid: lidKey,
        };
        contacts.set(phoneKey, {
          ...avatarMerged,
          id: phoneKey,
          jid: phoneKey,
          name: avatarMerged.name || jidToPhone(phoneKey) || phoneKey,
          phone: jidToPhone(phoneKey) || '',
          updated_at: new Date().toISOString(),
        });
        delete contacts.get(phoneKey).lid_pending;
        emitEvent({ event: 'contact_synced', contact: contacts.get(phoneKey) });
      }

      const lidChat = chats.get(lidKey);
      if (lidChat) {
        chats.delete(lidKey);
        const contact = contacts.get(phoneKey);
        const existingPhone = chats.get(phoneKey) || {};
        const lidChatName = lidChat.name && !isLidJid(lidChat.name) ? lidChat.name : null;
        const phoneChatName = existingPhone.name && !isLidJid(existingPhone.name) ? existingPhone.name : null;
        const mergedChat = {
          ...existingPhone,
          ...lidChat,
          id: phoneKey,
          jid: phoneKey,
          name: contact?.name || phoneChatName || lidChatName || jidToPhone(phoneKey) || phoneKey,
          name_source: contact?.name_source || existingPhone.name_source || lidChat.name_source || null,
          phone: jidToPhone(phoneKey) || '',
          is_group: false,
          updated_at: new Date().toISOString(),
        };
        chats.set(phoneKey, mergedChat);
        emitEvent({ event: 'conversation_updated', conversation: { ...mergedChat } });
      } else if (pending) {
        const chat = chats.get(phoneKey);
        if (chat) {
          const base = { name: isLidJid(chat.name) ? undefined : chat.name, name_source: chat.name_source };
          const picked = mergeContactName(base, pending.name, pending.name_source || 'addressbook');
          if (picked.name && picked.name !== chat.name) {
            chat.name = picked.name;
            chat.name_source = picked.name_source || null;
            chat.updated_at = new Date().toISOString();
            emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
          }
        }
      }

      const lidMsgs = messagesByChat.get(lidKey);
      if (lidMsgs) {
        messagesByChat.delete(lidKey);
        const phoneMsgs = messagesByChat.get(phoneKey) || [];
        const seen = new Set(phoneMsgs.map((m) => m.wa_message_id).filter(Boolean));
        const phoneStr = jidToPhone(phoneKey) || phoneKey;
        const migratedContact = contacts.get(phoneKey);
        for (const m of lidMsgs) {
          if (m.wa_message_id && seen.has(m.wa_message_id)) continue;
          m.conversation_id = phoneKey;
          if (typeof m.sender_phone === 'string' && m.sender_phone.endsWith('@lid')) m.sender_phone = phoneStr;
          if (typeof m.recipient_phone === 'string' && m.recipient_phone.endsWith('@lid')) m.recipient_phone = phoneStr;
          if (typeof m.sender_name === 'string' && m.sender_name.endsWith('@lid')) {
            m.sender_name = migratedContact?.name || phoneStr;
            m.sender_name_source = migratedContact?.name_source || m.sender_name_source || null;
          }
          phoneMsgs.push(m);
          emitEvent({ event: 'message_new', conversation_id: phoneKey, message: m });
        }
        phoneMsgs.sort((a, b) => (a.id || 0) - (b.id || 0));
        if (phoneMsgs.length > 2000) phoneMsgs.splice(0, phoneMsgs.length - 2000);
        messagesByChat.set(phoneKey, phoneMsgs);
      }
      logger.debug({ lid: lidKey, jid: phoneKey }, 'LID→telefon eşleşmesi uygulandı');
      emitEvent({
        event: 'lid_mapped',
        lid: lidKey,
        phone_jid: phoneKey,
        gateway_session_id: session.id,
      });
    },

    _touchChat(session, jid, preview, timestamp) {
      session = this._sess(session);
      const store = this._storeOf(session);
      const { chats, contacts } = store;
      const key = resolveJidKey(store, jid);
      const existing = chats.get(key) || {};
      const contact = contacts.get(key);
      const newTs = timestamp || new Date().toISOString();
      const tsOlder = existing.last_message_at && String(newTs) < String(existing.last_message_at);
      const nextPreview = preview && !tsOlder ? preview : existing.last_message_preview || '';
      const nextTs = tsOlder ? existing.last_message_at : newTs;
      chats.set(key, {
        ...existing,
        id: key,
        jid: key,
        name: contact?.name || existing.name || (key === '0@s.whatsapp.net' ? 'WhatsApp' : jidToPhone(key) || key),
        name_source: contact?.name_source || existing.name_source || (key === '0@s.whatsapp.net' ? 'system' : null),
        phone: jidToPhone(key) || existing.phone || '',
        is_group: key.includes('@g.us'),
        // Arsiv durumu bilinmiyorsa anahtar HIC gonderilmez (bkz. `archivedPatch`).
        ...archivedPatch(existing.archived),
        last_message_at: nextTs,
        last_message_preview: nextPreview,
        unread_count: existing.unread_count || 0,
        created_at: existing.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      // Phase 2.A: track @g.us jids that arrived via _touchChat without group
      // metadata. If `groupFetchAllParticipating` does not return them (omit /
      // fail / throttle / archived), the next _ensureGroupSubjects call will
      // pull them from this set and call `groupMetadata` on each. This closes
      // the 3Hacker bug where a group missing from store.chats had no path to
      // a `seedGroupChat` / targeted fallback.
      if (key.includes('@g.us')) {
        if (!session._pendingGroupJids) session._pendingGroupJids = new Set();
        const isResolved = existing.name && !isRawIdentityName(existing.name);
        if (!isResolved) session._pendingGroupJids.add(key);
      }
      if (isAvatarUrlExpired(chats.get(key)?.avatar_url)) void this._ensureChatAvatar(session, key);
    },

    async _ensureChatAvatar(session, key) {
      if (!session) return;
      session = this._sess(session);
      const store = this._storeOf(session);
      const { chats, contacts, avatarFetchInFlight, avatarFetchAttemptedAt } = store;
      if (avatarFetchInFlight.has(key)) return;
      const lastAttempt = avatarFetchAttemptedAt.get(key) || 0;
      if (Date.now() - lastAttempt < 10 * 60 * 1000) return;
      if (session.status !== 'CONNECTED' || !session.sock) return;
      if (typeof session.sock.profilePictureUrl !== 'function') return;
      avatarFetchInFlight.add(key);
      avatarFetchAttemptedAt.set(key, Date.now());
      let timer = null;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('profile_picture_query_timeout')), AVATAR_QUERY_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
        });
        timeoutPromise.catch(() => {});

        const queryPromise = Promise.resolve().then(() => session.sock.profilePictureUrl(key, 'preview'));
        const url = await Promise.race([queryPromise, timeoutPromise]);

        if (url) {
          const chat = chats.get(key);
          if (chat && chat.avatar_url !== url) {
            chat.avatar_url = url;
            chat.updated_at = new Date().toISOString();
            if (!isLidJid(key)) {
              this._emit({ event: 'conversation_updated', conversation: { ...chat }, gateway_session_id: session.id });
            }
          }
          const contact = contacts.get(key);
          if (contact && contact.avatar_url !== url) {
            contact.avatar_url = url;
            contact.updated_at = new Date().toISOString();
            this._emit({ event: 'contact_synced', contact: { ...contact }, gateway_session_id: session.id });
          }
        }
      } catch (err) {
        // Ayristirma: "item-not-found" sunucuda profil resmi YOK demektir —
        // bunu 30 sn'de bir yeniden denemek rate-limit israfidir. Negatif onbellek
        // uygulanir (1 saat boyunca tekrar sorulmaz). Gecici hatalar (ag/timeout)
        // backoff ile kisa sure sonra tekrar denenir.
        const errMsg = String(err?.message || err);
        const isTimeout = /timeout|timed out|408/i.test(errMsg);
        const noPicture = /item-not-found|not-acceptable|40[46]/i.test(errMsg);
        avatarFetchAttemptedAt.set(
          key,
          noPicture
            ? Date.now() + 50 * 60 * 1000
            : isTimeout
              ? Date.now() - (10 * 60 * 1000 - 45 * 1000)
              : Date.now() - (10 * 60 * 1000 - 30 * 1000),
        );
      } finally {
        if (timer) clearTimeout(timer);
        store.avatarFetchInFlight.delete(key);
      }
    },

    _scheduleBackgroundAvatarFetch(session) {
      if (!session) return;
      session = this._sess(session);
      const store = this._storeOf(session);
      if (!store) return;
      // Bir sweep zaten calisirken gelen tetikleyiciler YUTULMAZ: "yeniden
      // kos" isteği işaretlenir. Eskiden ikinci tetikleyici (finalizeHistorySync
      // + isLatest ayni anda ateslenir) sessizce dusüyordu; rate-limit'e
      // takilan sohbetler icin baska retry tetikleyicisi olmadigindan
      // avatarlari KALICI eksik kaliyordu.
      if (store._backgroundAvatarFetchRunning) {
        store._backgroundAvatarFetchRerunRequested = true;
        return;
      }
      store._backgroundAvatarFetchRunning = true;
      // A sweep that actually found chats is doing its job; clear the re-arm
      // budget so a later empty store (e.g. after a reconnect) can re-arm again.
      if (store.chats && store.chats.size > 0) store._avatarRearmCount = 0;

      // ROOT CAUSE (avatar 403/timeout): a WhatsApp profile-picture URL is a
      // SIGNED link that expires on its own. The old test was `!c.avatar_url`,
      // which treated an EXPIRED url as "we already have it" — so those chats
      // were never re-queried and the UI kept rendering a dead image (403)
      // until a manual refresh. Expiry is now part of "missing".
      const isMissingAvatar = (c) =>
        c && c.jid && isAvatarUrlExpired(c.avatar_url) && !isBroadcastOnlyJid(c.jid) && !isDegenerateJid(c.jid);
      const missingChats = () =>
        Array.from(store.chats.values())
          .filter(isMissingAvatar)
          .sort((a, b) => (b.last_message_at ? new Date(b.last_message_at).getTime() : 0) - (a.last_message_at ? new Date(a.last_message_at).getTime() : 0));

      // unref'li uyku: sweep'in backoff beklemeleri Node sürecini ALIKOYMAZ.
      // Gerçek gateway'de HTTP sunucusu süreci zaten canlı tutar; ama test
      // harness'ları gibi kısa ömürlü süreçlerde ref'li timer, olay yayıldıktan
      // sonra çıkışı dakikalarca geciktiriyordu (subprocess timeout).
      const unrefSleep = (ms) => {
        let timer;
        const p = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
        if (typeof timer.unref === 'function') timer.unref();
        return p;
      };

      setImmediate(async () => {
        let pass = 0;
        try {
          for (;;) {
            if (session._deleted || session._shuttingDown) break;
            if (session.status !== 'CONNECTED' || !session.sock) break;
            // Snapshot HER TURDA yeniden taranir: LID->PN gocu yeni chat
            // anahtarlari uretir; tek atimlik snapshot o anahtarlari kacirirdi.
            const chatsToFetch = missingChats();
            if (!chatsToFetch.length) break;
            pass += 1;
            for (let i = 0; i < chatsToFetch.length; i += AVATAR_SWEEP_BATCH) {
              if (session._deleted || session._shuttingDown) break;
              if (session.status !== 'CONNECTED' || !session.sock) break;
              const batch = chatsToFetch.slice(i, i + AVATAR_SWEEP_BATCH);
              await Promise.all(
                batch.map((chat) => this._ensureChatAvatar(session, chat.jid).catch(() => null))
              );
              // WhatsApp `profilePictureUrl` cagrlarini kisitlar. 3+100ms
              // tempo (~30 istek/sn) toplu kisitlama üretiyordu; jitterli
              // ~2-3 istek/sn esigin altinda kalir ve sweep artik EKSIK
              // KALMAYANA DEK backoff'lu turlarla tekrarlanir.
              const jitter = Math.floor(Math.random() * 200);
              await unrefSleep(AVATAR_SWEEP_PAUSE_MS + jitter);
            }
            const remaining = missingChats().length;
            if (!remaining) break;
            if (pass >= AVATAR_SWEEP_MAX_PASSES) {
              logger.info(
                { session_ref: sessionRef(session.id), pass, remaining },
                'Avatar sweep pass limit reached; retry on next trigger'
              );
              break;
            }
            const delay = AVATAR_SWEEP_RETRY_DELAYS_MS[
              Math.min(pass - 1, AVATAR_SWEEP_RETRY_DELAYS_MS.length - 1)
            ];
            logger.debug(
              { session_ref: sessionRef(session.id), pass, remaining, delay_ms: delay },
              'Avatar sweep pass done; scheduling backoff retry pass'
            );
            await unrefSleep(delay);
          }
        } catch (err) {
          logger.warn({ err, sessionId: session.id }, 'Background avatar fetch encountered error');
        } finally {
          store._backgroundAvatarFetchRunning = false;
          if (store._backgroundAvatarFetchRerunRequested) {
            store._backgroundAvatarFetchRerunRequested = false;
            this._scheduleBackgroundAvatarFetch(session);
          } else if (shouldRearmWhenEmpty(store, session)) {
            // ROOT CAUSE (photos arriving late): the sweep runs ONCE and exits
            // as soon as `missingChats()` is empty. The store is populated
            // asynchronously (Baileys `chats.update` / history sync), so a
            // sweep that is armed while the store is still empty finds nothing,
            // logs nothing, and never runs again — the photos then only appear
            // when an unrelated event happens to re-trigger it, which is what
            // users perceive as "gecikmeli". Re-arm on a short delay while the
            // store is still empty so the sweep picks the chats up as soon as
            // they land. Bounded so it cannot become a busy loop.
            scheduleRearm(this, session, store);
          }
        }
      });
    },

    /**
     * REST tetikleyicisi: eksik avatar sayisini raporlar ve (varsa) sweep'i
     * baslatir. Backend sync-job tamamlaninda ve manuel refresh'te kullanir.
     */
    requestAvatarBackfill(sessionId) {
      const session = this._requireSession(sessionId);
      const store = this._storeOf(session);
      let missing = 0;
      for (const c of store.chats.values()) {
        if (c && c.jid && isAvatarUrlExpired(c.avatar_url) && !isBroadcastOnlyJid(c.jid) && !isDegenerateJid(c.jid)) missing += 1;
      }
      const connected = session.status === 'CONNECTED' && Boolean(session.sock);
      if (missing && connected) this._scheduleBackgroundAvatarFetch(session);
      return { success: true, missing, scheduled: Boolean(missing && connected) };
    },

    async refreshAvatar(sessionId, jid) {
      const session = this._requireSession(sessionId);
      if (!session.sock || session.status !== 'CONNECTED') {
        return { success: false, error: 'Session not connected' };
      }
      const store = this._storeOf(session);
      const key = resolveJidKey(store, jid);
      try {
        // Bilinçli olarak `.catch(() => null)` YOK: başarısız ile "profil
        // resmi yok" ayrımı korunur. Başarısızlıkta mevcut avatar ASLA
        // null ile EZİLMEZ — eskiden null yazılıp `conversation_updated`
        // yayınlanıyordu ve sohbet listesindeki bilinen fotoğraf kayboluyordu.
        const url = await session.sock.profilePictureUrl(key, 'preview');
        if (store && url) {
          const chat = store.chats.get(key);
          if (chat) {
            chat.avatar_url = url;
            chat.updated_at = new Date().toISOString();
            this._emit({ event: 'conversation_updated', conversation: { ...chat }, gateway_session_id: session.id });
          }
          const contact = store.contacts.get(key);
          if (contact) {
            contact.avatar_url = url;
            contact.updated_at = new Date().toISOString();
            this._emit({ event: 'contact_synced', contact: { ...contact }, gateway_session_id: session.id });
          } else if (url) {
            this._emit({ event: 'contact_synced', contact: { jid: key, avatar_url: url }, gateway_session_id: session.id });
          }
        }
        return { success: true, jid: key, avatar_url: url || null };
      } catch (err) {
        return { success: false, jid: key, error: err.message };
      }
    },

    _resolveArchivedJids(session) {
      if (!session) return new Set();
      session = this._sess(session);
      try {
        const sessionDir = getSessionDir(sessionsDir, session.id);
        const regLowFile = path.join(sessionDir, 'app-state-sync-version-regular_low.json');
        if (!fs.existsSync(regLowFile)) return new Set();
        const regLow = JSON.parse(fs.readFileSync(regLowFile, 'utf8'));
        const indexMacs = new Set(Object.keys(regLow?.indexValueMap || {}));
        if (!indexMacs.size) return new Set();

        const keyFiles = fs.readdirSync(sessionDir).filter((f) => f.startsWith('app-state-sync-key-'));
        const syncKeys = [];
        for (const kf of keyFiles) {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, kf), 'utf8'));
            if (raw?.keyData) {
              const buf = typeof raw.keyData === 'string'
                ? Buffer.from(raw.keyData, 'base64')
                : Buffer.from(raw.keyData.data || raw.keyData);
              syncKeys.push(buf);
            }
          } catch { /* ignore */ }
        }
        if (!syncKeys.length) return new Set();

        const store = this._storeOf(session);
        const candidates = new Set([
          ...store.chats.keys(),
          ...store.contacts.keys(),
          '0@s.whatsapp.net',
        ]);
        if (session._pendingGroupJids) {
          for (const j of session._pendingGroupJids) candidates.add(j);
        }

        const archivedSet = new Set();
        for (const jid of candidates) {
          const indexBuffer = Buffer.from(JSON.stringify(['archive', jid]));
          for (const keyData of syncKeys) {
            try {
              const keys = expandAppStateKeys(keyData);
              const indexMac = hmacSign(indexBuffer, keys.indexKey).toString('base64');
              if (indexMacs.has(indexMac)) {
                archivedSet.add(jid);
                break;
              }
            } catch { /* ignore */ }
          }
        }
        return archivedSet;
      } catch (err) {
        logger.warn({ err: err?.message, sessionId: session.id }, 'Failed to resolve archived JIDs from local app state');
        return new Set();
      }
    },

    _applyArchivedState(session) {
      if (!session) return;
      session = this._sess(session);
      const store = this._storeOf(session);
      const archivedSet = this._resolveArchivedJids(session);
      if (!archivedSet.size) return;

      const emitEvent = (event) => this._emit({ gateway_session_id: session.id, ...event });

      // Seed 0@s.whatsapp.net (WhatsApp system chat) if archived and not present
      if (archivedSet.has('0@s.whatsapp.net') && !store.chats.has('0@s.whatsapp.net')) {
        const nowIso = new Date().toISOString();
        const waChat = {
          id: '0@s.whatsapp.net',
          jid: '0@s.whatsapp.net',
          name: 'WhatsApp',
          name_source: 'system',
          phone: '',
          is_group: false,
          archived: true,
          avatar_url: null,
          last_message_at: null,
          last_message_preview: '',
          unread_count: 0,
          created_at: nowIso,
          updated_at: nowIso,
        };
        store.chats.set('0@s.whatsapp.net', waChat);
        store.contacts.set('0@s.whatsapp.net', {
          id: '0@s.whatsapp.net',
          jid: '0@s.whatsapp.net',
          name: 'WhatsApp',
          name_source: 'system',
          phone: '',
          is_group: false,
          updated_at: nowIso,
        });
        emitEvent({ event: 'conversation_updated', conversation: { ...waChat } });
      }

      for (const jid of archivedSet) {
        const key = resolveJidKey(store, jid);
        const chat = store.chats.get(key);
        if (chat && !chat.archived) {
          chat.archived = true;
          chat.updated_at = new Date().toISOString();
          emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
        }
      }
    },

    async resyncAppState(sessionId) {
      const session = this._requireSession(sessionId);
      if (!session.sock || session.status !== 'CONNECTED') {
        return { success: false, error: 'Session not connected' };
      }
      this._applyArchivedState(session);
      if (typeof session.sock.resyncAppState !== 'function') {
        return { success: true };
      }
      try {
        await session.sock.resyncAppState(['regular_low', 'regular_high'], false);
        this._applyArchivedState(session);
        return { success: true };
      } catch (err) {
        return { success: false, error: err?.message || String(err) };
      }
    },

    /**
     * Arm the app-state sync recovery chain.
     *
     * Public counterpart of the module-level `scheduleAppStateRearm`, called
     * once a session reaches CONNECTED. See that function for why a Baileys
     * "parked" collection otherwise strands the chat list for the life of the
     * process.
     *
     * Every connect is a NEW app-state sync run (the previous run's park is
     * cleared by Baileys on `connection.close`), so the recovery verdict is
     * deliberately reset here. Carrying `appStateHealthy` across a reconnect
     * would skip the retry on exactly the connection that needs it.
     */
    _scheduleAppStateRearm(session) {
      session = this._sess(session);
      if (!session) return;
      const store = this._storeOf(session);
      store.appStateHealthy = false;
      store._appStateRearmCount = 0;
      if (!shouldRearmAppState(session, store)) return;
      scheduleAppStateRearm(this, session, store, getSessionDir(sessionsDir, session.id));
    },

    async _ensureGroupSubjects({ sessionId, force = false, extraJids = [] } = {}) {
      const session = sessionId ? sessions.get(String(sessionId)) : null;
      if (!session) return { applied: false, reason: 'no_session' };
      if (session.status !== 'CONNECTED' || !session.sock) {
        return { applied: false, reason: 'no_session' };
      }
      const store = this._storeOf(session);
      const { chats, contacts } = store;
      const emitEvent = (event) => this._emit({ gateway_session_id: session.id, ...event });

      const last = session._groupSubjectsAt || 0;
      if (!force && Date.now() - last < 10 * 60 * 1000) return { applied: false, reason: 'throttled' };
      if (session._groupSubjectsInFlight) return { applied: false, reason: 'in_flight' };
      session._groupSubjectsInFlight = true;
      session._groupSubjectsAt = Date.now();

      const applySubject = (jid, subject) => {
        const key = resolveJidKey(store, jid);
        const chat = chats.get(key);
        const contact = contacts.get(key);
        const rankCur = NAME_RANK[chat?.name_source] || 0;
        if (chat && (NAME_RANK.group_subject > rankCur || isRawIdentityName(chat.name))) {
          const merged = mergeContactName({ name: chat.name, name_source: chat.name_source }, subject, 'group_subject');
          if (merged.name && merged.name !== chat.name) {
            chat.name = merged.name;
            chat.name_source = merged.name_source;
            chat.updated_at = new Date().toISOString();
            emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
          }
        }
        if (contact) {
          const mergedC = mergeContactName({ name: contact.name, name_source: contact.name_source }, subject, 'group_subject');
          if (mergedC.name && mergedC.name !== contact.name) {
            contact.name = mergedC.name;
            contact.name_source = mergedC.name_source;
            contact.updated_at = new Date().toISOString();
            emitEvent({ event: 'contact_synced', contact: { ...contact } });
          }
        }
        // A group known only from its subject has no message of its own, so
        // `_touchChat` never runs for it and `seedGroupChat` stores
        // `avatar_url: null` — nothing else in the gateway ever asks WhatsApp
        // for that group's picture, and the one-shot background avatar sweep
        // (armed at history-sync progress 100) has already finished by the time
        // this pass seeds the chat. Measured live 2026-09-26: 9 of 12 group
        // chats held no avatar and 5 of those DID have one on the server (a
        // forced `profilePictureUrl` returned a URL). `_ensureChatAvatar` is
        // in-flight guarded and throttled to one attempt per jid per 10 min, so
        // requesting it on every pass is safe and self-healing.
        if (isAvatarUrlExpired(chats.get(key)?.avatar_url)) void this._ensureChatAvatar(session, key);
      };

      const resolvedKeys = new Set();
      const seedGroupChat = (jid, subject, meta) => {
        if (session.ephemeral) return;
        try {
          const key = resolveJidKey(store, jid);
          if (chats.has(key)) return;
          const nowIso = new Date().toISOString();
          const created = {
            id: key,
            jid: key,
            name: subject,
            name_source: 'group_subject',
            phone: '',
            is_group: true,
            // Yalnizca konusundan bilinen grup: arsiv durumu BILINMIYOR.
            // Sabit `false` yazmak, backend'in `"archived" in payload`
            // korumasini devre disi birakip bilinen bir arsivi ezerdi.
            ...archivedPatch(undefined),
            avatar_url: meta?.imgUrl || null,
            last_message_at: null,
            last_message_preview: '',
            unread_count: 0,
            created_at: nowIso,
            updated_at: nowIso,
          };
          chats.set(key, created);
          contacts.set(key, {
            id: key,
            jid: key,
            name: subject,
            name_source: 'group_subject',
            phone: '',
            is_group: true,
            updated_at: nowIso,
          });
          emitEvent({ event: 'conversation_updated', conversation: { ...created } });
        } catch (seedErr) {
          logger.warn({ err: seedErr }, 'group chat seeding failed for one group');
        }
      };

      try {
        const fetchPromise = session.sock.groupFetchAllParticipating();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('groupFetchAllParticipating timeout')), 15000)
        );
        const all = await Promise.race([fetchPromise, timeoutPromise]);
        for (const meta of Object.values(all || {})) {
          const jid = meta?.id;
          const subject = typeof meta?.subject === 'string' ? meta.subject.trim() : '';
          if (!jid || !jid.includes('@g.us') || !subject) continue;
          resolvedKeys.add(resolveJidKey(store, jid));
          seedGroupChat(jid, subject, meta);
          applySubject(jid, subject);
        }
      } catch (err) {
        session._groupSubjectsAt = 0;
        logger.warn({ err: err?.message || err }, 'groupFetchAllParticipating failed');
      }

      try {
        // Phase 2.A: union three sources for the targeted-fallback pass.
        // Pre-fix: only `chats.values()` was iterated, so a group that never
        // entered `store.chats` (because `groupFetchAllParticipating` omitted
        // it, failed, or the group has zero messages) had NO path to a
        // `groupMetadata` call. The 3Hacker bug is exactly this: the group
        // exists in the user's phone, has a subject, but the gateway could
        // not discover it because it never reached `chats`.
        //
        // Sources, in priority order:
        //   1. `chats.values()` — groups that already exist in store.chats
        //      (e.g. via a single message arriving) but lack a subject.
        //   2. `session._pendingGroupJids` — @g.us jids that `_touchChat` saw
        //      arrive without a subject. These may NOT be in `store.chats`
        //      yet (zero-message archived group that just produced a sync
        //      hint) and would otherwise be invisible to the targeted pass.
        //   3. `extraJids` — caller-supplied list (e.g. backend forwarding
        //      DB-known @g.us jids). Reserved for Phase 2.B/C; currently
        //      empty for internal callers.
        const unresolvedKeys = new Set();
        for (const c of chats.values()) {
          if (c.jid && c.jid.includes('@g.us') && !resolvedKeys.has(resolveJidKey(store, c.jid)) && (isRawIdentityName(c.name) || !c.name)) {
            unresolvedKeys.add(resolveJidKey(store, c.jid));
          }
        }
        // Phase 2.1.A: pending/extra jids must honour the SAME resolution
        // predicate as the chats.values() branch. Pre-fix, a jid forwarded
        // via extraJids (or seen by _touchChat) that the broad pass omits
        // was re-fetched with groupMetadata on EVERY forced pass — even
        // after a prior targeted pass had already resolved and seeded it.
        // Cross-pass dedup now matches within-pass dedup.
        const isUnresolvedGroupJid = (jid) => {
          const key = resolveJidKey(store, jid);
          if (resolvedKeys.has(key)) return false;
          const chat = chats.get(key);
          if (chat && chat.name && !isRawIdentityName(chat.name)) return false;
          return true;
        };
        if (session._pendingGroupJids) {
          for (const jid of session._pendingGroupJids) {
            if (jid && jid.includes('@g.us') && isUnresolvedGroupJid(jid)) {
              unresolvedKeys.add(resolveJidKey(store, jid));
            }
          }
        }
        for (const jid of extraJids) {
          if (jid && jid.includes('@g.us') && isUnresolvedGroupJid(jid)) {
            unresolvedKeys.add(resolveJidKey(store, jid));
          }
        }
        const unresolved = [...unresolvedKeys].slice(0, 10);
        let nextUnresolvedIndex = 0;
        const processUnresolvedGroup = async () => {
          while (true) {
            if (session._groupSubjectsInFlight === 'cancelled') return;
            const index = nextUnresolvedIndex++;
            if (index >= unresolved.length) return;
            const jid = unresolved[index];
            try {
              const metaPromise = session.sock.groupMetadata(jid);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('groupMetadata timeout')), 8000)
              );
              const meta = await Promise.race([metaPromise, timeoutPromise]);
              if (session._groupSubjectsInFlight === 'cancelled') return;
              const subject = typeof meta?.subject === 'string' ? meta.subject.trim() : '';
              if (subject) {
                // Phase 2.A closure: seed the chat if the group is absent from
                // store.chats. Pre-fix, the targeted pass only called
                // `applySubject` — a no-op for an absent chat — so a group whose
                // `groupMetadata` succeeded still never became a conversation
                // (it silently waited for a later `chats.update` event that
                // might never come). `seedGroupChat` is a no-op when the chat
                // already exists (`chats.has` guard) and emits
                // `conversation_updated`, which the backend persists into
                // public.conversations. Mirrors the broad pass (seed + apply).
                seedGroupChat(meta.id || jid, subject, meta);
                applySubject(meta.id || jid, subject);
              }
            } catch { /* ignored */ }
            if (session._groupSubjectsInFlight === 'cancelled') return;
            await new Promise((r) => setTimeout(r, 500));
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(2, unresolved.length) },
            () => processUnresolvedGroup(),
          ),
        );
        // Once the targeted pass has run, the pending set has been honoured.
        // Clear it: the next pass must rebuild it from current state, not
        // carry stale entries across restarts.
        if (session._pendingGroupJids) session._pendingGroupJids.clear();
      } catch (err) {
        logger.warn({ err }, 'targeted groupMetadata fallback failed');
      } finally {
        session._groupSubjectsInFlight = false;
      }
      if (typeof session.sock?.resyncAppState === 'function') {
        try {
          await session.sock.resyncAppState(['regular_low', 'regular_high'], false);
          logger.info({ sessionId: session.id }, 'App state resync completed for regular collections');
        } catch (resyncErr) {
          logger.warn({ err: resyncErr?.message, sessionId: session.id }, 'App state resync failed after group subjects');
        }
      }
      this._applyArchivedState(session);
      this._scheduleBackgroundAvatarFetch(session);
      return { applied: true, reason: null };
    },

    _resolveDisplayName(session, jid, fallbackPushName) {
      session = this._sess(session);
      const store = this._storeOf(session);
      const key = resolveJidKey(store, jid);
      const contact = key ? store.contacts.get(key) : null;
      if (contact?.name && !isRawIdentityName(contact.name)) return contact.name;
      if (fallbackPushName && !isRawIdentityName(fallbackPushName)) return fallbackPushName;
      const phone = jidToPhone(key);
      return phone || null;
    },

    _formatMentions(session, text, contextInfo) {
      if (!text || typeof text !== 'string') return text || '';
      session = this._sess(session);
      const store = this._storeOf(session);
      const mentionedJids = contextInfo?.mentionedJid;
      let formatted = text;

      if (Array.isArray(mentionedJids) && mentionedJids.length > 0) {
        for (const mJid of mentionedJids) {
          if (!mJid) continue;
          const userPart = String(mJid).split('@')[0];
          if (!userPart) continue;
          const name = this._resolveDisplayName(session, mJid);
          if (name && name !== userPart) {
            formatted = formatted.split(`@${userPart}`).join(`@${name}`);
          }
        }
      }

      const rawMentions = formatted.match(/@[0-9]{10,25}\b/g);
      if (rawMentions) {
        for (const mention of rawMentions) {
          const digits = mention.slice(1);
          const lidKey = resolveJidKey(store, `${digits}@lid`);
          const phoneKey = resolveJidKey(store, `${digits}@s.whatsapp.net`);
          const contact = store.contacts.get(lidKey) || store.contacts.get(phoneKey);
          if (contact?.name && !isRawIdentityName(contact.name)) {
            formatted = formatted.split(mention).join(`@${contact.name}`);
          }
        }
      }

      return formatted;
    },

    _historyMessageToRecord(session, msg, key) {
      session = this._sess(session);
      const content = msg.message || {};
      const rawText =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        '';
      const contextInfo =
        content.extendedTextMessage?.contextInfo ||
        content.imageMessage?.contextInfo ||
        content.videoMessage?.contextInfo ||
        content.documentMessage?.contextInfo;
      const text = this._formatMentions(session, rawText, contextInfo);
      const mediaType = classifyMessageType(content);
      if (!hasRecognizedContent(content) && !text) return null;
      const ts = messageTimestampMs(msg.messageTimestamp);
      const timestampSeconds = Number(msg.messageTimestamp);
      const rawMedia =
        content.imageMessage ||
        content.videoMessage ||
        content.audioMessage ||
        content.documentMessage ||
        content.stickerMessage;
      const mediaMime =
        rawMedia?.mimetype ||
        (mediaType === 'IMAGE'
          ? 'image/jpeg'
          : mediaType === 'VIDEO'
            ? 'video/mp4'
            : mediaType === 'AUDIO'
              ? 'audio/ogg'
              : content.documentMessage?.mimetype || null);
      const mediaFilename =
        content.documentMessage?.fileName ||
        rawMedia?.fileName ||
        null;
      const waMsgId = msg.key?.id || null;
      let mediaId = null;
      if (waMsgId && typeof mediaStore?.getMediaIdByWaId === 'function') {
        mediaId = mediaStore.getMediaIdByWaId(waMsgId);
      }

      const rawReactions = Array.isArray(msg.reactions)
        ? msg.reactions
        : (msg.message?.reactionMessage ? [msg.message.reactionMessage] : []);
      const reactions = rawReactions
        .filter((r) => r?.text)
        .map((r) => ({
          emoji: r.text,
          from_me: Boolean(r.key?.fromMe),
          reactor_jid: r.key?.fromMe ? null : (r.key?.participant || r.key?.remoteJid || null),
          created_at: r.senderTimestampMs
            ? new Date(Number(r.senderTimestampMs)).toISOString()
            : null,
        }));

      return {
        id: ts,
        timestamp_s: Number.isFinite(timestampSeconds) && timestampSeconds > 0 ? timestampSeconds : null,
        conversation_id: key,
        direction: msg.key?.fromMe ? 'OUTBOUND' : 'INBOUND',
        message_type: mediaType || 'TEXT',
        status: resolveMessageStatus(msg, Boolean(msg.key?.fromMe), reactions),
        body: text || '',
        media_id: mediaId,
        media_mime_type: mediaMime,
        media_filename: mediaFilename,
        media_caption: text || null,
        wa_message_id: waMsgId,
        sender_phone: msg.key?.fromMe ? 'ME' : (jidToPhone(msg.key?.participant || key) || key),
        recipient_phone: msg.key?.fromMe ? (jidToPhone(key) || key) : 'ME',
        sender_name: msg.key?.fromMe ? 'ME' : (this._resolveDisplayName(session, msg.key?.participant || key, msg.pushName) || null),
        participant_jid: msg.key?.participant || null,
        participant_name: msg.key?.participant ? this._resolveDisplayName(session, msg.key.participant, msg.pushName) : null,
        reactions: reactions,
        created_at: new Date(ts).toISOString(),
      };
    },

    // -----------------------------------------------------------------------
    // Socket Lifecycle Management
    // -----------------------------------------------------------------------
    _startSocket(id) {
      const session = sessions.get(id);
      if (!session || session._deleted) return;
      this._connectSocket(id).catch((error) => {
        const current = sessions.get(id);
        if (!current || current._deleted) return;
        current.status = 'UNAVAILABLE';
        current.is_phone_online = false;
        current.error_message = 'WHATSAPP_AUTH_STORE_UNAVAILABLE';
        current.updated_at = new Date().toISOString();
        diagnostic('socket_start_failed', {
          session_ref: sessionRef(id),
          generation: current._diagnosticSocketGeneration || 0,
          error_name: error?.name || 'Error',
          error_code: error?.code || null,
        });
        logger.error({ err: error, session_ref: sessionRef(id) }, 'WhatsApp socket start failed');
        const retryDelayMs = Math.min(15_000, 2_000 * (2 ** Math.min(current._connFailures || 0, 3)));
        setTimeout(() => {
          const s = sessions.get(id);
          if (s && !s._deleted && s.status === 'UNAVAILABLE' && s.is_active) {
            logger.info({ session_ref: sessionRef(id), retryDelayMs }, 'Retrying WhatsApp socket connect after transient store failure');
            this._startSocket(id);
          }
        }, retryDelayMs);
      });
    },

    async _connectSocket(id) {
      const session = sessions.get(id);
      // Phase 1 §1: a deleted or restarted session must not start a new socket.
      // `lifecycle.invalidate()` (called by deleteSession / refreshQr / logoutSession /
      // cancelPairing-finalize) bumps the generation AND nulls the lifecycle socket.
      // If a stale `_connectSocket` invocation arrives after the session is gone
      // or after the lifecycle was invalidated, we MUST NOT acquire a lease,
      // MUST NOT instantiate a new socket, and MUST NOT arm renewal.
      if (!session || session._deleted) return;
      if (session.lifecycle._reconnectTimer !== null) {
        diagnostic('connect_skipped_reconnect_timer_pending', { session_ref: sessionRef(id) });
        return;
      }
      const generation = session.lifecycle.beginAttempt();
      session._diagnosticSocketGeneration = generation;
      leaseCoordinator.clearLeaseTimers(session);

      // On-contended callback: the lease-coordinator will retry after 5–6s. By
      // that time the session may have been deleted; check the live session
      // each time, not the closure.
      const acquired = await leaseCoordinator.acquireLease(session, generation, () => {
        const live = sessions.get(id);
        if (!live || live._deleted) {
          diagnostic('lease_contention_callback_skipped_deleted', { session_ref: sessionRef(id), generation });
          return;
        }
        // Only retry if THIS socket's generation is still current — otherwise
        // a newer `_connectSocket` is already in flight.
        if (live.lifecycle.generation !== generation) {
          diagnostic('lease_contention_callback_stale_generation', {
            session_ref: sessionRef(id),
            callback_generation: generation,
            current_generation: live.lifecycle.generation,
          });
          return;
        }
        this._startSocket(id);
      });
      if (!acquired) return;

      // Phase 1 §1 (Defect 1): the session may have been deleted, refreshed, or
      // logged-out during the `acquireLease` await. If so, the lease is now
      // held by a session that is going away — release it and stop.
      if (session._deleted || !sessions.has(id)) {
        diagnostic('socket_start_aborted_after_lease_acquire', {
          session_ref: sessionRef(id),
          generation,
          reason: session._deleted ? 'deleted' : 'missing_from_registry',
        });
        try { await leaseCoordinator.releaseLease(session); } catch (err) { /* ignore */ }
        return;
      }

      let created;
      try {
        created = await createSocketForSession({
          id,
          session,
          generation,
          sessionsDir,
          aesKey,
          authRepository,
          logger,
          retryCounterCacheFor,
          onLidMappingDiscovered: (lid, phoneJid) => {
            // Re-read the session on every LID callback; the closure may be stale.
            const live = sessions.get(id);
            if (!live || live._deleted) return;
            // `_applyLidMapping` owns both cache persistence and migration of
            // pending contacts/chats/messages.  Pre-populating the cache here
            // made its `rememberLidPair` guard return false, skipping all of
            // those side effects and the canonical `lid_mapped` event.
            this._applyLidMapping(live, lid, phoneJid);
          },
        });
      } catch (err) {
        // Phase 1 §1: a thrown createSocketForSession leaves the lease HELD but
        // no socket attached. Release the lease and surface the error so the
        // caller (`_startSocket` catch) can mark UNAVAILABLE.
        try { await leaseCoordinator.releaseLease(session); } catch (releaseErr) { /* ignore */ }
        throw err;
      }

      if (session._deleted || session.lifecycle.generation !== generation) {
        diagnostic('stale_socket_attach_rejected', {
          session_ref: sessionRef(id),
          generation,
          current_generation: session.lifecycle.generation,
          deleted: session._deleted,
        });
        try { created.sock.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { created.sock.end(undefined); } catch (err) { /* ignore */ }
        try { await leaseCoordinator.releaseLease(session); } catch (err) { /* ignore */ }
        return;
      }

      const replacedSocket = session.lifecycle.attach(generation, created.sock);
      if (replacedSocket) {
        diagnostic('socket_owner_replaced', {
          session_ref: sessionRef(id),
          generation,
          previous_generation: generation - 1,
        });
        try { replacedSocket.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { replacedSocket.end(undefined); } catch (err) { /* ignore */ }
      }

      if (!session.lifecycle.isCurrent(generation, created.sock)) {
        diagnostic('stale_socket_attach_rejected', {
          session_ref: sessionRef(id),
          generation,
          current_generation: session.lifecycle.generation,
        });
        try { created.sock.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { created.sock.end(undefined); } catch (err) { /* ignore */ }
        return;
      }

      session.sock = created.sock;
      latency('socket_initialization_ms', created.connectStarted, id);

      const loseLease = () => {
        // Phase 1 §1: a lease-lost callback may fire AFTER the session was
        // deleted. In that case, do nothing — deleteSession already cleaned up
        // the lease, the socket, the auth, and the registry row.
        const live = sessions.get(id);
        if (!live || live._deleted) {
          diagnostic('lease_lost_callback_skipped_deleted', { session_ref: sessionRef(id), generation });
          return;
        }
        if (!live.lifecycle.isCurrent(generation, created.sock)) {
          diagnostic('lease_lost_callback_stale_generation', {
            session_ref: sessionRef(id),
            callback_generation: generation,
            current_generation: live.lifecycle.generation,
          });
          return;
        }
        live.lifecycle.invalidate();
        leaseCoordinator.clearLeaseTimers(live);
        try { created.sock.ev?.removeAllListeners(); } catch (err) { /* ignore */ }
        try { created.sock.end(undefined); } catch (err) { /* ignore */ }
        live.sock = null;
        live.status = 'UNAVAILABLE';
        live.is_phone_online = false;
        live.error_message = 'WHATSAPP_SESSION_LEASE_LOST';
        diagnostic('socket_lease_lost', { session_ref: sessionRef(id), generation });
      };

      const armLease = () => leaseCoordinator.armLeaseRenewal(session, generation, created.sock, loseLease);
      if (!session.ephemeral) armLease();

      bindSocketEvents({
        id,
        session,
        generation,
        sock: created.sock,
        state: created.state,
        saveCreds: created.saveCreds,
        connectStarted: created.connectStarted,
        sessionDir: created.sessionDir,
        manager: this,
        sessions,
        leaseCoordinator,
        lidRepository,
        mediaStore,
        authRepository,
        leaseRepository,
        instanceId,
        aesKey,
        logger,
        pendingHistoryWaiters,
        inFlightHistoryFetches,
        resetRetryCounterCache,
        clearSessionHistoryFetches,
        deactivatePersistentSession,
        armLeaseRenewal: armLease,
      });
    },
  };

  return sessionManager;
}
