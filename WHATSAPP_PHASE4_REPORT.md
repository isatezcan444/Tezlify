# TEZLIFY WHATSAPP — PHASE 4 REPORT
## Production Verification + G-3 Tenant Isolation Hardening

**Date:** 2026-09-19
**Scope:** production read-only verification, C-4 production migration gate, G-3 cross-tenant LID fix, final release gate.
**Explicitly out of scope (per directive §18):** new features, Baileys architecture, session lifecycle, message ACK model, history provider protocol, background-history enablement.

> **See also: `WHATSAPP_PHASE4_G3_ADDENDUM.md`** — extends §4/§6 with a class-wide sweep of every
> `whatsapp_private.*` table, one additional **latent** finding (`history_sync_states`, now fixed), the
> decidable rule for when a global read is legitimate, and a read-only proof of the G-3 fix executed against
> **real production data**. Final gate numbers after that change: backend **1039 passed**, gateway **18/18**,
> frontend logic **29/29**. The release decision is unchanged.

---

## 0. HEADLINE — READ THIS FIRST

Two facts dominate this phase, and they point in opposite directions.

1. **The G-3 risk is real, not theoretical.** Production contains **27 LID JIDs that appear under two different tenants' gateway sessions**. The read paths that resolved them were doing a bare, tenant-less `WHERE lid_jid = :lid` scan. That is a confirmed cross-tenant read path on live data.
2. **None of the fixes are live.** Production is deployed at **`f6ec68d`**, which is **3 commits behind local HEAD `f4db4dd`**. The C-4 migration and the G-3 fix exist only in the working tree. The C-4 unique index is **absent** from the production database.

> `LOCAL TEST = 1036 passed` and `PRODUCTION HEALTH = live and healthy` are **not** the same statement. Production is running **older code**. The sections below keep those two facts separate at all times.

---

## 1. LOCAL TEST (evidence class: workstation)

| Gate | Command | Result |
|---|---|---|
| Backend | `venv/bin/python -m pytest backend/tests -q` | **1039 passed** (0 failed) |
| Gateway | `for f in whatsapp-gateway/scripts/test-*.mjs; do node "$f" \|\| exit 1; done` | **18 / 18 passed** |
| Frontend types | `cd frontend && npx tsc --noEmit` | **exit 0** |
| Frontend build | `cd frontend && npm run build` | **success** — 1628 modules, `index.js` 859.75 kB (gzip 217.24 kB) |
| Frontend logic | `node frontend/scripts/verify-whatsapp-logic.mjs` | **29 / 29 PASS** |
| Whitespace | `git diff --check` | **clean** |

Baseline before Phase 4 was 1023 backend / 17 gateway. The deltas are the new G-3 tests only:

* `backend/tests/test_whatsapp_forensic_phase4_g3.py` — **16 tests** (13 for `lid_mappings`, 3 for the
  `history_sync_states` sibling instance added in the addendum)
* `whatsapp-gateway/scripts/test-g3-lid-tenant-scope.mjs` — **13 assertions** (1 new suite)

The 1036 figure quoted in the narrative below is the count **before** the addendum's sibling-table tests; the
authoritative final number is **1039**.

There is no vitest/jest in this repo. Frontend logic is executed by bundling the real TS modules with esbuild and asserting in Node — see the `esbuild-frontend-verification` skill.

---

## 2. PRODUCTION DEPLOY (evidence class: production host)

