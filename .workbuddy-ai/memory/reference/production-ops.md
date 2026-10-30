# Tezlify — production ops, deploy state, verification

Detail moved out of `MEMORY.md` to keep that index inside its injection limit. Read this when you are
about to touch production, deploy, or run the test suites. Invariants live in
`whatsapp-subsystem-invariants.md`; narratives live in `YYYY-MM-DD.md`.

## Production topology & access

- Oracle `130.162.247.20`, `/opt/tezlify`, user `ubuntu`, SSH key `~/.ssh/id_tezlify_oracle`.
  **Push is not deploy.** Compose file `docker-compose.prod.yml` declares **only `backend`, `gateway` and
  `caddy`** — `db` is **NOT** in it (see "The `db` container" below), so
  `docker compose config --services` printing three names is correct, not truncated output.
- Gateway listens on **8787** (`GATEWAY_PORT`) and its container has **no `curl`** — query it with `node`
  inside the container reading `process.env.WHATSAPP_GATEWAY_SECRET`, so the secret never leaves its own
  environment. **Gateway REST auth is `Authorization: Bearer <secret>`** — NOT `X-Gateway-Secret`, which
  is the inbound `/ws/gateway` side.
- `GET /sessions/:sid/conversations?limit=500` returns `{ items, total }` (not `conversations`/`chats`).
- **Production is PostgreSQL, not SQLite.** `DATABASE_URL=postgresql://tezlify:...@db:5432/tezlify`; the
  repo-root `tezlify.db` is stale and `sqlite3` is absent on the host. Use
  `docker exec tezlify-db psql -U tezlify -d tezlify`.
  - `history_sync_states` is keyed `(session_id, jid)` — joining on `jid` alone multiplies rows and
    inflates `count(m.id)`.
  - `conversations` has **no `jid` column**; join `contacts` for `display_name`.
  - In `\pset format unaligned`, a top-level `SELECT` prints the header **once per column** — wrap it in
    a CTE to get one line per row.
- **`WHATSAPP_AUTO_RESTORE` is `true` in production — CORRECTED 2026-10-02.** This note previously said
  `false` ("a gateway restart does **not** re-attach the linked line"). That is **stale and was about to
  mislead a deploy decision**: `docker-compose.prod.yml:146` sets `WHATSAPP_AUTO_RESTORE: "true"`, and
  the **live** gateway's `/health` reports `auto_restore: true` with `sessions: {total:1, connected:1}`
  (measured 2026-10-02, line `id=117` CONNECTED). So a gateway recreate is **expected to restore** the
  linked line from persisted credentials, with no QR. Verify it, don't assume it — the gateway only
  restores what `listRestorableSessions()` returns: sessions active in **both** `gateway_sessions` and
  `whatsapp_sessions` with stored credentials. Manual fallback is `POST /sessions/restore` (gateway,
  `X-Gateway-Secret`, no body), which re-attaches from persisted creds with **no QR**. The historical
  daily logs (2026-09-20, 2026-09-26) describe the earlier `false` era; they are append-only records and
  are left untouched — do not read them as current state.
- **Admin ops log clearing TRUNCATES the container log file in place.** Docker has no clear-logs API, so
  `clear_service_logs` resolves the path from `docker inspect --format {{.LogPath}}` — never from caller
  input: the container NAME passes a `LOG_SERVICES` allowlist and the path comes only from `inspect` — and
  opens it `"wb"`. **Truncate, never delete:** the daemon holds an open descriptor and keeps appending to the
  same inode, so truncation frees space immediately and `docker logs` keeps working, whereas deleting sends
  new output to an unlinked inode (`docker logs` shows nothing until recreate, and the space is not
  reclaimed). Proven by asserting the **inode survives** (`os.stat(path).st_ino`). This is why
  `docker-compose.prod.yml` mounts `/var/lib/docker/containers:rw` — an added privilege, justified in-file
  like the existing `docker.sock` grant. Live 2026-10-01: `caddy` 500 → 0 lines, **192.1 KB** freed, audit
  entry written, all four services writable; `db` holds ~89.5 MB.
- **TRUNCATING A LOG WEDGES THE DAEMON'S LOG READER — `docker logs` then blocks FOREVER.** Measured on a
  throwaway container 2026-10-01: `docker logs --tail 10` took **22 ms** before truncation, had **still not
  returned after 45 s** once the file was truncated in place, and took **19 ms** again after a container
  restart. It does **not** recover as the file regrows. All four production containers were in that state.
  Consequences and the fixes that follow from it:
  - **The Ops panel must never use `docker logs` for the tail.** `get_service_logs` reads the json-file
    **directly** (`_tail_json_log`: bounded backwards window, unwraps `{"log": ...}` records, drops the
    partial first record). Measured on the wedged production files: backend **6.5 ms / 200 lines**,
    gateway 0.6 ms, `caddy` (0 bytes) 0.0 ms and clean, `db` 0.3 ms — where `docker logs` hung. It also
    leaves no stuck D-state `docker logs` process behind. Pinned by
    `test_get_service_logs_never_shells_out_to_docker`.
  - **The 30 s stall the user reported was this**, not the panel's rendering: `get_service_logs` had a 30 s
    timeout around `docker logs`, so **every service-tab switch burned the full timeout and then rendered
    nothing**.
  - **Prevention is rotation, not clearing:** `docker-compose.prod.yml` sets
    `logging: {driver: json-file, options: {max-size: 10m, max-file: 3}}` on caddy/backend/gateway. The
    daemon performs rotation itself and keeps its reader consistent, so the side effect does not occur.
    **As of 2026-10-01 all FOUR containers carry it** (`logopts=map[max-file:3 max-size:10m]`), including
    `db` — see "The `db` container" below. `docker update` cannot apply it: it accepts `--log-driver` only,
    never `--log-opt` (verified on docker 29.8.0 — `docker update --help | grep -i log` is empty), so
    rotation **always needs a recreate**, which is also the only time a compose `logging:` block takes
    effect.
  - To unwedge a container, **`docker restart` is enough** (proven) — a full recreate is not required.

### The `db` container — hand-made, unlabelled, and deliberately NOT in compose

- **`db` is not declared anywhere.** Its `com.docker.compose.project.config_files` label still points at
  `/opt/tezlify/docker-compose.prod.yml` with `service=db`, i.e. it *was* created from a **locally edited**
  copy of that file; `git log -S'  db:' -- docker-compose.prod.yml` returns **nothing**, so the service
  never existed in the repo, and a later deploy's `git reset --hard` removed it from the host file too.
  That left the container an **orphan**: compose warns *"Found orphan containers (tezlify-db) for this
  project … --remove-orphans flag to clean it up"* — a single `up -d --remove-orphans` would **delete the
  database**. Confirmed live 2026-10-01.
- **Therefore `db` is run as a plain container with NO compose labels** (recreated that way 2026-10-01):
  unlabelled means compose cannot see it at all, so `--remove-orphans` cannot reach it. Safe because the
  Operations Center can never act on it either — `ALLOWED_SERVICES = ("backend", "gateway", "caddy")`
  excludes `db`. Do **not** "tidy this up" by adding a `db` service to the prod compose file.
- Its spec (verified 2026-10-01): image `postgres:17-alpine`, `restart=always`, network
  `tezlify_tezlify-internal` **with alias `db`** (backend dials `db:5432`), named volume
  **`tezlify_postgres_staging_data`** → `/var/lib/postgresql/data`, healthcheck
  `pg_isready -U tezlify -d tezlify` (5 s/3 s/×5), cmd
  `postgres -c timezone=UTC -c max_connections=100 -c shared_buffers=512MB -c work_mem=16MB -c fsync=on
  -c full_page_writes=on -c synchronous_commit=on`, user/db `tezlify`. It publishes **no** host ports.
  (`docker-compose.staging.yml` is a **different** stack: `staging-db`, `postgres:16-alpine`, volume
  `pg_staging_data`, user `tezlify_stage` — do not confuse them.)
- **Safe recreate recipe** (used for the 2026-10-01 rotation change): read every parameter back from the
  live container with `jq` (env → repeated `-e "$e"`, **never** `--env-file`, whose quoted values are not
  stripped); pass `--network-alias db`; then `docker stop` → `docker rename … -pre-rotation` →
  **`docker update --restart=no`** (a *stopped* `restart=always` container is restarted by the daemon on
  boot, and **two postmasters on one PGDATA corrupt the data**); create the replacement; verify by row
  count; only then `docker rm` the old one. Wrap it in `trap rollback ERR`. `pg_dump -Fc` first
  (75 MB DB → 4.6 MB dump). Full procedure + traps in the `docker-logs-wedge-diagnosis` skill.
