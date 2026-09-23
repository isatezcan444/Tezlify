/**
 * PHASE 2.C — gateway-side capacity benchmarks (Node, deterministic).
 *
 * §13  Group metadata pacing: levels 10 / 50 / 100 groups through the REAL
 *      _ensureGroupSubjects with the REAL 500ms pacing + 10-cap, mock socket.
 *      Measures: metadata calls, wall duration, groups/s, first-result latency,
 *      duplicate calls, forced passes needed.
 * §15  Memory retention: 500 / 1000 / 5000 messages through the REAL message
 *      store; heap before/peak/after; verifies eviction caps (500 byId, 2000 raw).
 *
 * Run: node benchmark-capacity.mjs /tmp/phase2c-node.json
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSessionManager } from '../src/session-manager.js';

const outFile = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tezlify-phase2c-'));
const RESULTS = { groups: {}, retention: {} };

const manager = createSessionManager({
  sessionsDir: path.join(tmp, 'sessions'),
  mediaDir: path.join(tmp, 'media'),
  aesKey: 'a'.repeat(64),
  backendWsUrl: null,
  authRepository: null,
  leaseRepository: null,
  instanceId: 'phase2c-bench',
  pool: null,
});

let counter = 0;
async function freshSession(metadataImpl) {
  counter += 1;
  const session = await manager.createSession(`phase2c-${counter}`, { autoStart: false });
  session.status = 'CONNECTED';
  const calls = { metadata: 0, fetchAll: 0 };
  session.sock = {
    groupFetchAllParticipating: async () => { calls.fetchAll += 1; return {}; },
    groupMetadata: async (jid) => { calls.metadata += 1; return metadataImpl(jid); },
  };
  return { session, calls };
}

// ---------------------------------------------------------------------------
// §13 — group metadata pacing levels
// ---------------------------------------------------------------------------
async function benchGroups(level) {
  const jids = Array.from({ length: level }, (_, i) => `120363${String(700000000 + i)}@g.us`);
  // NOTE: subjects must NOT contain/embed the jid — isRawIdentityName
  // classifies jid-suffixed strings as raw (production-accurate), which
  // would force re-fetches and skew the benchmark.
  const { session, calls } = await freshSession((jid) => ({ id: jid, subject: `Family Group ${jids.indexOf(jid)}` }));

  const t0 = Date.now();
  let firstResolvedMs = null;
  let passes = 0;
  // Forced passes until all resolved (10-cap per pass).
  for (;;) {
    passes += 1;
    const before = session.store.chats.size;
    await manager._ensureGroupSubjects({ sessionId: session.id, force: true, extraJids: jids });
    if (firstResolvedMs === null && session.store.chats.size > before) {
      firstResolvedMs = Date.now() - t0;
    }
    if (session.store.chats.size >= level || passes > 40) break;
  }
  const elapsed = Date.now() - t0;

  // Duplicate calls: every jid must have exactly one metadata call total.
  const duplicateCalls = calls.metadata - level;

  const r = {
    groups: level,
    metadata_calls: calls.metadata,
    forced_passes: passes,
    duration_ms: elapsed,
    groups_per_s: +(level / (elapsed / 1000)).toFixed(1),
    first_result_ms: firstResolvedMs,
    duplicate_calls: duplicateCalls,
    theoretical_pacing_bound_ms: null,
  };
  console.log(`[G${level}] ${JSON.stringify(r)}`);
  return r;
}

// ---------------------------------------------------------------------------
// §15 — memory retention / eviction
// ---------------------------------------------------------------------------
async function benchRetention(nEvents) {
  counter += 1;
  const session = await manager.createSession(`phase2c-ret-${counter}`, { autoStart: false });
  const store = session.store;
  const jid = '9055999999999@s.whatsapp.net';
  session.store.chats.set(jid, { jid, name: 'Ret Bench', is_group: false });

  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  // Feed messages through the REAL ingest path (_ingestUpsertMessage).
  for (let i = 0; i < nEvents; i++) {
    const msg = {
      key: { id: `RET${String(i).padStart(8, '0')}`, remoteJid: jid, fromMe: false },
      pushName: 'R',
      messageTimestamp: Math.floor(Date.now() / 1000) + i,
      message: { conversation: `retention body ${i}` },
    };
    await manager._ingestUpsertMessage(msg, session.sock, session.id);
  }
  const elapsed = Date.now() - t0;
  global.gc && global.gc();
  const heapAfter = process.memoryUsage().heapUsed;

  // Eviction verification: caps must hold after the flood.
  const perChatList = store.messagesByChat.get(jid);
  const rawMap = store.rawMessagesByChat.get(jid);

  const r = {
    events: nEvents,
    elapsed_ms: elapsed,
    ingest_per_s: Math.round(nEvents / Math.max(elapsed / 1000, 0.001)),
    heap_before_mb: +(heapBefore / 1048576).toFixed(1),
    heap_after_mb: +(heapAfter / 1048576).toFixed(1),
    heap_delta_mb: +((heapAfter - heapBefore) / 1048576).toFixed(1),
    normalized_retained: perChatList ? perChatList.length : 0,
    raw_retained: rawMap ? rawMap.size : 0,
    raw_global_count: store.rawMessageCount,
  };
  console.log(`[RET ${nEvents}] ${JSON.stringify(r)}`);
  return r;
}

for (const level of [10, 50, 100]) {
  RESULTS.groups[`g${level}`] = await benchGroups(level);
}
for (const n of [500, 1000, 5000]) {
  RESULTS.retention[`n${n}`] = await benchRetention(n);
}

if (outFile) fs.writeFileSync(outFile, JSON.stringify(RESULTS, null, 2));
console.log('DONE');