| Item | Value |
|---|---|
| Host | `tezlify-oracle` / `130.162.247.20` (Oracle Cloud Always Free) |
| SSH | `ubuntu@130.162.247.20` with `~/.ssh/id_tezlify_oracle` |
| Repo on host | `/opt/tezlify` |
| **Deployed revision** | **`f6ec68d`** (`origin/main` on the host is also `f6ec68d`) |
| Local HEAD | `f4db4dd` → **production is 3 commits behind** |
| Missing from production | `06f7df1`, `f4db4dd`, **the Phase 3 C-4 migration**, **the Phase 4 G-3 fix** |
| Images | `tezlify-backend:latest` built `2026-09-18 13:52:14Z`, `tezlify-gateway:latest` `13:52:21Z` |
| Containers | `tezlify-backend` up 19 h (healthy), `tezlify-gateway` up 19 h (healthy), `tezlify-caddy` up 20 h (healthy), `tezlify-db` up 3 d (healthy) |
| `/health` | `{"status":"healthy","gateway_bridge":{"connected":true,"last_event_at":"2026-09-19T08:38:53Z"}}` |
| PostgreSQL | 17.11 (aarch64-alpine), db `tezlify`, role `tezlify`, **103 MB** |
| `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED` | **`false`** ✅ (directive §13 satisfied — not changed) |

Verified directly on the host:

```
$ cd /opt/tezlify && git rev-parse --short HEAD          -> f6ec68d
$ grep -c 'uq_msg_conv_wa_message_id' backend/app/core/migrations.py -> 0   (absent)
$ ls backend/app/services/whatsapp/repositories/lid_mappings.py      -> ABSENT
```

**Conclusion:** production does not contain the C-4 migration and does not contain the G-3 fix. Every production statement below describes `f6ec68d`.

---

## 3. PRODUCTION READ-ONLY (evidence class: live database, read-only)

All queries were executed with a **forced read-only transaction**:

```bash
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 \
  "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' \
     tezlify-db psql -U tezlify -d tezlify"
```

The session guard was asserted first and returned `default_transaction_read_only = on`. No write was attempted and **no production data was mutated**.

### 3.1 C-4 production gate (directive §2, §3)

| Check | Query | Result | Verdict |
|---|---|---|---|
| Duplicate groups | `GROUP BY conversation_id, wa_message_id HAVING COUNT(*) > 1` | **0 rows** | ✅ migration applicable |
| Duplicate group count | same, wrapped in `COUNT(*)` | **0** | ✅ |
| `wa_message_id IS NULL` | `SELECT COUNT(*) …` | **0** | ✅ partial index covers 100 % of rows |
| Same `wa_message_id` in >1 conversation | `COUNT(*)` | 178 | ✅ allowed by design (index is conversation-scoped) |
| **Index present?** | `pg_indexes WHERE indexname = 'uq_msg_conv_wa_message_id'` | **0 → ABSENT** | ❌ **not deployed** |

Production `messages` indexes are the pre-C-4 set only: `ix_messages_wa_message_id` (non-unique, single column) plus the usual FK/status indexes. The conversation-scoped partial unique index does **not** exist.

**Per directive §2:** duplicates = 0, so the migration is **applicable and would not be blocked**. It simply has never been run in production. **No automatic deletion was performed** (there was nothing to delete).

### 3.2 Schema discovery — a directive assumption that production contradicts

Directive §1 and §7 specify joining `whatsapp_private.gateway_sessions` and filtering on `gateway_sessions.user_id`. **That column does not exist.** Actual production schema:

```
whatsapp_private.gateway_sessions(session_id TEXT PK, session_name, is_active, created_at, updated_at)
```

A repository-wide search for tenant columns returns `user_id` in `public.*` **only** — never in `whatsapp_private.*`. The real tenant route is:

```
whatsapp_private.lid_mappings.session_id      (TEXT = gateway session UUID)
  -> whatsapp_private.gateway_sessions.session_id   (FK, 1:1)
  -> public.whatsapp_sessions.gateway_id            (UNIQUE)
  -> public.whatsapp_sessions.user_id               (uuid, tenant)
```

Both §1 queries were rewritten against this route and re-run. `public.whatsapp_sessions.user_id` is **nullable**, which matters: a gateway session with no owning user has no tenant at all.

### 3.3 G-3 — the cross-tenant finding, on live data

`whatsapp_private.lid_mappings` holds **2928 rows** across 11 gateway sessions.

