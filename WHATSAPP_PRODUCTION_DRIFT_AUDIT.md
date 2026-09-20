# Production Drift Audit — Oracle `/opt/tezlify`

**Date:** 2026-09-20 00:41 +03
**Scope:** Read-only analysis of production drift vs `local/main`
**Mutating commands executed:** NONE (no reset, no clean, no stash, no commit, no push, no deploy, no fetch)

---

## 0. PREMISE CORRECTION (read this first)

Two of the assumptions in the request do not match the machine. Both were verified directly.

### 0.1 "working tree'de 13 modified file var" → they are NOT modified files

Production's working tree is **clean** for every tracked file:

```
$ git status --porcelain --untracked-files=no     → (empty)
$ git diff --stat                                 → (empty)
$ git diff --cached --stat                        → (empty)
$ git diff --name-only HEAD                       → (empty)
```

`git status --porcelain` returns **exactly 13 lines, all prefixed `??`** (untracked). The "13 modified files" are 13 **untracked artifacts** — release dirs, symlinks, backups, debug scripts. This changes the whole risk profile: there is **no uncommitted source work on production to lose**, and therefore **no merge conflict is possible**.

### 0.2 "Local HEAD: 91dbfe6" → local HEAD is `6f4aa00`

`91dbfe6` exists locally and is the **parent** of `6f4aa00` (the commit added after the snapshot was taken). Drift distance is still **18 commits**, as stated.

### 0.3 Commits `2d13064` and `5f8d25d` do not exist on Oracle at all

```
$ git cat-file -t 2d13064   → fatal: Not a valid object name 2d13064
$ git cat-file -t 5f8d25d   → fatal: Not a valid object name 5f8d25d
```

Production has **never fetched** them (last `.git/FETCH_HEAD` write: 2026-09-18 13:51). A `git fetch` is a prerequisite for any deploy.

### 0.4 Verified state summary

| Item | Local | Oracle |
|---|---|---|
| HEAD | `6f4aa00` | `f6ec68d` |
| Branch | `main` | `main` |
| Tracked tree | clean (2 memory files modified) | **clean** |
| Untracked | 1 file | **13 entries** |
| `origin/main` ref | `6f4aa00` | `f6ec68d` |
| Local commits ahead of origin/main | 0 | 0 |
| Remote `refs/heads/main` (ls-remote) | — | **`6f4aa00`** |

**Fast-forward is guaranteed clean:** `f6ec68d` is an ancestor of `origin/main`, production has 0 commits of its own, and the tree is clean. `git merge --ff-only origin/main` cannot conflict.

---

## FAZ 1 — Untracked (misreported as "modified") artifact audit

`git check-ignore` returns **nothing** for all 13 → none are covered by `.gitignore` (except the `.env*` family, see §1.2).

| # | Path | Type / size | What it is | Class |
|---|---|---|---|---|
| 1 | `.staging_db_secret` | file, 49 B, mode `600` | Staging DB credential leftover. **Contains a secret** (not printed). Not referenced by any compose file. | **C** |
| 2 | `backups/` | dir, `drwx------` | Postgres / caddy / config / media backups. **Bind-mounted read-only into the backend container** (`/opt/tezlify/backups:/opt/tezlify/backups:ro`). | **B** |
| 3 | `create_real_e2e_session.py` | file 3.6 KB | Ad-hoc E2E session seeder (`uuid`, `base64`, raw SQLAlchemy). Debug tool. | **C** |
| 4 | `frontend_candidate` | **symlink** → `releases/v20260918_phone_locale_and_baileys_lid_fix` | **THE LIVE FRONTEND ROOT.** Bind-mounted into Caddy as `/srv/frontend:ro`. | **B (critical)** |
| 5 | `frontend_current` | symlink → `releases/v20260917_phase14_1` | Previous release pointer. Rollback handle. | **B** |
| 6 | `frontend_next` | symlink → `frontend_releases/v20260917_phase13` | Stale staging pointer, never promoted. | **C** |
| 7 | `frontend_releases/` | dir, 15 release dirs | Older release pool (phase10.x–phase13.2). | **B** |
| 8 | `monitor_real_e2e_session.py` | file 2.3 KB | Ad-hoc session monitor. | **C** |
| 9 | `parse_gateway_forensics.py` | file 3.2 KB | `subprocess`-based docker-log parser for forensics. | **C** |
| 10 | `phase12_real_qr.png` | file 5.4 KB | Debug screenshot artifact. | **C** |
| 11 | `phase12_real_traffic_monitor.py` | file 2.9 KB | Ad-hoc traffic monitor. | **C** |
| 12 | `releases/` | dir, 5 release dirs | **Contains the `frontend_candidate` target.** Current + 4 prior frontend builds. | **B (critical)** |
| 13 | `scratch_audit_identity.py` | file 2.7 KB | Ad-hoc identity audit script. | **C** |

