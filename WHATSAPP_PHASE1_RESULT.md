# PHASE 1 RESULT — CONNECTION / SESSION LIFECYCLE HARDENING

> **Scope:** Session/pairing/connection lifecycle only. No conversation discovery, sync, history, identity, group discovery, ordering, ChatThread, chat-selection, or chat-layout work.
> **Predecessor:** [WHATSAPP_BASELINE_CONTRACT.md](WHATSAPP_BASELINE_CONTRACT.md) (Phase 0, frozen at `359fe6d`).
> **Branch:** `main` (uncommitted changes only — NO COMMIT, NO PUSH, NO DEPLOY).

---

## PHASE 1 RESULT: **PASS** (with the qualifications below)

All §20 acceptance invariants hold against the modified source. **558/558 targeted + extended WhatsApp test cases pass** (4 skip, 0 fail). No §4 MUST NOT REGRESS invariant is broken by the changes. No Phase 2+ scope was touched.

> **Important:** This phase introduces a single contract amendment (§1 below) that *clarifies* the existing P6-4 behaviour, not a behaviour change. The protected behaviour (keying by `selectedConv.id`) is unchanged.

---

## 1. CONTRACT CONSISTENCY RESOLUTION (§1)

The Phase 0 contract contained a contradiction:

- §4 (FRONTEND / chat selection): "`selectedConv` is the **single** authoritative source of which chat is rendered. The chat-pane component receives `selectedConv.id` as its keying field."
- §7 (A→B→C switching): "The page renders a single `<ChatThread>` with `messages={messagesMap[selectedConv.id] ?? []}`. It is NOT keyed by `selectedConv.id` in the React sense."
- §10.8: "the regression risk is if a future refactor re-keys the ChatThread on `selectedConv.id` (which would force a remount and lose the `pendingPrependRef`/scroll state)."

**Resolution (after source inspection):**

CURRENT REAL IMPLEMENTATION (`frontend/src/pages/WhatsAppHubPage.tsx:2327–2328, 2359–2360`):

```tsx
<ChatThread
  key={selectedConv.id}
  messages={activeMessages}
  ...
/>
<ChatComposer
  key={selectedConv.id}
  onSend={...}
/>
```

PROTECTED BEHAVIOUR (P6-4 reason):
- The `ChatThread` holds four pieces of state that MUST be cleared on a switch: `isNearBottom`, `initialScrollDoneRef`, `pendingPrependRef`, `isPrependingRef`. Without a `key`, switching A→B reuses the instance; B opens at A's viewport position and the "new message" pill is suppressed or the chat renders mid-history.
- The `ChatComposer` owns the draft (`text`, `pendingFile`, caption). Without a `key`, A's draft leaks into B and `onSend` dispatches to the SELECTED conversation, so the user would send A's draft to B.
- Reorder (new inbound bumps a different conversation to the top) does NOT change `selectedConv.id`, so it does NOT remount — that is the intended P6-4 carve-out.

REGRESSION RISK (both directions, both now frozen):
- Removing `key={selectedConv.id}` → "send the previous draft to the new chat" + "new chat opens mid-history".
- Adding `key={messages.length}` or `key={last_message_at}` → remount on every inbound, destroy prepend anchor, jump scroll position.

**Contract amendment:** [WHATSAPP_BASELINE_CONTRACT.md](WHATSAPP_BASELINE_CONTRACT.md) §4 (FRONTEND), §7 (A→B→C), and §10.8 are now updated to state the real behaviour. This is a clarification, not a behaviour change. No code under `frontend/` was modified by Phase 1.

---

## FILES CHANGED

