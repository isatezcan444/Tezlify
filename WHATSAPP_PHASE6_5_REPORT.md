# PHASE 6.5 — QR PAIRING REGRESSION RECOVERY

**Branch:** `main` @ `5f8d25d` (Phase 6.5 work committed and pushed — see §19)
**Baseline of last known-good pre-6.4:** `ce68359`
**Phase 6.4 commits under suspicion:** `bf6b0ce` (A) → `bd55f2f` (B) → `0c497b1` (C) → `e031a3a` (D) → `671d911` (E) → `c512755` (F)

---

## VERDICT (read this first)

Two separate questions were asked, and they have **two different answers**. Do not merge them.

### 1. "Which Phase 6.4 commit broke QR?" — **NO COMMIT DID.**

**The QR regression is not established.** The QR pairing chain is intact on the current branch, and
it was equally intact on the pre-6.4 baseline.

The user's own acceptance rule (§10) was:

> `ce68359 => PASS`, `c512755 => FAIL` kanıtlanabiliyorsa regression kesinleşmiş olur.

Measured result:

| Revision | QR availability | QR delivery (event) | Phone pairing code |
|---|---|---|---|
| `ce68359` | **PASS** | **FAIL** | **FAIL** |
| `c512755` (HEAD) | **PASS** | **PASS** | **PASS** |

`ce68359 => PASS` and `c512755 => PASS`. By the user's own criterion, **the QR regression is not
established**. What *is* established is that the two Phase 6.4 fixes are real and load-bearing —
and that the phone-pairing-code fix went `FAIL → PASS` exactly at `0c497b1`.

### 2. "Then why is QR pairing dead in production?" — **FOUND. It is a lease defect, not a 6.4 regression.**

The symptom was real; it simply was never caused by a Phase 6.4 commit. **Root cause, proven below:**

> `_connectSocket` deliberately skips `leaseRepository.acquire()` for an ephemeral pairing
> (`if (leaseRepository && !session.ephemeral)`, `session-manager.js:2568`) — the lease belongs to the
> *persistent* session a completed pairing is promoted into, and the promotion path takes it only on
> connect (`:3012`). But the renewal timer was armed with a bare `if (leaseRepository)` (`:2787`),
> so it **also ran for a session holding no `socket_leases` row**.
>
> The first tick called `renew()` against a nonexistent row; the adapter's
> `return result.rowCount === 1` (`lease/postgres-session-lease.js`) yielded **false**;
> `loseLease()` invalidated the socket lifecycle and set `status = 'UNAVAILABLE'`,
> `error_message = 'WHATSAPP_SESSION_LEASE_LOST'`. At the production TTL of 45 s the interval is
> TTL/3 = **15 s**, so the pairing died **~15 s after its socket opened — before WhatsApp ever
> emitted a QR.**

**This defect is present on BOTH `f6ec68d` (deployed) and `c512755` (local HEAD).** It is therefore
**not** a Phase 6.4 regression: it predates the 6.4 range and was only *exposed* by the 6.4 push
because that is when pairing traffic actually started exercising the ephemeral path.

**Production evidence** (read-only, 2026-09-19, gateway revision `f6ec68d`):

| Evidence | Value |
|---|---|
| `session_qr_updated` events in gateway logs | **0** |
| `socket_lease_lost` events | **4** |
| `socket_connect_started` → `socket_lease_lost` gaps | **15040 / 15058 / 15042 ms** (exactly one 15 s interval) |
| Rows in `whatsapp_private.socket_leases` | **1** — the CONNECTED session only; **none** for the four failed pairings |
| Failed pairings' status | `UNAVAILABLE` / `WHATSAPP_SESSION_LEASE_LOST` |

The 15 s gap is the decisive number: it is `TTL(45) / 3`, i.e. the **first renewal tick**, not a
timeout, not a network failure, not a QR encoding problem.

**Fix applied** (§16 — QR-breaking change only; P6-8 and P6-9 untouched):

- `session-manager.js` — the renewal arming was extracted into `armLeaseRenewal()` and is now called
  only where a lease is actually held: `if (!session.ephemeral) armLeaseRenewal()` at attach, and
  from the promotion branch immediately after `acquire()` succeeds. Guarding the arming *only* would
  have left a promoted session renewing nothing; arming it at promotion is the other half.
