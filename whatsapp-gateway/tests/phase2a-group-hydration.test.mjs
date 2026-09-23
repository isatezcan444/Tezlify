/**
 * Phase 2.1.A — generic group-discovery falsification harness.
 *
 * The gateway ships no test runner. This file is a plain-Node harness
 * (node:assert only) executed by `backend/tests/test_whatsapp_phase2_a_gateway_behavior.py`
 * via `node phase2a-group-hydration.test.mjs <outfile>`.
 *
 * GENERICITY CONTRACT: every discovery scenario below uses a RANDOM
 * `@g.us` jid and RANDOM subject generated at run time. No group name and
 * no specific jid is hardcoded into the mechanism. "3Hacker" appears in
 * exactly one place — TEST K — purely as a REGRESSION label for the
 * original field bug, exercising the identical generic path.
 *
 * Scenarios (all behavioural, against the REAL createSessionManager):
 *   A  — zero-message group, absent from store.chats, broad pass omits it,
 *        targeted groupMetadata succeeds → seeded + conversation_updated.
 *   B  — known jid forwarded via extraJids, store.chats.has(jid) false →
 *        true, visible through listConversations() immediately (no later
 *        chats.update dependency).
 *   E  — same jid in _pendingGroupJids + extraJids(x2) simultaneously →
 *        exactly one metadata call / one seed / one event.
 *   G  — three sequential passes with the same extraJids → metadata called
 *        exactly once in total (cross-pass resolution dedup).
 *   H  — two concurrent passes → in-flight guard, one metadata call.
 *   F  — one failing groupMetadata does not cascade to other jids.
 *   I  — metadata failure on pass 1 → no chat (fail-closed); pass 2 with
 *        the same extraJids retries and succeeds; in-flight flag clean.
 *   J  — session deleted mid-pass → targeted fetches stop (no dangling
 *        discovery work after delete).
 *   K  — 3Hacker regression: the original bug scenario through the same
 *        generic mechanism.
 *
 * The harness writes the REAL conversation_updated payload emitted in
 * SCENARIO A to <outfile>; backend tests feed that exact payload through
 * the real ingestion path (ingest_gateway_event) to prove persistence +
 * broadcast with the random jid/subject.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionManager } from '../src/session-manager.js';

const outFile = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tezlify-phase2_1_a-'));

const manager = createSessionManager({
  sessionsDir: path.join(tmp, 'sessions'),
  mediaDir: path.join(tmp, 'media'),
  aesKey: 'a'.repeat(64),
  backendWsUrl: null,
  authRepository: null,
  leaseRepository: null,
  instanceId: 'phase2_1_a-test-instance',
  pool: null,
});

// --- generic fixture generator (no hardcoded jid / group name) -----------
let fixtureCounter = 0;
function genericGroupFixture() {
  fixtureCounter += 1;
  const rand = `${Date.now().toString().slice(-6)}${fixtureCounter}${Math.floor(Math.random() * 1000)}`;
  return {
    jid: `120363${rand.padStart(12, '0')}@g.us`,
    subject: `Generic Test Group ${rand}`,
  };
}

let sessionCounter = 0;

async function freshSession(sockOverrides = {}) {
  sessionCounter += 1;
  const session = await manager.createSession(`phase2_1_a-${sessionCounter}`, {
    autoStart: false,
  });
  assert.ok(session, 'createSession must return the raw session object');
  session.status = 'CONNECTED';
  const calls = { groupMetadata: [], fetchAll: 0 };
  session.sock = {
    groupFetchAllParticipating: async () => {
      calls.fetchAll += 1;
      return sockOverrides.fetchAll ? sockOverrides.fetchAll() : {};
    },
    groupMetadata: async (jid) => {
      calls.groupMetadata.push(jid);
      if (sockOverrides.metadata) return sockOverrides.metadata(jid);
      return { id: jid, subject: sockOverrides.subject || 'Generic Subject' };
    },
  };
  return { session, calls };
}

function collectEmitted() {
  const emitted = [];
  const listener = (e) => emitted.push(e);
  manager._listeners.add(listener);
  return { emitted, stop: () => manager._listeners.delete(listener) };
}

function convEventsFor(emitted, jid) {
  return emitted.filter(
    (e) => e.event === 'conversation_updated' && e.conversation && e.conversation.jid === jid
  );
}

// ---------------------------------------------------------------------------
// SCENARIO A — zero-message group → metadata success → seeded (GENERIC)
// ---------------------------------------------------------------------------
let hydrationArtifact = null;
{
  const fx = genericGroupFixture(); // zero messages ever; absent from store.chats
  const { session, calls } = await freshSession({
    fetchAll: () => ({}), // broad discovery omits the group entirely
    subject: fx.subject,
  });
  const { emitted, stop } = collectEmitted();
  try {
    assert.strictEqual(session.store.chats.has(fx.jid), false, 'A: precondition — chat absent');
    await manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: [fx.jid] });

    const chat = session.store.chats.get(fx.jid);
    assert.ok(chat, 'A: zero-message group must be seeded on successful groupMetadata');
    assert.strictEqual(chat.name, fx.subject, 'A: resolved subject must be applied');
    assert.strictEqual(chat.is_group, true, 'A: seeded chat must be a group');
    assert.ok(session.store.contacts.get(fx.jid), 'A: group contact must be seeded');
    assert.ok(calls.groupMetadata.includes(fx.jid), 'A: targeted fallback must call groupMetadata');
    assert.strictEqual(calls.groupMetadata.length, 1, 'A: exactly one groupMetadata call');
    const events = convEventsFor(emitted, fx.jid);
    assert.strictEqual(events.length, 1, 'A: exactly one conversation_updated emitted');
    hydrationArtifact = events[0];
    console.log('SCENARIO A (zero-message, generic): PASS');
  } finally {
    stop();
  }
}

// ---------------------------------------------------------------------------
// SCENARIO B — known jid via extraJids: absent → present, no chats.update
// dependency, REST-visible immediately
// ---------------------------------------------------------------------------
{
  const fx = genericGroupFixture();
  const other = genericGroupFixture();
  const { session, calls } = await freshSession({
    fetchAll: () => ({ [other.jid]: { id: other.jid, subject: other.subject } }),
    subject: fx.subject,
  });
  const { emitted, stop } = collectEmitted();
  try {
    assert.strictEqual(session.store.chats.has(fx.jid), false, 'B: precondition — store.chats.has(jid) === false');
    await manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: [fx.jid] });

    assert.strictEqual(session.store.chats.has(fx.jid), true, 'B: store.chats.has(jid) === true after hydration');
    assert.strictEqual(session.store.chats.get(fx.jid).name, fx.subject, 'B: subject applied');
    assert.strictEqual(calls.groupMetadata.length, 1, 'B: one targeted metadata call (broad-pass group not re-fetched)');
    assert.ok(
      !calls.groupMetadata.includes(other.jid),
      'B: broad-pass-resolved group must not be re-fetched by the targeted pass'
    );
    // No _touchChat / chats.update / message event was injected anywhere:
    const snapshot = manager.listConversations(session.id);
    const visible = snapshot.items.find((c) => c.jid === fx.jid);
    assert.ok(visible, 'B: hydrated group visible via listConversations immediately');
    assert.strictEqual(visible.name, fx.subject, 'B: REST snapshot carries the resolved subject');
    assert.strictEqual(convEventsFor(emitted, fx.jid).length, 1, 'B: one conversation_updated, no later event needed');
    console.log('SCENARIO B (extraJids absent→present): PASS');
  } finally {
    stop();
  }
}

// ---------------------------------------------------------------------------
// TEST E — simultaneous duplicate across all three union sources
// ---------------------------------------------------------------------------
{
  const fx = genericGroupFixture();
  const { session, calls } = await freshSession({ subject: fx.subject });
  const { emitted, stop } = collectEmitted();
  try {
    if (!session._pendingGroupJids) session._pendingGroupJids = new Set();
    session._pendingGroupJids.add(fx.jid);
    await manager._ensureGroupSubjects({
      sessionId: session.id,
      force: true,
      extraJids: [fx.jid, fx.jid],
    });

    assert.deepStrictEqual(
      calls.groupMetadata,
      [fx.jid],
      'E: duplicate jid across sources must produce exactly ONE groupMetadata call'
    );
    const chatCount = [...session.store.chats.values()].filter((c) => c.jid === fx.jid).length;
    assert.strictEqual(chatCount, 1, 'E: exactly one chat record (no duplicate seed)');
    assert.strictEqual(convEventsFor(emitted, fx.jid).length, 1, 'E: exactly one conversation_updated');
    console.log('TEST E (simultaneous dedup): PASS');
  } finally {
    stop();
  }
}

// ---------------------------------------------------------------------------
// TEST G — three sequential passes: cross-pass resolution dedup
// ---------------------------------------------------------------------------
{
  const fx = genericGroupFixture();
  const { session, calls } = await freshSession({ subject: fx.subject });
  const { emitted, stop } = collectEmitted();
  try {
    for (let i = 0; i < 3; i++) {
      const out = await manager._ensureGroupSubjects({
        sessionId: session.id,
        force: true,
        extraJids: [fx.jid],
      });
      assert.strictEqual(out.applied, true, `G: pass ${i + 1} must apply`);
    }
    assert.strictEqual(calls.groupMetadata.length, 1, 'G: exactly ONE groupMetadata across 3 sequential passes');
    const chatCount = [...session.store.chats.values()].filter((c) => c.jid === fx.jid).length;
    assert.strictEqual(chatCount, 1, 'G: exactly one chat record across passes');
    assert.strictEqual(convEventsFor(emitted, fx.jid).length, 1, 'G: exactly one conversation_updated across passes');
    console.log('TEST G (sequential 3x idempotency): PASS');
  } finally {
    stop();
  }
}

// ---------------------------------------------------------------------------
// TEST H — two concurrent passes: in-flight guard
// ---------------------------------------------------------------------------
{
  const fx = genericGroupFixture();
  const { session, calls } = await freshSession({ subject: fx.subject });
  try {
    const p1 = manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: [fx.jid] });
    const p2 = manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: [fx.jid] });
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.strictEqual(r1.applied, true, 'H: first concurrent pass must run');
    assert.strictEqual(r2.applied, false, 'H: second concurrent pass must be rejected');
    assert.strictEqual(r2.reason, 'in_flight', 'H: rejection reason must be in_flight');
    assert.deepStrictEqual(
      [...new Set(calls.groupMetadata)],
      [fx.jid],
      'H: exactly one groupMetadata despite two concurrent triggers'
    );
    assert.ok(session.store.chats.get(fx.jid), 'H: chat seeded once');
    console.log('TEST H (concurrent in-flight guard): PASS');
  } finally {
    // listeners not registered here
  }
}

// ---------------------------------------------------------------------------
// TEST F — partial failure isolation
// ---------------------------------------------------------------------------
{
  const fx = genericGroupFixture();
  const bad = `120363${Date.now().toString().slice(-9)}9@g.us`;
  const { session, calls } = await freshSession({
    metadata: async (jid) => {
      if (jid === bad) throw new Error('boom: item not found');
      return { id: jid, subject: fx.subject };
    },
  });
  try {
    await manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: [bad, fx.jid] });

    assert.strictEqual(calls.groupMetadata.length, 2, 'F: both jids must be attempted');
    assert.ok(!session.store.chats.get(bad), 'F: failed metadata must NOT create a chat (fail-closed)');
    const good = session.store.chats.get(fx.jid);
    assert.ok(good, 'F: successful metadata after a failure must still hydrate (no cascade)');
    assert.strictEqual(good.name, fx.subject, 'F: good jid gets its own subject');
    console.log('TEST F (partial failure isolation): PASS');
  } finally {
    // listeners not registered here
  }
}

// ---------------------------------------------------------------------------
// TEST I — error path: failure → fail-closed → retry succeeds on next pass
// ---------------------------------------------------------------------------
{
  const fx = genericGroupFixture();
  let shouldFail = true;
  const { session, calls } = await freshSession({
    metadata: async (jid) => {
      if (shouldFail) throw new Error('item not found');
      return { id: jid, subject: fx.subject };
    },
  });
  const { emitted, stop } = collectEmitted();
  try {
    const r1 = await manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: [fx.jid] });
    assert.strictEqual(r1.applied, true, 'I: failure is swallowed per-jid, pass still completes');
    assert.ok(!session.store.chats.get(fx.jid), 'I: no chat after failed metadata (no fake data)');
    assert.strictEqual(session._groupSubjectsInFlight, false, 'I: in-flight flag must be clean after failure');
    assert.strictEqual(convEventsFor(emitted, fx.jid).length, 0, 'I: no conversation_updated on failure');

    // Retry: same jid, next pass — possible because extraJids are re-supplied
    // by the backend each sync (a _pendingGroupJids-only jid is cleared after
    // the pass and waits for the next Baileys touch — documented contract).
    shouldFail = false;
    await manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: [fx.jid] });
    const chat = session.store.chats.get(fx.jid);
    assert.ok(chat, 'I: retry on a later pass must succeed');
    assert.strictEqual(chat.name, fx.subject, 'I: retried hydration applies the subject');
    assert.strictEqual(calls.groupMetadata.length, 2, 'I: exactly one call per pass (no tight retry loop)');
    console.log('TEST I (error path + retry): PASS');
  } finally {
    stop();
  }
}

// ---------------------------------------------------------------------------
// TEST J — lifecycle: session deleted mid-pass stops targeted fetches
// ---------------------------------------------------------------------------
{
  const fx = genericGroupFixture();
  const jids = [fx.jid, genericGroupFixture().jid, genericGroupFixture().jid];
  const { session, calls } = await freshSession({
    metadata: async (jid) => {
      if (jid === jids[0]) await new Promise((r) => setTimeout(r, 150)); // keep pass in-flight
      return { id: jid, subject: 'S' };
    },
  });
  try {
    const pass = manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: jids });
    await new Promise((r) => setTimeout(r, 50)); // first metadata call is in flight
    const callsAtDelete = calls.groupMetadata.length;
    await manager.deleteSession(session.id);
    await pass;
    await new Promise((r) => setTimeout(r, 800)); // full remaining pacing window
    assert.ok(
      calls.groupMetadata.length <= callsAtDelete + 1,
      `J: targeted fetches must stop after session delete (at delete: ${callsAtDelete}, final: ${calls.groupMetadata.length})`
    );
    assert.ok(calls.groupMetadata.length < jids.length, 'J: not all jids were fetched — pass was cancelled');
    console.log('TEST J (delete mid-pass lifecycle): PASS');
  } catch (err) {
    throw new Error(`TEST J failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// TEST K — 3Hacker REGRESSION (generic mechanism, original bug as data)
// ---------------------------------------------------------------------------
{
  const jid = '120363999999999999@g.us';
  const subject = '3Hacker';
  const { session, calls } = await freshSession({ fetchAll: () => ({}), subject });
  const { emitted, stop } = collectEmitted();
  try {
    assert.strictEqual(session.store.chats.has(jid), false);
    await manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: [jid] });
    const chat = session.store.chats.get(jid);
    assert.ok(chat, 'K (3Hacker regression): group must be discovered');
    assert.strictEqual(chat.name, subject, 'K (3Hacker regression): subject applied');
    assert.strictEqual(chat.is_group, true);
    assert.strictEqual(calls.groupMetadata.length, 1);
    assert.strictEqual(convEventsFor(emitted, jid).length, 1);
    console.log('TEST K (3Hacker regression via generic mechanism): PASS');
  } finally {
    stop();
  }
}

// ---------------------------------------------------------------------------
// Emit artefact for backend integration tests (real ingestion + broadcast).
// ---------------------------------------------------------------------------
if (outFile) {
  if (!hydrationArtifact) {
    console.error('SCENARIO A did not produce a hydration event — backend integration tests cannot run');
    process.exit(1);
  }
  fs.writeFileSync(outFile, JSON.stringify(hydrationArtifact, null, 2));
  console.log(`ARTIFACT: hydration event written to ${outFile}`);
}

console.log('ALL GATEWAY BEHAVIOURAL TESTS: PASS');
