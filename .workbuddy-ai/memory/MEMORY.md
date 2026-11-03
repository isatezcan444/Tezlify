# Tezlify — project index

Index only. Detail lives in:

| Where | What |
| --- | --- |
| `reference/whatsapp-subsystem-invariants.md` | invariants **A–T** (60 KB) |
| `reference/production-ops.md` | topology, deploy state, release mechanics, **5.3.9–5.3.17 commit hattı** |
| `reference/testing-and-ops-recipes.md` | test DBs, pytest hazards, race/cleanup harnesses, shell gotchas |
| `reference/cross-cutting-rules.md` | defect patterns **X1–X8** |
| `docs/audits/ASAMA-*.md` | per-phase reports, 4.29 … 5.3.17 |

## Irreversible damage

- **Deleting a line is data loss** — cascades to conversations + messages, drops gateway auth dir.
- **No backup covers conversations/messages** (`archive_mode=off`, no PITR). **Measured 5.3.22:** newest dump `2026-10-17 19:30Z` predates the oldest message (`2026-10-27 20:32`) ⇒ **0/9,985 messages, 0/128 conversations** covered. No cron/root crontab/cron.d, **no postgres systemd timer** (only `tezlify-ram-snapshot`); `trigger_backup()` is manual-only and has **no retention code**; `certification_status`/`off_host_status` are **hardcoded strings**. DB dumps are same-host only (no oci/rclone/restic/borg/aws, no `~/.oci`). `rollback()` (`host-release.sh:282-300`) touches **images/frontend/`.deployed-commit` only — never the DB**; Alembic unused, `migrations.py` is forward-only with `DROP COLUMN`/`DROP TABLE` ⇒ **no downgrade**. Prove rollback by restoring to a scratch DB and **counting rows**; dump size proves nothing.
- **`sha256sum -c` without sudo lies here** — dumps are `0600 root:root`, operator is `ubuntu` ⇒ "1 listed file could not be read"; with `sudo -n` all 5 verify OK. A permission error reads like corruption.
- **The one real off-host asset is the RAM snapshot**, not the DB: `tezlify-ram-snapshot.timer` hourly, `TEZLIFY_OFFSITE_APPROVED=1`, bucket `tezlify-ram-snapshots`, 75/77 `OK` + `remote_verified=true`, Oct-30 snapshots hold **9,154 msgs/100 chats**. It restores only to SQLite (`ram_snapshot.py:466-474` refuses postgres) and covers no conversations/contacts/leads/sessions.
- **Deploy ONLY via `scripts/deploy/host-release.sh`**; `.deployed-commit` is authority; push ≠ deploy. `--skip-build` still recreates both services ⇒ use `--no-gateway`; a gateway recreate costs its RAM store (A6). **The script that runs is the OLD one** — exits 9 unless its `git hash-object` matches the target's.
- **A refusing guard is not a blocker — build the ref it asks for.** Never weaken `--no-gateway`; cut `release/backend-only-*` = main's tree with `whatsapp-gateway/` reverted to the deployed commit. The deployed gateway must accept every param the new backend sends.
- **A deploy runs startup migrations that DELETE rows.** "No migration files" ≠ "no data change": grep `migrations.py` for `delete(` first.
- **Persistence kill-switch opens ONLY on `true`/`1`** (`persistence_flag_guard.py`).
- **Deploy ORDER is itself damage (3.6):** gateway RAM held 7337 msgs nowhere else. Backend persistence → verify `/health.whatsapp_memory_persistence` → gateway. **A bounded turn without a cursor loses the tail silently** (3.6b).

## Invariants (A–T, key)

- Chat-list order = **absolute** last message, not last *received* (A4); coerce uint64.
- Empty preview never gates `last_message_at` (A11); text-less → `[MARKER]` preview, never a new `message_type` (A12); three label tables in parity.
- **LID bridge keyed to CONNECTION, never person** (A14/T): `ws.gateway_id` matched 4/4107; defer on `lid_jid` alone.
- On-demand PDO failure is per-CHAT, not per-session (`pdo_sent` vs `chunk_received`).
- Guard keyed on "page has rows" is DEAD for a page empty BY CONSTRUCTION (P) — ask what the *caller* holds.
- Preview = summary string, not a row (S); missing row = `UNSYNCED` (R); `LIMIT` before filtering scans a prefix (Q). `GET /sessions/{sid}/contacts` ≠ store health check (A8).

## Cross-cutting (evidence in `reference/cross-cutting-rules.md`)

- **X1** A key the `response_model` does not DECLARE never reaches the client (`extra="ignore"`).
- **X2** A code fix is not retroactive over a positive cache — pair it with an invalidation.
- **X3** Served type comes from the BYTES: sniff at upload *and* at serve; `inline` only for jpeg/png/webp.
- **X4** Global `unique=True` on a nullable identity column is a tenant-isolation bug → partial composite `(user_id, col) WHERE col IS NOT NULL`.
- **X5** "Persist but don't broadcast" has three mechanisms; `_internal_only` and `_skip` are the WRONG tools, `_no_broadcast` is the right one — and all three return paths must be closed.
- **X6** A wire discriminator is worthless unless THREADED end-to-end (`upsert type` → `_ingestUpsertMessage`; `messages.update` → explicit `upsertType:'replace'`, never a `Date.now()` fallback).
- **X7** A cleanup key must come from the SAME function the writer uses (`jid_to_phone` → `None` for `@g.us`/`@lid` ⇒ `WHERE phone_e164 = NULL` deletes nothing, test stays green). Fixing one copy isn't enough.
- **X8** **Tracked ≠ runs** (a committed test absent from the chain never ran). **A counter must match the output dialect it counts** (`ok - …` vs `  PASS …`).

