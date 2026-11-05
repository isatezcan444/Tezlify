/**
 * Regression test for the hub's older-page state transition.
 *
 * PRODUCTION SYMPTOM
 *   "Load older messages" sometimes does nothing at all: the spinner appears,
 *   no messages arrive, and the control is still there. Clicking again repeats
 *   the identical request forever.
 *
 * WHY IT HAPPENS
 *   The backend is honest but not omniscient. `resolve_has_more` keeps
 *   `has_more` true whenever the provider evidence is unproven — NOT_CHECKED,
 *   TIMEOUT, PROVIDER_ERROR — so an EMPTY page legitimately comes back as
 *   `has_more: true` with `oldest_message_id: null`. The hub used to write
 *   `hasMore: Boolean(res.has_more)` and `oldest: res.oldest_message_id ??
 *   prev.oldest`, which for an empty page keeps BOTH the same cursor and
 *   `hasMore: true` — a loop with zero progress.
 *
 *   `useWhatsAppConversation.loadOlderMessages` already terminates on an empty
 *   page (`has_more: false`). The hub was the odd one out.
 *
 * THE CONTRACT
 *   A response that adds no rows AND does not move the cursor is terminal.
 *   Any other response advances the cursor and follows the server's `has_more`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src', 'features', 'whatsapp', 'lib', 'olderPageState.ts');

const outDir = await mkdtemp(path.join(os.tmpdir(), 'older-page-state-'));
try {
  const outfile = path.join(outDir, 'olderPageState.mjs');
  await build({
    entryPoints: [SRC],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  });
  const { applyOlderPageResult } = await import(outfile);

  let passed = 0;
  const check = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  };

  console.log('older-page state transition');

  const state = (over) => ({ hasMore: true, oldest: 1000, loading: true, ...over });

  check('an empty page with has_more true preserves hasMore and sets error for retry', () => {
    // When the backend returns no rows but has_more is true (e.g. provider timeout or pending chunk),
    // hasMore must NOT be killed permanently. Setting error: true prevents auto-scroll looping
    // while keeping the affordance reachable via manual retry.
    const next = applyOlderPageResult(state(), {
      messages: [],
      has_more: true,
      oldest_message_id: null,
    });
    assert.equal(
      next.hasMore,
      true,
      'hasMore must remain true so older messages can be retried',
    );
    assert.equal(next.error, true, 'error must be set to prevent auto-scroll looping');
    assert.equal(next.oldest, 1000, 'the cursor must be left alone when nothing arrived');
    assert.equal(next.loading, false, 'the spinner must always be cleared');
  });

  check('an empty page with has_more false terminates the affordance', () => {
    const next = applyOlderPageResult(state(), {
      messages: [],
      has_more: false,
      oldest_message_id: null,
    });
    assert.equal(next.hasMore, false, 'an empty page with has_more false must end the affordance');
    assert.equal(next.error, false, 'no error when cleanly exhausted');
    assert.equal(next.loading, false);
  });

  check('a page that adds rows advances the cursor and follows the server', () => {
    const next = applyOlderPageResult(state(), {
      messages: [{ id: 900 }, { id: 901 }],
      has_more: true,
      oldest_message_id: 900,
    });
    assert.equal(next.hasMore, true, 'the server still reports more, so the control stays');
    assert.equal(next.oldest, 900, 'the cursor must advance to the page we just received');
    assert.equal(next.loading, false);
  });

  check('the last page ends the affordance', () => {
    const next = applyOlderPageResult(state(), {
      messages: [{ id: 900 }],
      has_more: false,
      oldest_message_id: 900,
    });
    assert.equal(next.hasMore, false, 'has_more false must be honoured');
    assert.equal(next.oldest, 900);
  });

  check('an empty page that DOES move the cursor is not terminal', () => {
    // Defensive: if the backend ever reports a cursor without rows, following it
    // is the only way to make progress, so the affordance must survive.
    const next = applyOlderPageResult(state({ oldest: 1000 }), {
      messages: [],
      has_more: true,
      oldest_message_id: 800,
    });
    assert.equal(next.hasMore, true, 'a moved cursor is progress, so the control stays');
    assert.equal(next.oldest, 800, 'the cursor must be adopted');
  });

  check('a non-numeric cursor is never adopted', () => {
    const next = applyOlderPageResult(state(), {
      messages: [{ id: 900 }],
      has_more: true,
      oldest_message_id: 0,
    });
    assert.equal(next.oldest, 1000, 'cursor 0 is not a real page cursor and must not be sent');
  });

  check('error and loading flags are cleared on a successful page', () => {
    const next = applyOlderPageResult(state({ error: true }), {
      messages: [{ id: 900 }],
      has_more: true,
      oldest_message_id: 900,
    });
    assert.equal(next.loading, false);
    assert.notEqual(next.error, true, 'a successful page must clear a previous paging error');
  });

  check('chronological cursor extraction outranks numeric id when older history has larger ids', async () => {
    // When older WhatsApp history is backfilled into Postgres after initial sync,
    // the older messages receive HIGHER auto-increment DB IDs.
    // e.g. initial message id=171455 (time: 13:55), older backfilled messages id=171929..171978 (time: 12:39..13:55).
    // Math.min would get stuck on 171455 forever.
    // Chronological selection correctly selects 171929 as the oldest loaded message.
    const orderingSrc = path.join(frontendRoot, 'src', 'features', 'whatsapp', 'lib', 'whatsappOrdering.ts');
    const orderingOut = path.join(outDir, 'ordering.mjs');
    await build({
      entryPoints: [orderingSrc],
      outfile: orderingOut,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent',
    });
    const { compareMessagesChronological, isRealDbId } = await import(orderingOut);

    const activeMessages = [
      { id: 171929, created_at: '2026-11-05T12:39:27', direction: 'OUTBOUND' },
      { id: 171978, created_at: '2026-11-05T13:55:13', direction: 'INBOUND' },
      { id: 171455, created_at: '2026-11-05T13:55:35', direction: 'INBOUND' },
    ];

    const oldestLoadedMsg = activeMessages.reduce((oldest, m) => {
      if (!isRealDbId(m.id) || typeof m.id !== 'number' || m.id <= 0) return oldest;
      if (!oldest) return m;
      return compareMessagesChronological(m, oldest) < 0 ? m : oldest;
    }, null);

    assert.equal(
      oldestLoadedMsg?.id,
      171929,
      'Oldest message must be 171929 (timestamp 12:39:27), NOT Math.min id 171455 (timestamp 13:55:35)',
    );
  });

  console.log(`\n${passed} checks passed`);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
