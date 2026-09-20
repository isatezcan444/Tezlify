# WhatsApp Production Deploy — Execution Report

**Date:** 2026-09-20 (window 21:51–22:12 UTC / 00:51–01:12 +03)
**Host:** `130.162.247.20` · `/opt/tezlify` · ssh `-i ~/.ssh/id_tezlify_oracle ubuntu`
**Deployed by:** agent, executing the 14-phase plan
**Constraints honoured:** NO `reset --hard`, NO `git clean`, NO stash, NO force-push, NO destructive deletion of production artifacts, NO unrelated code changes.

---

## 0. RESULT SUMMARY

| Phase | Result |
|---|---|
| 1 Capture rollback state | ✅ complete |
| 2 Protect runtime artifacts | ✅ complete (`.git/info/exclude`, `.gitignore` untouched) |
| 3 Fast-forward source | ✅ **clean FF**, `f6ec68d` → `6f4aa00`, 18 commits |
| 4 Build backend + gateway | ✅ both built, fixes verified **inside** the images |
| 5 Frontend release | ✅ new release dir, new asset hash, integrity verified |
| 6 DB pre-flight | ✅ `dup_groups = 0` |
| 7 Controlled service update | ✅ backend → gateway → symlink swap → caddy force-recreate |
| 8 QR latency regression | ✅ **PASS** (~0.21 s start, ~0.62 s to QR) |
| 9 LID isolation | ✅ **PASS** (0 scan, 0 FK flood) |
| 10 Lease acceptance | ✅ **PASS** ephemeral (70 s) · ✅ persistent (acquire + 4 renewals) · ✅ **promotion** (real-PG harness, §7.1) |
| 11 Real browser | ✅ **PASS** (QR visible 208×208, rotation, WS 101, 0 console errors) |
| 12 Real phone | ⛔ **NOT RUN — no physical device available to the agent** (code path asserted device-lessly in §7.1) |
| 13 Post-connect smoke | ⛔ **NOT RUN — depends on Phase 12** |
| 14 Final report | ✅ this document |

**No STOP condition was triggered.** The deploy completed.

**Verification gates at the deployed commit `6f4aa00`:** gateway harness **22/22**, frontend **10/10 suites**,
backend **1089 passed / 4 skipped**. One stale test harness was found and fixed (product unaffected); see §7.1–7.2.
No product regression. **`LIVE DEVICE E2E = NOT RUN`** — Phases 12/13 need a physical phone.

---

## 1. BEFORE / AFTER — mandatory metrics

| Metric | OLD (`f6ec68d`) | NEW (`6f4aa00`) |
|---|---|---|
| `POST /pairing/start` latency | **~21.6 s** | **0.222 / 0.217 / 0.207 s** (p50 **0.217 s**) |
| First-QR latency (API poll) | ~21.6 s p50 | **0.617 / 0.610 / 0.635 s** → p50 **0.617 s**, p95 **0.635 s** |
| First-QR latency (browser, click→visible) | — | **0.758 s**, **1.263 s** |
| LID files scanned for a NEW ephemeral session | **2 741** (every session dir) | **0** (own dir only) |
| Doomed LID FK-23503 INSERT attempts | **2 741** | **0** |
| `Failed to persist LID mapping` events | flooding (observed pre-deploy) | **0** |
| Lease state (ephemeral pairing) | `socket_lease_lost` after ~14–30 s | **no lease acquired, no renewal, no lease-lost** |
| Session state after 60 s (ephemeral) | dead (`UNAVAILABLE` / `LEASE_LOST`) | **alive — `SCAN_QR`, QR present at t=70 s** |
| Lease state (persistent session) | — | **acquire ✓ + 4 renewals, generation stable at 1** |
| Real phone `CONNECTED` | — | **NOT RUN** |
| WebSocket | — | **101 upgrade PASS** |
| Frontend bundle | `index-Dmup1g3A.js` / `index-DvGLjcBj.css` | **`index-DPQvI-dK.js` / `index-BL_JUexi.css`** |

