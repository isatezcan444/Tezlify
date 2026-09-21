// Phase 4 / G-3: gateway LID tenant-isolation tests.
//
// `whatsapp_private.lid_mappings` is keyed by the *gateway* session UUID and
// has no `user_id`. The tenant route is
//   lid_mappings.session_id -> public.whatsapp_sessions.gateway_id -> user_id
//
// Two gateway code paths used to ignore that:
//   * loadLidMappingsFromDb  -- unfiltered `DISTINCT ON (lid_jid)` over every
//                               tenant's rows
//   * syncLidMappingsFromDisk -- scanned *every* session directory and wrote
//                               the findings into the current session's store
//                               and DB rows
//
// Run: `node scripts/test-g3-lid-tenant-scope.mjs` (exit code 0 = PASS).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lidScopeSessionIds } from '../src/session-manager.js';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const USER_A = '11111111-2222-3333-4444-555555555501';
const USER_B = '11111111-2222-3333-4444-555555555502';

const GW_A = 'gw-a-1';
const GW_A2 = 'gw-a-2'; // second line of USER_A
const GW_B = 'gw-b-1';
const GW_ORPHAN = 'gw-orphan-1'; // registered line, no owning user

const LID = '900000000000001@lid';
const LID_B_ONLY = '900000000000003@lid';
const PHONE_A = '905321110001@s.whatsapp.net';
const PHONE_A2 = '905321110002@s.whatsapp.net';
const PHONE_B = '905321110003@s.whatsapp.net';

const SESSIONS = [
  { sessionId: GW_A, ownerId: USER_A },
  { sessionId: GW_A2, ownerId: USER_A },
  { sessionId: GW_B, ownerId: USER_B },
  { sessionId: GW_ORPHAN, ownerId: null },
];

const ownerOf = (sid) => {
  const row = SESSIONS.find((s) => s.sessionId === sid);
  return row ? row.ownerId : null;
};

// Mirrors the SQL row-set semantics after the fix:
//   SELECT DISTINCT ON (lid_jid) lid_jid, phone_jid
//   FROM whatsapp_private.lid_mappings
//   WHERE session_id = ANY($scope)
//   ORDER BY lid_jid, (session_id = $own) DESC, created_at DESC
function resolveWithScope(mappings, scope, ownSessionId) {
  const best = new Map();
  for (const m of mappings) {
    if (!scope.has(m.sessionId)) continue; // the isolation boundary
    const cur = best.get(m.lid);
    if (!cur) {
      best.set(m.lid, m);
      continue;
    }
    if (m.sessionId === ownSessionId && cur.sessionId !== ownSessionId) {
      best.set(m.lid, m);
    }
  }
  return best;
}

const resolveFor = (mappings, sessionId) =>
  resolveWithScope(mappings, lidScopeSessionIds(sessionId, ownerOf(sessionId), SESSIONS), sessionId);

// --- Test A: same LID, two tenants, different phones -> each sees its own ---

check('A: two tenants mapping the SAME lid to DIFFERENT phones stay isolated', () => {
  const mappings = [
    { sessionId: GW_A, lid: LID, phone: PHONE_A },
    { sessionId: GW_B, lid: LID, phone: PHONE_B },
  ];
  const a = resolveFor(mappings, GW_A);
  const b = resolveFor(mappings, GW_B);

  assert.equal(a.get(LID).phone, PHONE_A, 'tenant A must resolve its own phone');
  assert.equal(b.get(LID).phone, PHONE_B, 'tenant B must resolve its own phone');
  assert.notEqual(a.get(LID).phone, b.get(LID).phone);
});

check('A: A\'s scope excludes B\'s line (and vice versa)', () => {
  const scopeA = lidScopeSessionIds(GW_A, ownerOf(GW_A), SESSIONS);
  const scopeB = lidScopeSessionIds(GW_B, ownerOf(GW_B), SESSIONS);
  assert.ok(scopeA.has(GW_A));
  assert.equal(scopeA.has(GW_B), false, 'A must never read B\'s gateway session');
  assert.ok(scopeB.has(GW_B));
  assert.equal(scopeB.has(GW_A), false, 'B must never read A\'s gateway session');
});

// --- Test B: same user, two lines -> resolution still works (no over-isolation) ---

