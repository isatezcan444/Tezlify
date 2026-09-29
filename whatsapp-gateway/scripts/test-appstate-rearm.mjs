// App-state sync recovery contract.
//
// SYMPTOM (production, 2026-09-29): the chat list stayed empty
// (`chats: 0`) while the session was CONNECTED and the database held 117
// conversations.
//
// ROOT CAUSE, read from the library rather than guessed: Baileys parks an
// app-state collection whose decryption key is missing —
//   "regular blocked on missing key from v0, parking after 2 attempts"
// — and adds it to a module-level `blockedCollections` set
// (Socket/chats.js:523). It only un-parks that set inside a `creds.update`
// handler that fires only when `myAppStateKeyId` arrives (chats.js:1116).
// In production that key never arrived (zero "app state sync key arrived"
// lines in the gateway log), so `regular` stayed parked for the life of the
// process and the store never filled.
//
// The gateway therefore owns the retry. These checks pin the contract that
// makes that safe: recovery is armed on connect, it is BOUNDED, it stops as
// soon as the store has chats, and it never runs on a session that is not
// connected. Reverting the recovery fails them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionManager } from '../src/session-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const smSrc = fs.readFileSync(path.join(SRC, 'session-manager.js'), 'utf8');
const evSrc = fs.readFileSync(path.join(SRC, 'socket', 'socket-events.js'), 'utf8');

function makeManager(tag) {
  return createSessionManager({
    sessionsDir: path.join(os.tmpdir(), `appstate-rearm-${tag}`),
    mediaDir: path.join(os.tmpdir(), `appstate-rearm-media-${tag}`),
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
}

function fakeSession({ chats = 0, status = 'CONNECTED' } = {}) {
  const store = { chats: new Map() };
  for (let i = 0; i < chats; i += 1) store.chats.set(`c${i}@s.whatsapp.net`, { id: `c${i}` });
  const session = {
    id: 'sess-1',
    status,
    _deleted: false,
    _shuttingDown: false,
    store,
    sock: { resyncAppState: async () => {} },
  };
  return { session, store };
}

// --- A. the recovery exists and is armed from the connect path --------------
await check('A. connect arms the app-state recovery chain', () => {
  assert.ok(smSrc.includes('_scheduleAppStateRearm'),
    'session-manager must expose the recovery entry point');
  assert.ok(evSrc.includes('manager._scheduleAppStateRearm(session)'),
    'the socket connect path must arm the recovery');
});

// --- B. the recovery is BOUNDED, not an endless resync loop ----------------
await check('B. the recovery chain is bounded', () => {
  assert.ok(/const APPSTATE_REARM_MAX = \d+;/.test(smSrc),
    'a hard attempt cap must exist');
  const cap = Number(smSrc.match(/const APPSTATE_REARM_MAX = (\d+);/)[1]);
  assert.ok(cap > 0 && cap <= 12,
    `the cap must be small enough to avoid load on WhatsApp (got ${cap})`);
  assert.ok(smSrc.includes('unref'), 'the timer must be unref’d so it cannot hold the process open');
});

// --- C. it stops as soon as the store has chats ----------------------------
await check('C. recovery stops once the store has chats', () => {
  const { session, store } = fakeSession({ chats: 3 });
  makeManager('filled')._scheduleAppStateRearm(session);
  assert.equal(
    store._appStateRearmCount ?? 0, 0,
    'a populated chat store must not arm the recovery',
  );
});

// --- D. it never runs on a session that is not connected -------------------
await check('D. recovery is skipped for a non-connected session', () => {
  for (const status of ['SCAN_QR', 'DISCONNECTED', 'FAILED', 'RESTORING']) {
    const { session, store } = fakeSession({ chats: 0, status });
    makeManager(status)._scheduleAppStateRearm(session);
    assert.equal(store._appStateRearmCount ?? 0, 0, `status ${status} must not arm the recovery`);
  }
});

// --- E. it is skipped for a deleted / shutting-down session ----------------
await check('E. recovery is skipped for a deleted or shutting-down session', () => {
  for (const flag of ['_deleted', '_shuttingDown']) {
    const { session, store } = fakeSession({ chats: 0 });
    session[flag] = true;
    makeManager(`flag-${flag}`)._scheduleAppStateRearm(session);
    assert.equal(store._appStateRearmCount ?? 0, 0, `${flag} must not arm the recovery`);
  }
});

// --- F. an empty, connected store DOES arm it -----------------------------
await check('F. an empty connected store arms the recovery', () => {
  const { session, store } = fakeSession({ chats: 0 });
  makeManager('empty')._scheduleAppStateRearm(session);
  assert.ok(
    (store._appStateRearmCount ?? 0) >= 1,
    'the whole point: an empty store must arm a retry',
  );
});

// --- G. the requested collections include the parked one -------------------
await check('G. the retry asks for the collection Baileys parked', () => {
  // The production log parked "regular"; the older call sites only requested
  // regular_low/regular_high, so the parked collection was never re-requested.
  const block = smSrc.slice(smSrc.indexOf('function scheduleAppStateRearm'));
  assert.ok(/resyncAppState\(\['regular', 'regular_low', 'regular_high'\]/.test(block),
    'the retry must request `regular`, the collection that was parked');
});

console.log(`\nApp-state sync recovery contract: PASS (${passed} checks)`);
