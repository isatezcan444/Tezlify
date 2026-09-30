// Orphaned-session reporting.
//
// PRODUCTION 2026-09-29, right after the operator re-paired the number:
//   ERROR: insert or update on table "event_outbox" violates foreign key
//          constraint "event_outbox_session_id_fkey"
//   ERROR: insert or update on table "lid_mappings" violates foreign key
//          constraint "lid_mappings_session_id_fkey"
//
// Root cause: re-pairing deletes the old whatsapp_sessions row, but the
// in-memory gateway session keeps emitting. Every durable write then fails the
// foreign key. Both call sites CAUGHT that error and fell back to a
// best-effort path, so the product looked healthy while the outbox stayed
// empty and nothing durable was written — exactly the "mask the failure"
// behaviour the project rules forbid.
//
// These checks pin the contract: a foreign-key violation is reported once with
// an actionable message, it is not retried, and the caller still gets its
// payload so the socket path keeps working. Any OTHER error must propagate.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  createPostgresEventOutbox,
  reportOrphanedSession,
  resetOrphanReports,
  orphanReports,
  PG_FOREIGN_KEY_VIOLATION,
} from '../src/outbox/postgres-event-outbox.js';

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// The codec requires a 32-byte Buffer, not a hex string.
const KEY = Buffer.alloc(32, 0);

function outboxWithQuery(queryImpl) {
  return createPostgresEventOutbox({ encryptionKey: KEY, pool: { query: queryImpl } });
}

const fkError = () => Object.assign(new Error('violates foreign key constraint'), {
  code: PG_FOREIGN_KEY_VIOLATION,
});

async function capture(fn) {
  const original = console.error;
  const logged = [];
  // pino-style: error(metaObject, message). Keep BOTH so assertions can read
  // the human-readable text, which is the whole point of the report.
  console.error = (obj, message) => logged.push(
    typeof obj === 'string' && message === undefined
      ? { message: obj }
      : { ...obj, message: message ?? obj?.message },
  );
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
}

await check('a foreign-key violation is reported, not silently swallowed', async () => {
  resetOrphanReports();
  const logged = await capture(async () => {
    const outbox = outboxWithQuery(async () => { throw fkError(); });
    // Must NOT throw: the caller falls back to the socket path, and throwing
    // here would turn a dead session into a crash.
    const payload = await outbox.enqueue({
      gateway_session_id: 'sess-gone', event: 'conversation_updated',
    });
    assert.ok(payload, 'the caller must still receive the payload');
  });
  assert.equal(orphanReports().length, 1, 'the orphan must be reported');
  assert.ok(
    logged.some((l) => String(l?.message || '').includes('DISCARDED')),
    'the report must say the durable write is being discarded',
  );
});

await check('the report names the cause and the remedy', async () => {
  resetOrphanReports();
  const logged = await capture(async () => {
    reportOrphanedSession('event_outbox', 'sess-x', 'conversation_updated');
  });
  const message = String(logged[0]?.message || '');
  assert.ok(/re-paired/i.test(message), 'must name the most likely cause');
  assert.ok(/re-pair|restart/i.test(message), 'must state the remedy');
});

await check('the diagnosis is reported ONCE per table+session', async () => {
  resetOrphanReports();
  const logged = await capture(async () => {
    const outbox = outboxWithQuery(async () => { throw fkError(); });
    for (let i = 0; i < 25; i += 1) {
      await outbox.enqueue({ gateway_session_id: 'sess-noisy', event: 'x' });
    }
  });
  // A repeating foreign key is ONE problem. 25 identical stack dumps would bury
  // it, which is how this went unnoticed in the first place.
  assert.equal(logged.length, 1, `expected one report, got ${logged.length}`);
});

await check('a different session gets its own report', async () => {
  resetOrphanReports();
  const logged = await capture(async () => {
    reportOrphanedSession('lid_mappings', 'a');
    reportOrphanedSession('lid_mappings', 'b');
  });
  assert.equal(logged.length, 2, 'two sessions are two problems');
});

await check('a NON foreign-key error still propagates', async () => {
  resetOrphanReports();
  await capture(async () => {
    const outbox = outboxWithQuery(async () => { throw new Error('connection reset'); });
    await assert.rejects(
      () => outbox.enqueue({ gateway_session_id: 'sess-ok', event: 'x' }),
      /connection reset/,
      'a real database failure must not be mistaken for an orphan session',
    );
    assert.equal(orphanReports().length, 0, 'must not be reported as an orphan');
  });
});

await check('a healthy insert reports nothing and stores the row', async () => {
  resetOrphanReports();
  const seen = [];
  const logged = await capture(async () => {
    const outbox = outboxWithQuery(async (sql, params) => {
      seen.push(params);
      return { rows: [] };
    });
    await outbox.enqueue({ gateway_session_id: 'sess-ok', event: 'message_new' });
  });
  assert.equal(logged.length, 0, 'a healthy write must be silent');
  assert.equal(seen.length, 1, 'the row must actually be written');
  assert.equal(seen[0][1], 'sess-ok', 'the session id must be the gateway session');
});


// --- The session must be MARKED, not just logged -----------------------------
await check('a foreign-key violation marks the session as orphaned', async () => {
  resetOrphanReports();
  const marked = [];
  await capture(async () => {
    const outbox = createPostgresEventOutbox({
      encryptionKey: KEY,
      pool: { query: async () => { throw fkError(); } },
      onOrphaned: (id, detail) => marked.push({ id, detail }),
    });
    await outbox.enqueue({ gateway_session_id: 'sess-marked', event: 'message_new' });
  });
  assert.equal(marked.length, 1, 'the session must be marked, not only logged');
  assert.equal(marked[0].id, 'sess-marked');
});

await check('a missing onOrphaned callback is not an error', async () => {
  resetOrphanReports();
  await capture(async () => {
    const outbox = createPostgresEventOutbox({
      encryptionKey: KEY,
      pool: { query: async () => { throw fkError(); } },
    });
    // Reporting must never be the thing that breaks a live session.
    const payload = await outbox.enqueue({ gateway_session_id: 'sess-x', event: 'x' });
    assert.ok(payload);
  });
});

await check('a throwing onOrphaned callback does not propagate', async () => {
  resetOrphanReports();
  await capture(async () => {
    const outbox = createPostgresEventOutbox({
      encryptionKey: KEY,
      pool: { query: async () => { throw fkError(); } },
      onOrphaned: () => { throw new Error('reporting blew up'); },
    });
    const payload = await outbox.enqueue({ gateway_session_id: 'sess-y', event: 'x' });
    assert.ok(payload, 'the payload must still be returned');
  });
});

console.log(`\nOrphaned session reporting: PASS (${passed} checks)`);
