# Tezlify — project index

Curated index only. Detail lives elsewhere, deliberately:

| Where | What |
| --- | --- |
| `reference/whatsapp-subsystem-invariants.md` | WhatsApp subsystem invariants, sections **A–S** (the `A11`-style refs point here) |
| `reference/production-ops.md` | Production topology, deploy state, release mechanics, test baselines |
| `reference/cross-cutting-rules.md` | General defect patterns (X1–X4): response-model drop, positive cache, bytes-over-name, tenant-global unique |
| `YYYY-MM-DD.md` | Deploy narratives, timings, falsification evidence (most recent first) |
| the skills listed at the end | Reusable procedures — never duplicate them into memory |

## Irreversible-damage list — read before acting

- **Deleting a line is irreversible data loss, never a "disconnect".**
  `DELETE /api/v1/whatsapp/sessions/{id}` cascades (`all, delete-orphan`) to that line's `conversations` +
  `messages`, drops the `whatsapp_sessions` row, and deletes the gateway auth dir. Every conversation
  belongs to one line, so deleting the only connected line wipes the whole WhatsApp dataset.
- **No backup covers WhatsApp conversations/messages** — `archive_mode=off`, no replication slots, no PITR;
  older dumps are schema-only or empty. Before promising a rollback, restore into a scratch DB and **count
  rows** — dump size proves nothing.
- **Deploy only via `scripts/deploy/host-release.sh`; never hand-reset `/opt/tezlify`.** (The checkout is
  **clean**; `.deployed-commit` is the authority — the old "left dirty" note is stale.) **Push is not
  deploy.** It **force-recreates backend+gateway even with `--skip-build`** — so use **`--no-gateway`**
  for any release that does not touch `whatsapp-gateway/` or a compose file (the flag REFUSES, exit 1, if
  `.deployed-commit..target` changes either — never trust the claim, it is verified). A gateway recreate
  costs its in-memory store, §A6. (`--rollback-to` still recreates both.)
  **The script that runs is always the OLD one** — a release cannot be protected by a guard it ships; run
  the target commit's copy (`git show <sha>:scripts/deploy/host-release.sh > /tmp/hr.sh`) since
  `PROJECT_DIR` is hardcoded. Destructive added SQL now exits **3** before any container starts
  (`migration_guard.py`, needs `--allow-migrations`); the candidate log is saved before `docker rm -f`,
  which otherwise deletes it.
- **Never run pytest on the dev DB** (some tests assert global row counts) — use a schema-only copy.
  `conftest` now REFUSES a non-localhost `DATABASE_URL` (the autouse session fixture would migrate it).

## WhatsApp invariants — the one-line "tell" each (full detail in the reference)

- **Chat-list ordering = the ABSOLUTE last message, never the last RECEIVED one** (A4) — Baileys'
  `lastMessageRecvTimestamp` is "received from the other party", so ranking by it sinks every chat whose
  newest message is one *we* sent. Coerce the uint64 (`Number(Long)` is NaN); `last_message_at` only moves
  FORWARD.
- **An empty preview must NEVER gate `last_message_at`** (A11) — preview and timestamp are independent
  decisions; coupling them froze exactly the chats whose last message is text-less. Tell: the **asymmetry**
  (`_map_conversation_event` stamped unconditionally). `ts is None` never seeds a stamp.
- **Text-less system content gets a `[MARKER]` preview body, never a new `message_type`** (A12) —
  `[CALL] [REACTION] [REVOKED] [SYSTEM] [POLL] [EVENT]`; `MessageType` has no `SYSTEM`. **Three label
  tables must stay in parity** (gateway `whatsapp-formatting.js`, backend `preview_normalization.py`,
  frontend `whatsappPreview.ts` + `locales/{en,tr}.ts`).
- **Every gateway in-memory store (`chats`, `messagesByChat`, `store.contacts`) is lost on restart and NOT
  rebuilt** (A6) — WhatsApp sends no history sync for an existing session. Never read the gateway's list as
  "the current chats".
- **`GET /sessions/{sid}/contacts` is NOT a store health check** (A8) — `listContacts()` returns only
  `addressbook`/`verified` names, so it reads **0** while hundreds of `history`-rank names exist.
- **A group known only from its subject has no timestamp at all** (A13) — `_ensureGroupSubjects` seeds
  `last_message_at: null` and WhatsApp never sent one, so it sorts last by design. Distinguish from A11
  (stamp frozen by a bug) before "fixing" it.
- **The durable `whatsapp_sessions` row has exactly ONE writer** — `promote_ephemeral_pairing` (G). The QR
  poll delegates; it must never relink/reuse/INSERT. A refusal is a **409**, never a 502.
- **Gateway owns the unread count including decreases**; never `Math.max` (B). Message uniqueness
  `(conversation_id, wa_message_id) WHERE NOT NULL` (D); tenant routing G-3 (E); No-Create/lease rules (G);
  media + provider contracts and known-open items: F, J.