**Latency improvement: ~21.6 s → ~0.22 s on `pairing/start` ≈ 97× faster.**

---

## 2. Deployed artefacts

| Item | Value |
|---|---|
| Deployed git SHA | **`6f4aa00df67ffc064592749b2ed47a89eec0e0e8`** |
| Backend image | **`sha256:5002fe89203bd02997a6ec51861070de0e008a751b19c6e66ce51f24dcad4bbc`** |
| Gateway image | **`sha256:1a44410c768d1eb6b19b9e7406f0978a7bbce05be20e96c815cbe8feeefc0cd1`** |
| Caddy image | `sha256:5f5c8640…` (unchanged, `caddy:2-alpine`) |
| Frontend release path | **`/opt/tezlify/releases/v20260919_phase6_5_lid_scope_and_lease`** |
| Served bundle | `index-DPQvI-dK.js` (verified served by Caddy, not just on disk) |
| Migration result | **`uq_msg_conv_wa_message_id` CREATED** — `CREATE UNIQUE INDEX … ON public.messages USING btree (conversation_id, wa_message_id) WHERE (wa_message_id IS NOT NULL)` |
| Previously connected account relinked? | **NO — manual relink still required** (see §6) |

### Fix verification inside the built images (not just the source tree)
- `whatsapp-gateway/src/session-manager.js` sha256 in image == source tree: **`79dbb6457ff24fc69e53db8db30a3ccd2803ec204dee67393238fc7b00fd6f1e`**
- `backend/app/core/migrations.py` sha256 in image == source tree: **`f6bd2658d644982482359acee06e38995ff60747ba1fa6ebe63de1d2f99e4a6f`**
- `if (!session.ephemeral) armLeaseRenewal();` present at line 2830 (G-LEASE)
- G-3 scope guard `if (sessionId && !scope.has(String(item))) continue;` at line 830
- `ensure_messages_wa_message_id_unique` wired into the lifespan at `main.py:117`
- Phase 6.4 pair-token route `/pairing/{pair_token}/qr` present; Phase 6.5 backend test + fixture in image

> Note: the gateway Dockerfile copies only `whatsapp-gateway/src`, so the Phase 6.5 **test scripts** are in the repo but deliberately **not** in the gateway image. They were verified in the source tree, not the image.

---

## 3. Phase 1 — rollback point (all captured, nothing destroyed)

Backup dir: **`/opt/tezlify/backups/predeploy_20260919_215146`**

| Artefact | Value |
|---|---|
| `git_head.txt` | `f6ec68df74e3ff448298c8b6f668592a46d13c8c` |
| `containers.txt` | backend `6d782e83…`, gateway `e7f68323…`, caddy `c3456250…`, db `56c5d358…` |
| backend image (before) | `sha256:9b750d36ff9ac0643ef453d20fb3acf7775916f90072b63ea6cd665127bac9ed` |
| gateway image (before) | `sha256:01f0bef2589bb683e92702623d0925f5ab0e823dfa19d081a50f2a17be4228b5` |
| `frontend_candidate` before | `/opt/tezlify/releases/v20260918_phone_locale_and_baileys_lid_fix` |
| frontend asset before | `index-Dmup1g3A.js` · `index-DvGLjcBj.css` · index.html sha256 `1f33970a35c3bda63b7081e1cf5aa0e77f6ee4176eedcef0795877bd5b0710da` |
| `db.dump` | PostgreSQL custom format, **4 757 517 bytes**, sha256 `8f12da17fd6d73ffca1c42a96a970025c6c8d213150aa7b6131e52b6cecff917` |
| rollback image tags | **`tezlify-backend:backup-20260919_215146`**, **`tezlify-gateway:backup-20260919_215146`** |

**No secrets were printed at any point.**

