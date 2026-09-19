/**
 * Phase 6.3 — live WebSocket merge vs canonical merge.
 *
 * The hub page merges live WS messages. It used to do so with an INLINE
 * `findIndex` block while refresh / reconnect / sync-chunk / pagination all used
 * `mergeWhatsAppMessages`. Two implementations of one job drift.
 *
 * MODE DETECTION (so this file is the fail->pass proof, not a dead test):
 *   - hub still has the inline block  -> require inline == canonical (FAILS pre-fix)
 *   - hub uses the canonical helper   -> require the pattern + lock canonical
 *                                        behaviour on the whole matrix
 *
 * REAL CODE: `mergeWhatsAppMessages` is transpiled and imported from source.
 * The historical inline block is kept below as `legacyInlineMerge` and is pinned
 * to the shipped source whenever that mode is active, so it cannot drift.
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');
const HUB = path.join(SRC, 'pages/WhatsAppHubPage.tsx');
const MERGE_TS = path.join(SRC, 'features/whatsapp/lib/whatsappMessageMerge.ts');

async function loadModule(file) {
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const { mergeWhatsAppMessages, mergeDeliveryStatus } = await loadModule(MERGE_TS);

const hubSrc = fs.readFileSync(HUB, 'utf8');

/**
 * Verbatim copy of the historical inline block (WhatsAppHubPage.tsx:1162-1187).
 * Kept so the harness can still report what the pre-fix behaviour produced.
 */
function legacyInlineMerge(list, newMsg) {
  const waId = newMsg.wa_message_id;
  const clientMid = newMsg.client_message_id;
  const msgId = newMsg.id;
  const existingIdx = list.findIndex(
    (m) =>
      (waId && m.wa_message_id === waId) ||
      (clientMid && m.client_message_id === clientMid) ||
      (msgId && m.id === msgId)
  );
  if (existingIdx !== -1) {
    const updatedList = [...list];
    updatedList[existingIdx] = {
      ...updatedList[existingIdx],
      ...newMsg,
      status: mergeDeliveryStatus(updatedList[existingIdx].status, newMsg.status),
    };
    return updatedList;
  }
  return [...list, newMsg].sort((a, b) => {
    const tA = new Date(a.created_at || a.external_timestamp || 0).getTime();
    const tB = new Date(b.created_at || b.external_timestamp || 0).getTime();
    if (tA !== tB) return tA - tB;
    const nA = typeof a.id === 'number' ? a.id : 0;
    const nB = typeof b.id === 'number' ? b.id : 0;
    return nA - nB;
  });
}

