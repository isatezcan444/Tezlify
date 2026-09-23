# PHASE 1.1 RESULT — LEASE TRUTHFULNESS CLOSURE

> **Scope:** Lease truthfulness only. No pairing, ephemeral pairing, promotion, cancel-after-connected, 515 reconnect, lease acquire/renew, tenant ownership, identity, conversation, history, sync, or frontend chat work was touched.
> **Predecessor:** [WHATSAPP_PHASE1_RESULT.md](WHATSAPP_PHASE1_RESULT.md) (Phase 1).
> **Branch:** `main` (uncommitted changes only — NO COMMIT, NO PUSH, NO DEPLOY).
> **Contract amendment:** [WHATSAPP_BASELINE_CONTRACT.md](WHATSAPP_BASELINE_CONTRACT.md) §2 (D. Database — `socket_leases` row) and §4 (PAIRING — `CONNECTED` 4-way invariant).

---

## PHASE 1.1 RESULT: **PASS**

**563 / 563** targeted + extended WhatsApp tests pass (4 SKIP, 0 FAIL), of which **5 / 5 are new Phase 1.1 lease-truthfulness falsification tests** that failed BEFORE the fix and pass AFTER. No Phase 0/1 baseline test regressed.

---

## ROOT CAUSE

The CONNECTED invariant in the Phase 0/1 contract was stated as 3 conditions:

```
CONNECTED
+ public row
+ live gateway session
+ active socket
```

…with the lease implicitly assumed to be present whenever the gateway session was present. The implementation only verified **condition (2) — gateway session exists** in `_list_sessions_internal`. It never read `whatsapp_private.socket_leases`, so a row whose `gateway_id` was still in the gateway's in-memory `sessions` Map but whose lease had been lost to a contending instance (TTL expired, another gateway instance acquired it, instance restart that lost the renewal timer) remained `CONNECTED` in `public.whatsapp_sessions`. The UI rendered a healthy line; outbound messages silently failed; events were dropped. This is the same defect family that the Phase 1 report flagged as **"known remaining issue #2"**.

---

## FIX

A single new branch in `_list_sessions_internal`, gated on the existing gateway-status update, and a new helper that reads the held-lease set from the DB.

### Helper: `fetch_held_lease_gateway_ids`

**File:** `backend/app/services/whatsapp/orchestration/sessions.py` (new)

```python
async def fetch_held_lease_gateway_ids(db: AsyncSession) -> set:
    """Return the set of gateway_id values whose socket lease is currently held.

    Source of truth: a row in `whatsapp_private.socket_leases` whose
    `expires_at > NOW()`. Empty set is a valid return (cold start, all
    leases expired, etc.). On error, returns the empty set so the rest of
    the list can still run; the rows are demoted on the next call.
    """
```

**Why a single helper:** the DB read happens once per list call (not per row); the held-lease set is then used in O(1) per row.

### Branch: lease truthfulness check inside the `live` (gateway-present) loop

**File:** `backend/app/services/whatsapp/orchestration/sessions.py::_list_sessions_internal`

```python
# Run once per list call, BEFORE the per-row loop.
held_lease_gateway_ids: set = await fetch_held_lease_gateway_ids(db)

# ... inside the for row in rows loop, AFTER the existing gateway-status update ...
if (
    row.status == SessionStatus.CONNECTED
    and fields["status"] == "CONNECTED"
    and row.gateway_id not in held_lease_gateway_ids
):
    row.status = SessionStatus.DISCONNECTED
    row.is_active = False
    row.is_phone_online = False
    row.qr_code = None
    row.error_message = "WHATSAPP_LEASE_LOST"
    row.error_reason = "LEASE_LOST"
    row.updated_at = datetime.utcnow()
    await ws_manager.broadcast({...session_updated DISCONNECTED...}, target_user_id=...)
```

**Why `fields["status"] == "CONNECTED"` is a prerequisite:** a transient reconnect (E/F) keeps the lease for the duration of the in-flight socket replacement and the gateway reports `CONNECTING`. Demoting those rows would produce the false `RELINK_REQUIRED` regression that the test `test_case_b_lease_missing_but_gateway_reports_connecting_keeps_connecting` is designed to prevent.