### Phase 1 DB snapshot
```
whatsapp_sessions=3   gateway_sessions=31   socket_leases=1
lid_mappings=3139 (12 sessions)   messages=1333   dup_conv_wa_groups=0
uq_msg_index_present=0   conversations=449   contacts=1848
wa id=68 CONNECTED · id=5 RELINK_REQUIRED · id=4 SCAN_QR
lease a618f89c-… gen=6
```

---

## 4. Phase 3 — fast-forward (all gates PASS)

```
pre-fetch : HEAD=f6ec68d  origin/main=f6ec68d  status=[]
fetch     : f6ec68d..6f4aa00  main -> origin/main
HEAD=f6ec68d  origin/main=6f4aa00  incoming=18  outgoing=0
ANCESTOR_CHECK = PASS   exactly_18 = PASS   collision_scan = NO_COLLISION
merge     : git merge --ff-only origin/main   -> exit 0
post      : HEAD=6f4aa00  git status=[]  git diff=[]
```

Runtime artefacts (`frontend_candidate`, `frontend_current`, `frontend_next`, `releases/`, `frontend_releases/`, `backups/`, `.staging_db_secret`) all verified **PRESENT** after the merge. `.gitignore` was **not** modified; `.staging_db_secret` was added to **`.git/info/exclude`** only.

---

## 5. Phase 7 — controlled update (observed order)

| Step | Evidence |
|---|---|
| backend recreate | `Container tezlify-backend Recreated/Started`, healthy at **t+9 s** |
| migration log | `[MIGRATION] uq_msg_conv_wa_message_id olusturuldu (kismi tekil indeks; NULL wa_message_id haric).` → **CREATED, not BLOCKED** |
| gateway recreate | healthy at **t+9 s**; log: `session_registry_initialized in_memory_sessions=0 persisted_session_directories=24 restored_sessions=0` and `automatic session restore is disabled by WHATSAPP_AUTO_RESTORE=false` |
| symlink swap | atomic via `ln -sfn … .new` + `mv -T`; before → `v20260918_phone_locale…`, after → `v20260919_phase6_5_lid_scope_and_lease` |
| caddy force-recreate | healthy at **t+18 s**; now serves **`index-DPQvI-dK.js`** |
| final health | backend / gateway / caddy / db = **all healthy** |
| HTTP | site **200**, `/health` **200** |

**The force-recreate was demonstrably necessary** — the bind mount resolved the old symlink target at container creation, exactly as predicted. Swapping the symlink alone would have kept serving the old bundle.

**Live-session impact (stated plainly, not suppressed):** the previously connected WhatsApp socket was **dropped** by the gateway recreate and, with `WHATSAPP_AUTO_RESTORE=false`, it was **not restored**. The `socket_leases` row was released (1 → 0) while its `gateway_sessions` row survived.

---

## 6. Phases 8–11 — acceptance evidence

### Phase 8 — QR latency (3 fresh ephemeral pairings)
```
POST /pairing/start -> 201 in 0.222s / 0.217s / 0.207s
first QR (API)      -> 0.617s / 0.610s / 0.635s
lid_mappings delta  = 0
lid_disk_sync_events= 0        lid_persist_failures = 0
lease_lost_events   = 0
```
**Zero 20 s+ behaviour. Zero LID flood.** Hard-failure threshold (>2 s consistently) not approached.

Residual `23503` in the window: **6 events**, all `event_outbox_enqueue_failed` (`session_qr_updated`, `session_connecting`) against **`event_outbox_session_id_fkey`** — a **different FK** from the LID defect. The same events were present in the **pre-deploy** gateway log, so this is **pre-existing behaviour for No-Create ephemeral sessions** (an ephemeral pairing has no `gateway_sessions` row, so outbox rows cannot be written). **Not a regression**, and not the LID flood.

### Phase 9 — LID isolation (fresh ephemeral `7cf4f322-b69f-49e8-9cbb-690813ea07ef`)
```
own session dir lid files       = 0
lid_disk_sync_events            = 0     (no cross-tenant scan)
lid_persist_failures            = 0
lid_fk_23503                    = 0
protected dir a618f89c-…        = 2741 lid files, mtime 2026-09-18 21:12:09 (UNTOUCHED)
whatsapp_sessions (No-Create)   = 3     (unchanged)
```
The 2 741-file directory was **not deleted and not modified** — it remains legitimate data for its own session.