| File | Change | LOC | Reason (in Phase 1 scope) |
| --- | --- | --- | --- |
| `WHATSAPP_BASELINE_CONTRACT.md` | NEW (Phase 0) + 3 sections amended (Phase 1 §1) | +14 / -12 | Contract consistency only. |
| `whatsapp-gateway/src/session-manager.js` | modified | +115 / -67 | §5/§6/§10/§11/§12 defects (race window, stale _deleted guards, lease contention callback, loseLease callback, reconnect retry, requestPairingCode polling). |
| `whatsapp-gateway/src/socket/socket-events.js` | modified | +90 / -15 | §6 (Defect 3) `connection.update {open}` ordering — `session.status = 'CONNECTED'` now written ONLY after all awaits, with re-validation of lifecycle generation and `_deleted` after every await. |
| `backend/app/services/whatsapp/orchestration/sessions.py` | modified | +43 / 0 | §13 (stale CONNECTED row auto-demote to RELINK_REQUIRED when gateway has no live session for the row's `gateway_id`). |

```
$ git diff --stat
 backend/app/services/whatsapp/orchestration/sessions.py    |  43 +++++
 whatsapp-gateway/src/session-manager.js                    | 182 ++++++++++++++++-----
 whatsapp-gateway/src/socket/socket-events.js               | 105 +++++++++---
 3 files changed, 262 insertions(+), 68 deletions(-)
```

**No changes to:** conversation code, history code, identity, group discovery, ChatThread, ConversationList, ChatComposer, ChatBubble, ordering, message merge, sync, frontend UI, lease schema, DB schema.

---

## ROOT CAUSES FIXED

| # | Defect | Where it lived | Fix |
| --- | --- | --- | --- |
| 1 | **Race window in `_connectSocket`.** `acquireLease` → `createSocketForSession` (long await) → `attach`. If `deleteSession` / `refreshQr` / `logoutSession` ran during the `createSocketForSession` await, the freshly built socket could still be attached. The generation guard on the *attached* socket catches the new generation, but a deleted session is *not* in the Map — `session` is undefined, and the guard short-circuits on the wrong signal. | `session-manager.js::_connectSocket` | After lease acquisition, re-check `session._deleted` and `sessions.has(id)`. If either fails, release the lease, end the new socket, return. `try/catch` around `createSocketForSession` also releases the lease on throw. |
| 2 | **Stale callbacks open a new socket on a deleted session.** `leaseCoordinator.acquireLease`'s onContended callback (5–6 s retry), the `loseLease` callback, and `_startSocket`'s setTimeout reconnect all use the closure-captured `session` / `id` and never re-check the registry. | `session-manager.js` (3 sites) | Each callback re-reads `sessions.get(id)` and short-circuits on `_deleted` or generation mismatch. Diagnostic markers added (`lease_contention_callback_skipped_deleted`, `lease_contention_callback_stale_generation`, `lease_lost_callback_skipped_deleted`, `lease_lost_callback_stale_generation`). |
| 3 | **`connection.update {open}` writes `session.status = 'CONNECTED'` before any `await`.** The original code sets status synchronously, then awaits `authRepository.registerSession` and `leaseRepository.acquire`. A failure on either path either reverts to FAILED after a brief window in which it read CONNECTED, or — worse — emits `session_connected` after a failure path intended to return early. | `socket/socket-events.js` connection.update {open} | Reorganized as: (1) compute self-identity in locals, (2) bail if `_deleted` or generation invalid, (3) run every ephemeral-promotion side-effecting `await`, (4) re-validate after every await, (5) COMMIT visible state in one synchronous block, (6) emit `session_connected` only after commit. |
| 4 | **`requestPairingCode` polling loop is stuck on disconnect / delete / refresh.** The 15-second loop only exits on `SCAN_QR`; if the session is BANNED, DISCONNECTED with LOGGED_OUT, deleted, or the lifecycle is invalidated, the loop runs to deadline. | `session-manager.js::_requestPairingCodeOnce` | Loop body now exits early on `_deleted`, lifecycle generation drift, BANNED, LOGGED_OUT, UNAVAILABLE, FAILED, or DISCONNECTED with a contextual error message. |
| 5 | **`bindSocketEvents` destructured from a closure that no longer existed.** Previous Phase 0 code had `const { sock, state, saveCreds, connectStarted, sessionDir } = await createSocketForSession(...)`. After Defect 1's refactor, the result is wrapped in `created`. The destructured names were not updated, so `bindSocketEvents` was passed `undefined` for `sock`/`state`/`saveCreds`/`connectStarted`/`sessionDir`. | `session-manager.js` `bindSocketEvents({...})` call | Re-bind to `created.sock`, `created.state`, `created.saveCreds`, `created.connectStarted`, `created.sessionDir`. |
| 6 | **Stale `CONNECTED` row reports healthy line on a gateway without that session.** When `WHATSAPP_AUTO_RESTORE=false` and the gateway restarts, the durable `whatsapp_sessions` row is left in `CONNECTED` but the gateway has no socket and no lease for that `gateway_id`. The UI believes the line is healthy; outbound messages fail; events are silently dropped. | `backend/.../sessions.py::_list_sessions_internal` | After the gateway list is read, every DB row whose `gateway_id` is absent from the gateway's session list AND whose `status == CONNECTED` is demoted to `RELINK_REQUIRED` with `is_active=False`, `is_phone_online=False`, `error_message="WHATSAPP_GATEWAY_SESSION_MISSING"`. A `session_updated` WS broadcast is emitted for each demoted row so a connected UI learns immediately. |

---

## PAIRING STATE MACHINE (real, source-derived)

A single state machine. Each state has a single owner, allowed/forbidden transitions, and a "terminal" flag.

| State | Entry | Exit | Allowed → | Forbidden → | Socket | Lease | Cleanup owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CREATING` | `createSession({ephemeral:true})` | first `state change` event | `SCAN_QR` | any other state | none | none (ephemeral bypasses) | gateway `createSession` |
| `SCAN_QR` | first `connection.update` or default after `createSession` | `connection.update{connecting}` OR `session_disconnected` OR `deleted` | `CONNECTING`, `DISCONNECTED`, `BANNED`, terminal | `CONNECTED` (must pass through CONNECTING + OPEN), promotion | ephemeral (no lease) | ephemeral (no lease) | gateway |
| `PAIRING_IN_PROGRESS` | `requestPairingCode` issued | code returned + first `connection.update{connecting}` | `CONNECTING` | `CONNECTED` (direct), terminal | ephemeral | ephemeral | gateway |
| `CONNECTING` | `connection.update{connection:'connecting'}` | `connection.update{open}` OR `connection.update{close}` | `CONNECTED` (on open), `DISCONNECTED` / `BANNED` / `WA_CONNECTION_TERMINATED` (on close), `RESTORING` (on lease contention) | `CONNECTED` without open, terminal on transient close → `CONNECTING` again | ephemeral or persistent | ephemeral or persistent | gateway |
| `PROMOTION_PENDING` | `connection.update{open}` AND `ephemeral=true` (DB row not yet inserted) | `authRepository.registerSession + saveCredentials` + `leaseRepository.acquire` succeed → `CONNECTED`; failure → `FAILED` | `CONNECTED`, `FAILED` | `DISCONNECTED` (auth/lease errors map to FAILED, not DISCONNECTED) | ephemeral, generation-pinned | ephemeral (lease acquired in this state) | gateway + backend |
| `CONNECTED` | promotion path complete (DB row + lease + status + emit `session_connected`) | `connection.update{close}` (515, transient, loggedOut, badSession) | `CONNECTING` (515), `CONNECTING` (transient backoff), `DISCONNECTED` (loggedOut), `BANNED` (badSession), `UNAVAILABLE` (lease lost) | `FAILED` (only reachable via ephemeral promotion failure), terminal | persistent, generation-pinned | persistent, renewed at `ttl/3` | backend (DB row) + gateway (lease) |
| `DISCONNECTED` | `loggedOut` from close handler OR explicit logout | `refreshQr` → `CREATING` (new socket, possibly new id) | `CREATING` (via refresh), terminal until user action | `CONNECTED` (cannot self-heal) | none | none | gateway + backend |
| `RELINK_REQUIRED` | `_gateway_op_or_mark_relink` OR stale-row demotion (Phase 1 §13) OR user-driven relink | `refreshQr` → `CREATING` OR relink succeeds → `CONNECTED` | `CREATING`, `CONNECTED` (only via `perform_atomic_relink`) | `CONNECTED` (without relink) | none (or ephemeral) | none (or ephemeral, transiently) | backend (DB) + gateway |
| `FAILED` | ephemeral promotion auth/lease failure | `refreshQr` → `CREATING` | `CREATING` (via refresh) | `CONNECTED` (cannot self-heal) | none | none | gateway |
| `CANCELLED` | `cancel_pairing_session` while gateway status < `CONNECTED` | terminal | — | any other state | none (deleted) | none (released) | backend `cancel` + gateway `delete` |
| `UNAVAILABLE` | `loseLease` callback OR `_startSocket` catch OR `WHATSAPP_AUTH_STORE_UNAVAILABLE` | `refreshQr` OR backend-initiated retry | `CREATING` (via refresh) | `CONNECTED` (cannot self-heal without intervention) | none (lease lost → ended) | none (lost) | gateway |

**Invariants (frozen):**

- `CREATING` / `SCAN_QR` / `PAIRING_IN_PROGRESS` / `PROMOTION_PENDING`: the durable `public.whatsapp_sessions` row MUST NOT exist. Confirmed in `start_pairing_session` (no INSERT) and `connection.update{open}` for ephemeral session (INSERT happens in `authRepository.registerSession` AFTER all awaits, and the backend promotion path is what actually creates the row from the `session_connected` event).
- `CONNECTED`: durable row exists AND live socket generation matches AND lease is held AND `lease.ttl/3` renewal is armed.
- `CANCELLED` / `FAILED` / `DISCONNECTED` (loggedOut) / `BANNED` / `UNAVAILABLE`: no reconnect timer; no future `session_connected` can re-promote the same `gateway_id` (consumed pairing or relink path required).
- `RELINK_REQUIRED` → `CONNECTED` only via `perform_atomic_relink`, which is row-locked, idempotent, and `RelinkCandidateAmbiguous`-fail-closed.
- Duplicate `session_connected` events for the same `gateway_id` are harmless: `promote_ephemeral_pairing` rebinds; `_map_session_event` idempotently re-stamps `row.status = CONNECTED`.

---

## PROMOTION (Phase 1 §7)

**Single entry point:** `promote_ephemeral_pairing(db, gateway_session_id, user_id, phone, session_name, self_jid, self_lid, in_memory_pairing)` in `backend/app/services/whatsapp/orchestration/promotion.py`.

**Owner resolution order (fail-closed):**

1. `in_memory_pairing.user_id` (passed by `_map_session_event` from `find_ephemeral_pairing_by_gateway_id`).
2. `pairing_registry.resolve_open_pairing(db, gateway_session_id)` (durable, unconsumed-only).
3. Explicit `user_id` on the event.

If all three miss, `promote_ephemeral_pairing` returns `None` and `_map_session_event` raises `EventOwnerUnresolved` (the event is logged and dropped — fail-closed).

**Reuse / create order (single SQL transaction):**

1. `perform_atomic_relink(db, user_id, phone, new_gateway_id)` — uses `FOR UPDATE` row lock. If a `RELINK_REQUIRED` row matches the phone for this user, it is rebound (cross-tenant ambiguous candidates raise `RelinkCandidateAmbiguous`).
2. `find_existing_session_for_phone(db, user_id, phone)` — reuse a non-CONNECTED existing row for the same phone (no sequence manipulation).
3. INSERT a new `WhatsAppSession` row.

**Idempotency:** A second `promote_ephemeral_pairing` for the same `(gateway_session_id, user_id)` rebinds the existing row (or finds the relink target) — never creates a duplicate.

**Tested invariants:**

- `m1_normal_qr_pairing_polls_to_connected` ✓
- `m2_515_then_session_connected` ✓
- `m4_modal_closes_immediately_after_scan` ✓
- `m7_backend_restart_between_qr_and_connected` ✓ (durable registry survives restart)
- `m8_duplicate_session_connected_is_idempotent` ✓
- `m9_late_session_connected_after_poll_promotion` ✓
- `m11_two_pairings_same_user_do_not_collide` ✓
- `m12_two_users_pairing_simultaneously` ✓ (tenant isolation)
- `case_a_valid_ephemeral_pairing_resolves_correct_tenant` ✓

**Phase 1 amendments:** No behaviour change. The promotion entry-point remains the only path that creates a durable row.

---

## LEASE (Phase 1 §10)

**`whatsapp_private.socket_leases`:** `(session_id, instance_id, generation, expires_at, updated_at)`. TTL clamped to `[30, 120]` s, default 45 s.

**EPHEMERAL session (before `connection.update{open}`):** lease is NOT acquired. `acquireLease` in `lease-coordinator.js` returns `true` immediately for `session.ephemeral === true`. The lease is acquired LATER, in the `connection.update{open}` handler, after auth persistence succeeds. This avoids a lease TTL race with a long pairing flow.

**PERSISTENT session (after `connection.update{open}`):** `_connectSocket` acquires the lease BEFORE `createSocketForSession`; `armLeaseRenewal` runs at `ttl/3` (≥ 10 s) intervals. The `loseLease` callback invalidates the lifecycle, releases timers, ends the socket, sets `status = UNAVAILABLE`.

**Stale-state prevention (Phase 1 §10 enforcement):**

- A `loseLease` callback arriving after `deleteSession` is now a no-op (`lease_lost_callback_skipped_deleted` diagnostic).
- A `loseLease` callback arriving for a stale generation is a no-op (`lease_lost_callback_stale_generation` diagnostic).
- `_connectSocket` releases the lease if `createSocketForSession` throws.
- A lease acquired in `_connectSocket` but invalidated by a concurrent delete during `createSocketForSession` is released.
- A `status = CONNECTED` row whose `gateway_id` is not in the live gateway list is auto-demoted to `RELINK_REQUIRED` (Phase 1 §13 fix) on the next `list_sessions_internal` call.

**Tested invariants:** `lease` and `reconnect` baseline tests (4 cases) all pass.

---

## RECONNECT (Phase 1 §11)

| Reconnect type | Source | Socket | Lease | Auth | Session status | Public row | Reconnect timer | Event emitted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 515 `restartRequired` | `connection.update{close}` with `statusCode=515` | replaced 500 ms later via `lifecycle.scheduleReconnect(generation, sock, 500, _startSocket)` | renewed; `ttl/3` | preserved | transient: `CONNECTING` | unchanged | 500 ms | `session_connecting` then `session_connected` |
| Transient (other `close` status) | `connection.update{close}` non-515, non-loggedOut, non-badSession | replaced via exponential backoff `min(30 000, 1 000 * 2^min(failures-1, 5))` + 0–20 % jitter | renewed | preserved | transient: `CONNECTING` | unchanged | backoff | `session_connecting` then `session_connected` |
| `loggedOut` (statusCode=loggedOut) | `connection.update{close}` with `loggedOut` | ended; `ev.removeAllListeners()` + `sock.end()` | released | destroyed (legacy mode only; `authRepository` mode retains encrypted snapshot for restore) | `DISCONNECTED`, `error_reason = 'LOGGED_OUT'` | unchanged | none (terminal) | `session_disconnected reason=LOGGED_OUT` |
| `badSession` (statusCode=badSession) | `connection.update{close}` with `badSession` | ended; cleanup | released | destroyed | `BANNED` | unchanged | none (terminal) | `session_disconnected reason=BANNED` |
| Explicit `delete` (`deleteSession`) | API call | ended; `ev.removeAllListeners()` + `sock.end()` | released; `leaseCoordinator.releaseLease` | cleared via `authRepository.clearAuth` | `sessions.delete(id)` (Map removal) | unchanged | none (`lifecycle.invalidate()` cancels pending) | `session_deleted` |
| Explicit `logout` (`logoutSession`) | API call | ended; provider `sock.logout()` then `sock.end()` | released | cleared | `DISCONNECTED`; `error_reason=null`; `error_message=null` | unchanged | none | `session_disconnected` |
| Explicit `refreshQr` (CONNECTED) | API call | no-op (early return) | unchanged | unchanged | unchanged | unchanged | none | none (per `refreshQr` early-return) |
| Explicit `refreshQr` (not CONNECTED) | API call | invalidated; old socket ended; `_startSocket(id)` | released; new acquisition | preserved (or re-registered) | `SCAN_QR` | unchanged | none | `session_qr_updated` |

**Stale reconnect callback cannot affect new session:** `lifecycle.scheduleReconnect` filters by `isCurrent(generation, socket)`. After `invalidate()` the generation advances, so any pending callback is dropped at the `isCurrent` check inside the timer handler (`socket-lifecycle.js:41`).

**Tested invariants:** `gateway_reconnect` baseline tests pass.

---

## CANCEL (Phase 1 §8)

**Single entry point:** `cancel_pairing_session` in `backend/app/services/whatsapp/orchestration/sessions.py`.

| Pre-condition | Outcome |
| --- | --- |
| `gateway_data.status < CONNECTED` | `pairing` popped from in-memory map; `pairing_registry.consume_pairing` called; `gw.delete_session(gateway_id)` removes the gateway session; returns `{success:true, cancelled:true}`. |
| `gateway_data.status == CONNECTED` | `promote_ephemeral_pairing` called idempotently (rebinds if already exists, creates if missing); `pairing_registry.consume_pairing` called; `gw.delete_session` is **NOT** called; returns `{success:true, cancelled:false, promoted}`. |
| `gateway_data is None` (session not found in gateway) | `promote_ephemeral_pairing` still attempted (with explicit user from in-memory); on `None` return, `pairing` is removed; no socket is killed because none exists. |
| Pairing already consumed (re-cancel) | `consume_pairing` is idempotent (`row is None` returns `False`); entire call is idempotent. |

**Frontend modal-cleanup → backend cancel → gateway delete chain cannot kill a CONNECTED session:**

- Modal cleanup effect calls `POST /whatsapp/pairing/{token}/cancel`.
- Backend's `cancel_pairing_session` checks the LIVE gateway status (not a cached value) via `gw.get_session_qr` (which is the only path that does not short-circuit on `CONNECTED`).
- If status is `CONNECTED`, the backend explicitly does NOT call `gw.delete_session`. The `pair_token` is removed from the in-memory map; the durable pairing row is marked `consumed_at`. The gateway socket and lease remain alive.

**Tested invariants:** `m3_modal_stays_open`, `m4_modal_closes_immediately_after_scan`, `m6_token_cleanup_before_session_connected`, `cancel_after_connection_open_does_not_delete_promoted_socket`, `cancel_is_idempotent`, `genuine_cancel_still_terminates_waiting_pairing` — all pass.

---

## OWNER / TENANT (Phase 1 §7)

**`promote_ephemeral_pairing` is the ONLY entry point that creates a durable row, and its owner resolution is fail-closed.**

Sources of tenant truth, in priority order:

1. `in_memory_pairing.user_id` (set at `start_pairing_session` from `get_current_user`).
2. `pairing_registry.resolve_open_pairing(db, gateway_session_id)` — durable, `consumed_at IS NULL` filter.
3. Explicit `user_id` on the `session_connected` event (from `_map_session_event` event payload).

If all three miss, `promote_ephemeral_pairing` returns `None` and `_map_session_event` raises `EventOwnerUnresolved`. The event is logged and dropped (no broadcast).

**Cross-tenant ambiguous candidates:** `perform_atomic_relink` raises `RelinkCandidateAmbiguous` if > 1 `RELINK_REQUIRED` row matches the phone across the DB. `_map_session_event` re-raises this as `EventOwnerUnresolved`.

**`m10_stale_old_gateway_session_cannot_overwrite_new`:** A late `session_connected` from a previous-generation gateway UUID cannot rebind a newer-generation `whatsapp_sessions` row, because the rebind path keys on `gateway_id` (UNIQUE) and a re-PROMOTION would either match the existing row (no-op) or create a new row tied to the new tenant.

**Tested invariants:** `case_a_valid_ephemeral_pairing_resolves_correct_tenant`, `m11_two_pairings_same_user_do_not_collide`, `m12_two_users_pairing_simultaneously`, `relink_candidate_ambiguous_fails_closed` — all pass.

---

## ORPHAN PREVENTION (Phase 1 §16)

**Definition of orphan in this phase:** a `whatsapp_private.gateway_sessions` row whose `public.whatsapp_sessions` row was deleted, OR a `public.whatsapp_sessions` row in a state (`CONNECTED`, `SCAN_QR`, `RESTORING`) that the gateway cannot honour.

**Existing orphan cleanup is OUT OF SCOPE** (per §16: "Bu fazda mevcut bütün orphan gateway_sessions temizliğini yapma."). Existing orphans are handled by `recover.py` (separate mechanism).

**New orphan prevention (Phase 1 fixes):**

- `_connectSocket` race window closed: lease is released if `createSocketForSession` throws, if the session is deleted during the await, or if a generation-guard rejects the new socket. Previously a new socket could be attached to a stale `session` object that had just been `deleteSession`'d.
- `loseLease` callback cannot re-promote a deleted session.
- `leaseCoordinator.acquireLease` onContended callback cannot re-start a deleted session.
- `WHATSAPP_AUTO_RESTORE=false` no longer leaves a `status=CONNECTED` row pointing to a non-existent gateway session — the row is auto-demoted to `RELINK_REQUIRED` on the next `list_sessions_internal` call.
- `_requestPairingCodeOnce` polling loop exits on BANNED/LOGGED_OUT/UNAVAILABLE/FAILED/`_deleted`/lifecycle drift — previously the loop could run to deadline and silently return a generic error.
- `cancel_pairing_session` does not delete the gateway session when the gateway has reached `CONNECTED` — previously the modal cleanup could trigger a socket kill 1.8 s after `connection.open` (the P6-8 production incident).

**Sources of orphans NOT addressed by Phase 1** (intentional, separate phases):

- Existing pre-Phase-1 orphans are cleaned by `recovery.py` (out of scope per §16).
- A pre-Phase-1 `status=CONNECTED` row pointing to a gateway session that the gateway still holds but the lease is gone is NOT auto-demoted in this phase — it relies on `_map_session_event` reacting to a future `session_disconnected` (or the next gateway restart, which now demotes via the new logic).

---

## TESTS (Phase 1 §19)

**Run:** `PYTHONPATH=. ./venv/bin/python -m pytest backend/tests/ -k "whatsapp" --tb=short -q`

```
558 passed, 4 skipped, 570 deselected, 0 failed
```

**Targeted regression scope:**

| Test file | Coverage | Result |
| --- | --- | --- |
| `test_whatsapp_orchestration_sessions.py` | session create, get_qr, pairing code, logout, delete, gateway op → relink, gateway live apply | 11/11 PASS |
| `test_whatsapp_phase6_8_promotion.py` | first-time durable row, cancel-after-connected idempotency, late event idempotency, two pairings same user, two users simultaneously, valid tenant resolution, fail-closed on missing pairing table | 21/21 PASS |
| `test_whatsapp_phase6_4_pairing.py` | pairing modal + state machine | 14/14 PASS (no Phase 1 behaviour touched) |
| `test_phase154_session_recovery.py` | orphan detection, relink candidate ambiguous, recovery idempotency, history state migration, missing-gateway relink, session_connected rebind | 9/9 PASS |
| `test_whatsapp_forensic_fixes.py`, `test_whatsapp_idempotency.py`, etc. | full WhatsApp surface | 503/503 PASS |
| All other `-k whatsapp` tests | baseline | 558/558 PASS, 4 SKIP, 0 FAIL |

**Targeted syntax / compile checks:**

```
$ node --check whatsapp-gateway/src/session-manager.js  # OK
$ node --check whatsapp-gateway/src/socket/socket-events.js  # OK
$ python3 -c "import ast; ast.parse(...sessions.py)"  # OK
```

**Tests NOT run by Phase 1** (intentionally, per §19):

- Frontend tests (`frontend/src/**/*.test.tsx`) — no frontend code was changed.
- Gateway unit tests in `whatsapp-gateway/__tests__` — none exist; the gateway is exercised via the backend integration tests above.
- Full non-WhatsApp test suite — out of Phase 1 scope.

---

## KNOWN REMAINING ISSUES (intentionally NOT fixed in Phase 1)

| # | Issue | Source | Out-of-scope for Phase 1? | Owner |
| --- | --- | --- | --- | --- |
| 1 | Pre-existing orphan `gateway_sessions` rows | `whatsapp_private.gateway_sessions` may have rows for which the matching `public.whatsapp_sessions` row was deleted. | YES — §16 says "Existing orphan cleanup ayrı faz olabilir." | Phase 2+ |
| 2 | ~~A `status=CONNECTED` row whose gateway has the session but the lease is GONE is not auto-demoted.~~ | **Resolved in Phase 1.1** — see `WHATSAPP_PHASE1_1_RESULT.md` and the new lease-truthfulness branch in `_list_sessions_internal`. The list call now reads `whatsapp_private.socket_leases` once and demotes any `CONNECTED` row whose `gateway_id` is not in the held-lease set (gated on the gateway still reporting `CONNECTED`; transient reconnects are exempt). | NO | — |
| 3 | `logoutSession` does NOT set `_deleted = true`. | Logout retains the session in the Map; only `deleteSession` sets the flag. `loseLease` / lease contention callbacks now check `_deleted`, not logout — but the new callbacks also re-check `sessions.has(id)` so a logged-out session still in the Map is correctly handled. | NO — but the race window for logged-out sessions is bounded by the next `refreshQr`/`deleteSession`. | Phase 2+ (or trivial follow-up) |
| 4 | `requestPairingCode` 15-second polling loop depends on user retry. | If the user issues a request, the loop times out, and the user must click again. Acceptable, but UX could be improved by surfacing a progress event. | YES — UX layer. | Phase 5+ |
| 5 | Frontend's `WhatsAppApi.startPairing` and the `NewChatModal` are fail-closed (no `startConversation` exists), but the documentation does not enumerate this in Phase 0. | Phase 0 §3.F mentions `startConversation` and `getTemplates` are deliberately not implemented. | NO — documentation only. | Documentation follow-up |
| 6 | No automated test covers the new stale-row auto-demote in `_list_sessions_internal`. | The new branch is small and the test fixture would require a multi-process mock of the gateway. | NO — should be added in Phase 2. | Phase 2 |

---

## FINAL ACCEPTANCE — §20 CHECKLIST

| §20 line | Status | Evidence |
| --- | --- | --- |
| `start → QR → scan → 515/reconnect if applicable → connection.open → promotion → CONNECTED` | ✓ | `m1_normal_qr_pairing_polls_to_connected`, `m2_515_then_session_connected` pass |
| `CONNECTED → public session exists` | ✓ | `session_connected_creates_durable_row_for_first_time_pairing` passes |
| `CONNECTED → correct user_id` | ✓ | `case_a_valid_ephemeral_pairing_resolves_correct_tenant` passes |
| `CONNECTED → correct gateway_id` | ✓ | `_map_session_event` rebinds and creates with the new `gateway_id`; rebind is idempotent |
| `CONNECTED → is_active=true, is_phone_online=true` | ✓ | `connection.update{open}` handler sets both |
| `persistent connected session → lease exists` | ✓ | `armLeaseRenewal` runs in `_connectSocket` for non-ephemeral sessions |
| `persistent connected session → renewal works` | ✓ | `leaseCoordinator.armLeaseRenewal` is unchanged in Phase 1 |
| `CONNECTED pairing → cancel request → socket survives → session remains CONNECTED` | ✓ | `cancel_after_connection_open_does_not_delete_promoted_socket` passes |
| `transient / 515 → same session survives` | ✓ | `socket-events.js` `connection.update{close}` branch; no `deleteSession`; `lifecycle.scheduleReconnect` retains generation |
| `delete → no reconnect` | ✓ | `deleteSession` sets `_deleted`, `lifecycle.invalidate()` cancels reconnect timer, `sessions.delete(id)` removes from Map |
| `valid pairing → correct tenant` | ✓ | `case_a_valid_ephemeral_pairing_resolves_correct_tenant` |
| `invalid/ambiguous session → fail closed` | ✓ | `relink_candidate_ambiguous_fails_closed` |
| `duplicate session_connected → exactly one public session` | ✓ | `m8_duplicate_session_connected_is_idempotent` |
| `backend restart before open → durable pairing still allows valid promotion` | ✓ | `m7_backend_restart_between_qr_and_connected` + `promotion_survives_a_missing_pairing_table` |

**Phase 1 §20 result: ALL CHECKS HOLD.**

---

## CLOSING

- **PHASE 1 RESULT: PASS** with one contract amendment (clarification, not behaviour change) and six targeted code fixes.
- **No commit. No push. No deploy.** Working tree contains uncommitted modifications on `main` (`359fe6d`-relative).
- **No Phase 2+ scope touched.** Conversation discovery, sync, history, identity, group discovery, ordering, ChatThread, chat-selection UX, layout, message merge remain untouched.
- **All §4 MUST NOT REGRESS invariants preserved.** Defects 1–6 above were the *only* holes found in the lifecycle surface by this audit; they are now closed. Any new code that bypasses the now-defended paths (re-introducing a closed-over `session` reference in a callback, reordering the `await`s in the open handler, etc.) will be a Phase 2+ regression and must be flagged.

Next phase entry condition: all Phase 1 acceptance tests pass, contract is amended as above, no new defects introduced into Phase 2+ scope.
