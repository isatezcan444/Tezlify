/**
 * Executed verification of the WhatsApp frontend identity + ordering logic.
 *
 * The frontend has no test runner (no vitest/jest). This script bundles the
 * *real* source modules with esbuild and runs assertions in Node, so the checks
 * execute the shipped code instead of a copy of it.
 *
 * Run: `node scripts/verify-whatsapp-logic.mjs` — exit code 0 = PASS.
 *
 * Pins the Phase-2 audit fixes:
 *  - mapConversationItem / buildConversationUpdatedPayload must not write
 *    `undefined` for fields a partial realtime payload does not carry, while an
 *    explicit `null` stays authoritative (I-4, contract hardening).
 *  - ordering must depend ONLY on activity (`last_message_at`).
 *  - conversation dedup must be keyed by `conversation.id` (I-7).
 *  - a failed optimistic send rolls the activity back (F-6).
 *  - the canonical display helper never returns a raw technical JID (I-5/F-13).
 *  - typing TTL pruning applies to every conversation (F-11).
 *  - sync counts prefer the gateway's unique/cached fields (G-6 handoff).
 *  - `en` and `tr` dictionaries have exactly the same key set, and every
 *    reachable dynamic `whatsapp.syncStage.*` key exists (F-9).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
    `export { mapConversationItem, buildConversationUpdatedPayload } from '../src/features/whatsapp/api/whatsappApi';`,
    `export { compareConversationsByActivityDesc, getConversationActivityTimestamp, getConversationIdentityKey, dedupeConversationsByCanonicalIdentity, restoreConversationActivity } from '../src/features/whatsapp/lib/whatsappOrdering';`,
    `export { getConversationDisplayName, extractCleanPhone, formatPhoneNumber, isRawWhatsAppJid, stripJidPrefix } from '../src/features/whatsapp/lib/whatsappIdentity';`,
    `export { PEER_TYPING_TTL_MS, pruneExpiredTyping, resolveSyncDisplayCounts } from '../src/features/whatsapp/lib/whatsappSync';`,
    `export { buildChatPreview } from '../src/features/whatsapp/lib/whatsappPreview';`,
    `export { en } from '../src/locales/en';`,
    `export { tr } from '../src/locales/tr';`,
  ].join('\n'),
  'utf8'
);

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

/** Same contract as `check`, for assertions that need to read a source file. */
const checkAsync = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const fakeT = (key) =>
  ({
    'whatsapp.groupFallback': 'Group',
    'whatsapp.pendingIdentity': 'Resolving identity…',
    'whatsapp.contactFallback': 'Contact',
  })[key] ?? key;

