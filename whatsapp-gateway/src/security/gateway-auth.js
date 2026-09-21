/**
 * Gateway API/WS authentication — fail-closed shared-secret middleware.
 *
 * The FastAPI backend authenticates with `Authorization: Bearer <secret>` or
 * `?token=<secret>` (WebSocket upgrades only support the query form). The
 * shared secret is `process.env.WHATSAPP_GATEWAY_SECRET`.
 *
 * FAIL-CLOSED: if the secret is unset/empty, EVERY protected request is
 * rejected (503). We never fail open — an unauthenticated gateway must not
 * silently become reachable.
 */
import crypto from 'crypto';

/** Resolve the expected secret; empty string means "auth not configured". */
function expectedSecret() {
  return typeof process.env.WHATSAPP_GATEWAY_SECRET === 'string'
    ? process.env.WHATSAPP_GATEWAY_SECRET
    : '';
}

/**
 * Timing-safe comparison of the presented token against the shared secret.
 * Returns false when either side is empty/invalid.
 */
function tokenIsValid(token) {
  const expected = expectedSecret();
  if (!expected || typeof token !== 'string' || !token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Extract the presented token from an Express request (header or query). */
function extractToken(req) {
  const header = req.headers && req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const queryToken = req.query && req.query.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return '';
}

/**
 * Express middleware protecting REST routes.
 * - 503 when WHATSAPP_GATEWAY_SECRET is not configured (fail-closed).
 * - 401 when the presented token is missing/invalid.
 */
export function requireGatewayToken(req, res, next) {
  if (!expectedSecret()) {
    return res.status(503).json({ error: 'gateway auth not configured' });
  }
  if (!tokenIsValid(extractToken(req))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

/**
 * Verifies an incoming WebSocket upgrade request (raw http.IncomingMessage).
 * Accepts `Authorization: Bearer <secret>` header or `?token=<secret>` query.
 * Returns true only when a valid secret is configured AND the token matches.
 */
export function verifyWsToken(req) {
  const expected = expectedSecret();
  if (!expected) return false;

  let token = '';
  const header = req.headers && req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length).trim();
  } else {
    try {
      const url = new URL(req.url || '', 'http://localhost');
      token = url.searchParams.get('token') || '';
    } catch {
      token = '';
    }
  }
  return tokenIsValid(token);
}