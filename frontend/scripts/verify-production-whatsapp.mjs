/**
 * PRODUCTION smoke + latency measurement for the WhatsApp surface.
 *
 * Everything before this was jsdom or static analysis. This drives real Google
 * Chrome over the DevTools Protocol against the DEPLOYED site, so the numbers
 * are the ones a user actually experiences.
 *
 * It needs no login: the same public page loads the WhatsApp chunk, and what
 * can be verified without a session is exactly what regressed before — the
 * shipped bundle must contain the loading fix and not the impure state
 * updater, and the shipped CSS must carry the themed loading surface.
 *
 * The authenticated walkthrough (A -> B -> C -> A, send, ACK, latency on a real
 * conversation) is reported as NOT VERIFIED rather than guessed at.
 *
 * Run: node scripts/verify-production-whatsapp.mjs — exit code 0 = PASS.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PROD = 'https://130.162.247.20.sslip.io';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9444;

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok - ${label}`); };
const metrics = [];
const record = (name, value, unit = 'ms') => metrics.push({ name, value: Math.round(value), unit });

if (!existsSync(CHROME)) {
  console.log('SKIP: Google Chrome not found');
  process.exit(0);
}

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--user-data-dir=/tmp/tezlify-prod-smoke-profile',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const targets = await res.json();
    const page = targets.find((t) => t.type === 'page');
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
if (!wsUrl) { console.error('FAIL: Chrome DevTools never came up'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
let seq = 0;
const pending = new Map();
const consoleErrors = [];
const failedRequests = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.text ?? 'exception');
  }
  if (msg.method === 'Network.loadingFailed') failedRequests.push(msg.params.errorText);
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  seq += 1;
  pending.set(seq, { resolve, reject });
  ws.send(JSON.stringify({ id: seq, method, params }));
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
};

const t0 = Date.now();
await send('Page.navigate', { url: `${PROD}/` });
await new Promise((r) => setTimeout(r, 6000));
record('page load', Date.now() - t0);

const html = await evaluate('document.documentElement.outerHTML');
const bundle = (html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0];
const cssHref = (html.match(/\/assets\/index-[A-Za-z0-9_-]+\.css/) || [])[0];
record('bundle', 0, bundle ? bundle.split('/').pop() : 'MISSING');

check('the deployed page serves a hashed bundle', () => {
  assert.ok(bundle, `no hashed bundle served: ${String(html).slice(0, 200)}`);
});

const rootChildren = await evaluate('document.getElementById("root")?.childElementCount ?? 0');
check('React mounted into #root', () => {
  assert.ok(rootChildren > 0, '#root is empty — the bundle did not execute');
});

const bundleJs = await (await fetch(`${PROD}${bundle}`)).text();
const css = cssHref ? await (await fetch(`${PROD}${cssHref}`)).text() : '';

check('the deployed bundle contains the loading-deadlock fix', async () => {
  // WhatsAppHubPage is a lazily-loaded chunk (route-level code splitting), so
  // the hydration lifecycle lives there, not in the entry bundle. Looking only
  // at the entry would have reported a false failure.
  const chunkName = (bundleJs.match(/WhatsAppHubPage-[A-Za-z0-9_-]+\.js/) || [])[0];
  assert.ok(chunkName, 'the WhatsApp chunk is not referenced by the entry bundle');
  const chunkJs = await (await fetch(`${PROD}/assets/${chunkName}`)).text();

  // The impure updater is what caused the endless spinner; its absence is the
  // assertion that matters.
  assert.ok(
    !chunkJs.includes('setSelectedConv((prev)'),
    'the impure state updater is STILL in the deployed WhatsApp chunk',
  );
  assert.ok(
    chunkJs.includes('conversation-'),
    'the tested conversation hydration lifecycle is not in the deployed chunk',
  );
  record('whatsapp chunk (gzip-less)', chunkJs.length, 'bytes');
});

check('the deployed CSS carries a themed loading surface', () => {
  assert.ok(css.includes('.bg-white'), 'bg-white utility missing from the deployed CSS');
  assert.ok(
    css.includes('#111b21'),
    'the dark sync-gate surface is missing — the loading screen is stuck dark',
  );
});

check('no console errors on load', () => {
  // 401 on /auth/me is the correct unauthenticated response, not an error.
  const real = consoleErrors.filter((e) => !/401|Unauthorized|auth\/me/i.test(e));
  assert.deepEqual(real, [], `console errors: ${real.join(' | ')}`);
});

check('no transport-level request failure', () => {
  const real = failedRequests.filter((e) => !/ERR_ABORTED/.test(e));
  assert.deepEqual(real, [], `failed requests: ${real.join(', ')}`);
});

metrics.push({
  name: 'ws connect logs (unauthenticated)',
  value: consoleErrors.filter((e) => e.includes('Connected to realtime event stream')).length,
  unit: '',
});

console.log('\nMEASURED');
for (const m of metrics) console.log(`  ${m.name}: ${m.value}${m.unit ? ` ${m.unit}` : ''}`);

console.log('\nNOT VERIFIED (needs an authenticated session):');
for (const line of [
  'A -> B -> C -> A chat switching on live data',
  'incoming message latency on a real conversation',
  'send -> ACK -> DELIVERED round trip',
  'group chat open, history pagination, scroll preservation',
  'mobile viewport and the iOS keyboard',
]) console.log(`  - ${line}`);

console.log(`\n${passed}/6 checks passed`);
ws.close();
cleanup();
process.exit(passed === 6 ? 0 : 1);
