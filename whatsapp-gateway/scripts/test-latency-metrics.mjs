/**
 * Latency metric contract — proves the QR/sync timers actually emit, and that
 * they emit nothing they must not.
 *
 * WHY
 * ---
 * Phase 2 measured that `WHATSAPP_LATENCY_PROFILING` was NOT set in production
 * (printenv -> NOT_SET, and absent from docker-compose.prod.yml), so all three
 * metrics — `socket_start_to_provider_qr_ms`, `qr_generation_ms`,
 * `socket_start_to_ready_ms` — were silent there. The instrumentation was
 * correct; it was simply switched off. That is why a "measure the QR pairing"
 * task had no numbers to read.
 *
 * Phase 3 therefore flips the default to ON, with an explicit opt-out. This
 * test pins the new contract in BOTH directions, because a default that is
 * silently wrong is the same defect one level down:
 *
 *   unset  -> emits   (a fresh install measures without configuring anything)
 *   'true' -> emits   (the old opt-in still works)
 *   'false'-> silent  (the opt-out is real, not decorative)
 *
 * It also pins the two things that can silently rot:
 *   1. the metric name / payload shape (an operator greps by name), and
 *   2. the privacy rule — the payload carries an OPAQUE `session_ref` hash and
 *      must never contain the raw gateway session UUID, a QR, a phone or a JID.
 *
 * Each case runs in a child process because pino's level is fixed at module
 * load: toggling the env var in-process would not change it, and a test that
 * cannot turn the metric on cannot prove the metric works.
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
import { latency, latencyEnabledNow } from './src/observability.js';
console.log('__enabled=' + latencyEnabledNow());
const started = performance.now();
latency('socket_start_to_provider_qr_ms', started, ${JSON.stringify(SESSION_ID)});
await new Promise((r) => setTimeout(r, 50));
`;

/**
 * `flag` is the RAW value to put in the env var. `undefined` means "unset",
 * which is the case that matters most: it is what a fresh production container
 * looks like.
 */
function run(flag) {
  const env = { ...process.env };
  delete env.WHATSAPP_LATENCY_PROFILING;
  if (flag !== undefined) env.WHATSAPP_LATENCY_PROFILING = flag;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
    encoding: 'utf8',
  });
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function metricLine(out) {
  return out.split('\n').find((l) => l.includes('socket_start_to_provider_qr_ms')) || '';
}

// --- case 1: env var UNSET (a fresh production container) --------------------
// This is the case Phase 2 got wrong: unset used to mean "off".
{
  const { status, out } = run(undefined);
  check('unset: child exited cleanly', status === 0, `status=${status}`);
  check(
    'unset: metric IS emitted (measurement is on by default)',
    Boolean(metricLine(out)),
    out.trim().slice(0, 240),
  );
  check(
    'unset: the module reports itself as enabled',
    out.includes('__enabled=true'),
    out.trim().slice(0, 120),
  );
}

// --- case 2: explicit opt-out ------------------------------------------------
{
  const { out } = run('false');
  check(
    "explicit 'false' emits no latency line",
    !out.includes('socket_start_to_provider_qr_ms'),
    out.trim().slice(0, 200),
  );
  check(
    "explicit 'false' reports itself as disabled",
    out.includes('__enabled=false'),
    out.trim().slice(0, 120),
  );
}

// --- case 3: legacy opt-in still works --------------------------------------
{
  const { status, out } = run('true');
  check("explicit 'true': child exited cleanly", status === 0, `status=${status}`);

  const line = metricLine(out);
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

// --- case 4: `extra` may carry scalars, must drop structured payloads --------
// The new `extra` argument is the one place a caller could accidentally attach
// a message object. Prove it is filtered rather than serialised.
{
  const EXTRA_CHILD = `
import { latency } from './src/observability.js';
latency('socket_start_to_provider_qr_ms', performance.now(), ${JSON.stringify(SESSION_ID)}, {
  outcome: 'connected',
  attempt_ref: 'abc123def456',
  leaked_message: { body: 'merhaba', jid: '905551112233@s.whatsapp.net' },
});
`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', EXTRA_CHILD], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, WHATSAPP_LATENCY_PROFILING: 'true' },
    encoding: 'utf8',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const line = metricLine(out);
  check('extra: line still emitted', Boolean(line), out.trim().slice(0, 240));
  check('extra: scalar outcome is kept', line.includes('"outcome":"connected"'), line.slice(0, 240));
  check('extra: opaque attempt_ref is kept', line.includes('"attempt_ref":"abc123def456"'), line.slice(0, 240));
  check(
    'extra: a nested object is DROPPED, not serialised',
    !line.includes('leaked_message') && !line.includes('merhaba') && !line.includes('@s.whatsapp.net'),
    line.slice(0, 300),
  );
}

console.log('');
if (failures.length) {
  console.log(`[test-latency-metrics] ${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('[test-latency-metrics] All assertions passed.');