**No class A (change also present in local/main) exists** — every entry is either production-runtime (B) or debug/temporary (C). **No class D.** Nothing needs human judgment to classify, though the deploy decisions in §5 do.

### 1.1 Collision test — the only thing that could actually break the deploy

The 93 files changed across the 18 commits were intersected with the 13 untracked paths:

**Result: ZERO overlap.** No incoming path collides with any untracked artifact. `git merge --ff-only` will not refuse, and no artifact will be overwritten or shadowed.

### 1.2 Secret hygiene note

- Root `.env` is a symlink to `.env.production`; `.gitignore` covers `.env.*` → **not** visible in `git status`, correctly.
- `.staging_db_secret` is **not** ignored. It is one `git add -A` away from being committed. Recommendation: add it to `.git/info/exclude` (local, untracked, conflict-free) — **not** to `.gitignore`, because `.gitignore` is itself modified by the incoming commits and a local edit would break the fast-forward.
- `frontend/.env.production` **is tracked** in git (un-ignored via `!frontend/.env.production`). It is unchanged across the 18 commits. Worth a separate review, but it is not drift.

---

## FAZ 2 — Commit comparison vs Oracle working tree

Because Oracle has **no tracked modifications**, the "conflicts with local modifications?" column is `NO` for every commit — structurally, not by inspection. The table lists affected production files that carry real risk.

