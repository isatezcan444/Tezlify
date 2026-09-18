/**
 * Executed verification of the WhatsApp frontend identity + ordering logic.
 *
 * The frontend has no test runner (no vitest/jest). This script bundles the
 * *real* source modules with esbuild and runs assertions in Node, so the checks
 * execute the shipped code instead of a copy of it.
 *
 * Run: `node scripts/verify-whatsapp-logic.mjs` — exit code 0 = PASS.
 *
 * Pins the audit fixes:
 *  - mapConversationItem must not write `undefined` for fields a partial
 *    realtime payload does not carry (that is how a LID reconciliation used to
 *    erase a conversation's name and phone).
 *  - mapConversationItem must read the canonical `phone` / `identity_state`.
 *  - ordering must depend ONLY on activity (`last_message_at`), never on
 *    identity state / name / phone.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');

const tmp = await mkdtemp(path.join(frontendRoot, '.tmp-verify-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  [
    `export { mapConversationItem } from '../src/features/whatsapp/api/whatsappApi';`,
    `export { compareConversationsByActivityDesc, getConversationActivityTimestamp } from '../src/features/whatsapp/lib/whatsappOrdering';`,
  ].join('\n'),
  'utf8'
);

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

try {
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'error',
    define: {
      'import.meta.env': '{}',
      'process.env.NODE_ENV': '"test"',
    },
    external: ['react', 'react-dom'],
  });

  const { mapConversationItem, compareConversationsByActivityDesc, getConversationActivityTimestamp } =
    await import(out);

  // -------------------------------------------------------------------------
  // 1. Partial payload must NOT wipe known state on merge
  // -------------------------------------------------------------------------
  check('partial conversations_updated payload does not wipe name/phone', () => {
    const existing = mapConversationItem({
      id: 5,
      name: 'Ahmet Yılmaz',
      phone: '+905321112233',
      identity_state: 'RESOLVED_PROFILE',
      status: 'ACTIVE',
      unread_count: 2,
      is_group: false,
      message_count: 40,
      last_message_preview: 'selam',
      last_message_at: '2026-09-18T10:00:00Z',
    });

    // What the backend used to emit for a LID reconciliation: id + preview only
    // (and `lead_phone`, which the mapper does not read).
    const partial = mapConversationItem({
      id: 5,
      last_message_preview: 'görüşürüz',
    });

    const merged = { ...existing, ...partial };

    assert.equal(merged.lead_name, 'Ahmet Yılmaz', 'name must survive a partial payload');
    assert.equal(merged.lead_phone, '+905321112233', 'phone must survive a partial payload');
    assert.equal(merged.identity_state, 'RESOLVED_PROFILE');
    assert.equal(merged.status, 'ACTIVE');
    assert.equal(merged.unread_count, 2);
    assert.equal(merged.message_count, 40);
    assert.equal(merged.last_message_preview, 'görüşürüz', 'carried field must update');
  });

  check('canonical payload updates identity (phone / name / identity_state)', () => {
    const mapped = mapConversationItem({
      id: 7,
      name: null,
      phone: '+905551112233',
      identity_state: 'RESOLVED_PHONE',
      status: 'ARCHIVED',
      unread_count: 0,
      is_group: false,
    });
    assert.equal(mapped.lead_phone, '+905551112233');
    assert.equal(mapped.identity_state, 'RESOLVED_PHONE');
    assert.equal(mapped.status, 'ARCHIVED');
    // An explicit null from the backend IS authoritative.
    assert.equal(mapped.lead_name, undefined);
  });

  check('full REST payload maps every field as before', () => {
    const mapped = mapConversationItem({
      id: 9,
      session_id: 3,
      contact_id: 11,
      lead_id: null,
      name: 'Grup Aile',
      phone: '120363012345678901@g.us',
      identity_state: 'RESOLVED_PROFILE',
      is_group: true,
      is_archived: true,
      avatar_url: 'https://example.invalid/a.png',
      last_message_preview: '📷 Fotoğraf',
      last_message_at: '2026-09-18T10:00:00Z',
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-18T10:00:00Z',
      message_count: 12,
      last_message_state: 'RESOLVED',
      unread_count: 4,
      status: 'ACTIVE',
    });
    assert.equal(mapped.id, 9);
    assert.equal(mapped.session_id, 3);
    assert.equal(mapped.contact_id, 11);
    assert.equal(mapped.lead_id, null);
    assert.equal(mapped.lead_name, 'Grup Aile');
    assert.equal(mapped.lead_phone, '120363012345678901@g.us');
    assert.equal(mapped.is_group, true);
    assert.equal(mapped.is_archived, true);
    assert.equal(mapped.lead_avatar_url, 'https://example.invalid/a.png');
    assert.equal(mapped.message_count, 12);
    assert.equal(mapped.last_message_state, 'RESOLVED');
    assert.equal(mapped.unread_count, 4);
    assert.equal(mapped.status, 'ACTIVE');
    assert.equal(mapped.channel, 'WHATSAPP');
  });

  // -------------------------------------------------------------------------
  // 2. Ordering is activity-only (identity != ordering)
  // -------------------------------------------------------------------------
  check('ordering ignores identity state, name and phone', () => {
    const named = {
      id: 1,
      lead_name: 'Ahmet Yılmaz',
      lead_phone: '+905321112233',
      identity_state: 'RESOLVED_PROFILE',
      last_message_at: '2026-09-18T10:00:00Z',
    };
    const stranger = {
      id: 2,
      lead_name: undefined,
      lead_phone: '+905559998877',
      identity_state: 'RESOLVED_PHONE',
      last_message_at: '2026-09-18T10:05:00Z',
    };
    const unresolved = {
      id: 3,
      identity_state: 'UNRESOLVED_PERMANENT',
      last_message_at: '2026-09-18T10:10:00Z',
    };

    const sorted = [named, stranger, unresolved].sort(compareConversationsByActivityDesc);
    assert.deepEqual(
      sorted.map((c) => c.id),
      [3, 2, 1],
      'the most recent activity must be first, regardless of identity state'
    );
  });

  check('a resolved identity does not change the sort position', () => {
    const before = [
      { id: 1, last_message_at: '2026-09-18T10:00:00Z' },
      { id: 2, last_message_at: '2026-09-18T09:00:00Z' },
    ];
    const afterIdentityUpdate = before.map((c) =>
      c.id === 2
        ? { ...c, lead_name: 'Mehmet Kirkar', identity_state: 'RESOLVED_PROFILE' }
        : c
    );
    assert.deepEqual(
      [...afterIdentityUpdate].sort(compareConversationsByActivityDesc).map((c) => c.id),
      [1, 2],
      'a late name resolution must not move a conversation'
    );
  });

  check('conversations without messages never outrank conversations with messages', () => {
    const withMsg = { id: 1, last_message_at: '2020-01-01T00:00:00Z' };
    const noMsg = { id: 99, lead_name: 'Yeni Kişi' };
    assert.equal(getConversationActivityTimestamp(noMsg), 0);
    const sorted = [noMsg, withMsg].sort(compareConversationsByActivityDesc);
    assert.deepEqual(sorted.map((c) => c.id), [1, 99]);
  });

  check('comparator is a total order (no flicker on equal timestamps)', () => {
    const ts = '2026-09-18T10:00:00Z';
    const list = [
      { id: 3, last_message_at: ts, created_at: ts },
      { id: 1, last_message_at: ts, created_at: ts },
      { id: 2, last_message_at: ts, created_at: ts },
    ];
    const a = [...list].sort(compareConversationsByActivityDesc).map((c) => c.id);
    const b = [...list].reverse().sort(compareConversationsByActivityDesc).map((c) => c.id);
    assert.deepEqual(a, [3, 2, 1], 'ties must fall back to descending id');
    assert.deepEqual(a, b, 'the order must be independent of the input order');
  });

  console.log(`\nWhatsApp frontend identity + ordering verification: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
