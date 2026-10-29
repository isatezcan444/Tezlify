# Tezlify — project index

Index only. Every claim below has a measurement behind it; detail lives in `reference/`.

| Where | What |
| --- | --- |
| `reference/whatsapp-subsystem-invariants.md` | Invariants **A–T** (all `A11`-style refs point here) |
| `reference/production-ops.md` | Topology, deploy state, release mechanics, 3.8.x narratives |
| `reference/cross-cutting-rules.md` | Defect patterns **X1–X4** |
| `YYYY-MM-DD.md` | Per-session narratives, timings, falsification evidence |

## Irreversible damage — read before acting

- **Deleting a line is data loss, never a "disconnect".** `DELETE /sessions/{id}` cascades to that line's
  conversations + messages and drops the gateway auth dir. Every conversation belongs to one line ⇒ deleting
  the only connected line wipes everything.
- **No backup covers WhatsApp conversations/messages** (`archive_mode=off`, no slots, no PITR). To promise a
  rollback, restore into a scratch DB and **count rows** — dump size proves nothing.
- **Deploy only via `scripts/deploy/host-release.sh`; never hand-reset `/opt/tezlify`.** `.deployed-commit` is
  the authority. **Push is not deploy.** It force-recreates backend+gateway even with `--skip-build` ⇒ use
  **`--no-gateway`** (REFUSES, exit 1, if gateway/compose changed). A gateway recreate costs its RAM store (A6).
  **The script that runs is always the OLD one** — since 3.8.5 `host-release.sh` compares its own
  `git hash-object` to `<target>:…/host-release.sh` and **exits 9** on mismatch. Run the target's copy:
  `bash scripts/deploy/run_release.sh --expected-self-blob <blob> <ref> --no-gateway`. Measured: deployed
  `b5715fe` had **0** kill-switch references and accepted a new ref at exit 0 — the hole was real.
- **A refusing guard is not a blocker — build the ref it asks for.** `--no-gateway` compares `deployed..TARGET`;
  while `main` carries gateway changes, backend-only is impossible. Never weaken it: cut
  `release/backend-only-*` = main's tree with `whatsapp-gateway/` reverted to the deployed commit. Preflight:
  `python scripts/deploy/backend_only_release.py --base <deployed> --target <ref>`. **Check the CONTRACT**: does
  the *deployed* gateway support every param the new backend sends? Unknown params are ignored ⇒ silent failure.
- **A deploy runs startup migrations that DELETE rows — "no migration files" ≠ "no data change"** (3.8.6,
  measured). The 3.8.5→3.8.6 release had **0** `*.sql`/alembic files, yet `backend/app/core/migrations.py` runs
  on every boot and deleted **1 ghost LID contact + 1 conversation + 9 messages** (`126|2077|1538` →
  `125|2068|1537`). `migrations.py` was **byte-identical** to the base ⇒ pre-existing behaviour; it fired only
  because no boot had occurred since the ghost row appeared. **Before any deploy, read the candidate's
  `migration-summary.txt`/`candidate.log` and grep `migrations.py` for `delete(`** — the script prints
  `ONCEDEN VAR OLAN mesaj kayboldu` as a **warning and still exits 0**; a warning is not a gate. Deleted rows
  survive only in gateway RAM as `CLASS_unmapped_jid`, where persistence **skips** them ⇒ a gateway recreate
  makes the loss permanent. An image rollback is not a data rollback.
- **The persistence kill-switch opens ONLY on `true`/`1`** (3.8.5). `yes`/`on`/`y`/`t` are OFF in the app and a
  hard RED in `persistence_flag_guard.py`; absence/empty/typos are off and denied.
- **"No LID bridge" is not proof of a ghost — startup must never delete on it** (3.8.7). The old
  `purge_raw_jid_identity_data` deleted every `contacts.phone_e164 LIKE 'jid:%@lid'` with no `lid_mappings` row,
  **with no tenant filter**, and **failed OPEN**: if the bridge table was unreadable, `defer_clause` became
  empty and *every* ghost was deleted. Now it deletes nothing — it writes `whatsapp_identity_quarantine`
  (`bridge_known_deferred` / `bridge_unknown_has_messages` / `bridge_unknown_empty`) and returns
  `deleted_* == 0` as a tested contract. The ledger is one row per `contact_id`, idempotent, carries `user_id`,
  and **never overwrites an operator's `RELEASED`**. Release/delete is an explicit operator decision.