| Commit | Subject | Affected production files (runtime-relevant) | Conflicts w/ prod modifications? |
|---|---|---|---|
| `06f7df1` | forensic audit: identity / read receipts / ordering | `api/v1/endpoints/whatsapp.py`, `schemas/whatsapp.py`, `services/whatsapp/identity.py`, `orchestration/{events,sessions,sync}.py`, `whatsapp_service.py`, `gateway/src/{index,session-manager}.js`, 6 frontend files, locales | **NO** |
| `f4db4dd` | Phase 2 event delivery + frontend identity | `whatsapp.py`, `schemas`, `orchestration/{events,history_evidence,relink,sessions,sync}.py`, `whatsapp_service.py`, `gateway/src/{events,index,session-manager}.js`, 11 frontend files | **NO** |
| **`2d13064`** | **Phases 3–6 correctness (LID scoping)** | `core/migrations.py`, `main.py`, `models/message.py`, `orchestration/{events,history_evidence,messaging,sync}.py`, `preview_normalization.py`, `repositories/{conversations,lid_mappings}.py`, `whatsapp_service.py`, **`gateway/src/session-manager.js`** | **NO** |
| `287fbd8` | frontend chat defects (DOM/browser) | `ChatThread.tsx`, `whatsappConversationPatch.ts`, `whatsappUnread.ts`, `WhatsAppHubPage.tsx` | **NO** |
| `547d289` | frontend verification harnesses | `frontend/package.json`, 5 `scripts/verify-*.mjs`, 1 fixture | **NO** |
| `4fa1882` | docs + `.gitignore` | `.gitignore` (adds `vite.config.ts.timestamp-*.mjs`) | **NO** |
| `591f77b`, `ce68359` | docs only | `.workbuddy-ai/memory/*` | **NO** |
| `ba8d527` | pairing harness (WIP) | `scripts/{baileys-stub-loader,fake-baileys,pairing-harness,repro-pairing}.mjs` | **NO** |
| `bf6b0ce` | **P6-8 pair_token, P6-9 ephemeral QR owner** | `whatsapp.py`, `orchestration/{events,sessions}.py`, `whatsapp_service.py` | **NO** |
| `bd55f2f` | **gateway single-flight for pairing codes** | `gateway/src/session-manager.js` | **NO** |
| `0c497b1` | modal pairing-code route by `pair_token` | `whatsappApi.ts`, `WhatsAppQrConnectModal.tsx`, `whatsappRepository.ts` | **NO** |
| `e031a3a` | Phase 6.4 executed pairing verification | `frontend/package.json`, 3 verify scripts, 1 backend test | **NO** |
| `671d911`, `c512755` | docs | memory + `WHATSAPP_PHASE6_4_REPORT.md` | **NO** |
| **`5f8d25d`** | **Phase 6.5 G-LEASE fix** | **`gateway/src/session-manager.js`**, `scripts/test-session-lease.mjs`, `scripts/fake-lease-pool.mjs`, `test-phase6-5-ephemeral-lease.mjs`, `backend/tests/test_whatsapp_phase6_5_qr_live_seam.py` + fixture | **NO** |
| `91dbfe6` | docs | memory + `WHATSAPP_PHASE6_5_REPORT.md` | **NO** |
| `6f4aa00` | invariants reference + local Vite config | `frontend/vite.config.local.ts` (**new, local-only config — see §3.3**), `scripts/test-phase6-6-lease-real-pg.mjs`, memory | **NO** |

### 2.1 The three files that actually carry the fixes

| File | Commits | Why it matters |
|---|---|---|
| `whatsapp-gateway/src/session-manager.js` | `2d13064`, `bd55f2f`, `5f8d25d` | Contains **both** G-3 LID scoping and the **G-LEASE** ephemeral-lease fix. Single highest-risk file. |
| `backend/app/core/migrations.py` + `main.py` | `2d13064` | New partial unique index, auto-run at startup (see §4 Phase E). |
| `backend/app/services/whatsapp/repositories/lid_mappings.py` | `2d13064` (new file) | The tenant-scoped LID persistence path. |

---

## FAZ 3 — Production-specific changes that must be preserved

**There are no production-specific *source* modifications to preserve.** The source tree is byte-identical to `f6ec68d`. What must be preserved is **runtime state and deploy infrastructure** — none of which git touches:

| Artifact | Why production-specific | Must move to main? |
|---|---|---|
| `frontend_candidate` → `releases/v20260918_phone_locale_and_baileys_lid_fix` | Live Caddy document root. Bind-mounted at `/srv/frontend`. Losing it = blank site. | **No** — infra, not source |
| `releases/` (5 dirs) + `frontend_releases/` (15 dirs) | Release pool + rollback handles. | **No** |
| `backups/` | Bind-mounted read-only into backend container; holds DB/caddy/media backups. | **No** |
| `backups/predeploy_*` (to be created) | The rollback point for this deploy. | **No** |
| `.staging_db_secret` | Staging credential. Contains a secret. | **No** — and must stay out of git |
| 5 debug scripts + `phase12_real_qr.png` | One-off investigation tooling. | **No** (optional: promote `parse_gateway_forensics.py` if still useful) |
| `whatsapp_sessions` + `whatsapp_media` docker volumes | Encrypted Baileys auth state + media. **Not** under git. | **No** |

### 3.1 Live production state that the deploy will disturb

