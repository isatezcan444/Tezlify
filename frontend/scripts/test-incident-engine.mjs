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

  console.log(`\nIncident engine tests: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
