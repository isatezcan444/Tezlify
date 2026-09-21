/**
 * Baileys Pino Logger Proxy.
 *
 * Suppresses handshake retries, prekey exchanges, and stream resets from polluting
 * error-level logs while preserving authentic errors at level 50.
 */
import pino from 'pino';

export const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

export function extractBaileysErrorDetails(obj) {
  if (!obj) return '';
  if (obj instanceof Error) return `${obj.message} ${obj.stack || ''}`;
  if (typeof obj === 'string') return obj;
  const parts = [];
  if (obj.err) parts.push(extractBaileysErrorDetails(obj.err));
  if (obj.error) parts.push(extractBaileysErrorDetails(obj.error));
  if (obj.message) parts.push(String(obj.message));
  if (obj.msg) parts.push(String(obj.msg));
  if (obj.output?.payload?.message) parts.push(String(obj.output.payload.message));
  if (obj.payload?.message) parts.push(String(obj.payload.message));
  if (obj.data) parts.push(typeof obj.data === 'string' ? obj.data : JSON.stringify(obj.data));
  return parts.join(' ');
}

export function createBaileysLogger(baseLogger) {
  return new Proxy(baseLogger, {
    get(target, prop, receiver) {
      if (prop === 'error') {
        return function (obj, msg, ...args) {
          const msgStr = typeof obj === 'string' ? obj : (msg || obj?.msg || '');
          const objErrStr = extractBaileysErrorDetails(obj);
          const fullText = `${msgStr} ${objErrStr}`.toLowerCase();
          const isHandshakeRetry =
            fullText.includes('failed to decrypt message') ||
            fullText.includes("unexpected error in 'init queries'") ||
            fullText.includes("unexpected error in 'handling notification'") ||
            fullText.includes('failed to check/upload pre-keys') ||
            fullText.includes('pre-key') ||
            fullText.includes('prekey') ||
            fullText.includes('stream errored out') ||
            fullText.includes('error in handling message') ||
            fullText.includes('bad mac') ||
            fullText.includes('no matching sessions');

          if (isHandshakeRetry) {
            const errSummary = objErrStr || (typeof obj === 'object' && obj !== null ? obj?.msg : '') || msgStr;
            const remoteJid = typeof obj === 'object' && obj !== null ? (obj.key?.remoteJid || '') : '';
            return target.debug(
              { key: remoteJid ? { remoteJid } : undefined, err: errSummary },
              `[baileys-handshake] ${msgStr || errSummary}`
            );
          }
          return target.error(obj, msg, ...args);
        };
      }
      if (prop === 'child') {
        return function (bindings) {
          const childLogger = target.child(bindings);
          return createBaileysLogger(childLogger);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}
