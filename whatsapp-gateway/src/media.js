/**
 * Media Router - serves locally-stored incoming media files.
 *
 * Incoming WhatsApp media is downloaded by the session manager and stored
 * under the gateway MEDIA_DIR. This router exposes them at
 * GET /media/:mediaId so the backend / frontend can display them.
 *
 * NOTE: In production this should sit behind an authenticated reverse proxy;
 * the FastAPI backend validates the caller before proxying here.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMediaRouter({ mediaDir, sessionManager }) {
  const router = express.Router();

  router.get('/:mediaId', (req, res) => {
    const { mediaId } = req.params;
    const filePath = sessionManager.getMediaPath(mediaId);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Media not found' });
    }
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Media-Id', mediaId);
    res.sendFile(filePath);
  });

  return router;
}