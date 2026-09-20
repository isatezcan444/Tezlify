# PHASE 6.8 — PAIRING PROMOTION RACE

**Status: LOCAL FIX COMPLETE AND VERIFIED. LIVE-DEVICE E2E = NOT RUN.**
No commit, no push, no deploy, no production write was performed.
Finding 7 (the deferred terminal-status follow-up) is now fixed as a separate, scoped
change taken after 6.8 was frozen — see §12 for its diff, falsification evidence and
final gate sweep.

---

## 0. What was already in the tree when this phase started

An earlier session in this workspace had left an **untracked, incomplete** attempt at
this fix (`ephemeral_pairing.py`, `pairing_registry.py`, `promotion.py`,
`test_whatsapp_phase6_8_promotion.py`, created 02:09–02:11). It was **not** taken at
face value. Reviewing it found four defects, two of which would have shipped broken:

| # | Defect found in the in-progress work | Consequence if shipped |
|---|---|---|
| 1 | `pairing_registry` **used at `sessions.py:285` but never imported** | `NameError`; the durable record was never written |
| 2 | `start_pairing_session` gained a `db` parameter that **no caller passed** | same — dead code |
| 3 | `consume_pairing` failure → `db.rollback()` → the ORM row is **expired** → the next bare attribute read raises `greenlet_spawn has not been called` → the exception escaped `promote_ephemeral_pairing` and `ingest_gateway_event` **dropped an event whose row had already been committed** | the fix would have reproduced the production symptom |
| 4 | Parallel edits had **silently clobbered** three of the four promotion paths (paths 1, 3b, 4 still had the original code) | the crash in (3) remained live in 3 of 4 paths |

All four are fixed and are now covered by regression tests (§4).

---

## 1. ROOT CAUSE — the exact cancellation / promotion race

There were **two independent defects on the same chain**. Either alone loses the pairing.

### 1a. Backend: `session_connected` could not CREATE a durable row

`_map_session_event` (`events.py:1185`) could only **update** an existing
`public.whatsapp_sessions` row or **relink** an existing `RELINK_REQUIRED` row. It had
no branch that **creates** one. For a first-time QR pairing the only row-creating code
path in the entire backend was `get_pairing_qr` → "Scenario A-new" (`sessions.py:413`)
— i.e. **promotion silently depended on the browser continuing to poll**
`GET /pairing/{token}/qr`.

`perform_atomic_relink` raises `RelinkCandidateNotFound` for a first-time pairing
(`relink.py`), which `events.py:1320` swallowed; the event then fell through to the
P6-9 ephemeral branch, which **routes the event and returns without writing anything**.

### 1b. Frontend: closing the QR UI destroyed the promoted socket

Production order, measured:

```
22:40:40.492  gateway  Baileys restartRequired (515)      <- real phone scanned
22:40:43.657  gateway  registerSession -> gateway_sessions  <- connection.open
22:40:43.723  backend  EventOwnerUnresolved (message_new)   <- no row, event dropped
22:40:45.455  backend  DELETE /sessions/<gw_id> -> 200      <- 43.657 + ~1.5 s
22:40:45.5xx  backend  POST /pairing/<token>/cancel -> 200
... 2 904 gateway events dropped in 60 s as "unknown gateway session"
```

The `+1.5 s` is the modal's own auto-close timer. `WhatsAppQrConnectModal` reaches
`CONNECTED` the moment the `session_connected` event arrives, sets
`setTimeout(onClose, 1500)`, and the close re-runs the lifecycle effect whose cleanup
called `cancelPairing(token)` **unconditionally**. The backend then ran
`gw.delete_session(gateway_id)` on a socket that had just been promoted.

The cancellation had **three** unguarded call sites, all on ordinary React lifecycle
events: the in-flight-create bail-out, the modal-close branch, and the effect cleanup
(whose dependency array `[isOpen, initSession, clearTimers, existingSessionId]` means
**any re-render during the promotion window** re-ran it).