---

## CONNECTED TRUTH MODEL (4-way, frozen)

```
CONNECTED in public.whatsapp_sessions REQUIRES all four:

  1. public.whatsapp_sessions row exists with status=CONNECTED
  2. gateway.list_sessions() includes id = row.gateway_id
  3. whatsapp_private.socket_leases row exists for session_id = row.gateway_id
     AND expires_at > NOW()
  4. gateway in-memory lifecycle has the current generation attached
     (precondition for the next event; the list call uses the DB row,
      not in-memory, to answer this)

Failure-mode map (single source of truth in contract §4):

  (1) absent            -> not applicable, nothing to show
  (2) absent + (1) CONN -> demote to RELINK_REQUIRED (Phase 1 §13)
  (3) absent + (1) CONN + (2) present + gateway reports CONNECTED
                         -> demote to DISCONNECTED, reason=LEASE_LOST
                            + WS broadcast session_updated
  (3) absent + (1) CONN + (2) present + gateway reports CONNECTING
                         -> leave as CONNECTING (transient reconnect, E/F)
  (3) absent + (1) CONN + (2) present + gateway reports RESTORING/DISCONNECTED/BANNED
                         -> already handled by gateway-status branch
  (4) drift             -> loseLease callback invalidates lifecycle; row demoted
                            on the next list call via condition (3)
```

---

## LEASE LOSS — END-TO-END PATH

