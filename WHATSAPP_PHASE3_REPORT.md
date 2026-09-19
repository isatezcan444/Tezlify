# TEZLIFY WHATSAPP — PHASE 3 FINAL HARDENING

**Report date:** 2026-09-18
**Baseline commit:** `f4db4dd` — *"feat: implement WhatsApp Phase 2 fixes with robust event delivery and refactored frontend identity utilities"*
**Scope rule honoured:** Phase 1 and Phase 2 are accepted as given. No broad re-audit was performed. Only the single open technical gap (C-4) plus the two product decisions (F-5, G-3) are addressed.

---

## 0. CURRENT SNAPSHOT (verified this run — not carried over)

| Gate | Command | Result |
|---|---|---|
| Backend | `pytest backend/tests -q` | **1023 passed, 0 failed** |
| Backend (broad) | `pytest backend -q` | 1023 passed, **1 pre-existing collection failure** (see §6.2) |
| Gateway | `node scripts/test-*.mjs` × 17 | **17 / 17 passed** |
| Frontend types | `npx tsc --noEmit` | **exit 0** |
| Frontend build | `npm run build` | **exit 0** — 1628 modules, built in 2.91s |
| Frontend logic | `node frontend/scripts/verify-whatsapp-logic.mjs` | **PASS — 29 / 29 checks** |
| Whitespace | `git diff --check` | **clean (exit 0)** |

| Status flag | Value |
|---|---|
| **C-4** (message concurrency dedup) | **CLOSED** — migration + DB constraint + concurrency regression |
| **F-5** (New Chat) | **OPEN — PRODUCT DECISION** (unchanged, no fake success) |
| **G-3** (LID session scoping) | **OPEN — PRODUCT DECISION** (contract documented, behaviour untouched) |
| Background history expansion | **OFF** (`config.py:180` → `False`) |
| P0 findings | **0** |
| Live paired-device E2E | **NOT RUN** (no paired device in this environment) |
| **FINAL VERDICT** | **RELEASE CANDIDATE** |

### 0.1 Exact change surface

```
 M backend/app/core/migrations.py                 | +124   (new migration function)
 M backend/app/main.py                            |   +2   (import + startup call)
 M backend/app/models/message.py                  | +20/-1 (index declaration, `text` import)
 M backend/tests/test_whatsapp_forensic_phase2.py | +68/-17 (C-4 test rewritten)
?? backend/tests/test_whatsapp_forensic_phase3.py         (new — 10 tests)
```

Four files modified, one added. **No identity, ordering, history, status, session or gateway logic was touched.** That is the basis for the invariant-preservation claim in §5.

---

## 1. C-4 — MESSAGE CONCURRENCY DEDUP (the one real technical gap)

### 1.1 The defect, stated precisely

`messages.wa_message_id` was `String(255), nullable=True, index=True` — a **plain, non-unique** index (`ix_messages_wa_message_id`). Three application-level guards existed and all three were *sequential*:

| Guard | Location | Shape |
|---|---|---|
| Inbound ingest dedup | `orchestration/events.py:423-441` | `SELECT` → if found, return canonical; else `INSERT` |
| Gateway persist dedup | `orchestration/events.py:362` via `message_exists_by_wa_id` | `SELECT` then `INSERT` |
| Merge dedup | `reconcile_legacy_split_conversation` | deletes duplicate `wa_message_id` rows before re-pointing |

A `SELECT`-then-`INSERT` guard cannot close a race: two concurrent deliveries both run their `SELECT`, both observe "absent", and both `INSERT`. The result is two rows for one provider message — a duplicate event, a duplicate unread increment, and (on reconnect replay) a visible duplicate in the thread.

### 1.2 Step 1 — READ-ONLY data analysis (no production write)

Executed through a `sqlite3.connect("file:...?mode=ro", uri=True)` handle, so a write was impossible by construction.

