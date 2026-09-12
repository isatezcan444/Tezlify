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
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage, ALL_WA_PATCH_NAMES } from '@whiskeysockets/baileys';
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
// Faz 6e: WhatsApp'ın LID (Large Identity) dönemi — W:Contact app-state
// yamaları ve bazı mesaj anahtarları artık telefon JID'i yerine
// `xxx@lid` kimliğiyle anahtarlanır. Bu haritalar LID ↔ telefon JID
// köprüsünü kurar; rehber adları böylece telefon-anahtarlı sohbetlere
// işlenebilir (WhatsApp Web paritesi).
const lidToJid = new Map(); // lid jid -> phone jid
const jidToLid = new Map(); // phone jid -> lid jid
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

function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

// LID/telefon JID normalizasyonu: WhatsApp ham sayı ya da tam JID gönderebilir.
function asLid(v) {
  if (!v || typeof v !== 'string') return null;
  return v.includes('@') ? v : `${v}@lid`;
}

function asPn(v) {
  if (!v || typeof v !== 'string') return null;
  return v.includes('@') ? v : `${v}@s.whatsapp.net`;
}

// LID ↔ telefon çiftini kalıcı olarak öğren; ilk kez görülüyorsa true döner
// (çağıran taraf bekleyen LID kayıtlarını telefona taşır).
function rememberLidPair(lid, phoneJid) {
  const l = asLid(lid);
  const p = asPn(phoneJid);
  if (!l || !p || !isLidJid(l) || isLidJid(p)) return false;
  if (lidToJid.get(l) === p) return false;
  lidToJid.set(l, p);
  jidToLid.set(p, l);
  return true;
}

function jidToPhone(jid) {
  if (!jid) return null;
  // LID kimliği telefon numarası DEĞİLDİR — asla +rakam türetilmez
  // (AGENTS.md: sahte telefon sentezlenmez).
  if (isLidJid(jid)) return null;
  const match = jid.match(/^(\d+)@/);
  return match ? `+${match[1]}` : null;
}

