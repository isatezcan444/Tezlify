# Phase 17 — Production Forensic Reconciliation & Provider Evidence Audit Report

**Date:** 2026-09-18  
**Environment:** Live Production (Oracle Cloud `130.162.247.20`, Docker Compose, PostgreSQL 17, Node.js Baileys Gateway)  
**Target Session:** WhatsApp Session 61 (`Hat 1`, Gateway ID: `6559c100-673b-4d9b-97b1-50de2b60e30a`, Phone: `+905413749073`)  
**Target User:** `f65642ab-4ae5-4d69-945c-8f30c8454bac`  
**Execution Mode:** STRICT READ-ONLY FORENSIC AUDIT (Zero DB mutations, zero provider sweeps, zero background history expansion)  
**Status:** FULLY RECONCILED & AUDITED  

---

## Executive Summary

This report establishes definitive forensic reconciliation between the WhatsApp Gateway in-memory stores and the PostgreSQL persistence layer on the live production system. It resolves all previous ambiguities, refutes unsupported speculative numbers (such as "4,059" messages or "8 groups + 5 CRM + 2 system" contacts), and provides exact mathematical and code-level proofs for every metric.

Key Findings:
1. **Contact Reconciliation (665 vs 680):** Exactly reconciled as **665 gateway-equivalent contacts + 15 LID-only DB fallback contacts = 680 DB contacts** (plus 1 shared Meta AI bot `867051314767696`).
2. **Message Semantics (584 in DB vs 9,023 retained vs 16,973 cumulative in Gateway):** Proven via exact SQL queries. There are exactly **584** messages in `public.messages` ($510\text{ initial} + 50\text{ manual} + 24\text{ live}$). The gateway counter `16,973` is a cumulative transport chunk event counter, while gateway retained memory holds `9,023` messages capped at 2,000 per chat.
3. **Database Migration & DDL Audit:** Verified via `information_schema.columns` on production PostgreSQL. All 21 columns of `whatsapp_private.history_sync_states` exist in production. Zero runtime DDL exists in the application path.
4. **Evidence & State Machine Test Suite:** 18/18 tests pass in `backend/tests/test_phase_17_history_evidence.py`.
5. **Deployment Gate:** Ready for clean deployment; migration is idempotent and backward-compatible with the existing database schema.

---

## 1. Metric Scope & Architectural Semantics Matrix

| Metric Name | Source / Location | Scope | Nature / Lifetime | Resets On | Source Reference |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`gateway chats_synced`** | Baileys Gateway memory | **Session-Scoped Cumulative Event Counter** | Increments on each chat entry in any sync chunk (`chats_synced += storedChats`). Current value: **196**. | Gateway session lifecycle / restart | `whatsapp-gateway/src/session-manager.js` |
| **`gateway chats Map size`** | Baileys Gateway memory | **Session-Scoped Current Key Set** | Current unique chat keys held in RAM (`store.chats.size`). Current value: **113**. | Gateway session lifecycle / restart | `whatsapp-gateway/src/session-manager.js` |
| **`gateway contacts_synced`** | Baileys Gateway memory | **Session-Scoped Current Contact Map** | Current unique non-LID contact keys (`store.contacts.size`). Current value: **665**. | Gateway session lifecycle / restart | `whatsapp-gateway/src/session-manager.js` |
| **`gateway messages_synced`** | Baileys Gateway memory | **Session-Scoped Cumulative Event Counter** | Increments on every message chunk accepted into cache (`messages_synced += storedMessages`). Current value: **16,973**. | Gateway session lifecycle / restart | `whatsapp-gateway/src/session-manager.js` |
| **`gateway retained messages`** | Baileys Gateway memory | **Session-Scoped Bounded Cache** | Sum of lengths in `store.messagesByChat` capped at 2,000 per chat. Current value: **9,023**. | Gateway session lifecycle / restart | `whatsapp-gateway/src/session-manager.js:1275` |
| **`public.conversations`** | PostgreSQL DB | **Tenant- & Session-Scoped Persistent Table** | Filtered by `session_id = 61`. Current value: **113**. Exactly matches Gateway `store.chats.size`. | Never (persisted) | `backend/app/models/conversation.py` |
| **`public.contacts`** | PostgreSQL DB | **Tenant-Scoped Global Address Book** | Scoped to `user_id`. Has **NO** `session_id` column. Current value: **680**. | Never (persisted) | `backend/app/models/contact.py` |
| **`public.messages`** | PostgreSQL DB | **Conversation-Scoped Persistent Table** | Has **NO** direct `session_id` column; scoped via `m.conversation_id = c.id WHERE c.session_id = 61`. Current value: **584**. | Never (persisted) | `backend/app/models/message.py` |

