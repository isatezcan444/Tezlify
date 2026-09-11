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
// Faz 5: profil/grup resmi fetch durum takibi (retry storm önleme)
const avatarFetchInFlight = new Set();
const avatarFetchAttemptedAt = new Map(); // jid -> ms timestamp
const messagesByChat = new Map(); // jid -> Message[]
const mediaIndex = new Map(); // media_id -> { filePath, mimeType, filename, sizeBytes }

// Baileys/WA ack seviyeleri → WhatsApp Web tik anlamları.
// proto.WebMessageInfo.Status: 1=SERVER_ACK(✓) 2=DELIVERY_ACK(✓✓) 3=READ(✓✓ mavi) 4=PLAYED
const ACK_RANK = { 1: 'SENT', 2: 'DELIVERED', 3: 'READ', 4: 'READ' };
const ACK_ORDER = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };

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

    // -----------------------------------------------------------------------
    // Pairing code ("Telefon Numarası ile Bağlan") — Baileys
    // sock.requestPairingCode(digits) ile 8 haneli kod üretir; kullanıcı bu
    // kodu WhatsApp > Ayarlar > Bağlı Cihazlar > "Telefon numarasıyla bağla"
    // ekranına girer. Hata durumları fail-closed olarak yukarı fırlatılır
    // (AGENTS.md Truthfulness) — asla sahte başarı döndürülmez.
    // -----------------------------------------------------------------------
    async requestPairingCode(id, phone) {
      const session = sessions.get(id);
      if (!session) throw new Error('Session not found');
      if (session.status === 'CONNECTED') {
        throw new Error('Bu oturum zaten bağlı. Kod istemek için önce oturumu ayırın.');
      }

      // Telefonu normalize et: yalnızca rakam (ülke kodu dahil, "+" yok).
      let digits = String(phone || '').replace(/\D/g, '');
      if (digits.startsWith('00')) digits = digits.slice(2);
      // TR formatı "05XX..." olarak girilirse ülke kodunu otomatik tamamla.
      if (/^0\d{10}$/.test(digits)) digits = `90${digits.slice(1)}`;
      if (digits.length < 10 || digits.length > 15) {
        throw new Error('Geçersiz telefon numarası. Ülke kodu ile birlikte girin (örn. +90 5XX XXX XX XX).');
      }

      // Socket henüz hazırsa pairing çağrısı yapılamaz — kısa bir bekleme ile
      // socket açılışını karşıla (fail-fast değil, fail-closed: süreyi aşarsa hata).
      if (!session.sock) {
        this._startSocket(id);
      }
      const deadline = Date.now() + 15000;
      // requestPairingCode bağlantı AÇIK olmadan gönderilemez; QR üretimi
      // (status=SCAN_QR) bağlantının açıldığının kanıtıdır.
      while ((!session.sock || session.status !== 'SCAN_QR') && Date.now() < deadline) {
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
      // Bağlantı tamamlandığında telefonun görünmesi için oturuma işle.
      session.phone_number = `+${digits}`;
      session.updated_at = new Date().toISOString();
      logger.info({ id, pairingCode }, 'Pairing code generated');
      return { pairing_code: pairingCode, phone: session.phone_number };
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

    async sendMediaMessage(jid, { media_type, media_url, media_base64, mime_type, caption, filename, client_message_id }) {
      const session = this._getConnectedSession();
      const key = normalizeJid(jid);
      const type = (media_type || 'document').toLowerCase();
      // Base64 payload (frontend upload) wins over URL; Baileys accepts Buffers.
      const buffer = media_base64 ? Buffer.from(media_base64, 'base64') : null;
      const source = buffer
        ? { url: buffer, mimetype: mime_type || undefined }
        : { url: media_url };
      let content;
      if (type === 'image') {
        content = { image: source, caption: caption || '' };
      } else if (type === 'audio') {
        content = { audio: source, mimetype: mime_type || 'audio/mpeg', ptt: false };
      } else if (type === 'video') {
        content = { video: source, caption: caption || '' };
      } else {
        content = { document: source, mimetype: mime_type || 'application/octet-stream', fileName: filename || 'belge.bin', caption: caption || '' };
      }
      const result = await session.sock.sendMessage(key, content);
      const msg = this._recordOutbound(key, {
        body: caption || filename || media_url || `[${type.toUpperCase()}]`,
        message_type: type.toUpperCase(),
        media_url: media_url || null,
        media_filename: filename,
        media_caption: caption,
        client_message_id: client_message_id || `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        wa_message_id: result?.key?.id || null,
        status: 'SENT',
      });
      return msg;
    },

    // Faz 5: 'yazıyor…' presence güncellemesi (WhatsApp Web paritesi).
    async sendTyping(jid, typing = true, durationMs = 4000) {
      const session = this._getConnectedSession();
      const key = normalizeJid(jid);
      try {
        await session.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', key);
      } catch (err) {
        logger.warn({ err }, 'Send typing presence error');
      }
      return { success: true };
    },

    async markConversationRead(jid) {
      const session = this._getConnectedSession();
      const key = normalizeJid(jid);
      const isGroup = key.includes('@g.us');
      try {
        const list = messagesByChat.get(key) || [];
        const inbound = list.filter((m) => m.direction === 'INBOUND' && m.wa_message_id);
        if (isGroup) {
          // Grup okundu çentikleri mesaj anahtarı gerektirir: en yeni okunmuş
          // inbound mesajların anahtarlarını gönder (Baileys participant'a
          // key.participant üzerinden karar verir).
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
        is_group: key.includes('@g.us'),
        last_message_at: timestamp || new Date().toISOString(),
        last_message_preview: preview || existing.last_message_preview || '',
        unread_count: existing.unread_count || 0,
        created_at: existing.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      // Faz 5: sohbetin profil/grup resmi henüz yoksa arka planda çek.
      if (!chats.get(key)?.avatar_url) void this._ensureChatAvatar(key);
    },

    // Faz 5: profil (veya grup) resmini Baileys'ten tembel tembel çekip
    // sohbet ve kişi kayıtlarına yazar; conversation_updated olayı yayınlar.
    // Resmi olmayan kişilerde profilePictureUrl hata fırlatır — sessizce geçilir
    // ve 10 dk boyunca yeniden denenmez (retry storm yok).
    async _ensureChatAvatar(key) {
      if (avatarFetchInFlight.has(key)) return;
      const lastAttempt = avatarFetchAttemptedAt.get(key) || 0;
      if (Date.now() - lastAttempt < 10 * 60 * 1000) return;
      avatarFetchInFlight.add(key);
      avatarFetchAttemptedAt.set(key, Date.now());
      try {
        const session = [...sessions.values()].find((s) => s.status === 'CONNECTED' && s.sock);
        if (!session) return;
        const url = await session.sock.profilePictureUrl(key, 'preview');
        if (url) {
          const chat = chats.get(key);
          if (chat && chat.avatar_url !== url) {
            chat.avatar_url = url;
            chat.updated_at = new Date().toISOString();
            emitEvent({ event: 'conversation_updated', conversation: { ...chat } });
          }
          const contact = contacts.get(key);
          if (contact && contact.avatar_url !== url) {
            contact.avatar_url = url;
            contact.updated_at = new Date().toISOString();
            emitEvent({ event: 'contact_synced', contact: { ...contact } });
          }
        }
      } catch {
        // Resim yok/erişilemiyor — normal durum, sessiz geç.
      } finally {
        avatarFetchInFlight.delete(key);
      }
    },

    // History sync mesajlarini (WAMessage) gateway Message kaydina cevirir.
    // Medya indirmesi yapilmaz (gizemli/sifreli history medyasi): tip + caption
    // kaydedilir, media_id bos kalir.
    _historyMessageToRecord(msg, key) {
      const content = msg.message || {};
      const text =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        '';
      const mediaType = content.imageMessage ? 'IMAGE'
        : content.documentMessage ? 'DOCUMENT'
        : content.audioMessage ? 'AUDIO'
        : content.videoMessage ? 'VIDEO'
        : content.stickerMessage ? 'STICKER'
        : content.locationMessage ? 'LOCATION'
        : content.contactMessage ? 'CONTACT'
        : content.extendedTextMessage ? 'TEXT'
        : content.conversation ? 'TEXT'
        : null;
      if (!mediaType && !text) return null; // stub/unsupported message — skip
      const ts = Number(msg.messageTimestamp) * 1000;
      return {
        id: Number.isFinite(ts) ? ts : Date.now(),
        timestamp_s: Number(msg.messageTimestamp) || null,
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
        sender_name: msg.pushName || (msg.key?.fromMe ? 'ME' : null),
        participant_jid: msg.key?.participant || null,      participant_name: msg.key?.participant ? msg.pushName || null : null,        created_at: new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString(),
      };
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
        // bağlantı kırılarak reddediliyor (QR hiç oluşmuyor) — registration
        // payload'ını (requireFullSync) DEĞİŞTİRMEDEN, yalnızca telefonun
        // bağlantı sırasında PASİF olarak gönderdiği RECENT history sync
        // bildirimini işlemek için shouldSyncHistoryMessage kullanılır.
        // Bu, QR eşleşmesi sonrası sohbet listesinin boş kalmasını (Faz 4
        // hatası) çözer: 'messaging-history.set' olayı aşağıda dinlenir.
        shouldSyncHistoryMessage: () => true,
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
            participant_jid: msg.key?.participant || null,
            participant_name: isGroup ? msg.pushName || null : null,
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
            is_group: key.includes('@g.us'),
            last_message_at: update.lastMessage?.messageTimestamp ? new Date(update.lastMessage.messageTimestamp * 1000).toISOString() : existing.last_message_at,
            last_message_preview: update.lastMessage?.message?.conversation || existing.last_message_preview || '',
            unread_count: update.unreadCount ?? existing.unread_count ?? 0,
            created_at: existing.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          if (!chats.get(key)?.avatar_url) void sessionManager._ensureChatAvatar(key);
          emitEvent({ event: 'conversation_updated', conversation: chats.get(key) });
        }
      });

      // --- History sync (Faz 4): telefonun baglantı sirasinda pasif olarak
      // gonderdigi RECENT gecmisi isler. syncFullHistory (428 riski) KULLANILMAZ;
      // yalnizca shouldSyncHistoryMessage ile bildirim kabul edilir. ---
      sock.ev.on('messaging-history.set', async ({ chats: historyChats, contacts: historyContacts, messages: historyMessages, progress, isLatest }) => {
        try {
          // 1. Kisiler
          for (const c of historyContacts || []) {
            if (!c?.id) continue;
            const existing = contacts.get(c.id) || {};
            contacts.set(c.id, {
              id: c.id,
              jid: c.id,
              name: c.notify || c.name || existing.name || jidToPhone(c.id) || c.id,
              phone: jidToPhone(c.id) || existing.phone || '',
              avatar_url: c.imgUrl || existing.avatar_url || null,
              updated_at: new Date().toISOString(),
            });
          }
          // 2. Mesajlar (chat bazinda, wa_message_id ile dedup)
          let storedMessages = 0;
          for (const msg of historyMessages || []) {
            const jid = msg.key?.remoteJid;
            if (!jid || msg.key?.id === '__history__') continue;
            if (msg.message?.protocolMessage) continue; // revoke/ephemeral vb. — atla
            const key = normalizeJid(jid);
            const list = messagesByChat.get(key) || [];
            if (msg.key.id && list.some((m) => m.wa_message_id === msg.key.id)) continue;
            const record = this._historyMessageToRecord(msg, key);
            if (!record) continue;
            list.push(record);
            // Bellek koruması: sohbet başına en yeni 500 mesaj
            if (list.length > 500) list.splice(0, list.length - 500);
            messagesByChat.set(key, list);
            storedMessages += 1;
          }
          // 3. Sohbetler
          let storedChats = 0;
          for (const chat of historyChats || []) {
            const jid = chat.id || chat.jid;
            if (!jid) continue;
            const key = normalizeJid(jid);
            const contact = contacts.get(key);
            const list = messagesByChat.get(key) || [];
            const newest = list[list.length - 1];
            const ts = chat.lastMessageRecvTimestamp || newest?.timestamp_s;
            const existing = chats.get(key) || {};
            const merged = {
              ...existing,
              id: key,
              jid: key,
              name: chat.name || contact?.name || existing.name || jidToPhone(key) || key,
              phone: jidToPhone(key) || existing.phone || '',
              is_group: key.includes('@g.us'),
              avatar_url: chat.avatar_url || contact?.avatar_url || existing.avatar_url || null,
              last_message_at: ts ? new Date(Number(ts) * 1000).toISOString() : (newest?.created_at || existing.last_message_at),
              last_message_preview: newest?.body || existing.last_message_preview || '',
              unread_count: chat.unreadCount ?? existing.unread_count ?? 0,
              created_at: existing.created_at || new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            chats.set(key, merged);
            storedChats += 1;
            if (!merged.avatar_url) void sessionManager._ensureChatAvatar(key);
            emitEvent({ event: 'conversation_updated', conversation: merged });
          }
          emitEvent({
            event: 'history_sync_completed',
            progress: progress ?? null,
            is_latest: !!isLatest,
            chats_synced: storedChats,
            messages_synced: storedMessages,
          });
          logger.info({ storedChats, storedMessages, progress, isLatest }, 'History sync ingested');
        } catch (err) {
          logger.warn({ err }, 'History sync ingestion failed');
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

      // --- Message acks (✓ / ✓✓ / mavi ✓✓) — WhatsApp Web parity ---
      // Baileys emits messages.update with key.status transitions for our own
      // (fromMe) messages: SERVER_ACK → DELIVERY_ACK → READ. We translate these
      // into message_status_updated events so the backend can persist them.
      sock.ev.on('messages.update', (updates) => {
        for (const { key, update } of updates || []) {
          if (!key?.fromMe || !key?.id) continue;
          const statusNum = update?.status;
          const newStatus = ACK_RANK[statusNum];
          if (!newStatus) continue;
          const remoteJid = key.remoteJid;
          if (!remoteJid) continue;
          const k = normalizeJid(remoteJid);
          const list = messagesByChat.get(k) || [];
          const msg = list.find((m) => m.wa_message_id === key.id);
          if (!msg) continue;
          const currentRank = ACK_ORDER[msg.status] ?? 0;
          const nextRank = ACK_ORDER[newStatus] ?? 0;
          // Acks only move forward; never downgrade READ → DELIVERED.
          if (nextRank <= currentRank) continue;
          msg.status = newStatus;
          emitEvent({
            event: 'message_status_updated',
            conversation_id: k,
            wa_message_id: key.id,
            status: newStatus,
            timestamp: new Date().toISOString(),
          });
        }
      });
    },
  };

  // Helper used throughout the manager to broadcast events to listeners
  // (event bridge -> backend) without leaking the listener set.
  const emitEvent = (event) => sessionManager._emit(event);

  return sessionManager;
}