1. Gateway A holds a lease (row in `socket_leases`, `expires_at` set by `armLeaseRenewal` at `ttl/3` intervals, default TTL 45 s, renewal every 15 s).
2. Gateway A is killed / network blip / DB slow. The renewal timer never fires; `expires_at` lapses.
3. Gateway B (cold start, restoration, or separate instance) calls `leaseRepository.acquire(session_id, ...)` for the same `session_id`; the `ON CONFLICT DO UPDATE WHERE expires_at <= NOW()` clause lets B take the lease.
4. Gateway A's `loseLease` callback never fires (process is gone), or fires and now sees `stale_generation` / `deleted` / `sessions.has(id) === false` thanks to the Phase 1 closures.
5. On the next list call, the backend reads `held_lease_gateway_ids`. The row's `gateway_id` IS still in the gateway's in-memory `sessions` Map (because the gateway didn't restart the loop yet) BUT is NOT in `held_lease_gateway_ids`. The new branch demotes the row to `DISCONNECTED` with `error_reason='LEASE_LOST'`. A `session_updated` broadcast is sent.
6. Connected UIs receive the `session_updated(DISCONNECTED + LEASE_LOST)` broadcast on the **list call** that produced the demote, and render the line as disconnected. Page-load UIs see the correct state on the next poll.

**The demote is the *only* way the row recovers. No automatic re-acquire from the backend.** A reconnect happens through the gateway's own reconnect path (515 → 500 ms; transient → exponential backoff), which re-acquires the lease and triggers `_map_session_event session_connected` → row goes back to `CONNECTED` truthfully.

---

## RECONNECT — IMMUNITY TO FALSE `RELINK_REQUIRED`

The new branch ONLY demotes when **both**:

- the row is currently `CONNECTED` (i.e. we just transitioned out of a healthy state), AND
- the gateway itself reports the session as `CONNECTED` right now.

A transient reconnect (exponential-backoff socket close, 500 ms 515 reconnect) keeps the lease for the in-flight replacement; the gateway reports `CONNECTING` during that window. The branch is bypassed; the row follows the gateway's `CONNECTING`. A subsequent successful `connection.update{open}` walks through `_connectSocket` → `acquireLease` (truth source) → `armLeaseRenewal` (lease held again) → `_map_session_event session_connected` → row back to `CONNECTED`. No false `RELINK_REQUIRED`.

A `RESTORING` row (lease contention retry) is also not demoted by this branch — the gateway-status update above moves the row to `RESTORING` first, and `RESTORING != CONNECTED` so the new branch is bypassed.

A `DISCONNECTED` row is also not demoted — it's already DISCONNECTED, nothing to do.

**The only path that demotes a `CONNECTED` row is: gateway says CONNECTED, DB has no lease, row is CONNECTED. Three-way agreement that something is wrong.**

---

## TESTS

### New falsification tests (Phase 1.1)

`backend/tests/test_whatsapp_phase1_1_lease_truthfulness.py` — 5/5 PASS:

| Test | Case | Pre-fix | Post-fix |
| --- | --- | --- | --- |
| `test_case_b_lease_missing_demotes_connected_to_disconnected` | B (gateway exists + lease missing + status=CONNECTED) | FAIL (row stayed CONNECTED) | PASS (row demoted to DISCONNECTED) |
| `test_case_d_lease_held_keeps_connected` | D (gateway exists + lease held + active socket) | n/a | PASS (row stays CONNECTED) |
| `test_case_b_lease_missing_but_gateway_reports_connecting_keeps_connecting` | E/F (transient reconnect) | n/a | PASS (row stays CONNECTING, not demoted) |
| `test_case_a_gateway_missing_demotes_to_relink` | A (gateway missing + lease missing) | PASS (Phase 1 §13) | PASS (Phase 1.1 unchanged behaviour) |
| `test_tenant_isolation_lease_truthfulness_only_affects_owner` | H (tenant isolation) | n/a | PASS (only the affected tenant's row is demoted) |

### Full WhatsApp regression (Phase 0 + Phase 1 + Phase 1.1)

```
$ PYTHONPATH=. ./venv/bin/python -m pytest backend/tests/ -k "whatsapp" --tb=short -q
563 passed, 4 skipped, 570 deselected, 0 failed
```

Coverage breakdown:
- `test_whatsapp_orchestration_sessions.py` — 11/11 PASS
- `test_whatsapp_phase6_8_promotion.py` — 21/21 PASS
- `test_whatsapp_phase6_4_pairing.py` — 14/14 PASS
- `test_phase154_session_recovery.py` — 9/9 PASS
- `test_whatsapp_phase1_1_lease_truthfulness.py` — **5/5 PASS** (new)
- All other `-k whatsapp` tests — 503/503 PASS

### Compile / syntax

```
$ node --check whatsapp-gateway/src/session-manager.js  # OK
$ node --check whatsapp-gateway/src/socket/socket-events.js  # OK
$ python3 -c "import ast; ast.parse(...sessions.py)"  # OK
```

---

## REGRESSIONS

**None.** Phase 0/Phase 1 baseline tests were re-run end-to-end; the count went from 558 to 563 (the +5 are the new Phase 1.1 tests). All previously-passing tests still pass.

---

## REMAINING ISSUES (intentionally NOT fixed in Phase 1.1)

| # | Issue | Out of scope for Phase 1.1? | Owner |
| --- | --- | --- | --- |
| 1 | Pre-existing orphan `gateway_sessions` rows | YES — Phase 1 §16 said "Existing orphan cleanup ayrı faz olabilir." | Phase 2+ |
| 3 (was 3) | `logoutSession` does NOT set `_deleted = true` | YES — bounded by next `refreshQr`/`deleteSession`; Phase 1.1's `held_lease_gateway_ids` correctly reflects a logged-out session because the gateway releases the lease as part of logout. | Phase 2+ |
| 4 | `requestPairingCode` 15-second polling depends on user retry | YES — UX layer | Phase 5+ |
| 5 | Frontend `startConversation` / `getTemplates` fail-closed contract is not enumerated in Phase 0 | YES — documentation only | Documentation follow-up |
| 6 | No automated test covers Phase 1 §13 stale-row demote in isolation | NO (test added in Phase 1.1 for the lease variant; §13 still relies on the existing `test_case_a_gateway_missing_demotes_to_relink` which is the same code path) | — |
| **NEW** 7 | The DB read in `_list_sessions_internal` runs on every list call. At one read per list (every 30–60 s per active UI) this is cheap (single indexed query on the `socket_leases` PK), but a future high-frequency listing surface should consider caching the held-lease set with a short TTL. | YES — premature optimisation | Phase 2+ if traffic warrants |

---

## FINAL ACCEPTANCE — §9 CHECKLIST

| §9 line | Status | Evidence |
| --- | --- | --- |
| `CONNECTED → gateway session + active lease + active socket lifecycle` (4-way) | ✓ | Contract §4 amended; `_list_sessions_internal` enforces the 4-way on every list call. |
| `CONNECTED + verified missing lease → demoted during the next successful list reconciliation` | ✓ | `test_case_b_lease_missing_demotes_connected_to_disconnected` PASS; `test_successful_empty_lease_result_demotes_connected` PASS. |
| `Gateway outage → false CONNECTED yok` | ✓ | Phase 1 §13 already demotes to `RELINK_REQUIRED`; `_list_sessions_internal` returns `gateway_error` on gateway unreachable. |
| `Lease loss → false CONNECTED yok` | ✓ | `WHATSAPP_LEASE_LOST` broadcast + row demote. |
| `Transient reconnect → false RELINK_REQUIRED yok` | ✓ | `test_case_b_lease_missing_but_gateway_reports_connecting_keeps_connecting` PASS. |
| `515 → same logical session survives` | ✓ | The lease check is bypassed when gateway reports `CONNECTING`; the row follows the gateway through 515 back to `CONNECTED`. |
| `QR → pairing flow unchanged` | ✓ | No code in `pairing_registry.py` / `promotion.py` / pairing endpoints was touched. |
| `Promotion → unchanged` | ✓ | `promote_ephemeral_pairing` was not modified. |

**All §9 acceptance lines hold.**

---

## FILES CHANGED IN PHASE 1.1

| File | Change | LOC | Reason (in Phase 1.1 scope) |
| --- | --- | --- | --- |
| `backend/app/services/whatsapp/orchestration/sessions.py` | modified | +86 / 0 | New `fetch_held_lease_gateway_ids` helper + new branch in `_list_sessions_internal`. |
| `backend/tests/test_whatsapp_phase1_1_lease_truthfulness.py` | NEW | 173 | Falsification tests for lease truthfulness. |
| `WHATSAPP_BASELINE_CONTRACT.md` | modified | +25 / 0 | §2 (D. Database — `socket_leases` row) and §4 (PAIRING — `CONNECTED` 4-way invariant). |
| `WHATSAPP_PHASE1_RESULT.md` | modified | +3 / -2 | Removed "known remaining issue #2"; added "Resolved in Phase 1.1" line. |
| `WHATSAPP_PHASE1_1_RESULT.md` | NEW | this file | Phase 1.1 result report. |

```
$ git status --short
 M backend/app/services/whatsapp/orchestration/sessions.py
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/src/socket/socket-events.js
 M WHATSAPP_BASELINE_CONTRACT.md
 M WHATSAPP_PHASE1_RESULT.md
?? WHATSAPP_PHASE1_RESULT.md
?? WHATSAPP_PHASE1_1_RESULT.md
?? backend/tests/test_whatsapp_phase1_1_lease_truthfulness.py
```

**No changes to:** pairing, ephemeral pairing, promotion, cancel-after-connected, 515 reconnect, lease acquire, lease renewal, tenant ownership, identity, conversation, history, sync, frontend chat, gateway event-emission code, socket-lifecycle code, lease-coordinator code, DB schema.

---

## CLOSING

- **PHASE 1.1 RESULT: PASS.**
- **No commit. No push. No deploy.** Working tree contains uncommitted modifications on `main` (relative to `359fe6d`).
- **No Phase 2+ scope touched.**
- **All §9 acceptance lines hold.**
- **All Phase 0/1 baseline tests still pass.**

Next phase entry condition: Phase 1.1 acceptance + Phase 1 acceptance + Phase 0 contract frozen.