**One-line root cause:** *the UI's view-state machine reached CONNECTED and closed,
while the pairing was still being promoted — and closing the UI cancelled the pairing.*

---

## 2. FAILED BEFORE — exact regression tests

`backend/tests/test_whatsapp_phase6_8_promotion.py` — 24 tests driving the **real call
path** (HTTP endpoints + `ingest_gateway_event` + the real DB). Nothing asserts on a
private helper.

Measured against a clean `HEAD` checkout (the pre-6.8 production code):

| | HEAD | with fix |
|---|---|---|
| Phase 6.8 suite | **15 failed, 9 passed** | **24 passed** |

The 15 that fail on HEAD include the two production symptoms verbatim:
* `test_session_connected_creates_durable_row_for_first_time_pairing`
* `test_inbound_event_accepted_for_promoted_session` (the 2 904 dropped events)
* `test_cancel_after_connection_open_does_not_delete_promoted_socket`

Frontend, same discipline — reverting only the modal to HEAD:

```
FAIL - PROMOTION: auto-close after session_connected must NOT cancel the pairing
       1 !== 0
FAIL - PROMOTION: a React effect re-run after the scan must NOT cancel the pairing
       1 !== 0
```

Both pass with the fix; the two "genuine cancel still happens" guards pass on **both**
revisions, so the fix did not simply disable cancellation.

---

## 3. FIX — exact files and mechanism

### Backend

| File | Mechanism |
|---|---|
| `orchestration/promotion.py` **(new)** | `promote_ephemeral_pairing()` — the single idempotent entry point that completes a promotion **from the event alone**. Owner is resolved **first** and the function fails closed before touching any row. Then: already-bound → update in place; `RELINK_REQUIRED` candidate → `perform_atomic_relink`; existing row for the phone → reuse (refusing to overwrite a live CONNECTED session under a different gateway); otherwise → **CREATE**. |
| `orchestration/pairing_registry.py` **(new)** | The durable side of `_ephemeral_pairings`: `record_pairing` / `resolve_open_pairing` / `consume_pairing`. Documented as **best-effort** — "a durability upgrade, never a new hard dependency". `_to_dict` refuses any object that is not a real `EphemeralPairing` row, so owner resolution stays fail-closed. |
| `models/ephemeral_pairing.py` **(new)** | `ephemeral_pairings` table: `pair_token` PK, unique `gateway_session_id`, `user_id`, `consumed_at`. Deliberately **not** in `whatsapp_sessions`, so the No-Create QR invariant is untouched. Created in production by the existing `Base.metadata.create_all` (`main.py:103`). |
| `orchestration/events.py` | `session_connected` for an unknown gateway id now calls `promote_ephemeral_pairing` **before** the relink/fail-closed chain. |
| `orchestration/sessions.py` | ① added the missing `pairing_registry` import; ② `start_pairing_session` writes the durable record; ③ `cancel_pairing_session` is now **promotion-aware and idempotent** (see §4). |
| `api/v1/endpoints/whatsapp.py` | `pairing/start` and `pairing/{token}/cancel` now inject and pass `db`, so the durable record is actually written. |
| `models/__init__.py` | registers `EphemeralPairing` so `create_all` builds the table. |

### Frontend — `WhatsAppQrConnectModal.tsx`

An **explicit pairing lifecycle**, not timing guesses:

```
IDLE → CREATING → SCAN_QR → PAIRING_IN_PROGRESS → PROMOTION_PENDING → CONNECTED
                                                    (CANCELLED / FAILED terminal)
```

* `CANCELLABLE_PAIRING_STATES = ['CREATING', 'SCAN_QR']` — the only states in which a
  UI lifecycle event may tear a pairing down. From `PAIRING_IN_PROGRESS` on, the
  gateway already has a socket that is becoming a session.
* `cancelPairingIfStillWaiting(token)` is the **single** cancellation entry point,
  replacing all three unguarded sites. It is idempotent (a `Set` of already-cancelled
  tokens) and never fires for a promoted / promoting pairing.