| Fact | Value | Implication |
|---|---|---|
| WhatsApp session `id=68` | **`status = CONNECTED`**, user `e512dd40-…`, created 2026-09-18 20:18 | Recreating the gateway container **disconnects a live session** |
| `whatsapp_sessions` rows | 3 (1 CONNECTED, 1 RELINK_REQUIRED, 1 SCAN_QR) | — |
| `whatsapp_private.socket_leases` | 1 row: `a618f89c-…`, gen=6, expires 2026-09-19 21:45:05 UTC | Active lease held by the connected session |
| `WHATSAPP_AUTO_RESTORE` | `"false"` | After gateway recreate, sessions do **not** auto-relink → manual re-pair needed |
| Session dirs on disk | **23** | — |
| `lid-mapping-*.json` files | **2 741**, **all** in `a618f89c-8901-456f-816c-92e42dbf9a67` | This is the exact flood input (all other 22 dirs: 0) |

### 3.2 The 2 741-file finding, confirmed

The flood premise is now verified against the live box: 2 741 files exist, and **every one of them is in the currently-connected session's directory**. The pre-`2d13064` code scans all 23 dirs, so a *new* ephemeral pairing reads the connected session's 2 741 files and fires 2 741 FK-`23503` INSERTs.

Post-`2d13064` the same new pairing scans only **its own** dir → **0 files, 0 INSERTs**. The 2 741 files remain legitimately readable **for their own session** — that is correct behaviour, not a regression.

### 3.3 One thing that should NOT be in `main`

`6f4aa00` commits **`frontend/vite.config.local.ts`** — a machine-local Vite config. It is inert (Vite loads `vite.config.ts` unless `--config` is passed) and will land on production harmlessly, but it is a local-dev artifact in a shared branch. Flagging for a follow-up cleanup commit; **do not block the deploy on it**.

---

## FAZ 4 — Safe deploy plan (nothing below has been executed)

### Topology that dictates the plan

| Service | How it gets its code | Deploy action |
|---|---|---|
| `tezlify-backend` | image built from `backend/Dockerfile`, context `.` | rebuild + recreate |
| `tezlify-gateway` | image built from `whatsapp-gateway/Dockerfile`, context `.` | rebuild + recreate |
| `tezlify-caddy` | **static files via bind mount of the `frontend_candidate` symlink** | **symlink swap + `--force-recreate`** |
| `tezlify-db` | `postgres:17-alpine` | untouched |

**Critical mechanism:** `/opt/tezlify/frontend_candidate:/srv/frontend:ro` is a **bind mount of a symlink**. Docker resolves the symlink **at container creation**. Evidence: the current release dir was built at `12:51`, and the Caddy container started at `12:54:12` — the symlink was swapped *before* the container was (re)created. **Swapping the symlink alone does NOT change what is served.** Caddy must be force-recreated.

**Capacity check:** `/` has **86 GB free** (11% used), 23 GB RAM with 21 GB available. A backend rebuild (1.33 GB image) is safe.

### Exact sequence

**Phase A — Freeze & capture rollback point (no service impact)**

```bash
cd /opt/tezlify
TS=$(date +%Y%m%d_%H%M%S)
mkdir -p backups/predeploy_$TS

# A1 git state
git rev-parse HEAD                      > backups/predeploy_$TS/head.txt
git status --porcelain                  > backups/predeploy_$TS/status.txt
git log --oneline -20                   > backups/predeploy_$TS/log.txt

# A2 untracked inventory + symlink targets (the real "modified" state)
ls -la                                  > backups/predeploy_$TS/untracked_ls.txt
readlink -f frontend_candidate frontend_current frontend_next \
                                        > backups/predeploy_$TS/symlink_targets.txt

# A3 database dump  (no secrets echoed)
sudo docker exec tezlify-db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > backups/predeploy_$TS/db.dump
ls -l backups/predeploy_$TS/db.dump     # MUST be non-trivial in size

# A4 image tags (instant rollback)
sudo docker tag tezlify-backend:latest tezlify-backend:backup-$TS
sudo docker tag tezlify-gateway:latest tezlify-gateway:backup-$TS

# A5 frontend release rollback handle
CAND=$(readlink -f frontend_candidate); echo "$CAND" > backups/predeploy_$TS/candidate.txt
```