- **A `db` restart used to crash the gateway — FIXED in `7357f3b` (deployed 2026-10-02).** `docker stop
  tezlify-db` SIGTERMs Postgres, which terminates clients with `57P01 terminating connection due to
  administrator command`; the gateway's Node `pg` Pool re-emits that on the **Pool** (`pg-pool/index.js:62
  idleListener`) and Node treats an `'error'` event with **no listener** as fatal — the whole process
  exited (`restarts` +1). The crash bought nothing: the pool had already discarded the broken client and
  would reconnect on the next query, so a blip the gateway could absorb instead dropped every linked line
  for one lease TTL (`GATEWAY_LEASE_TTL_SECONDS=45`). `attachPoolErrorHandler(pool, label)` in
  `whatsapp-gateway/src/database/postgres-pool.js` is now applied at **all four** pool-creation sites
  (in production all four consumers inject the one shared `gatewayPool`). It **logs at error level** and
  is not swallowing: the operation that hit the error still fails. Pinned by
  `scripts/test-postgres-pool-error.mjs` (in `npm test`; falsified via scoped stash →
  `listenerCount('error') 0 !== 1`). Backend was never affected (`pool_pre_ping=True`,
  `pool_recycle=300`). Live proof 2026-10-02: `pg_terminate_backend()` on the gateway's single idle
  connection — the same `57P01`, with **zero downtime** — left `restarts=0`, `state=running`, and an
  unchanged `StartedAt`, while the new handler logged the event.
- **Verify this class of fix with `pg_terminate_backend()`, not a `db` restart.** Killing one idle
  pooled connection from the server side reproduces the client-side `'error'` exactly and disturbs
  nothing. Identify the owner by `client_addr` in `pg_stat_activity` against the container IPs
  (`172.29.0.2`=backend, `.3`=gateway, `.4`=caddy, `.5`=db on `tezlify_tezlify-internal`).
- Local sandbox sets `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:59508`, which tunnels `app.tezlify.com`
  into a 502 — run API probes **from the production host** (Caddy is local there). Playwright exists only
  in the repo `venv` (`venv/bin/python`).
- **Only Caddy publishes host ports** (`80`/`443`); `backend` (8000), `gateway` (8787) and `db` (5432) are
  container-internal, so `curl localhost:8000` from the host fails (empty body, `http=000`). Probe through
  Caddy instead: `curl -s -k https://localhost/openapi.json -H "Host: app.tezlify.com"`. **The OpenAPI
  document is at the root (`/openapi.json`)** — `/api/v1/openapi.json` is a 404. A **405** on a GET to a
  POST-only route (e.g. `/api/v1/admin/ops/logs/clear`) is the *positive* signal that the route is live.
- **Nested `sh -c "… node -e \"…\""` quoting does not survive ssh.** Write the script to `/tmp` and
  `docker cp` it in. A heredoc `<<'JS'` is fine, but `${...}` template literals are still expanded by the
  **local** shell — use string concatenation instead. After `--force-recreate` a container loses its
  `/tmp`, so `docker cp` must be repeated.

## Production browser probes

Procedure in the `real-browser-cdp-verification` skill. Short form:
`scripts/auth_helper.get_ephemeral_auth_token()` (2-hour `auth_staging_sessions` row for user
`f65642ab-...`) + real Chrome with `--host-resolver-rules=MAP app.tezlify.com 130.162.247.20`. The app is
tab-based, not routed: enter via `button[data-tab-id="whatsapp"]`; conversation rows are
`button[data-conv-id]`. Count `ChatThread` instances name-independently by walking the fiber tree from
the `__reactContainer$` root and matching `memoizedProps.messages` + `leadName` — minified names change
per build.

### Host-side probes — traps that produce a FAKE outage

- **`app.tezlify.com` does NOT resolve from the production host itself** (`getent hosts` fails — Oracle
  hairpin DNS), so `curl https://app.tezlify.com/` returns **000**, which reads as "site down". Probe the
  local edge instead: `curl -sk -H 'Host: app.tezlify.com' https://localhost/` → **200** (plain
  `http://localhost/` also 200).
- **The backend's `:8000` is NOT published on the host** (`docker port tezlify-backend` is empty), so
  `curl localhost:8000/health` → **000**. Probe from inside the container, or go through caddy.
- **The gateway's health port is `8787`** — that is its own healthcheck target, not 3000/8080/3001/8000
  (all of which refuse). It returns `database=connected`, `pool`, `sessions={"total":1,"connected":1,
  "pending_qr":0}`, `orphaned_sessions`, `auto_restore=true` and `live_session_ids`.
- **Never grep logs for a bare `502`** — `127.0.0.1:50224` matches it, so a healthy `200 OK` access line
  reads as a 502. Anchor the pattern (`" 502 `, `"status":502`).

## Release mechanics (`scripts/deploy/host-release.sh`) — re-measured 2026-10-01

- **The cutover is UNCONDITIONAL.** `docker compose up -d --force-recreate backend gateway` runs on every
  release, **including with `--skip-build`** (that flag only skips the image build, not the cutover). So
  even a memory/docs-only commit restarts both services — and a gateway restart drops its in-memory stores,
  which WhatsApp does NOT rebuild for an existing session (§A6). **Never deploy docs-only commits.**
- **`frontend_candidate` is a DIRECTORY, not a symlink.** `host-release.sh` sets
  `FRONTEND_DIR=/opt/tezlify/frontend_candidate`, deletes its contents and unpacks the tarball in place,
  keeping the previous copy at `frontend_candidate.prev-<TS>`. Caddy bind-mounts that directory at
  `/srv/frontend` (`rw=false`), so **Caddy is NOT recreated** — the release only runs
  `compose up -d --force-recreate backend gateway`. Writing into the already-mounted directory is served
  immediately: proved 2026-10-01 by `tezlify-caddy` being **Up 23 h** while serving a bundle written at
  12:50 UTC, with the served `assets/index-EbhNawq7.js` sha256 matching the file in `frontend_candidate`
  byte-for-byte. An earlier note here claimed an atomic symlink swap (`ln -sfn` + `mv -T`) plus a forced
  Caddy recreate — **that is stale; verify before trusting it.** (`/opt/tezlify/releases/` still exists but
  is NOT written by the current script; the newest entries are from 2026-09-30.)
- **The deploy audit markers are `/opt/tezlify/.deployed-commit` (the SHA) and
  `backups/releases/<TS>/release.json`** — sha, built images, `released_at`, frontend tarball name, and
  `previous_backend_image`. Rollback: `bash scripts/deploy/host-release.sh --rollback-to <TS>`, using the
  `tezlify-backend:pre-<TS>` / `tezlify-gateway:pre-<TS>` image tags plus the `frontend_candidate.prev-<TS>`
  directory. `.deployed-commit` is written LAST on purpose (an earlier failure left it pointing at a SHA that
  had been rolled back).
- **Cutover is gated by an isolated candidate container** — `PORT=8001`, gateway off
  (`GATEWAY_ENCRYPTION_KEY=`), `SKIP_JOB_RECOVERY=true`, env copied from the **LIVE container**, never from
  `.env.production` (its quoted values break `docker run --env-file`, and the first attempt died on a quoted
  `DATABASE_URL`). It must answer `/health` before traffic moves; the old container serves throughout. After
  cutover the script re-reads `docker inspect --format {{.Image}}` and **refuses to report success** if the
  live image differs from the one it built.
- **The script itself runs `git reset --hard <sha>`** — it demands `--force-reset` when the tree is dirty and
  first saves `worktree-unstaged.patch` / `worktree-staged.patch` under `backups/releases/<TS>/`. So manual
  `git reset --hard` in `/opt/tezlify` is still the wrong way to deploy (use the script), but a dirty tree is
  no longer the deploy marker it once was.
- Cache policy is already right: entry document `no-cache, no-store, must-revalidate`, hashed assets
  `immutable, max-age=31536000` — a plain reload picks up a deploy; no hard refresh needed.
- Release dirs are **build output only** (`index.html` + `assets/`, ~960 KB): no `node_modules`, no git
  repo on the host, so build locally and upload with `rsync`.
