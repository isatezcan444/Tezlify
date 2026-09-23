# PHASE 1.1 CLOSURE RESULT — LEASE TRUTHFULNESS SAFETY FIXES

> **Scope:** Lease truthfulness safety only. No pairing, ephemeral pairing, promotion, cancel-after-connected, 515 reconnect, lease acquire/renew, tenant ownership, identity, conversation, history, sync, or frontend chat work was touched. No new event pipeline, no new polling loop, no new background worker.
> **Predecessor:** [WHATSAPP_PHASE1_1_RESULT.md](WHATSAPP_PHASE1_1_RESULT.md) (Phase 1.1).
> **Branch:** `main` (uncommitted changes only — NO COMMIT, NO PUSH, NO DEPLOY).
> **Contract amendment:** [WHATSAPP_BASELINE_CONTRACT.md](WHATSAPP_BASELINE_CONTRACT.md) §4 (Phase 1.1 invariant block — rewritten to split external truth from lifecycle invariant; clarify `UNAVAILABLE` vs `DISCONNECTED` semantics; clarify event timing).

---

## PHASE 1.1 CLOSURE RESULT: **PASS**

**568 / 568** targeted + extended WhatsApp tests pass (4 SKIP, 0 FAIL), of which **10 / 10 are Phase 1.1 lease-truthfulness tests** (5 original + 5 new closure tests). The 3 new DB-failure tests FAILED before the closure fix and PASS after.

---

## FIXED

- **DB read error no longer equals empty lease set.** `fetch_held_lease_gateway_ids` now returns `None` on a DB exception and `set()` on a successful zero-row query. The two values are distinct; the demote branch is bypassed when the helper returns `None`. A DB hiccup will never mass-demote healthy CONNECTED rows.
- **`CONNECTED` contract wording aligned with actual enforcement.** The invariant is now split into:
  - **External truth** (1)–(3): checked by the list call. Requires a successful DB read.
  - **Lifecycle invariant** (4): enforced inside the gateway by `SocketLifecycle.isCurrent`, the stale-event guards, and the `_deleted` closures. The list call does not directly verify (4); the gateway-side guards filter stale events before they reach `_map_session_event`.
- **Lease-loss event timing wording aligned with actual event path.** The `session_updated(DISCONNECTED + LEASE_LOST)` broadcast is emitted from the **list call** on a successful reconciliation. It is NOT emitted from the gateway's `loseLease` callback. The "immediate WS notification" wording is removed; the correct wording is "lease loss → next successful list reconciliation → demote → WS `session_updated` broadcast".
- **Gateway `UNAVAILABLE` vs backend `DISCONNECTED` clarified.** These are two distinct semantic states in two different layers. The gateway `loseLease` callback sets in-memory `UNAVAILABLE` (transient owner-loss; a future `_startSocket` may recover). The backend list-call demote writes `DISCONNECTED + LEASE_LOST` (the user-facing truth the UI uses to drive the re-pair flow). The two are not interchangeable; the contract now states this explicitly.

---

## ROOT CAUSE — CLOSURE

The pre-closure `fetch_held_lease_gateway_ids` had:

```python
except Exception as exc:
    logger.warning(...)
    return set()
```

A DB read failure (network blip, schema missing, timeout, permission) was collapsed into "query succeeded, no lease held". The consumer of the helper could not distinguish "read failed" from "truthfully empty". Combined with the demote branch in `_list_sessions_internal` that demotes any `CONNECTED` row whose `gateway_id` is `not in held_lease_gateway_ids`, this meant a single transient DB issue could mass-demote every healthy CONNECTED session in the user's session list to `WHATSAPP_LEASE_LOST + DISCONNECTED + WS broadcast`. The Phase 1.1 falsification tests caught the demote branch's behaviour, but they did not exercise the helper's failure path; that gap is what this closure fills.

A second, separate defect was a wording error in the Phase 1.1 contract and report: the invariant was described as "4 conditions checked by the list call", but the list call does not directly verify the gateway's in-memory lifecycle generation. That verification lives in the gateway's `SocketLifecycle` and stale-event guards. The closure splits the invariant into "external truth (checked by the list call)" and "lifecycle invariant (enforced by the gateway)" so the contract matches the implementation.