const flattenKeys = (obj, prefix = '') => {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenKeys(v, next));
    else out.push(next);
  }
  return out;
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

  const {
    mapConversationItem,
    buildConversationUpdatedPayload,
    compareConversationsByActivityDesc,
    getConversationActivityTimestamp,
    getConversationIdentityKey,
    dedupeConversationsByCanonicalIdentity,
    restoreConversationActivity,
    getConversationDisplayName,
    extractCleanPhone,
    formatPhoneNumber,
    isRawWhatsAppJid,
    stripJidPrefix,
    buildChatPreview,
    PEER_TYPING_TTL_MS,
    pruneExpiredTyping,
    resolveSyncDisplayCounts,
    en,
    tr,
  } = await import(out);

  // -------------------------------------------------------------------------
  // 1. Partial payload must NOT wipe known state on merge (I-4 / contract)
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

  check('a missing phone field is absent from the mapped object (no undefined overwrite)', () => {
    const partial = mapConversationItem({ id: 5, last_message_preview: 'x' });
    assert.equal('lead_phone' in partial, false, 'missing phone must not create an own property');
    assert.equal('lead_name' in partial, false, 'missing name must not create an own property');
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

  check('explicit null phone is authoritative and overwrites a known value', () => {
    const existing = mapConversationItem({ id: 5, phone: '+905321234567' });
    assert.equal(existing.lead_phone, '+905321234567');
    const nulled = mapConversationItem({ id: 5, phone: null });
    assert.equal('lead_phone' in nulled, true, 'null must create the property (authoritative)');
    assert.equal(nulled.lead_phone, undefined);
    const merged = { ...existing, ...nulled };
    assert.equal(merged.lead_phone, undefined, 'an explicit null from the server is authoritative');
  });

  check('WS conversation_updated payload is normalized through the shared mapper', () => {
    const existing = mapConversationItem({
      id: 42,
      name: 'Ahmet Yılmaz',
      phone: '+905321234567',
      identity_state: 'RESOLVED_PROFILE',
      last_message_preview: 'selam',
    });

    // Partial event: no phone/identity_state -> known state must survive.
    const partialCanonical = buildConversationUpdatedPayload(42, {
      id: '905321234567@s.whatsapp.net',
      name: 'Ahmet Yılmaz',
      last_message_preview: 'yeni',
    });
    assert.equal(partialCanonical.id, 42, 'the JID id must never leak; the numeric id wins');
    assert.equal('phone' in partialCanonical, false, 'absent phone must not become undefined');
    const partialMerged = { ...existing, ...mapConversationItem(partialCanonical) };
    assert.equal(partialMerged.lead_phone, '+905321234567', 'phone must survive a partial WS event');
    assert.equal(partialMerged.identity_state, 'RESOLVED_PROFILE');

    // A canonical event that DOES carry identity updates it.
    const canonical = buildConversationUpdatedPayload(42, {
      phone: '+905559998877',
      identity_state: 'RESOLVED_PHONE',
      is_group: false,
    });
    const updated = { ...existing, ...mapConversationItem(canonical) };
    assert.equal(updated.lead_phone, '+905559998877', 'a phone learned via WS must be applied');
    assert.equal(updated.identity_state, 'RESOLVED_PHONE');
    assert.equal(updated.lead_name, 'Ahmet Yılmaz', 'an omitted name must not be erased');

    // A raw JID must never be accepted as a name.
    const raw = buildConversationUpdatedPayload(42, { name: '123456@lid' });
    assert.equal('name' in raw, false, 'raw JID name must be dropped by the normalizer');
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

  // -------------------------------------------------------------------------
  // 3. I-7 — dedup by conversation.id (no last-10-digit merging)
  // -------------------------------------------------------------------------
  check('dedup is keyed by conversation.id, not a phone suffix', () => {
    assert.equal(getConversationIdentityKey({ id: 1, lead_phone: '+905321234567' }), 'id:1');
    assert.equal(getConversationIdentityKey({ id: 2, lead_phone: '+1555551234567' }), 'id:2');

    const rows = [
      { id: 1, lead_phone: '+905321234567', last_message_at: '2026-09-18T10:00:00Z' },
      { id: 2, lead_phone: '+1555551234567', last_message_at: '2026-09-18T09:00:00Z' },
    ];
    const deduped = dedupeConversationsByCanonicalIdentity(rows);
    assert.equal(deduped.length, 2, '+905321234567 and +1555551234567 must NOT be merged');
  });

  check('id-less fallback uses the FULL number, not the last 10 digits', () => {
    // These two numbers share their last 10 digits ("5321234567").
    const a = { lead_phone: '+905321234567' };
    const b = { lead_phone: '+1555321234567' };
    assert.notEqual(
      getConversationIdentityKey(a),
      getConversationIdentityKey(b),
      'two distinct people sharing a 10-digit suffix must not collide'
    );
    const deduped = dedupeConversationsByCanonicalIdentity([
      { ...a, last_message_at: '2026-09-18T10:00:00Z' },
      { ...b, last_message_at: '2026-09-18T09:00:00Z' },
    ]);
    assert.equal(deduped.length, 2);
  });

  // -------------------------------------------------------------------------
  // 4. F-6 — optimistic send rollback
  // -------------------------------------------------------------------------
  check('failed optimistic send restores the previous activity and ordering', () => {
    const optimisticTs = '2026-09-18T12:00:00Z';
    const rows = [
      { id: 1, last_message_preview: 'hello', last_message_at: optimisticTs },
      { id: 2, last_message_preview: 'earlier', last_message_at: '2026-09-18T11:00:00Z' },
    ];
    const restored = restoreConversationActivity(
      rows[0],
      { last_message_preview: 'hello', last_message_at: optimisticTs },
      { last_message_preview: 'previous real message', last_message_at: '2026-09-18T10:00:00Z' },
    );
    assert.equal(restored.last_message_preview, 'previous real message');
    assert.equal(restored.last_message_at, '2026-09-18T10:00:00Z');
    const sorted = [restored, rows[1]].sort(compareConversationsByActivityDesc);
    assert.deepEqual(sorted.map((c) => c.id), [2, 1], 'the failed send must not pin the row on top');
  });

  check('rollback never clobbers a newer real message', () => {
    const superseded = {
      id: 1,
      last_message_preview: 'a real reply',
      last_message_at: '2026-09-18T13:00:00Z',
    };
    const result = restoreConversationActivity(
      superseded,
      { last_message_preview: 'hello', last_message_at: '2026-09-18T12:00:00Z' },
      { last_message_preview: 'old', last_message_at: '2026-09-18T10:00:00Z' },
    );
    assert.equal(result, superseded, 'a newer real activity must be left untouched');
  });

  // -------------------------------------------------------------------------
  // 5. I-5 / F-13 — canonical display helper never leaks raw JIDs
  // -------------------------------------------------------------------------
  check('canonical display helper resolves identity and never returns a raw JID', () => {
    // Known contact -> name
    assert.equal(
      getConversationDisplayName(
        { id: 1, lead_name: 'Ahmet Yılmaz', lead_phone: '+905321234567' },
        fakeT
      ),
      'Ahmet Yılmaz'
    );
    // PN JID -> formatted phone
    const pn = getConversationDisplayName(
      { id: 2, lead_name: '905321234567@s.whatsapp.net', lead_phone: '905321234567@s.whatsapp.net' },
      fakeT
    );
    assert.equal(pn, '+90 532 123 45 67');
    assert.equal(isRawWhatsAppJid(pn), false);
    // Group -> group subject, else group fallback
    assert.equal(
      getConversationDisplayName({ id: 3, is_group: true, lead_name: 'Aile', lead_phone: '1203@g.us' }, fakeT),
      'Aile'
    );
    assert.equal(
      getConversationDisplayName({ id: 4, is_group: true, lead_name: '1203@g.us', lead_phone: '1203@g.us' }, fakeT),
      'Group'
    );
    // Unmapped LID -> deterministic fallback, never the raw JID
    const lid = getConversationDisplayName(
      { id: 5, lead_name: '123456789012345@lid', lead_phone: '123456789012345@lid' },
      fakeT
    );
    assert.equal(lid, 'Contact');
    assert.equal(isRawWhatsAppJid(lid), false);
    // Transient resolving -> spinner label (deterministic, not raw)
    assert.equal(
      getConversationDisplayName({ id: 6, identity_state: 'RESOLVING_TRANSIENT' }, fakeT),
      'Resolving identity…'
    );
  });

  check('extractCleanPhone / formatPhoneNumber reject raw identifiers', () => {
    assert.equal(extractCleanPhone('123456789012345@lid'), null);
    assert.equal(extractCleanPhone('120363012345678901@g.us'), null);
    assert.equal(extractCleanPhone('+905321234567'), '+905321234567');
    assert.equal(formatPhoneNumber('+905321234567'), '+90 532 123 45 67');
  });

  // -------------------------------------------------------------------------
  // 6. F-11 — typing TTL applies to all conversations
  // -------------------------------------------------------------------------
  check('typing TTL prunes every expired conversation', () => {
    assert.equal(PEER_TYPING_TTL_MS, 10000);
    const expiry = { 1: 1_000, 2: 5_000, 3: 9_999 };
    assert.deepEqual(pruneExpiredTyping(expiry, 1_500).sort((a, b) => a - b), [1]);
    assert.deepEqual(pruneExpiredTyping(expiry, 10_000).sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual(pruneExpiredTyping(expiry, 500), []);
  });

  // -------------------------------------------------------------------------
  // 7. G-6 handoff — prefer unique/cached entity counts
  // -------------------------------------------------------------------------
  check('sync display counts prefer unique/cached fields, fall back when absent', () => {
    const preferred = resolveSyncDisplayCounts({
      chats_synced: 196,
      contacts_synced: 200,
      messages_synced: 16973,
      chats_unique: 12,
      contacts_unique: 120,
      messages_cached: 480,
    });
    assert.deepEqual(preferred, { chats: 12, contacts: 120, messages: 480 });

    const fallback = resolveSyncDisplayCounts({
      chats_synced: 7,
      contacts_synced: 9,
      messages_synced: 11,
    });
    assert.deepEqual(fallback, { chats: 7, contacts: 9, messages: 11 });
    assert.deepEqual(resolveSyncDisplayCounts(null), { chats: 0, contacts: 0, messages: 0 });
  });

  // -------------------------------------------------------------------------
  // 8. F-9 — locale dictionaries are in full sync + dynamic stage keys exist
  // -------------------------------------------------------------------------
  check('en and tr dictionaries have exactly the same key set', () => {
    const enKeys = new Set(flattenKeys(en));
    const trKeys = new Set(flattenKeys(tr));
    const missingInTr = [...enKeys].filter((k) => !trKeys.has(k));
    const missingInEn = [...trKeys].filter((k) => !enKeys.has(k));
    assert.deepEqual(missingInTr, [], `keys missing in tr: ${missingInTr.join(', ')}`);
    assert.deepEqual(missingInEn, [], `keys missing in en: ${missingInEn.join(', ')}`);
    assert.equal(enKeys.size, trKeys.size);
    console.log(`     (en=${enKeys.size} keys, tr=${trKeys.size} keys)`);
  });

  check('every reachable whatsapp.syncStage.* key exists in both dictionaries', () => {
    // Reachable stage values: backend job stages, WS handlers and the
    // `whatsapp_sync_failed` event (`failed`), plus the IDLE job response.
    const reachable = ['idle', 'starting', 'chats', 'contacts', 'messages', 'finalizing', 'complete', 'failed'];
    for (const stage of reachable) {
      assert.equal(
        typeof en.whatsapp?.syncStage?.[stage],
        'string',
        `en.whatsapp.syncStage.${stage} is missing`
      );
      assert.equal(
        typeof tr.whatsapp?.syncStage?.[stage],
        'string',
        `tr.whatsapp.syncStage.${stage} is missing`
      );
    }
  });

  check('distinct filtered empty-state keys exist in both dictionaries', () => {
    for (const key of ['emptyUnread', 'emptyGroups', 'emptyArchived', 'emptyActive', 'emptyClosed', 'emptySearch']) {
      assert.equal(typeof en.whatsapp?.[key], 'string', `en.whatsapp.${key} is missing`);
      assert.equal(typeof tr.whatsapp?.[key], 'string', `tr.whatsapp.${key} is missing`);
    }
  });

  // -------------------------------------------------------------------------
  // 9. I-7 — message-to-conversation matching uses the CANONICAL phone
  // -------------------------------------------------------------------------
  check('canonical phone match separates numbers that share their last 10 digits', () => {
    // These two are DIFFERENT people but share their last 10 digits. The old
    // last-10-digit comparison would have treated them as the same identity and
    // could attribute an inbound message to the wrong conversation.
    const a = '+905551234567'; // +90 555 123 45 67
    const b = '+15551234567'; //  +1  555 123 4567
    assert.equal(a.replace(/\D/g, '').slice(-10), b.replace(/\D/g, '').slice(-10));

    const canonA = extractCleanPhone(a);
    const canonB = extractCleanPhone(b);
    assert.ok(canonA && canonB);
    assert.notEqual(canonA, canonB, 'canonical phones must differ');
    assert.equal(canonA, '+905551234567');
    assert.equal(canonB, '+15551234567');
  });

  check('canonical phone match is stable across equivalent spellings', () => {
    // Same person, different surface forms — must all canonicalize identically.
    const forms = ['+905321234567', '905321234567', '05321234567', '5321234567'];
    const canonical = forms.map((f) => extractCleanPhone(f));
    for (const c of canonical) assert.equal(c, '+905321234567', `got ${c}`);
  });

  // -------------------------------------------------------------------------
  // 10. §31 — identity consolidation: ONE canonical module, no repeated regex
  // -------------------------------------------------------------------------
  check('stripJidPrefix strips the jid: marker and is idempotent', () => {
    assert.equal(stripJidPrefix('jid:905321234567@s.whatsapp.net'), '905321234567@s.whatsapp.net');
    assert.equal(stripJidPrefix('  +905321234567  '), '+905321234567');
    assert.equal(stripJidPrefix('905321234567@s.whatsapp.net'), '905321234567@s.whatsapp.net');
    assert.equal(stripJidPrefix(null), '');
    assert.equal(stripJidPrefix(undefined), '');
  });

  check('§31: an unmapped LID is NOT keyed as a phone number', () => {
    // The old hand-rolled key stripped non-digits and prefixed `phone:`, so a LID
    // was indistinguishable from a real phone. `extractCleanPhone` returns null
    // for @lid by contract, so the key falls back to the JID form.
    const lidKey = getConversationIdentityKey({ lead_phone: '123456789012345@lid' });
    assert.ok(lidKey.startsWith('jid:'), `LID must key as jid:, got ${lidKey}`);
    assert.ok(!lidKey.startsWith('phone:'), 'a LID is not a phone number');

    const groupKey = getConversationIdentityKey({ lead_phone: '120363000000000000@g.us' });
    assert.ok(groupKey.startsWith('jid:'), `group must key as jid:, got ${groupKey}`);
  });

  check('§31: equivalent spellings of one number collapse to ONE identity key', () => {
    const keys = ['+905321234567', '905321234567', '05321234567', '5321234567'].map((p) =>
      getConversationIdentityKey({ lead_phone: p })
    );
    for (const k of keys) assert.equal(k, 'phone:+905321234567', `got ${k}`);
    assert.equal(new Set(keys).size, 1, 'all spellings must produce the same key');
  });

  check('§31: conversation.id still wins over any phone key', () => {
    const byId = getConversationIdentityKey({ id: 42, lead_phone: '+905321234567' });
    assert.equal(byId, 'id:42');
  });

  await checkAsync('§31: the pairing modal sends the RAW phone so the gateway can detect international', async () => {
    // G-8: the gateway's `normalizePairingPhone` only skips the TR assumption when
    // it sees a leading `+`/`00`. Pre-normalizing in the browser destroyed that
    // marker, so a foreign number was silently rewritten to +90. The modal must
    // forward the raw input and let the gateway own normalization.
    const src = await readFile(
      path.join(frontendRoot, 'src/features/whatsapp/components/WhatsAppQrConnectModal.tsx'),
      'utf8'
    );
    assert.ok(
      !/pairingPhone\.replace\(\/\\D\/g/.test(src),
      'the modal must not pre-normalize the pairing phone'
    );
    assert.ok(
      !/\^5\\d\{9\}\$/.test(src),
      'the modal must not re-implement the Turkish 5XXXXXXXXX assumption'
    );
    assert.ok(
      /requestPairingCode\(sid,\s*rawPhone\)/.test(src),
      'the modal must forward the raw phone to the gateway'
    );
  });

  check('§31: group preview prefix is unchanged after routing raw-identity detection through the canonical helper', () => {
    const base = { message_type: 'TEXT', body: 'merhaba', direction: 'INBOUND' };
    // A real contact name IS prefixed in a group.
    assert.equal(
      buildChatPreview({ ...base, sender_name: 'Ahmet Yılmaz' }, true),
      'Ahmet Yılmaz: merhaba'
    );
    // Every raw identifier form is suppressed — never leaks into the preview.
    for (const raw of [
      'jid:905321234567@s.whatsapp.net',
      '123456789012345@lid',
      '120363000000000000@g.us',
      '905321234567@s.whatsapp.net',
      '905321234567@c.us',
      '123@',
    ]) {
      assert.equal(
        buildChatPreview({ ...base, sender_name: raw }, true),
        'merhaba',
        `raw identifier must not become a prefix: ${raw}`
      );
    }
    // A phone-like name is also suppressed (WhatsApp Web parity).
    assert.equal(buildChatPreview({ ...base, sender_name: '+90 532 123 45 67' }, true), 'merhaba');
    // Non-group conversations never get a prefix.
    assert.equal(buildChatPreview({ ...base, sender_name: 'Ahmet Yılmaz' }, false), 'merhaba');
  });

  console.log(`\nWhatsApp frontend identity + ordering verification: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
