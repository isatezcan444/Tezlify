/**
 * Operations Center — client contract tests.
 *
 * The API client is the only place the UI could turn into a command runner, so
 * this asserts the client can ONLY ask the server to run a named catalogue
 * entry, and that the localisation stays complete and in sync between TR and
 * EN. A hardcoded user-facing string or a missing key is a UI defect, not a
 * cosmetic issue.
 *
 * Run: node scripts/test-admin-ops-client.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const apiSrc = read('../src/api/admin.ts');
const typeSrc = read('../src/types/admin.ts');
const trSrc = read('../src/locales/tr.ts');
const enSrc = read('../src/locales/en.ts');

/** Collect keys of a nested object block (`name: {` at the given indent). */
function blockKeys(src, header, indent) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `block not found: ${header}`);
  let depth = 0;
  let end = start;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = src.slice(start, end);
  const re = new RegExp(`^${' '.repeat(indent)}([a-zA-Z][a-zA-Z0-9_]*):`, 'gm');
  return new Set([...body.matchAll(re)].map((m) => m[1]));
}

// ------------------------------------------------------------- client safety
check('client can only start a NAMED operation', () => {
  const startFn = apiSrc.slice(apiSrc.indexOf('static async startOperation'));
  assert.ok(startFn.includes('name'), 'must pass the operation name');
  assert.ok(startFn.includes('confirm'), 'must pass the confirmation flag');
  // No free-form command plumbing anywhere in the client.
  assert.ok(
    !/\b(command|argv|shell|exec)\b\s*[:=]/.test(apiSrc),
    'client must not carry a command/argv field',
  );
  assert.ok(
    apiSrc.includes('JSON.stringify({ name, confirm })'),
    'request body must be exactly { name, confirm }',
  );
});

check('client has no shell/exec escape hatch', () => {
  for (const forbidden of ['eval(', 'new Function(', 'child_process', 'dangerouslySetInnerHTML']) {
    assert.ok(!apiSrc.includes(forbidden), `client must not contain ${forbidden}`);
  }
});

check('client surfaces 403 as ACCESS_DENIED like the other admin calls', () => {
  assert.ok(apiSrc.includes("throw new Error('ACCESS_DENIED')"));
});

check('client encodes the operation id in the path', () => {
  assert.ok(
    apiSrc.includes('encodeURIComponent(id)'),
    'operation id must be URL-encoded (path traversal guard)',
  );
});

check('types mirror the backend schema (no command field)', () => {
  const start = typeSrc.indexOf('export interface OpsOperation {');
  const end = typeSrc.indexOf('}', start);
  const body = typeSrc.slice(start, end);
  for (const field of ['id:', 'name:', 'status:', 'logs:', 'health?']) {
    assert.ok(body.includes(field), `OpsOperation must carry ${field}`);
  }
  assert.ok(!/command\s*[?:]/.test(body), 'OpsOperation must not carry a command field');
  // The status union must match the backend Literal.
  assert.ok(
    typeSrc.includes("export type OpsOperationStatus = 'running' | 'succeeded' | 'failed'"),
    'operation status union must match backend schema',
  );
});

// ------------------------------------------------------------- localisation
const trOps = blockKeys(trSrc, '    ops: {', 6);
const enOps = blockKeys(enSrc, '    ops: {', 6);

check('TR and EN ops blocks are in sync', () => {
  assert.deepEqual(
    [...trOps].sort(),
    [...enOps].sort(),
    'TR/EN ops keys differ — a key would render raw in one language',
  );
  assert.ok(trOps.size >= 60, `expected a full key set, got ${trOps.size}`);
});

check('ops block covers every tab the Operations Center needs', () => {
  const required = [
    'title', 'subtitle',
    'tabOverview', 'tabConnection', 'tabChats', 'tabErrors',
    'tabSession', 'tabSystem', 'tabLogs', 'tabDeployment',
    'servicesTitle', 'healthAllOk', 'healthSomeDown',
    'logsTitle', 'logsEmpty',
    'deploymentTitle', 'currentCommit', 'deployNow',
    'operationsTitle', 'noOperations',
    'confirmTitle', 'confirmRestartBody', 'confirmDeployBody',
    'confirmProceed', 'cancel', 'inProgress',
    'auditTitle', 'auditEmpty',
    'dangerZone', 'dangerZoneDesc',
    'errorsTitle', 'errorsEmpty',
    'live', 'polling', 'liveHint', 'pollingHint',
  ];
  for (const key of required) {
    assert.ok(trOps.has(key), `missing ops key: ${key}`);
    assert.ok(enOps.has(key), `missing EN ops key: ${key}`);
  }
});

check('no Turkish text leaked into the EN ops block', () => {
  const start = enSrc.indexOf('    ops: {');
  const end = enSrc.indexOf('viewLogs', start);
  const block = enSrc.slice(start, end);
  for (const turkish of ['Çalışıyor', 'Başarılı', 'Yeniden', 'İşlem', 'Onayla', 'Durum']) {
    assert.ok(!block.includes(turkish), `EN block contains Turkish: ${turkish}`);
  }
});

check('the ops realtime hook listens on the shared socket and filters operation events', () => {
  const hook = read('../src/hooks/useOpsEvents.ts');
  // Reuse the managed factory: a bespoke socket would duplicate the auth-refresh
  // and backoff logic and reintroduce the 401 reconnect loop.
  assert.ok(/createWebSocket/.test(hook), 'must reuse createWebSocket');
  // Only operation events are consumed; the shared stream also carries scraper
  // and WhatsApp traffic that this panel must ignore.
  assert.ok(/startsWith\('operation\.'\)/.test(hook), 'must filter to operation.* events');
  // Never connect for a non-admin, and always tear the socket down.
  assert.ok(/if \(!enabled\)/.test(hook), 'must honour the enabled flag');
  assert.ok(/socket\?\.close\(\)/.test(hook), 'must close the socket on cleanup');
  // A realtime failure must degrade to polling, not break the panel.
  assert.ok(/catch\s*\{[\s\S]*?setConnected\(false\)/.test(hook), 'must fail soft to polling');
});

check('the page keeps a polling fallback when realtime is unavailable', () => {
  const page = read('../src/pages/admin/AdminWhatsAppPage.tsx');
  assert.ok(/useOpsEvents\(/.test(page), 'page must subscribe to ops events');
  // The interval period depends on the socket state: realtime healthy means a
  // slow safety poll, otherwise the original fast poll.
  assert.ok(
    /opsRealtimeConnected \? 60000 : 15000/.test(page),
    'poll period must depend on the realtime connection state',
  );
  // A finished operation must refresh service state immediately.
  assert.ok(/op\.status !== 'running'/.test(page), 'must refresh status when an operation finishes');
});

console.log(`\nAdmin ops client contract: PASS (${passed} checks)`);