- New regression test `whatsapp-gateway/scripts/test-phase6-5-ephemeral-lease.mjs` (6 checks), plus
  the shared `scripts/fake-lease-pool.mjs`.

See §20 for the fail→pass proof.

---

## §1 — Checkpoint table Q1–Q18

Executed against a **real running gateway process** (real Express `src/index.js`, real
`SessionManager`, real backend route, real DB), with **only the Baileys network boundary faked**
and the fake **provably in play** (`[fake-baileys] makeWASocket … autoQr=1 autoConnectMs=8000`).

```
Q1  modal open            -> frontend; covered by verify:pairing-browser scenario A
Q2  QR tab active         -> frontend; scenario A
Q3  POST /pairing/start   -> 201
Q4  pair_token/gateway_id -> 2659fc1d.. / 8ec01176..
Q5  backend registered    -> gateway session 8ec01176.. status=SCAN_QR
Q6  gateway session live  -> yes (real GET /sessions/8ec01176..)
Q7  session_connecting    -> status=SCAN_QR
Q8  session_qr_updated    -> qr present = True
Q9  backend ingested      -> GET /pairing/{token}/qr 200
Q10 owner-scoped delivery -> other tenant -> 404 (seam test)
Q11 GET qr payload        -> len=1754 prefix='data:image/png;base64,'
Q12 QR decodes as PNG     -> True  (magic bytes \x89PNG\r\n\x1a\n)
Q12b rows before connect  -> 0  (S-2 holds: no row before a successful pairing)
Q13 QR refresh/rotation   -> new QR len=1702
Q14 scan -> connection    -> CONNECTED
Q15 promotion             -> session_id=2 phone=+905413749073
Q16 QR cleared            -> qr_code=None
Q17 persisted rows        -> 1
Q18 list_sessions         -> 200 count=1
```

**First broken checkpoint: none — _in this configuration_.** Every checkpoint from Q1 to Q18
completes, and there is no "QR görünmüyor" state on this branch.

⚠️ **But this table was produced with NO lease repository configured** (the hermetic gateway runs
without `GATEWAY_DATABASE_URL`, and port 5432 is closed locally — see §18). That is precisely why it
could not see the real breakage: with a lease repository present, the pairing dies **before Q8**. The
checkpoint chain is therefore a valid statement about the *QR code path* and **not** a statement about
production. §20 supplies the missing configuration and the failing checkpoint.

---

## §2 / §3 / §10 — Bisect

### §2 Diff scope (`ce68359..c512755`)

| Commit | Files touched | QR path? |
|---|---|---|
| `bf6b0ce` (A, backend) | `endpoints/whatsapp.py`, `orchestration/events.py`, `orchestration/sessions.py`, `whatsapp_service.py` | **Additive only.** `get_pairing_qr` untouched. `events.py` only *adds* an owner-resolution branch before the existing `EventOwnerUnresolved` raise. |
| `bd55f2f` (B, gateway) | `session-manager.js`, `fake-baileys.mjs`, `pairing-harness.mjs`, `test-pairing-lifecycle.mjs` | **No.** The only two hunks in `session-manager.js` are the `pairingCodeInFlight` map and `requestPairingCode`. `grep -i qr` over added/removed lines returns **nothing**. |
| `0c497b1` (C, frontend) | `whatsappApi.ts`, `WhatsAppQrConnectModal.tsx`, `whatsappRepository.ts` | **No.** Modal hunks are `@@ -85,6 +85,7 @@` (ref declaration) and `@@ -299,30 +300,51 @@` (entirely inside `handleGetPairingCode`). `setQrCode`, `qrCode`, `fallbackPoll`, `session_qr_updated` appear **nowhere** in the diff. |
| `e031a3a` (D, tests) | test files + `frontend/package.json` | No product code. |
| `671d911` (E, docs) | `.md` only | Cannot affect runtime. |
| `c512755` (F, docs) | `.md` only | Cannot affect runtime. |

### §3(c) QR smoke at every revision

The **same 12-check real-browser suite** (Chrome/CDP, real `WhatsAppQrConnectModal`, real built CSS)
was run at each revision via `git worktree`:

| Revision | Result | Failing checks |
|---|---|---|
| `ce68359` | 8 passed, **4 failed** | B, B-painted, F, F2 — **phone code only** |
| `bf6b0ce` | 8 passed, **4 failed** | B, B-painted, F, F2 — **phone code only** |
| `bd55f2f` | 8 passed, **4 failed** | B, B-painted, F, F2 — **phone code only** |
| `0c497b1` | **12 passed, 0 failed** | — |
| `e031a3a` | **12 passed, 0 failed** | — |
| `c512755` | **12 passed, 0 failed** | — |

**Every QR check (A ×3, D ×2, E) passes at all six revisions.** The only failures are the phone
pairing-code checks, and they fail *before* `0c497b1` and pass *from* `0c497b1`.

Failure text at `ce68359`, verbatim:

```
FAIL - B: "Kod Al" for a NEW pairing shows all 8 digits
      exactly one pairing request (got 0)
FAIL - F: a QR-side failure does not block the phone pairing-code path
      a QR failure must not suppress the pairing-code request (got 0)
```

`got 0` = the P6-8 silent no-op. That is the defect Phase 6.4 fixed.

### §10 Verdict

`ce68359 => QR PASS`, `c512755 => QR PASS` → **no QR regression to binary-search.** The bisect
still produced a result, just not the expected one: **the first commit that changes behaviour is
`0c497b1`, and it changes the phone-code path from broken to working.**

---

## §4 — Modal hypotheses (all cleared)

| Hypothesis | Finding |
|---|---|
| `handleGetPairingCode` clears `qrCode` | **False.** It sets `setPairingCode(null)`, never `setQrCode(null)`. |
| QR flow forced onto the pair tab | **False.** No `setActiveTab('pair')` anywhere in the code path. |
| `existingSessionId === null` → wrong early return | **False.** The guard is `if (!sid && !pToken)`; on the QR path `pairToken` is set, so it does not fire. |
| `isPairingLoading` / `isQrLoading` share state | **False.** Separate state; `pairingInFlightRef` is only read in `handleGetPairingCode`. |
| `pair_token` and `sessionId` clear each other | **False.** `pairTokenRef` is cleared only on promotion/cancel, and the QR path reads `pairTokenRef` first. |

---

## §5 — Independent component tests

| Layer | Instrument | Result |
|---|---|---|
| Backend route | `test_whatsapp_phase6_5_qr_live_seam.py` vs. a real gateway | **4 passed** |
| Backend route (isolated) | `test_whatsapp_phase6_4_pairing.py` | passed (part of 1089) |
| Gateway | `test-pairing-lifecycle.mjs` + the other 19 `test-*.mjs` | **20/20** |
| Frontend (jsdom) | `verify:pairing` | **8 checks PASS** |
| Frontend (real browser) | `verify:pairing-browser` | **12/12 PASS** |

---

## §6 — Event vs. polling: **proven, not assumed**

Captured on a socket impersonating the backend `/ws/gateway` endpoint, from a real gateway:

```json
{"event":"session_qr_updated","gateway_session_id":"__GATEWAY_ID__","qr_code":"data:image/png;base64,...","session_id":"__GATEWAY_ID__"}
{"event":"session_connecting","gateway_session_id":"__GATEWAY_ID__","session_name":"Cap","session_id":"__GATEWAY_ID__"}
```

The QR payload's keys are exactly `['event','gateway_session_id','qr_code','session_id']` — it
carries **no `session_name`**. These payloads are pinned verbatim in
`backend/tests/fixtures/real_gateway_qr_events.json`; a hand-written fixture would have silently
omitted `gateway_session_id`, which is precisely the field the resolver falls back to.

**Conclusion:** QR arrives via **both** paths — `GET /pairing/{token}/qr` polling (2.5 s) **and**
the `session_qr_updated` event. Neither was broken, and neither was fixed by breaking the other.

---

## §7 — Tenant isolation: preserved, not globalised

The P6-9 fix attributes the event to the **single recorded owner**; anything unattributable still
fails closed. Explicit tests:

- `test_p69_qr_event_for_ephemeral_pairing_is_owner_scoped` — A's QR resolves to A and
  `owner not in (OTHER_UID,)`; B's own pairing resolves to B, independently.
- `test_qr_owner_scoping_survives_the_live_route` — another tenant requesting
  `GET /pairing/{token}/qr` gets **404**.

