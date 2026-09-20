# Ephemeral Pairing Session Leak — Production Diagnosis

**Read-only investigation.** No production state was modified. No code was changed.
Everything below is either a **read-only query**, a **log observation**, or a **code reading with file:line**.

Investigated: 2026-09-19 22:30–22:40 UTC, on `130.162.247.20` (`/opt/tezlify`, deployed `6f4aa00`),
triggered by the post-deploy health check.

**Status of the deploy itself: healthy.** 4/4 containers up (caddy/backend/gateway healthy, db up 4 days),
HEAD `6f4aa00`, `frontend_candidate` → `releases/v20260919_phase6_5_lid_scope_and_lease`, served asset
`index-DPQvI-dK.js`. Gateway `RestartCount=0`. **The findings below are pre-existing defects that the deploy
made *visible*, not regressions introduced by it** — with one explicit exception noted in F6.

---

## Summary

| # | Finding | Severity | Proven by |
|---|---|---|---|
| F1 | A **cancelled** pairing keeps reconnecting forever — live right now | **High** | production logs |
| F2 | Ephemeral gateway sessions are **never reaped** — 31 orphans | Medium | production DB |
| F3 | `event_outbox` **cannot store** ephemeral-session events (FK 23503) | Medium | code + 74 log hits |
| F4 | **1341 / 2289** outbox rows are permanently undeliverable | Medium | production DB |
| F5 | Transient **event storm** — 2065 dropped events in 60 s | Low (stopped) | production logs |
| F6 | Pairing map is **in-memory** → any backend restart orphans pairings | Medium | code reading |

F1–F5 are one systemic issue: **No-Create ephemeral sessions create private `gateway_sessions` rows but no
public `whatsapp_sessions` rows, and nothing ever reaps them.** The backend then cannot attribute their events,
the outbox cannot store them, and the gateway keeps them alive indefinitely.

---

## F1 — A cancelled pairing keeps looping (live, ongoing)

Session `cca3daa08c26` (gateway `session_ref`).

```
22:10:51.143  socket_connect_started   generation 1, auth_json_files 0, registered false
22:12:28      POST /pairing/a7b1268c-29d5-4bdb-8b13-2ee24a4eb053/cancel  ->  200 OK
22:32:26.963  socket_connection_transition  generation 9, connection "connecting"
22:36:47      (still active) generation 10, 12 log lines in the last 5 min
```

The session was created at epoch `1789855851` = **22:10:51 UTC**, which is byte-for-byte the timestamp of
`POST /api/v1/whatsapp/pairing/start` #1. That pairing's token was **explicitly cancelled 97 seconds later**.
**It has now been reconnecting for 26 minutes and survived the cancel by 24 minutes and counting.**

Every disconnect is `status_code 408`, `reason: "transient_disconnect"`, with
`auth_json_files: 0`, `encrypted_snapshot_present: false`, `registered: false` — i.e. a socket with **no
credentials at all**, retrying forever. 8 × `socket_reconnect_scheduled`, 8 × `socket_owner_replaced`,
generation climbing 1 → 10.

### Why this means the DELETE never arrived

`deleteSession()` (`whatsapp-gateway/src/session-manager.js:1325`) sets `session._deleted = true`, calls
`session.lifecycle.invalidate()`, ends the socket, and removes the session from the map.

`invalidate()` (`whatsapp-gateway/src/domain/socket-lifecycle.js:53-57`) does:

```js
invalidate() {
  this.cancelReconnect();     // clearTimeout(handle); this._reconnectTimer = null
  this._generation += 1;
  this._socket = null;
}
```

and the timer callback is **double-guarded** (`socket-lifecycle.js:36-45`):

```js
const handle = this._setTimer(() => {
  if (this._reconnectTimer !== handle) return;   // guard 1: cleared -> null !== handle -> return
  this._reconnectTimer = null;
  if (this.isCurrent(generation, socket)) callback();   // guard 2: generation bumped -> false
}, delayMs);
```

So a deleted session **cannot** reconnect. The observed loop therefore proves that
**`deleteSession()` was never called for `cca3daa08c26`** — the failure is in the *backend's* bookkeeping
(`cancel_pairing_session`, `backend/app/services/whatsapp/orchestration/sessions.py:430-445`), not in the
gateway's lifecycle code.

> **Not yet proven:** *why* the call was skipped. `cancel_pairing_session` only deletes when the token is still
> present in `_ephemeral_pairings` **and** `pairing["user_id"] == str(user_id)`. Candidate causes, in
> likelihood order: (a) a concurrent `GET /sessions/{id}/qr` re-registered `_logical_to_ephemeral[row.id]`
> under a **new** token (F6), leaving the old token's session unreachable; (b) the entry had already been
> popped; (c) a user_id mismatch. Distinguishing these needs a local reproduction with the existing harness.

