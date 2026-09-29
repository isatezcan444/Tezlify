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
    'tabOverview',  'tabErrors',
    'tabSession', 'tabSystem', 'tabLogs', 'tabDeployment', 'tabHistory',
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
    'overviewServices', 'overviewHealth', 'overviewDatabase', 'overviewWhatsapp',
    'overviewUnknown', 'overviewNoServices', 'persistenceWarning',
    
     
      
    'stagePull', 'stageBuild', 'stageRestart', 'stageProgress', 'stepInterrupted',
    'deployFull', 'deployFullDesc', 'deploymentUnavailable', 'deployBlocked',
    'deployRestartsBackendNote',
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

check('the deploy action is one cohesive pipeline, not three loose buttons', () => {
  const panel = read('../src/components/admin/ops/DeployPanel.tsx');
  // Pull, build and restart as separate controls let an operator deploy a
  // rebuild of the PREVIOUS commit. The panel must look the action up from the
  // catalogue so the allowlist stays the single source of truth.
  assert.ok(/catalogue\.find\(\(c\) => c\.name === 'deploy_full'\)/.test(panel),
    'the deploy action must come from the catalogue');
  assert.ok(!/deploy_pull/.test(panel) && !/deploy_build/.test(panel),
    'the granular deploy operations must not be offered as separate buttons');
});

check('a multi-step operation shows which stage is running', () => {
  const history = read('../src/components/admin/ops/OpsHistoryPanel.tsx');
  // A deploy takes minutes. Without the stage the operator cannot tell a normal
  // build from a hung one.
  assert.ok(/current_step/.test(history), 'must read the in-flight step');
  assert.ok(/total_steps/.test(history), 'must show progress out of the total');
  for (const stage of ['pull', 'build', 'restart']) {
    assert.ok(new RegExp(`'${stage}'`).test(history) || new RegExp(`\\b${stage}\\b`).test(history),
      `stage ${stage} must be displayable`);
  }
  // An interrupted operation (backend restarted mid-deploy) needs its own label.
  assert.ok(/interrupted/.test(history), 'must label the interrupted state');
});

check('the deploy button is disabled while another operation runs', () => {
  const panel = read('../src/components/admin/ops/DeployPanel.tsx');
  assert.ok(/const blocked = Boolean\(running\)/.test(panel),
    'the deploy control must be blocked while an operation is running');
  assert.ok(/disabled=\{!action \|\| blocked \|\| busy\}/.test(panel),
    'the button must actually be disabled');
});

