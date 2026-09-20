# WhatsApp QR Latency — Local vs Oracle Production Diagnosis

**Date:** 2026-09-19/20 · **Mode:** measure-only (no code change, no commit, no push, no deploy)
**Local HEAD:** `91dbfe6` · **Oracle HEAD:** `f6ec68d`
**Method:** real Chrome/CDP + real FastAPI + real Node gateway + real Baileys + real PostgreSQL, both sides.

---

## L. CRITICAL OUTPUT (the 5 answers)

| # | Question | Answer |
|---|---|---|
| 1 | **Local first QR** | **744–1428 ms** (p50 **1046 ms**) |
| 2 | **Oracle first QR** | **21 023–27 149 ms** (p50 **21 632 ms**) |
| 3 | **Largest latency interval** | **T2–T0**: `POST /pairing/start` → gateway `POST /sessions` = **~21.6 s** (local: 9–60 ms) |
| 4 | **Exact root cause** | `createSession` → `syncLidMappingsFromDisk` finds **2 741** `lid-mapping-*.json` files and fires **2 741** fire-and-forget `persistLidMappingToDb` INSERTs. The new ephemeral session has no `gateway_sessions` row, so **all 2 741 violate `lid_mappings_session_id_fkey` (23503)**. Each *failed* INSERT costs ~6.6–7.5 ms in the error/rollback path ⇒ **~18–21 s**, and `POST /sessions` cannot return until it drains. Local has **0** such files ⇒ **0** inserts ⇒ 60 ms. |
| 5 | **Code change required?** | **NO NEW FIX NEEDED — the fix already exists locally.** The missing commit is **`2d13064`** ("fix(whatsapp): backend, core and gateway correctness fixes (Phases 3-6)"), which is **not in Oracle's history**. Deploying HEAD resolves the 21 s delay *and* the cross-tenant leak. A **second, independent** defect also remains: Oracle lacks the Phase 6.5 G-LEASE fix, which kills every session ~14.6 s after it opens. |

---

## M. THE MISSING COMMIT — one omission, two bugs

Oracle's `f6ec68d` has **no** `lidScopeSessionIds`, **no** `lidScopeFor`, **no** `loadSessionOwners` — the
entire G-3 tenant-scoping machinery is absent. Its directory scan is unfiltered:

```js
// f6ec68d
for (const item of fs.readdirSync(sessionsDir)) {
  if (fs.statSync(itemPath).isDirectory()) scanDirs.add(itemPath);   // EVERY session dir
}
```

versus HEAD:

```js
// HEAD — 2d13064
if (sessionId && !scope.has(String(item))) continue;                 // tenant-bounded
```

`git log -S` attributes **both** `lidScopeSessionIds` and the `scope.has(...)` filter to
**`2d13064`**, and `git merge-base --is-ancestor 2d13064 f6ec68d` fails ⇒ **missing from production**.

### Proof on Oracle's real data (HEAD's actual exported function)

Oracle's `public.whatsapp_sessions`: `a618f89c` → tenant `e512dd40-…`; two others → the system user.
A brand-new ephemeral pairing has **`ownerId = null`**.

```
HEAD (2d13064) scope      = [ <newSessionId> ]      size 1
HEAD dirs scanned         = 1
HEAD lid files read       = 0
HEAD INSERTs attempted    = 0     ⇒ 0 FK violations

f6ec68d dirs scanned      = 6   (ALL — no scope filter)
f6ec68d lid files read    = 2741
f6ec68d INSERTs attempted = 2741  ⇒ all 23503 (new session has no gateway_sessions row)
```

**So the same missing commit produces both symptoms:**

1. **The 21 s QR delay** — 2 741 doomed INSERTs blocking `POST /sessions`.
2. **A cross-tenant LID-mapping exposure (G-3)** — `f6ec68d` reads 5 directories it must not,
   including `a618f89c`, which belongs to a **different tenant** (`e512dd40-…`) than the one pairing.
   Those mappings are mixed into the new session's in-memory store and written under its id.

This is why "just deploy HEAD" is the correct fix rather than a bespoke patch: the performance
defect and the isolation defect are the same omission.

---


## A. VERSION / CONFIG PARITY

**Oracle is 18 commits BEHIND local. `f6ec68d` is an ancestor of `91dbfe6`; Oracle has 0 commits local lacks.**