check('B: a mapping learned on the user\'s OTHER line still resolves', () => {
  const mappings = [{ sessionId: GW_A2, lid: LID, phone: PHONE_A2 }];
  const resolved = resolveFor(mappings, GW_A);
  assert.equal(resolved.get(LID).phone, PHONE_A2, 'sibling line of the SAME user must resolve');
});

check('B: both of the user\'s lines are in scope', () => {
  const scope = lidScopeSessionIds(GW_A, ownerOf(GW_A), SESSIONS);
  assert.deepEqual([...scope].sort(), [GW_A, GW_A2].sort());
});

check('B: the caller\'s OWN line wins over a sibling with the same lid', () => {
  const mappings = [
    { sessionId: GW_A, lid: LID, phone: PHONE_A },
    { sessionId: GW_A2, lid: LID, phone: PHONE_A2 },
  ];
  assert.equal(resolveFor(mappings, GW_A).get(LID).phone, PHONE_A);
  assert.equal(resolveFor(mappings, GW_A2).get(LID).phone, PHONE_A2);
});

// --- Test C: THE critical security regression test ---

check('C: a mapping that exists ONLY for tenant B is invisible to tenant A', () => {
  const mappings = [{ sessionId: GW_B, lid: LID_B_ONLY, phone: PHONE_B }];
  const a = resolveFor(mappings, GW_A);
  assert.equal(a.has(LID_B_ONLY), false, 'tenant A must NOT see tenant B\'s mapping');
  assert.equal(a.get(LID_B_ONLY)?.phone ?? null, null);
  // ...and B still resolves it, so this is isolation, not breakage.
  assert.equal(resolveFor(mappings, GW_B).get(LID_B_ONLY).phone, PHONE_B);
});

// --- fail-closed edges ---

check('orphan line gets its own session only, never a global scan', () => {
  const scope = lidScopeSessionIds(GW_ORPHAN, null, SESSIONS);
  assert.deepEqual([...scope], [GW_ORPHAN]);
  const mappings = [
    { sessionId: GW_A, lid: LID, phone: PHONE_A },
    { sessionId: GW_ORPHAN, lid: LID, phone: PHONE_B },
  ];
  assert.equal(resolveFor(mappings, GW_ORPHAN).get(LID).phone, PHONE_B);
});

check('unknown owner id fails closed to the caller\'s own line', () => {
  const scope = lidScopeSessionIds('gw-unknown', null, SESSIONS);
  assert.deepEqual([...scope], ['gw-unknown']);
});

check('no session id yields an empty scope (never "everything")', () => {
  assert.equal(lidScopeSessionIds('', USER_A, SESSIONS).size, 0);
  assert.equal(lidScopeSessionIds(null, USER_A, SESSIONS).size, 0);
});

check('a line owned by nobody is never a sibling of a real tenant', () => {
  const scope = lidScopeSessionIds(GW_A, USER_A, SESSIONS);
  assert.equal(scope.has(GW_ORPHAN), false);
});

// --- source guards: the unscoped forms must not come back ---

const here = path.dirname(fileURLToPath(import.meta.url));
const targetFile = fs.existsSync(path.join(here, '..', 'src', 'lid', 'lid-repository.js'))
  ? path.join(here, '..', 'src', 'lid', 'lid-repository.js')
  : path.join(here, '..', 'src', 'session-manager.js');
const SRC = fs.readFileSync(targetFile, 'utf8');

check('loadLidMappingsFromDb bounds its read by the tenant scope', () => {
  assert.match(
    SRC,
    /FROM whatsapp_private\.lid_mappings\s+WHERE session_id = ANY\(\$2::text\[\]\)/,
    'the LID read must be bounded by the scoped session allow-list'
  );
  assert.match(SRC, /ORDER BY lid_jid, \(session_id = \$1\) DESC, created_at DESC/,
    'own-session priority ordering must be preserved');
});

check('the disk sweep is gated by the tenant scope', () => {
  assert.match(SRC, /if \(sessionId && !scope\.has\(String\(item\)\)\) continue;/,
    'the disk sweep must skip directories outside the tenant scope');
});

check('the owner lookup goes through public.whatsapp_sessions.gateway_id', () => {
  assert.match(
    SRC,
    /SELECT gateway_id, user_id FROM public\.whatsapp_sessions/,
    'the tenant route is gateway_sessions.session_id -> whatsapp_sessions.gateway_id -> user_id'
  );
});

console.log(`[test-g3-lid-tenant-scope] ${passed} assertions passed`);