### Phase 10 — lease acceptance
**Ephemeral** — observed 70 s, sampled every 5 s:

| t | qr_status | lease rows | lease row for ephemeral | lease-lost |
|---|---|---|---|---|
| 0–70 s (15 samples) | `SCAN_QR` + QR | **0** | **0** | **0** |

`WHATSAPP_SESSION_LEASE_LOST = 0` · `socket_lease_lost = 0` · lease acquire attempts = 0 · **survived 70 s**, far beyond the old ~14–30 s death window.

**Persistent** (controlled test — one session created then deleted):

| t | generation | expires_at | updated_at |
|---|---|---|---|
| 0 s | 1 | 22:05:58.378 | 22:05:13.378 |
| 10 s | 1 | 22:06:13.418 | 22:05:28.418 ← **RENEWED** |
| 25 s | 1 | 22:06:28.425 | 22:05:43.425 ← **RENEWED** |
| 35 s | 1 | 22:06:43.426 | 22:05:58.426 ← **RENEWED** |
| 50 s | 1 | 22:06:58.431 | 22:06:13.431 ← **RENEWED** |

`socket_lease_acquired` fired (gen 1); renewal every **15 s = TTL/3**; generation stayed healthy; `lease_lost`/`renew_failed` = **0**.

### Phase 11 — real Chrome / CDP against production
```
app shell rendered                      = true (2.0s)
auth /api/v1/auth/me                    = 200
Link Device modal opens                 = YES
POST /api/v1/whatsapp/pairing/start     = 201
QR visible, DOM geometry                = 208 x 208, natural 292x292, complete=true
QR rotation (45s, full-payload compare) = 3 distinct payloads (t=8s, t=28s) -> PASS
WebSocket upgrade                       = 101  -> PASS
QR delivery path                        = real fast path (GET /pairing/{token}/qr, 200s)
console errors                          = 0 total, 0 pairing-related
first-visible-QR latency                = 0.758s / 1.263s
```
Screenshot captured: `/tmp/tz_phase11_qr.png` — real QR rendered inside the "Link Device" modal with a live rotation countdown ("Live QR", 11 s).

> Harness note: an initial rotation check compared only the first 60 chars of the base64 data-URL. Those bytes are the PNG signature + IHDR, identical for same-size QRs, so it falsely reported "no rotation". Re-run with full-payload comparison → **3 distinct payloads**. The first result was a harness bug, not a product finding.

---

## 7. Phases 12 & 13 — NOT RUN (blocked, stated plainly)

**Phase 12 (real phone) — NOT RUN.** No physical phone is available to the agent. It cannot be simulated, and the instructions forbid faking it. Consequently:

**Phase 13 (post-connect chat smoke) — NOT RUN.** Every item (chats load, contact names, groups, inbound, outbound, ACK transition, unread increment, mark-read, reconnect, LID mapping, history) requires a `CONNECTED` session that only a real phone can produce.

**Therefore the report status remains: `LIVE DEVICE E2E = NOT RUN`.**

What *was* proven without a phone: the pairing lifecycle up to and including a scannable, rotating QR; lease behaviour for both ephemeral and persistent sessions; LID isolation; migration; and the full UI path in a real browser. What is **not** proven: `CONNECTED` state, promotion-on-connect, lease-after-promotion, and post-connect chat parity.

### 7.1 Closing the promotion gap as far as a device-less run allows

Production could not reach the **promotion** branch, because promotion is triggered by
`connection.update{connection:'open'}` — which only a real phone scan produces. To narrow that gap I ran the
gateway's own harness against the **real** `session-manager.js`, the **real**
`src/lease/postgres-session-lease.js` adapter, and a **real PostgreSQL 17.11** server
(`127.0.0.1:5432`, `data_directory=/opt/homebrew/var/postgresql@17`, db `tezlify` — local, verified, not a tunnel).
Only `makeWASocket` is stubbed; the pairing events are driven through the same handlers production uses.

