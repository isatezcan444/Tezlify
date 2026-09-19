# TEZLIFY WHATSAPP — PHASE 4 ADDENDUM
## G-3 Class-Wide Tenant Isolation Sweep + Fix Verification on Real Data

**Date:** 2026-09-19
**Extends:** `WHATSAPP_PHASE4_REPORT.md`
**Scope:** the remaining `whatsapp_private.*` tables, plus a read-only proof of the G-3 fix against real production data. No production mutation; no new architecture.

---

## 1. WHY THIS ADDENDUM EXISTS

The Phase 4 directive named one table (`lid_mappings`). The §6 instruction, however, was to *build a reader
matrix*, and §4 framed G-3 as a **tenant isolation / data correctness / identity integrity** problem — not a
single-table bug. So the sweep was extended to every table in `whatsapp_private` and every LID/evidence read
in the gateway.

That produced:

* **one new latent finding** (`history_sync_states`, same bug class, fixed in this pass), and
* **a decidable rule** for telling a legitimate global read from a tenant leak.

---

## 2. THE DISCRIMINATOR — when is an unscoped read actually safe?

This is the reusable result of the sweep. An unscoped (tenant-less) read is safe **only** when the key is
**synthetic and globally unique**. It is a tenant leak when the key is a **natural key that legitimately
repeats across tenants**.

| Key | Nature | Unscoped read |
|---|---|---|
| `processed_events.event_id` | `crypto.randomUUID()` per event emission — synthetic, 122 bits | **Safe.** A global idempotency ledger is the correct design. |
| `lid_mappings.lid_jid` | Natural. The same LID is observed by every tenant that talks to that account. | **LEAK.** Returns another tenant's row. |
| `history_sync_states.jid` | Natural. Two tenants can both talk to the same phone number. | **LEAK.** Returns another tenant's exhaustion state. |

The asymmetry is not obvious and is the reason a bare `WHERE key = :key` looks harmless in review: for a
synthetic key it genuinely *is* harmless, and that pattern is then copied to a natural key.

**This is the same principle as §9 of the main report, applied across every table:**

> A global protocol fact is not a globally readable row — and a synthetic globally-unique key is not a
> natural key that repeats.

---

## 3. CLASS-WIDE READER MATRIX

### 3.1 `whatsapp_private` — backend

| Table | Reader | Location | Scope | Verdict |
|---|---|---|---|---|
| `lid_mappings` | `_upsert_contact` LID branch | `events.py:186` | own session → same user → stop | **FIXED** (Phase 4) |
| `lid_mappings` | `_ingest_contact_synced` | `events.py:504` | own session → same user → stop | **FIXED** (Phase 4) |
| `lid_mappings` | `list_conversations` batch | `whatsapp_service.py:469` | same user's sessions | **FIXED** (Phase 4) |
| `lid_mappings` | bulk-sync keying | `sync.py:830` | `session_id = :sid` | ALREADY SAFE |
| `history_sync_states` | `get_history_evidence` (scoped) | `history_evidence.py:82` | `session_id AND jid` | SAFE |
| **`history_sync_states`** | **`get_history_evidence` (`session_id=None`)** | **`history_evidence.py:86-92`** | **`WHERE jid = :jid` — GLOBAL** | ⚠ **LATENT LEAK → FIXED** |
| `history_sync_states` | `record_on_demand_provider_result` | `history_evidence.py:298` | `session_id AND jid` | SAFE |
| `history_sync_states` | relink migration UPDATE | `relink.py:268` | `session_id = :old_gw_id` | SAFE |
| `history_sync_states` | orphan detection scan | `recovery.py:118` | global, `NOT EXISTS` owner | **BY DESIGN** — operator CLI (`scripts/recover_whatsapp_session.py`), whose purpose *is* orphan detection |
| `history_sync_states` | orphan count | `recovery.py:205` | `session_id = :gid` | SAFE |
| `processed_events` | dedup SELECT / INSERT | `events.py:1334`, `events.py:1372` | global, keyed by `event_id` | **BY DESIGN** — synthetic UUID |
| `socket_leases`, `event_outbox`, `retry_messages` | admin ops aggregates | `admin/whatsapp_admin_service.py:137,160,182` | global counts | **BY DESIGN** — `require_admin` (ADMIN_EMAILS allow-list, fail-closed), read-only ops centre, PII masked |

