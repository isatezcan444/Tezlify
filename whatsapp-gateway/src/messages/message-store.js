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
import { createBoundedCache } from '../domain/bounded-cache.js';
import { createContactCache } from './contact-cache.js';

export const RAW_MESSAGE_STORE_MAX = 2000;

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
    rawMessagesByChat: new Map(), // jid -> Map<waMessageId, proto.IMessage>
    rawMessageCount: 0,
  };
  if (sessionDir) {
    const contactCache = createContactCache({ sessionDir, logger, sessionPhone });
    store.contacts = instrumentContacts(store.contacts, () => contactCache.schedule(store));
    store.contactCache = contactCache;
    // Restore before the socket starts so labels are correct from the first
    // message after a restart, not only once WhatsApp re-emits contact data.
    contactCache.load(store, { currentPhone: sessionPhone });
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
  if (byId.size > 500) {
    const oldest = byId.keys().next().value;
    byId.delete(oldest);
    store.rawMessageCount -= 1;
  }
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
    if (firstMap.size === 0) rawMessagesByChat.delete(firstChat);
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
  return alt ? rawMessagesByChat.get(alt)?.get(key.id) : undefined;
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
