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
  `messages`, drops the `whatsapp_sessions` row, and deletes the gateway auth dir under the
  `tezlify_whatsapp_sessions` volume. Every conversation belongs to one line, so deleting the only connected
  line wipes the whole WhatsApp dataset and forces a QR re-link.
- **No backup covers WhatsApp conversations/messages.** Sep 19 dump is schema-only for those tables; Sep 16
  restores but has 0 rows; `archive_mode=off`, no replication slots, no PITR. Before promising a rollback,
  restore into a scratch DB and **count rows** — dump size proves nothing.
- **Prod `/opt/tezlify` is a git checkout deliberately left dirty** as the deploy marker — never
  `git checkout .` / `git reset --hard` / `git clean` there. **Push is not deploy.**
- **Never run pytest on the dev DB** (some tests assert global row counts) — use a schema-only copy.

## WhatsApp invariants — the one-line "tell" each (full detail in the reference)

- **Chat-list ordering = the ABSOLUTE last message, never the last RECEIVED one** (A4) — Baileys'
  `lastMessageRecvTimestamp` is "the last message received from the other party", so ranking by it sinks
  every chat whose newest message is one *we* sent. Coerce the uint64 with `toPositiveSeconds`
  (`Number(Long)` is NaN); `last_message_at` only moves FORWARD.
- **An empty preview must NEVER gate `last_message_at`** (A11) — preview and timestamp are two independent
  decisions, and coupling them froze exactly the chats whose last message is text-less (reaction, REVOKE,
  call log, group notice, audio-only). The tell is the **asymmetry**: `_map_conversation_event` applied the
  stamp unconditionally. `ts is None` never seeds a stamp.
- **Text-less system content gets a `[MARKER]` preview body, never a new `message_type`** (A12) —
  `[CALL] [REACTION] [REVOKED] [SYSTEM] [POLL] [EVENT]`; `MessageType` has no `SYSTEM` value and adding one
  needs a migration. **Three label tables must stay in parity** (gateway `whatsapp-formatting.js`, backend
  `preview_normalization.py`, frontend `whatsappPreview.ts` + `locales/{en,tr}.ts`).
- **Every gateway in-memory store (`chats`, `messagesByChat`, `store.contacts`) is lost on restart and NOT
  rebuilt** (A6) — WhatsApp sends no history sync for an existing session. Never read the gateway's list as
  "the current chats".
- **`GET /sessions/{sid}/contacts` is NOT a store health check** (A8) — `listContacts()` returns only
  `addressbook`/`verified` names, so it reads **0** while hundreds of `history`-rank names exist.
- **A group known only from its subject has no timestamp at all** (A13) — `_ensureGroupSubjects` seeds it
  `last_message_at: null` and WhatsApp never sent one, so it sorts last by design. Distinguish this class
  from A11 (stamp frozen by a bug) before "fixing" it.
- **The durable `whatsapp_sessions` row has exactly ONE writer** — `promote_ephemeral_pairing` (G). The QR
  poll delegates; it must never relink/reuse/INSERT. It used to be a second writer, so a live 502 landed on
  a pairing that had actually SUCCEEDED. A refusal is a **409**, never a 502.
- **Gateway owns the unread count including decreases**; never `Math.max` (B). Message uniqueness
  `(conversation_id, wa_message_id) WHERE NOT NULL` (D); tenant routing G-3 (E); No-Create/lease rules (G);
  media + provider contracts and known-open items: F, J.
- **Archive state: "unknown" must never be written as `false`** (K) — the backend contract is *omit the key*
  and it already preserves a stored `is_archived` when the gateway stays silent; the gateway's four `?? false`
  writers made that guard **dead** (live: 112/112 chats carried the key, 111 `false`). Archive state can
  **only** arrive via app-state, never history sync. Recovering the already-lost rows is a **product
  decision** (needs a forced app-state resync that can clear unread badges).
- **Delete-sync / identity / unread narratives → §M, §N.** `regular_high` vs `regular_low` are different
  app-state collections; `lastMessages` THROWS instead of degrading; "owner unresolved" means EARLY not
  garbage; `remoteJidAlt` files a message under its phone identity at ingest; a local counter must count only
  what was PUBLISHED; a repair job can be starved by the cleanup that runs first; the merge needs a DB-row
  lease with a **normalised** key; a process-global "already initialised" flag must be keyed by the
  **resource**, not by a coarse family label.

