import crypto from 'node:crypto';

/**
 * Test stub for `@whiskeysockets/baileys/lib/Utils/crypto.js`.
 * `hmacSign` is imported at module load by the session manager.
 */
export function hmacSign(buffer, key) {
  return crypto.createHmac('sha256', key).update(buffer).digest();
}

export function aesDecryptGCM(ciphertext, key, iv, additionalData = Buffer.alloc(0)) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  const enc = ciphertext.slice(0, ciphertext.length - 16);
  const tag = ciphertext.slice(ciphertext.length - 16);
  decipher.setAAD(additionalData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export default { hmacSign, aesDecryptGCM };
