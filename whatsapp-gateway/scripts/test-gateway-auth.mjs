import assert from 'node:assert/strict';

import {
  authorizeGatewayRequest,
  createGatewayAuthMiddleware,
  requireGatewaySecret,
} from '../src/security/gateway-auth.js';

const secret = 'test-shared-secret-with-at-least-32-bytes';

assert.equal(requireGatewaySecret(secret), secret);
assert.throws(() => requireGatewaySecret(''), /WHATSAPP_GATEWAY_SECRET/);
assert.throws(() => requireGatewaySecret('too-short'), /at least 32/);

assert.equal(authorizeGatewayRequest({ headers: { 'x-gateway-secret': secret }, url: '/sessions' }, secret), true);
assert.equal(authorizeGatewayRequest({ headers: { authorization: `Bearer ${secret}` }, url: '/sessions' }, secret), true);
assert.equal(authorizeGatewayRequest({ headers: {}, url: `/ws?token=${encodeURIComponent(secret)}` }, secret), true);
assert.equal(authorizeGatewayRequest({ headers: { 'x-gateway-secret': 'wrong' }, url: '/sessions' }, secret), false);
assert.equal(authorizeGatewayRequest({ headers: {}, url: '/sessions' }, secret), false);

const middleware = createGatewayAuthMiddleware(secret, { publicPaths: new Set(['/health']) });

let nextCalled = false;
middleware({ path: '/health', headers: {} }, {}, () => { nextCalled = true; });
assert.equal(nextCalled, true, 'public liveness path must remain reachable');

let statusCode = null;
let responseBody = null;
middleware(
  { path: '/sessions', headers: {} },
  {
    status(code) { statusCode = code; return this; },
    json(body) { responseBody = body; },
  },
  () => { throw new Error('unauthorized request reached next()'); },
);
assert.equal(statusCode, 401);
assert.deepEqual(responseBody, { error: 'Unauthorized' });

console.log('[test-gateway-auth] fail-closed REST/WS authentication passed');