- `frontend/package-lock.json` does **not** exist -> `npm ci` is impossible; use `npm install` / existing
  `node_modules`. `.env.production` and `.env.local` both blank `VITE_API_URL`, but production always
  resolves same-origin `/api/v1` (`resolveApiBase()` short-circuits on `isRemoteHost`).
- Vite's `prepareOutDir` calls `emptyDir` on `dist/assets`; the sandbox's bulk-delete guard (>50 files)
  makes that fail and it *looks* like a build error. `rm -rf dist` first.

### The candidate container runs migrations against PRODUCTION, then its log is DELETED

Step 3 of the release lifts the new image in an **adacık (candidate)** container on `PORT=8001` with
`GATEWAY_ENCRYPTION_KEY` empty — safe for the WhatsApp session, but it points at the **same production
database** and therefore executes the **whole migration suite** against live data. After cutover the
script removes that container, and Docker deletes its log directory with it.

Consequence, measured 2026-10-27: a conversation vanished during the deploy window and **no surviving
artifact says which migration did it**. `docker ps -a` has no candidate, and
`/var/lib/docker/containers/` has no log dir for it. Any destructive migration
(`purge_raw_jid_identity_data`, `merge_deferred_lid_ghosts`, `purge_empty_ghost_conversations`,
`DELETE FROM conversations …`) is **unattributable after the fact**.

Rules that follow:
- **Never attribute a count drop to a migration without the candidate's log — you cannot get it.**
  Report `UNATTRIBUTED_HISTORICAL_EVENT` instead of naming a plausible function.
- Before a release, capture counts; after it, capture again. The deploy is the only window where a
  destructive migration can run unobserved.
- `purge_empty_ghost_conversations` logs **only when `deleted > 0`** (plus the exception branch), so
  *absence* of its log means it deleted 0 that run — that is a usable negative, but it says nothing
  about an earlier run whose log is gone.
- To make this observable, the candidate would have to persist its stdout somewhere (or migrations
  would have to write audit rows). Not done yet — it is the direct cause of the unattributed event.

## Deploy state (2026-09-26; refreshed 2026-10-02)

- **Measured 2026-10-27 20:24Z (LATEST): deployed = `978c1fe9ba479bbea46f8c324d7b4a21968f87cf`**
  (`feat(deploy): yikici migration'i HICBIR container kalkmadan durdur`), release
  `backups/releases/20261027T202239Z`, backend `sha256:67906f5f…`, 94 s, `RELEASE_EXIT=0`,
  `--no-gateway`. Docs commit `8e26844` on top is report-only and needs **no** deploy (HEAD ≠ deployed
  is expected here).
  - **Gateway still untouched**: container `5b867095d376`, `StartedAt=2026-10-27T17:25:57.8181699Z`,
    `restarts=0`; `db f6d79c4a1f8b` / `caddy ee66a5cab371` unchanged; only backend recreated
    (`969a0c8f1774`, 20:24:01). Line **200 CONNECTED**, gateway `/health` `{total:1,connected:1,
    pending_qr:0}`, `auto_restore=true`. **No QR, no pairing.**
  - Counts `123|1096|1535` identical at all three checkpoints (before candidate / after candidate /
    after cutover); schema fingerprint `82e6003b1b9f → 82e6003b1b9f`; `migration_lines=24`;
    `candidate.log` preserved (36 lines, zero WARNING/ERROR). 1099 seen at 20:25Z is post-cutover
    organic traffic, not migration.
  - `/health.whatsapp_data_audit` now carries **`table_status` + `table_ready`** (`ALREADY_PRESENT` /
    `true`). `failed==0` alone does not mean the table exists.
- **The deploy script that runs is ALWAYS the OLD one** — the new `host-release.sh` only lands after
  the script's own `git reset --hard`, so a release cannot be protected by a guard it ships. To run the
  target commit's script: `git show <sha>:scripts/deploy/host-release.sh > /tmp/hr.sh && bash /tmp/hr.sh
  <sha> --no-gateway`. `PROJECT_DIR="/opt/tezlify"` is hardcoded, so /tmp works, and the sha256 matches
  local byte-for-byte (measured `e9d0f3c7…`). `migration_guard.py` is read from the **target commit**
  for the same reason; if absent → `skipped_no_guard` (rollback stays possible, recorded in
  `release.json`).
- **Destructive-migration gate** (`migration_guard.py` + `--allow-migrations`): added `DELETE FROM` /
  `TRUNCATE` / `DROP TABLE` / `DROP COLUMN` in `backend/app/core/migrations.py` or `main.py` → exit
  **3** → `die` **before any container starts** (the gate sits above the `--dry-run` exit). `UPDATE …
  SET` is reported only; `DROP INDEX` is out of scope. Measured `407e8e4..3d50c1d` → 3, and the
  candidate-window count comparison refuses cutover on a drop.
- **`docker rm -f` deletes the candidate's log dir.** The candidate log is now copied to
  `releases/<TS>/candidate.log` **before** removal; count + schema fingerprints are captured before the
  candidate starts and after cutover, and `release.json` carries a `migrations` block.
- **pytest would run migrations against whatever `settings.DATABASE_URL` says** — the autouse
  session-scoped `run_db_migrations` fixture in `backend/tests/conftest.py`. A leftover production DSN
  in the shell would silently migrate production. `assert_test_db_is_not_remote()` now refuses any
  non-localhost host (escape hatch `TEZLIFY_TEST_DB_REMOTE_OK=1`); verified against the real prod DSN.
- **Schema gotchas for integrity probes:** `messages` has **no `contact_id`** — contact consistency is
  `conversations.contact_id`. The **backend container has no `wget`** (use `curl`); the **gateway
  container has no `curl`** (use `node`). `curl 127.0.0.1:8000` from the host is closed — probe inside
  the container.
- **Measured 2026-10-27 19:17Z (previous): deployed = `9a772068d38bf5333a696efd198fc20794728c25`**
  (`fix(whatsapp): ghost purge audit row was never written`). Two `--no-gateway` releases, both
  `RELEASE_EXIT=0`:
  - `8cd4223` → `backups/releases/20261027T190404Z`, backend `7c20f3b`, 94 s.
  - `9a77206` → `backups/releases/20261027T191541Z`, backend `3cfdd`, 90 s.
  - **Gateway untouched by both**: same container `id=5d37669a9671`, `StartedAt=17:25:57`,
    `live_gateway_image=a1ba2` unchanged, `gateway_touched: false` in both records. Line 200 stayed
    `CONNECTED`/`is_phone_online=t`; gateway `/health` `{total:1,connected:1,pending_qr:0}`,
    `auto_restore=true`. **No QR, no pairing, no session touch.**
  - Counts identical before/after **both** deploys: **123 conversations / 1050 messages / 1535
    contacts / 1 audit row**. The recurring `124→123` did NOT reproduce this time.
  - **`--no-gateway` is still valid** for backend-only commits: the deployed baseline at that time was
    `9a77206` (now `978c1fe`), which already contains every gateway change up to `a46eb0e`.
- **"No docker locally" does NOT mean "cannot deploy".** A previous session marked the deploy
  `BLOCKED` on `NO_DOCKER_HERE`; that was wrong. `host-release.sh` is a **HOST-side** script — run it
  over SSH (`ssh -i ~/.ssh/id_tezlify_oracle ubuntu@130.162.247.20 'cd /opt/tezlify && bash
  scripts/deploy/host-release.sh <sha> --no-gateway'`). Pipe a `<<'EOS'` heredoc to `bash -s` for
  multi-step probes; never nest `sh -c "… node -e \"…\""` (quoting does not survive ssh).
- **A function-local `import` binds the name for the WHOLE function.** `main.py`'s new `ghost_purge`
  audit block used `AsyncSessionLocal` above the `from … import AsyncSessionLocal` that sits further
  down in `lifespan` (the retention block) → the use compiled to `LOAD_FAST_CHECK` (offset 1516),
  first `STORE_FAST` at 2074 → **`UnboundLocalError`**, swallowed by the enclosing
  `except Exception`. The audit row was dead code and the only log line that could say so was the one
  that failed. Not a `NameError` — do not reason about this as "missing attribute". Falsified by
  stashing only `main.py`: the bytecode guard reports `{'AsyncSessionLocal': (1516, 2074)}`.
  Fixed in `9a77206` by extracting `_record_ghost_purge_audit()` with the import inside it.
