/**
 * Session Manager - Baileys WhatsApp Web session lifecycle.

 * Handles:
 * - Session creation with QR pairing (multi-device)
 * - Session persistence (encrypted auth state on disk)
 * - Contact / chat / message sync into in-memory stores
 * - Text & media message sending
 * - Media download & storage
 * - Realtime event emission to the event bridge
 */
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// ---------------------------------------------------------------------------
// In-memory stores (single source of truth for the gateway process)
// ---------------------------------------------------------------------------
const sessions = new Map(); // id -> session record
const contacts = new Map(); // jid -> contact
const chats = new Map(); // jid -> chat summary
const messagesByChat = new Map(); // jid -> Message[]
const mediaIndex = new Map(); // media_id -> { filePath, mimeType, filename, sizeBytes }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function encryptBuffer(buf, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

function decryptBuffer(buf, key) {
  const iv = buf.subarray(0, 16);
  const encrypted = buf.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function safeWriteEncrypted(filePath, data, key) {
  const encrypted = encryptBuffer(Buffer.from(JSON.stringify(data)), key);
  fs.writeFileSync(filePath, encrypted);
}

function safeReadEncrypted(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const encrypted = fs.readFileSync(filePath);
    const decrypted = decryptBuffer(encrypted, key);
    return JSON.parse(decrypted.toString('utf-8'));
  } catch (err) {
    logger.warn({ err }, 'Failed to decrypt session file, ignoring');
    return null;
  }
}

function jidToPhone(jid) {
  if (!jid) return null;
  const match = jid.match(/^(\d+)@/);
  return match ? `+${match[1]}` : null;
}

function normalizeJid(jid) {
  if (!jid) return jid;
  if (jid.includes('@g.us')) return jid; // group
  if (jid.includes('@s.whatsapp.net')) return jid;
  if (jid.includes('@')) return jid;
  return `${jid}@s.whatsapp.net`;
}

function getSessionDir(sessionsDir, sessionId) {
  return path.join(sessionsDir, sessionId);
}