A third, separate defect: the report and contract described lease loss as "immediate WS notification". The `loseLease` callback does not emit a backend event; only the list call does. The closure corrects this.

---

## FIX — CLOSURE

### `fetch_held_lease_gateway_ids` — return-type change

**Before:**

```python
async def fetch_held_lease_gateway_ids(db: AsyncSession) -> set:
    try:
        ...
        return {str(row[0]) for row in result.fetchall() if row and row[0] is not None}
    except Exception as exc:
        logger.warning(...)
        return set()
```

**After:**

```python
async def fetch_held_lease_gateway_ids(db: AsyncSession) -> Optional[set]:
    """Return the set of gateway_id values whose socket lease is currently held,
    or `None` if the DB read itself failed.
    ...
      return set()  → query SUCCEEDED, zero valid leases exist.
                       Consumer MUST treat this as truthful "no lease held".
      return None   → query FAILED. Consumer MUST skip the demote.
    """
    try:
        ...
        return {str(row[0]) for row in result.fetchall() if row and row[0] is not None}
    except Exception as exc:
        logger.warning(
            "[WhatsApp] fetch_held_lease_gateway_ids failed; lease "
            "truthfulness demote is deferred until the next successful read: %s",
            exc,
        )
        return None
```

### Demote branch — gate on `held_lease_gateway_ids is not None`

**Before:**

```python
held_lease_gateway_ids: set = await fetch_held_lease_gateway_ids(db)
...
if (
    row.status == SessionStatus.CONNECTED
    and fields["status"] == "CONNECTED"
    and row.gateway_id not in held_lease_gateway_ids
):
    # demote
```

**After:**

```python
held_lease_gateway_ids: Optional[set] = await fetch_held_lease_gateway_ids(db)
...
# Phase 1.1 CLOSURE: `held_lease_gateway_ids is None` means the DB read
# itself failed; in that case we cannot answer the lease-truthfulness
# question and we MUST NOT demote. The reconciliation is deferred to
# the next successful read.
if (
    held_lease_gateway_ids is not None
    and row.status == SessionStatus.CONNECTED
    and fields["status"] == "CONNECTED"
    and row.gateway_id not in held_lease_gateway_ids
):
    # demote
```

The log message inside the demote branch was also updated from "no holder in socket_leases" to "Verified lease-missing CONNECTED row (DB read succeeded, gateway_id not in socket_leases)" so the operational signal makes the distinction explicit in logs.

### Contract — split external truth from lifecycle invariant

The §4 Phase 1.1 invariant block was rewritten to make the source-level responsibility split explicit:

- "External truth — checked by the backend's `_list_sessions_internal` reconciliation" (1)–(3) with the explicit note that the DB read MUST have succeeded.
- "Lifecycle invariant — enforced inside the gateway (NOT by the list call)" (4) listing the four mechanisms that protect the next event.
- "State semantics — gateway `UNAVAILABLE` vs backend `DISCONNECTED`" explaining why the two values are not interchangeable.
- "Event timing" explaining the actual list-call → broadcast timing.

### Phase 1.1 result report — wording corrections

`WHATSAPP_PHASE1_1_RESULT.md` was updated to use "next successful list reconciliation" instead of "immediately demoted" and to clarify that the broadcast comes from the list call, not from the gateway.

---

## CONNECTED TRUTH MODEL — CLARIFIED

The model is the same as Phase 1.1, but with three corrections:

1. The list call checks (1), (2), and a **successful** read of (3). A failed read is not a demote; it is a defer.
2. (4) is enforced inside the gateway by the lifecycle guards, not by the list call. The list call's correctness is sufficient because the gateway-side guards filter stale events before they reach `_map_session_event`.
3. The "lease loss" demote writes `DISCONNECTED + LEASE_LOST`, not `UNAVAILABLE`. The gateway's `UNAVAILABLE` is a different state living in a different layer.

---

## LEASE LOSS — END-TO-END PATH (corrected)