- **Measured 2026-10-27 17:26Z: deployed = `a46eb0e214ed892f758b207cf16e4744ffc0065d`**, released
  17:23:40Z–17:26:44Z, `RELEASE_EXIT=0`, cutover `backend=sha256:a6ca7 gateway=sha256:a1ba2`. This one
  **did recreate the gateway** (StartedAt 11:39:38 → 17:25:57) — the range `70c0741..a46eb0e` contained
  `whatsapp-gateway/` (`bfc218c`, pushed earlier but never deployed), so `--no-gateway` **refused with
  exit 1** and the choice was "recreate or do not deploy". Session came back from credentials with **no
  QR** (`auto_restore=true`, `sessions:{total:1,connected:1,pending_qr:0}`); in-memory store was lost (§A6).
  Counts moved 124→123 / 1536→1535 (see the candidate-container section above).
  **`--no-gateway` is usable again from here** for any backend-only commit, because the deployed range
  now starts at `a46eb0e`, which already contains the gateway change.
- **Measured 2026-10-02:** the prod checkout is CLEAN at `e8a86ee`, `/opt/tezlify/.deployed-commit`
  = `e8a86ee8799c9e3657664208e0ccf40768ac2168`. This is a **deliberate rollback** (below), NOT the tip of
  `main` — do not "fix" it by deploying `main` without checking with the user. The older note that the tree
  is "deliberately left dirty as the deploy marker" at `359fe6d` is **stale**: `host-release.sh` resets hard
  to the target SHA and then asserts the tree is clean. Still — deploy via the script; never hand-reset.
- **2026-10-02 rollback to `e8a86ee` (user-requested).** Releases `20261002T122733Z`, then
  `20261002T122857Z`. The FIRST was **incomplete**: it rolled back the backend but left the newer frontend
  live. Cause: `release.sh` builds the frontend from the **local working tree**
  (`FRONTEND_DIR="$REPO_ROOT/frontend"`), not from the target SHA — so `release.sh <old-sha>` ships the old
  backend with the CURRENT frontend. Detected by `grep -c "have_rows=True"` → 0 while the served bundle was
  still `index-CD0gj4e3.js`. Fixed by `git checkout e8a86ee` locally, rebuilding, re-releasing. Final proof:
  served `index-DEU-2HqI.js` **200** + `WhatsAppHubPage-GJ3_Pr5f.js` **200**; newer `index-CD0gj4e3.js` /
  `WhatsAppHubPage-VbDT9_Pt.js` **404**; caddy 200; line `connected=1`. Repo side: `5c1c76d` reverts
  `d229269`, so `main`'s code == `e8a86ee` (history NOT rewritten; restore with `git revert 5c1c76d`).
- Live: frontend `5916ff1` chat-thread singleton + `8177a2b` i18n missing keys; backend `9981298`
  502-on-short-conversation + `6c7214a` ~4 s open-path bound; naming fix
  `55f994e`/`1030850`/`4bd7791`; gateway `4fc791a` chat-ordering stamp. Restarts are routine and the line
  re-attaches via `POST /sessions/restore` (no QR) — proven again 2026-09-26 09:21 (`restored:1`,
  CONNECTED, +905413749073).
- **Frontend release handle:** `frontend_candidate` -> `releases/v20260926_i18n_missing_keys` (live bundle
  `index-y-X3DlGp.js`, sha256 `52cead01…`); rollback target `v20260926_phase6_8_chatthread_singleton`
  (`index-3UEtgr4K.js`).
- **Residual, by design:** 19 zero-row conversations still 502 (17 no evidence row, 4 NOT_CHECKED,
  2 NO_MESSAGES; `is_history_exhausted_or_stalled` does not treat `NO_MESSAGES` as exhausted). All stale
  (newest 2026-08-27, oldest 2026-03-24) and none in the top 8 by recency.
- `ddbfbf4`'s large `session-manager.js` (+299) / `socket-events.js` (+105) rewrite remains **undeployed**
  by explicit choice. Prod's `socket-events.js` has no `selfJid` block in its connect handler, so patches
  authored against `ddbfbf4`'s shape do not apply there.
