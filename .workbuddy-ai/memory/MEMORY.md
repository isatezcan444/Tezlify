# Tezlify — project index

Curated index only. **Deploy narratives, timings and falsification evidence live in `YYYY-MM-DD.md`**
(read the most recent first); **WhatsApp subsystem detail in
`reference/whatsapp-subsystem-invariants.md`** (sections A–J); reusable procedures are skills, not
memory — see the pointer list at the end.

## Invariants

### WhatsApp — detail in `reference/whatsapp-subsystem-invariants.md`

- **Deleting a line is irreversible data loss, never a "disconnect".**
  `DELETE /api/v1/whatsapp/sessions/{id}` cascades (`all, delete-orphan`) to that line's `conversations` +
  `messages`, drops the `whatsapp_sessions` row, and deletes the gateway auth dir under the
  `tezlify_whatsapp_sessions` volume. Every conversation belongs to one line, so deleting the only
  connected line wipes the whole WhatsApp dataset and forces a QR re-link.
- **No backup covers WhatsApp conversations/messages.** Sep 19 dump is schema-only for those tables;
  Sep 16 restores but has 0 rows; `archive_mode=off`, no replication slots, so no PITR. Before promising
  a rollback, restore into a scratch DB and **count rows** — dump size proves nothing.
- **Chat-list ordering = the ABSOLUTE last message, never the last RECEIVED one** (A4). WhatsApp Web
  sorts by `conversationTimestamp`; Baileys' `lastMessageRecvTimestamp` is "the last message received
  from the other party", so ranking by it sinks every chat whose newest message is one *we* sent. Fixed
  in `4fc791a`; coerce the uint64 with `toPositiveSeconds` (`Number(Long)` is NaN) and guard the scale,
  because the backend only moves `last_message_at` FORWARD.
- **Every gateway in-memory store (`chats`, `messagesByChat`, `store.contacts`) is lost on restart and is
  NOT rebuilt** (A6) — WhatsApp sends no history sync for an existing session, so a restart silently
  discards ordering data (the DB is the only durable copy) and used to downgrade group sender labels to
  raw phones (A7). Never read the gateway's list as "the current chats".
- **`GET /sessions/{sid}/contacts` is NOT a store health check** (A8) — `listContacts()` returns only
  `addressbook`/`verified` names, so it reads **0** while hundreds of `history`-rank names exist.
- Gateway owns the unread count **including decreases**; never `Math.max` (B). Message uniqueness
  `(conversation_id, wa_message_id) WHERE NOT NULL` (D); tenant routing G-3 (E); No-Create/lease rules
  (G); media, provider contracts and known-open items: F, J.

### Cross-cutting

- Identity: `resolve_contact_identity` owns names; REST/WS fields match (never `lead_phone`); sort by
  activity only.
- **An exported-but-never-called guard is a dead guard.** `setSessionPhone()` shipped with no call site,
  so the cache's phone stamp stayed `null` and its mismatch check could never fire. Grep for the call
  site before trusting any defensive branch.
- **A parity check between two mirrors cannot detect something missing from both.** The i18n check
  compared `en` against `tr`, so 19 keys absent from *both* dictionaries passed it while the UI rendered
  raw key paths (`useI18n` warns and returns `path`). Derive the required set from the **consumer** (the
  `t('...')` call sites), not the sibling copy. Same trap for any "these two lists must match" assertion.

## Operational facts

- Production: Oracle `130.162.247.20`, `/opt/tezlify`, user `ubuntu`, SSH key
  `~/.ssh/id_tezlify_oracle`. **Push is not deploy.** Compose file `docker-compose.prod.yml`; services
  `backend`, `gateway`, `db`, `caddy`. Gateway listens on **8787** (`GATEWAY_PORT`) and its container has
  **no `curl`** — query it with `node` inside the container reading
  `process.env.WHATSAPP_GATEWAY_SECRET`, so the secret never leaves its own environment.
- **Production is PostgreSQL, not SQLite.** `DATABASE_URL=postgresql://tezlify:...@db:5432/tezlify`; the
  repo-root `tezlify.db` is stale and `sqlite3` is absent on the host. Use
  `docker exec tezlify-db psql -U tezlify -d tezlify`. `history_sync_states` is keyed
  `(session_id, jid)` — joining on `jid` alone multiplies rows and inflates `count(m.id)`.