* The lifecycle is **monotonic**, so a late `session_qr_updated` cannot drag a pairing
  back into the cancel window.
* `handleCancel` respects the same rule: after the scan it closes the UI and lets the
  promotion finish rather than destroying it.

---

## 4. PROMOTION-AWARE, IDEMPOTENT CANCEL

`cancel_pairing_session` used to run `gw.delete_session()` unconditionally. It now asks
the **gateway's own status**:

* `CONNECTED` → the pairing already succeeded. **Finalise it** (idempotent promotion)
  and return **without deleting the socket**.
* anything else → a genuine cancel: terminate the ephemeral socket.

Idempotent: a second call finds neither an in-memory entry nor an unconsumed durable
record and does nothing. A pairing still waiting for a scan **is** still torn down —
otherwise abandoned ephemeral sessions would leak forever (regression-tested).

---

## 5. BEFORE / AFTER

| Dimension | BEFORE | AFTER |
|---|---|---|
| **Promotion** | Only reachable via browser polling `GET /pairing/{token}/qr`. `session_connected` could not create a row. | `session_connected` alone completes promotion (create **or** relink). Polling is a redundant second path. |
| **Owner resolution** | In-memory `_ephemeral_pairings` only — lost on restart, cancel, or a popped token. | In-memory → **durable `ephemeral_pairings`** → explicit owner. Owner resolved **before** any row is touched; no record ⇒ fail closed. |
| **CONNECTED row** | Never created for a real phone scan unless the browser kept polling. | Created/relinked by the event itself. `phone` from the payload, `self_jid` as the fallback; a `@lid` is never treated as a phone. |
| **Lease** | N/A on this chain — but the promotion branch is exactly where the persistent session takes its `socket_leases` row (G-LEASE, already fixed/deployed). | Unchanged by 6.8; the promoted session is now a real session, so the lease path has a row to attach to. |
| **Inbound** | 2 904 events dropped in 60 s as "unknown gateway session". | Accepted: the promoted gateway UUID resolves to its durable row. Covered by `test_inbound_event_accepted_for_promoted_session`. |
| **Outbound** | Could not target a session that had no row. | Unchanged code path; unblocked by the row existing. **Not re-measured live.** |
| **Chat (6.3–6.5)** | — | All suites re-run green (§6). No chat code was touched by this phase. |
| **Tenant isolation** | Fail-closed, but promotion was impossible, so the question was moot. | **Not weakened.** Unknown gateway session → fail closed with **no DB row query at all**. Cross-tenant → refuse. Ambiguous → refuse. Stale session → cannot overwrite a live one. |

### Tenant-safety regression tests (§5 of the brief)

| Case | Test | Result |
|---|---|---|
| A. valid ephemeral pairing → correct tenant | `test_case_a_…` | PASS |
| B. lost ephemeral registry → owner still recoverable | `test_case_b_…` | PASS |
| C. unknown gateway session → fail closed | `test_case_c_…` | PASS |
| D. ambiguous owner → fail closed | `test_case_d_…` | PASS |
| E. stale old session cannot overwrite new | `test_case_e_…`, `test_m10_…` | PASS |

Plus the 12-case promotion matrix (§6 of the brief): normal QR, 515 restartRequired,
modal stays open, modal closes immediately, effect re-run, token cleanup before
`session_connected`, backend restart, duplicate, late, stale, two pairings / one user,
two users simultaneously — **all PASS**.

---

## 6. GATES — measured

| Gate | Result |
|---|---|
| Backend full suite | **1113 passed, 4 skipped, 0 failed** (baseline 1089 + 24 new) |
| Gateway full suite | **22/22 PASS** |
| Frontend `tsc --noEmit` | **0 errors** |
| `verify:logic` | 43 checks PASS |
| `verify:dom` | 20 checks PASS |
| `verify:browser` (real Chrome) | 7/7 PASS |
| `verify:pairing` | **14 checks PASS** (was 8; +4 race, +2 terminal — §12) |
| `verify:pairing-browser` (real Chrome) | **14/14 PASS** (was 12; +1 race, +1 terminal — §12) |
| `test-whatsapp-chat-order` | 10/10 PASS |
| `test-whatsapp-message-merge` | PASS |
| `verify:whatsapp-merge-equivalence` | PASS |