| Query | Result |
|---|---|
| `SELECT COUNT(*) FROM messages` | **0** |
| `SELECT COUNT(*) FROM messages WHERE wa_message_id IS NULL` | **0** |
| `GROUP BY conversation_id, wa_message_id HAVING COUNT(*) > 1` | **0 groups** |
| Same `wa_message_id` across **different** conversations | **0** |

Schema inspection of `sqlite_master` confirmed:

```
CREATE INDEX         ix_messages_wa_message_id  ON messages (wa_message_id)          <- non-unique
CREATE UNIQUE INDEX  ix_messages_client_message_id ON messages (client_message_id)   <- already unique
```

**Semantics that had to be decided before writing any migration:**

| Question | Answer found in the code | Consequence for the index |
|---|---|---|
| Can the same `wa_message_id` appear in a **different** conversation? | Yes — legitimately. A WhatsApp message id identifies a message, and a message belongs to exactly one chat; a chat re-keyed LID→PN is merged by `reconcile_legacy_split_conversation`. Also pinned by `test_34_wa_message_id_dedup_is_conversation_scoped_and_reliable` (asserts **2** rows across two conversations). | The index **must be conversation-scoped**. A global unique index on `wa_message_id` would be **wrong** and would break the merge path. |
| Do inbound and outbound share the same `wa_message_id` semantics? | Yes — both are the provider id from Baileys. Outbound rows carry `client_message_id` until `_confirmOutboundSent` learns the provider id. | One index covers both. |
| How must NULLs behave? | Locally-created rows have no provider id until acknowledged. `status` is `NOT NULL` but `wa_message_id` must stay nullable. | The index **must be partial** (`WHERE wa_message_id IS NOT NULL`) so many unacknowledged rows coexist. |
| Any historical duplicates? | 0 in the reachable database. | Migration proceeds; if duplicates existed it would refuse (see §1.4). |

**Scope caveat, stated plainly:** the only database reachable from this environment is the local development artifact `./tezlify.db`. No production host or credentials are configured. The numbers above therefore describe a **dev artifact**, not production. §4 records this as `NOT RUN (production)`.

### 1.3 Step 2 — The migration

Implemented in the project's normal migration layer. **There is no Alembic in this project** — `backend/app/core/migrations.py` is the migration layer, and it is driven from startup (`backend/app/main.py:105-120`). The new function follows the established `ensure_contacts_unique_phone` shape: idempotent, dialect-aware, fail-soft.