No `broadcast to everyone` was introduced. `ws_manager.broadcast` still routes by `target_user_id`.

---

## §12 / §13 — Phone pairing code preserved; single-flight is mode-aware

The phone path is **strictly better** than the baseline: it went from `got 0` requests (silent
no-op) at `ce68359` to working at `0c497b1` and staying green at HEAD.

Mode-awareness is proven behaviourally (scenario F), not just structurally:

- QR endpoint reports a hard error → switching to the phone tab still issues the code request and
  renders all 8 digits.
- The pairing-code request fails → the QR is still painted, and a retry reaches the backend.

Structurally the two guards are different refs and never shared: `isInitializingRef` (initSession)
vs. `pairingInFlightRef` (code path).

---

## §14 — Cancel / retry browser tests (new)

Two new real-browser scenarios, both green:

- **D** — `QR → cancel → reopen`: reopening starts a **new** pairing (`start` 1 → 2, `tokenSeq` 1 → 2)
  and paints a **different** QR; the stale QR never survives. Plus a second-cancel check proving the
  first `pair_token` is never reused.
- **E** — `start fails → retry`: the real backend error is visible, no QR is shown (fail closed), and
  the retry paints a QR.

---

## §15 — Regression matrix

| Scenario | `ce68359` (pre-6.4) | `c512755` (HEAD) | Verdict |
|---|---|---|---|
| New QR (first pairing) | **PASS** | **PASS** | no regression |
| QR refresh / rotation | **PASS** (browser + live: len 1754 → 1702) | **PASS** | no regression |
| QR cancel → reopen → new QR | **PASS** | **PASS** | no regression |
| QR start → fail → retry → QR | **PASS** | **PASS** | no regression |
| QR delivered by polling | **PASS** | **PASS** | no regression |
| QR delivered by event | **FAIL** | **PASS** | **6.4 fix, load-bearing** |
| Existing-session QR | **PASS** | **PASS** | no regression |
| Ephemeral QR owner scoping | n/a (event dropped) | **PASS** (404 to other tenant) | **6.4 fix** |
| Connected transition (Q14–Q18) | **PASS** | **PASS** | no regression |
| Phone pairing code (new pairing) | **FAIL** (`got 0`) | **PASS** | **6.4 fix, load-bearing** |
| Phone pairing code (existing session) | **PASS** | **PASS** | no regression |
| **Ephemeral pairing vs. session lease** (lease repo configured) | **FAIL** | **FAIL** | **pre-existing defect — fixed in 6.5, see §20** |

**Rows changed by Phase 6.4: 3 — all of them from FAIL to PASS. Rows broken by Phase 6.4: 0.**

The last row is the one that mattered. It fails **identically on both** revisions, which is precisely
why the bisect came back empty: the breakage was never inside the `ce68359..c512755` range. The six
browser checks and the live route both pass without a lease repository configured, which is why the
Phase 6.4 harnesses — none of which inject one — could not see it.

---

## §17 — FAIL → PASS proof, with teeth

### The required proof

`backend/tests/test_whatsapp_phase6_5_qr_live_seam.py::test_real_gateway_event_payload_resolves_to_its_owner`
feeds the **gateway's verbatim captured payload** through `ingest_gateway_event`:

```
ce68359  -> 1 failed, 3 passed
            E  AssertionError: the backend dropped the gateway's real session_qr_updated payload
               (main.py would count it `skipped` and never broadcast it)

c512755  -> 4 passed
```

Note the shape of that result: at `ce68359` the **QR availability** tests pass and only the
**event-delivery** test fails. That is the clearest possible statement that the QR chain worked
before 6.4 and the 6.4 change was additive.

### Teeth (falsification controls)

Every control patches product code, runs the suite, then reverts via `git checkout --`.

| Control | Patch | Result |
|---|---|---|
| **F1** remove QR forwarding | delete `setQrCode(res.qr_code)` in the poll | **7 passed, 5 failed** — A, A, D, D2, F |
| **F2** remove cancel purge | delete `await WhatsAppRepository.cancelPairing(activePair)` | **10 passed, 2 failed** — D, D2 |
| **F3** latch the guard | delete `pairingInFlightRef.current = false` in the `finally` | **11 passed, 1 failed** — F |
| **F4** re-arm the lease renewal unconditionally | `if (!session.ephemeral) armLeaseRenewal()` → `if (leaseRepository) armLeaseRenewal()` | **test fails at the first assertion** (see §20) |