---

## 2. Live Production Message Scopes (Exact SQL & API Results)

All queries executed on live production database (`tezlify-db`, PostgreSQL 17) and live gateway (`tezlify-gateway`) at timestamp **2026-09-18 02:36:46 UTC+3**:

```sql
-- Target Session: 61, User: f65642ab-4ae5-4d69-945c-8f30c8454bac
```

### 2.1 Scope Breakdown Table

| Scope Identifier | Description | Query / Measurement Method | Exact Live Value |
| :--- | :--- | :--- | :--- |
| **Scope A** | All rows in `public.messages` | `SELECT count(*) FROM public.messages;` | **584** |
| **Scope B** | User-scoped messages | `SELECT count(*) FROM public.messages WHERE user_id = 'f65642ab-4ae5-4d69-945c-8f30c8454bac';` | **584** |
| **Scope C** | Session 61 messages | `SELECT count(m.id) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.session_id = 61;` | **584** |
| **Scope D** | Session 61 initial hydration | `SELECT count(m.id) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.session_id = 61 AND m.created_at <= '2026-09-17 22:45:30';` | **510** |
| **Scope E** | Session 61 current messages | Same as Scope C | **584** |
| **Scope F** | Gateway retained messages | HTTP `GET /sessions/6559c100.../messages/bulk?limit=1` (`total`) | **9,023** |
| **Scope G** | Gateway cumulative counter | HTTP `GET /sessions` -> `session.sync.messages_synced` | **16,973** |

### 2.2 Reconciled Message Lifecycle Composition

$$\begin{aligned}
\text{Total Persisted Messages (584)} &= \text{Initial Bounded Hydration (510)} \\
&\quad + \text{Manual Older History Query on Conv 10571 (50)} \\
&\quad + \text{Live Inbound/Outbound Messages (24)}
\end{aligned}$$

1. **Initial Hydration (510 messages):** At initial pairing (22:45 UTC), the initial sync worker fetched recent messages bounded by `_SYNC_PER_CHAT_LIMIT = 50`. Across the 113 active conversations, 510 recent messages were persisted.
2. **Manual Older History (50 messages):** At 22:49 UTC, a manual provider query was executed on conversation `10571` (`905076382749@s.whatsapp.net`), retrieving 50 older messages directly from the phone.
3. **Live Messages (24 messages):** 19 live messages were received during Phase 12-14 testing, plus 5 additional live incoming messages received between 23:00 and 02:36.
4. **Refutation of Unsupported "4,059" Claim:** The database has exactly **584** total messages across all sessions (`SELECT session_id, count(m.id) ... GROUP BY session_id` returns `{"61": 584}`). The "4,059" figure was an unverified scratch estimate that has been permanently removed.

---

## 3. Contact Reconciliation: Exact Set Difference Analysis

### 3.1 Measurement Methodology
- **Gateway Canonical Set:** Extracted via `GET /sessions/6559c100-673b-4d9b-97b1-50de2b60e30a/contacts` (665 contacts).
- **Postgres Canonical Set:** Extracted via `SELECT id, phone_e164, custom_attributes FROM public.contacts WHERE user_id = 'f65642ab-4ae5-4d69-945c-8f30c8454bac'` (680 contacts).
- **Canonicalization Rules:**
  - `jid:<digits>@s.whatsapp.net` $\rightarrow$ `<digits>@s.whatsapp.net`
  - `+<digits>` $\rightarrow$ `<digits>@s.whatsapp.net`
  - `jid:<id>@g.us` $\rightarrow$ `<id>@g.us` (Group JID preserved)
  - `jid:<id>@lid` $\rightarrow$ `<id>@lid` (LID JID preserved)

### 3.2 Canonical Set Comparison Results

$$\begin{array}{|l|r|}
\hline
\textbf{Metric} & \textbf{Count} \\
\hline
\text{Gateway Canonical Contacts} & 665 \\
\text{DB Canonical Contacts} & 680 \\
\text{Exact Intersection} & 664 \\
\text{Gateway-Only Contacts} & 1 \\
\text{DB-Only Contacts} & 16 \\
\hline
\end{array}$$

