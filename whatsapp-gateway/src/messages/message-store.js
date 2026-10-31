/**
 * WhatsApp Session In-Memory Store and Raw Proto Cache.
 *
 * Scopes in-memory contacts, chats, messages, and retry proto cache per session (AGENTS.md multi-line isolation).
 *
 * `contacts` is the one scope that is also mirrored to disk: the gateway
 * resolves message sender labels from it (`_resolveDisplayName`), and losing it
 * on restart silently downgraded names to raw phone numbers. When a session
 * directory is supplied the map is wrapped so that *any* mutation schedules a
 * debounced save — including the call sites in `socket/socket-events.js` that
 * mutate the map directly. Hooking the map itself rather than each call site is
 * deliberate: a future `contacts.set(...)` cannot forget to persist.
 */
import { randomUUID } from 'node:crypto';

import { createBoundedCache } from '../domain/bounded-cache.js';
import { createContactCache } from './contact-cache.js';
import { createRawMediaCache } from './raw-media-cache.js';

export const RAW_MESSAGE_STORE_MAX = 10000;
export const MESSAGES_BY_CHAT_MAX_CHATS = 300;
//: Sohbet başına `messagesByChat` tavanı. Dört ayrı yazma yolunda da AYNI
//: sayı kullanılır; tek yerde tanımlanması, eviction logunun "hangi tavan
//: tetikledi" sorusunu tahmine bırakmaması içindir.
export const MESSAGES_PER_CHAT_MAX = 2000;

/**
 * Tek bir eviction olayını sayar ve TEK satır yapısal log üretir.
 *
 * NEDEN: `messagesByChat` sohbet başına 2000'i aştığında en eskiler sessizce
 * atılıyordu ve `message-store.js` içinde HİÇ `logger.` çağrısı yoktu — yani
 * veri kaybı tamamen görünmezdi. Bu fonksiyon kaybı sayılabilir kılar.
 *
 * PII SINIRI: log satırında mesaj kimliği, gövde, telefon numarası ve JID
 * YOKTUR. Yalnızca hangi tavanın tetiklendiği, kaç kaydın atıldığı ve o anki
 * doluluk yazılır. Sohbet anahtarı da yazılmaz: `messagesByChat` anahtarı bir
 * JID'dir, yani telefon numarasıdır.
 */
export function recordEviction(store, { reason, limit, removed, sizeAfter, chatCount, chatKey } = {}) {
  if (!store) return;
  const count = Number.isFinite(Number(removed)) ? Number(removed) : 1;
  store.evictionsTotal = (store.evictionsTotal || 0) + count;
  store.evictionsByReason = store.evictionsByReason || {};
  store.evictionsByReason[reason] = (store.evictionsByReason[reason] || 0) + count;
  store.lastEvictionAt = new Date().toISOString();
  store.lastEvictionReason = reason || null;
  // Sohbet başına dağılım YALNIZCA bellekte tutulur; `/health`'e ham hâliyle
  // çıkmaz (anahtar bir JID = telefon numarasıdır). Sınırlı tutulur: kaybın
  // olduğu sohbet sayısı 1000'i aşarsa yeni anahtar izlenmez, toplam yine
  // `evictions_total` içinde kalır.
  if (chatKey) {
    store._evictionsByChat = store._evictionsByChat || new Map();
    const prev = store._evictionsByChat.get(chatKey);
    if (prev !== undefined) {
      store._evictionsByChat.set(chatKey, prev + count);
    } else if (store._evictionsByChat.size < 1000) {
      store._evictionsByChat.set(chatKey, count);
    }
    store.evictionsAffectedChats = store._evictionsByChat.size;
    if (prev !== undefined && prev + count > (store.evictionsMaxPerChat || 0)) {
      store.evictionsMaxPerChat = prev + count;
    } else if (prev === undefined) {
      store.evictionsMaxPerChat = Math.max(store.evictionsMaxPerChat || 0, count);
    }
  }
  const logger = store.logger;
  if (logger && typeof logger.warn === 'function') {
    try {
      logger.warn(
        {
          eviction_reason: reason || 'unknown',
          eviction_limit: limit ?? null,
          evicted_count: count,
          size_after: sizeAfter ?? null,
          chats_after: chatCount ?? null,
        },
        'RAM message eviction: records dropped from in-memory store'
      );
    } catch {
      // Loglama asla ingestion yolunu bozmamalı.
    }
  }
}

