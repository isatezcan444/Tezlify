/**
 * HTTP media routes.
 *
 * Kept in its own module so the REAL route handlers can be mounted on an
 * isolated Express app in tests (no production-style server, no live Baileys
 * session). Both routes resolve the file, verify it and stream it through a
 * single open file descriptor: the bytes on the wire are exactly the bytes
 * whose SHA-256 was just checked, closing the verify→send TOCTOU window.
 *
 * Paths and file names never appear in responses or logs — only status codes
 * and stable error codes.
 */

/**
 * Express 4 does NOT await or catch promises returned by async route
 * handlers: a rejection becomes an unhandledRejection and the request hangs.
 * Every handler below goes through this wrapper so a rejection always
 * terminates the response exactly once.
 */
export function asyncHandler(handler) {
  return function routeHandler(req, res) {
    return Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        if (!res.headersSent) {
          try {
            return res
              .status(500)
              .json({ error: 'Media request failed', code: 'MEDIA_REQUEST_ERROR' });
          } catch {
            // fall through and destroy the connection
          }
        }
        try {
          res.destroy();
        } catch {
          // connection already gone
        }
        return undefined;
      });
  };
}

function mediaSessionGuard(sessionManager) {
  return (handler) => asyncHandler(async (req, res) => {
    const sessionId = req.params.sessionId;
    if (!sessionManager.getSession(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await handler(req, res, sessionId);
  });
}

export function registerMediaRoutes(app, { sessionManager, logger }) {
  const guarded = mediaSessionGuard(sessionManager);

  async function serveVerifiedMedia(req, res, sessionId, lookupId, options) {
    let filePath = null;
    try {
      filePath = await sessionManager.resolveMediaPath(sessionId, lookupId);
    } catch (err) {
      logger?.error({ err: err?.code || err?.message }, 'Media path resolution failed');
      return res.status(500).json({ error: 'Media lookup failed', code: 'MEDIA_LOOKUP_ERROR' });
    }
    if (!filePath) {
      try {
        filePath = await sessionManager.downloadMediaOnDemand(sessionId, lookupId, options);
      } catch (err) {
        logger?.error({ err: err?.code || err?.message }, 'On-demand media download failed');
        return res.status(500).json({ error: 'Media lookup failed', code: 'MEDIA_LOOKUP_ERROR' });
      }
    }
    if (!filePath) return res.status(404).json({ error: 'Media not found', code: 'MEDIA_EXPIRED' });

    let verified;
    try {
      verified = await sessionManager.openVerifiedMedia(lookupId, filePath);
    } catch (err) {
      logger?.error({ err: err?.code || err?.message }, 'Media integrity verification failed');
      return res.status(500).json({ error: 'Media integrity verification failed', code: 'MEDIA_VERIFY_ERROR' });
    }
    if (!verified?.ok) {
      if (verified?.reason === 'MISSING') {
        return res.status(404).json({ error: 'Media not found', code: 'MEDIA_EXPIRED' });
      }
      if (verified?.reason === 'INVALID_MIME') {
        // Metadata is unusable and was rejected BEFORE any FD was opened.
        return res.status(422).json({ error: 'Media metadata invalid', code: 'MEDIA_INVALID_METADATA' });
      }
      return res.status(422).json({ error: 'Media integrity check failed', code: 'MEDIA_CORRUPTED' });
    }

    const { stream, size } = verified;
    try {
      res.status(200);
      res.setHeader('Content-Type', verified.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', String(size));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      // Legacy (no sidecar hash) is served for backward compatibility but is
      // NOT reported as hash-verified.
      res.setHeader('X-Media-Integrity', verified.legacy ? 'legacy' : 'verified');
    } catch (err) {
      // A header failure must not leak the FD handed over with the stream.
      try {
        stream.destroy();
      } catch {
        // already closed
      }
      logger?.error({ err: err?.code || err?.message }, 'Media response header failed');
      if (!res.headersSent) {
        // A partially written header set can carry the media Content-Length
        // into the error body and truncate it. Retract every media header.
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Length');
        res.removeHeader('Cache-Control');
        res.removeHeader('X-Media-Integrity');
        return res.status(500).json({ error: 'Media response failed', code: 'MEDIA_RESPONSE_ERROR' });
      }
      return res.destroy();
    }

    // If the client is already gone, close the FD instead of leaking it when
    // the stream would never be consumed.
    if (res.destroyed || res.writableEnded) {
      stream.destroy();
      return;
    }

    if (req.method === 'HEAD') {
      stream.destroy();
      return res.end();
    }

    let settled = false;
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      logger?.error({ err: err?.code || err?.message }, 'Media stream failed');
      if (res.headersSent) {
        // Bytes already on the wire: terminate instead of pretending success.
        res.destroy();
      } else {
        // No byte was written yet: retract the success headers before the
        // error body, otherwise a stale Content-Length would truncate it.
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Length');
        res.removeHeader('Cache-Control');
        res.removeHeader('X-Media-Integrity');
        res.status(500).json({ error: 'Media stream failed', code: 'MEDIA_STREAM_ERROR' });
      }
    });
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.pipe(res);
  }

  // Download media by media_id or wa_message_id (with on-demand fallback)
  app.get('/sessions/:sessionId/media/:mediaId', guarded(async (req, res, sessionId) => {
    const preferPreview = req.query.preview === 'true';
    const retry = Boolean(req.query._retry || req.query.retry || req.query.force);
    const jid = req.query.jid ? String(req.query.jid) : null;
    const fromMe = req.query.from_me === 'true' || req.query.from_me === '1';
    await serveVerifiedMedia(req, res, sessionId, req.params.mediaId, { preferPreview, retry, jid, fromMe });
  }));

  // Unscoped media route for authorized callers
  app.get('/media/:mediaId', asyncHandler(async (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') || req.headers['x-gateway-secret'] || '';
    if (!process.env.WHATSAPP_GATEWAY_SECRET || token !== process.env.WHATSAPP_GATEWAY_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const preferPreview = req.query.preview === 'true';
    const retry = Boolean(req.query._retry || req.query.retry || req.query.force);
    const jid = req.query.jid ? String(req.query.jid) : null;
    const fromMe = req.query.from_me === 'true' || req.query.from_me === '1';
    await serveVerifiedMedia(req, res, null, req.params.mediaId, { preferPreview, retry, jid, fromMe });
  }));
}