**Attribution vs owner** (rewritten query):

| gateway session | owning `user_id` | ws id | LID rows |
|---|---|---|---|
| `a618f89c-…` | `e512dd40-…` | 68 (`CONNECTED`) | **1372** |
| `5a1a7247-…` | `f65642ab-…` | 67 (`DISCONNECTED`) | 208 |
| 9 further sessions | **none (orphan)** | — | 1165 |

**Orphan gateway sessions: 28 of 30** — they exist in `whatsapp_private.gateway_sessions` but have no `whatsapp_sessions` row, so they belong to **no tenant**.

**Cross-user LID collision (directive §1, "özellikle önemli"):**

```sql
SELECT lm.lid_jid, COUNT(DISTINCT ws.user_id) AS user_count
FROM whatsapp_private.lid_mappings lm
JOIN whatsapp_private.gateway_sessions gs ON gs.session_id = lm.session_id
JOIN public.whatsapp_sessions ws ON ws.gateway_id = gs.session_id
WHERE ws.user_id IS NOT NULL
GROUP BY lm.lid_jid HAVING COUNT(DISTINCT ws.user_id) > 1;
```

> **27 rows returned.** Each is a `lid_jid` present in **both** `e512dd40-…` and `f65642ab-…` — i.e. under two distinct tenants' gateway sessions.

**But:** `COUNT(DISTINCT phone_jid) > 1` for the same `lid_jid` = **0**. The same LID maps to the **same** phone in both tenants. No wrong phone has ever been served.

### 3.4 §9 — `global protocol fact` ≠ `globally readable DB row`

This distinction is the core of the G-3 analysis and belongs in the report verbatim:

* **A LID → phone pair IS a global protocol fact.** WhatsApp assigns one LID to one account; every tenant observing that account learns the same pair. Production proves it: 27 LIDs are observed by two tenants, and **for all 27 the phone is identical** (`conflicting_phones = 0`).
* **A `lid_mappings` row is NOT globally readable.** The row is keyed by one gateway session, that session belongs to one user, and it records *that tenant's* observation. Reading it on behalf of another tenant is a tenant-isolation violation even when the value happens to agree.

Why the violation still mattered, given the values agree:

1. **It is a leak of existence, not just of value.** Tenant A could learn *which* LIDs tenant B has mappings for.
2. **The safety was accidental.** It held only because LIDs are globally unique. Any row written with a wrong or malicious pair — a buggy gateway path, a replayed disk file, a future multi-device LID split — would immediately resolve to a foreign tenant's phone. The invariant was never enforced.
3. **The orphan rows had no tenant at all** — 1165 mapping rows belonging to nobody were readable by everybody.

So: **protocol-global does not imply row-global.** The fix keeps the protocol fact usable while enforcing the row boundary.

### 3.5 §11 — push-name data check

| Check | Result | Verdict |
|---|---|---|
| Contacts with `name_source = 'push'` | **885** | — |
| …where push name is the **primary** display name | **0** | ✅ invariant holds |
| Contacts whose `display_name` is a raw JID/LID | **0** | ✅ |

`name_source` distribution across 1960 contacts:

```
push 885 | addressbook 703 | history 317 | (none) 37 | group_subject 15 | verified 3
```

Sample shape (phone partially masked; full sample set in the read-only log on the workstation):

```
display_name   phone_e164        name_source  push_name
+9055…08458    +9055…08458       push         <counterparty profile name>
+9055…13706    +9055…13706       push         <counterparty profile name>
+9053…27211    +9053…27211       push         <counterparty profile name>
```

Every sampled row has `display_name == phone_e164`. **No remediation was performed** (directive §11) — the count is reported for a decision, and on this evidence there is nothing to remediate.

### 3.6 §12 — identity sanity in production

| Check | Result | Verdict |
|---|---|---|
| `display_name` containing a raw JID/LID | **0** | ✅ |
| LID-keyed contacts (unsaved / unresolved identity) | **2** | ⚠ see below |