```python
_WA_MSG_UNIQUE_INDEX = "uq_msg_conv_wa_message_id"

async def ensure_messages_wa_message_id_unique(engine: AsyncEngine) -> str:
    # 0) table present?            -> SKIPPED
    # 1) index already present?    -> ALREADY_PRESENT   (idempotent)
    # 2) READ-ONLY duplicate scan  -> BLOCKED           (creates nothing, deletes nothing)
    # 3) CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_conv_wa_message_id
    #      ON messages (conversation_id, wa_message_id)
    #      WHERE wa_message_id IS NOT NULL              -> CREATED
    # any exception                                    -> ERROR (logged, never raised)
```

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_conv_wa_message_id
ON messages (conversation_id, wa_message_id)
WHERE wa_message_id IS NOT NULL
```

Registered in `main.py` immediately after `ensure_messages_wa_message_id(engine)`, and mirrored in the ORM so a fresh install gets the identical index from `create_all`:

```python
Index(
    "uq_msg_conv_wa_message_id",
    "conversation_id", "wa_message_id",
    unique=True,
    sqlite_where=text("wa_message_id IS NOT NULL"),
    postgresql_where=text("wa_message_id IS NOT NULL"),
),
```

### 1.4 Step 3 — Safety properties (as mandated)

| Mandate | Implementation | Verified by |
|---|---|---|
| Not ad-hoc runtime DDL in a request path | The only DDL lives in `migrations.py`; no index is created inside a handler, the ingest path, or a repository | `git diff` — 0 lines changed in any service/API module |
| In the normal migration layer | `migrations.py`, called from the startup sequence | smoke test: `registered in startup: True` |
| Compatible with existing production data | Duplicate scan runs **before** any DDL; `CREATE ... IF NOT EXISTS`; one dialect-agnostic statement | `test_c4_migration_creates_conversation_scoped_partial_unique_index` |
| `BLOCKED` reported **before** the migration when duplicates exist | `logger.error("[MIGRATION][BLOCKED] ...")` with the offending groups, then `return "BLOCKED"` — no index created | `test_c4_migration_reports_blocked_on_duplicates_without_touching_data` |
| No automatic destructive cleanup | No `DELETE`, no `UPDATE`, no merge. Deliberately **unlike** `ensure_contacts_unique_phone`, which merges because there the canonical row (smallest id) is unambiguous. For messages there is no safe answer to "which copy is real" — that decision belongs to an operator | same test asserts **all 3 duplicate rows survive** and the total row count is unchanged |
| Must not crash startup | Fail-soft `try/except` → `"ERROR"` + warning, matching every other migration in the file | `test_c4_migration_does_not_raise_on_failure` |

> **Deployment consequence — read this.** On a database that already contains `(conversation_id, wa_message_id)` duplicates, the index is **not** created and the race remains open. Startup logs `[MIGRATION][BLOCKED] uq_msg_conv_wa_message_id olusturulamadi: ... Otomatik temizlik YAPILMADI`. The operator must resolve the duplicates, then restart. This is intentional and is the only honest option given the no-destructive-cleanup constraint.

### 1.5 Step 4 — Concurrency regression (real, not simulated)

**Deterministic backstop test.** `test_c4_db_constraint_rejects_a_duplicate_conversation_scoped_insert` bypasses the application guard entirely and writes a second row straight through the ORM:

```
IntegrityError  ✓ (the DB refuses the duplicate)
5 rows with wa_message_id IS NULL in one conversation  ✓ (partial index works)
same wa_message_id in a DIFFERENT conversation        ✓ (conversation-scoped)
```

**N-parallel-delivery test.** `test_c4_parallel_inbound_delivery_persists_exactly_one_row` drives the **production entry point** `ingest_gateway_event` — real sessions, real commits — with 6 identical `message_new` events, synchronised through an `asyncio.Barrier` injected into owner resolution so the deliveries genuinely overlap.

> **The overlap is real, not theoretical.** With the C-4 index removed, this exact test persisted **five duplicate rows** for one provider message. With the index in place it persists **one**. That before/after is the strongest available evidence that the race was genuine and is now closed.

Final observed run (post-fix):

```
published ids            : {1}                 <- one canonical id, no divergent duplicates
message rows             : [(1, 1, 'wa-c4-race-1')]   <- exactly one row
result distribution      : 1 x None (loser, rolled back), 5 x canonical dict
```

| Required outcome | Result |
|---|---|
| DB row count = 1 | ✅ |
| No unhandled `IntegrityError` | ✅ — the loser degrades gracefully |
| No duplicate event storm | ✅ — every published delivery carries the same canonical id; `unread_count == 1` |

**Why no production change was needed for the "no unhandled `IntegrityError`" requirement.** `ingest_gateway_event` already wraps its `db.commit()` in `except IntegrityError: await db.rollback(); logger.warning(...); return None` (`events.py:1380-1383`). The constraint and that pre-existing guard compose correctly: the loser rolls back cleanly, the unread increment and `last_message_at` write are undone with it, and nothing is re-broadcast. The DB constraint closes the race; the existing guard keeps the failure silent-but-logged. **No code change was required** — the two halves already fit.

**Why the loser is dropped rather than resolved to the canonical row.** Re-resolving and re-broadcasting would emit a second `message_new` for a message already delivered — exactly the duplicate event storm the requirement forbids. Dropping the redundant delivery is the truthful outcome.

**Control test.** `test_c4_parallel_delivery_of_distinct_messages_all_persist` — 6 distinct messages under the same concurrency must **all** persist. Without this, a constraint that rejected everything would still pass the single-message test.

### 1.6 Step 5 — Drift guard

`test_c4_model_declaration_matches_the_migration` compares the DDL the migration **actually emitted** (read back from `sqlite_master`) against the DDL SQLAlchemy **compiles from the model**, normalised. It also asserts the PostgreSQL and SQLite predicates are identical, because the migration emits one statement for both dialects. This closes the drift class that produced the original gap: the migration's existence check matches on **name only**, so a lookalike index under the same name would be silently accepted.

### 1.7 Verification scripts (reproducible, read-only where it matters)

| Script | Purpose |
|---|---|
| `scratch/verify_c4_migration.py` | 14 checks over throwaway SQLite DBs: CREATED / ALREADY_PRESENT / BLOCKED / SKIPPED, real `IntegrityError`, NULL semantics, cross-conversation allowance. **14/14 passed.** |
| `scratch/c4_readonly_integrity_check.py` | §4 read-only integrity survey. Opens the DB with `mode=ro`. |

---

## 2. F-5 — NEW CHAT: `OPEN — PRODUCT DECISION`

**No product decision was provided. Nothing was implemented.** No fake success was produced.

Current state, verified:

```ts
// frontend/src/features/whatsapp/data/whatsappRepository.ts:293-295
static async startConversation(_data: { phone: string; name?: string; message?: string }): Promise<ConversationDetail> {
  throw new WhatsAppApiError('Yeni konuşma başlatmak için canlı gateway gereklidir.');
}
```

The UI path (`NewChatModal.tsx:40-54`) awaits it and routes the failure to `toast.error(err.message)`. So the surface is **truthful** — it reports a real error and never claims a conversation was created — but the feature does not exist.

**What a decision must settle before implementation:**
1. Does the product want server-side conversation creation at all, or is a chat only ever created by an inbound/outbound WhatsApp event?
2. If yes: who owns `contact` creation, `conversation` creation, and the first outbound send — one atomic operation or three?
3. What happens when the gateway is offline at the moment of creation?
4. Is `channel` always `WHATSAPP`, and does the new conversation need a `session_id` (which line to send from)?

---

## 3. G-3 — LID SESSION SCOPING: contract reported, behaviour untouched

**No behaviour was changed.** What follows is what the current code actually does.

### 3.1 The schema and the writers are session-scoped (Model B)

```sql
CREATE TABLE whatsapp_private.lid_mappings (
    session_id TEXT NOT NULL REFERENCES whatsapp_private.gateway_sessions(session_id) ON DELETE CASCADE,
    lid_jid    VARCHAR(100) NOT NULL,
    phone_jid  VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, lid_jid)          -- <- one row per (session, lid)
)
```

Both writers are session-scoped and upsert on that key:

| Writer | Statement |
|---|---|
| `whatsapp-gateway/src/session-manager.js:766` | `INSERT ... ON CONFLICT (session_id, lid_jid) DO UPDATE` |
| `whatsapp-gateway/src/auth/postgres-auth-repository.js:193` | `INSERT ... ON CONFLICT (session_id, lid_jid) DO UPDATE` |

### 3.2 The readers are **not** session-scoped — and one is not even user-scoped

| Reader | Query | Effective scope |
|---|---|---|
| `orchestration/events.py:186` | `WHERE lid_jid = :lid ORDER BY created_at DESC LIMIT 1` | **GLOBAL** — no `session_id`, no `user_id` |
| `orchestration/events.py:504` | same | **GLOBAL** — no `session_id`, no `user_id` |
| `services/whatsapp_service.py:469` | `WHERE lid_jid = ANY(:lids)` | **GLOBAL** — no `session_id`, no `user_id` |
| `orchestration/sync.py:830` | `WHERE session_id = :sid` | **Strictly session-scoped** |
| `session-manager.js:782-787` | `SELECT DISTINCT ON (lid_jid) ... ORDER BY lid_jid, (session_id = $1) DESC, created_at DESC` | **Hybrid** — reads all sessions, *prefers* the current one |

### 3.3 Which model does the contract accept?

**Storage is Model B. Reads are overwhelmingly Model A, with one hybrid read.** The net effective contract is:

> **Model A with a session-preference tiebreak** — the system treats LID↔PN as a global, user-level identity fact, while retaining per-session provenance rows and preferring the local session's answer in the gateway.

**The sharp edge.** `lid_mappings` has **no `user_id` column** — its only route to a tenant is `session_id → gateway_sessions`. Therefore:

- a **session-scoped** read is tenant-safe by construction;
- a **global** read is **not**. If the same `@lid` is observed in two tenants' sessions, `events.py:186` returns whichever row was written most recently — potentially the *other tenant's* phone number, and the result is then written into a contact lookup (`events.py:199-204`) and, from `whatsapp_service.py:490`, into the display path.

This is the concrete reason G-3 needs a decision rather than a guess.

**The two models, for the decision:**

| | **Model A** — global user-level identity fact | **Model B** — session-specific |
|---|---|---|
| Claim | One `@lid` maps to one PN, globally | One `@lid` maps to a PN *per session* |
| Current fit | Matches 4 of 5 readers, and the gateway's `DISTINCT ON` preference | Matches the schema PK and both writers |
| Cost | Requires scoping every read to the **same user's** sessions (a join to `gateway_sessions`), or accepting cross-tenant contamination | Requires adding `session_id` to the three global reads and to `whatsapp_service.py:469`; may fail to resolve a LID seen only on another of the user's lines |
| Blocked by | Needs a product/protocol answer: **can WhatsApp issue the same `@lid` to two different users?** | — |

**Recommendation (not applied):** if the answer to that question is "no, `@lid` is account-scoped", Model A is correct and the fix is to scope the three global reads to the owning user's sessions. If the answer is uncertain, Model B is safe by construction. Either way the change is small and localised to five call sites — but it must not be made without the decision.

---

## 4. PRODUCTION READ-ONLY INTEGRITY CHECK

**Scope: `NOT RUN (production)`.** No production host or credentials are configured in this environment. The only reachable database is the local development artifact `./tezlify.db`. What follows is reported as **dev artifact** and must not be read as a production result.

All queries ran through a `mode=ro` URI handle — no `UPDATE`, `DELETE` or `INSERT` was issued. Script: `scratch/c4_readonly_integrity_check.py`.

| Check | Result | Verdict |
|---|---|---|
| duplicate `(conversation_id, wa_message_id)` groups | 0 | OK — migration not blocked |
| `wa_message_id` spanning >1 conversation | 0 | OK (allowed by design) |
| `messages` with `wa_message_id IS NULL` | 0 | OK |
| duplicate `(user_id, phone_e164)` contacts | 0 | OK — `uq_contact_user_phone` holds |
| contacts with `name_source = "push"` | 0 | OK |
| contacts whose **primary** name came from a push name | 0 | OK — §1 invariant holds in data |
| contacts with a raw JID/LID as `display_name` | 0 | OK |
| duplicate `(user_id, contact_id, channel)` conversations | 0 | OK |
| orphan messages (no parent conversation) | 0 | OK |
| conversations pointing at a missing contact | 0 | OK |
| active sessions **not** in `CONNECTED` | **1** | REVIEW — dev artifact: 1 session in `SCAN_QR`, `phone_number = NULL`, gateway id `c3855e1c-…`. Mid-pairing or abandoned; not a defect |
| `history_sync_states` `FULLY_EXHAUSTED` rows | 0 | OK — background expansion stays OFF |
| `history_sync_states` state distribution | `PROVIDER_ERROR` 30 / `NOT_CHECKED` 4 | Dev artifacts (`gw-relink-*`, `gw-seed-test`, `gw-test-session`) |
| `whatsapp_private.lid_mappings` | **not reachable** | PostgreSQL-only table; absent from a SQLite database. **G-3's data-side check could not be performed** |
| C-4 index present | `uq_msg_conv_wa_message_id` ✅ | Created on this DB by the migration |

Table census: `messages` 0, `conversations` 0, `contacts` 51, `leads` 23145, `whatsapp_sessions` 1, `history_sync_states` 34.

**Two checks that remain genuinely unperformed and must be run against production before `RELEASE READY`:**
1. The duplicate scan on the real `messages` table (must be `0 groups`, or the migration reports `BLOCKED`).
2. The LID mapping distribution `SELECT session_id, COUNT(*) FROM whatsapp_private.lid_mappings GROUP BY 1` — needed to size the G-3 decision.

---

## 5. PHASE 2 REGRESSION PRESERVATION — 11 / 11 HOLD

Structural argument: the change surface in §0.1 touches **no** identity, ordering, history, status, session or gateway logic. Empirical confirmation: the full suite passes and each invariant has a named, currently-passing test.

| # | Invariant | Pinning test(s) — all PASSED |
|---|---|---|
| 1 | unsaved contact → `+90` phone | `test_phase154_identity_and_sync_guard.py::test_unsaved_phone_contact_with_push_name_resolves_to_phone`, `::test_unsaved_phone_contact_is_not_unresolved`, `::test_pn_jid_without_contact_record` |
| 2 | pushName → not primary name | `test_phase154_identity_and_sync_guard.py::test_set_contact_name_push_does_not_pollute_display_name`, `test_whatsapp_forensic_fixes.py::test_upsert_contact_create_never_writes_push_name_as_display_name`, `::test_safe_display_name_never_returns_push_nickname_for_phone_contact`, `test_whatsapp_faz8_names.py::test_contact_synced_does_not_create_for_low_rank_push` |
| 3 | `identity != ordering` | `test_phase154_identity_and_sync_guard.py::test_activity_ordering_independent_of_identity` |
| 4 | REST identity == WS identity | `test_whatsapp_forensic_phase2.py::test_ws_conversation_updated_emits_canonical_contract` |
| 5 | raw LID → never user-facing | `test_whatsapp_faz7_identity_sync.py::test_safe_display_name_never_leaks_jid`, `::test_upsert_contact_never_stores_raw_lid_as_name`, `::test_jid_to_phone_rejects_lid`, `::test_list_conversations_sanitizes_raw_jid_name`, `test_whatsapp_faz8_names.py::test_set_contact_name_rejects_raw_jid`, `test_whatsapp_faz7_identity_sync.py::test_ingest_message_with_lid_sender_name_does_not_store_name` |
| 6 | group → group name | `test_whatsapp_faz8_names.py::test_group_conversation_displays_subject_not_raw_jid`, `::test_set_contact_name_group_subject_beats_history_and_push`, `::test_jid_to_phone_rejects_group_jid`, `test_phase154_identity_and_sync_guard.py::test_group_jid_not_treated_as_phone` |
| 7 | history exhaustion → two-step | `test_whatsapp_forensic_phase2.py::test_h2_background_sweep_needs_two_steps_to_exhaust`, `::test_h2_second_zero_sweep_completes_exhaustion` |
| 8 | timeout → durable evidence | `test_whatsapp_forensic_phase2.py::test_h3b_full_timeout_commits_evidence_before_raising`, `::test_h3_partial_timeout_records_real_count_and_persists_messages` |
| 9 | background expansion → OFF | `config.py:180` `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED: bool = False` + `test_phase154_identity_and_sync_guard.py::test_background_expansion_kill_switch` |
| 10 | read failure → does not report READ success | `test_whatsapp_orchestration_messaging.py::test_mark_conversation_read_relink_required_truthfulness` |
| 11 | failed send → `FAILED`, not `SENT` | `test_whatsapp_orchestration_messaging.py::test_send_text_message_gateway_failure_marks_failed`, `test_whatsapp_forensic_phase2.py::test_http_send_failure_never_returns_a_success_payload` |

Targeted invariant gate: **107 passed** across `test_phase154_identity_and_sync_guard.py`, `test_whatsapp_faz7_identity_sync.py`, `test_whatsapp_faz8_names.py`, `test_whatsapp_forensic_fixes.py`, `test_whatsapp_forensic_phase2.py`, `test_whatsapp_orchestration_messaging.py`.

> **Note on invariant 9.** `backend/tests/conftest.py` forces `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED = True` for the duration of each test, purely so the sweep can be exercised. The **production default** is `False` and was not changed. The kill-switch behaviour is pinned by `test_background_expansion_kill_switch`.

**One test was rewritten** (`test_whatsapp_forensic_phase2.py`), because its premise changed:

- `test_34_wa_message_id_has_no_unique_db_constraint` → renamed to `test_34_wa_message_id_uniqueness_is_conversation_scoped_and_partial`. It previously asserted only that *no* unique constraint existed. It now pins **both** facts: the single-column index stays **non-unique** (unacknowledged local rows must not collide) **and** the conversation-scoped partial unique index exists. The docstring of `test_34_wa_message_id_dedup_is_conversation_scoped_and_reliable` was corrected — it claimed the DB constraint did not exist, which is no longer true.

---

## 6. TEST GATE — real results

### 6.1 Commands run

```
pytest backend/tests -q                                  -> 1023 passed, 0 failed
pytest backend -q                                        -> 1023 passed, 1 failed (pre-existing, see 6.2)
node whatsapp-gateway/scripts/test-*.mjs  (x17)          -> 17 / 17 passed
cd frontend && npx tsc --noEmit                          -> exit 0
cd frontend && npm run build                             -> exit 0 (1628 modules, 2.91s)
node frontend/scripts/verify-whatsapp-logic.mjs          -> PASS (29 checks)
git diff --check                                         -> clean
git status --short                                       -> 4 modified + 1 added (see 0.1)
```

**Backend number movement:** `1013 passed` (baseline `f4db4dd`) → **`1023 passed`**. The +10 are exactly the new `test_whatsapp_forensic_phase3.py` tests. No previously-passing test was removed, skipped or weakened.

### 6.2 The one failure — pre-existing, not caused by this work

```
backend/scripts/test_staging_playwright_auth.py::test_playwright_staging_flow
  Failed: async def functions are not natively supported.
