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

// ---------------------------------------------------------------------------
// Latency metrics — ON BY DEFAULT.
//
// Phase 2 measured that `WHATSAPP_LATENCY_PROFILING` was NOT set in production
// (printenv -> NOT_SET, and absent from docker-compose.prod.yml), so all three
// metrics below were silent there. The instrumentation was correct; it was
// simply switched off. That made "measure the QR pairing" unanswerable: there
// was no number to read, only a pino line that dies with the container.
//
// So the default flips: measurement is on unless someone explicitly turns it
// off with `WHATSAPP_LATENCY_PROFILING=false`. The cost argument that motivated
// the old default does not hold up — these are ~6 lines per socket lifetime,
// only on connection events, never per message. An operator who needs silence
// can still get it, but must now say so.
//
// The backend owns the durable, queryable version of this measurement
// (`whatsapp_connect_stages`), because a gateway recreate costs the in-memory
// chat store (§A6) and measurement must never require that. This logger is the
// log-side view of the same stages; `session_ref` is the join key between them
// and is an opaque hash on both sides, never the session UUID.
// ---------------------------------------------------------------------------
const latencyEnabled =
  String(process.env.WHATSAPP_LATENCY_PROFILING ?? 'true').toLowerCase() !== 'false';

const latencyLogger = pino({
  level: latencyEnabled ? 'info' : 'silent',
  base: { component: 'whatsapp-latency' },
});

/** True when latency metrics are being emitted. Lets a caller skip timing work. */
export function latencyEnabledNow() {
  return latencyEnabled;
}

/**
 * Emit one duration sample.
 *
 * Only fixed metric names, an opaque session hash and monotonic durations.
 * `extra` exists so a caller can attach an opaque attempt/connection reference
 * and a small outcome code — never a JID, a phone, a QR or a message body.
 */
export function latency(metric, started, sessionId, extra = null) {
  if (!latencyEnabled) return;
  const payload = {
    metric,
    duration_ms: performance.now() - started,
    session_ref: sessionRef(sessionId),
    epoch_ms: Date.now(),
  };
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      // Scalars only: an object/array here is almost always a leaked payload.
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        payload[key] = typeof value === 'string' ? value.slice(0, 64) : value;
      }
    }
  }
  latencyLogger.info(payload);
}