The two LID-keyed contacts carry an **empty `display_name`** and `phone_e164 = 'jid:<n>@lid'`. They are the correct *unresolved* placeholder state — the LID is not masquerading as a phone number and no push name was promoted into the name. The invariant `unsaved phone → phone display → no pushName as primary name` is visible in production data.

### 3.7 Other production integrity checks

| Check | Result | Verdict |
|---|---|---|
| Orphan messages (conversation missing) | 0 | ✅ |
| Orphan `lid_mappings` (session missing) | 0 | ✅ |
| Duplicate contact groups (`user_id, phone_e164`) | 0 | ✅ |
| Duplicate conversation groups | 0 | ✅ |
| `contacts` / `conversations` / `messages` | 1960 / 562 / 1815 | — |
| Message status spread | INBOUND/RECEIVED 963, OUTBOUND/SENT 830, OUTBOUND/READ 23, OUTBOUND/FAILED 2 | — |

The **2 FAILED outbound** rows are `IMAGE` sends from 2026-09-18 with `error_message` set. Pre-existing, unrelated to this phase; noted for visibility only.

### 3.8 §13b — background history: an observation, not a fix

`WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED = false` ✅ (unchanged).

`history_sync_states` holds 340 rows, of which **10 are `FULLY_EXHAUSTED`**:

* **6** have provider evidence (`provider_checked = t`, `provider_msgs_returned = 0`, cursor set, `last_success_at` set) — promoted from a **single** provider call.
* **4** have **no provider evidence whatsoever** (`provider_checked = f`, no cursor, `last_success_at IS NULL`) yet are marked `FULLY_EXHAUSTED`.

All 10 predate the flag being disabled (2026-09-17/18), so none can be created while the flag is off. This matches the known-open item already recorded in project memory: the background sweep promotes to `FULLY_EXHAUSTED` from one provider call instead of the required two-step `EXHAUSTION_CANDIDATE → FULLY_EXHAUSTED`. **Not remediated** — it must be corrected before the flag is ever enabled, and that is out of this phase's scope.

---

## 4. G-3 — READER MATRIX (directive §6)

Every LID read path in the repository, with its scope before and after.

| # | Reader | Location | Scope before | Scope after | Verdict |
|---|---|---|---|---|---|
| 1 | `_upsert_contact` LID branch | `orchestration/events.py:186` | **GLOBAL** — `WHERE lid_jid = :lid ORDER BY created_at DESC LIMIT 1` | own session → same user's sessions → stop | **FIXED** |
| 2 | `_ingest_contact_synced` LID branch | `orchestration/events.py:504` | **GLOBAL** — same SQL | own session → same user's sessions → stop | **FIXED** |
| 3 | `list_conversations` batch | `whatsapp_service.py:469` | **GLOBAL** — `WHERE lid_jid = ANY(:lids)` | same user's sessions | **FIXED** |
| 4 | bulk-sync conversation keying | `orchestration/sync.py:830` | `WHERE session_id = :sid` (own gateway session) | unchanged | **ALREADY SAFE** |
| 5 | `loadLidMappingsFromDb` | `session-manager.js:783` | **GLOBAL** — unfiltered `DISTINCT ON (lid_jid)` | own session + same-owner sessions | **FIXED** |
| 6 | `syncLidMappingsFromDisk` | `session-manager.js:701-710` | **EVERY session directory** | own dir + same-owner dirs | **FIXED** |

Writers were audited and left unchanged (both correctly scoped by `(session_id, lid_jid)`):
`session-manager.js:766`, `auth/postgres-auth-repository.js:193`.