**Whole gateway suite: 22 / 22 pass, 0 fail, 0 skip.** (The pre-deploy baseline of "21/21" was 21 pass + 1
skip — `test-phase6-6-lease-real-pg.mjs` skips itself without a connection string. Given one, it runs, which is
why this is now 22 executed suites rather than 21.)

`test-phase6-6-lease-real-pg.mjs` — 7 checks against real PostgreSQL:

| # | Check | Result |
|---|---|---|
| 1 | `socket_leases → gateway_sessions` FK is real; `acquire` throws **23503**, `renew` stays a silent `false` | PASS |
| 2 | Real adapter `acquire` / `renew` / `release` round-trips against PostgreSQL | PASS |
| 3 | Ephemeral pairing with no `gateway_sessions` row holds **no lease row**, arms **no timer** | PASS |
| 4 | Persistent session holds a **real lease row** and arms renewal | PASS |
| 5 | Ephemeral pairing **survives one real renewal interval** (10 000 ms) | PASS |
| 6 | Persistent session **renews** its real row — `expires_at` advances in the DB | PASS |
| 7 | **Promoted pairing takes a real lease row and arms renewal** | PASS |

Check 1 is the mechanism of the original defect, now asserted directly: the FK really is
`FOREIGN KEY (session_id) REFERENCES whatsapp_private.gateway_sessions(session_id) ON DELETE CASCADE`, so
`INSERT` fails loudly (23503) while `UPDATE` returns `rowCount 0` — the silent-failure cover described in
`WHATSAPP_QR_LATENCY_DIAGNOSIS.md`. Checks 3–6 reproduce the Phase 10 production observations locally against
real SQL. **Check 7 is the one production could not reach**, and it now passes:

```js
sock.completePairing();
await h.credsUpdate(sock);
await h.connectionUpdate(sock, { connection: 'open' });
// -> status === 'CONNECTED', ephemeral === false,
//    a real socket_leases row exists, _leaseRenewTimer !== null
```

Supporting suites, all green: `test-phase6-5-ephemeral-lease` (6 checks — same promotion assertions against a
fake pool), `test-session-lease` (7), `test-pairing-lifecycle` (9 — pairing completes, clears the QR, persists
creds, cold restart reconnects without a second QR, two pairings stay isolated, a stale socket cannot overwrite
another session's state), `test-g3-lid-tenant-scope` (13 — tenant isolation, caller's own line wins, unknown
owner **fails closed**, no session id yields an **empty** scope never "everything", disk sweep gated, owner
lookup goes through `public.whatsapp_sessions.gateway_id`).

**Cleanup verified:** `socket_leases = 0`, `gateway_sessions = 0`, `leftover realpg-% rows = 0`, no stray
session dirs. The harness removed everything it created.

**What this does and does not change.** It raises confidence in the promotion/lease code path from
"unreachable" to "asserted end-to-end against real SQL with the real adapter". It does **not** make
`LIVE DEVICE E2E` run. A stubbed socket is not a phone: no real Baileys handshake, no real `creds.update` from
WhatsApp, no real `messages.upsert`. **The status stays `LIVE DEVICE E2E = NOT RUN`.** The remaining Phase 12/13
gap is now precisely scoped to "does WhatsApp's real server behave like the stub" — nothing else.

### 7.2 Frontend and backend verification gates, re-run at the deployed commit

Production now serves the tree at `6f4aa00`, so the local suites were re-run **at that exact commit** to
confirm the deployed revision is green (not merely that a green revision was deployed).

**Frontend — 10 / 10 suites PASS:**