> **Final revision:** every suite above was re-run on the shipped code *after* the §11
> review pass, with identical results. §11.6 holds the complete sweep, plus the
> session-free DB requirement the backend suite needs (a raw run reports 28 failures
> that are environmental, not regressions).

Verified in a single clean run (2026-09-20, `Chrome/153.0.8010.48`), verbatim:

```
WhatsApp frontend identity + ordering verification: PASS (43 checks)
WhatsApp DOM verification: PASS (20 checks)
Real browser (Chrome Chrome/153.0.8010.48): 7 passed, 0 failed
WhatsApp pairing verification: PASS (12 checks)
Real browser pairing (Chrome Chrome/153.0.8010.48): 13 passed, 0 failed
```

> The two pairing lines above are the **pre-§12** run. After the finding-7
> follow-up both pairing suites stand at 14 checks and were re-run on the final
> revision — §12.5.

> That run's shell exit was **non-zero**, but not because a suite failed: the sandbox intercepts
> Chrome's own housekeeping writes (RLZ store, `code_sign_clone` temp dirs, the LaunchServices
> quarantine journal). Every suite printed PASS. Do not read that exit code as a gate failure.

**Incidental repair:** `frontend/scripts/test-whatsapp-chat-order.mjs` was already
broken at HEAD (exit 1) — `whatsappOrdering.ts` had gained an import of
`extractCleanPhone`, which a `data:` URL harness can never resolve. The earlier session
fixed it; the fix was verified necessary (fails on HEAD, passes with it).

**Three regressions were introduced and fixed during this phase** (found by the full
suite, not by inspection): the promotion path ran before owner resolution and trusted
whatever `db.scalar` returned, breaking `test_map_session_event_fails_closed…`,
`test_session_connected_rebinds_recovered_session`, and
`test_p68_promotion_happens_exactly_once`. Fixed by resolving the owner first and by
validating the durable row type — **no existing test was weakened to make this pass.**

A real-browser-only defect was also caught by `verify:pairing-browser`:
`handleCancel` marked the lifecycle `CANCELLED` **before** calling the guarded cancel,
so the guard blocked its own cancellation. jsdom did not see it. Fixed by reordering.

---

## 7. NOT DONE — and why

**`LIVE DEVICE E2E = NOT RUN`.** The central acceptance criterion
(real QR scan → real WhatsApp → real `connection.open` → real durable CONNECTED →
real lease → real inbound message) **has not been proven**, because §12 forbids the
production actions it needs and no live phone was available in this session.

Specifically **not** run:
* §7 real event chain with per-step timestamps — needs a real phone against the live stack.
* §11 "Real Chrome: QR visible / QR rotates / WS 101" against the **real** gateway
  (the browser suites use real Chrome against a **stubbed** network boundary).
* §11 "Real phone: scan → CONNECTED → lease acquired after promotion".
* §9 post-connect chat smoke (inbound / outbound / ACK / unread / read / reconnect /
  groups / LID identity). The 6.3–6.5 chat **fixes** remain green in the suites, but the
  live chat smoke was not executed.
* Outbound after promotion was not re-measured live.

**This phase is therefore NOT marked complete.** What is proven is that the defect is
reproduced, the fix makes the reproduction pass, and every local gate is green.

---

## 8. §8 COMPLIANCE (did not fix only the symptom)

Not done: hardcoding CONNECTED · changing UI text · suppressing the sync error ·
manual DB status edits · ignoring `EventOwnerUnresolved` · disabling fail-closed owner
resolution · arbitrary sleeps · keeping dead sessions forever.