**Gateway disk-sweep finding (directive §8).** `syncLidMappingsFromDisk` enumerated *all* directories under `sessionsDir` and then called `persistLidMappingToDb(sessionId || dirSessionId, …)`. So a mapping file found in tenant B's directory was written into **tenant A's** `lid_mappings` rows and applied to tenant A's in-memory store. This is both a cross-tenant write and a cross-tenant read. The sweep is now gated by the tenant scope; per-directory attribution and the FK-safe `sessionId || dirSessionId` write are preserved (a sibling directory is only scanned when it belongs to the same user).

---

## 5. G-3 — THE FIX (directive §5, §7)

### 5.1 Backend

**New:** `backend/app/services/whatsapp/repositories/lid_mappings.py`

```python
async def resolve_lid_phone(db, lid_jid, *, user_id, gateway_session_id=None) -> Optional[str]
async def resolve_lid_phones(db, lid_jids, *, user_id, gateway_session_id=None) -> Dict[str, str]
```

Resolution order implements the §5 protective model exactly:

```
WHERE lm.lid_jid = :lid
  AND ws.user_id IS NOT NULL
  AND CAST(ws.user_id AS TEXT) IN (:uid, :uid_hex)
ORDER BY (lm.session_id = :gw) DESC, lm.created_at DESC
LIMIT 1
```

1. **current session** — `(lm.session_id = :gw) DESC` puts the caller's own line first
2. **other sessions of the same user** — the `user_id` predicate
3. **another user → never** — there is no code path that omits the predicate

Design notes:

* **Fail-closed.** No `user_id` → no result. There is no fallback to a global scan.
* **`get_user_filter` is deliberately not used.** That helper additionally matches `column IS NULL` under pytest (`core/auth.py:229-231`), which would make all 1165 orphan rows readable by every tenant. A dedicated predicate is used instead, and a test pins this.
* **Orphan rows are excluded** by the `INNER JOIN` plus `ws.user_id IS NOT NULL` — matching §5 priority 3.
* **Dialect-aware table references.** The old hardcoded `whatsapp_private.lid_mappings` raised on SQLite and was swallowed by a broad `except`, so the entire LID branch was dead outside PostgreSQL. It now resolves correctly on both, which is also what makes the new tests real rather than mocked.
* **Ordering moved before the lookup.** In `_ingest_contact_synced` the owner was resolved *after* the LID read; it now resolves first so the read can be scoped. `resolve_event_owner` is fail-closed and was already called unconditionally on that path, so only its position changed.

**Changed call sites:** `events.py` (2 readers + `_upsert_contact` gained an optional `gateway_session_id`), `whatsapp_service.py` (batch reader + import + the now-unused `text` import removed).

### 5.2 Gateway

New exported pure helper `lidScopeSessionIds(sessionId, ownerId, sessions)` returns the allow-list of gateway sessions permitted to answer a lookup — always the caller's own line, plus same-owner lines, never another user's. An unowned session collapses to its own line only.

* `loadLidMappingsFromDb` — the `DISTINCT ON` and `(session_id = $1) DESC` ordering are **preserved verbatim**; only `WHERE session_id = ANY($2::text[])` was added.
* `syncLidMappingsFromDisk` — the directory sweep is gated by the same scope.
* Owner resolution reads `SELECT gateway_id, user_id FROM public.whatsapp_sessions`.

This is deliberately **not** aggressive isolation: same-user multi-line resolution keeps working (directive §8), which is the behaviour that would otherwise regress.

---

## 6. G-3 — REGRESSION TESTS (directive §8)

### Backend — `backend/tests/test_whatsapp_forensic_phase4_g3.py` (13 tests)