- **A line re-link without history purges message history.** A new `whatsapp_sessions` row created at
  09:34:56 on 2026-09-26 (id 86, the user's own number `+905413749073`) rebuilt all 113 conversation rows
  and dropped `messages` 529 → 44. Not a code bug — a re-link — but it invalidates any before/after
  comparison across that timestamp.
- **2026-10-01:** deployed `7370c18` — `48fc52e` (ops Logs-tab "clear all" button) plus `7370c18` (the
  `wa_merge_locks` lock-table fix, §N). `RELEASE_EXIT=0` ("SÜRÜM TAMAM: 7370c18"), frontend hash parity,
  `/health` OK. The `/var/lib/docker/containers` mount is live (`rw=true`) and
  `POST /api/v1/admin/ops/logs/clear` is present in the live OpenAPI.
- **2026-10-01 (later):** deployed `f63a0f1` (the log-tail direct read). `RELEASE_EXIT=0`
  ("SÜRÜM TAMAM: f63a0f1"), frontend hash parity, public `/health` OK. Verified by running the DEPLOYED
  `ops_service.get_service_logs` inside the container — backend 25 ms / 200 lines, gateway 23 ms / 199,
  caddy 23 ms / 178, db 19 ms / 117, all `error=None` (previously a 30 s timeout returning nothing) — and
  by the deployed `ops_service.py` sha256 matching `git show HEAD:` byte-for-byte. `docker logs` was
  unwedged for all four with `docker restart` (now 22–23 ms). Rotation applied to backend+gateway; caddy
  and db still `map[]`.
- **2026-10-01 (later still): log rotation completed on ALL FOUR** — an ops action only, no code change, so
  the deployed SHA is still `f63a0f1`. `caddy` via
  `docker compose -p tezlify -f docker-compose.prod.yml up -d --force-recreate --no-deps caddy`; `db` via
  the unlabelled recreate described above. Verified: all four `logopts=map[max-file:3 max-size:10m]` and
  healthy, `db` has **0** `com.docker.compose` labels and the compose orphan warning is **gone**, backend
  resolves `db` (172.29.0.5), `docker logs` is **0.02 s** on all four (was 45000 ms), and the DEPLOYED
  `get_service_logs` reads all four at their **new** container paths — backend 27.1 ms/200 lines,
  gateway 26.5/199, caddy 17.5/26, db 16.7/9, all `error=None`. Row counts after the `db` recreate matched
  the pre-recreate baseline exactly (sessions 3 / conversations 120 / messages 699 / contacts 1525 /
  lid_mappings 17508). Site 200 / 5.5 ms, API 200 / 7.5 ms, `gateway_bridge.connected: true`.
- **2026-10-02:** deployed `7357f3b` (the `pg` Pool `'error'` handler — gateway survives a DB blip).
  `RELEASE_EXIT=0` ("SÜRÜM TAMAM: 7357f3b"), candidate health gate passed, cutover image identity
  verified, hash checks OK, frontend 200. Release record `backups/releases/20261002T072012Z/release.json`
  (`live_backend_image`/`live_gateway_image` equal the built digests); rollback tags
  `tezlify-{backend,gateway}:pre-20261002T072012Z`. **No `--frontend-tar` was passed** — the frontend
  did not change, and `host-release.sh` only rewrites `frontend_candidate` when one is given (line 294);
  the served bundle stayed `index-EbhNawq7.js`. Prod checkout was clean beforehand, so no
  `--force-reset`. Verified live with `pg_terminate_backend()` (zero downtime): `restarts=0`,
  `StartedAt` unchanged.
  - **Open at deploy time:** the WhatsApp line (session 116, +905413749073) is `DISCONNECTED` with
    `error_message=WHATSAPP_LOGGED_OUT`, stamped `2026-10-01 22:06:51` — WhatsApp unlinked the device
    ~9 h BEFORE this deploy, `gateway_sessions` went `is_active=f` and `session_credentials` was emptied,
    so the gateway correctly had `discovered=0` to restore. It cannot be restored from credentials;
    it needs a **QR re-pair**.
- **2026-10-02 (later):** deployed `73c9fe0` (`_bulk_channel_cache` keyed by `gateway_id` — see the
  baselines section). `RELEASE_EXIT=0` ("SÜRÜM TAMAM: 73c9fe0"), candidate health gate passed, cutover
  `backend=sha256:a96bc` / `gateway=sha256:ac49b`, release record
  `backups/releases/20261002T080620Z/release.json` (`live_*_image` equal the built digests,
  `frontend: null`), rollback tags `tezlify-{backend,gateway}:pre-20261002T080620Z`. **No
  `--frontend-tar`** — frontend unchanged, served bundle stayed `index-EbhNawq7.js`. Delta audit:
  the `backend/app/` delta in `7357f3b..73c9fe0` was **only** `sync.py` (+14/−5) → self-contained.
  Prod checkout clean beforehand. Verified live: the deployed `sync.py` sha256 is
  `81e0b3df…6108a8` = local (the script's `verify_blob` does **not** cover `sync.py`, so hash it
  yourself); `StartedAt` moved only for backend (08:06:28) + gateway (08:06:34), db/caddy unchanged;
  API 200/39 ms, frontend 200, gateway `/health` `database: connected`, `restarts=0` on all four.
  Recreating the gateway stranded nothing because **no line was CONNECTED** (116 still logged out,
  4/5 stale `diag`) — check this before any gateway recreate. Auto-restore is now `true` (see the
  corrected note above), so a recreate should re-attach the line; confirm `auto_restore` on the live
  `/health` rather than trusting either value from memory.
- **2026-10-02 (latest):** deployed `8d0b66c` (the early-loading-gate fix — see invariants §O).
  **This one included a frontend change**, so `--frontend-tar` WAS passed: local `npm run build` from a
  clean tree → `tar -czf … -C dist .` (the tar must have `./index.html` at its root) → `scp` →
  `bash scripts/deploy/host-release.sh 8d0b66c --frontend-tar /tmp/tezlify-frontend-dist.tar.gz`.
  `RELEASE_EXIT=0`, "SÜRÜM TAMAM: 8d0b66c", record `backups/releases/20261002T095006Z/release.json`.
  **The image build was a full cache hit (15 s)** because no backend/gateway *source* changed — a short
  release duration is not a symptom here.
  - **`--dry-run` cannot validate the SHA.** Its `run` helper prints commands without executing them, so
    `git fetch` never happens and it dies with "hedef SHA bu checkout'ta yok (push edildi mi?)" even
    though the push succeeded. Fetch on the host by hand first, then dry-run.
  - Verified live (the script's `verify_blob` covers only three hardcoded paths — hash your own files):
    `.deployed-commit` `8d0b66cbf80aa…`; in-container `sync.py` sha256 `01045b30…b21b` and
    `whatsapp_service.py` sha256 `3b8b8000…c0f`, **both = local**; `_GATEWAY_HISTORY_READY_TIMEOUT_S`
    present ×3; `whatsapp_service.py:414` carries the progress cap.
  - Frontend: `frontend_candidate/index.html` sha256 `296e2f71…1745` = local `dist`, and the served
    bundle moved `index-EbhNawq7.js` → **`index-DAy8k-4P.js`** (confirmed over HTTP, not just on disk).
  - `StartedAt` moved only for backend (09:50:13) + gateway (09:50:19); db/caddy unchanged; all four
    healthy, `restarts=0`; API `/health` 200/39 ms; frontend 200.
  - **Line 117 was CONNECTED throughout and came back CONNECTED after the gateway recreate**
    (`auto_restore: true`, gateway `/health` `sessions {total:1, connected:1}`, DB row still
    `is_phone_online=t` with its stamp). This is the empirical refutation of the old
    "a recreate strands the line" note.
  - Rollback: `bash scripts/deploy/host-release.sh --rollback-to 20261002T095006Z`.
- **2026-10-02 (latest):** deployed `e8a86ee` — the chat scroll/older-page fixes (`6479441`) plus the
  memory commit. Frontend-only change, so `release.sh e8a86ee --skip-build`.
  `RELEASE_EXIT=0`, "SÜRÜM TAMAM: e8a86ee", record `backups/releases/20261002T112215Z/release.json`,
  rollback `--rollback-to 20261002T112215Z`.
  - **`--skip-build` proven safe before use:** `8d0b66c..e8a86ee` touched **0** files under
    `backend/` + `whatsapp-gateway/`, AND the host's `tezlify-{backend,gateway}:latest` digests were
    **identical to the running containers' `.Image`** (backend `d10e2b41…`, gateway `da7b1563…`).
    So skipping the build still ships exactly the code that was already running. Rollback tags are
    created before the build regardless (`host-release.sh:214-216`).
  - **`release.sh` runs `npm run build` itself → the bulk-delete guard kills the release at the
    frontend step.** First attempt died with
    `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":54,"threshold":50,"scope":"turn"}`
    **before touching the server** (no partial deploy). Fix: `mv frontend/dist /tmp/…` **before**
    invoking `release.sh`, then re-run. `tsc` passes at that step.
  - Verified live, **byte-identical**: `index.html` `58477e154ee3808f…`, `index-DEU-2HqI.js`
    `df1e3a7e97c38747…`, `WhatsAppHubPage-GJ3_Pr5f.js` `0a90bb4098c1020c…`,
    `LeadDetailDrawer-DB-3LMAX.js` `190b1d29f9325069…`; the served `index.html` points at the NEW
    bundle and the **old `index-DAy8k-4P.js` is now 404**. `.deployed-commit` = `e8a86ee8799c…`.
  - `StartedAt` moved only for backend (11:22:20) + gateway (11:22:25); db/caddy unchanged; all four
    healthy; API `/health` 200/39 ms.
  - **The line is NOT connected — `sessions {total:0, connected:0}`.** `whatsapp_private.gateway_sessions`
    87 rows / **0 active**; `whatsapp_private.session_credentials` = **0 rows**; gateway log
    `session_registry_initialized: persisted_session_directories=26, restored=0` and
    `session_registry_restored: discovered=0`. This is the documented `WHATSAPP_LOGGED_OUT` state from
    2026-10-01 22:06:51 — it needs a **QR re-pair**, and the gateway's `discovered=0` is CORRECT.
  - ⚠️ **`public.conversations` and `public.messages` are EMPTY (0 rows, `pg_relation_size` = 0 bytes)**
    — the reference recorded 120/699 on 2026-10-01. `n_tup_del`: messages 72 737, conversations 9 023;
    `n_dead_tup` 0 in both. **This predates the deploy**: the relation files' mtimes are
    `messages` 11:20:34.063991 / `conversations` 11:20:34.078991 / `whatsapp_sessions` 11:20:28.244965
    (UTC), i.e. ~100 s BEFORE the 11:22:15 cutover, and **neither file was written again after the
    cutover** — so the freshly-started backend deleted nothing. The release path has no DB writes
    (grep for `psql|DELETE|TRUNCATE|drop|migrat` under `scripts/deploy/` → one log line only) and
    `tezlify-db` was never restarted. Leading, **unproven** mechanism: a **line deletion** (cascade),
    matching `whatsapp_sessions` being written at 11:20:28 and `public.whatsapp_sessions` now holding
    only the September rows (id 4, 5) — session **117** (CONNECTED at the 09:50 deploy) and **116**
    are gone. **No recovery exists** (`archive_mode=off`, no backups).
    - **RESOLVED 2026-10-02 11:41 — the QR re-pair repopulated them (measured, not inferred).** All
      **118** `conversations` rows were created **11:29:46.52 → 11:29:50.20** and all **480** `messages`
      **11:29:46.72 → 11:30:24.09**; `contacts` still reaches back to **2026-09-10**, so contacts were
      **not** cascaded. The 120/699 → 118/480 delta is therefore **not** a like-for-like loss — a re-link
      rebuilds history from whatever WhatsApp actually delivers (see the re-link note above). The empty
      window is real, its cause (a line deletion at ~11:20:28) is still **unproven**, and what restored
      the data was **re-pairing**, not any backup (there is still none).
    - **Table identity — do NOT conflate these (a wrong note cost a full debugging cycle).**
      `public.messages` **IS** the WhatsApp chat store (25 columns: `conversation_id`, `direction`,
      `message_type`, `body`, `media_*`, `sender_phone`, `recipient_phone`, `external_timestamp`,
      `wa_message_id`, … — no `campaign_id`/`rendered_message`/`target_phone`). There is **no**
      `whatsapp_private.messages` at all; that schema holds only `event_outbox`, `gateway_sessions`,
      `history_sync_states`, `lid_mappings`, `processed_events`, `retry_messages`,
      `session_credentials`, `signal_keys`, `socket_leases`. The **CRM campaign log** is
      `public.message_logs` (**2 rows**), which is a different table entirely.
- **2026-10-02 (latest): deployed `8ce2e7a`** — the load-older provider-timeout fix (`d229269`, §P) plus
  the memory commit. **A real build was required** (backend source changed), so `--skip-build` was NOT
  used; the frontend changed too, so the script produced and shipped its own tarball. Pre-step as always:
  `mv frontend/dist /tmp/…` before invoking `release.sh` (the script runs `npm run build` itself).
  `RELEASE_EXIT=0`, "SÜRÜM TAMAM: 8ce2e7a", record `backups/releases/20261002T115746Z/release.json`,
  rollback `bash scripts/deploy/host-release.sh --rollback-to 20261002T115746Z`.
  - Verified: `.deployed-commit` `8ce2e7a4b8fe96d560098a3603d22820b1d19a11` = local HEAD; in-container
    sha256 **byte-identical** for both changed backend files (`whatsapp_service.py` `3c935deb…8759`,
    `history_evidence.py` `726d40fe…77f8`) — `verify_blob` covers neither, so hash your own; the fix's
    lines present at `whatsapp_service.py:1069` (`rows or before_row is not None`) and `:1136`
    (`have_rows=True`).
  - `StartedAt` moved only for backend (11:57:54) + gateway (11:58:00); caddy (2026-10-01T17:44:18) and
    db (2026-10-01T17:45:08) unchanged; all four `running`.
  - **The line came back after the recreate:** gateway `/health` `auto_restore=true`,
    `sessions {total:1, connected:1, pending_qr:0}`, `database=connected`. Served bundle moved
    `index-DEU-2HqI.js` → **`index-CD0gj4e3.js`**; the old `index-DEU-2HqI.js` and
    `WhatsAppHubPage-GJ3_Pr5f.js` are **404**. API `/health` healthy, `gateway_bridge.connected: true`.
  - **End-to-end proof of the fix, on the reported conversation itself** (conv 18192, `before=107847`,
    run inside the backend container): **before** `RAISED after 25.2 s: WhatsAppHistoryTimeout`;
    **after** `OK after 25.2 s: messages=0 has_more=True oldest_message_id=None` with the log line
    `Provider history timed out (conv=18192); serving local rows instead of failing` — no exception, and
    `provider_exhausted` still `False` (H-3 intact).

## Candidate isolation — one production DB write is an isolation failure

- The candidate must start on an **isolated schema+data copy**, not on the production database.
- **There may be MORE than one connection string** in the candidate env. The first fix (2026-10-27)
  rewrote only the exact variable `DATABASE_URL`; live env also carried `GATEWAY_DATABASE_URL`, so
  the candidate's backend ran on the clone while its gateway layer was still pointing at production.
  The guard's own regex (`DATABASE_URL=.*/<db>`) matched that *second* line as a substring and
  refused the deploy — correct decision, but the wrong diagnosis (it pointed at the already-rewritten
  first line, not the unrewritten second one).
- **Rule: rewrite by family, not by exact name.** Any variable whose name ends in `DATABASE_URL` is
  a connection string. **Rule: verify positively.** Instead of "does any line contain the production
  name?" (negative), assert "every connection string's path equals `/<candidate_db>`" (positive).
  A leftover production URL is reported **by variable name**, making diagnosis immediate.
- The shell's independent second proof must also be **anchored** (`^([A-Za-z_][A-Za-z0-9_]*)?DATABASE_URL=`)
  and **boundary-checked** (`([?]|$)` on the database name). Without the boundary, `/tezlify_cand_X`
  is wrongly flagged because `tezlify` appears as a prefix. Without the anchor, `GATEWAY_DATABASE_URL=`
  is wrongly matched as a substring of the full name.
- The candidate clone DB is created before the container starts, and is dropped **before** cutover.
  `candidate-data-drop.txt` must never exist in the release directory; its presence means the clone
  touched production rows, and that is an **isolation failure** — it stops the deploy unconditionally.
- `host-release.sh`'s `verify_blob` list is **hardcoded** — it does not cover files changed by your
  commit. For a change outside that list, hash it yourself to prove the running code is the reviewed
  code.

## Verification baselines

- Last run (2026-10-02, after the load-older fix): backend **1440 pass / 4 skip / 0 fail** with
  `-p no:randomly`, **and green under `pytest-randomly` at three explicit seeds** (12345, 777,
  20261002) — the suite is **order-INDEPENDENT again**. gateway `npm test` exit 0 with every suite
  PASS (incl. `test-postgres-pool-error.mjs`); frontend `npm run build` exit 0, `tsc` clean; real
  Chrome `verify:browser` **10 passed / 0 failed** (A–J).
  (Baselines: **1438** after the early-gate fix, **1440** after the two load-older tests, **1432** after
  the cache fix; **+6** from the early-gate tests.) **The load-older patch was REVERTED** (`5c1c76d`), so
  its **2 tests** and its `verify:message-timeout-budget` script are gone — treat the **pre-patch**
  baseline as current. (The rule stands: an unwired verify script never runs in any gate.)
- **`pytest-randomly` is easy to fake.** `-q` suppresses its seed banner, so a run can *look* seeded
  without being so. Prove it reshuffles by diffing `--collect-only -q` output across two seeds
  (12345 vs 777 gave different orders on 2026-10-02). A green suite at several *verified* seeds is the
  evidence; three green runs at one accidental order is not.
- **`pytest-randomly 4.1.0` IS installed** — the backend suite *was* order-dependent until
  2026-10-02. Measured BEFORE the fix: random order → **21 failed / 1410 passed**; `-p no:randomly`
  → **1431 passed / 4 skipped, exit 0**. Failures were `test_whatsapp_sync_job.py` (19) +
  `test_whatsapp_live.py` (2), signature `AssertionError` — **not** `no such table`, so not a
  provisioning gap — and the file passed **alone** (46 passed).
  - The poisoning agent was a **real production bug** at
    `backend/app/services/whatsapp/orchestration/sync.py`:
    `_bulk_channel_cache: Dict[str, Any] = {"ok": False, "checked_at": 0.0}` was **module-global**,
    assigned by **reference** (`self._bulk_channel_cache = _bulk_channel_cache`), and
    `_bulk_channel_available(self, gateway_id)` **never keyed on `gateway_id`**. So one line's failed
    bulk probe answered "bulk channel unavailable" for **every** line for 300 s, silently degrading
    all of them to legacy per-chat sync — the invariant §N already states: key a process-global flag
    by the **resource**, not by a coarse family label.
  - **FIXED 2026-10-02.** The cache is now `Dict[str, Dict[str, Any]]` keyed by `gateway_id`, with
    `_BULK_CHANNEL_TTL_SECONDS = 300`; an unknown gateway is probed (never treated as a cached miss).
    New regression test `test_bulk_channel_probe_is_cached_PER_GATEWAY` (falsified: reverting only
    `sync.py` fails it on `assert False is True` at the cross-gateway line).
  - **A shape change to a module-global has OTHER writers.** Grep every reader/writer first. Two test
    files still reset it by flat key and silently stopped isolating tests — the four natural-order
    failures this change first produced: `test_whatsapp_sync_job.py` `_drain_jobs` (flat `["ok"]` /
    `["checked_at"]`) and `test_whatsapp_live.py` `_drain_sync_jobs` (same), plus `test_24`'s
    `_bulk_channel_cache["checked_at"] = … - 301`. All three now target the per-gateway entry /
    `.clear()`.
  - Still re-run with `-p no:randomly` *and* the file in isolation before calling anything
    "pre-existing" or blaming your change.
  - **A cleanup helper whose `clear()` sits AFTER an `await` is a cascade, not a cleanup** (2026-10-28).
    `test_whatsapp_sync_job.py::_drain_jobs` awaited `j.done.wait()` with `timeout=10` and only then
    called `ws._sync_jobs.clear()`. `SyncJob.done` is an `asyncio.Event` set in the job coroutine's
    `finally`; when a test's loop closes with the task still pending that `finally` never runs, so `done`
    is never set and the wait **always** times out. The `TimeoutError` escaped the autouse fixture's
    *setup* → `ERROR`, and because `clear()` was skipped the leaked `SYNCING` job re-stalled **every**
    subsequent test in the module (3 × 10 s). Which test errored depended purely on the random seed
    (green at some seeds, red at others) — it looked like "my new test file broke the suite".
    `test_whatsapp_live.py::_drain_sync_jobs` already had the `try/except`; only this copy did not.
    **Rule:** cleanup goes in `finally`, and a drain helper must never raise. Falsified by replicating the
    old body: `raised=TimeoutError leaked=True`.
  - **RE-PROVISION THE TEST DB BEFORE EVERY FULL RUN** (2026-10-28). Reusing one
    `/tmp/tezlify_clean.db` across back-to-back full runs makes
    `test_campaign_sequence_drip.py::test_campaign_sequence_full_drip_lifecycle` fail with
    `Campaign #N paused: daily_limit_reached (pool size: 1)` → `assert 0 == 2` on `len(seq_leads)`.
    Accumulated campaign rows exhaust a **per-day global counter**. Tell that it is pollution and not
    ordering: **the file fails ALONE too**, and `provision_test_db.py` makes it green in both fixed and
    random order. Always: `PYTHONPATH=. venv/bin/python scripts/provision_test_db.py` (33 tables, 0 rows)
    → then pytest. A green run on a dirty DB proves nothing, and a red one accuses the wrong code.
- Previous run (2026-09-26): backend **1169 pass / 4 skip / 0 fail**; gateway all **8** `npm test` scripts
  pass (`test-system-content-preview.mjs` 14 checks, `test-contact-cache.mjs` 37,
  `test-contact-hydration.mjs` 26); frontend `verify:logic` **45/45** (incl. the two i18n checks),
  `tsc --noEmit` clean, `npm run build` exit 0.
- **`verify:pairing` fails 2 checks with and without recent changes** (`calls=0`, `cancel=0`) — a harness
  failure, not a product one (confirmed by stashing). Do not attribute it to your change.
- Never run pytest on dev `tezlify.db` (or a **data** copy). Build the test DB **schema-only**:
  `sqlite3 tezlify.db .schema > s.sql && sqlite3 /tmp/empty.db < s.sql` -> 22 tables, 0 rows, including
  the raw-SQL tables (`history_sync_states`, `lid_mappings`, `auth_staging_*`) that bare
  `Base.metadata.create_all` misses (it yields only 16). Some modules assert **global** row counts
  (`test_whatsapp_faz9_group_phone_banner.py`), so foreign WhatsApp data fails them for reasons unrelated
  to the change — re-run against an empty schema before blaming code. Fresh pytest basetemp.
- `Scoutify` is a **symlink to `Tezlify`** — pytest tracebacks printing `../Scoutify/backend/...` are the
  same files.
- Compare actual exit codes (piping through `tail`/`head` masks them). **Falsify before trusting:** stash
  the source fix (`git stash push -- <path>`), require the new test to fail on the *precise* assertion,
  then restore. Counter-only assertions can pass under a missing call site, and post-reset counters need
  an explicit baseline, never zero.
- **Parallel `Edit` calls on one file clobber each other** — three concurrent edits to `MEMORY.md` landed
  only the first. Edit the same file sequentially, or rewrite it with one `Write`.

## Latency metrics: ON BY DEFAULT since `a46eb0e` (2026-10-27)

**This section previously said "OFF in production — turning it on is a deliberate, temporary act".
That is now STALE.** The old gate required `WHATSAPP_LATENCY_PROFILING === 'true'` and production
never set it (`printenv` → NOT_SET, absent from all three compose files), so every metric was silent
and "measure the QR pairing" had no number to read. A metric that needs an operator to remember an
env var is a metric that does not exist, so the default flipped:

```js
const latencyEnabled =
  String(process.env.WHATSAPP_LATENCY_PROFILING ?? 'true').toLowerCase() !== 'false';
```

Verified live after the `a46eb0e` deploy — 4 real lines from one **restore**, before the flip it was
**0**: `auth_state_load_ms` 1807.17, `provider_version_lookup_ms` 177.99,
`socket_initialization_ms` 2009.85, `socket_start_to_ready_ms` **3581.82 ms**, all keyed to
`session_ref=244d0d725095`. `LOG_LEVEL=info` (compose:149) is enough; `=false` restores silence.

`extra` now accepts **scalars only** — a nested object/array is *dropped, not serialised*. That is a
structural filter, not a key blocklist someone has to maintain: a caller passing a message or contact
object cannot leak its body. Falsified by deleting the filter (the log line then carried
`"body":"merhaba","jid":"905551112233@s…`).

**`session_ref` is the join key to the backend.** The gateway's `session_ref` (12-char hash) equals
`whatsapp_connect_stages.gateway_ref` for the same attempt — use it to correlate a gateway log line
with a durable stage row. Neither side ever stores the session UUID.

Trap when checking emission: `sudo grep -a "\"metric\":" <logpath>` returned **0** while 4 metrics
were present — nested quote layers mangled the pattern. Grep for the **component** instead
(`grep -a whatsapp-latency`) or for `duration_ms`. Same family as the `grep "a\|b"` trap: a grep that
matches nothing reads as "not present".

Contract pinned by `whatsapp-gateway/scripts/test-latency-metrics.mjs` (in `npm test`): silent when the
flag is off, correct name/JSON/`component` when on, opaque 12-char `session_ref`, and **no** session
UUID / QR / phone / JID. It must run in a **child process** — pino's level is fixed at module load, so
toggling the env var in-process changes nothing and would make the test unable to prove anything.

Frontend `whatsappLatency.ts` is gated on `import.meta.env.DEV && VITE_…` — dev-only by design. The
last-sync duration is likewise not logged in production.

## Durable data-shape audit (`whatsapp_data_audit`, live since `70c0741`)

**ATOMICITY — corrected in Phase 3.** This section used to say rows are "written **after** the
caller's COMMIT, so a row means 'this was committed', not 'we tried'". That guarantee was
**backwards**: between the COMMIT and the audit INSERT a crash left the delete permanent and the
explanation gone — exactly the "the count dropped and nothing says why" state the table exists to
prevent. Delete/merge paths now use `stage_data_event()`, which writes **inside the caller's
transaction** (after `flush()`, before `commit()`), so a rollback takes the row with it and a commit
keeps it. `record_data_event()` (own commit) survives only for the sweep's rollback path, where the
caller's transaction is already gone.

`stage_data_event` **pre-checks the idempotency key before `db.add`**. A staged duplicate otherwise
surfaces at the *caller's* commit as `IntegrityError`, which breaks the "never break the caller"
promise — it cost 6 red tests before the pre-check existed. The partial unique index
(`WHERE idempotency_key IS NOT NULL`, both dialects) stays as the concurrency backstop.

Carries `counts_before` / `counts_after`, a `correlation_id`, the `outbox_event_id` when one exists, and
a small sanitised `detail`. **No message bodies, phones, JIDs, QR or credentials** — surrogate ids only.

`snapshot_counts(user_id)` is **tenant-scoped**; a raw `SELECT count(*)` is **global**. Do not compare
the two (live: 698 tenant contacts vs 1535 global) — that gap is the scoping working, not a mismatch.
A failed snapshot returns `None`, never `0` (0 reads as "everything was deleted").

Read it with `GET /api/v1/whatsapp/data-audit` (auth required → 401 unauth, tenant-scoped, `limit` 1–200,
optional `event`). The sweep writes a row **only when it actually changed something** (merged / deferred /
errors / moved) — an empty table is the healthy state, not a broken recorder.

A merge row carries `legacy_archived_not_deleted: true`. That is the point: it proves a LID merge does
**not** change the conversation count, so the next "the count dropped" round can rule merges out with
evidence instead of suspicion.

**The "never raises" promise must cover resource ACQUISITION.** `record_data_event` opens its own session
when called with `db=None` (the sweep does this). The first version put `AsyncSessionLocal()` *outside*
the `try`, so a pool failure escaped and would have stopped the very repair loop the audit exists to
explain. Pinned by `test_session_acquisition_failure_never_raises`; falsified by moving the acquisition
back out (exactly that test goes red with `RuntimeError: pool exhausted`).

## OCI erişimi — instance principal, kimlik bilgisi olmadan (measured 2026-10-30)

`tezlify-oracle` üretimde **hiçbir OCI kimlik bilgisi tutmuyor**: `oci` CLI yok,
`~/.oci` yok, `.env.production`'da OCI değişkeni yok, uygulama bulut depolama
kullanmıyor. Buna rağmen OCI API'sine erişilebiliyor — IMDS + instance principal.

**Çalışan akış** (saf Python + `cryptography`, paket kurulumu gerekmez):

| Adım | Ayrıntı |
|---|---|
| IMDS | `http://169.254.169.254/opc/v2` + header `Authorization: Bearer Oracle` |
| Sertifika | `/identity/cert.pem`, `/identity/key.pem`, `/identity/intermediate.pem` |
| Tenancy | `/instance/` içindeki **`tenantId`**. **Sertifikada SAN YOK** — `SubjectAlternativeName` aramak `ExtensionNotFound` verir; yedek yol `subject` içindeki `OU=opc-tenant:…` |
| keyId | `"{tenancy}/fed-x509/{SHA1 fingerprint}"`, fingerprint = iki nokta ayrımlı büyük hex |
| Token | `POST https://auth.{region}.oraclecloud.com/v1/x509`, body `{certificate, publicKey, intermediateCertificates}` |
| Token sonrası | `keyId = "ST$" + token`, imza **bellekte üretilen oturum RSA-2048** anahtarıyla |

**İki ölçülmüş tuzak:**
1. Auth POST'unda `content-type: application/octet-stream` → **HTTP 415**. `application/json` şart.
2. `GET /n/{ns}/b` compartment'sız → **400 `MissingCompartmentId`**; `?compartmentId=<tenancy>` ile **404 `NamespaceNotFound`** = *yetki yok* (OCI yetkisizliği "kaynak yok" gibi gizler). `GET /n/` 200 dönse bile bucket enum yetkisi ayrı bir policy'dir.

**Durum (2026-10-30):** namespace `frlm5ioojy2m`; DG + policy + bucket kuruldu, bucket
listesi **200**. 8 nesne / 28.532.095 B yüklendi ve indirilerek SHA-256 ile doğrulandı.
Araç: `scripts/backup/offsite_oci.py` (`inventory` / `probe` / `upload` / `verify` /
`ls` / `download`). Escrow yüklemeyi kod seviyesinde bloke eder.

### Off-site nesne düzeni ve araç komutları (measured 2026-10-30)

| Konu | Değer |
|---|---|
| Bucket | `tezlify-ram-snapshots` (`NoPublicAccess`, versioning `Enabled`, `Standard`) |
| Prefix | `tezlify/whatsapp/ram-snapshots/{YYYY}/{MM}/{DD}/<dosya>` (tarih **dosya adından**) |
| Yükleme | `upload --bucket … [--only <dosya>] --execute` + `TEZLIFY_OFFSITE_APPROVED=1` |
| Doğrulama | `verify --bucket … [--only …] [--download-check]` |
| Envanter | `ls --bucket …` → nesne sayısı, toplam bayt, **`escrow_izi`** |
| İndirme | `download --bucket … --file X --out /tmp/X` (sha eşleşmezse yazmaz) |

**Ölçülmüş üç tuzak:**
1. `GET …/o` **`&fields=name,size,timeCreated` olmadan `size`/`timeCreated` döndürmez** (`None`).
2. `verify` yalnızca `opc-meta-sha256`'ya bakarsa **boyutu doğrulamaz** — `--download-check`
   gerçekten indirip `len(body)` ile `sha256`'yı birlikte karşılaştırır. İkisi ayrı iddia.
3. Zaten yüklenmiş nesne `If-None-Match: *` yüzünden **412/409** alır → araç bunu
   `ALREADY_PRESENT` sayar, **üzerine yazmaz**. Versioning şişmez.

### OCI 404 maskesi — nasıl ayırt edilir (measured 2026-10-30)

OCI, yetkisiz erişimi "kaynak yok" gibi gizler. `404 NamespaceNotFound`'u
"namespace yok" sanmak yanlış; **kod adı = gerçek sebep değil**.

Maskeyi kanıtlayan üç ölçüm (hepsi salt-okunur):
1. Kaynağın varlığını **başka** uçtan kanıtla — `GET /n/` → 200 ise namespace var.
2. **Geçersiz** parametreyle aynı isteği at — aynı 404 dönüyorsa yanıt parametreye bağlı değil.
3. **Eksik** parametreyle at — 400 dönerse uç nokta isteği parse ediyor (404 bozuk istek değil).

Aynı eksik parametre iki uçta **iki farklı maskeli kod** üretebiliyor:
`GET /n/{ns}/b` → `400 MissingCompartmentId`, `GET /n/{ns}/` → `404 CompartmentIdNotFound`.

**Sınır:** instance principal IAM'i okuyamıyor (`dynamicGroups`/`policies` →
`404 NotAuthorizedOrNotFound`), ama `compartments` (200) ve `tenancies` (200)
okunabiliyor. Yani "dynamic group yok" / "policy yok" / "policy koşulu uyuşmuyor"
üçlüsü **ayırt edilemez** — bu üçü aynı gözlemi üretir. Bu durumda
"yetki yok" demek de, "policy yok" demek de yanlış; doğrusu **NOT VERIFIED**.

### OCI kaynak kurulumu — hangi kimlikle (measured 2026-10-30)

Instance principal **yalnızca veri düzlemi** için yeterli; **IAM ve bucket oluşturamaz**
(`policies`/`dynamicGroups` okumakta bile `404 NotAuthorizedOrNotFound`).

| İş | Kimlik | Nereden |
|---|---|---|
| Snapshot listeleme/okuma/yazma | instance principal | üretim VM'i |
| DG / policy / bucket oluşturma | **user principal** | **yerel makine** `~/.oci/config` |
| Doğrulama | instance principal | üretim VM'i |

Kurulum: `scripts/backup/oci_provision.py inspect|apply --execute` (idempotent; mevcut
kaynağı tekrar oluşturmaz, kural/statement farklıysa CONFLICT deyip **dokunmaz**).

**İki tuzak:**
1. `GET /20160918/dynamicGroups` **listesi `matchingRule` döndürmez** — kural doğrulaması için `GET /dynamicGroups/{id}` gerekir.
2. Yeni bucket'ta `GET /b/{bucket}` bir süre **404** dönebilir (eventual consistency); ~15 sn sonra 200. Yetki sanıp policy'yi genişletme.

### "RAM-only" sayısı — toplam ile fark ayrı şeylerdir (measured 2026-10-30)

Uzun süre "RAM-only 9154" denildi; **yanlıştı**. İki sayı ayrı:

| Sayı | Anlamı | Ölçüm |
|---|---|---|
| **9154** | Gateway RAM'indeki **toplam** mesaj | `GET /messages/bulk?limit=1` → `total` |
| **6960** | Bunlardan **DB'de karşılığı olmayanlar** | kimlik kümesi farkı **veya** persistence dry-run `inserted` |
| 2194 | DB'deki toplam = RAM ile kesişim | DB ⊆ RAM (her DB mesajı RAM'de) |