**Phase B — Protect untracked artifacts without touching the tree**

```bash
# B1 Keep git status quiet and keep .staging_db_secret out of any future 'git add -A'.
#     .git/info/exclude is local + untracked, so it CANNOT conflict with the fast-forward.
cat >> .git/info/exclude <<'EOF'
.staging_db_secret
releases/
frontend_releases/
backups/
frontend_candidate
frontend_current
frontend_next
create_real_e2e_session.py
monitor_real_e2e_session.py
parse_gateway_forensics.py
phase12_real_traffic_monitor.py
phase12_real_qr.png
scratch_audit_identity.py
EOF

# B2 Prove no collision (must print nothing)
git ls-files --others --exclude-standard > /tmp/untracked.txt
#    → then verify: no incoming path appears in /tmp/untracked.txt  (already verified: 0 overlaps)
```

**Do NOT edit `.gitignore`** — it is modified by `4fa1882` and a local edit would block the fast-forward.

**Phase C — Source update (fast-forward only)**

```bash
git fetch origin main
git log --oneline HEAD..origin/main        # MUST show exactly 18 commits
git rev-list --count HEAD..origin/main     # MUST print 18
git merge-base --is-ancestor HEAD origin/main && echo "FF-SAFE"

git merge --ff-only origin/main            # <- the ONLY tree mutation, and it is FF-only
git rev-parse HEAD                          # MUST be 6f4aa00...
git status --porcelain                      # MUST still show only the 13 untracked
```

If `--ff-only` refuses for any reason: **STOP**. Do not fall back to `reset`/`checkout`. Restore from `backups/predeploy_$TS/` and investigate.

**Phase D — Build images (running services untouched)**

```bash
sudo docker compose -f docker-compose.prod.yml build backend gateway
```
Building does not replace running containers — production keeps serving throughout.

**Phase D2 — Frontend build (off-box, then upload)**

Production has **no `frontend/node_modules`** → the frontend is built on a workstation and uploaded.

```bash
# on the workstation
cd frontend && npm ci && npm run build     # must pass tsc + vite build
# NOTE: frontend/package.json now adds a `jsdom` devDependency (commit e031a3a)
```
```bash
# upload into a NEW release dir — never overwrite the live one
ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 \
  "mkdir -p /opt/tezlify/releases/v${TS}_phase6_5"
rsync -az --delete frontend/dist/ \
  ubuntu@130.162.247.20:/opt/tezlify/releases/v${TS}_phase6_5/
```
Verify the new `index.html` references a **different** asset hash than `index-Dmup1g3A.js` (the currently served bundle) — that proves the upload is new.

**Phase E — Migration pre-check (verify, do not hand-run)**

Migrations run **automatically** inside the backend `lifespan` (`main.py` → `ensure_messages_wa_message_id_unique`). They are idempotent and non-destructive: on duplicates the function logs `BLOCKED` and **skips creation without deleting anything**.

Pre-flight on the live DB — re-run immediately before Phase F (data changes over time):

```sql
-- MUST return 0. If > 0, the index will be skipped (not fatal, but the C-4 race stays open).
SELECT COUNT(*) FROM (
  SELECT conversation_id, wa_message_id FROM messages
  WHERE wa_message_id IS NOT NULL
  GROUP BY 1,2 HAVING COUNT(*) > 1
) d;
```

**Verified 2026-09-20:** `dup_groups = 0` → the index **will be created**. `uq_msg_conv_wa_message_id` is currently **absent**. `messages` = 1 332 rows.

```sql
-- context: whatsapp_sessions=3, gateway_sessions=31, lid_mappings=3139 rows/12 sessions,
--          socket_leases=1 row, FK socket_leases.session_id → whatsapp_private.gateway_sessions present
```
Expected startup log: `[MIGRATION]` line reporting `CREATED` (not `BLOCKED`).

