# TEZLIFY WHATSAPP — PHASE 5 REPORT
## Runtime Forensic Hardening / Remaining Behavioral Bug Hunt

**Date:** 2026-09-19 (session) · **Local HEAD:** `f4db4dd`
**Scope:** find and fix real behavioural bugs before deploy. No production deploy,
no production write, no message sent to a real third party, no controlled live E2E.

Evidence in this report is separated into four non-interchangeable classes:

| Class | Meaning |
|---|---|
| `LOCAL TEST` | Executed against the local SQLite dev DB / Node test harness |
| `PRODUCTION READ-ONLY` | Executed against production Postgres with `default_transaction_read_only=on` |
| `PRODUCTION DEPLOY` | Not performed this phase |
| `LIVE DEVICE E2E` | Not performed this phase (out of scope, §18) |

---

## 1. CONFIRMED BUGS

*Three confirmed bugs: P5-1 (all media sends broken), P5-2 and P5-3 (the unread badge —
backend and frontend halves of one defect that had to be fixed in both places).*

### BUG P5-1 — every outbound media send via file upload fails (the 2 FAILED IMAGE sends)

**Status:** `FIXED` — `LOCAL TEST`, root cause confirmed against `PRODUCTION READ-ONLY` evidence.

**BUG**
`sendMediaMessage()` in `whatsapp-gateway/src/session-manager.js` handed the uploaded
bytes to Baileys as `{ image: { url: <Buffer> } }`. Baileys does not accept a Buffer
inside `url`, so **every** media send that came from a frontend file upload failed with
HTTP 500 and was persisted as `FAILED`.

**IMPACT**
Media sending from the UI was 100% broken, not intermittently broken. A user sending an
image sees it optimistically, then it flips to FAILED forever. The optimistic row is
never rolled back and never retried.

**REPRODUCTION**
`whatsapp-gateway/scripts/test-p5-media-payload.mjs` — 9 assertions. Before the fix it
threw **the exact production error**, byte for byte:

```
TypeError [ERR_INVALID_ARG_VALUE]: The argument 'path' must be a string, Uint8Array,
or URL without null bytes. Received <Buffer 89 50 4e 47 0d 0a 1a 0a ...>
    at createReadStream (node:fs:3164:10)
    at getStream (.../@whiskeysockets/baileys/lib/Utils/messages-media.js:264:22)
```

`89 50 4e 47` is the PNG magic, `ff d8 ff e0` the JPEG magic — the same bytes production
logged. Same error code, same Baileys line.

**ROOT CAUSE**
Verified against the installed Baileys source, `lib/Utils/messages-media.js:249`:

```js
export const getStream = async (item, opts) => {
    if (Buffer.isBuffer(item))   return { stream: toReadable(item), type: 'buffer' };
    if ('stream' in item)        return { stream: item.stream,      type: 'readable' };
    const urlStr = item.url.toString();
    if (urlStr.startsWith('data:'))                       return ...;   // base64
    if (urlStr.startsWith('http://') || 'https://'))      return ...;   // remote
    return { stream: createReadStream(item.url), type: 'file' };        // <-- Buffer here
};
```

`{ url: <Buffer> }` matches none of the first three branches: `buf.toString()` is binary
decoded as UTF-8 and never starts with `data:`/`http(s):`. So it falls through to
`createReadStream(<Buffer>)` and Node rejects the path argument.

Secondary defect in the same builder: `mimetype` was nested inside the source object.
`prepareWAMessageMedia` reads `uploadData.mimetype` — a sibling of `image` — so the
declared MIME type was silently discarded.

**FIX**
`whatsapp-gateway/src/session-manager.js` — extracted the payload construction into a
pure, exported `buildMediaContent()` and corrected it:

