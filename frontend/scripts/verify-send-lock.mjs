/**
 * Regression test for the message send single-flight guard.
 *
 * PRODUCTION SYMPTOM
 *   Sending a message could deliver it twice, and the thread shows it twice.
 *
 * ROOT CAUSE
 *   ChatComposer guarded sends with React state (`sending`). State commits
 *   asynchronously, so a double Enter — or Enter plus a click in the same tick —
 *   both read `sending === false` and both called onSend.
 *
 *   The backend's idempotency guard does not catch it. That guard is keyed on
 *   `client_message_id`, and every send mints a fresh one
 *   (`cmsg_<ts>_<rand>`), so two sends of the same text are two unrelated
 *   messages as far as the server is concerned. Both reach WhatsApp.
 *
 * THE CONTRACT
 *   At most one send may be in flight at a time, claimed synchronously and
 *   independent of render, and released on both success and failure.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src', 'features', 'whatsapp', 'lib', 'sendLock.ts');

const outDir = await mkdtemp(path.join(os.tmpdir(), 'send-lock-'));
try {
  const outfile = path.join(outDir, 'sendLock.mjs');
  await build({
    entryPoints: [SRC], outfile, bundle: true, format: 'esm',
    platform: 'neutral', logLevel: 'silent',
  });
  const { createSendLock } = await import(outfile);

  let passed = 0;
  const check = async (label, fn) => { await fn(); passed += 1; console.log(`  ok  ${label}`); };
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  await check('a second send in the same tick is rejected', async () => {
    const lock = createSendLock();
    let calls = 0;
    const send = () => { calls += 1; return tick(20).then(() => `sent-${calls}`); };

    // Two Enter presses: both handlers run before React can commit `sending`.
    const both = await Promise.all([lock.run(send), lock.run(send)]);
    assert.equal(calls, 1, 'exactly one send may reach the backend');
    assert.ok(both[0], 'the first send runs');
    assert.equal(both[1], null, 'the duplicate is rejected, not queued');
  });

  await check('the lock is released after a successful send', async () => {
    const lock = createSendLock();
    await lock.run(async () => 'ok');
    assert.equal(lock.isLocked(), false);
    assert.equal(await lock.run(async () => 'again'), 'again', 'a second message must be sendable');
  });

  await check('the lock is released after a FAILED send', async () => {
    const lock = createSendLock();
    await assert.rejects(
      lock.run(async () => { throw new Error('gateway down'); }),
      /gateway down/,
    );
    assert.equal(lock.isLocked(), false, 'a failed send must not strand the composer');
    assert.equal(await lock.run(async () => 'recovered'), 'recovered', 'retry after failure must work');
  });

  await check('overlapping triggers in one tick collapse to one send', async () => {
    const lock = createSendLock();
    let calls = 0;
    const send = async () => { calls += 1; await tick(15); };
    // Enter + button click + a programmatic retry, all before any re-render.
    await Promise.all([lock.run(send), lock.run(send), lock.run(send)]);
    assert.equal(calls, 1, 'a burst of triggers must produce a single send');
  });

  await check('sequential sends are each delivered', async () => {
    const lock = createSendLock();
    const sent = [];
    await lock.run(async () => { sent.push('first'); await tick(5); });
    await lock.run(async () => { sent.push('second'); await tick(5); });
    assert.deepEqual(sent, ['first', 'second'], 'the guard must not swallow later messages');
  });

  await check('a rejected concurrent send does not reject the caller', async () => {
    // Returning null keeps the composer's optimistic UI honest: the duplicate is
    // simply not performed, and no error toast is shown for a send that was
    // never attempted.
    const lock = createSendLock();
    const first = lock.run(async () => { await tick(10); return 'first'; });
    const dup = await lock.run(async () => 'dup');
    assert.equal(dup, null);
    assert.equal(await first, 'first');
  });

  console.log(`\n${passed} checks passed`);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
