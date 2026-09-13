import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;

function aadBuffer(context) {
  return Buffer.from(String(context), 'utf8');
}

export function createEncryptedCodec(encryptionKey, { keyVersion = 1 } = {}) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
    throw new Error('Encrypted codec requires a 32-byte key.');
  }

  return {
    keyVersion,

    blindIndex(value) {
      return crypto.createHmac('sha256', encryptionKey).update(String(value)).digest('hex');
    },

    encrypt(plaintext, context) {
      const nonce = crypto.randomBytes(NONCE_BYTES);
      const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, nonce);
      cipher.setAAD(aadBuffer(context));
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(String(plaintext), 'utf8')),
        cipher.final(),
      ]);
      return {
        ciphertext,
        nonce,
        authTag: cipher.getAuthTag(),
        keyVersion,
      };
    },

    decrypt(record, context) {
      if (Number(record.key_version ?? record.keyVersion) !== keyVersion) {
        throw new Error('Unsupported WhatsApp encryption key version.');
      }
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        encryptionKey,
        Buffer.from(record.nonce),
      );
      decipher.setAAD(aadBuffer(context));
      decipher.setAuthTag(Buffer.from(record.auth_tag ?? record.authTag));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
