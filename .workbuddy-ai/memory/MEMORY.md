# Tezlify — project index

Index only. Detail is deliberately elsewhere — read the reference before acting.

| Where | What |
| --- | --- |
| `reference/whatsapp-subsystem-invariants.md` | Invariants **A–T** (the `A11`-style refs point here) |
| `reference/production-ops.md` | Topology, deploy state, release mechanics, test baselines |
| `reference/cross-cutting-rules.md` | Defect patterns **X1–X4** |
| `YYYY-MM-DD.md` | Deploy narratives, timings, falsification evidence |

## Irreversible damage — read before acting

- **Deleting a line is irreversible data loss, never a "disconnect".** `DELETE /sessions/{id}` cascades
  (`all, delete-orphan`) to that line's conversations + messages, drops the `whatsapp_sessions` row and
  deletes the gateway auth dir. Every conversation belongs to one line ⇒ deleting the only connected line
  wipes the whole WhatsApp dataset.
- **No backup covers WhatsApp conversations/messages** (`archive_mode=off`, no slots, no PITR; older dumps
  are schema-only). Before promising a rollback, restore into a scratch DB and **count rows** — dump size
  proves nothing.
- **Deploy only via `scripts/deploy/host-release.sh`; never hand-reset `/opt/tezlify`.** Checkout is clean;
  `.deployed-commit` is the authority. **Push is not deploy.** It force-recreates backend+gateway even with
  `--skip-build` ⇒ use **`--no-gateway`** unless `whatsapp-gateway/` or a compose file changed (the flag
  REFUSES, exit 1 — verified). A gateway recreate costs its in-memory store (A6). **The script that runs is
  always the OLD one** — run the target commit's copy (`git show <sha>:scripts/deploy/host-release.sh >
  /tmp/hr.sh`). Destructive added SQL exits **3** before any container starts (`migration_guard.py`).
- **Never run pytest on the dev DB** (some tests assert global row counts); `conftest` REFUSES a
  non-localhost `DATABASE_URL`.

## Invariants — the one-line tell each (detail in the reference)

- Chat-list order = the **absolute** last message, never the last *received* one (A4); coerce the uint64.
- An **empty preview must never gate `last_message_at`** (A11) — independent decisions; the tell is the
  asymmetry.
- Text-less content gets a `[MARKER]` preview body, never a new `message_type` (A12); **three label tables
  must stay in parity** (gateway / backend / frontend+locales).
- Every gateway in-memory store is lost on restart and **not rebuilt** (A6).
- `GET /sessions/{sid}/contacts` is **not** a store health check (A8) — it reads 0 while hundreds exist.
- A group known only from its subject has **no** timestamp (A13) — sorts last by design, not a bug.
- **A LID bridge is keyed to the CONNECTION, never the person** (A14/T) — joining `ws.gateway_id` matched
  **4 of 4107**; defer on `lid_jid` alone, take ownership from `contacts.user_id`, never guess.
- `whatsapp_sessions` has exactly **one** writer (`promote_ephemeral_pairing`); a refusal is **409**, not 502.
- Gateway owns the unread count **including decreases** (never `Math.max`, B). Message uniqueness
  `(conversation_id, wa_message_id) WHERE NOT NULL` (D).
- **Archive "unknown" must never be written as `false`** (K) — omit the key; only app-state carries it.
- The first-load gate opens ONLY on the durable `initial_sync_completed_at` stamp, never `sync.phase ==
  'ready'` (O).
- **A guard keyed on "the page has rows" is DEAD for a page empty BY CONSTRUCTION** (P) — ask what the
  *caller* holds. P's fix was REVERTED (`5c1c76d`), live at `e8a86ee`.
- A preview is a summary string, never a message row (S); a missing row is `UNSYNCED` (R); a `LIMIT`
  applied before filtering scans a prefix (Q). Delete-sync / identity / unread → M, N, Q.

## Cross-cutting

- Identity: `resolve_contact_identity` owns names; REST/WS fields match (never `lead_phone`); sort by
  activity only.
- **An exported-but-never-called guard is a dead guard** — grep the call site before trusting it.
- **A parity check between two mirrors cannot detect something missing from both** — derive the required
  set from the **consumer** (`t('...')` call sites).
- **Two writers on one unique key: the loser must ADOPT.** If only one has the try/except, that other
  writer is the bug.
- **A process-global cache/flag must be keyed by the RESOURCE**, not a coarse family label.
- X1–X4 → `reference/cross-cutting-rules.md`.

## Ops quick hits — full detail in `production-ops.md`

- PostgreSQL via `docker exec tezlify-db psql -U tezlify -d tezlify`; the repo-root `tezlify.db` is stale.
  The gateway container has no `curl` (probe with `node`); run API probes **from the production host**.
- **`db` is in NO compose file** ⇒ never `up -d --remove-orphans` (it would delete the database).
- **`pytest-randomly` is installed** — a new module-global cache, or a cleanup helper that can raise,
  reintroduces order-dependence. Re-check with `-p no:randomly` **and** the file alone.
- **Falsify before trusting** (`scoped-stash-falsification`). Parallel `Edit` on one file clobbers.
- Never `docker logs` for the Ops tail — truncating a json-file WEDGES the reader; rotate, never clear.
- `event_outbox` DEAD_LETTER is purged after **48 h** (`postgres-event-outbox.js::cleanup()`); an operator
  replay must happen inside that window or the encrypted payload is gone.
- Initial sync persists only the newest **50/chat** (`_SYNC_PER_CHAT_LIMIT`); older history lives only in
  gateway memory (A6) ⇒ a restart makes it unreachable unless the on-demand PDO answers.

## Skills

Reusable procedures live as skills — **each skill's own `description` is the authority**, never a copy
here. Load the matching one before improvising: deploy/release, falsification, frontend verification,
latency parity, schema migrations, dead guards, tenant isolation, test harnesses.
