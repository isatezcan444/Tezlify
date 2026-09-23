/**
 * WhatsApp Baileys Socket Event Listeners.
 *
 * Encapsulates all Baileys socket event bindings: creds, connection transitions,
 * messages, contacts, chats, history sync, and acks.
 */
import QRCode from 'qrcode';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { performance } from 'perf_hooks';
import { diagnostic, sessionRef, latency } from '../observability.js';
import {
  isLidJid,
  isBroadcastOnlyJid,
  isDegenerateJid,
  isRawIdentityName,
  isPhoneLikeName,
  contactPhoneJid,
  jidToPhone,
  mergeContactName,
  resolveJidKey,
  rememberLidPair,
} from '../utils/whatsapp-identity.js';
import {
  normalizePreviewText,
  buildChatPreview,
  resolveSyncState,
} from '../utils/whatsapp-formatting.js';
import { summarizeWaMessage } from '../messages/message-classifier.js';
import { createSessionStore, messageTimestampMs, rememberRawMessage } from '../messages/message-store.js';
import { safeWriteEncrypted } from './socket-connector.js';

export function bindSocketEvents({
  id,
  session,
  generation,
  sock,
  state,
  saveCreds,
  connectStarted,
  sessionDir,
  manager,
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
  armLeaseRenewal,
}) {
  const store = manager._storeOf(session);
  const { contacts, chats, messagesByChat } = store;
  const normalizeJid = (jid) => resolveJidKey(store, jid);
  const rememberRaw = (jid, msgId, message) => rememberRawMessage(store, jid, msgId, message);
  const applyLidMapping = (lid, phoneJid) => manager._applyLidMapping(session, lid, phoneJid);
  const resolveDisplayName = (jid, pushName) => manager._resolveDisplayName(session, jid, pushName);
  const historyMessageToRecord = (msg, key) => manager._historyMessageToRecord(session, msg, key);
  const ensureChatAvatar = (key) => manager._ensureChatAvatar(session, key);
  const ensureGroupSubjects = (opts = {}) => manager._ensureGroupSubjects({ ...opts, sessionId: id });

  const emitEvent = (event) => manager._emit({ gateway_session_id: id, ...event });

  const ignoreStaleSocketEvent = (eventName) => {
    if (session.lifecycle.isCurrent(generation, sock)) return false;
    diagnostic('stale_socket_event_ignored', {
      session_ref: sessionRef(id),
      generation,
      current_generation: session.lifecycle.generation,
      event_name: eventName,
    });
    return true;
  };

  const HISTORY_QUIET_PERIOD_MS = 3000;
  const HISTORY_NO_CHUNK_FALLBACK_MS = 45000;

  const finalizeHistorySync = (reason) => {
    if (!sessions.get(id)) return;
    if (!session.sync || session.sync.phase !== 'syncing') return;
    if (session._historyQuietTimer) {
      clearTimeout(session._historyQuietTimer);
      session._historyQuietTimer = null;
    }
    session.sync = {
      ...session.sync,
      phase: 'ready',
      progress: 100,
      completed_at: session.sync.completed_at || new Date().toISOString(),
    };
    logger.info({ id, reason, chats: session.sync.chats_synced, msgs: session.sync.messages_synced }, 'History sync finalized');
    emitEvent({ event: 'session_sync_completed', session_id: id, session_name: session.session_name, sync: session.sync });
    void ensureGroupSubjects({ force: true });
    manager._scheduleBackgroundAvatarFetch(session);
  };

  // --- QR event ---
  sock.ev.on('creds.update', async () => {
    if (!session.lifecycle.isCurrent(generation, sock)) return;
    session._diagnosticAuthUpdates = (session._diagnosticAuthUpdates || 0) + 1;
    try {
      await saveCreds();
    } catch (err) {
      diagnostic('auth_state_write_failed', {
        session_ref: sessionRef(id),
        generation,
        error_name: err?.name || 'Error',
        error_code: err?.code || null,
      });
      logger.error({ err, session_ref: sessionRef(id), generation }, 'Baileys auth state write failed');
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    if (!session.lifecycle.isCurrent(generation, sock)) {
      if (connection) {
        diagnostic('stale_socket_transition_ignored', {
          session_ref: sessionRef(id),
          generation,
          current_generation: session.lifecycle.generation,
          connection,
          status_code: statusCode ?? null,
        });
      }
      return;
    }
    if (connection) {
      diagnostic('socket_connection_transition', {
        session_ref: sessionRef(id),
        generation,
        connection,
        status_code: statusCode ?? null,
        is_current_socket: session.sock === sock,
        auth_updates: session._diagnosticAuthUpdates || 0,
      });
    }
    if (qr) {
      latency('socket_start_to_provider_qr_ms', connectStarted, id);
      session.status = 'SCAN_QR';
      session.error_message = null;
      session.error_reason = null;
      session._connFailures = 0;
      session._qrSeenForAttempt = true;
      const qrStarted = performance.now();
      session.qr_code = await QRCode.toDataURL(qr);
      latency('qr_generation_ms', qrStarted, id);
      session.updated_at = new Date().toISOString();
      emitEvent({ event: 'session_qr_updated', session_id: id, qr_code: session.qr_code });

      if (session._pairingPhone && session._pairingSocket !== sock) {
        const PAIRING_TTL_MS = 10 * 60 * 1000;
        if (Date.now() - (session._pairingRequestedAt || 0) > PAIRING_TTL_MS) {
          session._pairingPhone = null;
          session._pairingSocket = null;
        } else {
          try {
            const freshCode = await sock.requestPairingCode(session._pairingPhone);
            session._pairingSocket = sock;
            session.updated_at = new Date().toISOString();
            logger.warn({ session_ref: sessionRef(id) }, 'Pairing code re-issued after socket restart');
            emitEvent({
              event: 'session_pairing_code_updated',
              session_id: id,
              pairing_code: freshCode,
              phone: session.phone_number || null,
            });
          } catch (err) {
            logger.warn({ err, id }, 'Pairing code re-issue failed');
            emitEvent({
              event: 'session_pairing_code_updated',
              session_id: id,
              error: String(err?.message || err),
            });
          }
        }
      }
    }
    if (connection === 'connecting') {
      session.status = 'CONNECTING';
      emitEvent({ event: 'session_connecting', session_id: id, session_name: session.session_name });
    }
    if (connection === 'open') {
      latency('socket_start_to_ready_ms', connectStarted, id);
      // Phase 1 §6 (Defect 3): `session.status = 'CONNECTED'` MUST be written
      // AFTER every `await` on this code path. The previous code set the
      // status synchronously and then awaited `authRepository.registerSession`
      // and `leaseRepository.acquire`; an error on either path would either
      // revert the status to FAILED after a window in which it briefly read
      // CONNECTED, or (worse) emit `session_connected` after a failure path
      // intended to return early. The fix is: compute self-identity and
      // ephemeral-promotion prerequisites in a local context, attempt every
      // side-effecting await, and ONLY THEN commit the visible state.
      const meJid = sock.user?.id || state?.creds?.me?.id;
      const meLid = sock.user?.lid || state?.creds?.me?.lid;
      const selfJid = meJid ? resolveJidKey(store, meJid) : null;
      const selfLid = meLid ? resolveJidKey(store, meLid) : null;
      const selfPhone = selfJid ? (jidToPhone(selfJid) || session.phone_number) : session.phone_number;

      // Phase 1 §15: a late `connection.open` arriving on a session that was
      // already deleted, refreshed, or logged-out must NOT commit visible
      // state. The lifecycle guard at the top of this handler already filters
      // stale-socket events; we additionally refuse to commit when the
      // session is gone or the lifecycle generation has been invalidated.
      if (!sessions.has(id) || (sessions.get(id) && sessions.get(id)._deleted)) {
        diagnostic('open_ignored_session_deleted', { session_ref: sessionRef(id), generation });
        return;
      }
      if (!session.lifecycle.isCurrent(generation, sock)) {
        diagnostic('open_ignored_lifecycle_not_current', {
          session_ref: sessionRef(id),
          generation,
          current_generation: session.lifecycle.generation,
        });
        return;
      }

      // Ephemeral-session promotion side-effects MUST happen BEFORE we commit
      // status. Each branch below either commits to the next step or returns
      // WITHOUT touching the session-visible state.
      if (session.ephemeral) {
        if (authRepository) {
          try {
            await authRepository.registerSession(id, session.session_name, { active: true });
            if (state?.creds) {
              await authRepository.saveCredentials(id, state.creds);
            }
          } catch (authErr) {
            logger.error({ err: authErr?.message, session_ref: sessionRef(id) }, 'Failed to persist durable auth credentials during promotion');
            session.status = 'FAILED';
            session.error_message = 'Failed to persist session auth credentials';
            if (sock) sock.end(new Error('Auth persistence failed'));
            emitEvent({ event: 'connection_error', session_id: id, error: session.error_message });
            return;
          }
        }
        if (leaseRepository) {
          try {
            const acquired = await leaseRepository.acquire(id, instanceId, generation);
            if (!acquired) {
              logger.warn({ session_ref: sessionRef(id) }, 'Failed to acquire lease during promotion; another instance holds the lease');
              session.status = 'FAILED';
              session.error_message = 'Session lease could not be acquired (held by another instance)';
              if (sock) sock.end(new Error('Session lease conflict'));
              emitEvent({ event: 'connection_error', session_id: id, error: session.error_message });
              return;
            }
            session._leaseValidUntil = Date.now() + leaseRepository.ttlSeconds * 1000;
            if (typeof armLeaseRenewal === 'function') armLeaseRenewal();
          } catch (leaseErr) {
            logger.error({ err: leaseErr?.message, session_ref: sessionRef(id) }, 'Lease acquisition error during promotion');
            session.status = 'FAILED';
            session.error_message = 'Lease acquisition error';
            if (sock) sock.end(new Error('Lease acquisition error'));
            emitEvent({ event: 'connection_error', session_id: id, error: session.error_message });
            return;
          }
        }
        session.ephemeral = false;
      }

      if (!authRepository) {
        safeWriteEncrypted(sessionDir + '/auth.json', { creds: state.creds, keys: state.keys }, aesKey);
        diagnostic('legacy_auth_snapshot_written', {
          session_ref: sessionRef(id),
          generation,
          auth_updates: session._diagnosticAuthUpdates || 0,
          keys_value_type: typeof state.keys,
        });
      }

      // Re-validate the session after every await above: a `deleteSession` /
      // `logoutSession` / `refreshQr` that landed during the awaits MUST
      // short-circuit before we commit the visible state.
      if (!sessions.has(id) || (sessions.get(id) && sessions.get(id)._deleted)) {
        diagnostic('open_committed_aborted_session_deleted', { session_ref: sessionRef(id), generation });
        return;
      }
      if (!session.lifecycle.isCurrent(generation, sock)) {
        diagnostic('open_committed_aborted_lifecycle_not_current', {
          session_ref: sessionRef(id),
          generation,
          current_generation: session.lifecycle.generation,
        });
        return;
      }

      // Commit visible state — all in one synchronous block. After this point
      // the backend's `_map_session_event` is allowed to promote.
      session.status = 'CONNECTED';
      session.qr_code = null;
      session.error_message = null;
      session.error_reason = null;
      session._connFailures = 0;
      session._pairingPhone = null;
      session._pairingRequestedAt = 0;
      session._pairingSocket = null;
      session.is_phone_online = true;
      session.updated_at = new Date().toISOString();
      if (selfJid) {
        session.self_jid = selfJid;
        session.phone_number = selfPhone;
      }
      if (selfLid) {
        session.self_lid = selfLid;
      }
      if (session.self_lid && session.self_jid) {
        rememberLidPair(store, session.self_lid, session.self_jid);
        manager._applyLidMapping(session, session.self_lid, session.self_jid);
      }
      emitEvent({
        event: 'session_connected',
        session_id: id,
        session_name: session.session_name,
        phone: session.phone_number || null,
        self_jid: session.self_jid || null,
        self_lid: session.self_lid || null,
      });

      const priorSyncs = Number(state?.creds?.accountSyncCounter || 0);
      session.sync = priorSyncs > 0
        ? { phase: 'ready', progress: 100, chats_synced: 0, contacts_synced: 0, messages_synced: 0, started_at: new Date().toISOString(), completed_at: new Date().toISOString() }
        : { phase: 'syncing', progress: 0, chats_synced: 0, contacts_synced: 0, messages_synced: 0, started_at: new Date().toISOString(), completed_at: null };
      if (priorSyncs > 0) {
        emitEvent({ event: 'session_sync_completed', session_id: id, session_name: session.session_name, sync: session.sync });
        void ensureGroupSubjects();
        manager._scheduleBackgroundAvatarFetch(session);
      } else {
        emitEvent({ event: 'session_sync_started', session_id: id, session_name: session.session_name, sync: session.sync });
        if (session._historyQuietTimer) clearTimeout(session._historyQuietTimer);
        session._historyQuietTimer = setTimeout(() => {
          finalizeHistorySync('no_history_chunks_received');
        }, HISTORY_NO_CHUNK_FALLBACK_MS);
      }
    }
    if (connection === 'close') {
      if (session._historyQuietTimer) {
        clearTimeout(session._historyQuietTimer);
        session._historyQuietTimer = null;
      }
      if (session.sync && session.sync.phase !== 'ready') {
        session.sync = { phase: 'idle' };
      }
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isBanned = statusCode === DisconnectReason.badSession;
      if (statusCode === DisconnectReason.restartRequired) {
        session.status = 'CONNECTING';
        session.is_phone_online = false;
        session.updated_at = new Date().toISOString();
        logger.info({ id }, 'Baileys restartRequired (515) — soket hemen yeniden kuruluyor');
        const scheduled = session.lifecycle.scheduleReconnect(
          generation, sock, 500, () => manager._startSocket(id),
        );
        if (scheduled) diagnostic('socket_reconnect_scheduled', {
          session_ref: sessionRef(id), generation,
          reason: 'restart_required', delay_ms: 500,
        });
        return;
      }
      if (isLoggedOut || isBanned) {
        session.status = isBanned ? 'BANNED' : 'DISCONNECTED';
        session.is_active = false;
        session.is_phone_online = false;
        session.error_message = isBanned
          ? 'WhatsApp bu oturumu engelledi (badSession). Oturumu silip yeniden QR ile bağlanın.'
          : null;
        session.error_reason = isBanned ? 'BANNED' : 'LOGGED_OUT';
        session.updated_at = new Date().toISOString();
        await leaseCoordinator.releaseLease(session);
        await deactivatePersistentSession(id);
        session.store = createSessionStore();
        mediaStore.clearSessionMedia(id);
        clearSessionHistoryFetches(id);
        resetRetryCounterCache(id);
        emitEvent({ event: 'session_disconnected', session_id: id, session_name: session.session_name, reason: isBanned ? 'BANNED' : 'LOGGED_OUT' });
      } else {
        session._connFailures = (session._connFailures || 0) + 1;
        const sawQrThisAttempt = session._qrSeenForAttempt;
        session._qrSeenForAttempt = false;
        const maxAttempts = 3;
        const isPairing = !session._isRegistered && !session.phone_number;
        if (isPairing && !sawQrThisAttempt && session._connFailures >= maxAttempts) {
          session.status = 'DISCONNECTED';
          session.is_active = false;
          session.is_phone_online = false;
          session.qr_code = null;
          session.error_reason = 'WA_CONNECTION_TERMINATED';
          session.error_message =
            `WhatsApp sunucusu QR kodu oluşturulmadan bağlantıyı kapattı ` +
            `(statusCode=${statusCode ?? 'bilinmiyor'}, ${session._connFailures} deneme). ` +
            `Bu geçici bir WhatsApp reddi olabilir; birkaç dakika sonra ` +
            `"QR'ı Yenile" ile tekrar deneyin.`;
          session.updated_at = new Date().toISOString();
          logger.error({ statusCode, failures: session._connFailures }, 'Baileys kept being terminated before QR — surfacing error');
          emitEvent({
            event: 'connection_error',
            session_id: id,
            session_name: session.session_name,
            error: session.error_message,
            error_message: session.error_message,
          });
          return;
        }
        session.status = 'CONNECTING';
        session.is_phone_online = false;
        session.updated_at = new Date().toISOString();
        const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(session._connFailures - 1, 5)));
        const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(delayMs * 0.2)));
        const scheduled = session.lifecycle.scheduleReconnect(
          generation, sock, delayMs + jitterMs, () => manager._startSocket(id),
        );
        if (scheduled) diagnostic('socket_reconnect_scheduled', {
          session_ref: sessionRef(id), generation,
          reason: 'transient_disconnect', delay_ms: delayMs + jitterMs,
          status_code: statusCode ?? null, failure_count: session._connFailures,
        });
      }
    }
  });

  // --- Messages (inbound + phone-sent outbound) ---
  sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
    if (ignoreStaleSocketEvent('messages.upsert')) return;
    for (const msg of newMessages || []) {
      if (ignoreStaleSocketEvent('messages.upsert')) return;
      try {
        await manager._ingestUpsertMessage(msg, sock, id);
      } catch (err) {
        diagnostic('message_upsert_failed', {
          session_ref: sessionRef(id),
          upsert_type: type || null,
          message_id_present: Boolean(msg?.key?.id),
          group_message: Boolean(msg?.key?.remoteJid?.includes('@g.us')),
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
        logger.warn({
          err,
          session_ref: sessionRef(id),
          message_id: msg?.key?.id || null,
        }, 'messages.upsert item failed');
      }
    }
  });

  // --- Contacts sync ---
  sock.ev.on('contacts.update', (updates) => {
    if (ignoreStaleSocketEvent('contacts.update')) return;
    manager._ingestContactUpdates(session, updates);
  });

  // --- Address book (W:Contact app-state) ---
  sock.ev.on('contacts.upsert', (list) => {
    if (ignoreStaleSocketEvent('contacts.upsert')) return;
    for (const c of list || []) {
      const rawId = c?.id;
      if (!rawId || !c.name) continue;
      if (isBroadcastOnlyJid(rawId)) continue;
      if (isDegenerateJid(rawId)) continue;
      const phoneJid = contactPhoneJid(c);
      if (c.lid && !isLidJid(rawId)) applyLidMapping(c.lid, rawId);
      if (phoneJid && isLidJid(rawId)) applyLidMapping(rawId, phoneJid);
      const jid = normalizeJid(rawId);
      if (isBroadcastOnlyJid(jid)) continue;
      const now = new Date().toISOString();
      if (isLidJid(jid)) {
        const merged = mergeContactName(contacts.get(jid) || {}, c.name, 'addressbook');
        contacts.set(jid, {
          ...merged,
          id: jid,
          jid,
          name: merged.name,
          phone: '',
          lid_pending: true,
          updated_at: now,
        });
        continue;
      }
      const merged = mergeContactName(contacts.get(jid) || {}, c.name, 'addressbook');
      contacts.set(jid, {
        ...merged,
        id: jid,
        jid,
        name: merged.name,
        phone: jidToPhone(jid) || merged.phone || '',
        avatar_url: merged.avatar_url || null,
        updated_at: now,
      });
      emitEvent({ event: 'contact_synced', contact: contacts.get(jid) });
      const chatKey = normalizeJid(jid);
      const chat = chats.get(chatKey);
      if (chat && chat.name !== merged.name && merged.name_source === 'addressbook') {
        chat.name = merged.name;
        chat.name_source = 'addressbook';
        chat.updated_at = now;
        emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
      }
    }
  });

  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
    if (ignoreStaleSocketEvent('chats.phoneNumberShare')) return;
    if (lid && jid) applyLidMapping(lid, jid);
  });

  // --- Chats sync ---
  sock.ev.on('chats.update', (updates) => {
    if (ignoreStaleSocketEvent('chats.update')) return;
    for (const update of updates) {
      const jid = update.id;
      if (!jid) continue;
      if (isBroadcastOnlyJid(jid)) continue;
      if (isDegenerateJid(jid)) continue;
      const key = normalizeJid(jid);
      if (isBroadcastOnlyJid(key)) continue;
      const lidHold = isLidJid(key);
      const existing = chats.get(key) || {};
      const contact = contacts.get(key);
      const updTs = update.lastMessage?.messageTimestamp
        ? new Date(messageTimestampMs(update.lastMessage.messageTimestamp)).toISOString()
        : null;
      const updPreview = update.lastMessage
        ? (() => {
            const s = summarizeWaMessage(update.lastMessage);
            const base = normalizePreviewText(s.message_type, s.body);
            if (!base) return null;
            if (key.includes('@g.us') && !update.lastMessage.key?.fromMe) {
              const pname = resolveDisplayName(update.lastMessage.key?.participant, update.lastMessage.pushName);
              if (pname && !isRawIdentityName(pname) && !isPhoneLikeName(pname) && pname.toUpperCase() !== 'ME') {
                return `${pname}: ${base}`;
              }
            }
            return base;
          })()
        : null;
      const tsOlder = updTs && existing.last_message_at && String(updTs) < String(existing.last_message_at);
      if (update.lastMessage?.key?.id) {
        try {
          const list = messagesByChat.get(key) || [];
          const known = list.some((m) => m.wa_message_id && m.wa_message_id === update.lastMessage.key.id);
          if (!known) {
            const synth = historyMessageToRecord(update.lastMessage, key);
            if (synth) {
              const next = [...list, synth];
              if (next.length > 2000) next.splice(0, next.length - 2000);
              messagesByChat.set(key, next);
              emitEvent({ event: 'message_new', conversation_id: key, message: synth });
            }
          }
        } catch (err) {
          logger.warn({ err }, 'chats.update lastMessage sentezlenemedi');
        }
      }
      chats.set(key, {
        ...existing,
        id: key,
        jid: key,
        name: contact?.name || existing.name || (lidHold ? '' : jidToPhone(key) || key),
        name_source: contact?.name_source || existing.name_source || null,
        phone: jidToPhone(key) || existing.phone || '',
        is_group: key.includes('@g.us'),
        archived: update.archived ?? existing.archived ?? false,
        last_message_at: updTs && !tsOlder ? updTs : existing.last_message_at,
        last_message_preview: updPreview && !tsOlder ? updPreview : existing.last_message_preview || '',
        unread_count: update.unreadCount ?? existing.unread_count ?? 0,
        created_at: existing.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (!chats.get(key)?.avatar_url) void ensureChatAvatar(key);
      emitEvent({ event: 'conversation_updated', conversation: chats.get(key) });
    }
  });

  // --- History sync ---
  sock.ev.on('messaging-history.set', async ({ chats: historyChats, contacts: historyContacts, messages: historyMessages, progress, isLatest, phoneNumberToLidMappings, lidPnMappings }) => {
    if (ignoreStaleSocketEvent('messaging-history.set')) return;
    try {
      const rawMappings = [
        ...(Array.isArray(lidPnMappings) ? lidPnMappings : []),
        ...(Array.isArray(phoneNumberToLidMappings) ? phoneNumberToLidMappings : []),
      ];
      for (const m of rawMappings) {
        const lid = m?.lid || m?.lidJid;
        const pn = m?.pn || m?.pnJid;
        if (lid && pn) applyLidMapping(lid, pn);
      }
      for (const c of historyContacts || []) {
        if (!c?.id) continue;
        if (isBroadcastOnlyJid(c.id)) continue;
        if (isDegenerateJid(c.id)) continue;
        const phoneJid = contactPhoneJid(c);
        if (c.lid && !isLidJid(c.id)) applyLidMapping(c.lid, c.id);
        if (phoneJid && isLidJid(c.id)) applyLidMapping(c.id, phoneJid);
        if (isLidJid(c.id)) continue;
        let merged = contacts.get(c.id) || {};
        if (c.name) merged = mergeContactName(merged, c.name, 'history');
        if (c.notify) merged = mergeContactName(merged, c.notify, 'push');
        if (c.verifiedName) merged = mergeContactName(merged, c.verifiedName, 'verified');
        contacts.set(c.id, {
          ...merged,
          id: c.id,
          jid: c.id,
          name: merged.name || jidToPhone(c.id) || c.id,
          phone: jidToPhone(c.id) || merged.phone || '',
          avatar_url: c.imgUrl || merged.avatar_url || null,
          updated_at: new Date().toISOString(),
        });
      }
      let storedMessages = 0;
      for (const msg of historyMessages || []) {
        const jid = msg.key?.remoteJid;
        if (!jid || msg.key?.id === '__history__') continue;
        if (isBroadcastOnlyJid(jid)) continue;
        if (msg.key?.senderLid && msg.key?.senderPn) applyLidMapping(msg.key.senderLid, msg.key.senderPn);
        if (msg.message?.protocolMessage) continue;
        const key = normalizeJid(jid);
        if (isBroadcastOnlyJid(key)) continue;
        if (msg.key.id && msg.message) rememberRaw(key, msg.key.id, msg.message);
        const list = messagesByChat.get(key) || [];
        if (msg.key.id && list.some((m) => m.wa_message_id === msg.key.id)) continue;
        const record = historyMessageToRecord(msg, key);
        if (!record) continue;
        list.push(record);
        list.sort((a, b) => (a.id || 0) - (b.id || 0));
        if (list.length > 2000) list.splice(0, list.length - 2000);
        messagesByChat.set(key, list);
        storedMessages += 1;
      }
      for (const [flightKey, waiter] of pendingHistoryWaiters.entries()) {
        if (waiter.sessionId === session.id) {
          const chatMsgs = messagesByChat.get(waiter.key) || [];
          const matching = waiter.before ? chatMsgs.filter((m) => m.id < waiter.before) : chatMsgs;
          waiter.resolve(matching);
          pendingHistoryWaiters.delete(flightKey);
          inFlightHistoryFetches.delete(flightKey);
        }
      }
      let storedChats = 0;
      for (const chat of historyChats || []) {
        const jid = chat.id || chat.jid;
        if (!jid) continue;
        if (isBroadcastOnlyJid(jid)) continue;
        if (isDegenerateJid(jid)) continue;
        if (chat.lidJid && !isLidJid(jid)) applyLidMapping(chat.lidJid, jid);
        if (isLidJid(jid) && chat.pnJid) applyLidMapping(jid, chat.pnJid);
        const key = normalizeJid(jid);
        if (isBroadcastOnlyJid(key)) continue;
        const contact = contacts.get(key);
        const list = messagesByChat.get(key) || [];
        const newest = list.reduce(
          (acc, m) => (acc && Number(acc.id) >= Number(m.id) ? acc : m),
          null,
        );
        const timestampSeconds = Number(chat.lastMessageRecvTimestamp || newest?.timestamp_s);
        const ts = Number.isFinite(timestampSeconds) && timestampSeconds > 0
          ? timestampSeconds
          : null;
        const existing = chats.get(key) || {};
        const merged = {
          ...existing,
          id: key,
          jid: key,
          name: contact?.name || chat.name || existing.name || jidToPhone(key) || key,
          name_source: contact?.name_source || existing.name_source || null,
          phone: jidToPhone(key) || existing.phone || '',
          is_group: key.includes('@g.us'),
          archived: chat.archived ?? existing.archived ?? false,
          avatar_url: chat.avatar_url || contact?.avatar_url || existing.avatar_url || null,
          last_message_at: ts ? new Date(messageTimestampMs(ts)).toISOString() : (newest?.created_at || existing.last_message_at),
          last_message_preview:
            (newest ? buildChatPreview(newest, key.includes('@g.us')) : '') ||
            existing.last_message_preview ||
            '',
          unread_count: chat.unreadCount ?? existing.unread_count ?? 0,
          created_at: existing.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        chats.set(key, merged);
        storedChats += 1;
        if (!merged.avatar_url && storedChats <= 5) void ensureChatAvatar(key);
        emitEvent({ event: 'conversation_updated', conversation: merged });
      }
      const cachedMessages = [...messagesByChat.values()].reduce((n, l) => n + l.length, 0);
      emitEvent({
        event: 'history_sync_completed',
        progress: progress ?? null,
        is_latest: !!isLatest,
        chats_synced: storedChats,
        messages_synced: storedMessages,
        chats_unique: chats.size,
        contacts_unique: contacts.size,
        messages_cached: cachedMessages,
      });
      if (isLatest || progress === 100) {
        manager._scheduleBackgroundAvatarFetch(session);
      }
      if (session.sync) {
        const { next, justCompleted } = resolveSyncState(session.sync, { progress, isLatest });
        next.chats_synced = (session.sync.chats_synced || 0) + storedChats;
        next.messages_synced = (session.sync.messages_synced || 0) + storedMessages;
        next.contacts_synced = contacts.size;
        next.chats_unique = chats.size;
        next.contacts_unique = contacts.size;
        next.messages_cached = cachedMessages;
        session.sync = next;
        emitEvent({ event: 'session_sync_progress', session_id: id, session_name: session.session_name, sync: session.sync });
        if (justCompleted) {
          if (session._historyQuietTimer) {
            clearTimeout(session._historyQuietTimer);
            session._historyQuietTimer = null;
          }
          emitEvent({ event: 'session_sync_completed', session_id: id, session_name: session.session_name, sync: session.sync });
          void ensureGroupSubjects({ force: true });
        } else if (session.sync.phase === 'syncing') {
          if (session._historyQuietTimer) clearTimeout(session._historyQuietTimer);
          session._historyQuietTimer = setTimeout(() => {
            if (session.sync && session.sync.phase === 'syncing') {
              finalizeHistorySync('quiet_period_after_last_chunk');
            }
          }, HISTORY_QUIET_PERIOD_MS);
        }
      }
      logger.info({ storedChats, storedMessages, progress, isLatest }, 'History sync ingested');
    } catch (err) {
      logger.warn({ err }, 'History sync ingestion failed');
    }
  });

  // --- Groups ---
  sock.ev.on('groups.update', (updates) => {
    if (ignoreStaleSocketEvent('groups.update')) return;
    for (const update of updates || []) {
      const jid = update?.id;
      const subject = typeof update?.subject === 'string' ? update.subject.trim() : '';
      if (!jid || !jid.includes('@g.us') || !subject) continue;
      const key = normalizeJid(jid);
      const chat = chats.get(key);
      if (chat) {
        const merged = mergeContactName({ name: chat.name, name_source: chat.name_source }, subject, 'group_subject');
        if (merged.name && merged.name !== chat.name) {
          chat.name = merged.name;
          chat.name_source = merged.name_source;
          chat.updated_at = new Date().toISOString();
          emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
        }
      }
      const contact = contacts.get(key);
      if (contact) {
        const mergedC = mergeContactName({ name: contact.name, name_source: contact.name_source }, subject, 'group_subject');
        if (mergedC.name && mergedC.name !== contact.name) {
          contact.name = mergedC.name;
          contact.name_source = mergedC.name_source;
          contact.updated_at = new Date().toISOString();
          emitEvent({ event: 'contact_synced', contact: { ...contact } });
        }
      }
    }
  });

  // --- Presence ---
  sock.ev.on('presence.update', ({ id: presenceId, presences }) => {
    if (ignoreStaleSocketEvent('presence.update')) return;
    const key = normalizeJid(presenceId);
    const chat = chats.get(key);
    if (chat) {
      chat.presence = presences?.[0]?.presence || null;
      emitEvent({ event: 'presence_updated', conversation_id: key, presence: chat.presence });
    }
  });

  // --- Message acks ---
  sock.ev.on('messages.update', (updates) => {
    if (ignoreStaleSocketEvent('messages.update')) return;
    for (const { key, update } of updates || []) {
      manager._applyMessageAck(id, key, update);
    }
  });
}
