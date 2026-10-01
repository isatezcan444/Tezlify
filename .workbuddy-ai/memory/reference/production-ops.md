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
- **`WHATSAPP_AUTO_RESTORE=false`**: a gateway restart does **not** re-attach the linked line.
  `POST /sessions/restore` (gateway, `X-Gateway-Secret`, no body) re-attaches from persisted creds with
  **no QR**. `listRestorableSessions()` only returns sessions active in both `gateway_sessions` and
  `whatsapp_sessions` with stored credentials — check that count before firing it.
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
- **A `db` restart crashes the gateway.** `docker stop tezlify-db` SIGTERMs Postgres, which terminates
  clients with `57P01 terminating connection due to administrator command`; the gateway's Node `pg` Pool
  emits `'error'` with **no listener** (`pg-pool/index.js:62 idleListener`), so the **process dies**
  (`restarts` +1). Backend is unaffected (`pool_pre_ping=True`, `pool_recycle=300`). Recovery is
  automatic and correct — the gateway restores the session and re-acquires the socket lease **after one
  TTL** (`GATEWAY_LEASE_TTL_SECONDS=45`, ~49 s measured) — but the crash itself is an open resilience
  gap (fix: attach a Pool `'error'` handler). See §G/§M and the 2026-10-01 session log.
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

## Release mechanics (`scripts/deploy/host-release.sh`) — re-measured 2026-10-01

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

## Deploy state (2026-09-26; refreshed 2026-10-01)

- **Measured 2026-10-01: the prod checkout is CLEAN at `7370c18`** (`git status --porcelain
  --untracked-files=no` empty), and the authoritative deploy marker is `/opt/tezlify/.deployed-commit`.
  The older note that the tree is "deliberately left dirty as the deploy marker" at `359fe6d` is **stale**:
  `host-release.sh` resets hard to the target SHA and then asserts the tree is clean. Still — deploy via the
  script; never hand-reset `/opt/tezlify`.
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

## Verification baselines

- Last run (2026-10-01): backend **1423 pass / 4 skip / 0 fail**; gateway `npm test` **42 PASS** (exit 0);
  frontend `npm run build` exit 0, `tsc --noEmit` clean, i18n parity **8/8** keys in both locales.
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