The UI banner was **not** touched. `EventOwnerUnresolved` still fires (proven by the
fail-closed tests). Fail-closed owner resolution is intact and is now structurally
first.

---

## 9. §10 SEPARATE CLEANUP TRACK — findings only, nothing bundled

Deliberately **not** fixed in this phase; each needs its own decision:

1. **35 orphan `gateway_sessions`** — private rows with no public counterpart and no reaper.
2. **`event_outbox.session_id` FK 23503 for ephemeral sessions** — `registerSession` and
   the lease are gated `!ephemeral`, the outbox is not (74 errors / 40 min observed).
3. **1 341 undeliverable outbox rows** (1 341 / 2 289 permanently undeliverable).
4. **In-memory `_ephemeral_pairings`** — partially mitigated (the durable record now
   exists) but the registry itself is still process-local and never reaped.
5. **Retained FAILED sync jobs** — `get_sync_job` returns `snapshot()` regardless of
   state, so a FAILED job re-renders the banner on every hub mount until restart.
6. **Frontend local-config cleanup.**
7. **An ephemeral pairing never learns the gateway went terminal** — found during the
   §11 review pass. Every `applyTerminalGatewayStatus` call site is on the
   existing-session path, so `BANNED` / `UNAVAILABLE` / `RELINK_REQUIRED` during an
   ephemeral pairing leaves the modal showing a QR that can never work. Pre-existing;
   not bundled here. See §11.2. **FIXED** in the separate scoped follow-up after 6.8
   was frozen — §12.

---

## 10. FILES CHANGED

```
backend/app/api/v1/endpoints/whatsapp.py                        (db injection)
backend/app/models/__init__.py                                  (register model)
backend/app/models/ephemeral_pairing.py                         (new)
backend/app/services/whatsapp/orchestration/events.py           (promotion call)
backend/app/services/whatsapp/orchestration/pairing_registry.py (new)
backend/app/services/whatsapp/orchestration/promotion.py        (new)
backend/app/services/whatsapp/orchestration/sessions.py         (import, durable write, cancel)
backend/tests/test_whatsapp_phase6_8_promotion.py               (new, 24 tests)
frontend/src/features/whatsapp/components/WhatsAppQrConnectModal.tsx
frontend/scripts/verify-whatsapp-pairing.mjs                    (+6 checks: 4 race + 2 terminal)
frontend/scripts/verify-whatsapp-pairing-browser.mjs            (+2 checks: 1 race + 1 terminal)
frontend/scripts/test-whatsapp-chat-order.mjs                   (pre-existing harness rot)
```

---

## 11. REVIEW PASS — the §12 precondition, performed

§12 requires "the final diff has been reviewed" before any commit. That review was
performed on the complete diff (10 tracked files, +622/−61, plus the 4 new
untracked source files). It found one latent trap, one new product finding, one
vacuous test of my own, and several cosmetic defects.

### 11.1 A latent trap in the guard predicate — hardened

The guard was written as a **negation over a set that is not the complement of the
states it protects**:

```ts
export const CANCELLABLE_PAIRING_STATES = ['CREATING', 'SCAN_QR'];
...
if (!CANCELLABLE_PAIRING_STATES.includes(lifecycle)) return;  // "not cancellable" ⇒ "promoted"
```

`IDLE`, `CANCELLED` and `FAILED` belong to *neither* set, so the negation silently
classified them as **promoted**. Both guard sites used it. Replaced with a positive
set that states the invariant directly:

```ts
export const PROMOTED_OR_PROMOTING_STATES = ['PAIRING_IN_PROGRESS', 'PROMOTION_PENDING', 'CONNECTED'];
```

> At handover the tree still carried the six-state complement of the negation —
> §11.1's replacement was not actually present. Corrected in the §12 follow-up,
> together with the in-vivo falsification of both restored checks.

**Honest scope: this is hardening, not a live-defect fix.** Reachability of the
mis-classification was *not* proven. Because of 11.2, `FAILED` cannot currently be
held while a pair token exists, and `CANCELLED` nulls the token in the same handler.
The negation was one small change away from becoming live — which is why it was
corrected rather than left in place.