İki bağımsız yöntem (kimlik farkı ve `drain_gateway_memory_once(dry_run=True)`) **aynı** sonucu
verdiği için sayı güvenilir. Yeni raporlarda "RAM-only" = **6960**.

**`dry_run=True` gerçekten yazmaz:** `db.commit()` yalnızca `not dry_run` iken çağrılır ve
`_prefetch_existing_ids` salt okunur. Kill-switch yalnızca `run_memory_persistence_once`
içinde denetlenir; `drain_gateway_memory_once` doğrudan çağrılabilir (bilinen tasarım boşluğu,
düzeltme ayrı onay ister).

**LID tablosu `whatsapp_private` şemasındadır**, `public` değil:
`SELECT … FROM whatsapp_private.lid_mappings` (`session_id`, `lid_jid`, `phone_jid`).
`public` şemada aramak "tablo yok" sanılmasına yol açar.

### Bağımsız escrow ile off-site restore — `scripts/backup/escrow_offsite_restore.py`

Tek komut: `anchor8` kontrolü → OCI'den indirme → boyut/`opc-meta-sha256`/yerel üç yönlü
karşılaştırma → **bellekte** şifre çözme → `:memory:` restore → kimlik kökünü **uzaktan
indirilen manifest** ile karşılaştırma. İndirme **diske yazılmaz**, geçici dosya oluşmaz.

Anahtar argv'ye, ortama, dosyaya yazılmaz (`--stdin`/`getpass`). Çıkış kodları:
`0` PASS · `1` kullanım · `2` ağ · `3` bütünlük · `4` escrow çapası · `5` kimlik.

`offsite_oci.py` ve bu araç üretimde **kurulu değil**; `scp` ile geçici dizine alınır,
iş bitince silinir (`/opt/tezlify/scripts/backup/` boştur).