- **Archive state: "unknown" must never be written as `false`** (K) — the backend contract is *omit the key*
  and it already preserves a stored `is_archived` when the gateway stays silent; the gateway's four `?? false`
  writers made that guard **dead** (live: 112/112 chats carried the key, 111 `false`). Archive state can
  **only** arrive via app-state. Recovery is a **product decision**.
- **The first-load gate opens ONLY on the durable `initial_sync_completed_at` stamp**, never on the
  gateway's `sync.phase == 'ready'` (§O).
- **A guard keyed on "the current page has rows" is DEAD for a page that is empty BY CONSTRUCTION**
  (§P) — pagination past the end re-paid a futile provider round-trip on every click (25.2 s → 502, live
  conv 18192); ask what the **caller** holds, not the page. Client abort budget must EXCEED the server's
  worst case (gateway 25 s < backend 30 s → 40 s). **§P's fix was REVERTED** (`5c1c76d`) — LIVE at `e8a86ee`.
- **Delete-sync / identity / unread narratives → §M, §N, §Q.** `regular_high` vs `regular_low` are different
  app-state collections; `lastMessages` THROWS instead of degrading; "owner unresolved" means EARLY not
  garbage; `remoteJidAlt` files a message under its phone identity at ingest; a local counter must count only
  what was PUBLISHED; a repair job can be starved by the cleanup that runs first; the merge needs a DB-row
  lease with a **normalised** key; a process-global "already initialised" flag must be keyed by the
  **resource**, not by a coarse family label (`_bulk_channel_cache` broke this — `production-ops.md`).
- **A preview is a summary string, never a message row** (§S) — never synthesise a message from it; a
  missing row is `UNSYNCED`, not "no messages" (§R). A `LIMIT` applied before filtering scans a fixed
  prefix, not the work (§Q).

## Cross-cutting

- Identity: `resolve_contact_identity` owns names; REST/WS fields match (never `lead_phone`); sort by
  activity only.
- **An exported-but-never-called guard is a dead guard** (`setSessionPhone()` had no call site) — grep the
  call site before trusting any defensive branch. See `dead-guard-by-construction`.
- **A parity check between two mirrors cannot detect something missing from both** — the i18n check compared
  `en` against `tr`, so 19 keys absent from *both* passed while the UI rendered raw key paths (`useI18n`
  warns and returns the path). Derive the required set from the **consumer** (`t('...')` call sites).
- **Two writers on one unique key: the loser must ADOPT, not fail.** If only one writer has the try/except,
  **that other writer is the bug** — check both. Before "fixing" a duplicate implementation, measure whether
  its branches have ever actually run.
- **Undeclared response fields, positive caches, bytes-over-name, tenant-global unique →
  `reference/cross-cutting-rules.md` (X1–X4).**

## Operational quick hits — full detail in `reference/production-ops.md`

- Production is **PostgreSQL** (`docker exec tezlify-db psql -U tezlify -d tezlify`); the repo-root
  `tezlify.db` is stale. The gateway container has **no `curl`** — probe it with `node` inside it. Run API
  probes **from the production host** — the local sandbox proxy turns `app.tezlify.com` into a 502.
- **`db` is in NO compose file** (unlabelled container, alias `db`, volume `tezlify_postgres_staging_data`)
  — compose calls it an *orphan*, so **never run `up -d --remove-orphans`**; it would delete the database.
  Log rotation is on all four. A `db` restart no longer kills the gateway (fixed in `7357f3b`).
  **`pytest-randomly` is installed**; the suite was order-dependent until `_bulk_channel_cache` was
  keyed by gateway (2026-10-02, now green at 3 seeds) — but a **new** module-global cache can
  reintroduce false reds, so still re-check with `-p no:randomly` and the file alone.
- **Falsify before trusting** — see the `scoped-stash-falsification` skill.
- **Parallel `Edit` calls on one file clobber each other** — edit sequentially or rewrite with one `Write`.
- **Never reintroduce `docker logs` for the Ops tail** — truncating a json-file in place WEDGES the
  daemon's reader forever; the panel reads the file directly (`_tail_json_log`); rotate, never clear.

## Skills covering reusable procedures

Each skill's own `description` is the authority — not duplicated here.

`git-checkout-prod-partial-service-deploy`, `scoped-stash-falsification`,
`esbuild-frontend-verification`, `real-browser-cdp-verification`, `jsdom-react-dom-gate-verification`,
`stack-latency-parity-diagnosis`, `non-destructive-schema-constraint-migration`,
`hermetic-service-process-harness`, `asymmetric-resource-guard-detection`,
`dead-guard-by-construction`, `client-lifecycle-cancels-server-promotion`, `cross-tenant-lookup-isolation`,
`symlink-served-release-fast-forward-deploy`, `fastapi-response-model-silent-field-drop`,
`bootstrap-model-registration-parity`, `tezlify-push-verification-gate`,
`memory-index-truncation-recovery`, `docker-logs-wedge-diagnosis`,
`permissive-branch-removal-orphans-transition`, `fixture-limitation-masks-bug`.