## Cross-cutting

- Identity: `resolve_contact_identity` owns names; REST/WS fields match (never `lead_phone`); sort by
  activity only.
- **An exported-but-never-called guard is a dead guard.** `setSessionPhone()` shipped with no call site, so
  the cache's phone stamp stayed `null` and its mismatch check could never fire. Grep for the call site
  before trusting any defensive branch.
- **A parity check between two mirrors cannot detect something missing from both.** The i18n check compared
  `en` against `tr`, so 19 keys absent from *both* dictionaries passed it while the UI rendered raw key paths
  (`useI18n` warns and returns `path`). Derive the required set from the **consumer** (the `t('...')` call
  sites), not the sibling copy. Same trap for any "these two lists must match" assertion.
- **Two writers on one unique key: the loser must ADOPT, not fail.** When two code paths can both INSERT a
  row guarded by a unique index, whichever loses has to roll back and re-read the winner's row. If only one
  writer has the try/except, **that other writer is the bug** — check both before trusting either. And
  before "fixing" a duplicate implementation, measure whether its branches have ever actually run.
- **A key the serializer emits but the `response_model` does not DECLARE never reaches the client.**
  Pydantic v2 defaults to `extra="ignore"`, so `WhatsAppMessageItem` silently discarded the `link_preview`
  dict that `serialize_message` always builds (`whatsapp/orchestration/messaging.py:117`) — the whole
  link-preview feature ran correctly server-side and was **invisible in production** (live 2026-09-30:
  `status=OK` rows in `link_previews`, yet `HAS preview KEY: False` on the wire). The tell is an
  **asymmetry**: `reactions` was declared on the same model and worked. It had already been fixed once for
  `WhatsAppSessionResponse.sync` (A8) — the pattern was known and recurred. Tests stopped below the Pydantic
  boundary, so both were green while the feature was dead. See `fastapi-response-model-silent-field-drop`
  (generic guard: `set(serialize(row)) - set(Model.model_fields)` must be empty).
- **A code fix is not retroactive over a positive cache.** Correcting how a value is *computed* leaves
  already-cached rows holding the old value for their full TTL — the two consent-interstitial rows
  (`status=OK`, 7-day TTL) kept their wrong titles until `expires_at` was forced into the past so the next
  chat-open re-resolved them. Always pair a compute-path fix with a cache-invalidation step.

## Operational quick hits — full detail in `reference/production-ops.md`

- Production is **PostgreSQL** (`docker exec tezlify-db psql -U tezlify -d tezlify`); the repo-root
  `tezlify.db` is stale. The gateway container has **no `curl`** — probe it with `node` inside it. Run API
  probes **from the production host** — the local sandbox proxy turns `app.tezlify.com` into a 502.
- **Falsify before trusting** — see the `scoped-stash-falsification` skill.
- **Parallel `Edit` calls on one file clobber each other** — edit sequentially or rewrite with one `Write`.
- Ops log clearing **TRUNCATEs** the container log file in place (never delete — the daemon holds the inode
  and keeps appending; deleting strands the output and reclaims nothing). `docker-compose.prod.yml` mounts
  `/var/lib/docker/containers:rw` for exactly this.

## Skills covering reusable procedures

`git-checkout-prod-partial-service-deploy`, `scoped-stash-falsification` (prove a fix is load-bearing / a
failure is pre-existing by stashing only the source and re-running), `esbuild-frontend-verification`,
`real-browser-cdp-verification`, `jsdom-react-dom-gate-verification`, `stack-latency-parity-diagnosis`,
`non-destructive-schema-constraint-migration`, `hermetic-service-process-harness`,
`asymmetric-resource-guard-detection`, `client-lifecycle-cancels-server-promotion`,
`cross-tenant-lookup-isolation`, `symlink-served-release-fast-forward-deploy`,
`fastapi-response-model-silent-field-drop`, `bootstrap-model-registration-parity` (a hand-provisioned test
DB must import **every** model module, not just `app/models/`, or tables are silently absent and unrelated
tests die on "no such table"), `tezlify-push-verification-gate` (the exact 3-suite pre-push sequence + the
sandbox traps that fake a signal).
