// App-state sync recovery contract.
//
// SYMPTOM 1 (production, 2026-09-29): the chat list stayed empty (`chats: 0`)
// while the session was CONNECTED and the database held 117 conversations.
//
// SYMPTOM 2 (production, session 73155bba, 2026-10-01): the chat list was FULL
// (118 conversations) while app-state was still broken. Measured:
//
//   park   regular_low                       1790841765872
//   write  app-state-sync-key-AAAAAPAM.json  1790841766000   (129 ms later)
//   frozen regular_low                       1790841766000   (never advanced)
//   advanced regular_high                    1790842042000   (4.5 min later)
//
// ROOT CAUSE, read from the library rather than guessed: Baileys parks a
// collection whose decryption key is missing —
//   "regular blocked on missing key from v0, parking after 2 attempts"
// — and adds it to a module-level `blockedCollections` set (Socket/chats.js:523).
// It only un-parks that set inside a `creds.update` handler that fires when
// `myAppStateKeyId` ARRIVES (chats.js:1116). Because `creds.json` already
// carries that id, the handler never fires and the parked set survives for the
// life of the process.
//
// THE BUG THIS FILE NOW PINS: the first fix gated the retry on an EMPTY chat
// store ("stop once the store fills up"). That conflates two unrelated
// subsystems. History sync fills the store; it says nothing about app-state.
// The gate therefore stopped retrying `regular_low` — the collection carrying
// chat-level actions (archive / markChatAsRead / chat delete) — which is why a
// chat read or deleted on the phone never reached us.
//
// The recovery must key on APP-STATE health (positive evidence), never on
// chat-store size. Reverting that fails check C below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSessionManager,
  shouldRearmAppState,
  readAppStateProgress,
} from '../src/session-manager.js';

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
const storeSrc = fs.readFileSync(path.join(SRC, 'messages', 'message-store.js'), 'utf8');

function makeManager(tag) {
  return createSessionManager({
    sessionsDir: path.join(os.tmpdir(), `appstate-rearm-${tag}`),
    mediaDir: path.join(os.tmpdir(), `appstate-rearm-media-${tag}`),
    aesKey: '0'.repeat(64),
    backendWsUrl: '',
  });
}

function fakeSession({ chats = 0, status = 'CONNECTED' } = {}) {
  const store = { chats: new Map(), appStateHealthy: false, _appStateRearmCount: 0 };
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

// --- A. the recovery exists and is armed from both connect paths -------------
await check('A. both connect paths arm the app-state recovery chain', () => {
  assert.ok(smSrc.includes('_scheduleAppStateRearm'),
    'session-manager must expose the recovery entry point');
  assert.ok(evSrc.includes('manager._scheduleAppStateRearm(session)'),
    'the socket connect path must arm the recovery');
  // A first QR pairing never takes the `priorSyncs > 0` branch, and that is
  // exactly the path whose connect-time resync races the key share.
  const finalizeBlock = evSrc.slice(
    evSrc.indexOf('const finalizeHistorySync'),
    evSrc.indexOf('// --- QR event ---'),
  );
  assert.ok(finalizeBlock.includes('manager._scheduleAppStateRearm(session)'),
    'the history-finalize path must arm the recovery too');
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

// --- C. THE CORE CONTRACT: a full chat store does NOT stop the recovery -----
await check('C. a populated chat store does NOT block the recovery', () => {
  const { session, store } = fakeSession({ chats: 3 });
  assert.equal(shouldRearmAppState(session, store), true,
    'history sync filling the store must not be mistaken for app-state health');
  makeManager('filled')._scheduleAppStateRearm(session);
  assert.ok((store._appStateRearmCount ?? 0) >= 1,
    'a populated store with unhealthy app-state must still arm a retry');
});

// --- C2. it stops on POSITIVE evidence, and only on that --------------------
await check('C2. recovery stops once app-state is proven healthy', () => {
  const { session, store } = fakeSession({ chats: 0 });
  store.appStateHealthy = true;
  assert.equal(shouldRearmAppState(session, store), false,
    'proven health must stop the retry (bounded load on WhatsApp)');
  // Scope to THIS decision function: the avatar sweep legitimately uses the
  // "stop once the store fills up" gate, so a whole-file assertion would
  // confuse the two.
  const src = smSrc.slice(
    smSrc.indexOf('export function shouldRearmAppState'),
    smSrc.indexOf('function scheduleAppStateRearm'),
  );
  assert.ok(src.includes('appStateHealthy === true'),
    'health, not chat count, is the stop condition');
  assert.ok(!src.includes('store.chats'),
    'the chat-store gate must be gone from the app-state decision');
});

// --- C3. the health signal is a real measurement, not a flag ---------------
await check('C3. readAppStateProgress detects an advanced collection', () => {
  assert.equal(readAppStateProgress(null), null, 'no session dir ⇒ no fingerprint');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appstate-progress-'));
  const before = readAppStateProgress(dir);
  assert.ok(typeof before === 'string' && before.includes('regular_low:-'),
    'missing files must be reported as absent, not as an error');
  fs.writeFileSync(path.join(dir, 'app-state-sync-version-regular_low.json'), '{"a":1}');
  const after = readAppStateProgress(dir);
  assert.notEqual(after, before,
    'writing a collection version file must change the fingerprint');
  assert.ok(after.includes('regular_low:'), 'the advanced collection must be named');
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

// --- F. an empty, connected store DOES arm it ------------------------------
await check('F. an empty connected store arms the recovery', () => {
  const { session, store } = fakeSession({ chats: 0 });
  makeManager('empty')._scheduleAppStateRearm(session);
  assert.ok(
    (store._appStateRearmCount ?? 0) >= 1,
    'an empty store must arm a retry',
  );
});

// --- G. EVERY collection is re-requested, not a convenient subset ----------
await check('G. the retry requests every app-state collection', () => {
  const block = smSrc.slice(smSrc.indexOf('const APPSTATE_PATCH_NAMES'));
  for (const name of ['critical_block', 'critical_unblock_low', 'regular', 'regular_low', 'regular_high']) {
    assert.ok(block.includes(`'${name}'`),
      `the retry must request \`${name}\` — a partial list leaves the parked one behind`);
  }
  assert.ok(!smSrc.includes("resyncAppState(['regular_low', 'regular_high'], false)") ||
    smSrc.includes('APPSTATE_PATCH_NAMES'),
    'the recovery must use the full collection list');
});

// --- H. the health field is declared on the store, not implicit ------------
await check('H. the store declares app-state health explicitly', () => {
  assert.ok(storeSrc.includes('appStateHealthy: false'),
    'a lazily-attached field would read as healthy-by-accident elsewhere');
});

console.log(`\nApp-state sync recovery contract: PASS (${passed} checks)`);
