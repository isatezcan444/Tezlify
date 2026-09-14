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

const latencyLogger = pino({
  level: process.env.WHATSAPP_LATENCY_PROFILING === 'true' ? 'info' : 'silent',
  base: { component: 'whatsapp-latency' },
});

/** Only fixed metric names, opaque session hashes and monotonic durations. */
export function latency(metric, started, sessionId) {
  if (process.env.WHATSAPP_LATENCY_PROFILING !== 'true') return;
  latencyLogger.info({ metric, duration_ms: performance.now() - started,
    session_ref: sessionRef(sessionId), epoch_ms: Date.now() });
}
