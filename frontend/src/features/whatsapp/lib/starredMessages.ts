/**
 * WhatsApp Web Starred Messages State Management
 *
 * Implements persistent Star / Unstar functionality with:
 * 1. Synchronous localStorage persistence under `tezlify_starred_messages_v1`
 * 2. Subscription mechanism for reactive UI sync across ChatBubble and ChatInfoDrawer
 * 3. O(1) membership lookups
 */
import { Message } from '../../../types';

const STORAGE_KEY = 'tezlify_starred_messages_v1';

export interface StarredRecord {
  messageId: string | number;
  conversationId: number;
  starredAt: string;
}

let cachedStarredMap: Map<string, StarredRecord> | null = null;
const listeners = new Set<() => void>();

function getStorageSafe(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {}
  return null;
}

function loadStarredMap(): Map<string, StarredRecord> {
  if (cachedStarredMap) return cachedStarredMap;
  const map = new Map<string, StarredRecord>();
  const storage = getStorageSafe();
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.messageId !== undefined && item.messageId !== null) {
              map.set(String(item.messageId), item);
            }
          }
        }
      }
    } catch (err) {
      console.debug('[starredMessages] Failed to read from localStorage:', err);
    }
  }
  cachedStarredMap = map;
  return map;
}

function persistStarredMap(map: Map<string, StarredRecord>) {
  cachedStarredMap = map;
  const storage = getStorageSafe();
  if (storage) {
    try {
      const arr = Array.from(map.values());
      storage.setItem(STORAGE_KEY, JSON.stringify(arr));
    } catch (err) {
      console.debug('[starredMessages] Failed to persist to localStorage:', err);
    }
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.debug('[starredMessages] Listener error:', err);
    }
  }
}

/** Check if a message is currently starred */
export function isMessageStarred(messageId: string | number | undefined | null): boolean {
  if (messageId === undefined || messageId === null) return false;
  const map = loadStarredMap();
  return map.has(String(messageId));
}

/** Toggle star status of a message. Returns the NEW status (true if starred, false if unstarred). */
export function toggleMessageStar(messageId: string | number | undefined | null, conversationId: number): boolean {
  if (messageId === undefined || messageId === null) return false;
  const strId = String(messageId);
  const map = loadStarredMap();
  const currentlyStarred = map.has(strId);

  if (currentlyStarred) {
    map.delete(strId);
  } else {
    map.set(strId, {
      messageId,
      conversationId,
      starredAt: new Date().toISOString(),
    });
  }

  persistStarredMap(map);
  return !currentlyStarred;
}

/** Retrieve all starred messages within a specific conversation */
export function getStarredMessagesForConversation(conversationId: number, messages: Message[]): Message[] {
  if (!messages || !Array.isArray(messages)) return [];
  const map = loadStarredMap();
  return messages.filter((m) => m && map.has(String(m.id)));
}

/** Retrieve count of starred messages in a conversation */
export function getStarredCountForConversation(conversationId: number, messages: Message[]): number {
  if (!messages || !Array.isArray(messages)) return 0;
  const map = loadStarredMap();
  let count = 0;
  for (const m of messages) {
    if (m && map.has(String(m.id))) {
      count++;
    }
  }
  return count;
}

/** Clear all starred messages (optionally scoped to one conversation) */
export function clearStarredMessages(conversationId?: number) {
  const map = loadStarredMap();
  if (conversationId !== undefined) {
    for (const [key, record] of Array.from(map.entries())) {
      if (record.conversationId === conversationId) {
        map.delete(key);
      }
    }
  } else {
    map.clear();
  }
  persistStarredMap(map);
}

/** Subscribe to changes in starred state. Returns unsubscribe cleanup function. */
export function subscribeStarredChanges(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