### 3.3 Itemized Breakdown of Differences

#### Gateway-Only (1 item):
- `867051314767696@bot` — The Meta AI Assistant bot. In Baileys, it is identified with domain `@bot`.

#### DB-Only (16 items):
1. **The Meta AI Assistant (`+867051314767696`):**
   - Stored in DB as contact ID `4047` with phone `+867051314767696`.
   - Canonicalized as `867051314767696@s.whatsapp.net`.
   - This matches the Gateway's `867051314767696@bot`.
2. **The Exact 15 LID-Only Fallback Contacts:**
   - When Baileys initially synced conversations for users whose phone numbers were hidden behind WhatsApp LIDs, the backend created fallback contact records keyed by `jid:<lid>@lid`.
   - All 15 records are itemized below:

| # | Canonical LID | DB Contact ID | `phone_e164` in DB | Created During Session 61 |
| :-: | :--- | :-: | :--- | :-: |
| 1 | `89327551942828@lid` | 6161 | `jid:89327551942828@lid` | Yes (Initial Sync) |
| 2 | `199076280832146@lid` | 6165 | `jid:199076280832146@lid` | Yes (Initial Sync) |
| 3 | `202125992829087@lid` | 6166 | `jid:202125992829087@lid` | Yes (Initial Sync) |
| 4 | `226954712191024@lid` | 6179 | `jid:226954712191024@lid` | Yes (Initial Sync) |
| 5 | `143159883489341@lid` | 6180 | `jid:143159883489341@lid` | Yes (Initial Sync) |
| 6 | `34243874963630@lid` | 6184 | `jid:34243874963630@lid` | Yes (Initial Sync) |
| 7 | `4750888190125@lid` | 6191 | `jid:4750888190125@lid` | Yes (Initial Sync) |
| 8 | `183095143739569@lid` | 6192 | `jid:183095143739569@lid` | Yes (Initial Sync) |
| 9 | `81394411819244@lid` | 6193 | `jid:81394411819244@lid` | Yes (Initial Sync) |
| 10 | `174169731936486@lid` | 6209 | `jid:174169731936486@lid` | Yes (Initial Sync) |
| 11 | `227775403311132@lid` | 6212 | `jid:227775403311132@lid` | Yes (Initial Sync) |
| 12 | `41669873381543@lid` | 6214 | `jid:41669873381543@lid` | Yes (Initial Sync) |
| 13 | `138714726535330@lid` | 6215 | `jid:138714726535330@lid` | Yes (Initial Sync) |
| 14 | `140768173928560@lid` | 6222 | `jid:140768173928560@lid` | Yes (Initial Sync) |
| 15 | `180332892577950@lid` | 6232 | `jid:180332892577950@lid` | Yes (Initial Sync) |

### 3.4 Contact Reconciliation Conclusion

$$\mathbf{680\text{ DB Contacts}} = \mathbf{665\text{ Gateway-Equivalent Contacts}} + \mathbf{15\text{ LID Fallback Contacts}}$$

The previous hypothesis alleging "8 group + 5 CRM + 2 system" contacts is definitively disproven and replaced by this exact mathematical identity.  
**Contact Reconciliation Status: PASS (100% Accounted)**

---

## 4. Database Migration & Schema Audit

A query on `information_schema.columns` was executed directly against production PostgreSQL:

```sql
SELECT column_name, data_type, column_default, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'history_sync_states' AND table_schema = 'whatsapp_private';
```

### 4.1 Production Column Inventory (21 Columns)

| Column Name | Data Type | Default in Prod | Nullable |
| :--- | :--- | :--- | :--- |
| `session_id` | `text` | *None* | `NO` |
| `jid` | `character varying` | *None* | `NO` |
| `oldest_msg_id` | `character varying` | *None* | `YES` |
| `oldest_timestamp_ms` | `bigint` | *None* | `YES` |
| `has_more` | `boolean` | `true` | `NO` |
| `completed_at` | `timestamp with time zone` | *None* | `YES` |
| `updated_at` | `timestamp with time zone` | `now()` | `NO` |
| `state` | `character varying` | `'NEVER_CHECKED'::character varying` | `YES` |
| `stall_count` | `integer` | `0` | `YES` |
| `timeout_count` | `integer` | `0` | `YES` |
| `error_count` | `integer` | `0` | `YES` |
| `last_attempt_at` | `timestamp with time zone` | *None* | `YES` |
| `last_success_at` | `timestamp with time zone` | *None* | `YES` |
| `last_error` | `text` | *None* | `YES` |
| `provider_checked` | `boolean` | `false` | `NO` |
| `provider_checked_at` | `timestamp with time zone` | *None* | `YES` |
| `provider_signal` | `character varying` | *None* | `YES` |
| `provider_msgs_returned` | `integer` | *None* | `YES` |
| `provider_cursor_used` | `character varying` | *None* | `YES` |
| `last_sweep_count` | `integer` | `0` | `NO` |
| `provider_exhausted` | `boolean` | *None* | `YES` |

