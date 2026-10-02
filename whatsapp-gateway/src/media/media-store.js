/**
 * WhatsApp Gateway Media Store.
 *
 * Handles incoming media downloading via Baileys, disk persistence,
 * sidecar metadata file saving (${mediaId}.meta.json), FIFO eviction, and session cleanup.
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { resolveDownloadableMedia } from '../messages/message-classifier.js';

export function createMediaStore({
  mediaDir,
  logger,
  MEDIA_INDEX_MAX = 5000,
}) {
  const mediaIndex = new Map();
  const mediaByWaId = new Map();

  // Disk initialization: scan mediaDir for existing .meta.json files on startup
  function initFromDisk() {
    try {
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
        return;
      }
      const files = fs.readdirSync(mediaDir);
      for (const file of files) {
        if (!file.endsWith('.meta.json')) continue;
        const mediaId = file.slice(0, -10);
        const metaPath = path.join(mediaDir, file);
        try {
          const raw = fs.readFileSync(metaPath, 'utf8');
          const meta = JSON.parse(raw);
          if (meta && meta.filePath && fs.existsSync(meta.filePath)) {
            mediaIndex.set(mediaId, meta);
            if (meta.waMessageId) {
              mediaByWaId.set(String(meta.waMessageId), mediaId);
            }
          }
        } catch {
          // ignore corrupted sidecar
        }
      }
    } catch (err) {
      logger?.warn({ err }, 'Failed to initialize media store from disk');
    }
  }

  initFromDisk();

  function evictOverflowMedia() {
    while (mediaIndex.size > MEDIA_INDEX_MAX) {
      const oldestId = mediaIndex.keys().next().value;
      const entry = mediaIndex.get(oldestId);
      mediaIndex.delete(oldestId);
      if (entry?.waMessageId) {
        mediaByWaId.delete(String(entry.waMessageId));
      }
      try {
        if (entry?.filePath && fs.existsSync(entry.filePath)) {
          fs.rmSync(entry.filePath, { force: true });
        }
        const metaPath = path.join(mediaDir, `${oldestId}.meta.json`);
        if (fs.existsSync(metaPath)) {
          fs.rmSync(metaPath, { force: true });
        }
      } catch (err) {
        logger?.warn({ err, mediaId: oldestId }, 'Media eviction cleanup failed');
      }
    }
  }

  function getMediaIdByWaId(waMessageId) {
    if (!waMessageId) return null;
    const strId = String(waMessageId);
    if (mediaByWaId.has(strId)) {
      const mediaId = mediaByWaId.get(strId);
      const entry = mediaIndex.get(mediaId);
      if (entry && entry.filePath && fs.existsSync(entry.filePath)) {
        return mediaId;
      }
    }
    return null;
  }

  function getMediaPath(sessionId, mediaId) {
    if (!mediaId) return null;
    const strMediaId = String(mediaId);
    let entry = mediaIndex.get(strMediaId);

    // If mediaId wasn't found directly, check if it's a waMessageId
    if (!entry && mediaByWaId.has(strMediaId)) {
      const mappedId = mediaByWaId.get(strMediaId);
      entry = mediaIndex.get(mappedId);
    }

    if (!entry) {
      const metaPath = path.join(mediaDir, `${strMediaId}.meta.json`);
      if (fs.existsSync(metaPath)) {
        try {
          const raw = fs.readFileSync(metaPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.filePath && fs.existsSync(parsed.filePath)) {
            entry = parsed;
            mediaIndex.set(strMediaId, entry);
            if (entry.waMessageId) {
              mediaByWaId.set(String(entry.waMessageId), strMediaId);
            }
          }
        } catch {
          entry = null;
        }
      }
    }

    // Direct filesystem check fallback (e.g. ${mediaId}.jpeg, ${mediaId}.mp4, etc.)
    if (!entry) {
      try {
        const files = fs.readdirSync(mediaDir);
        const match = files.find(f => f.startsWith(strMediaId) && !f.endsWith('.meta.json'));
        if (match) {
          const fullPath = path.join(mediaDir, match);
          entry = { filePath: fullPath, sessionId: sessionId ? String(sessionId) : '' };
          mediaIndex.set(strMediaId, entry);
        }
      } catch {
        // directory read failed
      }
    }

    if (!entry || !entry.filePath || !fs.existsSync(entry.filePath)) return null;
    // CRITICAL: Do NOT reject if entry.sessionId !== sessionId.
    // Downloaded media belongs to CRM conversations. Ephemeral QR re-links assign a new
    // sessionId, but historical messages still reference the persisted media files.
    return entry.filePath;
  }

  function storeMediaBuffer(sessionId, buffer, { mimeType, filename, waMessageId } = {}) {
    if (!buffer || !Buffer.isBuffer(buffer)) return null;
    const mediaId = uuidv4();
    const resolvedMime = mimeType || 'application/octet-stream';
    const ext = (resolvedMime.split('/')[1] || 'bin').split(';')[0];
    const resolvedFilename = filename || `media_${mediaId}.${ext}`;
    const filePath = path.join(mediaDir, `${mediaId}.${ext}`);
    fs.writeFileSync(filePath, buffer);
    const meta = {
      sessionId: String(sessionId || ''),
      waMessageId: waMessageId ? String(waMessageId) : null,
      filePath,
      mimeType: resolvedMime,
      filename: resolvedFilename,
      sizeBytes: buffer.length,
      savedAt: Date.now(),
    };
    const metaPath = path.join(mediaDir, `${mediaId}.meta.json`);
    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
    } catch (metaErr) {
      logger?.warn({ metaErr, mediaId }, 'Failed to write media sidecar metadata');
    }
    mediaIndex.set(mediaId, meta);
    if (waMessageId) {
      mediaByWaId.set(String(waMessageId), mediaId);
    }
    evictOverflowMedia();
    return { media_id: mediaId, mime_type: resolvedMime, filename: resolvedFilename, size_bytes: buffer.length };
  }

  async function storeIncomingMedia(session, waMessage, sock) {
    try {
      const waMessageId = waMessage?.key?.id;
      // If we already have this message's media on disk, reuse existing media_id!
      if (waMessageId && mediaByWaId.has(String(waMessageId))) {
        const existingMediaId = mediaByWaId.get(String(waMessageId));
        const existingEntry = mediaIndex.get(existingMediaId);
        if (existingEntry && existingEntry.filePath && fs.existsSync(existingEntry.filePath)) {
          return {
            media_id: existingMediaId,
            mime_type: existingEntry.mimeType,
            filename: existingEntry.filename,
            size_bytes: existingEntry.sizeBytes,
          };
        }
      }

      const resolved = resolveDownloadableMedia(waMessage?.message);
      if (!resolved) {
        logger?.debug(
          { waMessageId },
          'Medya indirilmedi: indirilebilir icerik bulunamadi'
        );
        return null;
      }
      const { media } = resolved;
      let buffer = null;
      try {
        buffer = await downloadMediaMessage(
          waMessage,
          'buffer',
          {},
          { logger, reuploadRequest: sock?.updateMediaMessage }
        );
      } catch (dlErr) {
        logger?.debug({ dlErr: dlErr?.message, waMessageId }, 'downloadMediaMessage failed, checking thumbnail');
      }

      let mimeType = media.mimetype || 'application/octet-stream';
      let filename = media.fileName || undefined;

      // Fallback: If full download failed (e.g. expired link on CDN), use jpegThumbnail as preview
      if (!buffer && media.jpegThumbnail) {
        const thumbBuf = Buffer.isBuffer(media.jpegThumbnail)
          ? media.jpegThumbnail
          : Buffer.from(media.jpegThumbnail);
        if (thumbBuf.length > 0) {
          buffer = thumbBuf;
          mimeType = 'image/jpeg';
          filename = filename || `thumb_${waMessageId || 'preview'}.jpeg`;
          logger?.info({ waMessageId }, 'Using jpegThumbnail fallback for media preview');
        }
      }

      if (!buffer) return null;
      return storeMediaBuffer(session?.id, buffer, { mimeType, filename, waMessageId });
    } catch (err) {
      logger?.warn({ err }, 'Failed to store incoming media');
      return null;
    }
  }

  function clearSessionMedia(sessionId) {
    // CRITICAL: Do NOT delete downloaded CRM conversation media files from disk upon
    // disconnect or logout. Disconnecting a WhatsApp line or relinking with QR code
    // intentionally preserves conversation history and media attachments. Eviction of
    // old media is managed safely via FIFO LRU (evictOverflowMedia) up to MEDIA_INDEX_MAX.
  }

  return {
    mediaIndex,
    mediaByWaId,
    getMediaPath,
    getMediaIdByWaId,
    storeIncomingMedia,
    storeMediaBuffer,
    evictOverflowMedia,
    clearSessionMedia,
  };
}
