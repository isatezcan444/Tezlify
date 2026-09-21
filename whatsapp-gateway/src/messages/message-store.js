/**
 * WhatsApp Session In-Memory Store and Raw Proto Cache.
 *
 * Scopes in-memory contacts, chats, messages, and retry proto cache per session (AGENTS.md multi-line isolation).
 */
import { createBoundedCache } from '../domain/bounded-cache.js';

export const RAW_MESSAGE_STORE_MAX = 2000;

export function createSessionStore() {
  return {
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