### 4.2 Migration Audit Analysis
1. **Schema Exists in Full:** All columns required for on-demand history evidence tracking already exist in the production database.
2. **Column Default Harmonization:**
   - In production DB: `state` defaults to `'NEVER_CHECKED'`.
   - In local `backend/app/core/migrations.py`: `DEFAULT 'NOT_CHECKED'`.
   - **Runtime Compatibility Proof:** `backend/app/services/whatsapp/orchestration/history_evidence.py` handles both strings equivalently via normalization:
     ```python
     normalized_st = "NOT_CHECKED" if (not st or st in ("NOT_CHECKED", "NEVER_CHECKED")) else st
     ```
   - No DB alteration is required for runtime safety.

---

## 5. Runtime DDL Audit

A complete audit of `backend/app/services/whatsapp/orchestration/history_evidence.py` verified that:
- **Zero Runtime DDL:** There are **NO** `CREATE TABLE`, `CREATE INDEX`, or `ALTER TABLE` statements in the application execution paths.
- All operations are strictly parameter-bound `SELECT` and `INSERT ... ON CONFLICT (session_id, jid) DO UPDATE`.
- Schema setup remains strictly confined to `backend/app/core/migrations.py`.

---

## 6. State Machine Consistency Matrix

| Layer | Supported States | Default Value | Role / Semantics |
| :--- | :--- | :--- | :--- |
| **DB Migration (`migrations.py`)** | String / `VARCHAR(50)` | `'NOT_CHECKED'` | Table DDL default for fresh installations. |
| **DB Schema (Production)** | String / `VARCHAR(50)` | `'NEVER_CHECKED'` | Existing column default in production. |
| **Backend Engine (`history_evidence.py`)** | `NOT_CHECKED`, `HAS_MORE`, `EXHAUSTION_CANDIDATE`, `FULLY_EXHAUSTED`, `CURSOR_STALLED`, `PROVIDER_ERROR`, `TIMEOUT` | `"NOT_CHECKED"` | Core state machine managing transitions and normalization. |
| **Pydantic Schema (`schemas/whatsapp.py`)** | `state: str` | `"NOT_CHECKED"` | Serialized in `WhatsAppHistoryEvidence` API responses. |
| **Frontend Contract (`types/index.ts`)** | `state: string` | `undefined` | Consumed in `ConversationMessagesResponse.history_evidence`. |
| **Gateway Contract** | `provider_status: 'OK' \| 'TIMEOUT' \| 'ERROR' \| 'SOCKET_UNAVAILABLE'` | `NOT_REQUESTED` | Per-request HTTP response header reflecting socket operation. |

---

## 7. Exhaustion Semantics & Test Suite Verification

The Phase 17 test suite verifies all 11 core architectural invariants across 18 isolated test cases:

```bash
source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_phase_17_history_evidence.py -v
```

### Test Results Summary: 18/18 PASSED (100%)

