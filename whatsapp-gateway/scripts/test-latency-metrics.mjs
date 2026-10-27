/**
 * Latency metric contract — proves the QR/sync timers actually emit, and that
 * they emit nothing they must not.
 *
 * WHY
 * ---
 * `observability.latency()` is gated on `WHATSAPP_LATENCY_PROFILING === 'true'`
 * and that variable is NOT set in production (nor in docker-compose.prod.yml),
 * so all three metrics — `socket_start_to_provider_qr_ms`,
 * `qr_generation_ms`, `socket_start_to_ready_ms` — are silent there. The
 * instrumentation is correct; it is simply switched off, which is why a
 * "measure the QR pairing" task finds no numbers to read.
 *
 * Nothing in the suite covered this, so the two things that can silently rot
 * were unpinned:
 *   1. the metric name / payload shape (an operator greps by name), and
 *   2. the privacy rule — the payload carries an OPAQUE `session_ref` hash and
 *      must never contain the raw gateway session UUID, a QR, a phone or a JID.
 *
 * Each case runs in a child process because the pino logger's level is fixed at
 * module load: toggling the env var in-process would not change it, and a test
 * that cannot turn the metric on cannot prove the metric works.
 *
 * Run: node scripts/test-latency-metrics.mjs
 */

import { spawnSync } from 'node:child_process';

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok - ${label}`);
  } else {
    console.log(`  FAIL - ${label}${detail ? ` :: ${detail}` : ''}`);
    failures.push(label);
  }
}

const SESSION_ID = '7c73505f-6aa7-4703-beb7-448f99d41cee';

// Emits one metric the way the socket handlers do: `latency(name, started, id)`
// where `started` is a monotonic `performance.now()` reading.
const CHILD = `
import { latency } from './src/observability.js';
const started = performance.now();
latency('socket_start_to_provider_qr_ms', started, ${JSON.stringify(SESSION_ID)});
await new Promise((r) => setTimeout(r, 50));
`;

function run(flag) {
  const env = { ...process.env };
  delete env.WHATSAPP_LATENCY_PROFILING;
  if (flag) env.WHATSAPP_LATENCY_PROFILING = 'true';
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
    encoding: 'utf8',
  });
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

// --- case 1: flag off (the production default) -------------------------------
{
  const { out } = run(false);
  check(
    'flag off emits no latency line (production default is silent)',
    !out.includes('socket_start_to_provider_qr_ms'),
    out.trim().slice(0, 200),
  );
}

// --- case 2: flag on --------------------------------------------------------
{
  const { status, out } = run(true);
  check('child exited cleanly', status === 0, `status=${status}`);

  const line = out.split('\n').find((l) => l.includes('socket_start_to_provider_qr_ms')) || '';
  check('the metric is emitted under its documented name', Boolean(line), out.trim().slice(0, 300));

  let payload = null;
  try {
    payload = JSON.parse(line);
  } catch {
    // fall through: asserted below
  }
  check('the metric line is valid JSON', payload !== null, line.slice(0, 200));

  if (payload) {
    check(
      'duration_ms is a non-negative number',
      typeof payload.duration_ms === 'number' && payload.duration_ms >= 0,
      JSON.stringify(payload.duration_ms),
    );
    check('the payload is tagged as a latency sample', payload.component === 'whatsapp-latency', String(payload.component));
    check(
      'session_ref is the opaque 12-char hash, not the session UUID',
      typeof payload.session_ref === 'string'
        && payload.session_ref.length === 12
        && payload.session_ref !== SESSION_ID,
      JSON.stringify(payload.session_ref),
    );
    check(
      'the raw session id never reaches the log',
      !line.includes(SESSION_ID),
      'session UUID leaked into the metric line',
    );
    check(
      'no QR / phone / JID material in the payload',
      !/@s\.whatsapp\.net|@lid|@g\.us|\+90|qr_code|base64/i.test(line),
      line.slice(0, 300),
    );
  }
}

console.log('');
if (failures.length) {
  console.log(`[test-latency-metrics] ${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('[test-latency-metrics] All assertions passed.');