/**
 * Sohbet başına tavanı uygular ve kaybı SAYAR.
 *
 * Dört yazma yolu da (canlı upsert, giden kayıt, history sync, chats.update
 * sentezi) aynı `splice(0, len - 2000)` desenini kullanıyordu ve hiçbiri
 * kaybı raporlamıyordu. Tek yardımcıya toplamak, "hangi tavan, kaç kayıt"
 * sorusunu tek yerde yanıtlar.
 */
export function trimChatMessages(store, chatKey, list) {
  if (!Array.isArray(list) || list.length <= MESSAGES_PER_CHAT_MAX) return list;
  const removed = list.length - MESSAGES_PER_CHAT_MAX;
  list.splice(0, removed);
  recordEviction(store, {
    reason: 'per_chat_cap',
    limit: MESSAGES_PER_CHAT_MAX,
    removed,
    sizeAfter: list.length,
    chatCount: store?.messagesByChat?.size ?? null,
    chatKey,
  });
  return list;
}

export function boundMessagesByChat(store, currentKey) {
  if (!store?.messagesByChat) return;
  const { messagesByChat } = store;
  if (currentKey && messagesByChat.has(currentKey)) {
    const val = messagesByChat.get(currentKey);
    messagesByChat.delete(currentKey);
    messagesByChat.set(currentKey, val);
  }
  while (messagesByChat.size > MESSAGES_BY_CHAT_MAX_CHATS) {
    const oldestKey = messagesByChat.keys().next().value;
    if (!oldestKey || oldestKey === currentKey) break;
    const dropped = messagesByChat.get(oldestKey);
    messagesByChat.delete(oldestKey);
    // Sohbetin TAMAMI düştü: bu, sohbet başına tavandan daha ağır bir kayıptır
    // ve ayrı bir `reason` ile sayılır.
    recordEviction(store, {
      reason: 'chat_count_cap',
      limit: MESSAGES_BY_CHAT_MAX_CHATS,
      removed: Array.isArray(dropped) ? dropped.length : 1,
      sizeAfter: messagesByChat.size,
      chatCount: messagesByChat.size,
      chatKey: oldestKey,
    });
  }
}

/**
 * Depoya ait monotonik ekleme sırası.
 *
 * NEDEN GEREKLİ: `listAllMessages` sayfalaması `offset` tabanlıydı ve liste
 * BAŞINDAN eviction yapıldığında indeksler sola kayıyordu; `offset` sabit
 * kaldığı için hiç görülmemiş kayıtlar kalıcı olarak atlanıyordu (izole
 * ölçüm: 10 kayıtta 3 kayıt hiç ziyaret edilmedi). Mesajın `id` alanı
 * keyset olarak KULLANILAMAZ: gelen mesajlarda `id` = gönderim zamanı (ms),
 * giden mesajlarda `id` = `Date.now()` — yani ne benzersiz ne de artan.
 * Geçmiş senkronuyla SONRADAN gelen eski bir mesaj, sıralamada imlecin
 * GERİSİNE düşerdi.
 *
 * `_seq` ekleme anında atanır: benzersiz, kesin artan, ekleme sırasına eşit.
 * Bir değer olduğu için liste başından eviction imleci KAYDIRMAZ.
 */
export function nextMessageSeq(store) {
  if (!store) return 0;
  store._messageSeq = (store._messageSeq || 0) + 1;
  return store._messageSeq;
}

/**
 * Kayda taze bir `_seq` damgası basar (varsa üzerine yazar).
 *
 * `enumerable: false` bilinçlidir: kayıt nesneleri `/messages/bulk` ve
 * `message_new` olaylarıyla JSON'a serileşir. Sayılabilir bir alan olsaydı
 * her API yanıtına ve her WS olayına içsel bir sayaç sızardı.
 */