| Suite | Result |
|---|---|
| `verify-whatsapp-logic` | PASS — **43 checks** (identity + ordering, §P6/F delivery-status monotonicity) |
| `verify-whatsapp-dom` | PASS — **20 checks** |
| `verify-whatsapp-browser` | real Chrome 153: **7 passed / 0 failed** |
| `verify-whatsapp-pairing-browser` | real Chrome 153: **12 passed / 0 failed** |
| `verify-whatsapp-pairing` | PASS — **8 checks** (§12 single-flight, failed-init must not latch the guard) |
| `verify-whatsapp-merge-equivalence` | PASS — live WS merge == canonical merge (10 rows, `mode=canonical`) |
| `test-whatsapp-chat-order` | PASS — **10 ordering invariants** (see below) |
| `test-whatsapp-avatar` | PASS (0 duplicate requests) |
| `test-whatsapp-chat-scroll` | PASS |
| `test-whatsapp-message-merge` | PASS (identity/status/reconnect retention; 1200+pending merge ≈1.4 ms) |

> **A stale test was found and fixed — in the harness, not the product.** `test-whatsapp-chat-order.mjs`
> hand-transpiles `whatsappOrdering.ts` with `ts.transpileModule()` into a `data:` URL, stripping imports by
> literal string match. `whatsappOrdering.ts` later gained
> `import { extractCleanPhone } from './whatsappIdentity';`, which the strip-list never learned about, so the
> `data:` URL threw `ERR_UNSUPPORTED_RESOLVE_REQUEST` — a **relative specifier cannot resolve from `data:`**.
> The product file is correct; the harness had rotted. Fixed by stripping that import and inlining
> `whatsappIdentity.ts` (self-contained apart from a type-only import), matching the file's existing pattern.
> All 10 ordering invariants now run, including the two worth having: an empty conversation must **never** sort
> above an active one, and a contact-sync/avatar `updated_at` bump must **not** reorder the list.
> Lesson recorded in the `esbuild-frontend-verification` skill.

**Backend — `1089 passed, 4 skipped`** (rc=0), exactly the recorded baseline.

> **The first backend run reported 28 failures. They were not a regression.** All 28 were `whatsapp_sessions`
> owner-resolution tests failing with
> `Gateway olayi sahibi cozulemedi … (bagli tenant sayisi=2, jid=…)`.
> Cause: `resolve_event_owner()` (repositories/sessions.py:132-145) selects **every** `CONNECTED` row with no
> tenant filter — correct, since the event carries no `session_id` — and **fails closed** when it finds more
> than one distinct owner. The dev DB (`tezlify.db`, SQLite — not the local Postgres) carried a leftover
> `CONNECTED` row for owner `67890123…` (id=2, `+905413749073`), while each test seeds its own owner ⇒ 2
> distinct owners ⇒ ambiguous ⇒ event skipped ⇒ assertion fails. **The product was behaving exactly as
> designed.** Re-run against a session-free copy of the DB (a copy — the original was never modified, verified
> afterwards): **1089 passed / 4 skipped**. This is the "needs a session-free DB" precondition that was already
> recorded, now demonstrated rather than assumed.

**Net: no product regression on either side.** One harness bug fixed, one environment precondition explained
and proven.

---

## 8. Final production state vs baseline

| Metric | Baseline (Phase 1) | Final | Note |
|---|---|---|---|
| `whatsapp_sessions` | 3 | **3** | unchanged |
| `gateway_sessions` | 31 | **33** | **+2 = test residue, see §9** |
| `socket_leases` | 1 | **0** | lease released when the live socket dropped; no session restored |
| `lid_mappings` | 3139 | **3139** | **unchanged — zero cross-tenant writes** |
| `messages` | 1333 | **1333** | unchanged |
| `dup_groups` | 0 | **0** | unchanged |
| `conversations` | 449 | **447** | −2 from the **pre-existing** `purge_raw_jid_identity_data` (unchanged by these 18 commits, already called in the old `main.py:116`) |
| `contacts` | 1848 | **1846** | same pre-existing purge |
| `uq_msg_conv_wa_message_id` | absent | **present** | migration created it |
| session dirs | 24 | **25** | +1 (`37c4da78…`) from the Phase 11 browser pairing |
| protected 2741-file dir | 2741 files | **2741 files, mtime unchanged** | untouched |
| backend / gateway errors since deploy | — | **0 / 0** | |
| LID persist failures since deploy | — | **0** | |
| `socket_lease_lost` since deploy | — | **0** | |

