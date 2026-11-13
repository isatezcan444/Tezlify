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
export const RAW_MEDIA_CACHE_VERSION = 2;
export const RAW_MEDIA_CACHE_MAX_ENTRIES = 5000;
export const RAW_MEDIA_CACHE_SAVE_DEBOUNCE_MS = 2000;

const MAX_SANITIZE_DEPTH = 24;

// Keys allowed even inside context containers (e.g. reply/forward/ephemeral metadata).
const SAFE_CONTEXT_KEYS = new Set([
  'stanzaid',
  'participant',
  'quotedmessage',
  'remotejid',
  'mentionedjid',
  'isforwarded',
  'forwardingscore',
  'expiration',
  'ephemeralsettingtimestamp',
  'disappearingmode',
  'messageaddonDurationinsecs'.toLowerCase(),
  'externaladreply',
  'conversiondata',
  'conversionsource',
  'conversiondelayseconds',
  'entrypointconversionapp',
  'entrypointconversionsource',
  'businessmessageforwardinfo',
  'smbclientcampaigninfo',
  'dataSharingContext'.toLowerCase(),
  'forwardednewslettermessageinfo',
  'groupmentions',
  'pairedmedianotification',
]);

// Known secret-bearing keys stripped everywhere in cached media envelopes.
const ALWAYS_REDACTED_KEYS = new Set([
  'messagesecret',
  'encsecret',
  'botmessagesecret',
  'reportingtokeninfo',
  'reportingtag',
  'secretencryptedmessage',
  'senderkeydistributionmessage',
  'axolotlsenderkeydistributionmessage',
  'appstatesynckeyshare',
  'appstatesynckeydata',
  'appstatesynckeyid',
  'initialsecuritynotificationsettingsync',
  'threadkey',
  'sharedkey',
  'signingkey',
  'privatekey',
  'sessionkey',
  'rootkey',
  'enckey',
]);

const CONTEXT_CONTAINER_KEYS = new Set([
  'messagecontextinfo',
  'contextinfo',
  'devicelistmetadata',
  'botmetadata',
  'aipsimetadata',
]);

// Explicit CDN media fields that MUST remain intact for media download / thumbnails.
const PRESERVED_MEDIA_KEYS = new Set([
  'mediakey',
  'mediakeytimestamp',
  'fileencsha256',
  'filesha256',
  'thumbnailencsha256',
  'thumbnailsha256',
]);

const FUTURE_CONTEXT_SECRET_RE =
  /(secret|enckey|encsecret|encpayload|enciv|privatekey|signingkey|ratchet|senderkey|synckey|sharedkey|masterkey|sessionkey|rootkey|reportingtag|authkey)/i;

function isSerializedBuffer(val) {
  return Boolean(
    val &&
    typeof val === 'object' &&
    !Array.isArray(val) &&
    val.type === 'Buffer' &&
    Array.isArray(val.data),
  );
}