---

## F2 — Ephemeral sessions are never reaped

```sql
SELECT count(*) FROM whatsapp_private.gateway_sessions;   -- 34
SELECT count(*) FROM public.whatsapp_sessions;            -- 3
```

**31 of 34 private rows have no public counterpart.** Every one has `is_active = false`. The names are the
tell — an abandoned pairing's default line name:

```
Hat 1 ×27   (incl. 4ed446af-…, 2d0751bf-…, 97f5c636-…, 8f133803-…)
PHASE12_REAL_E2E, PHASE12_E2E, Temp QR Modal Test Line, Temp QR Modal Second Attempt
deploy-verify-persistent, deploy-verify-renewal      <- my own Phase-10 test residue
```

Nothing in the codebase deletes them. `deleteSession` removes a row only when it is *called*; the orphan rows
are exactly the sessions for which it never was.

---

## F3 — `event_outbox` cannot store ephemeral events

**The constraint:**

```
event_outbox_session_id_fkey :: FOREIGN KEY (session_id)
  REFERENCES whatsapp_private.gateway_sessions(session_id) ON DELETE CASCADE
```

**The asymmetry.** `registerSession()` — the only writer of `gateway_sessions` — is guarded:

```js
// whatsapp-gateway/src/session-manager.js:1121
if (authRepository && persistRegistry && !ephemeral) {
  await authRepository.registerSession(id, name, { active: true });
}
```

The lease has the identical guard (`session-manager.js:2568`):

```js
if (leaseRepository && !session.ephemeral) { ... }
```

**But the outbox has no such guard** (`whatsapp-gateway/src/events.js:224-241`):

```js
if (eventOutbox) {
  try {
    const durableEvent = await eventOutbox.enqueue(event);   // <- INSERT ... FK 23503
    sendLocal(durableEvent);
    await pumpOutbox();
  } catch (error) {
    diagnostic('event_outbox_enqueue_failed', { ... error_code: error?.code ... });
    deliverBestEffort(event);
  }
  return;
}
```

`enqueue()` (`whatsapp-gateway/src/outbox/postgres-event-outbox.js:32-48`) INSERTs unconditionally.
For a session with no `gateway_sessions` row — i.e. **every ephemeral session, by design** — the INSERT
fails **23503**.

**Measured in production:**

```
event_outbox_enqueue_failed : 74 occurrences in 40 min
event_type distribution     : session_qr_updated ×58, session_connecting ×16
error_code                  : 23503 (100%)
```

**Impact, stated honestly:** the event is **not lost** while the backend bridge is up — the `catch` falls
through to `deliverBestEffort()`, which is deliberate (G-10(c)). What *is* lost is **durability**: the event
never reaches the outbox, so if the bridge is down at that instant the only copy is the 500-entry in-memory
`fallbackBuffer`, which silently drops on overflow. Each failure also costs a failed statement (~6.7 ms,
the same cost measured in `WHATSAPP_QR_LATENCY_DIAGNOSIS.md`) and emits a diagnostic line.

The correct shape is the **same one already applied twice** — gate the outbox on `!session.ephemeral` at the
`publish()` call site, exactly as `registerSession` and `armLeaseRenewal` are gated.

---

## F4 — 1341 of 2289 outbox rows can never be delivered

```
outbox_state: DELIVERED   = 1611
outbox_state: DEAD_LETTER =  678
outbox_state: PENDING     =    0

undeliverable (no public whatsapp_sessions row) = 1341
deliverable   (maps to a public session)        =  948   (= a618f89c-…, the CONNECTED line)

oldest row: 2026-09-14 16:15:32   (5 days old)
newest row: 2026-09-19 22:16:36
```

`resolve_event_owner()` (`backend/app/services/whatsapp/repositories/sessions.py:116-145`) raises
`EventOwnerUnresolved` for any event whose `session_id` has no `whatsapp_sessions.gateway_id`. Because the
public table holds only **3** rows while 31 gateway session ids have come and gone, the majority of the outbox
backlog is addressed to sessions that no longer exist. **59% of the outbox is dead weight** — it can never be
attributed, never delivered, and `cleanup()` only reaps `DELIVERED` after 24 h and `DEAD_LETTER` after 7 days.

---

## F5 — Transient event storm (stopped)

```
22:16:35  WARNING Gateway olayi sahibi cozulemedi, atlandi (event=conversation_updated,
          session=4ed446af-cc1a-4679-9828-d110cce64f57, jid=905076382749@s.whatsapp.net)
          (son 60 sn'de 2065 olay atlandi)
22:17:57  ... (son 60 sn'de 2065 olay atlandi)
22:19:07  ... (son 60 sn'de 1032 olay atlandi)
22:20:37  ... (son 60 sn'de 1032 olay atlandi)
```

