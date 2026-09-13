import crypto from 'crypto';
import pino from 'pino';

const diagnosticsEnabled = String(process.env.WHATSAPP_DIAGNOSTICS || 'true').toLowerCase() !== 'false';
const diagnosticLogger = pino({
  level: diagnosticsEnabled ? 'info' : 'silent',
  base: { component: 'whatsapp-diagnostics' },
});

/** Stable correlation key that does not expose the gateway session UUID. */
export function sessionRef(sessionId) {
  if (!sessionId) return null;
  return crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12);
}

/** Low-volume structured diagnostic event. Never pass QR, phone, JID or auth material. */
export function diagnostic(event, fields = {}) {
  diagnosticLogger.info({ event, ...fields }, event);
}