function shouldRedactKey(rawKey, inContextContainer) {
  const lower = String(rawKey).toLowerCase();
  if (PRESERVED_MEDIA_KEYS.has(lower)) return false;
  if (ALWAYS_REDACTED_KEYS.has(lower)) return true;
  if (inContextContainer && !SAFE_CONTEXT_KEYS.has(lower) && FUTURE_CONTEXT_SECRET_RE.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Recursively strips `messageSecret` and future secret-bearing context fields
 * from Baileys message objects before disk media-cache persistence, without
 * mutating the caller's object or breaking mediaKey / thumbnails / quotes / View Once.
 */
export function sanitizeMediaCacheMessage(message) {
  if (!message || typeof message !== 'object') {
    return { sanitized: message, redactedCount: 0 };
  }
  const seen = new WeakSet();
  let redactedCount = 0;

  function walk(node, depth, inContextContainer) {
    if (node === null || node === undefined || typeof node !== 'object') {
      return node;
    }
    if (Buffer.isBuffer(node)) {
      return Buffer.from(node);
    }
    if (node instanceof Uint8Array) {
      return Buffer.from(node);
    }
    if (isSerializedBuffer(node)) {
      return { type: 'Buffer', data: node.data.slice() };
    }
    if (depth >= MAX_SANITIZE_DEPTH || seen.has(node)) {
      return undefined;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      const outArr = [];
      for (const item of node) {
        const cleaned = walk(item, depth + 1, inContextContainer);
        if (cleaned !== undefined) outArr.push(cleaned);
      }
      return outArr;
    }

    const outObj = {};
    for (const key of Object.keys(node)) {
      const lower = key.toLowerCase();
      if (shouldRedactKey(key, inContextContainer)) {
        if (node[key] !== undefined && node[key] !== null) {
          redactedCount += 1;
        }
        continue;
      }
      const nextContext =
        lower === 'quotedmessage'
          ? false
          : (inContextContainer || CONTEXT_CONTAINER_KEYS.has(lower));
      const val = node[key];
      if (typeof val === 'function' || val === undefined) continue;
      const cleanedVal = walk(val, depth + 1, nextContext);
      if (cleanedVal !== undefined) {
        outObj[key] = cleanedVal;
      }
    }
    return outObj;
  }

  const sanitized = walk(message, 0, false);
  return { sanitized: sanitized || {}, redactedCount };
}

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
      const rawItems = Array.from(entriesById.values()).slice(-maxEntries);
      const items = rawItems.map((entry) => {
        const { sanitized } = sanitizeMediaCacheMessage(entry.message);
        return { ...entry, message: sanitized };
      });
      const payload = {
        version: RAW_MEDIA_CACHE_VERSION,
        saved_at: new Date().toISOString(),
        items,
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${filePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, filePath);
      try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
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

    const { sanitized } = sanitizeMediaCacheMessage(message);

    // Put in LRU map
    entriesById.delete(String(id));
    entriesById.set(String(id), {
      jid: String(jid),
      id: String(id),
      message: sanitized,
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
      let totalRedacted = 0;
      let entriesWithSecrets = 0;
      const fileVersion = Number(parsed.version || 0);

      for (const item of parsed.items) {
        if (!item?.jid || !item?.id || !item?.message) continue;
        const { sanitized, redactedCount } = sanitizeMediaCacheMessage(item.message);
        if (redactedCount > 0) {
          totalRedacted += redactedCount;
          entriesWithSecrets += 1;
        }
        const cleanItem = {
          ...item,
          message: sanitized,
        };
        entriesById.set(String(cleanItem.id), cleanItem);

        // Populate in-memory store
        const { rawMessagesByChat } = store;
        if (rawMessagesByChat) {
          let byId = rawMessagesByChat.get(cleanItem.jid);
          if (!byId) {
            byId = new Map();
            rawMessagesByChat.set(cleanItem.jid, byId);
          }
          if (!byId.has(cleanItem.id)) {
            store.rawMessageCount = (store.rawMessageCount || 0) + 1;
          }
          byId.set(cleanItem.id, cleanItem.message);
          loadedCount++;
        }
      }

      if (entriesById.size > 0 && (totalRedacted > 0 || fileVersion < RAW_MEDIA_CACHE_VERSION)) {
        logger?.info?.(
          {
            previousVersion: fileVersion,
            entriesWithSecrets,
            redactedFields: totalRedacted,
            loadedCount,
          },
          'Sanitized legacy raw media cache and rewriting without secret fields',
        );
        flush();
      } else {
        logger?.debug?.({ loadedCount }, 'Loaded raw media messages from disk cache');
      }
      return loadedCount;
    } catch (err) {
      logger?.warn?.({ err: err?.message }, 'Failed to load raw media cache from disk');
      return 0;
    }
  }

  function get(id) {
    return entriesById.get(String(id)) || null;
  }

  function has(id) {
    return entriesById.has(String(id));
  }

  return {
    schedule,
    load,
    flush,
    get,
    has,
    delete: (id) => entriesById.delete(String(id)),
  };
}
