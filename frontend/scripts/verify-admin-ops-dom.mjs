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
  const { React, domAct, createRoot, I18nProvider, ToastProvider, ServiceStatusPanel, ErrorFeed, buildErrorFeed, classifyError, OpsLogsPanel } = mod;
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

  console.log(`\nAdmin operations DOM verification: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
