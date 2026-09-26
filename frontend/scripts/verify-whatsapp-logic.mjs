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
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const SRC = path.join(frontendRoot, 'src');

// Build OUTSIDE the working tree: a crashed or killed run would otherwise leave
// `.tmp-verify-*` directories behind in the repo, ready to be committed.
const tmp = await mkdtemp(path.join(os.tmpdir(), 'tezlify-logic-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'bundle.mjs');

await writeFile(
  entry,
  [
    `export { mapConversationItem, buildConversationUpdatedPayload } from '${SRC}/features/whatsapp/api/whatsappApi';`,
    `export { compareConversationsByActivityDesc, getConversationActivityTimestamp, getConversationIdentityKey, dedupeConversationsByCanonicalIdentity, restoreConversationActivity } from '${SRC}/features/whatsapp/lib/whatsappOrdering';`,
    `export { getConversationDisplayName, extractCleanPhone, formatPhoneNumber, isRawWhatsAppJid, stripJidPrefix } from '${SRC}/features/whatsapp/lib/whatsappIdentity';`,
    `export { PEER_TYPING_TTL_MS, pruneExpiredTyping, resolveSyncDisplayCounts } from '${SRC}/features/whatsapp/lib/whatsappSync';`,
    `export { buildChatPreview, normalizePreviewText, shouldApplyPreview } from '${SRC}/features/whatsapp/lib/whatsappPreview';`,
    `export { resolveUnreadCount } from '${SRC}/features/whatsapp/lib/whatsappUnread';`,
    `export { mergeWhatsAppMessages, mergeDeliveryStatus } from '${SRC}/features/whatsapp/lib/whatsappMessageMerge';`,
    `export { applyConversationEvent } from '${SRC}/features/whatsapp/lib/whatsappConversationPatch';`,
    `export { en } from '${SRC}/locales/en';`,
    `export { tr } from '${SRC}/locales/tr';`,
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
    // Resolve node_modules against the repo: the entry itself lives in the
    // OS temp dir so a crashed run cannot litter the working tree.
    absWorkingDir: frontendRoot,
    // The entry lives in the OS temp dir, so node_modules is not reachable by
    // walking up from it. Search the workspace roots explicitly.
    nodePaths: [
      path.join(frontendRoot, 'node_modules'),
      path.resolve(frontendRoot, '..', 'node_modules'),
    ],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'error',
    define: {
      'import.meta.env': '{}',
      'process.env.NODE_ENV': '"test"',
    },
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
    normalizePreviewText,
    shouldApplyPreview,
    resolveUnreadCount,
    mergeWhatsAppMessages,
    mergeDeliveryStatus,
    applyConversationEvent,
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
  // 8b. Every t('...') call site must resolve in BOTH dictionaries.
  //
  // The parity check above only compares en against tr, so a key missing from
  // BOTH passes it silently — while `useI18n` warns and returns the raw key
  // path, so the UI renders `whatsapp.warmUpDayLabel` as literal text. A
  // hand-written allowlist (as used for syncStage) only covers the keys someone
  // remembered. Deriving the required set from the call sites is the only way
  // to catch the whole class: 19 keys were missing this way.
  // -------------------------------------------------------------------------
  await checkAsync('every static t(...) call site resolves in both dictionaries', async () => {
    const walk = async (dir) => {
      const out = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(p)));
        else if (/\.tsx?$/.test(entry.name)) out.push(p);
      }
      return out;
    };

    const enKeys = new Set(flattenKeys(en));
    const trKeys = new Set(flattenKeys(tr));
    const files = await walk(SRC);

    const missing = [];
    let callSites = 0;
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      const rel = path.relative(frontendRoot, file);
      // Matches `t('a.b')` and `t("a.b", { params })`. Template-literal sites
      // start with a backtick and are deliberately not matched here.
      for (const m of src.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) {
        const key = m[2];
        callSites += 1;
        const inEn = enKeys.has(key);
        const inTr = trKeys.has(key);
        if (!inEn || !inTr) {
          missing.push(`${key} @ ${rel}${inEn ? '' : ' [missing in en]'}${inTr ? '' : ' [missing in tr]'}`);
        }
      }
    }

    assert.ok(callSites > 500, `expected many t() call sites, saw ${callSites}`);
    assert.deepEqual(missing, [], `t() keys with no dictionary entry:\n    ${missing.join('\n    ')}`);
    console.log(`     (${callSites} call sites across ${files.length} files)`);
  });

  await checkAsync('every reachable dynamic t(`...`) key family exists', async () => {
    const src = await readFile(
      path.join(SRC, 'features/whatsapp/components/WhatsAppQrConnectModal.tsx'),
      'utf8'
    );
    // Pin the assumption: if the step range changes, this check must change too.
    assert.ok(
      /\[1,\s*2,\s*3,\s*4\]\.map\(\(n\)/.test(src),
      'pairing-code step range changed; update this check to match'
    );
    const m = src.match(/t\(`([A-Za-z.]+)\$\{n\}`\)/);
    assert.ok(m, 'expected the pairingCodeStep template-literal site to still exist');
    for (const n of [1, 2, 3, 4]) {
      assert.equal(typeof en.whatsapp?.[`pairingCodeStep${n}`], 'string', `en ${m[1]}${n} is missing`);
      assert.equal(typeof tr.whatsapp?.[`pairingCodeStep${n}`], 'string', `tr ${m[1]}${n} is missing`);
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
    // P6-8: there are now TWO call sites — the numeric-session route and the
    // pair_token route for a new pairing. Both must forward `rawPhone`
    // untouched; neither may normalize.
    assert.ok(
      /requestPairingCode\(\s*Number\(sid\)\s*,\s*rawPhone\s*\)/.test(src),
      'the numeric-session route must forward the raw phone to the gateway'
    );
    assert.ok(
      /requestPairingCodeForToken\([^,]+,\s*rawPhone\s*\)/.test(src),
      'the pair_token route must forward the raw phone to the gateway'
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

  check('§32: the unread badge can go DOWN — a read on another device clears it', () => {
    // The gateway owns unread_count and reports decreases; the backend persists
    // the policy-applied value and emits it, so the UI must accept it verbatim.
    assert.equal(resolveUnreadCount(5, 0), 0, 'explicit 0 must clear the badge');
    assert.equal(resolveUnreadCount(5, 2), 2, 'a decrease must be honoured');
    assert.equal(resolveUnreadCount(1, 4), 4, 'an increase must be honoured');
    assert.equal(resolveUnreadCount(0, 0), 0, 'already-read stays read');
  });

  check('§32: a partial event with no unread_count never erases known state', () => {
    assert.equal(resolveUnreadCount(3, undefined), 3);
    assert.equal(resolveUnreadCount(3, null), 3);
    assert.equal(resolveUnreadCount(0, undefined), 0);
  });

  await checkAsync('§32: the WS merge no longer clamps the badge with Math.max', async () => {
    const [hubSrc, patchSrc] = await Promise.all([
      readFile(path.join(frontendRoot, 'src/pages/WhatsAppHubPage.tsx'), 'utf8'),
      readFile(
        path.join(frontendRoot, 'src/features/whatsapp/lib/whatsappConversationPatch.ts'),
        'utf8'
      ),
    ]);
    assert.ok(
      !/Math\.max\([^)]*unread_count/.test(hubSrc),
      'the WS conversation_updated merge must not clamp unread_count with Math.max'
    );
    assert.ok(
      !/Math\.max\([^)]*unread_count/.test(patchSrc),
      'the shared merge helper must not clamp unread_count with Math.max'
    );
    // The hub page must delegate to the single shared merge path (P6.2), and
    // that path must route the badge through the shared policy helper.
    assert.ok(
      /applyConversationEvent\(c,\s*payload/.test(hubSrc),
      'the merge must delegate to the shared applyConversationEvent helper'
    );
    assert.ok(
      /resolveUnreadCount\(current\.unread_count,\s*payload\.unread_count\)/.test(patchSrc),
      'the shared merge must route the badge through resolveUnreadCount'
    );
  });

  // -----------------------------------------------------------------------
  // Phase 6.1 — cross-layer: apply REAL backend WebSocket payloads to the
  // shipped frontend mappers.
  //
  // `phase6-ws-payloads.json` is produced by running the real ingest path
  // (scratch/p6_dump_ws_payloads.py); main.py:319 broadcasts exactly those
  // dicts. So these checks compare DB-produced state against React state.
  // -----------------------------------------------------------------------
  const fx = JSON.parse(
    await readFile(path.join(frontendRoot, 'scripts/fixtures/phase6-ws-payloads.json'), 'utf8')
  );

  /** Mirrors WhatsAppHubPage's conversation_updated merge with the shipped helpers. */
  const mergeConversation = (current, wsPayload) => {
    const payload = wsPayload.conversation || wsPayload;
    const mapped = mapConversationItem(buildConversationUpdatedPayload(current.id, payload));
    const next = { ...current, ...mapped };
    next.unread_count = resolveUnreadCount(current.unread_count, payload.unread_count);
    const gwPreview = payload.last_message_preview
      ? normalizePreviewText(payload.message_type, String(payload.last_message_preview), fakeT)
      : '';
    const applyGw = Boolean(gwPreview) && shouldApplyPreview(payload.last_message_at, current.last_message_at);
    next.last_message_preview = applyGw ? gwPreview : current.last_message_preview;
    next.last_message_at = applyGw ? payload.last_message_at || current.last_message_at : current.last_message_at;
    return next;
  };

  const baseUi = {
    id: fx.conversation_id,
    unread_count: fx.baseline.unread_count,
    lead_name: fx.baseline.name,
    avatar_url: 'https://cdn.example/a.png',
    last_message_preview: 'son mesaj',
    last_message_at: '2026-09-18T10:02:00.000Z',
    is_group: false,
  };

  check('§P6/I: an external read produced by the backend really clears the UI badge 5 -> 0', () => {
    assert.equal(fx.ws_external_read.conversation.unread_count, 0, 'backend must emit 0');
    const next = mergeConversation(baseUi, fx.ws_external_read);
    assert.equal(next.unread_count, 0, `UI badge must reach 0, got ${next.unread_count}`);
  });

  check('§P6/§20: a partial event preserves name / avatar / preview / timestamp / is_group', () => {
    const next = mergeConversation(baseUi, fx.ws_partial_unread_zero);
    assert.equal(next.unread_count, 0, 'unread must still be applied');
    assert.equal(next.lead_name, baseUi.lead_name, 'name must be preserved');
    assert.equal(next.avatar_url, baseUi.avatar_url, 'avatar must be preserved');
    assert.equal(next.last_message_preview, baseUi.last_message_preview, 'preview must be preserved');
    assert.equal(next.last_message_at, baseUi.last_message_at, 'last_message_at must be preserved');
    assert.equal(next.is_group, baseUi.is_group, 'is_group must be preserved');
  });

  check('§P6/§21: DB(WS payload) and frontend agree on unread / preview / last_message_at', () => {
    const ws = fx.ws_external_read.conversation;
    const next = mergeConversation(baseUi, fx.ws_external_read);
    // unread_count: exact equality across all three layers
    assert.equal(next.unread_count, ws.unread_count, 'frontend unread != WS unread');
    assert.equal(ws.unread_count, fx.ws_external_read.conversation.unread_count);
    // last_message_at: the payload is the DB value; the UI keeps it when the
    // gateway preview is absent (no newer activity evidence).
    assert.equal(
      next.last_message_at,
      baseUi.last_message_at,
      'frontend last_message_at diverged from the persisted value'
    );
    assert.equal(next.last_message_preview, baseUi.last_message_preview, 'preview diverged');
  });

  // ---- Pagination / merge layer: the React state half of Scenarios D, F, N ----
  // These run the shipped `mergeWhatsAppMessages`, i.e. exactly the function
  // `WhatsAppHubPage` calls on refresh, reconnect and sync-chunk merges.
  const T0 = Date.UTC(2026, 8, 18, 0, 0, 0);
  const ts = (n) => new Date(T0 + n * 1000).toISOString();
  const mkMsg = (n, extra = {}) => ({
    id: n,
    conversation_id: 1,
    body: `m${n}`,
    direction: 'INBOUND',
    status: 'RECEIVED',
    created_at: ts(n),
    external_timestamp: ts(n),
    wa_message_id: `W${n}`,
    ...extra,
  });
  const page2 = Array.from({ length: 50 }, (_, i) => mkMsg(i + 1)); // older  (1..50)
  const page1 = Array.from({ length: 50 }, (_, i) => mkMsg(i + 51)); // newer (51..100)

  check('§P6/N: page 1 + page 2 are both retained and chronologically ordered', () => {
    const loaded = mergeWhatsAppMessages(page1, page2);
    assert.equal(loaded.length, 100, `expected 100, got ${loaded.length}`);
    assert.equal(loaded[0].id, 1, 'oldest message must be first');
    assert.equal(loaded[99].id, 100, 'newest message must be last');
  });

  check('§P6/N: a refresh during pagination keeps the older pages and appends new activity', () => {
    const loaded = mergeWhatsAppMessages(page1, page2);
    const live = mkMsg(101);
    // Reconnect/sync path: `mergeWhatsAppMessages(prev, [...res.messages, ...buf])`
    const afterRefresh = mergeWhatsAppMessages(loaded, [...page1, live]);
    assert.equal(afterRefresh.length, 101, `expected 101, got ${afterRefresh.length}`);
    assert.ok(afterRefresh.some((m) => m.id === 1), 'page 2 must not disappear');
    assert.ok(afterRefresh.some((m) => m.id === 50), 'page 2 must not disappear');
    assert.equal(afterRefresh[100].id, 101, 'new activity must be last');
    assert.equal(new Set(afterRefresh.map((m) => m.wa_message_id)).size, 101, 'duplicate wa_message_id');
  });

  check('§P6/N: replaying the same refresh or the same sync chunk does not duplicate', () => {
    const loaded = mergeWhatsAppMessages(page1, page2);
    const once = mergeWhatsAppMessages(loaded, [...page1, mkMsg(101)]);
    const twice = mergeWhatsAppMessages(once, [...page1, mkMsg(101)]);
    assert.equal(twice.length, 101, `replay changed the count: ${twice.length}`);
  });

  check('§P6/D: history and realtime carrying the same wa_message_id are one bubble', () => {
    const historyRow = mkMsg(10, { wa_message_id: 'WSAME', status: 'RECEIVED' });
    const realtimeRow = mkMsg(77, { wa_message_id: 'WSAME', status: 'READ' });
    const merged = mergeWhatsAppMessages([historyRow], [realtimeRow]);
    assert.equal(merged.length, 1, `expected 1 bubble, got ${merged.length}`);
    assert.equal(merged[0].status, 'READ', 'the higher delivery rank must win');
  });

  check('§P6/F: delivery status is monotonic — retry advances, a late FAILED never downgrades', () => {
    assert.equal(mergeDeliveryStatus('FAILED', 'PENDING'), 'FAILED', 'FAILED must not become PENDING');
    assert.equal(mergeDeliveryStatus('FAILED', 'SENT'), 'SENT', 'a retry must advance');
    assert.equal(mergeDeliveryStatus('SENT', 'FAILED'), 'SENT', 'a late FAILED must not downgrade');
    assert.equal(mergeDeliveryStatus('DELIVERED', 'PENDING'), 'DELIVERED', 'stale PENDING must not rewind');
    assert.equal(mergeDeliveryStatus('READ', 'DELIVERED'), 'READ', 'an older ACK must not rewind READ');
  });

  // The hub page's inline merge was extracted into `applyConversationEvent`
  // (Phase 6.2) so the DOM tests can drive the real path. Prove the extraction
  // is behaviour-identical: run both on the same REAL backend payloads.
  check('§P6.2: the extracted merge agrees with the pre-extraction implementation', () => {
    for (const key of ['ws_external_read', 'ws_partial_unread_zero', 'ws_stale_snapshot_older', 'ws_stale_snapshot_same_ts']) {
      const payload = fx[key].conversation;
      const extracted = applyConversationEvent({ ...baseUi }, payload, fakeT);
      const reference = mergeConversation({ ...baseUi }, fx[key]);
      assert.equal(extracted.unread_count, reference.unread_count, `${key}: unread diverged`);
      assert.equal(extracted.last_message_preview, reference.last_message_preview, `${key}: preview diverged`);
      assert.equal(extracted.last_message_at, reference.last_message_at, `${key}: last_message_at diverged`);
    }
  });

  await checkAsync('§P6.4/§P6.5: the hub page resets the thread by conversation id and keys the composer', async () => {
    const src = await readFile(path.join(frontendRoot, 'src/pages/WhatsAppHubPage.tsx'), 'utf8');
    // ChatThread: the pane must keep ONE instance for its whole lifetime. A
    // keyed ChatThread means every switch destroys a huge subtree, and a
    // destruction that does not complete leaves the stale root on screen — that
    // is the stacked-chat defect (one chat per clicked person). The instance is
    // now told WHICH conversation it renders so it resets its own viewport and
    // pagination state instead.
    assert.ok(
      /<ChatThread\s+conversationKey=\{selectedConv\.id\}/.test(src),
      'ChatThread must receive conversationKey so a switch resets it in place'
    );
    assert.ok(
      !/<ChatThread\s+key=\{/.test(src),
      'ChatThread must never be keyed by conversation id: a switch must not destroy it'
    );
    // ChatComposer: it owns the draft in internal state and gets no
    // conversation identifier, so unkeyed it leaks the draft into the next chat
    // — and `onSend` delivers to the SELECTED conversation (wrong recipient).
    assert.ok(
      /<ChatComposer\s+key=\{selectedConv\.id\}/.test(src),
      'ChatComposer must be keyed by conversation id so a draft cannot leak to another chat'
    );
  });

  check('§P6.2: the extracted merge keeps the known name when the payload carries none', () => {
    const patched = applyConversationEvent({ ...baseUi }, { id: baseUi.id, unread_count: 0 }, fakeT);
    assert.equal(patched.lead_name, baseUi.lead_name, 'an unresolved identity must keep the known name');
    assert.equal(patched.unread_count, 0, 'the badge must still be applied');
  });

  console.log(`\nWhatsApp frontend identity + ordering verification: PASS (${passed} checks)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
