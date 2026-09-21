/**
 * Gateway API/WS authentication — fail-closed shared-secret middleware.
 *
 * Supports:
 * - Direct header: `X-Gateway-Secret: <secret>`
 * - Standard Authorization header: `Authorization: Bearer <secret>`
 * - Query param for WS handshake: `?token=<secret>`
 *
 * FAIL-CLOSED: if the secret is unset, empty, or shorter than 32 bytes,
 * every protected request is rejected (401/503).
 */
import crypto from 'crypto';

const SECRET_HEADER = 'x-gateway-secret';

export function requireGatewaySecret(value) {
  const secret = String(value || '').trim();
  if (!secret) {
    throw new Error('WHATSAPP_GATEWAY_SECRET must be configured.');
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('WHATSAPP_GATEWAY_SECRET must be at least 32 bytes.');
  }
  return secret;
}

export function expectedSecret() {
  return typeof process.env.WHATSAPP_GATEWAY_SECRET === 'string'
    ? process.env.WHATSAPP_GATEWAY_SECRET.trim()
    : '';
}

function suppliedSecret(req) {
  const direct = req?.headers?.[SECRET_HEADER];
  if (typeof direct === 'string' && direct) return direct.trim();

  const authorization = req?.headers?.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }

  try {
    return new URL(req?.url || '/', 'http://gateway.local').searchParams.get('token') || '';
  } catch {
    return '';
  }
}

export function authorizeGatewayRequest(req, secret) {
  const expected = typeof secret === 'string' ? secret.trim() : expectedSecret();
  if (!expected) return false;
  const candidate = suppliedSecret(req);
  if (!candidate) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const suppliedBuf = Buffer.from(candidate, 'utf8');
  if (suppliedBuf.length !== expectedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(suppliedBuf, expectedBuf);
  } catch {
    return false;
  }
}

export function createGatewayAuthMiddleware(expectedSecretValue, { publicPaths = new Set() } = {}) {
  return (req, res, next) => {
    if (publicPaths.has(req.path)) {
      next();
      return;
    }
    const secret = expectedSecretValue || expectedSecret();
    if (!secret) {
      res.status(503).json({ error: 'Gateway auth not configured' });
      return;
    }
    if (!authorizeGatewayRequest(req, secret)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Express middleware protecting REST routes.
 * - 503 when WHATSAPP_GATEWAY_SECRET is not configured (fail-closed).
 * - 401 when the presented token is missing/invalid.
 */
export function requireGatewayToken(req, res, next) {
  const secret = expectedSecret();
  if (!secret) {
    return res.status(503).json({ error: 'gateway auth not configured' });
  }
  if (!authorizeGatewayRequest(req, secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

/**
 * Verifies an incoming WebSocket upgrade request (raw http.IncomingMessage).
 * Accepts `X-Gateway-Secret`, `Authorization: Bearer <secret>`, or `?token=<secret>`.
 * Returns true only when a valid secret is configured AND the token matches.
 */
export function verifyWsToken(req) {
  const secret = expectedSecret();
  if (!secret) return false;
  return authorizeGatewayRequest(req, secret);
}