- **`WHATSAPP_AUTO_RESTORE=false`**: a gateway restart does **not** re-attach the linked line.
  `POST /sessions/restore` (gateway, `X-Gateway-Secret`, no body) re-attaches from persisted creds with
  **no QR**. `listRestorableSessions()` only returns sessions active in both `gateway_sessions` and
  `whatsapp_sessions` with stored credentials — check that count before firing it.
- Local sandbox sets `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:59508`, which tunnels `app.tezlify.com`
  into a 502 — run API probes **from the production host** (Caddy is local there). Playwright exists only
  in the repo `venv` (`venv/bin/python`).
- Production browser probes (procedure in the `real-browser-cdp-verification` skill):
  `scripts/auth_helper.get_ephemeral_auth_token()` (2-hour `auth_staging_sessions` row for user
  `f65642ab-...`) + real Chrome with `--host-resolver-rules=MAP app.tezlify.com 130.162.247.20`. The app
  is tab-based, not routed: enter via `button[data-tab-id="whatsapp"]`; conversation rows are
  `button[data-conv-id]`. Count `ChatThread` instances name-independently by walking the fiber tree from
  the `__reactContainer$` root and matching `memoizedProps.messages` + `leadName` — minified names change
  per build.
- Frontend releases live at `/opt/tezlify/releases/` (NOT `/opt/tezlify/frontend/releases/` — that older
  path exists but is unused). Swap the `frontend_candidate` symlink atomically (`ln -sfn` + `mv -T`) then
  **force-recreate Caddy** (its bind mount resolves the symlink at creation). Cache policy is already
  right: entry document `no-cache, no-store, must-revalidate`, hashed assets `immutable,
  max-age=31536000` — a plain reload picks up a deploy. Release dirs are **build output only**
  (`index.html` + `assets/`, ~960 KB): no `node_modules`, no git repo on the host, so build locally and
  upload with `rsync`.
- `frontend/package-lock.json` does **not** exist -> `npm ci` is impossible; use `npm install` / existing
  `node_modules`. `.env.production` and `.env.local` both blank `VITE_API_URL`, but production always
  resolves same-origin `/api/v1` (`resolveApiBase()` short-circuits on `isRemoteHost`).

## Deploy state

- Prod `/opt/tezlify` is a **git checkout deliberately left dirty** at `359fe6d` with the deployed patches
  applied as uncommitted working-tree changes. **That dirt is the deploy marker** — never run
  `git checkout .` / `git reset --hard` / `git clean` there. A later full deploy of `ddbfbf4` should find
  those files already matching.
- Live (details in the daily logs): frontend `5916ff1` chat-thread singleton + `8177a2b` i18n missing
  keys; backend `9981298` 502-on-short-conversation + `6c7214a` ~4 s open-path bound; naming fix
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

## Verification

- Last run (2026-09-26): backend **1166 pass / 4 skip / 0 fail**; gateway all **7** `npm test` scripts
  pass (`test-contact-cache.mjs` 37 assertions, `test-contact-hydration.mjs` 26); frontend `verify:logic`
  **45/45** (incl. the two i18n checks), `tsc --noEmit` clean, `npm run build` exit 0.
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
- Compare actual exit codes (piping through `tail`/`head` masks them). Falsify a restored regression check
  against the real broken mechanism before trusting it: counter-only assertions can pass under a missing
  call site, and post-reset counters need an explicit baseline, never zero.

## Skills covering reusable procedures

`git-checkout-prod-partial-service-deploy` (subset/deferred deploy, rebase-and-delta, `--no-deps`),
`esbuild-frontend-verification` (executed frontend checks with no test runner),
`real-browser-cdp-verification`, `stack-latency-parity-diagnosis`,
`non-destructive-schema-constraint-migration`, `hermetic-service-process-harness`,
`asymmetric-resource-guard-detection`, `client-lifecycle-cancels-server-promotion`,
`cross-tenant-lookup-isolation`, `symlink-served-release-fast-forward-deploy`.