### 3.2 Gateway

| Reader | Location | Scope | Verdict |
|---|---|---|---|
| `loadLidMappingsFromDb` | `session-manager.js:783` | own session + same-owner sessions | **FIXED** (Phase 4) |
| `syncLidMappingsFromDisk` | `session-manager.js:701-710` | own dir + same-owner dirs | **FIXED** (Phase 4) |
| `persistLidMappingToDb` | `session-manager.js:766` | `(session_id, lid_jid)` | SAFE (writer) |
| `loadCredentials` | `postgres-auth-repository.js:84` | `session_id = $1` | SAFE |
| `getSignalKeys` | `postgres-auth-repository.js:124` | `session_id = $1` | SAFE |
| `listRestorableSessions` | `postgres-auth-repository.js:67` | all active lines | **BY DESIGN** — the gateway is shared infrastructure, not a tenant; it must enumerate every line to restore it |
| `event_outbox.claimPending` | `postgres-event-outbox.js:50` | global queue, `FOR UPDATE SKIP LOCKED` | **BY DESIGN** — single shared consumer; payload encrypted per `(sessionId, eventId)` |
| `socket_leases` | `postgres-session-lease.js` | instance coordination | **BY DESIGN** |

**Architectural note.** The gateway is a *shared service*, not a tenant. A global read inside it is therefore
not automatically a leak — the leak is when the gateway uses **one tenant's data to serve a different
tenant's session**. That is precisely what the unfiltered `DISTINCT ON` and the every-directory disk sweep
did, and both are now scoped. Nothing else in the gateway crossed that line.

---

## 4. THE NEW FINDING — `history_sync_states` (latent, not live)

```python
# BEFORE
if session_id:
    ... WHERE session_id = :sid AND jid = :jid
else:
    ... WHERE jid = :jid ORDER BY updated_at DESC LIMIT 1     # <-- cross-tenant
```

`jid` is a natural key. Tenant A could read tenant B's `state`, `provider_checked`, `provider_exhausted` and
`provider_msgs_returned` for any shared counterparty — i.e. **whether another tenant has exhausted the
history for that contact, and how many messages the provider returned**. Beyond the leak, the value feeds
the UI's `has_more` decision, so tenant B's evidence could drive tenant A's "load older messages" affordance
— a **data-correctness** problem as well.

### Why it is latent, not live — verified, not assumed

All three call sites guard on a resolved session id:

| Call site | Guard |
|---|---|
| `whatsapp_service.py:739` | `if history_session_id and conv.contact_id:` |
| `whatsapp_service.py:668` | `if j_val and history_session_id and await is_history_exhausted_or_stalled(...)` |
| `sync.py:1642` | `if sid_str and await is_history_exhausted_or_stalled(db, jid, session_id=sid_str)` |

and `sync.py:1425` passes `session_id=str(gateway_id)`. So **no live leak**. The `session_id=None` branch was
unreachable.

**But it is a latent footgun**, and it is exactly the shape of G-3's root cause: a helper whose *default*
behaviour is a global read. The safety came from a convention duplicated at three call sites, not from an
enforced invariant — so the next caller to omit the argument (the natural thing to write) reopens the bug.

### The fix

`session_id` is now **required**. With none, the function returns the fail-closed `NOT_CHECKED` default
instead of falling back to a cross-tenant read. Behaviour is **unchanged for every existing caller** (they
all pass one); the duplicated guard becomes an enforced invariant.

---

## 5. VERIFICATION OF THE G-3 FIX ON REAL PRODUCTION DATA (read-only)