| Test | What it pins |
|---|---|
| **Test A** — same LID, two tenants, *different* phones | each tenant resolves its own phone; they do not collapse |
| **Test A (reader path)** — `_upsert_contact` | two distinct contacts, two distinct phones |
| **Test B** — mapping learned on the user's *other* line | still resolves (anti-over-isolation) |
| **Test B** — own line wins over sibling | `(session_id = :gw) DESC` priority |
| **Test C** — mapping exists **only** for tenant B | **tenant A gets `None`** — the critical security test |
| **Test C (reader path)** — `_upsert_contact` | A's contact is not keyed by B's phone; keeps the `jid:<lid>` placeholder |
| **Test C (batch)** — `resolve_lid_phones` | A's batch contains only A's rows |
| orphan-session mapping | readable by **nobody** |
| no `user_id` | fail-closed (`None` / `{}`) |
| unknown LID | `None` |
| source guard | the three removed global SQL strings cannot return |
| source guard | the tenant boundary never imports or calls `get_user_filter` |
| source guard | both scoped entry points are actually used by the readers |

Test A deliberately maps the **same LID to different phones** in the two tenants, so a leak cannot hide behind values that happen to agree (unlike today's production data). The source guards scan comment-stripped code via `tokenize`, so the explanatory comments that quote the removed SQL do not create false positives.

### Gateway — `whatsapp-gateway/scripts/test-g3-lid-tenant-scope.mjs` (13 assertions)

Test A (scope excludes the other tenant; different phones stay isolated), Test B (sibling line resolves; own line wins), **Test C (a mapping existing only for B is invisible to A)**, plus fail-closed edges (orphan line → own session only; unknown owner → own session only; no session id → empty scope) and source guards (the read is bounded by the allow-list, the ordering is preserved, the sweep is gated, the owner route is `public.whatsapp_sessions.gateway_id`).

---

## 7. LIVE DEVICE E2E (directive §15)

**A paired device exists.** Production session `68` is `CONNECTED`, `is_active`, `is_phone_online = true`, with a phone number, last updated `2026-09-19 00:53`. The backend bridge reports `connected: true` with `last_event_at` ≈ the time of this audit.

**Live traffic is observable and recent** (read-only, aggregate):

| Signal | Value |
|---|---|
| Newest message | `2026-09-19 08:35:04` (OUTBOUND) |
| Newest conversation activity | `2026-09-19 08:33:58` (INBOUND) |
| Newest LID learned | `2026-09-19 08:33:58` |
| Inbound | 963 `RECEIVED` |
| Outbound | 830 `SENT`, 23 `READ`, 2 `FAILED` |

So inbound, outbound, ACK, read receipts and LID learning are all demonstrably functioning on live traffic within the hour preceding this audit.

**However — `LIVE DEVICE E2E = NOT RUN (controlled).`**

Running the §15 matrix (pair / initial sync / saved contact / unsaved contact / external inbound / outbound / ACK / read / older history / reconnect / identity / ordering) as a *controlled* test requires sending real messages to real third parties. That is a production data mutation **and** it contacts people outside this system. Directive §18 forbids production mutation without explicit evidence, and §18 forbids a fake E2E. So the controlled matrix was not executed.

Two clearly separated rows, as required:

* `LIVE TRAFFIC OBSERVED = PASS (observational, read-only)` — the flows above are visibly working on real data.
* `LIVE DEVICE E2E = NOT RUN (controlled)` — no scripted round-trip was performed.

If a controlled run is wanted, it needs an explicit decision on a test recipient and an authorisation to send.

---

## 8. UNCHANGED / DELIBERATELY NOT TOUCHED

| Item | State |
|---|---|
| **F-5 New Chat** (directive §10) | **untouched** — `whatsappRepository.ts:293` still an unconditional `throw`. Stays `OPEN — PRODUCT DECISION`. No fake success introduced. |
| `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED` | `false`, unchanged (§13) |
| Baileys architecture, session lifecycle, ACK model, history provider protocol | unchanged (§18) |
| LID writers (`session-manager.js:766`, `postgres-auth-repository.js:193`) | unchanged — already `(session_id, lid_jid)` scoped |
| `sync.py:830` reader | unchanged — already session-scoped |
| Production push-name rows (885) | **not remediated** (§11 — report first) |
| Production `FULLY_EXHAUSTED` rows (10) | **not remediated** (§13b — report first) |
| Production C-4 duplicates | **not deleted** (§2 — there were none) |

---

## 9. RELEASE DECISION (directive §17)

| Criterion | Status |
|---|---|
| C-4 production duplicate scan = 0 | ✅ **0** |
| C-4 production unique partial index **verified** | ❌ **ABSENT** — migration never applied in production |
| G-3 cross-tenant leakage closed (code) | ✅ closed in working tree, **not deployed** |
| Backend tests pass | ✅ 1036 passed |
| Gateway pass | ✅ 18 / 18 |
| Frontend build pass | ✅ tsc 0, build success, logic 29/29 |
| Paired-device E2E pass | ❌ **NOT RUN** (controlled) |

`RELEASE BLOCKED` is defined as *production C-4 duplicates > 0* **or** *G-3 cross-tenant leakage not fixed*. Neither holds — duplicates are 0 and the leakage is fixed in code.

`RELEASE READY` requires the production index verified **and** a passing paired-device E2E. Neither holds.

### → **VERDICT: `RELEASE CANDIDATE`**

…with two explicit, non-negotiable blockers before any `RELEASE READY` claim:

1. **PRODUCTION DEPLOY IS STALE.** `f6ec68d` ≠ `f4db4dd`. Neither the C-4 migration nor the G-3 fix is live. The C-4 index is absent from production. The G-3 cross-tenant read path is **still open on the running system** — the fix exists only in the working tree.
2. **CONTROLLED LIVE E2E NOT RUN.** Needs a test recipient and explicit authorisation to send.

### Remaining work

| # | Item | Class | Blocking? |
|---|---|---|---|
| 1 | Commit Phase 3 + Phase 4 work and deploy to `/opt/tezlify` | PRODUCTION DEPLOY | **yes** |
| 2 | Apply/verify the C-4 migration in production (`uq_msg_conv_wa_message_id`) | PRODUCTION DEPLOY | **yes** |
| 3 | Confirm G-3 readers are tenant-scoped on the running system | PRODUCTION DEPLOY | **yes** |
| 4 | Controlled paired-device E2E (needs a test recipient + authorisation) | LIVE E2E | **yes** for READY |
| 5 | F-5 New Chat — product decision | PRODUCT | no (stays OPEN) |
| 6 | Background-sweep `FULLY_EXHAUSTED` promotion — fix before enabling the flag | CORRECTNESS | no (flag off) |
| 7 | 10 pre-existing `FULLY_EXHAUSTED` rows — decide whether to reset | DATA | no |
| 8 | 2 `FAILED` outbound IMAGE sends (2026-09-18) — investigate | CORRECTNESS | no |
| 9 | 2 LID-keyed contacts with empty `display_name` — expected unresolved state | DATA | no |

---

## 10. REPRODUCTION

```bash
# ---- LOCAL TEST ----
rm -rf "$TMPDIR"pytest-of-root "$TMPDIR"pytest-of-unknown   # sandbox mkdir wrapper ignores exist_ok
venv/bin/python -m pytest backend/tests -q                  # 1036 passed

for f in whatsapp-gateway/scripts/test-*.mjs; do node "$f" || exit 1; done   # 18/18

cd frontend && npx tsc --noEmit && npm run build
node frontend/scripts/verify-whatsapp-logic.mjs             # 29 checks PASS
cd .. && git diff --check

# ---- PRODUCTION READ-ONLY ----
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 \
  "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' \
     tezlify-db psql -U tezlify -d tezlify -P pager=off" < scratch/phase4_prod_readonly.sql

# ---- PRODUCTION DEPLOY ----
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 "cd /opt/tezlify && git rev-parse --short HEAD"
```

**Discipline honoured:** no false success; no production data mutation; no fake E2E. `LOCAL TEST`, `PRODUCTION READ-ONLY`, `PRODUCTION DEPLOY` and `LIVE DEVICE E2E` are reported as four separate evidence classes throughout.
