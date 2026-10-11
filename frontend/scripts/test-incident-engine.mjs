import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-incident-test-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  `export {
    normalizeLogPattern,
    groupLogsIntoIncidents,
    computeExecutiveSummary,
  } from '${SRC}/components/admin/ops/incidentEngine';`,
  'utf8',
);

await build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
});

const {
  normalizeLogPattern,
  groupLogsIntoIncidents,
  computeExecutiveSummary,
} = await import(`file://${out}`);

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

try {
  check('normalizeLogPattern strips timestamps, UUIDs, IPs and line numbers', () => {
    const line1 = '2026-10-11T22:58:10.000Z [ERROR] Failed to connect to 127.0.0.11:53 with id 123e4567-e89b-12d3-a456-426614174000:line 45';
    const line2 = '2026-10-11T23:15:22.000Z [ERROR] Failed to connect to 10.0.0.2:8080 with id 987e4567-e89b-12d3-a456-426614174999:line 99';

    const norm1 = normalizeLogPattern(line1);
    const norm2 = normalizeLogPattern(line2);

    assert.equal(norm1, '[ERROR] Failed to connect to <IP> with id <UUID>');
    assert.equal(norm2, '[ERROR] Failed to connect to <IP> with id <UUID>');
    assert.equal(norm1, norm2, 'Normalized patterns must be identical for identical root errors');
  });

  check('groupLogsIntoIncidents deduplicates 50 repeated errors into 1 incident', () => {
    const repeatedLines = Array.from({ length: 50 }, (_, i) =>
      `{"level":"error","ts":${1791727866 + i},"msg":"dial tcp: lookup backend on 127.0.0.11:53: server misbehaving"}`
    );

    const logs = {
      caddy: repeatedLines,
    };

    const incidents = groupLogsIntoIncidents(logs, null);

    assert.equal(incidents.length, 1, '50 repeated Caddy DNS errors must group into exactly 1 incident');
    assert.equal(incidents[0].count, 50, 'Incident count must reflect all 50 occurrences');
    assert.equal(incidents[0].severity, 'critical', 'Caddy DNS backend lookup error must be classified as critical');
    assert.equal(incidents[0].service, 'caddy');
    assert.ok(incidents[0].evidence.length <= 3, 'Evidence must be capped to at most 3 sample lines');
  });

  check('groupLogsIntoIncidents classifies WhatsApp gateway connection loss with high severity', () => {
    const logs = {
      gateway: [
        '2026-10-11T22:00:00Z [WARN] gateway connection lost: WebSocket closed 1006',
        '2026-10-11T22:00:05Z [ERROR] Boom: Connection Failure in session 180',
      ],
    };

    const incidents = groupLogsIntoIncidents(logs, null);

    assert.ok(incidents.length >= 1, 'Should find at least 1 incident');
    const waIncident = incidents.find((i) => i.service === 'gateway');
    assert.ok(waIncident, 'Must identify gateway incident');
    assert.equal(waIncident.severity, 'high');
    assert.equal(waIncident.actionRiskLevel, 'caution');
  });

  check('computeExecutiveSummary reflects health states accurately (healthy, critical, unavailable)', () => {
    // 1. All healthy
    const healthySummary = computeExecutiveSummary({
      services: [
        { name: 'tezlify-backend', status: 'running', health: 'healthy' },
        { name: 'tezlify-gateway', status: 'running', health: 'healthy' },
        { name: 'tezlify-caddy', status: 'running', health: 'healthy' },
      ],
      health: { all_healthy: true, whatsapp: { connected: true, state: 'CONNECTED' }, checks: {}, checked_at: '' },
      operations: [],
      incidents: [],
    });
    assert.equal(healthySummary.healthState, 'healthy');
    assert.equal(healthySummary.activeIncidentsCount, 0);
    assert.equal(healthySummary.troubledServices.length, 0);

    // 2. Service down
    const downSummary = computeExecutiveSummary({
      services: [
        { name: 'tezlify-backend', status: 'exited', health: 'unhealthy' },
        { name: 'tezlify-gateway', status: 'running', health: 'healthy' },
        { name: 'tezlify-caddy', status: 'running', health: 'healthy' },
      ],
      health: { all_healthy: false, whatsapp: { connected: true, state: 'CONNECTED' }, checks: {}, checked_at: '' },
      operations: [],
      incidents: [],
    });
    assert.equal(downSummary.healthState, 'critical');
    assert.deepEqual(downSummary.troubledServices, ['backend']);

    // 3. Telemetry error / empty services (FAIL-CLOSED)
    const unavailableSummary = computeExecutiveSummary({
      services: [],
      health: null,
      operations: [],
      incidents: [],
      hasTelemetryError: true,
    });
    assert.equal(unavailableSummary.healthState, 'unavailable');
    assert.equal(unavailableSummary.isStale, true);
  });

  check('adversarial: malformed, null, non-string, and empty log entries handled without crashing', () => {
    const maliciousLogs = {
      backend: [
        null,
        undefined,
        '',
        '   ',
        12345,
        '{"corrupted_json": true',
        '2026-10-11T23:00:00Z [ERROR] Valid error after malformed lines',
      ],
      gateway: null,
      caddy: [''],
    };

    const incidents = groupLogsIntoIncidents(maliciousLogs, null);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].service, 'backend');
  });

  check('adversarial: secret tokens, passwords, and authorization headers redacted in fingerprint and title', () => {
    const tokenLine1 = '2026-10-11T23:00:00Z [ERROR] Request failed with Bearer eyJhbGciOiJIUzI1NiJ9.secret1 and token=secrettoken1';
    const tokenLine2 = '2026-10-11T23:00:01Z [ERROR] Request failed with Bearer eyJhbGciOiJIUzI1NiJ9.secret2 and token=secrettoken2';

    const norm1 = normalizeLogPattern(tokenLine1);
    const norm2 = normalizeLogPattern(tokenLine2);

    assert.ok(!norm1.includes('secret1'), 'Secret 1 must be redacted');
    assert.ok(!norm2.includes('secret2'), 'Secret 2 must be redacted');
    assert.equal(norm1, norm2, 'Normalized patterns must be identical regardless of variable secrets');

    const logs = { backend: [tokenLine1, tokenLine2] };
    const incidents = groupLogsIntoIncidents(logs, null);
    assert.equal(incidents.length, 1, 'Token differences must not fragment identical incidents');
    assert.ok(!incidents[0].titleDefault.includes('secret1'), 'Title must not leak tokens');
  });

  check('adversarial: identical error string across different services produces separate isolated incidents', () => {
    const logs = {
      backend: ['2026-10-11T23:00:00Z [ERROR] Connection timeout while contacting worker'],
      gateway: ['2026-10-11T23:00:00Z [ERROR] Connection timeout while contacting worker'],
    };

    const incidents = groupLogsIntoIncidents(logs, null);
    assert.equal(incidents.length, 2, 'Different services must never merge into a single incident');
    const services = incidents.map((i) => i.service).sort();
    assert.deepEqual(services, ['backend', 'gateway']);
  });

  check('adversarial: distinct HTTP status codes (404 vs 500) remain separate incidents', () => {
    const logs = {
      backend: [
        '2026-10-11T23:00:00Z [ERROR] HTTP 404 Not Found on /api/v1/leads',
        '2026-10-11T23:00:01Z [ERROR] HTTP 500 Internal Server Error on /api/v1/leads',
      ],
    };

    const incidents = groupLogsIntoIncidents(logs, null);
    assert.equal(incidents.length, 2, 'HTTP 404 and HTTP 500 must produce distinct incidents');
  });

  check('adversarial: uncatalogued errors set confidence to unknown and do not guess root cause', () => {
    const logs = {
      backend: ['2026-10-11T23:00:00Z [ERROR] Custom vendor exception occurred in pipeline step X'],
    };

    const incidents = groupLogsIntoIncidents(logs, null);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].confidence, 'unknown', 'Unknown errors must not fabricate high confidence root causes');
    assert.equal(incidents[0].possibleCauseKey, 'admin.incidents.genericCause');
    assert.equal(incidents[0].actionRiskLevel, 'safe');
  });

  console.log(`\nIncident engine tests: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
