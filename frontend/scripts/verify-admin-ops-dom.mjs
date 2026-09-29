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
    `export { ConnectionPanel } from '${SRC}/components/admin/ops/ConnectionPanel';`,
    `export { LiveChatsLink } from '${SRC}/components/admin/ops/LiveChatsLink';`,
    `export { DeployPanel } from '${SRC}/components/admin/ops/DeployPanel';`,
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
    OverviewPanel, ConnectionPanel, LiveChatsLink, DeployPanel,
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

  await check('the page renders a realtime indicator for operators', async () => {
    const page = readFileSync(new URL('../src/pages/admin/AdminWhatsAppPage.tsx', import.meta.url), 'utf8');
    // The operator must be able to tell a live panel from one silently falling
    // back to polling, otherwise a stale view looks like a healthy system.
    assert.ok(
      /opsRealtimeConnected \? 'admin\.ops\.live' : 'admin\.ops\.polling'/.test(page),
      'page must render the live/polling indicator',
    );
    assert.ok(
      /opsRealtimeConnected \? 'admin\.ops\.liveHint' : 'admin\.ops\.pollingHint'/.test(page),
      'the indicator must explain the current mode on hover',
    );
  });

  await check('OverviewPanel summarises the deployment read-only', async () => {
    await mount(h(OverviewPanel, {
      overview: { database: { health: 'healthy' } },
      services: [
        { name: 'tezlify-backend', status: 'running', state: 'Up 2 hours (healthy)' },
        { name: 'tezlify-db', status: 'running', state: 'Up 13 days (healthy)' },
      ],
      health: { checks: {}, all_healthy: true, checked_at: '', whatsapp: { state: 'connected', connected: true } },
      operations: [{ id: '1', name: 'restart_gateway', label: 'Restart WhatsApp gateway', status: 'succeeded', step: 'completed', destructive: true, logs: [] }],
    }));
    const body = text();
    assert.ok(body.includes('2/2'), 'service ratio shown');
    assert.ok(body.includes('backend'), 'service names shown');
    assert.ok(body.includes('Restart WhatsApp gateway'), 'recent operation shown');
    // No action controls: the Overview tab must not place a destructive button
    // in front of the operator before they have read any state.
    const labels = buttons().map((b) => (b.textContent || '').trim());
    assert.ok(!labels.some((l) => /restart|deploy/i.test(l)), 'overview must have no action buttons');
  });

  await check('OverviewPanel warns when the server cannot persist history', async () => {
    await mount(h(OverviewPanel, {
      overview: null, services: [], health: null, operations: [], persistenceOk: false,
    }));
    assert.ok(
      text().includes('cannot write its operation history'),
      'an unwritable state dir must be surfaced, not hidden',
    );
  });

  await check('ConnectionPanel reports session state without pairing controls', async () => {
    let navigated = false;
    await mount(h(ConnectionPanel, {
      data: {
        gateway_bridge: { connected: true, reconnect_count: 2, last_connected_at: null, last_event_at: null },
        gateway_runtime: { health_status: 'healthy' },
        sessions: [{ id: 1, session_name: 'Ops phone', status: 'CONNECTED', phone_number_masked: '+90***' }],
      },
      health: { checks: {}, all_healthy: true, checked_at: '', whatsapp: { state: 'connected', connected: true } },
    }));
    const body = text();
    assert.ok(body.includes('Ops phone'), 'session listed');
    assert.ok(body.includes('CONNECTED'), 'session status shown');
    // Pairing belongs to the account owner; the admin panel must not offer it.
    const labels = buttons().map((b) => (b.textContent || '').trim());
    assert.ok(!labels.some((l) => /pair|qr|scan|connect now/i.test(l)),
      'the admin connection panel must not offer pairing');
  });

  await check('LiveChatsLink hands off to the scoped chat surface', async () => {
    let opened = false;
    await mount(h(LiveChatsLink, { onOpenChats: () => { opened = true; } }));
    const btn = buttons().find((b) => /open whatsapp chats/i.test(b.textContent || ''));
    assert.ok(btn, 'must offer a hand-off button');
    await domAct(async () => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    assert.ok(opened, 'clicking must navigate to the WhatsApp hub');
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

  console.log(`\nAdmin operations DOM verification: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