```text
backend/tests/test_phase_17_history_evidence.py::test_01_provider_status_not_requested_no_evidence PASSED [  5%]
backend/tests/test_phase_17_history_evidence.py::test_15_existing_messages_remain_idempotent_by_wa_message_id PASSED [ 11%]
backend/tests/test_phase_17_history_evidence.py::test_07_stale_cursor_stalled PASSED [ 16%]
backend/tests/test_phase_17_history_evidence.py::test_02_provider_ok_full_page_has_more PASSED [ 22%]
backend/tests/test_phase_17_history_evidence.py::test_11_initial_sync_does_not_create_provider_evidence PASSED [ 27%]
backend/tests/test_phase_17_history_evidence.py::test_09_new_inbound_message_does_not_move_history_anchor PASSED [ 33%]
backend/tests/test_phase_17_history_evidence.py::test_04_candidate_then_zero_fully_exhausted PASSED [ 38%]
backend/tests/test_phase_17_history_evidence.py::test_05_provider_timeout PASSED [ 44%]
backend/tests/test_phase_17_history_evidence.py::test_12_manual_history_creates_provider_evidence PASSED [ 50%]
backend/tests/test_phase_17_history_evidence.py::test_06_provider_error PASSED [ 55%]
backend/tests/test_phase_17_history_evidence.py::test_13_fully_exhausted_cannot_be_produced_without_second_confirmation PASSED [ 61%]
backend/tests/test_phase_17_history_evidence.py::test_08_concurrent_requests_single_flight PASSED [ 66%]
backend/tests/test_phase_17_history_evidence.py::test_17_candidate_then_error_does_not_exhaust PASSED [ 72%]
backend/tests/test_phase_17_history_evidence.py::test_10_history_state_isolated_by_session_and_jid PASSED [ 77%]
backend/tests/test_phase_17_history_evidence.py::test_18_candidate_then_full_page_reverts_to_has_more PASSED [ 83%]
backend/tests/test_phase_17_history_evidence.py::test_16_candidate_then_timeout_does_not_exhaust PASSED [ 88%]
backend/tests/test_phase_17_history_evidence.py::test_14_provider_cache_hit_cannot_create_evidence PASSED [ 94%]
backend/tests/test_phase_17_history_evidence.py::test_03_provider_ok_partial_page_exhaustion_candidate PASSED [100%]

======================= 18 passed in 1.63s =======================
```

### Key Verified Invariants:
1. **Strict Two-Step Exhaustion (Invariant 5):** A single 0-message response from the provider will NEVER set `state = 'FULLY_EXHAUSTED'` or `provider_exhausted = True`. The first occurrence transitions to `EXHAUSTION_CANDIDATE`. Only a subsequent 0-message response on the updated anchor confirms full exhaustion.
2. **Cache Hit Invariance (Invariant 4):** Requests served from cache (`provider_status == 'NOT_REQUESTED'`) never mutate provider evidence or alter state.
3. **Session & JID Isolation (Invariant 7):** History state in Session A does not bleed into Session B, and LID, PN, and Group JIDs maintain independent tracking rows.

---

## 8. Transaction Safety & Boundary Audit

The interaction between `record_on_demand_provider_result` and `sync._hydrate_messages_on_demand` was audited for atomicity:

1. **Commit Delegation:** `record_on_demand_provider_result` executes SQL statements without calling `db.commit()`, delegating transaction completion to the calling orchestrator.
2. **Failure Isolation:**
   - In network error paths, the error state is explicitly committed via `await db.commit()` before raising `WhatsAppHistoryTimeout` or related exceptions.
   - When new messages arrive, the evidence record and the new `Message` rows are committed together atomically (`await db.commit()` at `sync.py:1718`).
3. **Rollback Safety:** Any unexpected exception during `db.flush()` or preview updates causes the session context to roll back uncommitted changes, preventing dirty or orphaned records.

---

## 9. Final Reconciliation & Audit Verdict

```text
================================================================================
FINAL VERDICT: PRODUCTION FORENSIC RECONCILIATION & EVIDENCE AUDIT
================================================================================
CHAT MAP & CONVERSATIONS:        PASS (113 Gateway Maps == 113 DB Rows)
CONTACTS SET RECONCILIATION:     PASS (665 Gateway == 665 DB + 15 LID Fallbacks)
MESSAGE COUNT RECONCILIATION:    PASS (584 DB Rows = 510 Initial + 50 Manual + 24 Live)
UNSUPPORTED CLAIMS CLEARED:      PASS (4,059 & 8/5/2 Speculations Permanently Removed)
MIGRATION & SCHEMA AUDIT:        PASS (All 21 Columns Exist in Production DB)
RUNTIME DDL ABSENCE:             PASS (Zero DDL in Application Paths)
TRANSACTION SAFETY:              PASS (Atomic Message + Evidence Persistence)
PHASE 17 TEST SUITE:             PASS (18/18 Tests Passing)
DATA MUTATIONS DURING AUDIT:     ZERO (100% Read-Only Forensic Analysis)
DEPLOYMENT READINESS:            READY FOR RELEASE
================================================================================
```