### 11.2 NEW FINDING — an ephemeral pairing never learns the gateway went terminal

**Every** `applyTerminalGatewayStatus` call site is on the **existing-session** path.
Neither ephemeral branch handles a terminal *status*:

* the fallback poll's `pToken` branch — `else if (res.error_message)` only, so a
  terminal status with no `error_message` falls through and is ignored;
* `handleRefreshQr`'s `currentPairToken` branch — no terminal call at all.

Consequence: if the gateway reports `BANNED` / `UNAVAILABLE` / `RELINK_REQUIRED`
while an **ephemeral** pairing is showing a QR, the modal keeps displaying a QR that
can never work until the 25 s countdown expires or the user refreshes manually.
**Pre-existing — not introduced by 6.8, and deliberately NOT fixed here** (scope
discipline: it is a separate UI-truthfulness change). Recorded with the §10 items.

### 11.3 A vacuous test of mine was written, falsified, and removed

A `TERMINAL:` regression check was added to cover 11.1. It was then falsified:
with the buggy predicate **deliberately restored**, the suite still reported
`PASS (14 checks)` — the check asserted nothing, because the state it drove is
unreachable (11.2). It was **removed** rather than kept.

A test that passes under a broken implementation is worse than no test, and this
phase had already been burned once by a test passing for the wrong reason. So
`verify:pairing` is back to **12 checks**, and the reason is documented inline in
the script so nobody re-adds it without first fixing 11.2.

**Superseded by §12:** once 11.2 was fixed, the `FAILED` state became reachable
while a pair token is held, so the checks were **restored** — with an added
assertion that pins finding 7's own mechanism (the dead QR must be removed) — and
were each proven to **FAIL** first, under the deliberately broken predicate and
under a disabled call site, before passing on the fixed code (14 checks).

### 11.4 Cosmetic and documentation corrections

* two statements had been merged onto a single line in `verify-whatsapp-pairing.mjs`;
* four stray blank lines in `verify-whatsapp-pairing-browser.mjs`;
* the new browser check was labelled `D:` next to two existing `D:` checks, making a
  failure ambiguous — relabelled **`G:`**;
* `pairing_registry.resolve_pairing_by_token` documented a production QR-poll caller
  that was **reverted**. It is test-harness-only and must never be used in an
  owner-resolution path (it includes consumed records). Docstring corrected.

### 11.5 Sweeps

* **No debug leftovers** (`console.log` / `debugger` / `__p68` / `TODO` / `FIXME`) in
  any changed source or test file — the only `console.log` hits are the verification
  scripts' own PASS/FAIL output.
* **No secrets or credentials** introduced in the diff.
* **No existing test was weakened** to make anything pass.
* `_to_dict` was verified to map `gateway_session_id` → `"gateway_id"`, which is what
  `cancel_pairing_session` reads. A name mismatch there would have silently turned
  every durable-path cancel into a no-op.
* `reconcile_self_identity(db, user_id, session, self_lid=)` was verified to exist
  with that exact signature.
* `isCancelledRef` **is** reset on reopen, so the new `handleCancel` early-return
  cannot latch and block a later pairing.

### 11.6 FINAL-REVISION GATE SWEEP — every suite re-run on the shipped revision

All suites were re-run on the final code (after the review changes), so every number
below refers to the **same** revision:

| Gate | Result |
|---|---|
| Backend full suite | **1113 passed, 4 skipped, 0 failed** |
| `tsc --noEmit` | **0 errors** |
| `verify:logic` | **PASS (43 checks)** |
| `verify:dom` | **PASS (20 checks)** |
| `verify:browser` (real Chrome) | **7 passed, 0 failed** |
| `verify:pairing` | **PASS (12 checks)** |
| `verify:pairing-browser` (real Chrome) | **13 passed, 0 failed** |
| `verify:merge` | **PASS** — identity/status/reconnect retention; 1200+pending merge in 1.22 ms |
| `verify:merge-equivalence` | **PASS** (10 rows, mode=canonical) |
| `test-whatsapp-chat-order` | **10/10 PASS** |
| Gateway | **22/22** — gateway code was not touched by this phase |

