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
import { createBoundedCache } from './domain/bounded-cache.js';

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
  contactPhoneJid,
  normalizePairingPhone,
  mergeContactName,
  rememberLidPair,
  resolveJidKey,
} from './utils/whatsapp-identity.js';

import {
  TYPE_PREVIEW_LABELS,
  normalizePreviewText,
  buildChatPreview,
  sanitizeChatForEmit,
  sanitizeOutboundEvent,
  resolveSyncState,
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
  buildMediaContent,
} from './messages/message-classifier.js';

import {
  RAW_MESSAGE_STORE_MAX,
  createSessionStore,
  rememberRawMessage,
  lookupRawMessage,
  messageTimestampMs,
} from './messages/message-store.js';

import { createMediaStore } from './media/media-store.js';

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

// Baileys/WA ack rank and order
const ACK_RANK = { 2: 'SENT', 3: 'DELIVERED', 4: 'READ', 5: 'READ' };
const ACK_ORDER = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 0 };

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
  const lidRepository = createLidRepository({ pool, sessionsDir, logger });
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
      await lidRepository.loadLidMappingsFromDb(id, session.store);
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
        session.lifecycle.invalidate();
        await leaseCoordinator.releaseLease(session);
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
      const { contacts } = this._storeOf(session);
      return [...contacts.values()]
        .filter((c) => !isLidJid(c.id) && (c.name_source === 'addressbook' || c.name_source === 'verified'))
        .map((c) => ({ ...c }));
    },

    listConversations(sessionId, { search, limit, offset } = {}) {
      const session = this._requireSession(sessionId);
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
      { count = 50, oldestMsgId, oldestMsgFromMe, oldestMsgTimestampMs, before, timeoutMs = 15000 } = {}
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

      const fetchPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingHistoryWaiters.delete(flightKey);
          inFlightHistoryFetches.delete(flightKey);
          logger.info({ flightKey, targetId }, 'Older history request timed out waiting for provider chunk');
          resolve({ messages: [], count: 0, status: 'TIMEOUT' });
        }, timeoutMs);

        pendingHistoryWaiters.set(flightKey, {
          resolve: (newMsgs) => {
            clearTimeout(timer);
            pendingHistoryWaiters.delete(flightKey);
            inFlightHistoryFetches.delete(flightKey);
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
              resolve({ messages: [], count: 0, status: 'ERROR', error: err?.message });
            });
        } catch (err) {
          clearTimeout(timer);
          pendingHistoryWaiters.delete(flightKey);
          inFlightHistoryFetches.delete(flightKey);
          logger.warn({ flightKey, err: err?.message }, 'Exception in sock.fetchMessageHistory');
          resolve({ messages: [], count: 0, status: 'ERROR', error: err?.message });
        }
      });

      inFlightHistoryFetches.set(flightKey, fetchPromise);
      return fetchPromise;
    },

    async getMessages(
      sessionId,
      jid,
      { limit = 50, before, fetchProvider = false, oldestMsgId, oldestMsgFromMe, oldestMsgTimestampMs, timeoutMs = 15000 } = {}
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

    listAllMessages(sessionId, { limit = 1000, offset = 0, since = null, perChatLimit = null } = {}) {
      const session = this._requireSession(sessionId);
      const { messagesByChat } = this._storeOf(session);
      const sinceMs = Number.isFinite(Number(since)) && since !== null && since !== ''
        ? Number(since) * 1000
        : null;
      const perChat = Number.isFinite(Number(perChatLimit)) && Number(perChatLimit) > 0
        ? Number(perChatLimit)
        : null;
      const all = [];
      for (const list of messagesByChat.values()) {
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
        if (existing.status !== 'FAILED') return { ...existing };
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
        if (existing.status !== 'FAILED') return { ...existing };
      }
      const content = buildMediaContent({
        media_type, media_url, media_base64, mime_type, caption, filename,
      });
      const messageId = crypto.createHash('sha256')
        .update(`${session.id}\0${key}\0${clientMessageId}`)
        .digest('hex').slice(0, 32).toUpperCase();
      const pending = this._recordOutbound(key, {
        body: expectedBody, message_type: type.toUpperCase(),
        client_message_id: clientMessageId, wa_message_id: messageId, status: 'PENDING',
        media_filename: filename, media_caption: caption,
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
          } else {
            await session.sock.readMessages([{ remoteJid: key, id: undefined, fromMe: false }]);
          }
        } else {
          const newest = inbound[inbound.length - 1];
          await session.sock.readMessages([{ remoteJid: key, id: newest?.wa_message_id, fromMe: false }]);
        }
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
      return gatewayOk ? { success: true } : { success: false, error: gatewayError };
    },

    // -----------------------------------------------------------------------
    // Media delegation
    // -----------------------------------------------------------------------
    getMediaPath(sessionId, mediaId) {
      return mediaStore.getMediaPath(sessionId, mediaId);
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
      const key = normalizeJid(jid);
      if (isBroadcastOnlyJid(key)) return null;

      if (msg.key?.id) {
        const dup = (messagesByChat.get(key) || []).some(
          (m) => m.wa_message_id && m.wa_message_id === msg.key.id
        );
        if (dup) return null;
      }

      const lidHold = isLidJid(key);
      if (msg.key?.id && msg.message) {
        rememberRawMessage(store, key, msg.key.id, msg.message);
      }
      const contact = contacts.get(key);
      const isGroup = jid.includes('@g.us');
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || msg.message?.documentMessage?.caption || '';
      const mediaType = classifyMessageType(msg.message);
      let mediaInfo = null;
      if (!fromMe && mediaType !== 'TEXT' && mediaType !== 'LOCATION' && mediaType !== 'CONTACT' && typeof this.storeIncomingMedia === 'function' && sock) {
        mediaInfo = await this.storeIncomingMedia(session, msg, sock);
      }
      const ts = messageTimestampMs(msg.messageTimestamp);
      const timestampSeconds = Number(msg.messageTimestamp);
      const record = {
        id: ts,
        timestamp_s: Number.isFinite(timestampSeconds) && timestampSeconds > 0 ? timestampSeconds : null,
        conversation_id: key,
        direction: fromMe ? 'OUTBOUND' : 'INBOUND',
        message_type: mediaType,
        status: fromMe ? 'SENT' : 'RECEIVED',
        body: text || '',
        media_id: mediaInfo?.media_id || null,
        media_mime_type: mediaInfo?.mime_type || null,
        media_filename: mediaInfo?.filename || null,
        media_caption: text || null,
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
      chatMsgs.push(record);
      if (chatMsgs.length > 2000) {
        chatMsgs.splice(0, chatMsgs.length - 2000);
      }
      this._touchChat(session, key, buildChatPreview(record, isGroup), record.created_at);
      const chat = chats.get(key);
      if (chat && !fromMe) chat.unread_count = (chat.unread_count || 0) + 1;
      if (!lidHold) {
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
      void lidRepository.persistLidMappingToDb(session.id, lid, phoneJid);
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
        name: contact?.name || existing.name || jidToPhone(key) || key,
        name_source: contact?.name_source || existing.name_source || null,
        phone: jidToPhone(key) || existing.phone || '',
        is_group: key.includes('@g.us'),
        archived: existing.archived ?? false,
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
      if (!chats.get(key)?.avatar_url) void this._ensureChatAvatar(session, key);
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
      avatarFetchInFlight.add(key);
      avatarFetchAttemptedAt.set(key, Date.now());
      try {
        const url = await session.sock.profilePictureUrl(key, 'preview');
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
      } catch {
        // Picture not accessible - expected
      } finally {
        store.avatarFetchInFlight.delete(key);
      }
    },

    _scheduleBackgroundAvatarFetch(session) {
      if (!session) return;
      session = this._sess(session);
      const store = this._storeOf(session);
      if (!store || store._backgroundAvatarFetchRunning) return;
      store._backgroundAvatarFetchRunning = true;

      setImmediate(async () => {
        try {
          const chatsToFetch = Array.from(store.chats.values())
            .filter((c) => c && c.jid && !c.avatar_url && !isBroadcastOnlyJid(c.jid) && !isDegenerateJid(c.jid))
            .sort((a, b) => (b.last_message_at ? new Date(b.last_message_at).getTime() : 0) - (a.last_message_at ? new Date(a.last_message_at).getTime() : 0));

          const BATCH_SIZE = 3;
          for (let i = 0; i < chatsToFetch.length; i += BATCH_SIZE) {
            if (session.status !== 'CONNECTED' || !session.sock) break;
            const batch = chatsToFetch.slice(i, i + BATCH_SIZE);
            await Promise.all(
              batch.map((chat) => this._ensureChatAvatar(session, chat.jid).catch(() => null))
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (err) {
          logger.warn({ err, sessionId: session.id }, 'Background avatar fetch encountered error');
        } finally {
          store._backgroundAvatarFetchRunning = false;
        }
      });
    },

    async refreshAvatar(sessionId, jid) {
      const session = this._requireSession(sessionId);
      if (!session.sock || session.status !== 'CONNECTED') {
        return { success: false, error: 'Session not connected' };
      }
      const store = this._storeOf(session);
      const key = resolveJidKey(store, jid);
      try {
        const url = await session.sock.profilePictureUrl(key, 'preview').catch(() => null);
        if (store) {
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
        return { success: true, jid: key, avatar_url: url };
      } catch (err) {
        return { success: false, jid: key, error: err.message };
      }
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
            archived: false,
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
        const all = await session.sock.groupFetchAllParticipating();
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
        logger.warn({ err }, 'groupFetchAllParticipating failed');
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
              const meta = await session.sock.groupMetadata(jid);
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

    _historyMessageToRecord(session, msg, key) {
      session = this._sess(session);
      const content = msg.message || {};
      const text =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        '';
      const mediaType = classifyMessageType(content);
      if (!hasRecognizedContent(content) && !text) return null;
      const ts = messageTimestampMs(msg.messageTimestamp);
      const timestampSeconds = Number(msg.messageTimestamp);
      return {
        id: ts,
        timestamp_s: Number.isFinite(timestampSeconds) && timestampSeconds > 0 ? timestampSeconds : null,
        conversation_id: key,
        direction: msg.key?.fromMe ? 'OUTBOUND' : 'INBOUND',
        message_type: mediaType || 'TEXT',
        status: msg.key?.fromMe ? 'SENT' : 'RECEIVED',
        body: text || '',
        media_id: null,
        media_mime_type: null,
        media_filename: content.documentMessage?.fileName || null,
        media_caption: text || null,
        wa_message_id: msg.key?.id || null,
        sender_phone: msg.key?.fromMe ? 'ME' : (jidToPhone(msg.key?.participant || key) || key),
        recipient_phone: msg.key?.fromMe ? (jidToPhone(key) || key) : 'ME',
        sender_name: msg.key?.fromMe ? 'ME' : (this._resolveDisplayName(session, msg.key?.participant || key, msg.pushName) || null),
        participant_jid: msg.key?.participant || null,
        participant_name: msg.key?.participant ? this._resolveDisplayName(session, msg.key.participant, msg.pushName) : null,
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
            rememberLidPair(live.store, lid, phoneJid);
            void lidRepository.persistLidMappingToDb(live.id, lid, phoneJid);
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