**Phase F — Controlled recreate (maintenance window; live session drops here)**

```bash
# F1 backend first
sudo docker compose -f docker-compose.prod.yml up -d --no-deps backend
#    wait for healthy
until [ "$(sudo docker inspect -f '{{.State.Health.Status}}' tezlify-backend)" = "healthy" ]; do sleep 3; done
sudo docker logs tezlify-backend --since 5m | grep -i "MIGRATION"     # expect CREATED

# F2 gateway (depends_on backend healthy)
sudo docker compose -f docker-compose.prod.yml up -d --no-deps gateway
until [ "$(sudo docker inspect -f '{{.State.Health.Status}}' tezlify-gateway)" = "healthy" ]; do sleep 3; done

# F3 frontend: atomic symlink swap (ln -sfn is NOT atomic → swap via rename)
ln -sfn /opt/tezlify/releases/v${TS}_phase6_5 frontend_candidate.new
mv -T frontend_candidate.new frontend_candidate

# F4 MANDATORY: the bind mount resolved the OLD symlink target at container start.
sudo docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps caddy
```

**Phase G — Verify** → see FAZ 5.
**Phase H — Rollback** (only if G fails)

```bash
# H1 application
sudo docker tag tezlify-backend:backup-$TS tezlify-backend:latest
sudo docker tag tezlify-gateway:backup-$TS tezlify-gateway:latest
sudo docker compose -f docker-compose.prod.yml up -d --no-deps backend gateway

# H2 frontend
ln -sfn "$(cat backups/predeploy_$TS/candidate.txt)" frontend_candidate.new
mv -T frontend_candidate.new frontend_candidate
sudo docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps caddy

# H3 source
git switch --detach f6ec68d     # detached, non-destructive; do NOT reset --hard

# H4 schema (only if the new index causes trouble — it should not)
# DROP INDEX IF EXISTS uq_msg_conv_wa_message_id;
```
The new index is **additive and backward-compatible**: old code simply ignores it. No rollback is expected to need H4.

---

## FAZ 5 — Post-deploy test plan

| # | Check | Method | Pass criterion |
|---|---|---|---|
| **A** | `POST /pairing/start` | `curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' -X POST .../api/v1/whatsapp/pairing/start` | HTTP 2xx, `time_total` ≪ 21 s |
| **B** | First-QR visible latency | time from request → first `qr` event on `/ws/gateway` | **target ≈ 1 s**, hard ceiling **< 2 s**; the 20 s+ LID flood must not reappear |
| **C** | `lid_mappings` INSERT count | before/after `SELECT COUNT(*) FROM whatsapp_private.lid_mappings` + gateway log scan for `23503` | For a **new ephemeral** session: **0 cross-tenant scans, 0 doomed INSERTs** (its own dir has 0 files) |
| **D** | Lease behaviour | `SELECT * FROM whatsapp_private.socket_leases` before/after | **Ephemeral:** no acquire, no renew. **Persistent / promotion:** acquire **and** renewal both occur (gen increments) |
| **E** | Session lifetime | gateway logs ≥ 60 s after pairing | **No** `WHATSAPP_SESSION_LEASE_LOST` |
| **F** | Tenant isolation | `test-g3-lid-tenant-scope.mjs` + verify the new session scans only its own dir | Cannot read another tenant's `lid-mapping-*.json` |
| **G** | Real browser (Chrome) | CDP: `verify-whatsapp-pairing-browser.mjs` | QR DOM visible **< 2 s**, rotation works, WS handshake **101** |
| **H** | Real phone pairing | physical device scan → wait for `CONNECTED` | reaches `CONNECTED`; then re-check D/E hold |

**Baselines captured now, for comparison after deploy:**