check('the TR and EN ops dictionaries have identical key sets', () => {
  // Two apostrophe-escaping bugs slipped into the TR block during this work and
  // only surfaced at compile time. This compares the key sets directly so a
  // key added to one language and forgotten in the other fails here instead.
  const blockOf = (src) => src.slice(src.indexOf('    ops: {'));
  const keysOf = (src) => {
    const out = new Set();
    for (const line of blockOf(src).split('\n')) {
      const m = line.match(/^\s{6}([A-Za-z0-9_]+):/);
      if (m) out.add(m[1]);
    }
    return out;
  };
  const tr = keysOf(trSrc);
  const en = keysOf(enSrc);
  const missingInEn = [...tr].filter((k) => !en.has(k));
  const missingInTr = [...en].filter((k) => !tr.has(k));
  assert.deepEqual(missingInEn, [], `EN is missing ops keys: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInTr, [], `TR is missing ops keys: ${missingInTr.join(', ')}`);
});

check('the WhatsApp admin page is read-only again: no server controls', () => {
  const wa = read('../src/pages/admin/AdminWhatsAppPage.tsx');
  // This is the regression this restructure exists to prevent: restarting a
  // container or deploying code is not a WhatsApp operation, and putting those
  // controls here made the page header lie about what its buttons did.
  for (const forbidden of ['OpsApi', 'ServiceStatusPanel', 'DeployPanel', 'OpsLogsPanel', 'ErrorFeed', 'startOperation']) {
    assert.ok(!wa.includes(forbidden), `the WhatsApp page must not contain ${forbidden}`);
  }
});

check('server operations live on their own page', () => {
  const ops = read('../src/pages/admin/AdminOperationsPage.tsx');
  assert.ok(/ServiceStatusPanel/.test(ops), 'service control belongs here');
  assert.ok(/OpsLogsPanel/.test(ops), 'logs belong here');
  assert.ok(/ErrorFeed/.test(ops), 'errors belong here');
  assert.ok(/OpsHistoryPanel/.test(ops), 'history belongs here');
  assert.ok(/useOpsEvents/.test(ops), 'must follow operations in realtime');
  for (const id of ['overview', 'system', 'errors', 'logs', 'history']) {
    assert.ok(new RegExp(`id: '${id}'`).test(ops), `missing tab ${id}`);
  }
});

check('the operations page never offers code deployment', () => {
  const ops = read('../src/pages/admin/AdminOperationsPage.tsx');
  // Restarting a service and shipping new code are different risk classes;
  // DeployPanel must not appear on the server operations page.
  assert.ok(!ops.includes('DeployPanel'), 'deploy must not be offered here');
  assert.ok(!ops.includes("deploy_full"), 'the deploy pipeline must not be started here');
});

check('deployment actions live on the deployment page', () => {
  const dep = read('../src/pages/admin/AdminDeploymentPage.tsx');
  assert.ok(/DeployPanel/.test(dep), 'the deploy action belongs on the deployment page');
  assert.ok(/runDeploy/.test(dep), 'the page must wire a deploy handler');
  // It must follow the deploy over the socket: a deploy restarts the backend,
  // so the page has to recover state when the socket drops and reconnects.
  assert.ok(/useOpsEvents/.test(dep), 'must track the deploy in realtime');
  assert.ok(/status !== 'running'/.test(dep), 'a finished deploy must re-read the deployment state');
});

check('the sidebar exposes operations and deployment as separate entries', () => {
  const side = read('../src/components/Layout/Sidebar.tsx');
  assert.ok(side.includes("id: 'admin-operations'"), 'missing operations entry');
  assert.ok(side.includes("id: 'admin-deployment'"), 'missing deployment entry');
  // Ordering: operations must sit next to deployment, not inside WhatsApp.
  const opsIdx = side.indexOf("id: 'admin-operations'");
  const depIdx = side.indexOf("id: 'admin-deployment'");
  const waIdx = side.indexOf("id: 'admin-whatsapp'");
  assert.ok(waIdx < opsIdx, 'operations must come after the WhatsApp entry');
  assert.ok(Math.abs(opsIdx - depIdx) < 400, 'operations and deployment should be adjacent');
});

check('every page is routed in App.tsx', () => {
  const app = read('../src/App.tsx');
  assert.ok(app.includes("activeTab === 'admin-operations'"), 'operations route missing');
  assert.ok(app.includes('<AdminOperationsPage'), 'operations page not rendered');
  assert.ok(app.includes("case 'admin-operations':"), 'operations title/subtitle case missing');
});

check('log and error exports are available and honest about filters', () => {
  const panel = read('../src/components/admin/ops/OpsLogsPanel.tsx');
  // The file must contain what the operator SEES. Exporting the raw buffer
  // would quietly bypass a level filter or search they are relying on.
  assert.ok(/buildLogExport\(\{[\s\S]*?lines: visible,/.test(panel),
    'the export must use the filtered lines, not the raw buffer');
  assert.ok(/levelFilter: level/.test(panel), 'the active level filter must be recorded');
  assert.ok(/query,/.test(panel), 'the active search must be recorded');
  // Two distinct exports: an operator debugging an incident usually wants the
  // errors, not 500 lines of noise.
  assert.ok(panel.includes('tezlify-errors'),
    'an errors-only export must exist');
  assert.ok(panel.includes("'tezlify-logs'"), 'a full log export must exist');
  // Nothing to export means the control is disabled, not a silent empty file.
  assert.ok(/disabled=\{!hasVisible \|\| errorCount === 0\}/.test(panel),
    'the errors export must be disabled when there are none');
});

check('the download helper revokes its object URL', () => {
  const helper = read('../src/components/admin/ops/exportLogs.ts');
  // AGENTS.md requires revoking blob URLs: an admin session that exports
  // repeatedly would otherwise hold every export in memory.
  assert.ok(/URL\.revokeObjectURL\(url\)/.test(helper), 'must revoke the object URL');
  assert.ok(/setTimeout\(\(\) => URL\.revokeObjectURL/.test(helper),
    'revoke must be deferred a tick, or Safari aborts the download');
  assert.ok(
    /removeChild\(anchor\)|anchor\.remove\(\)/.test(helper),
    'the anchor must not stay in the DOM',
  );
  // File names must be sortable and safe on every filesystem.
  assert.ok(helper.includes("replace(/[:.]/g, '-')"),
    'the timestamp must not contain characters that break a file name');
});

check('the errors tab can be exported too', () => {
  const ops = read('../src/pages/admin/AdminOperationsPage.tsx');
  // The page owns the per-service buffers, so the merged export has to receive
  // them; without this the file would only ever contain the visible service.
  assert.ok(/logsByService=\{logsByService\}/.test(ops),
    'the logs panel must receive the loaded service buffers');
});

check('log levels are read from the structured field, not just keywords', () => {
  const lvl = read('../src/components/admin/ops/logLevel.ts');
  // The gateway (pino) logs {"level":50,...} and caddy logs {"level":"error"}.
  // A keyword-only regex filed {"level":50,"msg":"transaction failed, rolling
  // back"} as INFO, so the Error feed looked empty while the gateway threw.
  assert.ok(lvl.includes('PINO_ERROR'), 'pino numeric levels must be understood');
  assert.ok(lvl.includes('JSON.parse'), 'the structured level must be parsed');
  assert.ok(lvl.includes('"level"'), 'the JSON fast-path guard must be present');
  // Both surfaces must share ONE classifier, or they drift apart again.
  const panel = read('../src/components/admin/ops/OpsLogsPanel.tsx');
  const feed = read('../src/components/admin/ops/ErrorFeed.tsx');
  assert.ok(panel.includes('classifyLogLevel'), 'the log viewer must use the shared classifier');
  assert.ok(feed.includes('classifyLogLevel'), 'the error feed must use the shared classifier');
});

check('the caddy config no longer requests a certificate for a dead domain', () => {
  // The Caddyfile is a repo-root file: two levels above this script.
  const caddy = fs.readFileSync(new URL('../../Caddyfile', import.meta.url), 'utf8');
  // api.tezlify.com has no DNS record, so every ACME attempt failed with
  // NXDOMAIN and Caddy retried forever, burying the real signals.
  assert.ok(!caddy.includes('api.tezlify.com,') && !caddy.includes(', api.tezlify.com'),
    'the dead domain must not be served');
  // The sslip host must NOT pin `tls internal`: switching the issuing CA broke
  // every client that trusted the existing chain, and stopping the ACME loop
  // does not require it. Removing the dead domain is sufficient.
  const siteStart = caddy.indexOf('api.130.162.247.20.sslip.io, 130.162');
  const siteBlock = caddy.slice(siteStart, caddy.indexOf('\n}', siteStart));
  assert.ok(!siteBlock.includes('tls internal'),
    'the sslip site must not switch the issuing CA');
  // The site must still exist and still serve the API.
  assert.ok(siteBlock.includes('reverse_proxy backend:8000'),
    'the sslip site must still proxy the backend');
});

console.log(`\nAdmin ops client contract: PASS (${passed} checks)`);