## Load-bearing habits

- **Exported-but-never-called guard = dead guard.** Parity between two mirrors can't detect something missing from both — derive the set from the CONSUMER. Two writers on one unique key: loser must ADOPT. Process-global cache keyed by RESOURCE, not family label. **Green test can hide a dead guard** — assert absence of error, not just side effect. **Equal counts ≠ equal sets.**
- `resolve_contact_identity` owns names; REST/WS fields match (never `lead_phone`); sort by activity.
- `git show <c>:<path> | shasum` is NOT a presence test (a failing `git show` hashes `e3b0c442…`); use `git cat-file -e`. Never mix `git hash-object`/`rev-parse` (SHA1) with `shasum -a 256` (SHA256).
- **Tam backend suite `node_modules` symlink'lerini ister** — yoksa 2 test `ERR_MODULE_NOT_FOUND: 'uuid'` verir ve ürün kırılması gibi görünür (→ `production-ops.md`). **`.gitignore`'daki `node_modules/` symlink'i KAPSAMAZ** (sondaki `/` yalnız gerçek dizini eşler) ⇒ test penceresinde 3 ekstra `??` girdi; `git add -A` bunları commit'e sokar. Symlink'leri koşu biter bitmez kaldır.
- **npm echo satırı tüm script adlarını içerir** ⇒ "40/40 script log'da geçiyor" **sahte pozitiftir**; `^> ` satırlarını çıkarıp zincir semantiği + her yeni linkin ayırt edici marker'ıyla kanıtla.

## Release state (full record in `reference/production-ops.md`)

- **Deployed = `0b795ea6`** (`release/backend-only-seq-safety`, 2026-11-01T11:01:27Z), 5 backend files only, `--no-gateway`. Carries **4.27** (epoch_reset → `after_seq=0`) + **4.28** (jid chunking, `_SYNC_BULK_PAGE_SIZE=1000`, `_SYNC_PER_CHAT_LIMIT=50`). Initial sync persists only the newest 50/chat; older history lives only in gateway RAM (A6).
- **`main` = `e7f1077a`** (5.2.6, parent `a4f12d7`) — **NOT deployed, not pushed**. 5.2 touches `whatsapp-gateway/src/` ⇒ `--no-gateway` impossible. **Cannot deploy from main**: it lacks 4.27/4.28 and the deployed gateway `20c88bb` is not its ancestor.
- **C4 exception:** `backend_only_release.py` RC=1 on that ref (Pattern B). Operational, not security — `host-release.sh:558-570` checks ONLY `gateway_changes` (= 0).
- **`release/backend-only-seq-safety` = `6b413f3`** (21+1 files: `5f29d9e` `5209/24` + `6b413f3` `13/2`) — **PUSHED 2026-11-02T12:40Z**, fast-forward `0b795ea..6b413f3`, 3 commits, 0 lost. **NOT deployed.**
- **HEAD = `6b413f3`** (5.3.17: the 5.3.15 test repair, `+13/−2`, one file; blob `39a2a66…`). **3 commits pushed**, 0 lost. **5.3.18 re-ran all three gates on the COMMITTED tree and passed**: backend `2123/4/0/0` exit 0 · gateway exit 0, 40/40 links, **202 `ok -`** assertions · frontend exit 0 (`✓ built in 11.57s`, 0 TS errors). **Deploy still awaits separate approval.**
- **4.34 (live E2E acceptance) NOT yet run.** Persistence loop remains OFF (4.27 shipped but dormant; enabling as-is is UNSAFE → separate task).
- **5.3.20 = BLOCKED (read-only audit).** Release touches `whatsapp-gateway/src/` ⇒ **`--no-gateway` impossible** (guard's own command exits 1); no DB backup/rollback (`rollback()` reverts image/frontend/`.deployed-commit` only); startup migrations DELETE/UPDATE every boot (`ensure_verified_commercial_leads`) and the static guard only scans **added** lines. `release.sh` refuses this branch (`origin/main` ancestor check); `run_release.sh` carries no frontend.
- **5.3.21 = CONDITIONAL; the RAM P0 is CLOSED (measured 2026-11-02).** `RAM_ONLY = 0` twice, 49 s apart: RAM **484 msgs / 7 chats**, all in Postgres under the right conversation (IDENTITY_MATCH 484, CHAT/TENANT mismatch 0, dup 0). `messagesByChat` is a **cache**: gateway's durable Postgres outbox is active (`GATEWAY_DATABASE_URL`), **1250 events all DELIVERED, 0 PENDING/IN_FLIGHT/DEAD_LETTER**, 313 `message_new`/24 h, `requeueInflight()` on boot. **UNSYNCED = 26 today (the "32" was historical)**; ghost-purge candidates 0 and structurally immune (purge needs `last_message_at IS NULL`, UNSYNCED requires NOT NULL).
- **Deploy gate to add:** immediately before any gateway recreate require `RAM_ONLY == 0` **and** outbox `PENDING/IN_FLIGHT == 0`, else abort. Overall deploy still blocked by backup, DB rollback, migration impact, frontend entry point, explicit approval.
- **Still open:** 7 frontend scripts fail **pre-existing**; `frontend/scripts/verify-*.mjs` are in **no** chain (hand-run); 5.3.13–5.3.17 reports are **untracked**. **Push needs explicit user approval.**
- `.workbuddy-ai/memory/*` is tracked and dirty — `git add -A` would put it in a release commit; stage an explicit file list.
