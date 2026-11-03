import crypto from 'node:crypto';

/**
 * Test stub for `@whiskeysockets/baileys/lib/Utils/crypto.js`.
 * `hmacSign` is imported at module load by the session manager.
 */
export function hmacSign(buffer, key) {
  return crypto.createHmac('sha256', key).update(buffer).digest();
}

export default { hmacSign };
