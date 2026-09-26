/**
 * WhatsApp Preview, Formatting, and Event Sanitization Utilities.
 *
 * Enforces single source of truth for chat previews, sync state resolution,
 * and outbound event privacy sanitization (AGENTS.md §1.1).
 */
import { isRawIdentityName, isPhoneLikeName, jidToPhone } from './whatsapp-identity.js';

export const TYPE_PREVIEW_LABELS = {
  IMAGE: '📷 Fotoğraf',
  VIDEO: '🎥 Video',
  AUDIO: '🎵 Sesli mesaj',
  STICKER: 'Sticker',
  DOCUMENT: '📄 Dosya',
  LOCATION: '📍 Konum',
  CONTACT: '👤 Kişi kartı',
  TEMPLATE: 'Şablon mesajı',
  // Metinsiz sistem turleri. Bunlar `classifyMessageType`ta 'TEXT'e duserdi,
  // bos govdeyle birlikte preview BOS kalirdi; bu yuzden son mesaji bir arama /
  // ifade / silinmis mesaj / grup bildirimi olan sohbetler listede ne bir sey
  // gosteriyordu ne de aktivite damgasini ilerletiyordu.
  CALL: '📞 Arama',
  REACTION: '❤️ İfade',
  REVOKED: 'Silinmiş mesaj',
  SYSTEM: 'Sistem mesajı',
  POLL: '📊 Anket',
  EVENT: '📅 Etkinlik',
  UNKNOWN: 'Mesaj',
  OTHER: 'Mesaj',
};

export function normalizePreviewText(messageType, body) {
  const t = String(messageType || 'TEXT').toUpperCase();
  const text = String(body || '').trim();
  if (text) {
    const m = /^\[([A-Za-z_]+)\]$/.exec(text);
    if (m) {
      const inner = m[1].toUpperCase();
      return TYPE_PREVIEW_LABELS[inner] || TYPE_PREVIEW_LABELS[t] || 'Mesaj';
    }
    if (text === '[object Object]' || text === '[Medya]') return TYPE_PREVIEW_LABELS[t] || 'Mesaj';
    return text;
  }
  if (t === 'TEXT') return '';
  return TYPE_PREVIEW_LABELS[t] || 'Mesaj';
}

export function buildChatPreview(record, isGroup) {
  const base = normalizePreviewText(record?.message_type, record?.body);
  if (!base) return '';
  const name = String(record?.participant_name || '').trim();
  if (
    isGroup &&
    String(record?.direction || 'INBOUND').toUpperCase() === 'INBOUND' &&
    name &&
    name.toUpperCase() !== 'ME' &&
    !isRawIdentityName(name) &&
    !isPhoneLikeName(name)
  ) {
    return `${name}: ${base}`;
  }
  return base;
}

export function sanitizeChatForEmit(chat) {
  if (!chat) return chat;
  const out = { ...chat };
  if (isRawIdentityName(out.name)) {
    out.name = null;
    out.name_source = null;
  }
  return out;
}

/**
 * Bilinmeyen arsiv durumu `false` olarak IDDIA EDILMEMELIDIR.
 *
 * Backend sozlesmesi: `is_archived` YALNIZCA payload'da `archived` anahtari
 * VARSA yazilir (`events.py`, `sync.py` — `if "archived" in payload:`), boylece
 * gateway'in bilmedigi bir sohbetin DB'deki bilinen durumu korunur. Dort
 * gateway yazicisi da `?? false` / sabit `false` ile bu sozlesmeyi ihlal
 * ediyordu; sonuc: anahtar HER ZAMAN gonderiliyor ve backend'in korumasi
 * olu kaliyordu. Canli olcum 2026-09-26: gateway'in 112 sohbetinin 112'si
 * `archived` anahtari tasiyordu, 111'i `false` — oysa gateway bu sohbetlerin
 * arsiv durumunu HIC ogrenmemisti (bkz. `getChatUpdateConditional` asagida).
 *
 * Bu yuzden: durum biliniyorsa anahtar gonderilir, bilinmiyorsa anahtar
 * HIC gonderilmez (`JSON.stringify` undefined'i zaten dusurur; backend de
 * anahtar yoksa mevcut degeri korur).
 *
 * Neden bu kadar onemli: gateway'in `chats` store'u yalnizca bellekte yasar
 * ve restart'ta bosalir. `?? false` ile, bir restart sonrasi gelen history
 * chunk'i DB'de `is_archived = true` olan bir sohbeti `false` ile EZIYORDU.
 */
export function archivedPatch(known) {
  if (known === undefined || known === null) return {};
  return { archived: Boolean(known) };
}

export function sanitizeOutboundEvent(event) {
  if (!event || typeof event !== 'object') return event;
  switch (event.event) {
    case 'conversation_updated':
      if (event.conversation) return { ...event, conversation: sanitizeChatForEmit(event.conversation) };
      return event;
    case 'contact_synced': {
      if (!event.contact) return event;
      const contact = { ...event.contact };
      if (isRawIdentityName(contact.name)) {
        contact.name = jidToPhone(contact.id) || null;
        contact.name_source = contact.name ? 'phone' : null;
      }
      return { ...event, contact };
    }
    case 'message_new': {
      if (!event.message) return event;
      const msg = { ...event.message };
      if (isRawIdentityName(msg.sender_name)) {
        msg.sender_name = jidToPhone(msg.conversation_id) || null;
      }
      if (isRawIdentityName(msg.participant_name)) msg.participant_name = null;
      return { ...event, message: msg };
    }
    default:
      return event;
  }
}

export function resolveSyncState(prevSync, { progress, isLatest }) {
  const prev = prevSync || {
    phase: 'syncing',
    progress: 0,
    chats_synced: 0,
    contacts_synced: 0,
    messages_synced: 0,
    chats_unique: 0,
    contacts_unique: 0,
    messages_cached: 0,
  };
  const realProgress = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(100, Math.round(progress)) : null;
  const done = !!isLatest || realProgress === 100;
  const alreadyDone = prev.phase === 'ready';
  let nextProgress = prev.progress || 0;
  if (realProgress != null) nextProgress = Math.max(nextProgress, realProgress);
  if (done) nextProgress = 100;
  return {
    next: {
      ...prev,
      phase: done || alreadyDone ? 'ready' : 'syncing',
      progress: nextProgress,
      completed_at: (done || alreadyDone)
        ? (prev.completed_at || new Date().toISOString())
        : prev.completed_at || null,
    },
    justCompleted: (done && !alreadyDone),
  };
}
