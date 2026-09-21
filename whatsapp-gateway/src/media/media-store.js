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

  function evictOverflowMedia() {
    while (mediaIndex.size > MEDIA_INDEX_MAX) {
      const oldestId = mediaIndex.keys().next().value;
      const entry = mediaIndex.get(oldestId);
      mediaIndex.delete(oldestId);
      try {
        if (entry?.filePath && fs.existsSync(entry.filePath)) {
          fs.rmSync(entry.filePath, { force: true });
        }
        const metaPath = path.join(mediaDir, `${oldestId}.meta.json`);
        if (fs.existsSync(metaPath)) {
          fs.rmSync(metaPath, { force: true });
        }
      } catch (err) {
        logger.warn({ err, mediaId: oldestId }, 'Media eviction cleanup failed');
      }
    }
  }

  function getMediaPath(sessionId, mediaId) {
    if (!mediaId) return null;
    let entry = mediaIndex.get(mediaId);
    if (!entry) {
      const metaPath = path.join(mediaDir, `${mediaId}.meta.json`);
      if (fs.existsSync(metaPath)) {
        try {
          const raw = fs.readFileSync(metaPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.filePath && fs.existsSync(parsed.filePath)) {
            entry = parsed;
            mediaIndex.set(mediaId, entry);
          }
        } catch {
          entry = null;
        }
      }
    }
    if (!entry) return null;
    if (!sessionId || entry.sessionId !== String(sessionId)) return null;
    return entry.filePath || null;
  }

  async function storeIncomingMedia(session, waMessage, sock) {
    try {
      const resolved = resolveDownloadableMedia(waMessage?.message);
      if (!resolved) {
        logger.debug(
          { waMessageId: waMessage?.key?.id },
          'Medya indirilmedi: indirilebilir icerik bulunamadi'
        );
        return null;
      }
      const { media } = resolved;
      const buffer = await downloadMediaMessage(
        waMessage,
        'buffer',
        {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      );
      if (!buffer) return null;
      const mediaId = uuidv4();
      const mimeType = media.mimetype || 'application/octet-stream';
      const ext = (mimeType.split('/')[1] || 'bin').split(';')[0];
      const filename = media.fileName || `media_${mediaId}.${ext}`;
      const filePath = path.join(mediaDir, `${mediaId}.${ext}`);
      fs.writeFileSync(filePath, buffer);
      const meta = {
        sessionId: String(session?.id || ''),
        filePath,
        mimeType,
        filename,
        sizeBytes: buffer.length,
        savedAt: Date.now(),
      };
      const metaPath = path.join(mediaDir, `${mediaId}.meta.json`);
      try {
        fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
      } catch (metaErr) {
        logger.warn({ metaErr, mediaId }, 'Failed to write media sidecar metadata');
      }
      mediaIndex.set(mediaId, meta);
      evictOverflowMedia();
      return { media_id: mediaId, mime_type: mimeType, filename, size_bytes: buffer.length };
    } catch (err) {
      logger.warn({ err }, 'Failed to store incoming media');
      return null;
    }
  }

  function clearSessionMedia(sessionId) {
    for (const [mediaId, entry] of mediaIndex) {
      if (entry?.sessionId !== String(sessionId)) continue;
      try {
        if (entry.filePath && fs.existsSync(entry.filePath)) {
          fs.rmSync(entry.filePath, { force: true });
        }
      } catch (err) {
        logger.warn({ err, mediaId }, 'Session media cleanup failed');
      }
      mediaIndex.delete(mediaId);
    }
  }

  return {
    mediaIndex,
    getMediaPath,
    storeIncomingMedia,
    evictOverflowMedia,
    clearSessionMedia,
  };
}