| Item | Local | Oracle | Match |
|---|---|---|---|
| git commit | `91dbfe6` | `f6ec68d` | **NO — 18 behind** |
| working tree | 3 untracked | **13 modified** | NO |
| Baileys | 7.0.0-rc14 | 7.0.0-rc14 | YES |
| Node | 22.22.2 | **20.20.2** | NO |
| Python | 3.13.12 | 3.12.14 | NO (both satisfy AGENTS.md "3.12+") |
| PostgreSQL | 17.11 | 17.11 | YES |
| frontend build | Vite dev | `index-Dmup1g3A.js` / `v20260918_phone_locale_and_baileys_lid_fix` | n/a |
| gateway image | bare node | `tezlify-gateway` `sha256:01f0bef2…` (2026-09-18T13:52Z) | n/a |
| backend image | bare uvicorn | `tezlify-backend` `sha256:9b750d36…` (2026-09-18T13:52Z) | n/a |
| reverse proxy | Vite `:5173` same-origin proxy | Caddy: `/api/*`+`/ws*`→`backend:8000`, `/`→`/srv/frontend` | n/a |

**Commits Oracle does NOT have** (all 18, incl.):
`5f8d25d` (Phase 6.5 **G-LEASE**), `c512755`/`671d911`/`e031a3a`/`0c497b1`/`bd55f2f`/`bf6b0ce` (all of **Phase 6.4**),
`287fbd8`, `2d13064`, `f4db4dd`, `06f7df1` (Phase 3–6.3 correctness fixes).

### The five required checks

| Check | Result |
|---|---|
| Oracle runs Phase 6.4/6.5 code? | **NO** — none of it |
| Oracle gateway real Baileys? | **YES** — `lib/index.js` present, no stub registration |
| Oracle `leaseRepository != null`? | **YES** — `GATEWAY_DATABASE_URL` set (len 85, host `db`) |
| Oracle gateway sees `GATEWAY_DATABASE_URL`? | **YES** |
| Oracle frontend API/WS targets | `https://api.130.162.247.20.sslip.io` + `wss://api.130.162.247.20.sslip.io` — **cross-origin** vs the page host `130.162.247.20.sslip.io` |

Env var **names** (values never printed): gateway — `GATEWAY_DATABASE_URL`, `DATABASE_URL`, `GATEWAY_ENCRYPTION_KEY`, `WHATSAPP_GATEWAY_SECRET`, `BACKEND_WS_URL`, `GATEWAY_HOST/PORT`, `WHATSAPP_AUTO_RESTORE=false`, `LOG_LEVEL=info`, **`GATEWAY_DATABASE_POOL_MAX` unset (→ default 3)**. Backend — `WHATSAPP_GATEWAY_SECRET` SET(len 64), `WHATSAPP_GATEWAY_URL=http://gateway:8787`.

---

## B. END-TO-END TIMELINE

Measured gateway-side (`POST /sessions` → first visible QR payload), 5 runs each, identical harness.

| Stage | local_ms | oracle_ms | delta_ms |
|---|---|---|---|
| **T2–T0** `POST /sessions` | **9–60** (p50 11) | **20 377–26 812** (p50 **21 632**) | **+21 621** |
| T3–T2 socket start → `connected to WA` | ~300 | ~302 | ~0 |
| T5–T3 `connected` → QR payload | ~735–1368 | **337–646** | **−400** |
| T6–T5 QR payload → `session_qr_updated` | ~150 | ~120 | ~0 |
| **T11–T0** to visible QR | **744–1428** (p50 1046) | **21 023–27 149** (p50 21 632) | **+20 586** |

**The entire Oracle delay lives in ONE interval: T2–T0.** Oracle's *QR-generation* interval is actually **faster** than local (337–646 ms vs 735–1368 ms) because its network to WhatsApp is better.

T7–T11 (backend→browser) could not be instrumented on Oracle: the production frontend requires Google-OAuth login and Caddy access logging is disabled. Reported as **not measured**, not assumed.

---

## C. IS THE WEBSOCKET PATH ACTUALLY WORKING?

| Check | Result |
|---|---|
| browser → `/ws` upgrade | **101 OPEN** — direct 26 ms, via Caddy sslip 65 ms, via Caddy api 17 ms |
| gateway → backend bridge | **connected**, `reconnect_count=1`, `last_event_at` live (21:20:53Z) |
| polling fallback in use? | **No evidence of fallback**; the fast-path is healthy |
| Caddy access log correlation | **UNAVAILABLE** — access logging not enabled |

**Verdict: the WebSocket fast-path is functional on Oracle. This is NOT a WS/proxy problem.** The delay happens *before any QR exists*, so no delivery mechanism could have hidden it. (My first `curl` handshake returned 404 — that was a curl artifact, not a real failure; a proper `ws` client gets 101.)

---

## D. ORACLE → WHATSAPP NETWORK

