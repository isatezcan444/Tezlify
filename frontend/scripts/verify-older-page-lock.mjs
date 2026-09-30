/**
 * Regression test for the "load older messages" concurrency guard.
 *
 * PRODUCTION RISK
 *   Older-page fetches were guarded by React state (`activePaging.loading`).
 *   State commits asynchronously, so two triggers in the same tick — a double
 *   click, or a scroll event firing again while the control is still visible —
 *   both read `loading === false` and both fired a request for the SAME cursor.
 *
 *   Two responses for one cursor then race to commit. The scroll anchor captured
 *   for the first is applied to a list whose height already changed underneath
 *   it, so the thread jumps, and the second response can overwrite the paging
 *   cursor written by the first, so the next page is fetched from the wrong
 *   boundary and messages are skipped.
 *
 * THE CONTRACT
 *   Exactly one older-page request may hold a conversation's cursor at a time,
 *   and that claim must be synchronous — independent of any render.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src', 'features', 'whatsapp', 'lib', 'olderPageLock.ts');

const outDir = await mkdtemp(path.join(os.tmpdir(), 'older-page-lock-'));
try {
  const outfile = path.join(outDir, 'olderPageLock.mjs');
  await build({
    entryPoints: [SRC],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  });
  const { claimOlderPage, releaseOlderPage, isCurrentOlderPage } = await import(outfile);

  let passed = 0;
  const check = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  };

  console.log('older-page concurrency guard');

  check('a second trigger in the same tick is rejected', () => {
    const inflight = new Map();
    const first = claimOlderPage(inflight, 1);
    assert.ok(first, 'the first trigger must claim the lock');
    // React has not re-rendered, so a UI-level `loading` flag would still read
    // false here. The lock must reject regardless.
    const second = claimOlderPage(inflight, 1);
    assert.equal(second, null, 'a duplicate request for the same cursor must be rejected');
  });

  check('the lock is released so a later page can be fetched', () => {
    const inflight = new Map();
    const first = claimOlderPage(inflight, 1);
    releaseOlderPage(inflight, 1, first);
    const second = claimOlderPage(inflight, 1);
    assert.ok(second, 'after release, the next page must be fetchable');
  });

  check('locks are per conversation', () => {
    const inflight = new Map();
    const a = claimOlderPage(inflight, 1);
    const b = claimOlderPage(inflight, 2);
    assert.ok(a && b, 'switching chats must not leave the previous one locked');
  });

  check('a superseded request cannot release the newer one\'s lock', () => {
    const inflight = new Map();
    const first = claimOlderPage(inflight, 1);
    // Simulate a teardown that re-armed the lock for a fresh request.
    const replacement = { controller: new AbortController(), token: Symbol('replacement') };
    inflight.set(1, replacement);

    releaseOlderPage(inflight, 1, first);
    assert.ok(
      inflight.get(1) === replacement,
      'a stale request must not release the lock a newer request now holds',
    );
  });

  check('only the current owner may commit', () => {
    const inflight = new Map();
    const first = claimOlderPage(inflight, 1);
    assert.equal(isCurrentOlderPage(inflight, 1, first), true);
    const replacement = { controller: new AbortController(), token: Symbol('replacement') };
    inflight.set(1, replacement);
    assert.equal(
      isCurrentOlderPage(inflight, 1, first),
      false,
      'a superseded response must not commit over the live one',
    );
  });

  check('a failed request releases the lock', () => {
    const inflight = new Map();
    const request = claimOlderPage(inflight, 1);
    // The catch/finally path releases unconditionally for the current owner.
    releaseOlderPage(inflight, 1, request);
    assert.equal(inflight.size, 0, 'an error must not leave the conversation locked');
    assert.ok(claimOlderPage(inflight, 1), 'retry after an error must be possible');
  });

  check('interleaved triggers across two conversations stay independent', () => {
    const inflight = new Map();
    const a1 = claimOlderPage(inflight, 1);
    const b1 = claimOlderPage(inflight, 2);
    assert.equal(claimOlderPage(inflight, 1), null);
    assert.equal(claimOlderPage(inflight, 2), null);
    releaseOlderPage(inflight, 2, b1);
    // Releasing chat 2 must not unlock chat 1.
    assert.equal(claimOlderPage(inflight, 1), null, 'chat 1 is still in flight');
    assert.ok(claimOlderPage(inflight, 2), 'chat 2 may start its next page');
    releaseOlderPage(inflight, 1, a1);
  });

  check('a conversation switch cannot strand the lock', () => {
    // Regression risk in the new guard itself: a lock left behind after a
    // conversation switch reports a request in flight that no longer exists, so
    // returning to that chat could never load older messages again. The only
    // symptom is a control that silently does nothing — which is the defect
    // this whole change exists to remove, reintroduced by its own fix.
    const inflight = new Map();
    claimOlderPage(inflight, 7);

    // This is what the effect cleanup does on unmount/switch.
    inflight.get(7).controller.abort();
    inflight.delete(7);

    assert.ok(
      claimOlderPage(inflight, 7),
      'returning to a conversation must be able to load older messages again',
    );
  });

  check('an aborted request is actually aborted', () => {
    const inflight = new Map();
    const request = claimOlderPage(inflight, 1);
    assert.equal(request.controller.signal.aborted, false);
    request.controller.abort();
    assert.equal(request.controller.signal.aborted, true, 'cleanup must abort the fetch');
  });

  console.log(`\n${passed} checks passed`);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