F1 is the user's mandated control ("QR forwarding'i kaldır → FAIL"): removing QR state delivery
fails the suite, restoring it passes. F3 is the exact defect class I found in my own 6.4 code
during review, so it now has a permanent guard. F4 is the control for the lease defect — it
reproduces the pre-fix line exactly.

---

## §18 — Gates

| Gate | Result |
|---|---|
| `pytest backend/tests -q` | **1089 passed, 4 skipped** — see the DB note below |
| gateway `test-*.mjs` loop | **21/21** (was 20; +`test-phase6-5-ephemeral-lease.mjs`) |
| `npx tsc --noEmit` | exit **0** |
| `npm run build` | exit **0** |
| `verify:logic` | **PASS (43 checks)** |
| `verify:dom` | **PASS (20 checks)** |
| `verify:merge` | **PASS** |
| `verify:merge-equivalence` | **PASS** (mode=canonical) |
| `verify:pairing` | **PASS (8 checks)** |
| `verify:browser` | **7 passed, 0 failed** |
| `verify:pairing-browser` | **12 passed, 0 failed** |
| live QR seam (`WHATSAPP_LIVE_GATEWAY_URL`) | **4 passed** |

The 4 skips are the live-seam tests skipping without `WHATSAPP_LIVE_GATEWAY_URL` — that is by
design, so the default suite stays hermetic.

### Environment constraint on these gates (important)

The gateway gates — including the live QR seam and the §1 checkpoint chain — ran **without a lease
repository**. The hermetic gateway is started with `REQUIRE_DURABLE_AUTH=false` and no
`GATEWAY_DATABASE_URL`, and no local PostgreSQL is available (port 5432 closed, no container runtime
installed). `leaseRepository` is therefore `null`, so `_connectSocket` never enters the lease branch at
all.

That is exactly why the QR path looked healthy everywhere: **the configuration that produces the
production failure was absent from every gate.** The lease path is covered instead by
`test-session-lease.mjs` and `test-phase6-5-ephemeral-lease.mjs`, which inject a real lease adapter over
a fake pool (§20). No gate in this phase exercised the real adapter against a real PostgreSQL.

### ⚠️ The backend suite is only green against a DB with no pre-existing sessions

A first run of `pytest backend/tests -q` in this tree reported **28 failed, 1061 passed, 4 skipped**.
**This is not a code regression** — the backend tree was byte-identical to HEAD (the only backend
files added in Phase 6.5 are new test files that do not participate when a node id is given), and
the failure reproduces with a single test run in isolation.

Cause: the suite runs against the developer's local `tezlify.db`, which contained **two leftover
sessions from manual testing** (`local-test` / `SCAN_QR`, `Q-walk` / `CONNECTED`) belonging to two
*other* users. Several test modules ingest events that carry **no `session_id`** (only a
`conversation_id`), so the owner must be resolved from the jid — and with those extra sessions
present the resolver correctly refused:

```
WARNING ... Gateway olayi sahibi cozulemedi, atlandi (event=message_new):
Olay session_id tasimiyor ve sahibi tek anlamli degil
(bagli tenant sayisi=2, jid=905525372434@s.whatsapp.net)
```

`ingest_gateway_event` therefore returned `None` and the tests saw zero rows. The module-level
`_cleanup` fixture wipes only its own two test user ids, so it cannot remove unrelated dev rows.

Verified by running the identical suite against a **cleaned copy** of the DB
(`cp tezlify.db /tmp/tezlify_test_clean.db`, delete `whatsapp_sessions` rows, then
`DATABASE_URL=sqlite+aiosqlite:////tmp/tezlify_test_clean.db`): **1089 passed, 4 skipped.** The
developer's real `tezlify.db` was **not modified** by this investigation.

**Actionable:** this is a test-isolation weakness worth fixing (the suite shares the dev DB and
assumes it holds no other sessions). It is unrelated to Phase 6.4/6.5 and was left untouched.

---

## §19 — Commit status

**COMMITTED AND PUSHED** — the user lifted the §19 hold and authorised commit + push, choosing a
**single commit**.

