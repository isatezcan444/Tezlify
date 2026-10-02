# Tezlify — project index

Curated index only. Detail lives elsewhere, deliberately:

| Where | What |
| --- | --- |
| `reference/whatsapp-subsystem-invariants.md` | WhatsApp subsystem invariants, sections **A–N** (the `A11`-style refs point here) |
| `reference/production-ops.md` | Production topology, deploy state, release mechanics, test baselines |
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
- **Deploy only via `scripts/deploy/host-release.sh`; never hand-reset `/opt/tezlify`.** (Measured
  2026-10-01: that checkout is **clean** at the released SHA; `/opt/tezlify/.deployed-commit` is the
  authoritative marker — the older "deliberately left dirty" note is stale.) **Push is not deploy.**
- **Never run pytest on the dev DB** (some tests assert global row counts) — use a schema-only copy.

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
  **  only** arrive via app-state. Recovering the already-lost rows is a **product decision**.
- **The first-load gate opens ONLY on the durable `initial_sync_completed_at` stamp**, never on the
  gateway's `sync.phase == 'ready'` (§O).
- **Delete-sync / identity / unread narratives → §M, §N.** `regular_high` vs `regular_low` are different
  app-state collections; `lastMessages` THROWS instead of degrading; "owner unresolved" means EARLY not
  garbage; `remoteJidAlt` files a message under its phone identity at ingest; a local counter must count only
  what was PUBLISHED; a repair job can be starved by the cleanup that runs first; the merge needs a DB-row
  lease with a **normalised** key; a process-global "already initialised" flag must be keyed by the
  **resource**, not by a coarse family label — the same rule `_bulk_channel_cache` broke by being a
  flat, un-keyed dict (one line's failed probe answered for EVERY line for 300 s; fixed 2026-10-02).

## Cross-cutting

- Identity: `resolve_contact_identity` owns names; REST/WS fields match (never `lead_phone`); sort by
  activity only.
- **An exported-but-never-called guard is a dead guard.** `setSessionPhone()` shipped with no call site, so
  the cache's phone stamp stayed `null` and its mismatch check could never fire. Grep for the call site
  before trusting any defensive branch.
- **A parity check between two mirrors cannot detect something missing from both.** The i18n check compared
  `en` against `tr`, so 19 keys absent from *both* passed it while the UI rendered raw key paths (`useI18n`
  warns and returns the path). Derive the required set from the **consumer** (the `t('...')` call sites),
  not the sibling copy.
- **Two writers on one unique key: the loser must ADOPT, not fail.** If only one writer has the try/except,
  **that other writer is the bug** — check both. Before "fixing" a duplicate implementation, measure whether
  its branches have ever actually run.
- **A key the serializer emits but the `response_model` does not DECLARE never reaches the client.**
  Pydantic v2 defaults to `extra="ignore"`, so `WhatsAppMessageItem` silently discarded `link_preview`
  (always built by `serialize_message`, `whatsapp/orchestration/messaging.py:117`) — the feature ran
  correctly server-side and was **invisible in production**. Tell: the **asymmetry** (`reactions` was
  declared on the same model and worked). Already fixed once for `WhatsAppSessionResponse.sync` (A8), so the
  pattern recurred. See `fastapi-response-model-silent-field-drop`.
- **A code fix is not retroactive over a positive cache.** Correcting how a value is *computed* leaves
  cached rows holding the old value for their full TTL (two 7-day consent-interstitial rows kept wrong
  titles until `expires_at` was forced into the past). Always pair a compute-path fix with a cache
  invalidation.

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
`client-lifecycle-cancels-server-promotion`, `cross-tenant-lookup-isolation`,
`symlink-served-release-fast-forward-deploy`, `fastapi-response-model-silent-field-drop`,
`bootstrap-model-registration-parity`, `tezlify-push-verification-gate`,
`memory-index-truncation-recovery`, `docker-logs-wedge-diagnosis`,
`permissive-branch-removal-orphans-transition`, `fixture-limitation-masks-bug`
(**a deliberately constrained fixture can make the bug class structurally unobservable — a green gate
is not coverage; assert the side-effect COUNT, not just the end state**).
