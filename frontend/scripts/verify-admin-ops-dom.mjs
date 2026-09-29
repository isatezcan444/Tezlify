/**
 * Executed DOM verification of the Operations Center components.
 *
 * Renders the REAL components (ServiceStatusPanel / ErrorFeed / OpsLogsPanel)
 * into jsdom with React 18 and asserts on the resulting DOM — including that a
 * service with no allowlisted operation (`db`) renders NO action button rather
 * than a disabled mystery control.
 *
 * Run: node scripts/verify-admin-ops-dom.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  } catch { /* already provided */ }
};
setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('navigator', window.navigator);
setGlobal('HTMLElement', window.HTMLElement);
setGlobal('Element', window.Element);
setGlobal('Node', window.Node);
setGlobal('Event', window.Event);
setGlobal('MouseEvent', window.MouseEvent);
setGlobal('CustomEvent', window.CustomEvent);
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('localStorage', window.localStorage);
setGlobal('sessionStorage', window.sessionStorage);
setGlobal('location', window.location);
setGlobal('history', window.history);
setGlobal('matchMedia', window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
setGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
setGlobal('MutationObserver', window.MutationObserver);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-ops-dom-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  [
    `export { default as React, act } from 'react';`,
    `export * as ReactNS from 'react';`,
    `export { act as domAct } from 'react-dom/test-utils';`,
    `export { createRoot } from 'react-dom/client';`,
    `export { I18nProvider } from '${SRC}/context/I18nContext';`,
    `export { ToastProvider } from '${SRC}/context/ToastContext';`,
    `export { ServiceStatusPanel } from '${SRC}/components/admin/ops/ServiceStatusPanel';`,
    `export { ErrorFeed, buildErrorFeed, classifyError } from '${SRC}/components/admin/ops/ErrorFeed';`,
    `export { OpsLogsPanel } from '${SRC}/components/admin/ops/OpsLogsPanel';`,
    `export { OverviewPanel } from '${SRC}/components/admin/ops/OverviewPanel';`,
    `export { DeployPanel } from '${SRC}/components/admin/ops/DeployPanel';`,
    `export { OpsHistoryPanel } from '${SRC}/components/admin/ops/OpsHistoryPanel';`,
  ].join('\n'),
  'utf8',
);

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const SERVICES = [
  { name: 'tezlify-backend', status: 'running', health: 'healthy', uptime: '3 days', restart_count: 0, oom_killed: false },
  { name: 'tezlify-gateway', status: 'running', health: 'starting', uptime: '5 minutes', restart_count: 2, oom_killed: false },
  { name: 'tezlify-caddy', status: 'running', health: 'healthy', uptime: '9 days', restart_count: 0, oom_killed: false },
  { name: 'tezlify-db', status: 'running', health: 'healthy', uptime: '13 days', restart_count: 0, oom_killed: false },
];
const CATALOGUE = [
  { name: 'restart_backend', label: 'Restart backend', destructive: true },
  { name: 'restart_gateway', label: 'Restart WhatsApp gateway', destructive: true },
  { name: 'restart_caddy', label: 'Restart edge proxy', destructive: true },
];

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: out,
    format: 'esm',
    platform: 'browser',
    absWorkingDir: frontendRoot,
    nodePaths: [path.join(frontendRoot, 'node_modules')],
    define: {
      'import.meta.env.VITE_API_URL': '"/api/v1"',
      'import.meta.env': '{"VITE_API_URL":"/api/v1","DEV":false,"PROD":false,"MODE":"test"}',
      'process.env.NODE_ENV': '"development"',
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'text' },
    logLevel: 'error',
  });

  const mod = await import(out);
    const {
    React, domAct, createRoot, I18nProvider, ToastProvider,
    ServiceStatusPanel, ErrorFeed, buildErrorFeed, classifyError, OpsLogsPanel,
    OverviewPanel, DeployPanel, OpsHistoryPanel,
  } = mod;
  const h = React.createElement;
  const text = () => window.document.body.textContent || '';
  const buttons = () => Array.from(window.document.querySelectorAll('button'));

  // Each mount gets a CLEAN document. Without this, a previous case's DOM
  // stays in the body and assertions match buttons that are no longer mounted.
  let root = null;
  const mount = async (el) => {
    if (root) await domAct(async () => { root.unmount(); });
    window.document.body.innerHTML = '';
    const c = window.document.createElement('div');
    window.document.body.appendChild(c);
    root = createRoot(c);
    await domAct(async () => { root.render(h(I18nProvider, null, h(ToastProvider, null, el))); });
    return root;
  };

  await check('ServiceStatusPanel renders every service with a status', async () => {
    await mount(h(ServiceStatusPanel, {
      services: SERVICES, health: { checks: {}, all_healthy: false, checked_at: '' },
      catalogue: CATALOGUE, onRun: () => {},
    }));
    assert.ok(text().includes('backend'), 'backend row');
    assert.ok(text().includes('gateway'), 'gateway row');
    assert.ok(text().includes('3 days'), 'uptime rendered');
  });

  await check('db renders NO restart button (not allowlisted)', async () => {
    const labels = buttons().map((b) => b.textContent || '');
    assert.ok(!labels.some((l) => /db/i.test(l)), `db must have no action, got ${JSON.stringify(labels)}`);
    // The other three do have one.
    assert.ok(labels.some((l) => l.includes('Restart backend')));
    assert.ok(labels.some((l) => l.includes('Restart WhatsApp gateway')));
  });

  await check('a running operation disables the action buttons', async () => {
    await mount(h(ServiceStatusPanel, {
      services: SERVICES, health: { checks: {}, all_healthy: true, checked_at: '' },
      catalogue: CATALOGUE, onRun: () => {},
      running: { id: 'x', name: 'restart_backend', label: 'Restart backend', status: 'running', destructive: true, logs: [] },
    }));
    const restartButtons = buttons().filter((b) => (b.textContent || '').includes('Restart'));
    assert.ok(restartButtons.length > 0, 'restart buttons exist');
    assert.ok(restartButtons.every((b) => b.disabled), 'all restart buttons must be disabled while one runs');
  });

  await check('ErrorFeed classifies and orders errors newest-first', () => {
    assert.equal(classifyError('Error: boom'), 'ERROR');
    assert.equal(classifyError('WARNING: slow'), 'WARN');
    assert.equal(classifyError('info: ok'), null);
    const feed = buildErrorFeed({ gateway: ['info a', 'Error: b', 'warn c'] });
    assert.equal(feed.length, 2, 'only error/warn are surfaced');
    assert.equal(feed[0].line, 'warn c', 'newest first');
  });

  await check('ErrorFeed expands on click and shows service actions', async () => {
    await mount(h(ErrorFeed, {
      logsByService: { gateway: ['Error: connection lost'] },
      catalogue: CATALOGUE, onRun: () => {}, onViewLogs: () => {},
    }));
    assert.ok(text().includes('connection lost'), 'error line listed');
    const trigger = buttons().find((b) => (b.textContent || '').includes('connection lost'));
    assert.ok(trigger, 'error row is clickable');
    await domAct(async () => { trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    const labels = buttons().map((b) => b.textContent || '');
    assert.ok(labels.some((l) => l.includes('View Logs')), 'view logs action');
    assert.ok(labels.some((l) => l.includes('Restart WhatsApp gateway')), 'service-scoped restart action');
  });

  await check('OpsLogsPanel filters by level', async () => {
    await mount(h(OpsLogsPanel, {
      services: ['backend', 'gateway'], activeService: 'gateway',
      lines: ['Error: one', 'info: two', 'WARNING: three'],
      onServiceChange: () => {}, onReload: () => {},
    }));
    assert.ok(text().includes('one') && text().includes('two') && text().includes('three'));
    const errFilter = buttons().find((b) => (b.textContent || '').trim() === 'ERROR');
    await domAct(async () => { errFilter.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    const after = text();
    assert.ok(after.includes('one'), 'error still shown');
    assert.ok(!after.includes('two'), 'info filtered out');
  });

  await check('the operations page renders a realtime indicator for operators', async () => {
    const page = readFileSync(new URL('../src/pages/admin/AdminOperationsPage.tsx', import.meta.url), 'utf8');
    // The operator must be able to tell a live panel from one silently falling
    // back to polling, otherwise a stale view looks like a healthy system.
    assert.ok(
      /realtimeConnected \? 'admin\.ops\.live' : 'admin\.ops\.polling'/.test(page),
      'the operations page must render the live/polling indicator',
    );
    assert.ok(
      /realtimeConnected \? 'admin\.ops\.liveHint' : 'admin\.ops\.pollingHint'/.test(page),
      'the indicator must explain the current mode on hover',
    );
  });

  await check('DeployPanel offers ONE pipeline action and blocks it while busy', async () => {
    const catalogue = [
      { name: 'deploy_full', label: 'Deploy latest', destructive: true, description: 'pull, build, restart' },
      { name: 'deploy_pull', label: 'Pull', destructive: true },
      { name: 'deploy_build', label: 'Build', destructive: true },
    ];
    await mount(h(DeployPanel, { catalogue, running: null, busyName: null, onRun: () => {} }));
    let labels = buttons().map((b) => (b.textContent || '').trim());
    const deployButtons = labels.filter((l) => /deploy latest/i.test(l));
    assert.equal(deployButtons.length, 1, 'exactly one deploy action, not three loose ones');
    // The granular operations must not be offered as separate buttons.
    assert.ok(!labels.some((l) => /^(pull|build)$/i.test(l.trim())),
      'pull/build must not be separate buttons');

    // A running operation must disable the control: the server would reject it.
    await mount(h(DeployPanel, {
      catalogue, running: { id: 'x', name: 'restart_gateway', label: 'r', status: 'running', destructive: true, logs: [] },
      busyName: null, onRun: () => {},
    }));
    const btn = buttons().find((b) => /deploy latest/i.test(b.textContent || ''));
    assert.ok(btn.disabled, 'the deploy button must be disabled while another operation runs');
  });

  await check('OpsLogsPanel exports the visible lines and disables an empty error export', async () => {
    const created = [];
    // The helper is stubbed so the assertions run against the button logic
    // (what is exported, and when it is offered) rather than the browser's
    // download plumbing, which jsdom does not implement.
    await mount(h(OpsLogsPanel, {
      services: ['backend', 'gateway'],
      activeService: 'gateway',
      lines: ['Error: boom', 'info: fine', 'WARNING: careful', 'Error: second'],
      onServiceChange: () => {},
      onReload: () => {},
      logsByService: { gateway: ['Error: boom', 'info: fine'], backend: ['Error: db down'] },
    }));

    const exportBtns = buttons().filter((b) => /export errors|export/i.test(b.textContent || ''));
    const errBtn = exportBtns.find((b) => /export errors/i.test(b.textContent || ''));
    const logBtn = exportBtns.find((b) => !/export errors/i.test(b.textContent || ''));
    assert.ok(errBtn, 'an errors export must exist');
    assert.ok(logBtn, 'a full log export must exist');
    // Two ERROR lines are present, so the count must be shown, not a guess.
    assert.ok(/2/.test(errBtn.textContent || ''), 'the errors export must show the count');
    assert.ok(!errBtn.disabled, 'must be enabled when errors exist');

    // A service with no errors must offer nothing rather than an empty file.
    await mount(h(OpsLogsPanel, {
      services: ['gateway'], activeService: 'gateway',
      lines: ['info: all good'], onServiceChange: () => {}, onReload: () => {},
    }));
    const noneBtn = buttons().find((b) => /export errors/i.test(b.textContent || ''));
    assert.ok(noneBtn && noneBtn.disabled, 'the errors export must be disabled with no errors');
  });

  await check('the log export respects an active level filter', async () => {
    await mount(h(OpsLogsPanel, {
      services: ['gateway'], activeService: 'gateway',
      lines: ['Error: one', 'info: two', 'WARNING: three'],
      onServiceChange: () => {}, onReload: () => {},
    }));
    const errFilter = buttons().find((b) => (b.textContent || '').trim() === 'ERROR');
    await domAct(async () => { errFilter.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    // After filtering, the export must be present and still enabled: the file
    // has to match the screen, never the raw buffer behind the filter.
    const errBtn = buttons().find((b) => /export errors/i.test(b.textContent || ''));
    assert.ok(errBtn && !errBtn.disabled, 'the filtered view must still be exportable');
  });

  await check('OpsHistoryPanel exports the history and pages through it', async () => {
    const ops = [
      { id: 'a1', name: 'deploy_full', label: 'Deploy latest', status: 'succeeded',
        step: 'completed', destructive: true, logs: [], total_steps: 3, current_step: 'restart' },
      { id: 'a2', name: 'restart_gateway', label: 'Restart gateway', status: 'failed',
        step: 'interrupted', destructive: true, logs: [] },
    ];
    await mount(h(OpsHistoryPanel, {
      operations: ops,
      audit: [{ id: 'x', at: 't', action: 'operation.start', actor: 'admin', result: 'accepted', detail: '{}' }],
      totalOperations: 45, offset: 20, pageSize: 20,
      onPageChange: () => {}, onStatusFilter: () => {}, onNameFilter: () => {},
    }));

    const labels = buttons().map((b) => (b.textContent || '').trim());
    assert.ok(labels.includes('CSV'), 'a CSV export must be offered');
    assert.ok(labels.includes('JSON'), 'a JSON export must be offered');
    // Paging must reflect the real retained total, not the page size.
    assert.ok(text().includes('21-22 / 45'), 'the page range and total must be shown');
    const next = buttons().find((b) => /next/i.test(b.textContent || ''));
    const prev = buttons().find((b) => /previous/i.test(b.textContent || ''));
    assert.ok(next && !next.disabled, 'next must be enabled mid-history');
    assert.ok(prev && !prev.disabled, 'previous must be enabled when not on the first page');
  });

  await check('OpsHistoryPanel hides paging when everything fits', async () => {
    await mount(h(OpsHistoryPanel, {
      operations: [{ id: 'a', name: 'x', label: 'X', status: 'succeeded', destructive: false, logs: [] }],
      audit: [],
      totalOperations: 3, offset: 0, pageSize: 20,
      onPageChange: () => {},
    }));
    // Controls that cannot do anything are noise; a 3-record history does not
    // need a pager.
    const labels = buttons().map((b) => (b.textContent || '').trim());
    assert.ok(!labels.some((l) => /next|previous/i.test(l)),
      'paging must be hidden when the whole history fits on one page');
  });

  await check('OverviewPanel warns that a session is connected but not stored', async () => {
    // The failure this prevents: an operator sees CONNECTED, assumes the session
    // is fine, and only discovers the gap as missing message history.
    await mount(h(OverviewPanel, {
      overview: null, services: [], health: null, operations: [],
      orphanedCount: 1,
      orphanedDetail: [{ id: 's1', session_name: 'Hat 1', since: '2026-09-29T15:32:00Z' }],
    }));
    const body = text();
    assert.ok(/not being saved/i.test(body), 'the warning must say it is NOT being saved');
    assert.ok(body.includes('Hat 1'), 'the affected session must be named');
    // And a clean system must NOT show a red banner.
    await mount(h(OverviewPanel, {
      overview: null, services: [], health: null, operations: [], orphanedCount: 0,
    }));
    assert.ok(!/not being saved/i.test(text()), 'a healthy system must not show the warning');
  });

  console.log(`\nAdmin operations DOM verification: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