- a Buffer is passed **directly** as the media value (Baileys' `Buffer` branch);
- `mimetype` is a **sibling** key on the content object;
- `media_url` still goes through `{ url: <string> }` unchanged;
- `document` keeps `fileName`.

**REGRESSION TEST**
`whatsapp-gateway/scripts/test-p5-media-payload.mjs`, added to the `test-*.mjs` loop.
It asserts against the **real** Baileys `getStream` (no stubs/mocks): base64 IMAGE /
VIDEO / AUDIO / DOCUMENT must stream back the uploaded bytes; a `data:` URL must decode;
an `https://` URL must stay a string (asserted structurally — the suite must not depend
on the network); `mimetype` must be a sibling; plus a source guard that no Buffer ever
reaches a `url` field.

**Fail → pass verified:** the file was written and run *before* the fix (threw
`ERR_INVALID_ARG_VALUE`), then re-run after (9/9 pass).

---

### BUG P5-2 — the unread badge could never clear, and mark-read lied on provider failure

**Status:** `FIXED` — `LOCAL TEST`.

**BUG**
Two separate defects in the same area, both about the read/unread truth.

*P5-2a — monotonic `max()`.* Both chat-snapshot write paths used

```python
conv.unread_count = max(conv.unread_count or 0, int(item.get("unread_count") or 0))
```

The gateway is the **owner** of `unread_count` and reports it verbatim, including
**decreases** — reading a chat on the phone drives it to 0 and `chats.update` forwards
that. A monotonic `max()` can only ever raise, so a read performed on the phone or
another device could never lower the badge. The badge was permanently stuck.

*P5-2b — mark-read claimed success on failure.* `mark_conversation_read()` cleared
`unread_count` **and** stamped `last_read_at` even when the gateway call raised. The DB
then said "read" while the counterparty still saw the message unread. Worse, the
`last_read_at` stamp poisoned the read-guard, so a later legitimate snapshot could no
longer correct the value.

**IMPACT**
Unread badges that never clear; and a silent lie — the UI shows a conversation as read
when WhatsApp never received the read receipt.

**REPRODUCTION**
`backend/tests/test_whatsapp_forensic_phase5.py`:

- `test_p5_stale_snapshot_does_not_resurrect_a_read_conversation`
- `test_p5_snapshot_can_lower_the_badge_read_on_another_device`
- `test_p5_stale_snapshot_does_not_erase_newer_message_unread`
- `test_p5_failed_provider_mark_read_does_not_claim_the_chat_was_read`
- `test_p5_successful_mark_read_clears_unread` (control case)

**ROOT CAUSE**
No shared policy: each write path re-implemented the arithmetic ad hoc, and the read
path was fail-open.

**FIX**

1. New pure primitive `should_apply_unread_count()` in
   `backend/app/services/whatsapp/preview_normalization.py`, plus the applier
   `apply_conversation_unread_count()` in `repositories/conversations.py`. It applies
   the gateway value verbatim — so it can go **down** — with exactly two staleness
   guards:
   - *decrease guard:* a snapshot older than the newest message we already hold cannot
     account for that message, so it may not lower the badge;
   - *read guard:* a snapshot at or before our own successful read describes the
     pre-read state, so it may not raise the badge back.
2. All three write paths now go through it (`events.py` `conversation_updated`,
   `sync.py` `_persist_chat_snapshot`, `sync.py` reconnect snapshot).
3. `mark_conversation_read()` now writes only inside the success path
   (`if gateway_ok and ...`).
4. The `conversation_read` event handler now stamps `last_read_at` — without it the
   read guard had nothing to compare against.

**REGRESSION TEST**
The five tests above, plus the source guard
`test_p5_no_unread_monotonic_max_remains_in_the_write_paths`.

**Fail → pass verified:** the `max()` rule was temporarily restored in `events.py`; the
unread tests failed. Restoring the fix made them pass. Two pre-existing tests that had
pinned the *untruthful* mark-read behaviour were updated to the truthful contract
(`test_whatsapp_live.py`, `test_whatsapp_orchestration_messaging.py`).

---

### BUG P5-3 — the UI clamped the badge with `Math.max`, undoing P5-2

**Status:** `FIXED` — `LOCAL TEST`.

**BUG**
`WhatsAppHubPage.tsx`'s realtime `conversation_updated` merge contained

```ts
next.unread_count =
  payload.unread_count != null ? Math.max(c.unread_count || 0, payload.unread_count) : c.unread_count;
```

the same monotonic-`max` defect as P5-2a, on the frontend.

**IMPACT**
This is the badge the user actually sees. The backend now correctly persists `0` and
**emits the persisted value** (`event["conversation"]["unread_count"] = conv.unread_count`,
`events.py` ~line 1126), but the UI clamped it back up. Without this fix P5-2 would have
been invisible to the user: the database would say "read" while the badge stayed lit.

**ROOT CAUSE**
The backend is the authority and already applies the staleness policy before emitting, so
the value arriving over the WebSocket is safe to accept verbatim. The UI re-implemented
its own arithmetic instead.

**FIX**
New pure helper `resolveUnreadCount()` in
`frontend/src/features/whatsapp/lib/whatsappUnread.ts` (matching the existing
`whatsappOrdering` / `whatsappIdentity` / `whatsappPreview` lib pattern), wired into the
WS merge: an explicit value — including `0` — is authoritative; an absent value keeps known
state.

**REGRESSION TEST**
Three new checks in `frontend/scripts/verify-whatsapp-logic.mjs` (which bundles and runs
the **real** source with esbuild, since the frontend has no test runner): the badge can go
down; a partial event never erases it; and a source guard that the merge no longer clamps
with `Math.max`.

**Fail → pass verified:** `resolveUnreadCount` was temporarily reverted to `Math.max`; the
suite failed with `explicit 0 must clear the badge`. Restoring made it pass (32/32).

---

## 2. LATENT BUGS

None newly identified this phase. See §3 for two items that looked like bugs and were
not.

---

## 3. NOT BUG (investigated and cleared)

### §6 — history exhaustion single-call write — already fixed at HEAD

The directive flagged `sync.py:1383-1402` as the known-remaining bug (background sweep
setting `FULLY_EXHAUSTED` from a single provider call). **It is already fixed** at
`f4db4dd` by the H-2 change: the sweep no longer implements its own policy, it delegates
to `hydrate_messages_on_demand`, which funnels every provider outcome through the shared
`history_evidence.record_on_demand_provider_result` primitive
(`sync.py:1400-1423`). The two-step `EXHAUSTION_CANDIDATE → FULLY_EXHAUSTED` policy
therefore applies identically to the on-demand scroll path and the background path —
which is exactly the "shared primitive, not special-cased" requirement.

The background-history flag remains `False` (`config.py:180`). Not touched.

### §13 — duplicate conversation race — already mitigated; Phase 5 addition reverted

Concurrent first-contact ingest looked like it produced two conversation rows. It does
not, on a correctly migrated database:

- `Conversation.__table_args__` already declares
  `uq_conv_user_session_contact_channel (user_id, session_id, contact_id, channel)`;
- `ensure_conversations_columns` (registered at `main.py:111`) already creates it, with
  same-line dedup, for both Postgres and SQLite;
- **production already has it** (`PRODUCTION READ-ONLY`:
  `CREATE UNIQUE INDEX uq_conv_user_session_contact_channel ON public.conversations
  USING btree (user_id, session_id, contact_id, channel) WHERE (session_id IS NOT NULL)`,
  and `duplicate_conversation_groups = 0`);
- `_ensure_conversation_race_safe` already catches `IntegrityError` → rollback →
  re-resolve owner → retry.

I initially added a dedicated C-5 migration **and** a per-(user, contact, line) asyncio
lock. Both were **removed** after verification:

- the migration duplicated `ensure_conversations_columns` one-for-one;
- the lock was **measured** to be ineffective: concurrent events use different DB
  sessions, and a `flush()`ed but uncommitted row is invisible to the other session, so
  the post-lock SELECT still returns "yok". The DB constraint is the real backstop.
  (My intermediate edit had also mis-scoped the lock body to wrap only the filter
  computation, making it a no-op.)

The observations that started this line were an artifact of my own `DROP INDEX` during
probing, not of production behaviour. Two tests now pin the real invariant instead:
`test_p5_conversation_line_uniqueness_is_enforced_by_the_database` (a duplicate row with
the same line is rejected; note the line must be set — NULL `session_id` rows are
deliberately allowed to coexist) and
`test_p5_line_uniqueness_index_is_scoped_by_line` (same contact on two lines stays two
conversations).

### §3 — outbound status monotonicity — correct as written

`resolve_next_delivery_status` / `DELIVERY_STATUS_RANKS` already enforce
`PENDING → SENT → DELIVERED → READ` never going backwards. Tests pin:
`test_p5_status_never_downgrades_after_read`,
`test_p5_failed_outbound_is_not_downgraded_by_late_pending_echo`,
`test_p5_sent_is_not_downgraded_by_late_failed_echo`,
`test_p5_outbound_echo_reconciles_optimistic_row_not_a_new_one`,
`test_p5_duplicate_message_new_with_distinct_event_ids_is_deduplicated`,
`test_p5_concurrent_duplicate_message_new_is_deduplicated`.

`PRODUCTION READ-ONLY`: `stuck PENDING = 0`; messages whose `wa_message_id` repeats
inside one conversation = `0`.

### §15 — preview/ordering drift

`PRODUCTION READ-ONLY`: `preview_without_timestamp = 0`. Realtime-vs-snapshot ordering
and group-metadata preview protection are covered by
`test_p5_group_subject_arrival_does_not_downgrade_preview`,
`test_p5_partial_conversation_updated_keeps_existing_state`, and
`test_p5_ordering_is_by_activity_not_identity_resolution`.

### §17 — F-5 New Chat

Unchanged. `WhatsAppRepository.startConversation()` still throws
`WhatsAppApiError('Yeni konuşma başlatmak için canlı gateway gereklidir.')` — an explicit
product decision, no fake success.

---

## 3b. FINAL SWEEP OF §5 / §7 / §8 / §12 / §13 — NO NEW CONFIRMED BUG FOUND

These areas were audited after the main report was written. Each was checked against
source (and, where a guard exists, its cleanup path), not assumed.

| Area | What was checked | Result |
|---|---|---|
| **§12** reconnect burst | `_schedule_initial_sync` session single-flight (`sync.py:1190-1206`): per-`(owner, session)` marker, further requests coalesced and *counted*; `_run_initial_sync`'s `finally` releases every marker for that owner once nothing is pending, so a later genuine reconnect can reconcile again. Verified the `CancelledError` path also reaches the `finally`. | Correct — "one session ⇒ one effective reconcile" holds and markers cannot leak. |
| **§6** concurrent history | `whatsapp_service.py:644-709`: `_in_flight_history_fetches[(conv.id, before)]` future + double-check inside the conversation-scoped lock + `pop` in `finally`. Same conversation + same cursor ⇒ one in-flight provider op. | Correct. |
| **§13** remaining races | Grepped every `IntegrityError` handler and every `ON CONFLICT`. There are **no** `ON CONFLICT` upserts, so all writes are SELECT-then-INSERT. All five handlers roll back and re-resolve (`events.py:254` contact, `events.py:360` conversation, `sync.py:563` bulk contacts, `sync.py:654` bulk conversations); the top-level `events.py:1427` rolls back and drops the event — correct, because the concurrent twin already persisted it. | Correct — no unguarded check-then-create found. |
| **§15** partial `conversation_updated` | Backend (`events.py:1043-1075`): `is_archived` guarded by `"archived" in payload`; name/avatar guarded by presence; preview/unread routed through the shared policies; `is_group` falls back to the `@g.us` suffix so a partial event cannot de-group a group. The emitted payload is the **canonical** shape including the persisted `conv.unread_count`. Frontend: routes through `mapConversationItem(buildConversationUpdatedPayload(...))`. | Correct (the one defect found here is P5-3). |
| **§5 / §7** snapshot vs realtime, inbound dedup | Covered by `test_p5_stale_snapshot_does_not_downgrade_newer_preview`, `test_p5_partial_conversation_updated_keeps_existing_state`, `test_p5_duplicate_message_new_with_distinct_event_ids_is_deduplicated`, `test_p5_concurrent_duplicate_message_new_is_deduplicated`. | Correct. |
| **§8** chat scroll / **§9** identity / **§10** groups | Frontend ordering + preview + identity logic pinned by `verify-whatsapp-logic.mjs` (32 checks); group preview protection pinned by `test_p5_group_subject_arrival_does_not_downgrade_preview`; identity/LID by the Phase 4 G-3 suite. | No new finding. |

---

## 4. TEST-INFRASTRUCTURE FIX (not a production bug)

`backend/tests/conftest.py` gained an autouse `reset_whatsapp_module_globals` fixture.

`sync.py` keeps a module-global on-demand provider budget keyed by
`(owner, conversation_id)`; `whatsapp_service.py` keeps an in-flight history map; there
are also conversation locks and JID cooldown/attempt counters. These keys are unique in
production — a conversation id is never reused. In the suite, every module wipes the
tables, so SQLite hands out the **same** ids again, and unrelated tests silently shared
one budget. That surfaced as 15 order-dependent failures in `test_whatsapp_live.py`
(`test_38_lazy_hydration_older_history_keyset_ordering` saw the budget exhausted and
therefore never observed `get_messages` being called).

Resetting between tests restores the production assumption that a conversation id
identifies exactly one conversation.

---

## 5. PRODUCTION READ-ONLY FINDINGS

Executed with `PGOPTIONS='-c default_transaction_read_only=on'`; the session asserted
`default_transaction_read_only = on` before any query. 14 sections, 0 errors. Script:
`scratch/phase5_prod_readonly.sql`, log `scratch/prod_p5_readonly_2026-09-19.log`.

| # | Finding | Value |
|---|---|---|
| 00 | read-only assertion | `on` |
| 01 | `uq_conv_user_session_contact_channel` present | **1** |
| 02 | duplicate `(user, line, contact, channel)` groups | **0** |
| 03 | `uq_msg_conv_wa_message_id` (C-4) present | **0 — ABSENT** |
| 04 | `FAILED` messages, all time | **2**, both IMAGE, both base64 uploads → P5-1 |
| 05 | `FAILED` by type/day | `IMAGE / 2026-09-18 / 2` |
| 06 | FAILED media payload evidence | `client_message_id` `file_1789762781346_0pfti5`, `file_1789745472229_w4nxo5`; PNG + JPEG magic in the error |
| 07 | unread > 0 and never read | 5 (normal) |
| 08 | read but still unread | 0 |
| 09 | preview without `last_message_at` | 0 |
| 10 | `wa_message_id` repeated in one conversation | 0 |
| 11 | stuck `PENDING` outbound | 0 |
| 12 | status distribution | INBOUND/RECEIVED 967 · OUTBOUND/SENT 837 · OUTBOUND/READ 23 · OUTBOUND/FAILED 2 |
| 13 | table sizes | conversations 562 · messages 1829 · contacts 1960 · whatsapp_sessions 4 |
| 14 | unique indexes present | `conversations_pkey`, `uq_conv_user_session_contact_channel`, `idx_msg_client_id`, `messages_pkey` |

**§14 read-path re-scan.** Re-applied the Phase 4 synthetic-vs-natural discriminator to
all new code. An unscoped read is safe only when the key is *synthetic and globally
unique* (a `crypto.randomUUID()` event id); it is a tenant leak when the key is a
*natural key that repeats across tenants* (`lid_jid`, `history_sync_states.jid`, phone,
`gateway_id`). No new leaking reader found — the only `WHERE … = :value` matches are the
G-3 comments documenting the fixed path and a `conversation_id`-scoped cleanup query.
Not auto-flagged: global synthetic event-id dedup, admin aggregates, shared gateway
infrastructure, orphan-detection CLI.

---

## 6. TEST RESULTS

| Gate | Baseline (§1) | Phase 5 |
|---|---|---|
| Backend `pytest backend/tests` | 1039 passed | **1058 passed** (0 failed) |
| Gateway `test-*.mjs` loop | 18/18 | **19/19** (new: `test-p5-media-payload.mjs`) |
| Frontend `tsc --noEmit` | 0 | **0** |
| Frontend `npm run build` | success | **success** |
| Frontend `verify-whatsapp-logic.mjs` | 29/29 | **32/32** |
| `git diff --check` | clean | **clean** |

New tests: `backend/tests/test_whatsapp_forensic_phase5.py` (19),
`whatsapp-gateway/scripts/test-p5-media-payload.mjs` (9 assertions),
`frontend/scripts/verify-whatsapp-logic.mjs` (+3 checks).

---

## 7. RELEASE BLOCKERS

1. **Production is still 3 commits behind** (`f6ec68d` vs local `f4db4dd`). It therefore
   has neither C-4 (`uq_msg_conv_wa_message_id` — confirmed absent above), nor the
   Phase 4 G-3 tenant-isolation fix, nor P5-1 / P5-2. `PRODUCTION DEPLOY` was not
   performed this phase.
2. **P5-1 is not end-to-end verified on a live device.** The regression test proves the
   payload is now valid for the real Baileys media primitives and reproduces the original
   failure exactly, but no message was sent to anyone (§18). A single self-owned-number
   media send after deploy is the confirming check.
3. **Controlled live device E2E not run** (out of scope per §18).

---

## 8. EXPLICITLY NOT DONE

- No production deploy, migration, or data write.
- No message sent to a real third party.
- Phase 4 security / tenant-isolation fixes **not** reverted (G-3 scoped resolver and
  `history_evidence` session requirement both still present and covered by
  `test_whatsapp_forensic_phase4_g3.py`).
- `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED` left `False`.
- F-5 New Chat not implemented.
- No new architecture; no changes to Baileys, session lifecycle, the ACK model, or the
  history protocol.