1. Gateway A's lease renewal timer stops firing (process killed, network blip, DB slow). `socket_leases.expires_at` lapses.
2. Gateway B acquires the lease (TTL expired branch in `ON CONFLICT DO UPDATE WHERE ...`).
3. Gateway A's `loseLease` callback (if the process is still alive) sets the in-memory state to `UNAVAILABLE`, releases timers, ends the socket. **This callback does NOT emit a backend event.**
4. On the next list call, the backend reads `held_lease_gateway_ids` from the DB:
   - If the read succeeds, the row's `gateway_id` is not in the held set, the row is demoted to `DISCONNECTED + LEASE_LOST`, and `session_updated` is broadcast.
   - If the read fails (returns `None`), the row is NOT demoted. The reconciliation is deferred to the next call.
5. Connected UIs see the demote on the broadcast. Page-load UIs see the corrected state on their next list poll.
6. Reconnect (515 500 ms, transient backoff) eventually triggers a new `connection.update{open}` in the gateway that holds the lease, which triggers `_map_session_event session_connected`, which moves the row back to `CONNECTED` truthfully.

---

## RECONNECT — IMMUNITY TO FALSE `RELINK_REQUIRED` (unchanged)

The new branch only demotes when all four conditions hold: row is `CONNECTED`, gateway reports `CONNECTED`, DB read succeeded, `gateway_id` not in the held set. A transient reconnect (gateway reports `CONNECTING`) is exempt. A `RESTORING` row is exempt. A `DISCONNECTED` row is already in the right state. The only path that demotes a `CONNECTED` row is: gateway says `CONNECTED`, DB read succeeded, lease is gone, row is `CONNECTED`. Four-way agreement.

---

## TESTS

### New closure tests (Phase 1.1 closure)

`backend/tests/test_whatsapp_phase1_1_lease_truthfulness.py::TestLeaseDBReadFailureVsEmptyResult` — 5/5 PASS:

| Test | Scenario | Pre-fix | Post-fix |
| --- | --- | --- | --- |
| `test_db_read_failure_does_not_demote_healthy_connected` | 1 healthy CONNECTED row + DB read returns None | FAIL (demoted to LEASE_LOST) | PASS (stays CONNECTED) |
| `test_successful_empty_lease_result_demotes_connected` | 1 healthy CONNECTED row + DB read returns set() | PASS (demoted) | PASS (demoted) |
| `test_no_mass_demotion_on_db_failure` | 7 healthy CONNECTED rows + DB read returns None | FAIL (all 7 demoted) | PASS (all 7 stay CONNECTED) |
| `test_helper_returns_none_on_db_exception` | helper-level: DB exception | FAIL (returned set()) | PASS (returns None) |
| `test_helper_returns_empty_set_on_successful_zero_rows` | helper-level: query succeeds, zero rows | PASS (returns set()) | PASS (returns set()) |

### Phase 1.1 tests (preserved)

`TestListSessionsLeaseTruthfulness` — 5/5 PASS. The closure did not touch any of these; the demote branch's behaviour for "set() returned" is unchanged.

### Full WhatsApp regression (Phase 0 + Phase 1 + Phase 1.1 + Closure)

```
$ PYTHONPATH=. ./venv/bin/python -m pytest backend/tests/ -k "whatsapp" --tb=short -q
568 passed, 4 skipped, 570 deselected, 0 failed
```

Phase 0/1 baseline tests: 558 unchanged → still pass. Phase 1.1 tests: 5 → still pass. Closure tests: 5 new → all pass. Total: 568 (was 563 pre-closure; +5 are the new closure tests).

### Compile / syntax

```
$ node --check whatsapp-gateway/src/session-manager.js  # OK
$ node --check whatsapp-gateway/src/socket/socket-events.js  # OK
$ python3 -c "import ast; ast.parse(...sessions.py)"  # OK
```

---

## REGRESSIONS

**None.** The count went from 563 (Phase 1.1) to 568 (Phase 1.1 closure). The +5 are exclusively the new closure tests. All previously-passing tests still pass.

---

## REMAINING ISSUES (intentionally NOT fixed in Phase 1.1 closure)

