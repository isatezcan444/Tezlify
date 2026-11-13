import { proto } from '@whiskeysockets/baileys';
import { aesDecryptGCM, hmacSign } from '@whiskeysockets/baileys/lib/Utils/crypto.js';
import { unwrapMessageContent } from '../messages/message-classifier.js';

const GCM_NONCE_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;

function safeTimestampMs(ts) {
  if (ts === null || ts === undefined) return Date.now();
  let num = NaN;
  if (typeof ts === 'number') {
    num = ts;
  } else if (typeof ts === 'string') {
    num = Number(ts);
  } else if (typeof ts?.toNumber === 'function') {
    num = ts.toNumber();
  } else if (typeof ts?.low === 'number' && typeof ts?.high === 'number') {
    num = ts.high * 4294967296 + (ts.low >>> 0);
  }
  return Number.isFinite(num) && num > 0 ? num : Date.now();
}

/**
 * Extracts messageContextInfo.messageSecret (or nested contextInfo.messageSecret)
 * from a Baileys WAMessage.message object.
 */
export function extractMessageSecret(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return null;
  const unwrapped = unwrapMessageContent(rawMessage) || rawMessage;
  const direct =
    rawMessage.messageContextInfo?.messageSecret ||
    rawMessage.message?.messageContextInfo?.messageSecret ||
    unwrapped?.messageContextInfo?.messageSecret;
  if (direct && Buffer.from(direct).length > 0) {
    return Buffer.from(direct);
  }
  for (const source of [rawMessage, rawMessage.message, unwrapped]) {
    if (!source || typeof source !== 'object') continue;
    for (const k of Object.keys(source)) {
      const secret = source[k]?.contextInfo?.messageSecret;
      if (secret && Buffer.from(secret).length > 0) {
        return Buffer.from(secret);
      }
    }
  }
  return null;
}

/**
 * Parses a decoded SecretEncryptedMessage object, raw protobuf Buffer/Uint8Array
 * (`proto.Message` or `proto.Message.SecretEncryptedMessage`), or a BinaryNode
 * stanza carrying `<enc type="msmsg">` protobuf bytes.
 * Fails closed on malformed buffers or non-MESSAGE_EDIT types.
 */
export function decodeMsmsgProtobufPayload(input) {
  if (!input) return { ok: false, reason: 'empty_input', secEnc: null };

  let candidate = input;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    try {
      const msgDecoded = proto.Message.decode(input);
      if (msgDecoded?.secretEncryptedMessage) {
        candidate = msgDecoded.secretEncryptedMessage;
      } else if (msgDecoded?.deviceSentMessage?.message?.secretEncryptedMessage) {
        candidate = msgDecoded.deviceSentMessage.message.secretEncryptedMessage;
      } else {
        const directSec = proto.Message.SecretEncryptedMessage.decode(input);
        candidate = directSec;
      }
    } catch {
      return { ok: false, reason: 'invalid_protobuf', secEnc: null };
    }
  } else if (typeof input === 'object' && input.tag === 'message') {
    const contentNodes = Array.isArray(input.content) ? input.content : [];
    const msmsgEnc = contentNodes.find(
      (c) => c && c.tag === 'enc' && String(c.attrs?.type || '').toLowerCase() === 'msmsg',
    );
    if (!msmsgEnc || !(Buffer.isBuffer(msmsgEnc.content) || msmsgEnc.content instanceof Uint8Array)) {
      return { ok: false, reason: 'missing_msmsg_enc_bytes', secEnc: null };
    }
    try {
      const msgDecoded = proto.Message.decode(msmsgEnc.content);
      if (msgDecoded?.secretEncryptedMessage) {
        candidate = msgDecoded.secretEncryptedMessage;
      } else {
        candidate = proto.Message.SecretEncryptedMessage.decode(msmsgEnc.content);
      }
    } catch {
      return { ok: false, reason: 'unsupported_or_invalid_msmsg_wire_payload', secEnc: null };
    }
  } else if (typeof input === 'object' && input.secretEncryptedMessage) {
    candidate = input.secretEncryptedMessage;
  }

  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'missing_secret_encrypted_message', secEnc: null };
  }

  const secType = Number(candidate.secretEncType);
  if (secType !== 2 && String(candidate.secretEncType) !== 'MESSAGE_EDIT') {
    return { ok: false, reason: 'unsupported_secret_enc_type', secEnc: candidate };
  }

  const targetWaId = candidate.targetMessageKey?.id ? String(candidate.targetMessageKey.id) : '';
  if (!targetWaId) {
    return { ok: false, reason: 'missing_target_message_id', secEnc: candidate };
  }

  if (!candidate.encIv || Buffer.from(candidate.encIv).length !== GCM_NONCE_BYTES) {
    return { ok: false, reason: 'invalid_iv_length', secEnc: candidate };
  }

  if (!candidate.encPayload || Buffer.from(candidate.encPayload).length <= GCM_AUTH_TAG_BYTES) {
    return { ok: false, reason: 'invalid_ciphertext_length', secEnc: candidate };
  }

  return { ok: true, reason: null, secEnc: candidate };
}