// ---------------------------------------------------------------------------
// Session Manager factory
// ---------------------------------------------------------------------------
export function createSessionManager({ sessionsDir, mediaDir, aesKey, backendWsUrl }) {
  const sessionManager = {
    _listeners: new Set(),
    _emit(event) {
      for (const listener of this._listeners) {
        try { listener(event); } catch (err) { logger.warn({ err }, 'Event listener error'); }
      }
    },
    onEvent(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
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
        is_active: s.is_active,
        is_phone_online: s.is_phone_online || false,
        battery_level: s.battery_level ?? null,
        error_message: s.error_message || null,
        qr_code: s.status === 'SCAN_QR' ? s.qr_code : null,
        created_at: s.created_at,
        updated_at: s.updated_at,
      }));
    },

    getSession(id) {
      return sessions.get(id) || null;
    },

    async createSession(name) {
      const id = uuidv4();
      const session = {
        id,
        session_name: name,
        status: 'SCAN_QR',
        qr_code: null,
        phone_number: null,
        is_active: true,
        is_phone_online: false,
        battery_level: null,
        error_message: null,
        error_reason: null,
        _connFailures: 0,
        _qrSeenForAttempt: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sock: null,
      };
      sessions.set(id, session);
      this._startSocket(id);
      return this.getSession(id);
    },

    async refreshQr(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      if (session.status === 'CONNECTED') return this.getSession(id);
      session.status = 'SCAN_QR';
      session.qr_code = null;
      session.error_message = null;
      session.error_reason = null;
      session._connFailures = 0;
      session._qrSeenForAttempt = false;
      session.updated_at = new Date().toISOString();
      // Force a fresh QR by restarting the socket
      if (session.sock) {
        try { session.sock.end(undefined); } catch (err) { /* ignore */ }
        session.sock = null;
      }
      this._startSocket(id);
      return this.getSession(id);
    },

    async logoutSession(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      try {
        if (session.sock) {
          await session.sock.logout();
          session.sock.end(undefined);
        }
      } catch (err) {
        logger.warn({ err }, 'Logout error');
      }
      session.status = 'DISCONNECTED';
      session.is_active = false;
      session.is_phone_online = false;
      session.updated_at = new Date().toISOString();
      // Remove persisted auth state
      const dir = getSessionDir(sessionsDir, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      emitEvent({ event: 'session_disconnected', session_id: id, session_name: session.session_name });
      return this.getSession(id);
    },

    async deleteSession(id) {
      const session = sessions.get(id);
      if (session?.sock) {
        try { session.sock.end(undefined); } catch (err) { /* ignore */ }
      }
      sessions.delete(id);
      const dir = getSessionDir(sessionsDir, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      emitEvent({ event: 'session_deleted', session_id: id });
    },

    // -----------------------------------------------------------------------
    // Contacts
    // -----------------------------------------------------------------------
    listContacts() {
      return [...contacts.values()].map((c) => ({ ...c }));
    },

    // -----------------------------------------------------------------------
    // Conversations
    // -----------------------------------------------------------------------
    listConversations({ search, limit, offset } = {}) {
      let list = [...chats.values()].sort((a, b) => {
        const tA = new Date(a.last_message_at || a.created_at || 0).getTime();
        const tB = new Date(b.last_message_at || b.created_at || 0).getTime();
        return tB - tA;
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
      return { items: list.map((c) => ({ ...c })), total };
    },

    async getMessages(jid, { limit = 50, before } = {}) {
      const key = normalizeJid(jid);
      let list = messagesByChat.get(key) || [];
      if (before) {
        list = list.filter((m) => m.id < before);
      }
      list.sort((a, b) => (a.id || 0) - (b.id || 0));
      return list.slice(-limit);
    },

    // -----------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------
    async sendTextMessage(jid, body, client_message_id) {
      const session = this._getConnectedSession();
      const key = normalizeJid(jid);
      const result = await session.sock.sendMessage(key, { text: body });
      const msg = this._recordOutbound(key, {
        body,
        message_type: 'TEXT',
        client_message_id: client_message_id || `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        wa_message_id: result?.key?.id || null,
        status: 'SENT',
      });
      return msg;
    },

    async sendMediaMessage(jid, { media_type, media_url, caption, filename, client_message_id }) {
      const session = this._getConnectedSession();
      const key = normalizeJid(jid);
      const type = (media_type || 'document').toLowerCase();
      let content;
      if (type === 'image') {
        content = { image: { url: media_url }, caption: caption || '' };
      } else if (type === 'audio') {
        content = { audio: { url: media_url } };
      } else if (type === 'video') {
        content = { video: { url: media_url }, caption: caption || '' };
      } else {
        content = { document: { url: media_url }, filename: filename || 'belge.pdf', caption: caption || '' };
      }
      const result = await session.sock.sendMessage(key, content);
      const msg = this._recordOutbound(key, {
        body: caption || filename || media_url || '',
        message_type: type.toUpperCase(),
        media_url,
        media_filename: filename,
        media_caption: caption,
        client_message_id: client_message_id || `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        wa_message_id: result?.key?.id || null,
        status: 'SENT',
      });
      return msg;
    },

    async markConversationRead(jid) {
      const session = this._getConnectedSession();
      const key = normalizeJid(jid);
      try {
        await session.sock.readMessages([{ remoteJid: key, id: undefined }]);
      } catch (err) {
        logger.warn({ err }, 'Mark read error');
      }
      const chat = chats.get(key);
      if (chat) chat.unread_count = 0;
      emitEvent({ event: 'conversation_read', conversation_id: key, unread_count: 0 });
      return { success: true };
    },

    // -----------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------
    getMediaPath(mediaId) {
      return mediaIndex.get(mediaId)?.filePath || null;
    },

    async storeIncomingMedia(mediaMessage, sock) {
      try {
        const buffer = await downloadMediaMessage(mediaMessage, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        if (!buffer) return null;
        const mediaId = uuidv4();
        const ext = (mediaMessage.mimetype || '').split('/')[1] || 'bin';
        const filename = mediaMessage.fileName || `media_${mediaId}.${ext}`;
        const filePath = path.join(mediaDir, `${mediaId}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        mediaIndex.set(mediaId, {
          filePath,
          mimeType: mediaMessage.mimetype || 'application/octet-stream',
          filename,
          sizeBytes: buffer.length,
        });
        return { media_id: mediaId, mime_type: mediaMessage.mimetype || 'application/octet-stream', filename, size_bytes: buffer.length };
      } catch (err) {
        logger.warn({ err }, 'Failed to store incoming media');
        return null;
      }
    },

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------
    _getConnectedSession() {
      const connected = [...sessions.values()].find((s) => s.status === 'CONNECTED' && s.sock);
      if (!connected) throw new Error('Bagli bir WhatsApp oturumu yok. Lutfen once QR ile eslestirin.');
      return connected;
    },

    _recordOutbound(jid, data) {
      const key = normalizeJid(jid);
      const msg = {
        id: Date.now(),
        conversation_id: key,
        direction: 'OUTBOUND',
        message_type: data.message_type || 'TEXT',
        status: data.status || 'SENT',
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
      messagesByChat.get(key).push(msg);
      this._touchChat(key, msg.body || '', msg.created_at);
      emitEvent({
        event: 'message_new',
        conversation_id: key,
        message: msg,
      });
      return { ...msg };
    },

    _touchChat(jid, preview, timestamp) {
      const key = normalizeJid(jid);
      const existing = chats.get(key) || {};
      const contact = contacts.get(key);
      chats.set(key, {
        ...existing,
        id: key,
        jid: key,
        name: contact?.name || existing.name || jidToPhone(key) || key,
        phone: jidToPhone(key) || existing.phone || '',
        last_message_at: timestamp || new Date().toISOString(),
        last_message_preview: preview || existing.last_message_preview || '',
        unread_count: existing.unread_count || 0,
        created_at: existing.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    },

    _startSocket(id) {
      const session = sessions.get(id);
      if (!session) return;
      this._connectSocket(id);
    },

    async _connectSocket(id) {
      const session = sessions.get(id);
      if (!session) return;
      const sessionDir = getSessionDir(sessionsDir, id);
      fs.mkdirSync(sessionDir, { recursive: true });

      // Load persisted auth state (encrypted on disk)
      const persisted = safeReadEncrypted(path.join(sessionDir, 'auth.json'), aesKey);
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

      // If we have persisted creds, restore them
      if (persisted?.creds) {
        try {
          // Rebuild the auth state from the encrypted snapshot
          const restored = {
            creds: persisted.creds,
            keys: persisted.keys || {},
          };
          // useMultiFileAuthState reads from disk; we write the restored state back
          fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(restored.creds));
          fs.writeFileSync(path.join(sessionDir, 'keys.json'), JSON.stringify(restored.keys));
        } catch (err) {
          logger.warn({ err }, 'Failed to restore session state');
        }
      }

      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        logger,
        browser: Browsers.macOS('Desktop'),
        auth: state,
        markOnlineOnConnect: true,
        // NOT: syncFullHistory: true WhatsApp tarafından statusCode=428 ile
        // bağlantı kırılarak reddediliyor (QR hiç oluşmuyor). Sohbet geçmişi
        // yine de messages.upsert olaylarıyla canlı olarak toplanır.
      });

      session.sock = sock;

      // --- QR event ---
      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          session.status = 'SCAN_QR';
          session.error_message = null;
          session.error_reason = null;
          session._connFailures = 0;
          session._qrSeenForAttempt = true;
          session.qr_code = await QRCode.toDataURL(qr);
          session.updated_at = new Date().toISOString();
          emitEvent({ event: 'session_qr_updated', session_id: id, qr_code: session.qr_code });
        }
        if (connection === 'open') {
          session.status = 'CONNECTED';
          session.qr_code = null;
          session.error_message = null;
          session.error_reason = null;
          session._connFailures = 0;
          session.is_phone_online = true;
          session.updated_at = new Date().toISOString();
          // Persist encrypted auth state
          safeWriteEncrypted(path.join(sessionDir, 'auth.json'), { creds: state.creds, keys: state.keys }, aesKey);
          emitEvent({ event: 'session_connected', session_id: id, session_name: session.session_name, phone: session.phone_number || null });
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const isBanned = statusCode === DisconnectReason.badSession;
          if (isLoggedOut || isBanned) {
            session.status = isBanned ? 'BANNED' : 'DISCONNECTED';
            session.is_active = false;
            session.is_phone_online = false;
            session.error_message = isBanned
              ? 'WhatsApp bu oturumu engelledi (badSession). Oturumu silip yeniden QR ile bağlanın.'
              : null;
            session.error_reason = isBanned ? 'BANNED' : 'LOGGED_OUT';
            session.updated_at = new Date().toISOString();
            emitEvent({ event: 'session_disconnected', session_id: id, session_name: session.session_name, reason: isBanned ? 'BANNED' : 'LOGGED_OUT' });
          } else {
            // Transient disconnect — retry with a bounded number of attempts.
            // If WhatsApp keeps terminating the socket BEFORE ever sending a
            // QR (typical when the host IP is blocked by WhatsApp), fail
            // loudly instead of retrying forever (AGENTS.md truthfulness).
            session._connFailures = (session._connFailures || 0) + 1;
            const sawQrThisAttempt = session._qrSeenForAttempt;
            session._qrSeenForAttempt = false;
            const maxAttempts = 3;
            if (!sawQrThisAttempt && session._connFailures >= maxAttempts) {
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
            setTimeout(() => this._connectSocket(id), 5000);
          }
        }
      });

      // --- Messages (inbound) ---
      sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
        for (const msg of newMessages) {
          if (msg.key?.fromMe) continue; // outbound handled separately
          const jid = msg.key?.remoteJid;
          if (!jid) continue;
          const key = normalizeJid(jid);
          const contact = contacts.get(key);
          const isGroup = jid.includes('@g.us');
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || msg.message?.documentMessage?.caption || '';
          const mediaType = msg.message?.imageMessage ? 'IMAGE' : msg.message?.documentMessage ? 'DOCUMENT' : msg.message?.audioMessage ? 'AUDIO' : msg.message?.videoMessage ? 'VIDEO' : msg.message?.stickerMessage ? 'STICKER' : msg.message?.locationMessage ? 'LOCATION' : msg.message?.contactMessage ? 'CONTACT' : 'TEXT';
          let mediaInfo = null;
          if (mediaType !== 'TEXT' && mediaType !== 'LOCATION' && mediaType !== 'CONTACT') {
            const mediaMessage = msg.message?.imageMessage || msg.message?.documentMessage || msg.message?.audioMessage || msg.message?.videoMessage || msg.message?.stickerMessage;
            mediaInfo = await this.storeIncomingMedia(mediaMessage, sock);
          }
          const record = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            conversation_id: key,
            direction: 'INBOUND',
            message_type: mediaType,
            status: 'RECEIVED',
            body: text || '',
            media_id: mediaInfo?.media_id || null,
            media_mime_type: mediaInfo?.mime_type || null,
            media_filename: mediaInfo?.filename || null,
            media_caption: text || null,
            wa_message_id: msg.key?.id || null,
            sender_phone: jidToPhone(jid) || key,
            recipient_phone: 'ME',
            sender_name: contact?.name || jidToPhone(jid) || key,
            created_at: new Date((msg.messageTimestamp || Date.now()) * 1000).toISOString(),
          };
          if (!messagesByChat.has(key)) messagesByChat.set(key, []);
          messagesByChat.get(key).push(record);
          this._touchChat(key, text || `[${mediaType}]`, record.created_at);
          // Update unread count
          const chat = chats.get(key);
          if (chat) chat.unread_count = (chat.unread_count || 0) + 1;
          emitEvent({
            event: 'message_new',
            conversation_id: key,
            message: record,
          });
        }
      });

      // --- Contacts sync ---
      sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
          const jid = update.id;
          if (!jid) continue;
          const existing = contacts.get(jid) || {};
          contacts.set(jid, {
            id: jid,
            jid,
            name: update.notify || update.name || existing.name || jidToPhone(jid) || jid,
            phone: jidToPhone(jid) || existing.phone || '',
            avatar_url: update.imgUrl || existing.avatar_url || null,
            updated_at: new Date().toISOString(),
          });
          emitEvent({ event: 'contact_synced', contact: contacts.get(jid) });
        }
      });

      // --- Chats sync ---
      sock.ev.on('chats.update', (updates) => {
        for (const update of updates) {
          const jid = update.id;
          if (!jid) continue;
          const key = normalizeJid(jid);
          const existing = chats.get(key) || {};
          const contact = contacts.get(key);
          chats.set(key, {
            ...existing,
            id: key,
            jid: key,
            name: contact?.name || existing.name || jidToPhone(key) || key,
            phone: jidToPhone(key) || existing.phone || '',
            last_message_at: update.lastMessage?.messageTimestamp ? new Date(update.lastMessage.messageTimestamp * 1000).toISOString() : existing.last_message_at,
            last_message_preview: update.lastMessage?.message?.conversation || existing.last_message_preview || '',
            unread_count: update.unreadCount ?? existing.unread_count ?? 0,
            created_at: existing.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          emitEvent({ event: 'conversation_updated', conversation: chats.get(key) });
        }
      });

      // --- Presence ---
      sock.ev.on('presence.update', ({ id, presences }) => {
        const key = normalizeJid(id);
        const chat = chats.get(key);
        if (chat) {
          chat.presence = presences?.[0]?.presence || null;
          emitEvent({ event: 'presence_updated', conversation_id: key, presence: chat.presence });
        }
      });
    },
  };

  // Helper used throughout the manager to broadcast events to listeners
  // (event bridge -> backend) without leaking the listener set.
  const emitEvent = (event) => sessionManager._emit(event);

  return sessionManager;
}