- **Never run pytest on the dev DB**; `conftest` REFUSES a non-localhost `DATABASE_URL`. **`TEST_DB_PATH` alone
  is not enough** — `settings.DATABASE_URL` is what pytest connects to, so export BOTH.
- **Deploy ORDER is itself irreversible damage (3.6):** gateway RAM held **7337 messages that exist nowhere
  else** (3.6b's corrected number; 3.6's "7080" came from `per_chat_limit=50` — never quote a gateway count
  taken under a truncating cap). Gateway-before-backend = gone for good (A6). Always: backend persistence →
  verify `messages` / `/health.whatsapp_memory_persistence` → gateway.
- **A bounded turn without a cursor loses the tail silently** (3.6b): 10 000 cap against 9 122 RAM messages,
  every turn restarting at `offset 0` ⇒ the tail could *never* be written, no error, `/health` green.

## Invariants — the highest-value tells (full list: A–T in the reference)

- Chat-list order = the **absolute** last message, never the last *received* (A4); coerce the uint64.
- An **empty preview must never gate `last_message_at`** (A11) — the tell is the asymmetry.
- Text-less content gets a `[MARKER]` preview body, never a new `message_type` (A12); **three label tables must
  stay in parity** (gateway / backend / frontend+locales).
- **A LID bridge is keyed to the CONNECTION, never the person** (A14/T) — joining `ws.gateway_id` matched **4 of
  4107**; defer on `lid_jid` alone, take ownership from `contacts.user_id`, never guess.
- **On-demand PDO failure is per-CHAT, never per-session** (3.6). **"PDO attempted" ≠ "phone returned"** —
  distinguish `pdo_sent` from `chunk_received`. **If RAM holds exactly what the DB holds, the gap is upstream.**
- **A guard keyed on "the page has rows" is DEAD for a page empty BY CONSTRUCTION** (P) — ask what the *caller*
  holds. P's fix was REVERTED (`5c1c76d`), live at `e8a86ee`.
- A preview is a summary string, never a message row (S); a missing row is `UNSYNCED` (R); a `LIMIT` applied
  before filtering scans a prefix (Q). `GET /sessions/{sid}/contacts` is **not** a store health check (A8).

## Cross-cutting

- Identity: `resolve_contact_identity` owns names; REST/WS fields match (never `lead_phone`); sort by activity only.
- **An exported-but-never-called guard is a dead guard** — grep the call site before trusting it.
- **A parity check between two mirrors cannot detect something missing from both** — derive the required set from
  the **consumer**.
- **Two writers on one unique key: the loser must ADOPT.** If only one has the try/except, that writer is the bug.
- **A process-global cache/flag must be keyed by the RESOURCE**, not a coarse family label.

## Ops quick hits — full detail in `production-ops.md`

- PostgreSQL via `docker exec tezlify-db psql -U tezlify -d tezlify`; the repo-root `tezlify.db` is stale. The
  gateway container has no `curl` (probe with `node`); run API probes **from the production host**.
- **`db` is in NO compose file** ⇒ never `up -d --remove-orphans` (it would delete the database).
- **`pytest-randomly` is installed** — a new module-global cache, or a cleanup helper that can raise, reintroduces
  order-dependence. Re-check with `-p no:randomly` **and** the file alone.
- Never `docker logs` for the Ops tail — truncating a json-file WEDGES the reader; rotate, never clear.
- Initial sync persists only the newest **50/chat** (`_SYNC_PER_CHAT_LIMIT`); older history lives only in gateway
  memory (A6) ⇒ a restart makes it unreachable unless the on-demand PDO answers.
- Host `grep "a\|b"` returns empty in this shell (alternation artifact) — use the Grep tool or single patterns.

## Skills

Each skill's own `description` is the authority, never a copy here. Load the matching one before improvising:
deploy/release, falsification, frontend verification, latency parity, schema migrations, dead guards, tenant
isolation, test harnesses.