| Metric | Oracle | Verdict |
|---|---|---|
| DNS `web.whatsapp.com` | 4–7 ms | excellent |
| TCP connect `:443` | **p50 2 ms** (min 2, max 16) | excellent |
| TLS handshake | 31 ms | excellent |
| total | 215 ms | excellent |

**Oracle's network to WhatsApp is BETTER than local's.** Network latency is **excluded** as a cause. The Baileys QR production interval (337–646 ms) confirms it.

---

## E. ORACLE GATEWAY EVENT TIMING

From real gateway logs (one pairing attempt, ms from `socket_connect_started`):

```
   0 ms  socket_connect_started (gen 1)
  55 ms  auth_state_loaded
 163 ms  connection_transition = connecting
 168 ms  event_outbox_enqueue_failed  session_connecting   (23503)
 302 ms  "connected to WA"
 476 ms  "not logged in, attempting registration..."
 851 ms  event_outbox_enqueue_failed  session_qr_updated   (23503)
6528 ms  "pairing configured successfully, expect to restart"
7104 ms  Stream Errored (restart required)
7265 ms  connection_transition = close, status_code = 515
7265 ms  socket_reconnect_scheduled  delay_ms=500
7766 ms  socket_connect_started (gen 2)
```

Note the **515 `restartRequired` → 500 ms reconnect loop**: every restart re-registers, and re-emitting `session_qr_updated` **invalidates the previously issued pairing code**.

---

## F. event_outbox FK 23503

- FK confirmed: `event_outbox.session_id → whatsapp_private.gateway_sessions(session_id) ON DELETE CASCADE`
- **23503 does occur** for ephemeral pairings (`session_connecting`, `session_qr_updated`)
- Outbox census: **2 112 rows = 1 953 DELIVERED + 162 DEAD_LETTER** (one row at **142 attempts**)
- **No `session_qr_updated` has enqueued since 2026-09-17 12:56** — every QR event on Sep 19 failed enqueue
- Cost per failed enqueue ≈ **6.6 ms** (same failed-INSERT path); on failure `events.js` falls back to `deliverBestEffort`, which still reaches the backend

**Impact on latency: negligible** (a handful of events). It is a *correctness/durability* defect, **not** the 21 s delay. The 21 s comes from the **`lid_mappings`** variant of the same FK-23503 class, at **2 741× the volume**.

---

## G. POSTGRES LATENCY — "is the DB the cause?"

**No. Direct evidence, all measured on Oracle:**

| Measurement | Value |
|---|---|
| the LID `DISTINCT ON` query | **0.165 ms** execution, index scan |
| `SELECT 1` via gateway pool | 0.37–0.44 ms |
| **200 FK-violating INSERTs on one direct connection** | **13 ms total (0.065 ms each)** |
| one *failed* INSERT via the pool | **6.59–7.59 ms** |
| one NOT NULL-violating INSERT (no FK) | 6.79 ms |
| pool size 3 / 10 / 20 | 7.54 / 7.13 / 7.75 ms — **no effect** |
| same-key vs distinct-key FK violations | 21 133 ms vs 22 659 ms (**0.93× — no lock serialization**) |
| `max_connections` / current | 100 / 10 |

The database rejects an FK violation in **0.065 ms**. The ~6.7 ms is the **failed-statement path in the client** (implicit-transaction abort + error construction), identical for FK and NOT-NULL failures — i.e. **generic failed-INSERT cost, not FK-specific, not DB load, not lock waits, not pool exhaustion.**

---

## H. SERVER RESOURCES

| Metric | Value |
|---|---|
| host | 4 cores, 23.9 GB RAM, disk 11% |
| load average | 0.19 (idle) → **2.91** during the measurement storms |
| gateway CPU | **162 %** during the flood |
| postgres CPU | **130 %** during the flood |
| memory | 1.8 GB used of 23.9 GB — fine |
| restarts / OOM | **0 / false** for all four containers |
| gateway HTTP RTT (event-loop proxy) | min 2, **p50 5**, **max 88 ms** |

The one **88 ms** sample is a genuine event-loop stall (the synchronous `fs.readFileSync` loop over 2 741 files plus the failing-insert flood). It is **under** the 100 ms threshold and is a **consequence** of the flood, not its cause. Resource exhaustion is **not** the root cause.

---

## I. STALE SESSION / CONCURRENCY

**Oracle session census (as found): 11 sessions — `{CONNECTED: 1, UNAVAILABLE: 10}`**

All ten dead sessions carry `error_message = "WHATSAPP_SESSION_LEASE_LOST"`, created 2026-09-19 17:38→21:04, each dying **21–31 s** after creation:

```
created 17:38:38 -> updated 17:39:02  (24 s)
created 17:39:38 -> updated 17:40:09  (31 s)
created 18:51:29 -> updated 18:51:51  (22 s)
created 19:08:42 -> updated 19:09:04  (22 s)
created 19:39:24 -> updated 19:39:45  (21 s)
created 19:39:51 -> updated 19:40:13  (22 s)
created 19:39:54 -> updated 19:40:25  (31 s)
created 20:05:59 -> updated 20:06:20  (21 s)
created 20:10:25 -> updated 20:10:47  (22 s)
created 21:03:51 -> updated 21:04:12  (21 s)
```

DB: `gateway_sessions=31` with **30 orphans**, `socket_leases=1` (**only one** — ephemeral sessions never hold a lease).

**Ten consecutive failed pairing attempts in one evening is the user-visible symptom.** The 10 stale sessions also keep CPU high.

**Not verified:** that the `gateway_session_id` on the browser WS equals the new pairing session id. This requires an authenticated browser session on production; flagged as unverified rather than assumed.

---

## J. SAME TEST, SAME CONDITIONS (5 runs each)

| run | local_ms | oracle_ms | oracle_ws | oracle_qr_source |
|---|---|---|---|---|
| 1 | 1 428 | 27 149 | not measured | gateway `GET /sessions/:id/qr` |
| 2 | 1 255 | 21 741 | not measured | gateway `GET /sessions/:id/qr` |
| 3 | 1 030 | 21 632 | not measured | gateway `GET /sessions/:id/qr` |
| 4 | 744 | 21 023 | not measured | gateway `GET /sessions/:id/qr` |
| 5 | 1 046 | 21 523 | not measured | gateway `GET /sessions/:id/qr` |

| | local | oracle |
|---|---|---|
| p50 | **1 046 ms** | **21 632 ms** |
| p95 | 1 428 ms | 27 149 ms |
| session outcome | `SCAN_QR` persists | `UNAVAILABLE` +14.6 s |

---

## K. ROOT-CAUSE CLASSIFICATION

**PRIMARY — category 1 (code/version mismatch), manifesting as category 6 (FK-failure overhead)**

Oracle is missing `2d13064`, whose absence makes `syncLidMappingsFromDisk` scan **every** session
directory instead of the tenant-bounded scope. Category 6 is the *mechanism* by which that omission
becomes 21 seconds:

```
Oracle T2–T0 = 21 632 ms      Local T2–T0 = 11 ms
2 741 failing INSERTs per POST × 6.6–7.5 ms = 18 063–20 667 ms
measured POST = 21 309 ms     FK errors span 21 075 ms   ← 1:1
Local lid-mapping files = 0   ⇒ 0 inserts ⇒ 60 ms
HEAD scope for the same input = { newSessionId }  ⇒ 0 inserts
```

**SECONDARY — category 1 again, second missing commit**
Oracle also lacks `5f8d25d` (Phase 6.5 G-LEASE). This is the **separate** defect that kills every
session at ~14.6 s (= TTL/3), i.e. before the user can scan. `socket_lease_lost` is present in the
Oracle log.

**CONTRIBUTING — category 8 (stale-session/concurrency)**
10 stale `UNAVAILABLE` sessions + 30 orphan `gateway_sessions` keep the gateway at 162 % CPU.

**EXCLUDED, with measurements:**
- **#2 WebSocket/proxy** — 101 upgrades succeed (17–65 ms); bridge live.
- **#3 Oracle→WhatsApp network** — TCP p50 **2 ms**; Oracle is *faster* than local.
- **#5 PostgreSQL latency** — LID query 0.165 ms; 200 FK-violating inserts in 13 ms; pool size irrelevant; no lock waits.
- **#7 resource saturation** — no OOM/restarts; 88 ms max event-loop stall is an *effect*.
- **#9 frontend rendering** — Oracle's QR-generation interval (337–646 ms) beats local's.

---

## FIX DIRECTION (diagnosis only — NOT applied)

1. **Deploy the existing commits.** `2d13064` (G-3 LID scoping) removes the 2 741 doomed INSERTs *and*
   the cross-tenant read; `5f8d25d` (Phase 6.5 G-LEASE) stops the session dying 14.6 s after the QR
   appears. No new code is required for either.
2. **Optional hardening** (not required to fix the reported symptom): a real
   `GATEWAY_DATABASE_POOL_MAX`, and suppressing the per-row `logger.warn` on a write path that is
   known to be doomed — 2 741 warn lines per pairing is pure I/O.
3. **Note for whoever deploys:** `persistLidMappingToDb` is `void`-fired, so its failures are
   invisible to the caller while still consuming pool connections and log bandwidth. The scoping fix
   makes this harmless in the new-session case, but the fire-and-forget shape remains a latent risk.

**No code was changed. No commit. No push. No deploy.**
