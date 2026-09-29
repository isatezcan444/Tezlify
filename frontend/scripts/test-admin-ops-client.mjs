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
    'overviewServices', 'overviewHealth', 'overviewDatabase', 'overviewWhatsapp',
    'overviewUnknown', 'overviewNoServices', 'persistenceWarning',
    'bridgeStatus', 'gatewayHealth', 'reconnectCount',
    'connected', 'disconnected', 'sessionsTitle', 'sessionsEmpty',
    'pairingActive', 'pairingNeeded', 'chatsScopedNote', 'chatsOpenHub',
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

check('all eight Operations Center tabs are wired to real components', () => {
  const page = read('../src/pages/admin/AdminWhatsAppPage.tsx');
  // The panel is only finished when every declared tab renders something. A tab
  // that falls through would show a blank card and look broken.
  // `operations` is the deliberate fall-through: it also hosts the live log
  // view, so it has no explicit `opsTab === 'operations'` branch.
  for (const [id, component] of [
    ['overview', 'OverviewPanel'],
    ['connection', 'ConnectionPanel'],
    ['chats', 'LiveChatsLink'],
    ['session', 'null'],
    ['system', 'ServiceStatusPanel'],
    ['errors', 'ErrorFeed'],
    ['logs', 'OpsLogsPanel'],
  ]) {
    assert.ok(new RegExp(`opsTab === '${id}'`).test(page), `missing tab branch: ${id}`);
    if (component !== 'null') {
      assert.ok(new RegExp(`<${component}[\\s/>]`).test(page), `${id} must render ${component}`);
    }
  }
  // The fall-through must still render the history panel.
  assert.ok(/<OpsHistoryPanel[\s/>]/.test(page), 'operations tab must render OpsHistoryPanel');
  // The tab bar must not advertise a tab the page cannot render.
  for (const id of ['overview', 'connection', 'chats', 'session', 'system', 'errors', 'logs', 'operations']) {
    assert.ok(new RegExp(`id: '${id}'`).test(page), `tab ${id} missing from the tab bar`);
  }
});

check('the chats tab does not embed a conversation list', () => {
  const link = read('../src/components/admin/ops/LiveChatsLink.tsx');
  // /whatsapp/conversations is user-scoped and enforced server-side. An admin
  // panel that listed them would leak another tenant's chats or silently show
  // the admin's own, so the tab must hand off instead.
  assert.ok(/onOpenChats/.test(link), 'must navigate to the scoped chat surface');
  assert.ok(!/conversation_id|fetchConversations|\.map\(.*conversations/.test(link),
    'the admin ops tab must not render conversations itself');
  const page = read('../src/pages/admin/AdminWhatsAppPage.tsx');
  assert.ok(
    page.includes("<LiveChatsLink onOpenChats={() => onNavigate?.('whatsapp')} />"),
    'chats tab must route to the WhatsApp hub',
  );
});

check('the connection tab is read-only (pairing stays with the account owner)', () => {
  const panel = read('../src/components/admin/ops/ConnectionPanel.tsx');
  // Pairing endpoints are scoped to the requesting user; an admin-triggered
  // pairing flow would pair the wrong account or need a privileged endpoint
  // that writes session credentials on a user's behalf.
  assert.ok(!/pair\/start|startPairing|pairing\/\{pair_token\}/.test(panel),
    'the admin connection panel must not call pairing endpoints');
});

check('the overview tab surfaces an unwritable state directory', () => {
  const panel = read('../src/components/admin/ops/OverviewPanel.tsx');
  assert.ok(/persistenceOk/.test(panel), 'must render the persistence warning');
  const page = read('../src/pages/admin/AdminWhatsAppPage.tsx');
  assert.ok(/persistence_ok !== false/.test(page), 'page must read the server flag');
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

console.log(`\nAdmin ops client contract: PASS (${passed} checks)`);