> The two pairing rows above are the pre-follow-up run. After the finding-7 change
> (§12) both suites stand at **14 checks** and were re-run — §12.5 holds the final
> numbers.

That is the complete set: the 7 `package.json` verification scripts, plus
`test-whatsapp-chat-order` — which has **no** `package.json` entry, so it must be run as
`node scripts/test-whatsapp-chat-order.mjs` or it silently never runs.

#### The backend suite must be run against a session-free DB copy

A raw `pytest backend/tests/` on the dev DB reports **28 failed, 1085 passed**. Those 28
are **not regressions** — they are the product failing closed *correctly*:

```
EventOwnerUnresolved: Olay session_id tasimiyor ve sahibi tek anlamli degil
                      (bagli tenant sayisi=2, jid=905321004040@s.whatsapp.net)
```

`resolve_event_owner()` selects **every** `CONNECTED` row with no tenant filter and raises
when more than one distinct owner exists. The dev DB `tezlify.db` holds a leftover
`CONNECTED` row (`id=2`), so each test's own seeded owner becomes the second tenant and
the event is refused. The shipped revision is clean:

```bash
cp tezlify.db /tmp/p68_test.db
python -c 'import sqlite3; c=sqlite3.connect("/tmp/p68_test.db");
c.execute("delete from whatsapp_sessions where status=?", ("CONNECTED",));
c.execute("delete from ephemeral_pairings"); c.commit()'
DATABASE_URL="sqlite+aiosqlite:////tmp/p68_test.db" PYTHONPATH=. pytest backend/tests/ -q
# -> 1113 passed, 4 skipped    (identical total: 28 + 1085 + 4 == 1113 + 4)
```

Removing exactly that one row turns `28 failed` into `0 failed` at an unchanged total —
which is the proof that the failures were environmental, not a regression. The dev DB also
held **11** stale `ephemeral_pairings` rows written by earlier in-place test runs, which is
precisely why the copy is mandatory and the dev DB must never be mutated.

**Still `LIVE DEVICE E2E = NOT RUN`.** Nothing in the review pass changes §7.

---

## 12. FINDING 7 FIXED — separate, scoped follow-up

Finding 7 (§11.2, §10 item 7) is fixed. It was taken as its own change, **after** 6.8
was frozen — nothing else in the phase was touched. The follow-up changed **three
frontend files only**; no backend, gateway, or production code.

### 12.1 What was broken

Every `applyTerminalGatewayStatus` call site sat on the **existing-session** path.
Neither ephemeral branch handled a terminal *status*:

* the fallback poll's `pToken` branch handled only `error_message` — a terminal
  status carrying **no** message (the common shape) fell through and was ignored;
* `handleRefreshQr`'s `currentPairToken` branch had no terminal call at all.

So `BANNED` / `UNAVAILABLE` / `RELINK_REQUIRED` while an ephemeral QR was on screen
left the modal painting a QR that could never work — and, because `FAILED` was
unreachable while a pair token existed, the guard predicate's `FAILED` branch was
unobservable (§11.1, §11.3).

### 12.2 The fix