```
session_dirs          = 23
lid_mapping_files     = 2741   (all in a618f89c-8901-456f-816c-92e42dbf9a67)
lid_mappings rows     = 3139   (12 distinct sessions)
messages rows         = 1332   dup_groups = 0
whatsapp_sessions     = 3      gateway_sessions = 31
socket_leases rows    = 1      (a618f89c, gen=6)
served bundle         = index-Dmup1g3A.js
```

Note: the **2741-file directory belongs to the live connected session**. A test that re-syncs *that* session will still legitimately touch 2741 files. The flood test must use a **fresh ephemeral** pairing, whose own dir is empty.

**Report status must stay:** `LIVE DEVICE E2E = NOT RUN` until step H is actually executed.

---

## ANSWERS

### 1. What are the 13 "modified" files on Oracle?
They are **not modified** — they are **13 untracked entries**; the tracked tree is clean. Full list with classification is in the FAZ 1 table: `backups/`, `frontend_candidate`, `frontend_current`, `frontend_next`, `frontend_releases/`, `releases/` (class B — production infrastructure), and `.staging_db_secret`, `create_real_e2e_session.py`, `monitor_real_e2e_session.py`, `parse_gateway_forensics.py`, `phase12_real_qr.png`, `phase12_real_traffic_monitor.py`, `scratch_audit_identity.py` (class C — debug/leftover).

### 2. Which must be preserved?
All **6 class-B** entries — `frontend_candidate` (the live Caddy root), `frontend_current` (rollback handle), `releases/`, `frontend_releases/`, `backups/`. The 7 class-C entries are disposable but must **not** be deleted as part of the deploy; leave them in place.

### 3. Which conflict with main?
**None.** Zero of the 13 untracked paths collide with any of the 93 files changed across the 18 commits, and Oracle has no tracked modifications. A `--ff-only` merge cannot conflict.

### 4. Recommended exact deploy sequence
Phase A capture rollback point (git state, untracked inventory, `pg_dump`, image tags, symlink target) → Phase B add the 13 paths to `.git/info/exclude` (**never** `.gitignore`) and re-verify zero collision → Phase C `git fetch` + verify 18 → `git merge --ff-only origin/main` → Phase D rebuild backend+gateway images, build the frontend off-box and rsync into a **new** `releases/v<ts>_phase6_5/` → Phase E re-verify `dup_groups = 0` (migration auto-runs and must log `CREATED`) → Phase F recreate backend → gateway → swap symlink via `mv -T` → **`--force-recreate caddy` (mandatory)** → Phase G run FAZ 5 A–H → Phase H rollback = retag backup images, restore symlink, `git switch --detach f6ec68d`, `DROP INDEX` only if needed. Full commands in FAZ 4.

### 5. What information / decisions are still missing?
1. **Maintenance window.** A live WhatsApp session (`id=68`, user `e512dd40-…`, `CONNECTED`) holds an active lease and will be **disconnected** by the gateway recreate. `WHATSAPP_AUTO_RESTORE="false"` means it will **not** auto-relink. When is it acceptable to drop it, and who re-pairs it?
2. **Frontend build/upload approval.** Confirmed production has no `frontend/node_modules`, so the dist is built on a workstation. Is building here and uploading to a new release dir approved, and is `frontend/.env.production` (tracked) carrying the correct production `VITE_API_URL`?
3. **Deploy scope.** All 18 commits as one fast-forward, or a subset? The range includes docs, test harnesses, and the local-only `frontend/vite.config.local.ts` (`6f4aa00`). Recommendation: full fast-forward; remove `vite.config.local.ts` in a later cleanup commit.
4. **`.git/info/exclude` approval** — the mechanism proposed to keep `.staging_db_secret` out of git without breaking the fast-forward.
5. **Real device availability** for FAZ 5 step H — without it the report must stay `LIVE DEVICE E2E = NOT RUN`.
6. **Who runs the deploy, and is a `docker compose build` window on the box acceptable** (86 GB free, 21 GB RAM available — capacity is fine; it is the live-session interruption that needs a decision).
