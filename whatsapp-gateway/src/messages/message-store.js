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