Rather than trust synthetic fixtures, the old and new read semantics were both executed against the live
database, read-only. Production has exactly **two** tenant-owned lines: `e512dd40…` (ws 68, `CONNECTED`) and
`f65642ab…` (ws 67, `DISCONNECTED`).

### 5.1 What the OLD global read actually did

| Metric | Value |
|---|---|
| LID rows owned by the two tenants | **1580** |
| …where the old global read (`ORDER BY created_at DESC LIMIT 1`, no tenant filter) selected a row from **another session** | **27** |
| …where that selected row was owned by **another tenant or by nobody** | **27** |

**27 of 1580 (1.7 %) of the tenants' LID lookups were answered from a row that did not belong to them.**
This corroborates the Phase 4 §3.3 collision count of 27 from an independent direction.

### 5.2 Orphan reachability — an honest nuance

| Metric | Value |
|---|---|
| LID keys reachable **only** via orphan (unowned) rows | **0** |

The 1165 orphan rows are real and were globally readable, but **none of them introduced a key the tenants
could not already resolve for themselves** — they are shadowed duplicates of keys the tenants also hold. So
the orphan exposure was a genuine read-path violation but did **not** widen the reachable key set. Stating
this precisely matters: the risk was real, and it was smaller than the raw row count suggests.

### 5.3 The fixed resolver, executed on real data

| tenant | rows visible | from own session | from same-user sibling |
|---|---|---|---|
| `e512dd40…` | 1372 | **1372** | 0 |
| `f65642ab…` | 208 | **208** | 0 |

1372 + 208 = **1580** — exactly the tenant-owned set from §5.1. The scoped read is therefore **precisely the
legitimately-owned rows: no leakage, and no loss of resolution**. The 27 lookups that previously resolved
from a foreign row now resolve locally.

### 5.4 Reproduce

`scratch/phase4_prod_readonly.sql` §17 (17a–17d) runs all of the above under
`PGOPTIONS='-c default_transaction_read_only=on'`.

---

## 6. GATES AFTER THE ADDITIONAL CHANGE

| Gate | Result |
|---|---|
| Backend `pytest backend/tests -q` | **1039 passed** (1036 + 3 new) |
| Gateway `test-*.mjs` loop | **18 / 18** |
| Frontend `verify-whatsapp-logic.mjs` | **29 / 29 PASS** |
| `git diff --check` | clean |

New tests in `backend/tests/test_whatsapp_forensic_phase4_g3.py` (13 → 16):

* `test_g3_history_evidence_is_scoped_to_the_requesting_tenant` — tenant B's `FULLY_EXHAUSTED` /
  `provider_msgs_returned = 42` row is invisible to tenant A, which gets the fail-closed default. It asserts
  tenant B *does* see its own row, so the test cannot pass by the query simply failing.
* `test_g3_history_evidence_requires_a_session_id` — `None` and `""` both fail closed, including through the
  `is_history_exhausted_or_stalled` delegate.
* `test_g3_history_evidence_has_no_unscoped_branch` — source guard; every `history_sync_states` read must be
  session-scoped.

These are non-vacuous: `_table_name()` is dialect-aware and returns the bare table name on SQLite, so the
query genuinely executes against a real table in the test DB.

---

## 7. RELEASE DECISION — UNCHANGED

**`RELEASE CANDIDATE`.** The two blockers from the main report stand, and this addendum does not move them:

1. **Production is stale.** Deployed `f6ec68d` ≠ local `f4db4dd`. The C-4 index is absent from production and
   the G-3 fix — including this addendum's `history_sync_states` change — is **not live**.
2. **Controlled live E2E not run.**

The class-wide sweep *strengthens* the security claim (one more instance found and closed, and the remaining
global reads are now individually justified rather than assumed) but it does not substitute for deploying.

**Updated remaining-work item.** The background-sweep `FULLY_EXHAUSTED` promotion
(`sync.py:1383-1402`) is now the **only** remaining known correctness gap of this family. It must be
corrected before `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED` is ever enabled; production currently
carries 10 such rows, 4 with no provider evidence at all. Out of scope here by directive §18.
