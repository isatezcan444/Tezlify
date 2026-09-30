/**
 * Regression test for the conversation-loading deadlock.
 *
 * PRODUCTION SYMPTOM
 *   open chat A -> opens; open B -> opens; open C -> "Mesajlar yükleniyor..."
 *   forever; switch away and back -> still stuck.
 *
 * TWO CAUSES, both now owned by conversationHydration:
 *   1. hydrateConversationMessages was invoked from INSIDE a setSelectedConv
 *      updater. Updaters must be pure and StrictMode double-invokes them, so
 *      every invocation aborted the in-flight fetch and started a new one.
 *      When the list refreshed more often than the fetch completed, the load
 *      was restarted before it could finish — "loading" meant a request that
 *      was perpetually being cancelled.
 *   2. The superseded/aborted paths returned without clearing the load state,
 *      so an interrupted conversation stayed 'loading' with nothing in flight.
 *
 * The contract asserted here is the one the UI depends on: a state is 'loading'
 * only while a request for it can still settle.
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
const setGlobal = (n, v) => {
  try { Object.defineProperty(globalThis, n, { configurable: true, writable: true, value: v }); }
  catch { /* already provided */ }
};
for (const n of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MutationObserver']) setGlobal(n, window[n]);
setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
setGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('localStorage', window.localStorage);
setGlobal('matchMedia', window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-chat-loading-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  `export { createConversationHydrator } from '${SRC}/features/whatsapp/lib/conversationHydration';\n`,
  'utf8',
);
await build({
  entryPoints: [entry], bundle: true, format: 'esm', outfile: out, platform: 'node',
  absWorkingDir: frontendRoot,
  nodePaths: [path.join(frontendRoot, 'node_modules')],
  logLevel: 'silent',
});
const { createConversationHydrator } = await import(out);

let passed = 0;
const check = async (label, fn) => { await fn(); passed += 1; console.log(`  ok - ${label}`); };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Fetcher whose latency is controllable, so an abort storm can be staged. */
function makeFetcher(initialDelay = 10) {
  const calls = [];
  let delay = initialDelay;
  return {
    calls,
    setDelay: (ms) => { delay = ms; },
    fetchMessages: (convId, { signal }) => new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        resolve({ messages: [{ id: convId * 100, body: 'hi' }], has_more: false });
      }, delay);
      calls.push(convId);
      signal?.addEventListener('abort', () => clearTimeout(t));
    }),
  };
}

await check('a completed load reaches "ready" and never returns to "loading"', async () => {
  const f = makeFetcher();
  const h = createConversationHydrator({
    fetchMessages: f.fetchMessages,
    onMessages: () => {},
    timeoutMs: 5000,
  });
  const seen = [];
  h.subscribe((id, s) => seen.push([id, s]));
  h.hydrate(1);
  await tick(80);
  assert.equal(h.getState(1), 'ready', `expected ready, got ${h.getState(1)}`);
  assert.ok(seen.some(([, s]) => s === 'loading'), 'loading must be observable while in flight');
  assert.equal(seen.filter(([, s]) => s === 'loading').length, 1, 'exactly one loading transition per load');
  h.dispose();
});

await check('a superseded load does NOT stay "loading" (the deadlock)', async () => {
  const f = makeFetcher(200);
  const h = createConversationHydrator({
    fetchMessages: f.fetchMessages,
    onMessages: () => {},
    timeoutMs: 5000,
  });
  h.hydrate(1);
  await tick(10);
  // Supersede it — this is what every conversation-list refresh used to do.
  h.hydrate(1);
  await tick(400);
  assert.notEqual(
    h.getState(1), 'loading',
    `a superseded load must not strand the conversation on loading (got ${h.getState(1)})`,
  );
  h.dispose();
});

await check('releasing a conversation leaves "loading"', async () => {
  const f = makeFetcher(200);
  const h = createConversationHydrator({
    fetchMessages: f.fetchMessages,
    onMessages: () => {},
    timeoutMs: 5000,
  });
  h.hydrate(5);
  await tick(10);
  h.release(5);
  assert.notEqual(
    h.getState(5), 'loading',
    `leaving a conversation must cancel its spinner (got ${h.getState(5)})`,
  );
  h.dispose();
});

await check('rapid A -> B -> A switching settles every conversation', async () => {
  const f = makeFetcher(30);
  const h = createConversationHydrator({
    fetchMessages: f.fetchMessages,
    onMessages: () => {},
    timeoutMs: 5000,
  });
  for (const id of [1, 2, 1, 2, 1]) { h.hydrate(id); await tick(5); }
  await tick(400);
  for (const id of [1, 2]) {
    assert.equal(
      h.getState(id), 'ready',
      `conversation ${id} must settle, got ${h.getState(id)} — a stuck loading here IS the bug`,
    );
  }
  h.dispose();
});

await check('a rejected load lands in "error", never "loading"', async () => {
  const h = createConversationHydrator({
    fetchMessages: () => Promise.reject(new Error('boom')),
    onMessages: () => {},
    timeoutMs: 5000,
  });
  h.hydrate(9);
  await tick(60);
  assert.equal(h.getState(9), 'error', `expected error, got ${h.getState(9)}`);
  assert.ok(h.getError(9), 'an error state must carry a message for the retry UI');
  h.dispose();
});

await check('a timeout is reported, not swallowed', async () => {
  const h = createConversationHydrator({
    fetchMessages: (_id, { signal }) => new Promise((_res, rej) => {
      const t = setTimeout(() => rej(Object.assign(new Error('t'), { name: 'AbortError' })), 500);
      signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('t'), { name: 'AbortError' })); });
    }),
    onMessages: () => {},
    timeoutMs: 20,
  });
  h.hydrate(7);
  await tick(150);
  assert.equal(h.getState(7), 'error', `expected error after timeout, got ${h.getState(7)}`);
  h.dispose();
});

await check('an empty conversation is "ready", not an endless "loading"', async () => {
  const h = createConversationHydrator({
    fetchMessages: () => Promise.resolve({ messages: [], has_more: false }),
    onMessages: () => {},
    timeoutMs: 5000,
  });
  h.hydrate(4);
  await tick(50);
  assert.equal(h.getState(4), 'ready', 'an empty chat must show its empty state, not a spinner');
  h.dispose();
});

await check('dispose aborts in-flight work and leaves no spinner', async () => {
  const f = makeFetcher();
  const h = createConversationHydrator({
    fetchMessages: f.fetchMessages,
    onMessages: () => {},
    timeoutMs: 5000,
  });
  h.hydrate(1);
  await tick(5);
  h.dispose();
  await tick(60);
  assert.notEqual(h.getState(1), 'loading', 'disposal must not leave a spinner running');
});

console.log(`\n${passed}/8 checks passed`);
await rm(tmp, { recursive: true, force: true });
process.exit(passed === 8 ? 0 : 1);