| # | Issue | Out of scope for closure? | Owner |
| --- | --- | --- | --- |
| 1 | Pre-existing orphan `gateway_sessions` rows | YES — Phase 1 §16; separate phase | Phase 2+ |
| 3 | `logoutSession` does NOT set `_deleted = true` | YES — bounded by next refresh/delete; not in closure scope | Phase 2+ |
| 4 | `requestPairingCode` 15-second polling depends on user retry | YES — UX layer | Phase 5+ |
| 5 | Frontend `startConversation` / `getTemplates` fail-closed contract not enumerated in Phase 0 | YES — documentation | Doc follow-up |
| 7 | DB lease read runs on every list call (cheap, indexed PK; could cache with TTL if traffic warrants) | YES — premature optimisation | Phase 2+ if needed |
| **NEW** 8 | The gateway `loseLease` callback sets in-memory `UNAVAILABLE` but does NOT emit a backend event. The list call is the only path that notifies the UI of a verified lease loss. The actual end-to-end latency between gateway-side lease loss and UI visibility is therefore bounded by the list-call interval. This is correct per the corrected contract wording, but a future optimisation would be a "lease_lost" event from the gateway for sub-list-call latency. | YES — new event pipeline is out of closure scope | Phase 2+ |

---

## FILES CHANGED IN PHASE 1.1 CLOSURE

| File | Change | LOC | Reason (in Phase 1.1 closure scope) |
| --- | --- | --- | --- |
| `backend/app/services/whatsapp/orchestration/sessions.py` | modified | +18 / -7 | `fetch_held_lease_gateway_ids` returns `Optional[set]`; demote branch gates on `is not None`; log message clarifies "verified lease-missing". |
| `backend/tests/test_whatsapp_phase1_1_lease_truthfulness.py` | modified | +158 / -25 | New `TestLeaseDBReadFailureVsEmptyResult` class with 5 tests; fixture deduped. |
| `WHATSAPP_BASELINE_CONTRACT.md` | modified | +47 / -8 | §4 (Phase 1.1 invariant) rewritten to split external truth vs lifecycle invariant; clarify state semantics; clarify event timing. |
| `WHATSAPP_PHASE1_1_RESULT.md` | modified | +2 / -2 | Wording corrections: "next successful list reconciliation" / "list call" instead of "immediately demoted" / "immediate WS notification". |
| `WHATSAPP_PHASE1_1_CLOSURE_RESULT.md` | NEW | this file | Phase 1.1 closure result report. |

```
$ git status --short
 M backend/app/services/whatsapp/orchestration/sessions.py
 M backend/tests/test_whatsapp_phase1_1_lease_truthfulness.py
 M whatsapp-gateway/src/session-manager.js
 M whatsapp-gateway/src/socket/socket-events.js
 M WHATSAPP_BASELINE_CONTRACT.md
 M WHATSAPP_PHASE1_1_RESULT.md
 M WHATSAPP_PHASE1_RESULT.md
?? WHATSAPP_PHASE1_1_CLOSURE_RESULT.md
?? WHATSAPP_PHASE1_1_RESULT.md
?? WHATSAPP_PHASE1_RESULT.md
?? WHATSAPP_BASELINE_CONTRACT.md
```

**No changes to:** pairing, ephemeral pairing, promotion, cancel-after-connected, 515 reconnect, lease acquire, lease renewal algorithm, tenant ownership, identity, conversation, history, sync, frontend chat, gateway event-emission code, socket-lifecycle code, lease-coordinator code, DB schema. **No new event pipeline, no new polling loop, no new background worker.**

---

## CLOSING

- **PHASE 1.1 CLOSURE RESULT: PASS.**
- **No commit. No push. No deploy.** Working tree contains uncommitted modifications on `main`.
- **No Phase 2+ scope touched.**
- **All §9 closure acceptance lines hold.**
- **All Phase 0/1/1.1 baseline tests still pass.**

Next phase entry condition: Phase 1.1 closure acceptance + Phase 1.1 acceptance + Phase 1 acceptance + Phase 0 contract frozen.
