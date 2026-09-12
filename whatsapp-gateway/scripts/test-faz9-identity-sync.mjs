// Faz 9 (§28): gateway birim testleri — dejenere JID koruması, sync
// tamamlanma lifecycle'ı ve grup subject çözümleyici yardımcıları.
// `node scripts/test-faz9-identity-sync.mjs` ile çalışır, exit code 0 = PASS.
import assert from 'node:assert/strict';
import {
  jidToPhone,
  isDegenerateJid,
  resolveSyncState,
} from '../src/session-manager.js';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// --- §4/§5: '+0' ÜRETİLEMEZ — dejenere JID'lerden telefon türememeli ---

check('jidToPhone rejects degenerate 0@s.whatsapp.net (no +0)', () => {
  assert.equal(jidToPhone('0@s.whatsapp.net'), null);
  assert.equal(jidToPhone('00@s.whatsapp.net'), null);
  assert.equal(jidToPhone('000@s.whatsapp.net'), null);
  assert.equal(jidToPhone('0@c.us'), null);
});

check('jidToPhone keeps valid numbers (regression: name/phone çalışması bozulmadı)', () => {
  assert.equal(jidToPhone('905321002030@s.whatsapp.net'), '+905321002030');
  assert.equal(jidToPhone('15556599459@s.whatsapp.net'), '+15556599459');
  assert.equal(jidToPhone('12345@s.whatsapp.net'), '+12345');
  assert.equal(jidToPhone('120363012345678901@g.us'), null);
  assert.equal(jidToPhone('62771114836011@lid'), null);
});

check('isDegenerateJid flags only degenerate numeric JIDs', () => {
  assert.equal(isDegenerateJid('0@s.whatsapp.net'), true);
  assert.equal(isDegenerateJid('000@s.whatsapp.net'), true);
  assert.equal(isDegenerateJid('905321002030@s.whatsapp.net'), false);
  assert.equal(isDegenerateJid('120363012345678901@g.us'), false);
  assert.equal(isDegenerateJid('62771114836011@lid'), false);
  assert.equal(isDegenerateJid(null), false);
});

// --- §16/§19/§22: sync tamamlanma — GERÇEK sinyal (isLatest VEYA progress 100) ---

check('resolveSyncState: progress=100 completes sync even without isLatest (prod RC-3)', () => {
  const prev = { phase: 'syncing', progress: 62, chats_synced: 90, contacts_synced: 150, messages_synced: 900 };
  const { next, justCompleted } = resolveSyncState(prev, { progress: 100, isLatest: false });
  assert.equal(next.phase, 'ready');
  assert.equal(next.progress, 100);
  assert.ok(next.completed_at, 'completed_at must be set on real completion');
  assert.equal(justCompleted, true);
});

check('resolveSyncState: isLatest=true completes sync', () => {
  const prev = { phase: 'syncing', progress: 40 };
  const { next, justCompleted } = resolveSyncState(prev, { progress: 40, isLatest: true });
  assert.equal(next.phase, 'ready');
  assert.equal(next.progress, 100);
  assert.equal(justCompleted, true);
});

check('resolveSyncState: mid progress stays syncing, monotonic', () => {
  const prev = { phase: 'syncing', progress: 70 };
  const { next, justCompleted } = resolveSyncState(prev, { progress: 55, isLatest: false });
  assert.equal(next.phase, 'syncing');
  assert.equal(next.progress, 70, 'progress must never regress');
  assert.equal(next.completed_at ?? null, null);
  assert.equal(justCompleted, false);
});

check('resolveSyncState: already-ready does not re-complete (no duplicate event)', () => {
  const prev = { phase: 'ready', progress: 100, completed_at: '2026-01-01T00:00:00.000Z' };
  const { next, justCompleted } = resolveSyncState(prev, { progress: 100, isLatest: true });
  assert.equal(next.phase, 'ready');
  assert.equal(next.completed_at, '2026-01-01T00:00:00.000Z', 'first completion timestamp preserved');
  assert.equal(justCompleted, false);
});

check('resolveSyncState: missing progress keeps previous value (no fake numbers)', () => {
  const prev = { phase: 'syncing', progress: 33 };
  const { next } = resolveSyncState(prev, { progress: undefined, isLatest: false });
  assert.equal(next.phase, 'syncing');
  assert.equal(next.progress, 33);
});

console.log(`[test-faz9-identity-sync] ${passed} assertions passed`);