const CANONICAL_LIVE_PATTERN = /mergeWhatsAppMessages\(prev\[convId\] \|\| \[\], \[newMsg\]\)/;
const INLINE_PATTERN = /const existingIdx = list\.findIndex\(/;

const mode = INLINE_PATTERN.test(hubSrc) ? 'inline' : 'canonical';
console.log(`hub page live-WS merge mode: ${mode}\n`);

if (mode === 'inline') {
  // Pin the verbatim copy to the shipped source.
  assert.ok(
    /\(waId && m\.wa_message_id === waId\)/.test(hubSrc) &&
      /\(clientMid && m\.client_message_id === clientMid\)/.test(hubSrc) &&
      /\(msgId && m\.id === msgId\)/.test(hubSrc),
    'the inline live-WS identity keys changed — update this harness'
  );
} else {
  assert.ok(
    CANONICAL_LIVE_PATTERN.test(hubSrc),
    'the live WS new-message block must merge via mergeWhatsAppMessages(prev[convId] || [], [newMsg])'
  );
  assert.ok(
    !INLINE_PATTERN.test(hubSrc),
    'the live WS path must not keep a second, inline merge implementation'
  );
}

// --- fixtures -------------------------------------------------------------
/** Build the message object the live WS path hands to its merge (hub :1144-1160). */
function buildEventMessage(event) {
  return {
    id: event.id ?? Date.now(),
    conversation_id: 1,
    direction: event.direction || 'OUTBOUND',
    message_type: 'TEXT',
    status: event.status || (event.direction === 'INBOUND' ? 'RECEIVED' : 'PENDING'),
    body: typeof event.body === 'string' ? event.body : '',
    wa_message_id: event.wa_message_id,
    client_message_id: event.client_message_id,
    sender_name: undefined,
    sender_phone: '',
    media_id: undefined,
    media_mime_type: undefined,
    media_filename: undefined,
    media_caption: undefined,
    created_at: event.created_at || '2026-01-01T00:00:00Z',
  };
}

const summarize = (list) =>
  list.map((m) => ({
    id: m.id,
    wa: m.wa_message_id ?? null,
    client: m.client_message_id ?? null,
    status: m.status,
    body: m.body,
  }));

const applySequence = (events, apply) =>
  events.reduce((list, e) => apply(list, buildEventMessage(e)), []);

// --- the matrix -----------------------------------------------------------
// `expect` locks canonical behaviour: [rowCount, {id, status, wa, client}?]
const ROWS = [
  {
    name: 'optimistic + echo',
    events: [
      { id: -1, client_message_id: 'C1', status: 'PENDING', body: 'merhaba' },
      { id: 1, client_message_id: 'C1', wa_message_id: 'W1', status: 'SENT', body: 'merhaba' },
    ],
    expect: [1, { id: 1, wa: 'W1', client: 'C1', status: 'SENT', body: 'merhaba' }],
  },
  {
    name: 'missing client id (echo has wa only)',
    events: [
      { id: -1, client_message_id: 'C1', status: 'PENDING', body: 'merhaba' },
      { id: 1, client_message_id: null, wa_message_id: 'W1', status: 'SENT', body: 'merhaba' },
    ],
    // Identity is not yet linkable: no single event carries both keys.
    expect: [2],
  },
  {
    name: 'late identity link',
    events: [
      { id: -1, client_message_id: 'C1', status: 'PENDING', body: 'merhaba' },
      { id: 1, client_message_id: null, wa_message_id: 'W1', status: 'SENT', body: 'merhaba' },
      { id: 1, client_message_id: 'C1', wa_message_id: 'W1', status: 'DELIVERED', body: 'merhaba' },
    ],
    expect: [1, { id: 1, wa: 'W1', client: 'C1', status: 'DELIVERED', body: 'merhaba' }],
  },
  {
    name: 'status update',
    events: [
      { id: 1, client_message_id: 'C1', wa_message_id: 'W1', status: 'SENT', body: 'merhaba' },
      { id: 1, client_message_id: 'C1', wa_message_id: 'W1', status: 'DELIVERED', body: 'merhaba' },
    ],
    expect: [1, { id: 1, wa: 'W1', client: 'C1', status: 'DELIVERED', body: 'merhaba' }],
  },
  {
    name: 'same wa_message_id, different db id',
    events: [
      { id: 1, wa_message_id: 'W1', status: 'SENT', body: 'merhaba' },
      { id: 2, wa_message_id: 'W1', status: 'DELIVERED', body: 'merhaba' },
    ],
    expect: [1, { id: 2, wa: 'W1', status: 'DELIVERED', body: 'merhaba' }],
  },
  {
    name: 'same client_message_id, no wa_message_id',
    events: [
      { id: -1, client_message_id: 'C1', status: 'PENDING', body: 'merhaba' },
      { id: 1, client_message_id: 'C1', status: 'SENT', body: 'merhaba' },
    ],
    expect: [1, { id: 1, client: 'C1', status: 'SENT', body: 'merhaba' }],
  },
  {
    name: 'duplicate event (replay)',
    events: [
      { id: 1, wa_message_id: 'W1', client_message_id: 'C1', status: 'SENT', body: 'merhaba' },
      { id: 1, wa_message_id: 'W1', client_message_id: 'C1', status: 'SENT', body: 'merhaba' },
    ],
    expect: [1, { id: 1, wa: 'W1', client: 'C1', status: 'SENT', body: 'merhaba' }],
  },
  {
    name: 'missing wa id',
    events: [
      { id: 1, client_message_id: 'C1', status: 'SENT', body: 'merhaba' },
      { id: 1, client_message_id: 'C1', status: 'DELIVERED', body: 'merhaba' },
    ],
    expect: [1, { id: 1, client: 'C1', status: 'DELIVERED', body: 'merhaba' }],
  },
  {
    name: 'status update without body',
    events: [
      { id: 1, client_message_id: 'C1', wa_message_id: 'W1', status: 'SENT', body: 'merhaba' },
      { id: 1, client_message_id: 'C1', wa_message_id: 'W1', status: 'DELIVERED' },
    ],
    // DOCUMENTED: an event with no text blanks the body. Shared by both paths;
    // not a divergence, so out of scope for the canonicalization.
    expect: [1, { id: 1, status: 'DELIVERED', body: '' }],
  },
  {
    name: 'inbound then outbound ordering',
    events: [
      { id: 1, wa_message_id: 'W1', status: 'RECEIVED', direction: 'INBOUND', body: 'selam', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, client_message_id: 'C1', status: 'SENT', body: 'merhaba', created_at: '2026-01-01T00:00:05Z' },
    ],
    expect: [2, { id: 1, status: 'RECEIVED', body: 'selam' }],
  },
];

// --- run ------------------------------------------------------------------
const canonicalOf = (list, msg) => mergeWhatsAppMessages(list, [msg]);
const pad = (s, n) => String(s).padEnd(n);

console.log(pad('EVENT', 42) + pad('ROWS', 7) + pad('AGREE', 8) + 'CANONICAL');
console.log('-'.repeat(110));

const failures = [];
for (const row of ROWS) {
  const canonical = applySequence(row.events, canonicalOf);
  const legacy = applySequence(row.events, legacyInlineMerge);
  const [expectedRows, expectedFirst] = row.expect;
  const agree = JSON.stringify(summarize(canonical)) === JSON.stringify(summarize(legacy));

  let ok = canonical.length === expectedRows;
  if (ok && expectedFirst) {
    const first = summarize(canonical)[0];
    for (const [k, v] of Object.entries(expectedFirst)) {
      if (first[k] !== v) ok = false;
    }
  }
  if (!ok) {
    failures.push(row.name);
  }

  console.log(
    pad(row.name, 42) + pad(String(canonical.length), 7) + pad(agree ? 'yes' : 'NO', 8) +
      JSON.stringify(summarize(canonical))
  );
  if (!agree) {
    console.log(`${' '.repeat(42)}${' '.repeat(7)}${' '.repeat(8)}legacy inline: ` +
      JSON.stringify(summarize(legacy)));
  }
}

console.log('');

// --- performance (§5): no accidental O(n^2) on a big thread ---------------
const big = Array.from({ length: 500 }, (_, i) => ({
  ...buildEventMessage({ id: i + 1, wa_message_id: `W${i}`, status: 'READ', body: `m${i}` }),
  created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
}));
let perf = [...big];
const t0 = performance.now();
for (let i = 0; i < 200; i += 1) {
  perf = canonicalOf(perf, buildEventMessage({
    id: 500 + i + 1,
    wa_message_id: `NEW${i}`,
    client_message_id: `C${i}`,
    status: 'SENT',
    body: `new${i}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 1, i)).toISOString(),
  }));
}
const elapsed = performance.now() - t0;
console.log(`perf: 500-message thread + 200 live events -> ${elapsed.toFixed(1)}ms (${perf.length} rows)`);
// Generous bound: correctness first, but catch a genuine O(n^2) regression.
assert.ok(elapsed < 2000, `live merge too slow: ${elapsed.toFixed(1)}ms for 200 events`);

// --- assertions -----------------------------------------------------------
assert.deepEqual(
  failures,
  [],
  `canonical merge no longer behaves as locked for: ${failures.join(', ')}`
);

if (mode === 'inline') {
  const divergent = ROWS.filter(
    (r) =>
      JSON.stringify(summarize(applySequence(r.events, canonicalOf))) !==
      JSON.stringify(summarize(applySequence(r.events, legacyInlineMerge)))
  );
  assert.equal(
    divergent.length,
    0,
    `the live WS path still diverges from the canonical helper on: ` +
      `${divergent.map((r) => r.name).join(', ')}`
  );
}

console.log(`\nLive WS merge == canonical merge: PASS (${ROWS.length} rows, mode=${mode})`);