```

Evidence it is pre-existing and unrelated:

1. The file is **untouched** by this work (`git status` clean for it).
2. It contains **0** `pytest.mark.asyncio` markers; pytest-asyncio runs in strict mode, so an undecorated `async def` fails at setup.
3. It **fails identically in isolation** (`pytest backend/scripts/test_staging_playwright_auth.py` → 1 failed).
4. It is a **manual staging E2E script** living in `backend/scripts/`, not in `backend/tests/` — it drives a real staging host and Playwright, which is not available here.

It is therefore excluded from the backend gate number, which is why the canonical scope is reported as `backend/tests`.

### 6.3 Environment note for reproducing the gate

In this sandbox, a second `pytest` run can fail at fixture setup with `PermissionError: EEXIST ... mkdir '.../pytest-of-root'` — the sandbox's `mkdir` wrapper rejects creating an existing directory, and pytest's `tmp_path` factory calls `mkdir(exist_ok=True)`. Clear the stale roots first:

```bash
rm -rf "$TMPDIR"pytest-of-root "$TMPDIR"pytest-of-unknown
```

This is a sandbox artifact, not a repository defect.

---

## 7. LIVE E2E — **NOT RUN**

No paired WhatsApp device is available in this environment (the single `whatsapp_sessions` row is in `SCAN_QR` with `phone_number = NULL`). Per instruction, this is reported as **`NOT RUN`** rather than guessed at. **No PASS was written.**

The 11-step paired-device E2E (pair → initial sync → existing contact → unsaved phone → external inbound → outbound → ACK → read → older history → identity + ordering → reconnect) therefore remains **unexecuted**.

---

## 8. REPORT CONSISTENCY

| Number | Status |
|---|---|
| `1010 passed` | **historical / superseded** (pre-Phase-2 intermediate snapshot) |
| `23/23` frontend logic | **historical / superseded** (superseded by `29/29`) |
| `975` baseline at `f6ec68d` | **historical** (Phase 1 baseline) |
| `1013 passed` / `17/17` / `29/29` | **baseline** at `f4db4dd` — the accepted Phase 2 snapshot |
| **`1023 passed` / `17/17` / `29/29` / `tsc 0` / `build 0`** | **CURRENT** — measured this run |

No stale Phase 1 number is presented as a current result anywhere in this document. Where a historical figure appears it is labelled as such.

---

## 9. FINAL DECISION

> ## **RELEASE CANDIDATE**

The C-4 migration plus its concurrency regression **succeeded**. The one real technical gap from Phase 2 is closed, with:
- a conversation-scoped partial unique index in the normal migration layer,
- a `BLOCKED` path that refuses to create the index when duplicates exist and destroys nothing,
- a deterministic DB-level proof and an N-parallel integration proof,
- a drift guard between the model and the migration,
- all 11 Phase 2 invariants intact,
- and a change surface of four modified files plus one new test file.

**`RELEASE READY` is deliberately NOT written**, because two gates remain:

1. **F-5 and G-3 are undecided product decisions** (§2, §3). F-5 is unimplemented and honest about it; G-3's behaviour is documented but its cross-tenant risk is unresolved.
2. **The paired-device live E2E has not run** (§7), and the **production** read-only integrity check — in particular the duplicate scan that gates the C-4 migration — has not run either (§4).

### Remaining work, in priority order

| # | Item | Owner | Blocked by |
|---|---|---|---|
| 1 | Run the C-4 duplicate scan on **production** `messages`; if non-zero, resolve duplicates before the next deploy | Ops | — |
| 2 | Run `SELECT session_id, COUNT(*) FROM whatsapp_private.lid_mappings GROUP BY 1` on production to size the G-3 decision | Ops | — |
| 3 | Decide G-3: is `@lid` account-scoped (Model A) or session-scoped (Model B)? Then scope the 5 read sites accordingly | Product / Protocol | #2 |
| 4 | Decide F-5: does New Chat create a conversation server-side, and who owns contact/conversation/first-send? | Product | — |
| 5 | Paired-device live E2E, 11 steps | QA | a paired device |
| 6 | Fix the pre-existing collection error in `backend/scripts/test_staging_playwright_auth.py` (add `@pytest.mark.asyncio`, or move it out of pytest's collection path) | Eng | — |
| 7 | *Optional:* add a standalone runner for `ensure_messages_wa_message_id_unique` so the index can be applied out-of-band before a deploy, rather than only at startup | Eng | — |

---

## Appendix — C-4 migration semantics, independently verified

`scratch/verify_c4_migration.py` — **14 / 14 checks passed** against throwaway SQLite databases:

```
PASS  clean DB -> CREATED
PASS  index exists
PASS  index is UNIQUE
PASS  index is PARTIAL on NULL
PASS  second run -> ALREADY_PRESENT (idempotent)
PASS  duplicates present -> BLOCKED
PASS  no index created when BLOCKED
PASS  no row deleted/merged (4 rows intact)
PASS  all 3 duplicate rows survive (no destructive cleanup)
PASS  missing messages table -> SKIPPED
PASS  duplicate (conv, wa_id) INSERT is REJECTED by the DB   [IntegrityError]
PASS  5 rows with NULL wa_message_id coexist (partial index)
PASS  same wa_message_id in a DIFFERENT conversation is allowed
PASS  wa-x exists in exactly 2 conversations
```

Emitted DDL, read back from `sqlite_master`:

```sql
CREATE UNIQUE INDEX uq_msg_conv_wa_message_id
ON messages (conversation_id, wa_message_id)
WHERE wa_message_id IS NOT NULL
```