| # | File | Change |
|---|---|---|
| ① | `WhatsAppQrConnectModal.tsx` | The ephemeral poll branch now calls `applyTerminalGatewayStatus(res.status, res.error_message)` — deliberately **before** the `error_message` fallback, so the lifecycle is marked `FAILED` even when a message accompanies the terminal status. |
| ② | `WhatsAppQrConnectModal.tsx` | The ephemeral refresh branch (`handleRefreshQr`, `currentPairToken`) calls it symmetrically with the existing-session branch. |
| ③ | `WhatsAppQrConnectModal.tsx` | `PROMOTED_OR_PROMOTING_STATES` **brought back in line with its own documented predicate**. The handed-over tree still carried the six-state complement (`IDLE`, `PAIRING_IN_PROGRESS`, `PROMOTION_PENDING`, `CONNECTED`, `CANCELLED`, `FAILED`) — i.e. §11.1's replacement was not actually in the tree. With the ①② call sites making `FAILED` reachable, that form was no longer latent: pressing Cancel / close on a terminal pairing would have **claimed CONNECTED and leaked the socket**. The predicate is now the documented positive set — `PAIRING_IN_PROGRESS`, `PROMOTION_PENDING`, `CONNECTED`. |
| ④ | `verify-whatsapp-pairing.mjs` | The two `TERMINAL:` checks removed in §11.3 were **restored** — reachable and falsifiable now — and check 1 gained the assertion that pins finding 7's own mechanism: `the dead QR must be removed once the gateway is terminal`. |
| ⑤ | `verify-whatsapp-pairing-browser.mjs` | New real-Chrome check **`H`**: terminal status with **no** message → dead QR removed from the actual paint + terminal reason visible + closing releases the socket without claiming a promotion. |

### 12.3 Falsification — every new check was made to fail first

**1. The handed-over tree (six-state predicate, i.e. §11.1's trap left in place), before
any fix:**

```
FAIL - TERMINAL: an errored pairing is still torn down...            (cancel=0)
FAIL - TERMINAL: pressing Cancel on an errored pairing must not claim CONNECTED  (cancel=0)
WhatsApp pairing verification: FAILED (12 checks)
```

That is the in-vivo falsification of both restored checks **and** the proof the
six-state form was a live defect once `FAILED` became reachable.

**2. The call site itself** — disabled with `false && applyTerminalGatewayStatus(...)`
(reproduces pre-finding-7 behaviour exactly: the harness sends `error_message: null`):

```
jsdom:   FAIL - the dead QR must be removed once the gateway is terminal
Chrome:  FAIL - H: ... the dead QR must be removed once the gateway is terminal
                (qrSrc=data:image/png;base64,...)
```

**3. The real browser caught a defect in my own new check.** Check `H` asserted
`cancel === 0` right after `reset()` — but `reset()` unmounts the previous check's
modal, whose still-waiting pairing is *correctly* cancelled, so the baseline was
made explicit (`cancelsBefore`) instead of assumed. The **test** was fixed; the
product behaviour it described was right. (Second time this phase that Chrome found
what jsdom could not — here a test bug, there a product bug.)

### 12.4 Scope honesty

* The **refresh** call site (②) is defence-in-depth: the 2.5 s poll (①) learns the
  same terminal status on its own. The checks drive the **poll** site; ② is
  symmetric hardening, verified by review, not by a dedicated check.
* No i18n keys, banners, other components, or backend code were touched.
* The §1.1 truthfulness rule is the reason ③ is a **fix** and not cosmetic: a
  terminal pairing must never be reported as CONNECTED.

### 12.5 Final gates on the combined revision

| Gate | Result |
|---|---|
| Backend full suite | **1113 passed, 4 skipped, 0 failed** (re-run on the session-free DB copy; backend code unchanged by this follow-up) |
| `tsc --noEmit` | **0 errors** |
| `verify:logic` | **PASS (43 checks)** |
| `verify:dom` | **PASS (20 checks)** |
| `verify:browser` (real Chrome) | **7 passed, 0 failed** |
| `verify:pairing` | **PASS (14 checks)** |
| `verify:pairing-browser` (real Chrome) | **14 passed, 0 failed** |
| `verify:merge` | **PASS** |
| `verify:merge-equivalence` | **PASS** (10 rows, mode=canonical) |
| `test-whatsapp-chat-order` | **10/10 PASS** |
| Gateway | **22/22** — untouched by this follow-up |

**`LIVE DEVICE E2E = NOT RUN` remains true.** The follow-up fixes a local
truthfulness/cleanup defect; it does not and cannot change §7. No commit, no push,
no deploy.

