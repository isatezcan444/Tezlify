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

function suppliedSecret(req) {
  const direct = req?.headers?.[SECRET_HEADER];
  if (typeof direct === 'string' && direct) return direct;

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

export function authorizeGatewayRequest(req, expectedSecret) {
  const candidate = suppliedSecret(req);
  if (!candidate) return false;
  const expected = Buffer.from(expectedSecret, 'utf8');
  const supplied = Buffer.from(candidate, 'utf8');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function createGatewayAuthMiddleware(expectedSecret, { publicPaths = new Set() } = {}) {
  return (req, res, next) => {
    if (publicPaths.has(req.path)) {
      next();
      return;
    }
    if (!authorizeGatewayRequest(req, expectedSecret)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