```
5f8d25d  fix(whatsapp): ephemeral pairing lost a lease it never held (Phase 6.5)
         main -> origin/main   (c512755..5f8d25d)
         13 files changed, 1670 insertions(+), 197 deletions(-)
```

The commit contains exactly this Phase 6.5 work:

```
 M frontend/scripts/verify-whatsapp-pairing-browser.mjs   (scenarios D/E/F, open/clickAria, startFails/qrFails)
 M whatsapp-gateway/scripts/fake-baileys.mjs              (standalone-server auto-QR/rotate/connect + trace)
 M whatsapp-gateway/scripts/pairing-harness.mjs           (injectable leaseRepository/pool/authRepository)
 M whatsapp-gateway/scripts/test-session-lease.mjs        (uses the shared fake pool)
 M whatsapp-gateway/src/session-manager.js                (THE FIX — armLeaseRenewal, 2 call sites)
 A backend/tests/test_whatsapp_phase6_5_qr_live_seam.py
 A backend/tests/fixtures/real_gateway_qr_events.json
 A whatsapp-gateway/scripts/register-baileys-stub.mjs
 A whatsapp-gateway/scripts/fake-lease-pool.mjs
 A whatsapp-gateway/scripts/test-phase6-5-ephemeral-lease.mjs
 A WHATSAPP_PHASE6_5_REPORT.md                            (this file)
```

The blocking condition was: *QR = PASS, phone pairing = PASS, tenant isolation = PASS, browser*.
All four hold (§18), and the QR breakage has a named cause and a fail→pass proof (§20).

### ⚠️ Pushing is not deploying

The fix is on `main`, but **production still runs `f6ec68d`** and still carries the defect. QR pairing
stays broken for real users until a deploy happens. The commit changes nothing about that, and no
deploy is performed or proposed by this phase.

Pre-push gate (run against the committed tree, not the working tree):
`node --check session-manager.js` OK · `test-session-lease` 7 assertions · `test-phase6-5-ephemeral-lease`
6 checks.

---

## §20 — The lease defect: fail → pass, with teeth

### The proof

A probe drives a REAL ephemeral pairing against a REAL lease adapter over a fake pool, then waits
past one renewal interval. Same command, same code path, one line different:

| | T+0 s | T+11.5 s |
|---|---|---|
| **PRE-FIX** (`if (leaseRepository)`) | `status=SCAN_QR qr=painted` **`renewTimer=ARMED`** `leaseRow=false` | **`status=UNAVAILABLE` `error=WHATSAPP_SESSION_LEASE_LOST` `sockEnded=true` `renewCalls=1`** |
| **POST-FIX** (`if (!session.ephemeral)`) | `status=SCAN_QR qr=painted` **`renewTimer=null`** `leaseRow=false` | **`status=SCAN_QR` `error=none` `sockEnded=false` `renewCalls=0`** |

The pre-fix row is a **line-for-line reproduction of the production symptom**: a session that is
holding a painted QR, has no lease row, fires exactly one renewal, and is then torn down as
`UNAVAILABLE` / `WHATSAPP_SESSION_LEASE_LOST`. The post-fix row shows the timer is never armed and
the pairing survives indefinitely.

### The permanent guard

`whatsapp-gateway/scripts/test-phase6-5-ephemeral-lease.mjs` — **6 checks**, all passing:

1. the lease adapter reports `renew() === false` for a row that does not exist (the mechanism)
2. an ephemeral pairing arms **no** renewal timer and holds **no** lease row
3. a persistent session **does** arm renewal because it holds the lease
4. an ephemeral pairing **survives past one renewal interval** (the production symptom)
5. a persistent session renews its lease and survives the same interval
6. a **promoted** pairing arms renewal for the lease it takes on connect

Check 6 exists because the obvious one-line fix is incomplete. Guarding the arming *only*
(`if (!session.ephemeral)`) leaves a session that was ephemeral at attach time holding the lease it
takes at promotion with **nothing renewing it** — the lease would silently expire while this
instance kept running, which is a split-brain risk. The renewal therefore had to be armed at the
promotion site too, which is why `armLeaseRenewal()` is a named function with two call sites rather
than an inlined `if`.