**2065 events dropped in a single 60-second window**, each logging a WARNING. `4ed446af-…` is
`session_name='Hat 1'`, `is_active=false`, with **519 outbox rows** — a superseded line whose events the
backend can no longer attribute. Currently **0 in the last 60 s** (all outbox rows are terminal, so nothing is
being replayed); the storm coincided with the 22:16 pairing attempt and is most plausibly that session's
initial Baileys sync burst. **Mechanism inferred, not proven.**

The rate-limited orphan logger (`events.py:98-118`) is what keeps this from being an unbounded log flood —
worth knowing that it works, and that the counts it prints are real.

---

## F6 — The pairing map is in-memory, so restarts orphan pairings

```python
# backend/app/services/whatsapp/orchestration/sessions.py:229-230
_ephemeral_pairings: Dict[str, Dict[str, Any]] = {}
_logical_to_ephemeral: Dict[int, str] = {}
```

Process-local dicts. **A backend restart erases them**, so every live ephemeral pairing becomes
undeletable-by-token — its gateway session (a different container) keeps running and can never be cancelled.
This is the one finding the deploy **did** exercise: the backend was recreated, wiping the map.

It compounds with `get_session_qr()` (`sessions.py:494-550`), which **creates a new ephemeral gateway session**
whenever the logical session is `RELINK_REQUIRED` and its ephemeral is missing:

```python
# sessions.py:529-544
if not pairing or not eph_data:
    line_name = row.session_name or f"Hat {datetime.utcnow().strftime('%H:%M')}"
    gw_session = await gw.create_session(line_name, ephemeral=True)
    ...
    pair_token = str(uuid.uuid4())
    _ephemeral_pairings[pair_token] = { ... "gateway_id": ephemeral_gid, ... }
    _logical_to_ephemeral[row.id] = pair_token      # <- OVERWRITES any previous token
```

`whatsapp_sessions.id=5` **is** `RELINK_REQUIRED` in production. So every poll of that endpoint while its
ephemeral is unavailable spawns another gateway session, and line 544 **overwrites** the logical→token
mapping — orphaning the previous entry (and its gateway session) with no reference left to delete it.
The orphan rows in F2, overwhelmingly named `Hat 1`, are the accumulated result.

---

## Recommended fixes (NOT applied — no code was changed)

Ordered by risk-reduction per unit of change. All three are small and mirror patterns already in the codebase.

1. **Gate the outbox on `!ephemeral`** at `events.js:224`, matching `session-manager.js:2568` and `:1121`.
   Removes 100% of the 23503 failures; the `deliverBestEffort` path already handles the non-durable case
   correctly, so behaviour for ephemeral sessions is unchanged apart from no longer attempting the INSERT.
2. **Reap orphan `gateway_sessions` rows.** On startup, and/or on a timer: list gateway sessions, and delete
   any with `is_active=false` and no public `whatsapp_sessions.gateway_id` older than N minutes. This is what
   would have killed `cca3daa08c26`.
3. **Make the pairing map durable**, or make `get_session_qr` reuse-before-create idempotently and stop
   overwriting `_logical_to_ephemeral[row.id]` (line 544) when an entry already exists. Persisting
   `_ephemeral_pairings` to `whatsapp_private` would survive restarts and make cancels reliable.

Also worth a look, smaller: `cleanup()` could reap `DEAD_LETTER` rows whose `session_id` has no public
session immediately rather than after 7 days (F4).

## Immediate operational action

`cca3daa08c26` is a live, looping, credential-less socket. It is harmless to data — it emits no WhatsApp
traffic, because it can never authenticate — but it consumes CPU and network and is the direct source of the
`event_outbox_enqueue_failed` noise. **The only way to stop it today is to recreate the gateway container**
(`docker compose up -d --force-recreate gateway`), which clears the in-memory session map. That is a
production write and was **not** performed — it needs your approval, and it will also drop any other live
session, so it should be scheduled rather than done casually.

## What was NOT determined

- Which of the three candidate causes in F1 actually fired. A local reproduction using the existing
  `scripts/pairing-harness.mjs` + `fake-baileys.mjs` (no production DB needed) can settle it — create an
  ephemeral session, drive it into the `transient_disconnect` path, then call `deleteSession()` and assert the
  reconnect never fires. That tests the gateway half, which I have already shown to be correct by reading;
  the useful version drives `cancel_pairing_session` against the backend service instead.
- Whether the F5 storm's 2065 events were a Baileys initial sync or an outbox replay. Inferred, not proven.
- Whether F1's session belongs to a real user's abandoned modal or to an automated probe. The pairing calls all
  came from one IP (`104.28.244.150`, Cloudflare) via the UI's own endpoints.
