/**
 * Durable Raw Media Message Cache.
 *
 * Persists raw Baileys message protobufs for media messages (image, video,
 * audio, document, sticker) to disk in sessionDir.
 *
 * Why this exists: Baileys requires the original encrypted message proto
 * (directPath, mediaKey, fileEncSha256, etc.) to decrypt and download media
 * from WhatsApp CDN on demand. Previously, raw protos lived only in Node.js
 * RAM (`rawMessagesByChat`), which was wiped on every gateway restart or redeploy,
 * causing historical and unhydrated media messages to 404 when requested.
 *
 * This cache ensures that up to 500 recent raw media protos survive gateway
 * restarts, allowing on-demand media downloads to succeed after redeployment.
 */
import fs from 'fs';
import path from 'path';
import { resolveDownloadableMedia } from './message-classifier.js';

export const RAW_MEDIA_CACHE_FILE = 'raw-media-cache.json';
export const RAW_MEDIA_CACHE_VERSION = 1;
export const RAW_MEDIA_CACHE_MAX_ENTRIES = 500;
export const RAW_MEDIA_CACHE_SAVE_DEBOUNCE_MS = 2000;

export function createRawMediaCache({
  sessionDir,
  logger = null,
  maxEntries = RAW_MEDIA_CACHE_MAX_ENTRIES,
  debounceMs = RAW_MEDIA_CACHE_SAVE_DEBOUNCE_MS,
} = {}) {
  const filePath = sessionDir ? path.join(sessionDir, RAW_MEDIA_CACHE_FILE) : null;
  const entriesById = new Map(); // id -> { jid, id, message, saved_at }
  let saveTimer = null;
  let isSaving = false;

  function clearSaveTimer() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function flush() {
    clearSaveTimer();
    if (!filePath || entriesById.size === 0 || isSaving) return;
    try {
      isSaving = true;
      const items = Array.from(entriesById.values()).slice(-maxEntries);
      const payload = {
        version: RAW_MEDIA_CACHE_VERSION,
        saved_at: new Date().toISOString(),
        items,
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      logger?.warn?.({ err: err?.message }, 'Failed to persist raw media cache to disk');
    } finally {
      isSaving = false;
    }
  }

  function schedule(jid, id, message) {
    if (!filePath || !jid || !id || !message) return;
    // Only persist if this message actually carries downloadable media
    const downloadable = resolveDownloadableMedia(message);
    if (!downloadable) return;

    // Put in LRU map
    entriesById.delete(String(id));
    entriesById.set(String(id), {
      jid: String(jid),
      id: String(id),
      message,
      saved_at: Date.now(),
    });

    while (entriesById.size > maxEntries) {
      const oldestKey = entriesById.keys().next().value;
      if (!oldestKey) break;
      entriesById.delete(oldestKey);
    }

    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        flush();
      }, debounceMs);
      if (typeof saveTimer.unref === 'function') {
        saveTimer.unref();
      }
    }
  }

  function load(store) {
    if (!filePath || !store) return 0;
    try {
      if (!fs.existsSync(filePath)) return 0;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items)) return 0;

      let loadedCount = 0;
      for (const item of parsed.items) {
        if (!item?.jid || !item?.id || !item?.message) continue;
        entriesById.set(String(item.id), item);

        // Populate in-memory store
        const { rawMessagesByChat } = store;
        if (rawMessagesByChat) {
          let byId = rawMessagesByChat.get(item.jid);
          if (!byId) {
            byId = new Map();
            rawMessagesByChat.set(item.jid, byId);
          }
          if (!byId.has(item.id)) {
            store.rawMessageCount = (store.rawMessageCount || 0) + 1;
          }
          byId.set(item.id, item.message);
          loadedCount++;
        }
      }
      logger?.debug?.({ loadedCount }, 'Loaded raw media messages from disk cache');
      return loadedCount;
    } catch (err) {
      logger?.warn?.({ err: err?.message }, 'Failed to load raw media cache from disk');
      return 0;
    }
  }

  return {
    schedule,
    load,
    flush,
  };
}
