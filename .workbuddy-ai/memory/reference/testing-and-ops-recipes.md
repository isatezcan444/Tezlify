# Testing & ops recipes (Tezlify)

Companion to `MEMORY.md`. Load this when running tests, provisioning DBs, or
building a race/cleanup harness.

## Local test databases

- **PG:** `psql -h 127.0.0.1 -U isatezcan -d tezlify_race_523`.
  The role is `isatezcan`; `tezlify` does not exist locally (that's the *docker*
  role on the production host). PostgreSQL 17.11 Homebrew,
  `data_directory=/opt/homebrew/var/postgresql@17`.
- `conftest.assert_test_db_is_not_remote` refuses any non-localhost URL unless
  `TEZLIFY_TEST_DB_REMOTE_OK=1`. Local hosts: `localhost`, `127.0.0.1`, `::1`,
  `host.docker.internal`, empty.
- **Isolated SQLite** (keeps repo `tezlify.db` clean):
  ```bash
  TEST_DB_PATH=/tmp/x.db DATABASE_URL="sqlite+aiosqlite:////tmp/x.db" \
      python scripts/provision_test_db.py          # 34 tables
  TEST_DB_PATH=/tmp/x.db DATABASE_URL="sqlite+aiosqlite:////tmp/x.db" \
      pytest backend/tests/test_foo.py
  ```
  `assert_test_db_matches_requested_path` raises if `TEST_DB_PATH` and
  `DATABASE_URL` diverge — this catches the silent fallback to the stale repo
  `tezlify.db`, whose old rows surface as random failures.
- **Fresh PG test DB needs THREE steps:** `Base.metadata.create_all` (28 tables)
  + `ensure_whatsapp_gateway_private_schema` +
  `ensure_whatsapp_private_lid_and_history_tables`. Without the last one, any
  `lid_mappings` SELECT aborts the transaction and you get 34 bogus
  `InFailedSQLTransactionError`.
- `db` appears in NO compose file ⇒ never `docker compose up -d
  --remove-orphans`.

## pytest hazards

- **`pytest-randomly` is installed.** Re-check every result with
  `-p no:randomly` AND the file alone AND an explicit
  `--randomly-seed=<int>` (`'random'` is rejected — only an integer or `last`).
  A file that passes alone but fails in the suite = DB-state pollution.
- **`backend/tests/` has NO `__init__.py`** ⇒ pytest imports test modules as
  TOP-LEVEL names (`test_whatsapp_upsert_append`), not
  `backend.tests.test_whatsapp_upsert_append`. Patching the dotted name patches
  a *different* module object, so a monkeypatch/spy silently never fires and
  the test still goes green. Patch `item.module` from
  `pytest_collection_modifyitems`.
- **`tmp_path` breaks on a second run** in this sandbox (`mkdir` wrapper ignores
  `exist_ok=True`): `PermissionError: EEXIST … pytest-of-root`. Clear with
  `rm -rf "${TMPDIR}pytest-of-root" "${TMPDIR}pytest-of-unknown"`.
- Piping pytest through `tail`/`head` masks the exit code — redirect to a file
  and `echo $?` separately.

## Harness recipes

- **Deterministic PG race (5.2.3, proven 5/5).** Hold the FIRST ingest at an
  existing `await` between INSERT-flush and commit
  (`_preview_for_text_message`, `events.py:1187`) via `monkeypatch`; start the
  loser; release only after `pg_stat_activity` shows
  `wait_event_type='Lock' AND state='active' AND query ILIKE '%INSERT INTO
  messages%'`. No sleeps. Violated constraint =
  `uq_msg_conv_wa_message_id` (the `client_message_id` index is partial ⇒
  definitionally inapplicable when that column is NULL). Recovery's re-select
  depends on **READ COMMITTED** — under REPEATABLE READ the loser would
  silently `_skip` instead of recovering.
- **asyncpg is loop-bound.** A module-level engine + pytest-asyncio
  function-scoped loops ⇒ `got Future attached to a different loop`. Fix:
  `conftest.postgres_fresh_pool` (autouse, guarded by
  `engine.dialect.name != "postgresql"` ⇒ measured no-op on SQLite) calls
  `engine.sync_engine.dispose(close=False)` before and after each test.
  `close=True` re-raises the same error (close awaits on the dead loop). Guard
  on **dialect**, never on `settings.DATABASE_URL` (monkeypatchable).
- **Prove cleanup isn't a no-op.** "Test passed" proves nothing: wrap the purge
  and record row counts before/after (expected 1/1/1 → 0/0/0). Count
  `messages`, `conversations`, `contacts`, `whatsapp_sessions`,
  `whatsapp_private.processed_events` after EVERY run, plus the leftover's
  *signature* form (e.g. `phone_e164 LIKE 'jid:%@g.us'`), not just totals —
  totals hide which rows survived.
- **Attribute leftovers before blaming the phase under test.** Run the
  suspected *other* files alone on a fresh DB; if the row reappears, it's
  pre-existing. 5.2.5 did this for `+905321110001/+3`
  (`test_whatsapp_forensic_phase4_g3.py`), `+905321112233`
  (`test_whatsapp_outbound_delete_sync.py` /
  `test_whatsapp_message_info.py`), `+905356872662`
  (`test_whatsapp_group_reaction_preview.py:73`).

## Shell / host gotchas

- **Never write `grep "a\|b"`** on this box (macOS BSD grep): BRE alternation
  silently matches NOTHING and exits 1, so it reads as "not present" and
  `grep … && do_thing` silently skips. Use the Grep tool or `grep -E`.
- SSH: `ubuntu` + `-i ~/.ssh/id_tezlify_oracle`; `root@` rejected. ControlMaster
  goes stale ⇒ `-o ControlMaster=no -o ControlPath=none`. zsh does NOT
  word-split `$OPTS`. macOS has no `timeout`.
- `psql -c` with multiple statements aborts the REST on the first error — one
  statement per call.
- Never `docker logs` for an Ops tail — truncating the json-file WEDGES the
  reader. `docker images` HANGS on the prod host (rc=124); read
  `backups/releases/<TS>/release.json` instead.
- Worktrees: `main` lacks the seq code, so seq tests run at `de1f1ad`
  (`git worktree add --detach`). Bare-specifier node harnesses fail
  `ERR_MODULE_NOT_FOUND: uuid` — symlink the repo-root `node_modules` too.
- `rm -rf` on a directory with >50 files trips a bulk-delete confirm guard.