### Known stale state (not caused by the deploy, but now visible)
`whatsapp_sessions.id=68` still reports **`CONNECTED`** while its socket no longer exists. The DB row was not updated because nothing emitted an event after the restart. **The previously connected WhatsApp account must be relinked manually.** This is the expected consequence of `WHATSAPP_AUTO_RESTORE=false` and was called out as an expected maintenance event up front.

---

## 9. Residue I created — reported, NOT deleted

Two controlled tests (Phase 10 persistent half) and one browser pairing left traces. Per the instruction not to delete production DB state, **I did not clean these up**. They are inert.

| Residue | Detail |
|---|---|
| `gateway_sessions` +2 | `f872268d-3482-4269-ae31-05c15debacec`, `af59b362-d71f-4fb5-9ad8-99abc5734358` |
| `event_outbox` +7 | 4 rows for `f872268d…`, 3 for `af59b362…` |
| session dir +1 | `37c4da78-2121-4a27-a403-6218fda9b4e8` (from the Phase 11 browser pairing, 0 LID files) |

Optional cleanup, **for your approval only** (not executed):
```sql
DELETE FROM whatsapp_private.event_outbox
 WHERE session_id IN ('f872268d-3482-4269-ae31-05c15debacec',
                      'af59b362-d71f-4fb5-9ad8-99abc5734358');
DELETE FROM whatsapp_private.gateway_sessions
 WHERE session_id IN ('f872268d-3482-4269-ae31-05c15debacec',
                      'af59b362-d71f-4fb5-9ad8-99abc5734358');
```
```bash
# on the host, only if you want the dir gone:
rm -rf /opt/tezlify/releases/../whatsapp-gateway-sessions-dir/37c4da78-...   # inside the docker volume, via:
docker exec tezlify-gateway rm -rf /app/sessions/37c4da78-2121-4a27-a403-6218fda9b4e8
```

---

## 10. Rollback (available, not needed)

```bash
cd /opt/tezlify
sudo docker tag tezlify-backend:backup-20260919_215146 tezlify-backend:latest
sudo docker tag tezlify-gateway:backup-20260919_215146 tezlify-gateway:latest
sudo docker compose -f docker-compose.prod.yml up -d --no-deps backend
sudo docker compose -f docker-compose.prod.yml up -d --no-deps gateway

ln -sfn /opt/tezlify/releases/v20260918_phone_locale_and_baileys_lid_fix frontend_candidate.new
mv -T frontend_candidate.new frontend_candidate
sudo docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps caddy

git switch --detach f6ec68d      # non-destructive; do NOT reset --hard
# DB restore only if required:
# sudo docker exec -i tezlify-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean' < backups/predeploy_20260919_215146/db.dump
```
The new index is additive and backward-compatible; old code ignores it. `DROP INDEX IF EXISTS uq_msg_conv_wa_message_id` is available but not expected to be needed.

---

## 11. Open items / next actions

1. **Manually relink the WhatsApp account** for session 68 (owner `e512dd40-…`). Until then it reports a stale `CONNECTED` with no socket.
2. **Run Phase 12 with a real phone**, then Phase 13 chat smoke. Acceptance for the phone run: reaches `CONNECTED`, no `WHATSAPP_SESSION_LEASE_LOST`, promotion to persistent occurs, **lease exists after promotion**, no cross-tenant LID import.
3. **Decide on the residue in §9.**
4. **Known-open, unrelated to this deploy:** the `event_outbox` FK failure for No-Create ephemeral sessions (6 events per 3 pairings). Pre-existing; worth a separate ticket.
5. `6f4aa00` ships `frontend/vite.config.local.ts` (a local-only Vite config) into `main`. Harmless, but worth a cleanup commit.