**A defect found in the test itself:** the first draft built both harnesses before any socket
existed. `createHarness` seeds its socket cursor from the global registry length at construction
time, so both cursors started at 0 and `nextSocket()` handed the **same** socket to both harnesses —
the persistent session was being driven by the ephemeral session's socket. The test now creates the
harnesses sequentially, drives each to a painted QR, and asserts `ephSock !== perSock`. Without that
assertion the test would have "passed" while proving nothing.

---

## §21 — Same-class sweep: is this defect elsewhere?

Having fixed one asymmetric guard, I swept for siblings rather than assuming it was unique.

**Method:** enumerate every timer and every resource-lifecycle call site, then diff the predicate
that *acquires* the resource against the predicate that *renews/releases* it.

| Surface | Finding |
|---|---|
| `session-manager.js` timers | Only **one** resource-guarded timer — the lease renewal. **Fixed.** |
| `events.js:250,252` | The outbox pump/cleanup timers are guarded by `if (eventOutbox)`, a constructor-injected dependency that never appears or disappears mid-lifecycle. **No asymmetry.** |
| Backend lease lifecycle | **None exists.** The backend only *reads* `whatsapp_private.socket_leases` for admin metrics; acquire/renew/release are gateway-only. |
| `_conversation_locks` (`repositories/conversations.py:16`) | Unbounded module-level `Dict[(user_id, conversation_id), asyncio.Lock]`, never evicted. A **different** class (unbounded cache, one small object per conversation ever touched), already noted as intentional. Not an asymmetric guard. |

**Result: the lease renewal was the only instance of this class in the tree.** That is a statement
about this codebase, not a general guarantee — the value of the sweep is that it was done, not that
it came back empty.

---

## §22 — Why nobody noticed: the readiness surface was green throughout

The outage ran for hours and the monitoring reported **OK**. That is not a coincidence, and it is
worth recording because it is how the bug survived to production.

The invariant evaluator is `scripts/whatsapp_reliability_collector.py`; the backend merely *displays*
what it produces (`monitoring_admin_service.py:163` reads `current.json`). Of its 13 invariants, the
two lease rules are:

```python
# R5: No duplicate active socket ownership (leases <= connected)
r5 = leases <= max(1, conn_count)
# R6: No stale socket leases accumulating
r6 = leases == conn_count
```

With **1 connected session and 1 lease**, both evaluate `1 <= 1` and `1 == 1` → **PASS**, while four
pairings died. R12 (`gateway.status == "ok"`) also passed, because the *gateway process* was healthy
— it was the *sessions* that were dying. The gateway health probe has no per-session dimension.

The distinction that makes this a definitional gap, not an oversight in the data:

- **R5** asks "is any connected session holding *more than one* lease?" — the dead pairings held
  **zero**.
- **R6** asks "are there leases with *no* connected session?" — again, the dead pairings held **zero**.

Neither rule can express "a session that should be alive holds no lease", which is the actual
failure. Notably the collector **already gathers the data** — `whatsapp_sessions.by_status` includes
`UNAVAILABLE` — but no invariant consumes it.

