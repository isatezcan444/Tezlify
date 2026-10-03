/**
 * WhatsApp Web Pinned Messages State Management
 *
 * Implements persistent Pin / Unpin functionality with:
 * 1. Synchronous localStorage persistence under `tezlify_pinned_messages_v1`
 * 2. Subscription mechanism for reactive UI sync across ChatBubble and ChatThread
 * 3. O(1) membership lookups
 */
import { Message } from '../../../types';

const STORAGE_KEY = 'tezlify_pinned_messages_v1';

export interface PinnedRecord {
  messageId: string | number;
  conversationId: number;
  pinnedAt: string;
}

let cachedPinnedMap: Map<string, PinnedRecord> | null = null;
const listeners = new Set<() => void>();

function getStorageSafe(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {}
  return null;
}

function loadPinnedMap(): Map<string, PinnedRecord> {
  if (cachedPinnedMap) return cachedPinnedMap;
  const map = new Map<string, PinnedRecord>();
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
      console.debug('[pinnedMessages] Failed to read from localStorage:', err);
    }
  }
  cachedPinnedMap = map;
  return map;
}

function persistPinnedMap(map: Map<string, PinnedRecord>) {
  cachedPinnedMap = map;
  const storage = getStorageSafe();
  if (storage) {
    try {
      const arr = Array.from(map.values());
      storage.setItem(STORAGE_KEY, JSON.stringify(arr));
    } catch (err) {
      console.debug('[pinnedMessages] Failed to persist to localStorage:', err);
    }
  }
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {}
  });
}

export function isMessagePinned(messageId: string | number | undefined | null): boolean {
  if (messageId === undefined || messageId === null) return false;
  const map = loadPinnedMap();
  return map.has(String(messageId));
}

export function toggleMessagePin(messageId: string | number, conversationId: number): boolean {
  const map = new Map(loadPinnedMap());
  const key = String(messageId);
  const willBePinned = !map.has(key);
  if (willBePinned) {
    map.set(key, {
      messageId,
      conversationId,
      pinnedAt: new Date().toISOString(),
    });
  } else {
    map.delete(key);
  }
  persistPinnedMap(map);
  return willBePinned;
}

export function getPinnedMessageIdsForConversation(conversationId: number): Set<string> {
  const map = loadPinnedMap();
  const set = new Set<string>();
  for (const record of map.values()) {
    if (record.conversationId === conversationId) {
      set.add(String(record.messageId));
    }
  }
  return set;
}

export function subscribePinnedChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