export function stampMessageSeq(store, record) {
  if (!store || !record || typeof record !== 'object') return record;
  const seq = nextMessageSeq(store);
  try {
    Object.defineProperty(record, '_seq', {
      value: seq,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    // Tanımlanamazsa kayıt yine de yazılır; `listAllMessages` eksik damgayı
    // okuma anında tamamlar (bkz. `ensureMessageSeq`).
  }
  return record;
}

export function messageSeqOf(record) {
  const value = record?._seq;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Damgasız kayda sıra atar; damgalıysa DOKUNMAZ.
 *
 * Okuma anında tamamlama bilinçlidir: bir yazma yolu `stampMessageSeq`
 * çağırmayı unutursa kayıt imlecin gerisinde kalmaz — o an en yüksek sırayı
 * alır ve tur içinde mutlaka ziyaret edilir. Yani eksik damga "sessiz atlama"
 * değil, "aynı turda daha geç ziyaret" demektir.
 */
export function ensureMessageSeq(store, record) {
  if (!record || typeof record !== 'object') return null;
  const existing = messageSeqOf(record);
  if (existing !== null) return existing;
  const seq = nextMessageSeq(store);
  try {
    Object.defineProperty(record, '_seq', {
      value: seq,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    return null;
  }
  if (store) store.seqLateStampTotal = (store.seqLateStampTotal || 0) + 1;
  return seq;
}

/**
 * Deponun sıra dönemi (epoch).
 *
 * İmleç `(epoch, seq)` çiftidir. Süreç/session yeniden oluşursa `_messageSeq`
 * sıfırdan başlar; eski bir epoch'a ait yüksek bir seq, yeni depoda HİÇBİR
 * kaydı eşleştirmez (hepsi `seq > after_seq` filtresinden düşerdi). Epoch
 * değişimini gören backend imleci sıfırlar — yani kayıp imleç güvenli bir
 * yeniden taramaya dönüşür, veri kaybına değil.
 */
export function storeSeqEpoch(store) {
  if (!store) return '';
  if (!store._seqEpoch) store._seqEpoch = randomUUID();
  return store._seqEpoch;
}

/**
 * RAM kapasitesinin tek geçişlik özeti (P2-1).
 *
 * O(sohbet) — `MESSAGES_BY_CHAT_MAX_CHATS` (300) ile sınırlı, bu yüzden her
 * `/health` isteğinde çağrılabilir. Mesaj listelerini KOPYALAMAZ, sıralamaz:
 * sağlık ucu sık sorulur ve burada yapılan her ek iş, asıl ingestion
 * yolundan çalınan zamandır.
 *
 * `evictions_by_chat` bilinçli olarak bir JID→sayı haritası DEĞİL: sohbet
 * anahtarı bir JID'dir, yani telefon numarasıdır ve `/health` kimlik
 * doğrulaması istemez. Bu yüzden dağılım yalnızca özet olarak yayınlanır.
 */
export function ramCapacitySnapshot(store) {
  const byChat = store?.messagesByChat;
  let messages = 0;
  let chats = 0;
  let atCap = 0;
  let largest = 0;
  if (byChat && typeof byChat.values === 'function') {
    for (const list of byChat.values()) {
      if (!Array.isArray(list)) continue;
      chats += 1;
      messages += list.length;
      if (list.length > largest) largest = list.length;
      if (list.length >= MESSAGES_PER_CHAT_MAX) atCap += 1;
    }
  }
  const rawTotal = Number(store?.rawMessageCount || 0);
  const evictedByReason = store?.evictionsByReason || {};
  let evictedTotal = 0;
  for (const value of Object.values(evictedByReason)) evictedTotal += Number(value) || 0;
  return {
    ram_messages_total: messages,
    ram_chats_total: chats,
    ram_chats_at_cap: atCap,
    ram_chat_max_utilization: chats ? Number((largest / MESSAGES_PER_CHAT_MAX).toFixed(4)) : 0,
    ram_raw_store_total: rawTotal,
    ram_raw_store_utilization: Number((rawTotal / RAW_MESSAGE_STORE_MAX).toFixed(4)),
    evictions_total: evictedTotal,
    // Sohbet başına eviction dağılımı: PII'siz özet (bkz. fonksiyon başlığı).
    evictions_by_chat: {
      affected_chats: Number(store?.evictionsAffectedChats || 0),
      max_per_chat: Number(store?.evictionsMaxPerChat || 0),
      total: evictedTotal,
    },
    evictions_by_reason: { ...evictedByReason },
    last_eviction_at: store?.lastEvictionAt || null,
    last_eviction_reason: store?.lastEvictionReason || null,
    limits: {
      per_chat: MESSAGES_PER_CHAT_MAX,
      chats: MESSAGES_BY_CHAT_MAX_CHATS,
      raw_store: RAW_MESSAGE_STORE_MAX,
    },
  };
}

const CONTACTS_MUTATORS = new Set(['set', 'delete', 'clear']);
function instrumentContacts(map, onChange) {
  if (typeof onChange !== 'function') return map;
  return new Proxy(map, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      // Map methods must run against the real Map: a Proxy receiver has no
      // internal slot, so `get`/`entries`/`size` would throw if unbound.
      if (!CONTACTS_MUTATORS.has(prop)) return value.bind(target);
      return (...args) => {
        const result = value.apply(target, args);
        try {
          onChange();
        } catch {
          // Persistence is best-effort; it must never break ingestion.
        }
        return result;
      };
    },
  });
}

export function createSessionStore({ sessionDir = null, sessionPhone = null, logger = null } = {}) {
  const store = {
    contacts: new Map(), // jid -> contact
    chats: new Map(), // jid -> chat summary
    messagesByChat: new Map(), // jid -> Message[]
    lidToJid: new Map(), // lid jid -> phone jid
    jidToLid: new Map(), // phone jid -> lid jid
    avatarFetchInFlight: new Set(),
    avatarFetchAttemptedAt: createBoundedCache({ maxEntries: 10_000, ttlMs: 60 * 60 * 1000 }),
    avatarNegativeCache: createBoundedCache({ maxEntries: 10_000, ttlMs: 24 * 60 * 60 * 1000 }),
    avatarRetryAfter: createBoundedCache({ maxEntries: 10_000, ttlMs: 60 * 60 * 1000 }),
    _avatarQueue: [],
    _avatarHighPriorityQueue: [],
    _avatarInFlightMap: new Map(),
    _avatarPumpRunning: false,
    _activeAvatarWorkers: 0,
    _avatarCircuitBreakerUntil: 0,
    rawMessagesByChat: new Map(), // jid -> Map<waMessageId, proto.IMessage>
    rawMessageCount: 0,
    // --- Kalıcılaştırma sayfalaması için monotonik ekleme sırası (P0-1) ---
    _messageSeq: 0,
    _seqEpoch: randomUUID(),
    seqLateStampTotal: 0,
    // --- RAM kapasitesi / eviction gözlemlenebilirliği (P2-1) ---
    evictionsTotal: 0,
    evictionsByReason: {},
    _evictionsByChat: new Map(),
    evictionsAffectedChats: 0,
    evictionsMaxPerChat: 0,
    lastEvictionAt: null,
    lastEvictionReason: null,
    logger: logger || null,
    // App-state sync health. `true` ONLY after a resync demonstrably advanced a
    // collection version file (see `readAppStateProgress`). A populated `chats`
    // map is not evidence of app-state health: history sync fills it while
    // `regular_low` can stay parked.
    appStateHealthy: false,
    _appStateRearmCount: 0,
  };
  if (sessionDir) {
    const contactCache = createContactCache({ sessionDir, logger, sessionPhone });
    store.contacts = instrumentContacts(store.contacts, () => contactCache.schedule(store));
    store.contactCache = contactCache;
    // Restore before the socket starts so labels are correct from the first
    // message after a restart, not only once WhatsApp re-emits contact data.
    contactCache.load(store, { currentPhone: sessionPhone });

    const rawMediaCache = createRawMediaCache({ sessionDir, logger });
    store.rawMediaCache = rawMediaCache;
    rawMediaCache.load(store);
  }
  return store;
}

export function rememberRawMessage(store, jid, id, message) {
  if (!store || !jid || !id || !message) return;
  const { rawMessagesByChat } = store;
  let byId = rawMessagesByChat.get(jid);
  if (!byId) {
    byId = new Map();
    rawMessagesByChat.set(jid, byId);
  }
  if (!byId.has(id)) store.rawMessageCount += 1;
  byId.set(id, message);
  if (store.rawMediaCache && typeof store.rawMediaCache.schedule === 'function') {
    store.rawMediaCache.schedule(jid, id, message);
  }
  if (byId.size > 500) {
    const oldest = byId.keys().next().value;
    byId.delete(oldest);
    store.rawMessageCount -= 1;
    recordEviction(store, {
      reason: 'raw_chat_cap',
      limit: 500,
      removed: 1,
      sizeAfter: store.rawMessageCount,
      chatCount: rawMessagesByChat.size,
    });
  }
  let rawEvicted = 0;
  while (store.rawMessageCount > RAW_MESSAGE_STORE_MAX) {
    const firstChat = rawMessagesByChat.keys().next().value;
    const firstMap = rawMessagesByChat.get(firstChat);
    if (!firstMap || firstMap.size === 0) {
      rawMessagesByChat.delete(firstChat);
      continue;
    }
    const oldest = firstMap.keys().next().value;
    firstMap.delete(oldest);
    store.rawMessageCount -= 1;
    rawEvicted += 1;
    if (firstMap.size === 0) rawMessagesByChat.delete(firstChat);
  }
  if (rawEvicted > 0) {
    recordEviction(store, {
      reason: 'raw_store_cap',
      limit: RAW_MESSAGE_STORE_MAX,
      removed: rawEvicted,
      sizeAfter: store.rawMessageCount,
      chatCount: rawMessagesByChat.size,
    });
  }
}

export function lookupRawMessage(store, key) {
  if (!store || !key?.remoteJid || !key?.id) return undefined;
  const { rawMessagesByChat, lidToJid, jidToLid } = store;
  const direct = rawMessagesByChat.get(key.remoteJid)?.get(key.id);
  if (direct) return direct;
  const alt = key.remoteJid.includes('@lid')
    ? lidToJid.get(key.remoteJid)
    : jidToLid.get(key.remoteJid);
  if (alt && rawMessagesByChat.get(alt)?.has(key.id)) return rawMessagesByChat.get(alt).get(key.id);
  if (store.rawMediaCache && typeof store.rawMediaCache.get === 'function') {
    const cached = store.rawMediaCache.get(key.id);
    if (cached?.message) return cached.message;
  }
  return undefined;
}

export function messageTimestampMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
}

/**
 * Coerces a protobuf `uint64` timestamp (SECONDS) into a positive JS number.
 *
 * Baileys hands these back as a plain number, a string, or a Long-like object
 * depending on how the payload was decoded, so `Number(value)` alone is not
 * enough: `Number(Long)` is NaN, which would silently discard a perfectly good
 * timestamp and fall through to a worse fallback. Returning `null` (rather than
 * `Date.now()`) is deliberate — callers must be able to tell "absent" from
 * "present", which is what makes the precedence in `firstPositiveSeconds` work.
 */
export function toPositiveSeconds(value) {
  if (value === null || value === undefined) return null;
  let seconds;
  if (typeof value === 'number') {
    seconds = value;
  } else if (typeof value === 'string') {
    seconds = Number(value);
  } else if (typeof value.toNumber === 'function') {
    seconds = value.toNumber(); // long.js / protobufjs Long
  } else if (typeof value.low === 'number' && typeof value.high === 'number') {
    seconds = value.high * 4294967296 + (value.low >>> 0);
  } else {
    seconds = Number(value);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // Guard the SCALE, not just the sign. These proto fields are uint64 SECONDS,
  // but a millisecond value leaking in would be ~1000x too large. That matters
  // more than it looks: the backend only ever moves `last_message_at` FORWARD
  // (`gw_ts > conv.last_message_at`), so a far-future stamp would latch at the
  // top of the list permanently and could never be corrected by a later sync.
  // 1e11 seconds is year 5138, so anything above it is unambiguously millis.
  if (seconds >= 1e11) seconds = Math.round(seconds / 1000);
  return seconds > 0 ? seconds : null;
}

/**
 * The first argument that yields a usable positive timestamp, else null.
 * Lets a caller express a fallback chain without nested `||` truthiness traps
 * (a `0` or a Long would otherwise short-circuit incorrectly).
 */
export function firstPositiveSeconds(...values) {
  for (const value of values) {
    const seconds = toPositiveSeconds(value);
    if (seconds !== null) return seconds;
  }
  return null;
}

/**
 * Resolves the chat-list activity stamp (SECONDS) for a chat from Baileys.
 *
 * WhatsApp Web orders its chat list by the ABSOLUTE last message in the chat.
 * `lastMessageRecvTimestamp` is the last message received FROM THE OTHER PARTY,
 * so ranking by it sinks every chat whose newest message is one WE sent.
 * Measured on live production data: 24 chats carried a stamp older than their
 * own newest message, and 23 of those 24 had an OUTBOUND newest message (worst
 * case 36 days) — the reported "Tezlify's order does not match WhatsApp Web".
 *
 * Precedence:
 *   1. chat.conversationTimestamp    — the field WhatsApp Web itself sorts by
 *   2. chat.lastMsgTimestamp         — absolute last message (proto field 5)
 *   3. newest.timestamp_s            — newest locally known message, sent OR received
 *   4. chat.lastMessageRecvTimestamp — received-only; LAST resort, never first
 *
 * Returns null when the chat carries no usable stamp, so the caller can fall
 * back to `newest.created_at` / the previous value rather than inventing one.
 */
export function resolveChatActivitySeconds(chat = {}, newest = null) {
  return firstPositiveSeconds(
    chat?.conversationTimestamp,
    chat?.lastMsgTimestamp,
    newest?.timestamp_s,
    chat?.lastMessageRecvTimestamp,
  );
}