function normalizeJid(jid) {
  if (!jid) return jid;
  if (jid.includes('@g.us')) return jid; // group
  // LID kimliği eşleşmesi biliniyorsa telefon JID'ine çöz — sohbetler,
  // kişiler ve mesajlar her zaman telefon anahtarıyla tutulur (WhatsApp
  // Web paritesi: rehber adı telefon-anahtarlı sohbete işlenir).
  if (isLidJid(jid)) {
    const phone = lidToJid.get(jid);
    return phone || jid;
  }
  if (jid.includes('@s.whatsapp.net')) return jid;
  if (jid.includes('@')) return jid;
  return `${jid}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------
// Contact name priority (WhatsApp Web parity): kullanıcının telefon
// rehberindeki ad (W:Contact app-state → contacts.upsert) her zaman
// pushName'den (kişinin kendi profil adı) önce gelir.
// ---------------------------------------------------------------------------
const NAME_RANK = { addressbook: 5, verified: 4, history: 3, push: 2, phone: 1 };

function mergeContactName(existing, name, source) {
  const base = existing || {};
  if (!name) return base;
  const currentRank = NAME_RANK[base.name_source] || (base.name ? NAME_RANK.history : 0);
  const newRank = NAME_RANK[source] || NAME_RANK.history;
  const phoneLike = !base.name || /^\+\d+$/.test(base.name) || base.name === base.phone;
  if (phoneLike || newRank >= currentRank) {
    return { ...base, name, name_source: source };
  }
  return base;
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
        _pairingPhone: null,
        _pairingRequestedAt: 0,
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
      // Pairing niyetini sakla: QR süresi dolup soket yeniden başlayınca kod
      // geçersiz olur (WhatsApp "Cihaza bağlanamadı" verir) — _connectSocket
      // içindeki yeni QR kolonu bu sayede taze kod üretip UI'a itebilir.
      session._pairingPhone = digits;
      session._pairingRequestedAt = Date.now();
      session.updated_at = new Date().toISOString();
      // logger.warn: prod'da pino seviyesi 'warn' — pairing yaşam döngüsü
      // olayları görünür kalmalı (aksi halde teşhis için log yok).
      logger.warn({ id, pairingCode }, 'Pairing code generated');
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
      session._pairingPhone = null;
      session._pairingRequestedAt = 0;
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
      // Telefon kimliği henüz çözülememiş LID-bekletme kayıtlarını dışarı
      // verme — eşleşme öğrenilince _migrateLidToPhone telefona taşır.
      return [...contacts.values()]
        .filter((c) => !isLidJid(c.id))
        .map((c) => ({ ...c }));
    },

    // -----------------------------------------------------------------------
    // Conversations
    // -----------------------------------------------------------------------
    listConversations({ search, limit, offset } = {}) {
      // Eşleşmesi henüz çözülememiş LID-anahtarlı sohbetleri dışarı verme —
      // telefon eşleşmesi öğrenilince _applyLidMapping onları telefona taşır
      // (WhatsApp Web'de ham `xxx@lid` başlığı görünmez).
      let list = [...chats.values()].filter((c) => !isLidJid(c.jid)).sort((a, b) => {
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
      // Okuma aninda ismi contact Map'ten yeniden coz (rehber adi app-state
      // senkronu sohbet kaydindan sonra gelmis olabilir — sidebar paritesi).
      return {
        items: list.map((c) => {
          const contact = contacts.get(c.jid) || contacts.get(normalizeJid(c.jid));
          if (contact?.name && contact.name !== c.name) {
            const rankNew = NAME_RANK[contact.name_source] || 0;
            const rankCur = NAME_RANK[c.name_source] || (c.name && /^\+\d+$/.test(c.name) ? 0 : NAME_RANK.history);
            if (!c.name || /^\+\d+$/.test(c.name) || rankNew >= rankCur) {
              return { ...c, name: contact.name, name_source: contact.name_source || null };
            }
          }
          return { ...c };
        }),
        total,
      };
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

    // Faz 6e: yeni bir LID ↔ telefon eşleşmesi öğrenildiğinde, LID anahtarı
    // altında bekletilen kişi/sohbet/mesaj kayıtlarını telefon anahtarına
    // taşır ve sidebar'ı rehber adıyla tazeler. mapping değişmediyse no-op.
    _applyLidMapping(lid, phoneJid) {
      if (!rememberLidPair(lid, phoneJid)) return;
      const lidKey = asLid(lid);
      const phoneKey = asPn(phoneJid);
      // 1. Bekleyen LID kişisini telefona taşı (mergeContactName önceliği korur).
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
      // 2. LID anahtarlı sohbet varsa telefona taşı / başlığı güncelle.
      const lidChat = chats.get(lidKey);
      if (lidChat) {
        chats.delete(lidKey);
        const contact = contacts.get(phoneKey);
        // LID sohbetinin gerçek alanları (app-state arşiv/bastırma, son mesaj)
        // telefon stub'ını ezsın; id/jid/phone telefon kimliğine sabitlenir.
        const existingPhone = chats.get(phoneKey) || {};
        // LID-stub sohbetinin adı ham LID jid'si olabilir ("xxx@lid") — onu
        // asla görüntülenen ad yapma; contact > mevcut telefon adı > telefon.
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
        // Sohbet zaten telefon anahtarında — rehber adını öncelik sırasıyla uygula.
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
      // 3. LID anahtarlı mesaj geçmişi varsa telefona taşı (sıra korunur).
      // Bekletilen (yayınlanmamış) mesajlar artık telefon kimliğiyle yayına girer.
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
          // LID kimliğiyle yazılmış alanları telefon kimliğine çevir.
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
        if (phoneMsgs.length > 500) phoneMsgs.splice(0, phoneMsgs.length - 500);
        messagesByChat.set(phoneKey, phoneMsgs);
      }
      logger.warn({ lid: lidKey, jid: phoneKey }, 'LID→telefon eşleşmesi uygulandı');
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
        name_source: contact?.name_source || existing.name_source || null,
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
          // --- Faz 6b fix: pairing kodu sokete bağlıdır ve QR ile birlikte
          // (~60 sn) geçerliliğini yitirir. Soket yeniden başlayıp yeni QR
          // üretildiğinde, ekrandaki eski kod WhatsApp'ta "Cihaza
          // bağlanamadı / kodu tekrar girin" hatası verir. Bekleyen bir
          // pairing isteği varsa taze kodu otomatik üretip UI'a it.
          if (session._pairingPhone) {
            const PAIRING_TTL_MS = 10 * 60 * 1000;
            if (Date.now() - (session._pairingRequestedAt || 0) > PAIRING_TTL_MS) {
              session._pairingPhone = null;
            } else {
              try {
                const freshCode = await sock.requestPairingCode(session._pairingPhone);
                session.updated_at = new Date().toISOString();
                logger.warn({ id, pairingCode: freshCode }, 'Pairing code re-issued after socket restart');
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
        if (connection === 'open') {
          session.status = 'CONNECTED';
          session.qr_code = null;
          session.error_message = null;
          session.error_reason = null;
          session._connFailures = 0;
          session._pairingPhone = null;
          session._pairingRequestedAt = 0;
          session.is_phone_online = true;
          session.updated_at = new Date().toISOString();
          // Persist encrypted auth state
          safeWriteEncrypted(path.join(sessionDir, 'auth.json'), { creds: state.creds, keys: state.keys }, aesKey);
          emitEvent({ event: 'session_connected', session_id: id, session_name: session.session_name, phone: session.phone_number || null });
          // Faz 6e: Baileys'in doğal W:Contact senkronu yalnızca history-sync
          // bildirimi 20 sn içinde gelirse çalışır; gelmezse rehber adları
          // hiçbir bağlantıda ulaşmaz (WhatsApp Web'de görünen isimler burada
          // hiç oluşmaz). Bağlantıdan sonra gecikmeli tam app-state senkronunu
          // zorla tetikle — idempotent: sürüm > 0 ise sunucu yalnızca yeni
          // yamaları döner, sürüm 0 ise snapshot'la tüm rehber gelir.
          // Doğal senkron hâlâ sürüyorsa (event buffer aktif) dokunma — o
          // yol kendi flush'ını kendisi yapar; 5 sn sonra tekrar dene.
          const forceAppStateResync = (attempt) => {
            if (session.status !== 'CONNECTED' || !sock) return;
            if (attempt > 6) return;
            if (sock.ev.isBuffering && sock.ev.isBuffering()) {
              setTimeout(() => forceAppStateResync(attempt + 1), 5000);
              return;
            }
            try {
              Promise.resolve(sock.resyncAppState(ALL_WA_PATCH_NAMES, true))
                .then(() => {
                  // resyncAppState createBufferedFunction'dır: ürettiği
                  // contacts.upsert/chats.update olayları buffer'da kalır ve
                  // merkezi durum makinesi Online geçişini çoktan yaptığı için
                  // kimse flush etmez — burada elle boşalt.
                  try { sock.ev.flush(); } catch { /* zaten boşsa önemsiz */ }
                })
                .catch((err) => logger.warn({ err }, 'Forced app-state resync failed'));
            } catch (err) {
              logger.warn({ err }, 'Forced app-state resync threw');
            }
          };
          setTimeout(() => forceAppStateResync(0), 8000);
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
          // Faz 6e: LID döneminde anahtar senderLid/senderPn çifti taşıyabilir
          // — eşleşmeyi kalıcı olarak öğren (remoteJid @lid ise sohbet de
          // normalizeJid ile telefona çözülür).
          if (msg.key?.senderLid && msg.key?.senderPn) {
            this._applyLidMapping(msg.key.senderLid, msg.key.senderPn);
          }
          if (msg.key?.participantLid && msg.key?.participantPn) {
            this._applyLidMapping(msg.key.participantLid, msg.key.participantPn);
          }
          const key = normalizeJid(jid);
          // Eşleşmesi bilinmeyen LID: mesajı bellekte beklet, backend'e yayma
          // (hayalet `jid:@lid` sohbeti oluşmasın) — _applyLidMapping öğrendiğinde
          // telefon kimliğiyle yayına verilir.
          const lidHold = isLidJid(key);
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
            sender_phone: jidToPhone(key) || key,
            recipient_phone: 'ME',
            sender_name: contact?.name || jidToPhone(key) || key,
            sender_name_source: contact?.name_source || null,
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
          if (!lidHold) {
            emitEvent({
              event: 'message_new',
              conversation_id: key,
              message: record,
            });
          }
        }
      });

      // --- Contacts sync ---
      // contacts.update: Baileys bunu msg.pushName ile yayar (kişinin KENDI
      // profil adi) — rehber adini asla ezmemeli; mergeContactName onceligi korur.
      sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
          // LID döneminde remoteJid/participant @lid olabilir — eşleşme
          // biliniyorsa telefona çöz, değilse lid anahtarında beklet
          // (_applyLidMapping öğrendiğinde telefona taşır).
          const jid = normalizeJid(update.id);
          if (!jid) continue;
          // Eşleşmesi henüz bilinmeyen LID anahtarını backend'e yayma —
          // kayıt LID altında bekler, _applyLidMapping öğrendiğinde telefona
          // taşır (backend'de jid:@lid hayalet satır oluşmaz).
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
      });

      // --- Address book (W:Contact app-state) — WhatsApp Web paritesinin asıl
      // kaynağı: kullanıcının telefonunda rehberde kayıtlı adlar. Baileys,
      // app-state senkronundaki contactAction mutasyonlarını bu olayla yayar.
      // Faz 6e: WhatsApp artık bu yamaları `xxx@lid` kimliğiyle anahtarlıyor;
      // payload {id, name, lid, jid} şeklindedir (jid yalnızca id telefon
      // JID'iyse dolar). LID anahtarlı kayıtlar eşleşme öğrenilinceye kadar
      // bekletilir, öğrenilince _applyLidMapping telefona taşır.
      sock.ev.on('contacts.upsert', (list) => {
        for (const c of list || []) {
          const rawId = c?.id;
          if (!rawId || !c.name) continue;
          // Çift bilgisi varsa eşlemeyi öğren (id telefon + lid alanı dolu).
          if (c.lid && !isLidJid(rawId)) this._applyLidMapping(c.lid, rawId);
          const jid = normalizeJid(rawId); // lid ise ve eşleşme biliniyorsa telefona çözülür
          const now = new Date().toISOString();
          if (isLidJid(jid)) {
            // Eşleşme henüz bilinmiyor: adres defteri adını LID anahtarında
            // beklet — mesaj/geçmiş/phone-share eşleşmeyi getirince taşınır.
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
          // Rehber adı bilinen sohbetin başlığını da tazele (sidebar parity).
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

      // --- Faz 6e: LID → telefon eşleşmesi — kişi telefon numarasını
      // paylaştığında WhatsApp bunu lid ile birlikte bildirir; kalıcı eşleme.
      sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        if (lid && jid) this._applyLidMapping(lid, jid);
      });

      // --- Chats sync ---
      sock.ev.on('chats.update', (updates) => {
        for (const update of updates) {
          const jid = update.id;
          if (!jid) continue;
          const key = normalizeJid(jid);
          // Çözülmemiş LID anahtarı: sohbet LID altında bekler, eşleşme
          // öğrenilince _applyLidMapping telefona taşır — backend'e yaymaz.
          const lidHold = isLidJid(key);
          const existing = chats.get(key) || {};
          const contact = contacts.get(key);
          chats.set(key, {
            ...existing,
            id: key,
            jid: key,
            name: contact?.name || existing.name || (lidHold ? '' : jidToPhone(key) || key),
            name_source: contact?.name_source || existing.name_source || null,
            phone: jidToPhone(key) || existing.phone || '',
            is_group: key.includes('@g.us'),
            last_message_at: update.lastMessage?.messageTimestamp ? new Date(update.lastMessage.messageTimestamp * 1000).toISOString() : existing.last_message_at,
            last_message_preview: update.lastMessage?.message?.conversation || existing.last_message_preview || '',
            unread_count: update.unreadCount ?? existing.unread_count ?? 0,
            created_at: existing.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          if (!chats.get(key)?.avatar_url) void sessionManager._ensureChatAvatar(key);
          if (!lidHold) emitEvent({ event: 'conversation_updated', conversation: chats.get(key) });
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
            // Faz 6e: gecmis kisi kaydi {id: telefon, lid} tasir — eşleşmeyi
            // öğren (LID anahtarlı bekleyen rehber adları varsa telefona taşınır).
            if (c.lid && !isLidJid(c.id)) this._applyLidMapping(c.lid, c.id);
            if (isLidJid(c.id)) continue; // salt-LID kaydı: yalnızca eşleme kaynağı
            let merged = contacts.get(c.id) || {};
            // Conversation.name (senkron anındaki rehber adı) pushName'den önce gelir.
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
          // 2. Mesajlar (chat bazinda, wa_message_id ile dedup)
          let storedMessages = 0;
          for (const msg of historyMessages || []) {
            const jid = msg.key?.remoteJid;
            if (!jid || msg.key?.id === '__history__') continue;
            // Faz 6e: gecmis mesaj anahtarlari da LID↔telefon çifti tasir.
            if (msg.key?.senderLid && msg.key?.senderPn) this._applyLidMapping(msg.key.senderLid, msg.key.senderPn);
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
            // Faz 6e: Conversation.lidJid — sohbet telefon anahtarlıysa eşlemeyi öğren;
            // Conversation.pnJid — sohbet LID anahtarlıysa telefonu buradan çöz.
            if (chat.lidJid && !isLidJid(jid)) this._applyLidMapping(chat.lidJid, jid);
            if (isLidJid(jid) && chat.pnJid) this._applyLidMapping(jid, chat.pnJid);
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
              // contact Map öncelik-çözümlemeli adı taşır (rehber > push); chat.name
              // (Conversation.name) yalnızca yedek olarak kullanılır.
              name: contact?.name || chat.name || existing.name || jidToPhone(key) || key,
              name_source: contact?.name_source || existing.name_source || null,
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