/**
 * Derives the AES-256-GCM decryption key for SecretEncryptedMessage (MESSAGE_EDIT = 2)
 * using Baileys hmacSign primitives and WhatsApp's "Message Edit" domain separator.
 */
export function deriveMessageEditDecryptionKey(msgSecret, { targetWaId, senderJid }) {
  const secretBuf = Buffer.isBuffer(msgSecret) ? msgSecret : Buffer.from(msgSecret);
  const toBinary = (txt) => Buffer.from(String(txt), 'utf8');
  const senderBuf = toBinary(senderJid);
  const sign = Buffer.concat([
    toBinary(targetWaId),
    senderBuf,
    senderBuf,
    toBinary('Message Edit'),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(secretBuf, new Uint8Array(32), 'sha256');
  return hmacSign(sign, key0, 'sha256');
}

/**
 * Verifies authentication tag + decrypts SecretEncryptedMessage(MESSAGE_EDIT)
 * into a standard Baileys ProtocolMessage (type = 14) container.
 */
export function decryptSecretMessageEditPayload({
  secEnc,
  msgSecret,
  senderJid,
  targetWaId,
  targetChatJid,
  timestampMs = null,
  expectedTargetId = null,
}) {
  if (!secEnc || !msgSecret || !targetWaId || !senderJid) {
    throw new Error('Missing cryptographic parameters for MESSAGE_EDIT decryption.');
  }
  if (expectedTargetId && String(expectedTargetId) !== String(targetWaId)) {
    throw new Error('Target message ID mismatch against envelope context.');
  }
  const ivBuf = Buffer.from(secEnc.encIv);
  const payloadBuf = Buffer.from(secEnc.encPayload);
  if (ivBuf.length !== GCM_NONCE_BYTES) {
    throw new Error('Invalid AES-GCM IV length.');
  }
  if (payloadBuf.length <= GCM_AUTH_TAG_BYTES) {
    throw new Error('Ciphertext shorter than authentication tag.');
  }

  const decKey = deriveMessageEditDecryptionKey(msgSecret, { targetWaId, senderJid });
  const decrypted = aesDecryptGCM(payloadBuf, decKey, ivBuf, Buffer.alloc(0));
  const innerMsg = proto.Message.decode(decrypted);
  if (!innerMsg || typeof innerMsg !== 'object' || Object.keys(innerMsg).length === 0) {
    throw new Error('Decrypted protobuf message is empty.');
  }

  return {
    protocolMessage: {
      type: 14,
      key: secEnc.targetMessageKey || { id: targetWaId, remoteJid: targetChatJid, fromMe: true },
      editedMessage: innerMsg,
      timestampMs: safeTimestampMs(timestampMs),
    },
  };
}