**Recommended follow-up (not implemented — it is a product/ops change outside §16's "fix only the
QR-breaking change"):** add an invariant over `by_status`, e.g. *"zero sessions in `UNAVAILABLE` with
a lease error"*, and/or alert on `socket_lease_lost` diagnostics in the gateway log. My fix keeps R6
green during a normal pairing (ephemeral sessions still hold no lease), so such a rule would fire on
the real failure and stay quiet otherwise.

---

## Harness defects found and fixed during Phase 6.5

These were defects in **my own tooling**, not the product. Each one made an earlier result a lie.

1. **`--import ./scripts/baileys-stub-loader.mjs` never installed the hook.** `--import` only
   *loads* a module; a loader must call `register()`. Every gateway started that way (the harnesses
   on 8791–8795) was talking to **real WhatsApp** while still looking hermetic. Fixed with
   `register-baileys-stub.mjs`. The harness on **8796 was started with the fixed form** and its trace
   confirms the double was in play for all 16 sockets it created — so the **live seam results, which
   ran against 8796, are hermetic and stand**. The defect only invalidates the 8791–8795 runs.
2. **Three parallel `Edit` calls to the same file raced and clobbered each other.** Two of the three
   edits were silently lost, so the harness's `startFails` switch was never installed and scenario E
   was exercising a *successful* start. Edits to one file must be serialised.
3. **A backtick inside a comment in the entry template literal** terminated it
   (`SyntaxError: missing ) after argument list`). The file's own warning at line 48 says exactly
   this; I still tripped it.
4. **My checkpoint script hardcoded `settings.WHATSAPP_GATEWAY_URL = "http://127.0.0.1:8796"`**, so
   every "fresh gateway" run actually hit the long-lived 8796 process and its results were
   mis-attributed to the process I had just started. The giveaway was
   `session_registry_shutdown sessions:0` in the new process's log — it had served nothing. Fixed to
   honour `WHATSAPP_LIVE_GATEWAY_URL`; only then did Q13/Q14–Q18 pass. (The Q13/Q14 gaps seen while
   pointed at 8796 were that gateway's own configuration: it was started without
   `FAKE_BAILEYS_AUTO_QR_ROTATE`, so it never rotated.)
5. **Stale gateway processes on a reused port.** A new process can print `listening on …` and still
   lose the port to an older one, so "the gateway I started" is not evidence. Verify by asserting the
   serving process's own log (e.g. `sessions:N` at shutdown, or a trace line), not by the port
   responding.
6. **Two harnesses built before any socket existed share a cursor.** `createHarness` seeds
   `socketCursor` from the global fake-socket registry length *at construction time*; building two
   harnesses back-to-back starts both at 0, and `nextSocket()` then hands the **same** socket to
   each. My first draft of the lease test did exactly this and silently drove the persistent session
   with the ephemeral session's socket. Fixed by creating harnesses sequentially and asserting
   `ephSock !== perSock`. Any future multi-harness test needs the same assertion.
7. **The backend suite shares the developer's `tezlify.db`.** It is green only when that DB holds no
   other `whatsapp_sessions` rows; two leftover local-dev sessions produced **28 spurious failures**
   (§18). Always confirm the DB is clean before treating a backend failure as a regression — and
   prefer `DATABASE_URL` pointed at a copy over mutating the real DB.

---

## What is NOT proven (stated plainly)

1. ~~The reported symptom is not reproduced.~~ **SUPERSEDED.** The symptom *was* reproduced — it just
   was not a Phase 6.4 regression. The lease defect in §20 reproduces it line-for-line on demand
   (`UNAVAILABLE` / `WHATSAPP_SESSION_LEASE_LOST` ~15 s after the socket opens, with a painted QR and
   no lease row), and matches production's 15040/15058/15042 ms gaps. What remains unproven is the
   narrower claim that *this specific defect* is what the reporter saw — the reported symptom is
   consistent with it, but the report did not include logs.
2. **Production was inspected read-only, once.** Deployed revision confirmed as `f6ec68d`; the four
   failed pairings, the single `socket_leases` row, the four `socket_lease_lost` events and the zero
   `session_qr_updated` events were all read directly. **Not re-verified after this session**, and no
   fix has been deployed.
3. **The fix is not deployed.** `f6ec68d` in production still carries the defect. Deploying is outside
   this phase's scope (and forbidden by §19), so **production QR pairing remains broken until a
   deploy happens**.
4. **The lease path was never exercised against real PostgreSQL.** The gateway test uses a fake pool
   that implements the adapter's three statements; no local Postgres is available (port 5432 closed,
   no container runtime). The adapter's real `renew()` SQL is covered by `test-session-lease.mjs`
   against the same fake pool, not against a live server.
5. **LIVE DEVICE E2E = NOT RUN.** No QR was ever scanned by a physical phone and no real pairing
   attempt was made. The Q14–Q18 connect/promote/persist chain was driven through the explicit
   pairing route against a faked provider boundary. Real-device behaviour is unverified.
6. **Q13/Q14–Q18 are hermetic-only.** They exercise the fake provider's rotation and auto-connect,
   which is what makes them deterministic — but it also means they do not prove how real WhatsApp
   rotates a QR in production.
7. **The backend suite's DB isolation weakness is unfixed.** `pytest backend/tests` is only green
   against a DB holding no other `whatsapp_sessions` rows (§18). Left untouched: it is unrelated to
   this phase and fixing it means changing shared test infrastructure.
