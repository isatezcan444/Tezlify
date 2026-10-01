# Tezlify — project index

Curated index only. Detail lives elsewhere, deliberately:

| Where | What |
| --- | --- |
| `reference/whatsapp-subsystem-invariants.md` | WhatsApp subsystem invariants, sections **A–K** (the numbered `A11`-style refs below point here) |
| `reference/production-ops.md` | Production topology, deploy state, release mechanics, test baselines |
| `YYYY-MM-DD.md` | Deploy narratives, timings, falsification evidence (most recent first) |
| the skills listed at the end | Reusable procedures — never duplicate them into memory |

## Invariants

### WhatsApp — detail in `reference/whatsapp-subsystem-invariants.md`

- **Deleting a line is irreversible data loss, never a "disconnect".**
  `DELETE /api/v1/whatsapp/sessions/{id}` cascades (`all, delete-orphan`) to that line's `conversations` +
  `messages`, drops the `whatsapp_sessions` row, and deletes the gateway auth dir under the
  `tezlify_whatsapp_sessions` volume. Every conversation belongs to one line, so deleting the only
  connected line wipes the whole WhatsApp dataset and forces a QR re-link.
- **No backup covers WhatsApp conversations/messages.** Sep 19 dump is schema-only for those tables;
  Sep 16 restores but has 0 rows; `archive_mode=off`, no replication slots, no PITR. Before promising a
  rollback, restore into a scratch DB and **count rows** — dump size proves nothing.
- **Chat-list ordering = the ABSOLUTE last message, never the last RECEIVED one** (A4). WhatsApp Web
  sorts by `conversationTimestamp`; Baileys' `lastMessageRecvTimestamp` is "the last message received
  from the other party", so ranking by it sinks every chat whose newest message is one *we* sent. Fixed
  in `4fc791a`; coerce the uint64 with `toPositiveSeconds` (`Number(Long)` is NaN) and guard the scale,
  because the backend only moves `last_message_at` FORWARD.
- **An empty preview must NEVER gate `last_message_at`** (A11). Preview and timestamp are two independent
  decisions — `should_apply_last_message` decides the **preview only**. A text-less last message
  (reaction, `protocolMessage` REVOKE, call log, `messageStubType` group notice, audio-only) yields an
  empty summary, and coupling the stamp to it froze exactly those chats at their old list position while
  the rest of the list stayed correct (live 2026-09-26: 21/113 chats empty-preview, 5 null-stamp, conv
  14458 pinned 8.5 min behind). The tell is the **asymmetry**: `_map_conversation_event` always applied
  the stamp unconditionally, so only notification-only chats were wrong. `ts is None` never seeds a stamp
  (Faz 10 RC-1).
- **Text-less system content gets a `[MARKER]` preview body, never a new `message_type`** (A12):
  `[CALL] [REACTION] [REVOKED] [SYSTEM] [POLL] [EVENT]`. `MessageType` has no `SYSTEM` value and adding
  one needs a migration, so the marker rides in `body`. `systemContentMarker()` is the single producer.
  **Three label tables must stay in parity** (gateway `whatsapp-formatting.js`, backend
  `preview_normalization.py`, frontend `whatsappPreview.ts` + `locales/{en,tr}.ts`) — the frontend copy
  had already drifted six labels behind and would have rendered the generic "Mesaj".
- **Every gateway in-memory store (`chats`, `messagesByChat`, `store.contacts`) is lost on restart and is
  NOT rebuilt** (A6) — WhatsApp sends no history sync for an existing session, so a restart silently
  discards ordering data (the DB is the only durable copy) and used to downgrade group sender labels to
  raw phones (A7). Never read the gateway's list as "the current chats".
- **`GET /sessions/{sid}/contacts` is NOT a store health check** (A8) — `listContacts()` returns only
  `addressbook`/`verified` names, so it reads **0** while hundreds of `history`-rank names exist.
- **A group known only from its subject has no timestamp at all** (A13) — `_ensureGroupSubjects` seeds it
  with `last_message_at: null` and WhatsApp never sent one, so it sorts last by design. Distinguish this
  class from A11 (stamp frozen by a bug) before "fixing" it.
- **The durable `whatsapp_sessions` row has exactly ONE writer** — `promote_ephemeral_pairing` (G). The QR
  poll (`GET /pairing/{token}/qr`) delegates; it must never relink/reuse/INSERT. It used to be a second
  writer for the same `gateway_id`, so a live 502 landed on a pairing that had actually SUCCEEDED (the
  modal showed a false failure). A refusal is a 409, never a 502.
- Gateway owns the unread count **including decreases**; never `Math.max` (B). Message uniqueness
  `(conversation_id, wa_message_id) WHERE NOT NULL` (D); tenant routing G-3 (E); No-Create/lease rules
  (G); media, provider contracts and known-open items: F, J.
- **Archive state: "unknown" must never be written as `false`** (K). The backend contract is *omit the
  key* — all three write sites guard on key presence (`events.py:1104`, `sync.py:985,1847`), so it already
  preserves a stored `is_archived` when the gateway stays silent. The gateway's four writers used to
  default to `?? false`, making that guard **dead** and asserting `false` for chats it knew nothing about
  (live: 112/112 chats carried the key, 111 `false`). Archive state can **only** arrive via app-state,
  never history sync (`Utils/history.js` has no `archived` mapping) — and on an initial sync the update is
  conditional and gets **swallowed forever** for any chat absent from `historySets`. Since the store is
  memory-only (A6), a restart then wiped known state. Fixed via `archivedPatch()`; recovering the already
  lost rows is a **product decision** (needs a forced app-state resync that can clear unread badges).

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
- **Two writers on one unique key: the loser must ADOPT, not fail.** When two code paths can both INSERT a
  row guarded by a unique index, whichever loses has to roll back and re-read the winner's row. If only one
  writer has the try/except, **that other writer is the bug** — check both before trusting either. And
  before "fixing" a duplicate implementation, measure whether its branches have ever actually run.
- **A key the serializer emits but the `response_model` does not DECLARE never reaches the client.**
  Pydantic v2 defaults to `extra="ignore"`, so `WhatsAppMessageItem` silently discarded the
  `link_preview` dict that `serialize_message` always builds (`whatsapp/orchestration/messaging.py:117`)
  — the whole link-preview feature ran correctly server-side and was **invisible in production**
  (live 2026-09-30: `status=OK` rows in `link_previews`, yet `HAS preview KEY: False` on the wire).
  The tell is an **asymmetry**: `reactions` was declared on the same model and worked. The same bug had
  already been fixed for `WhatsAppSessionResponse.sync` with an in-file comment (A8) — the pattern was
  known and recurred. Tests stopped at the service/serializer layer and never crossed the Pydantic
  boundary, so both were green while the feature was dead. See
  `fastapi-response-model-silent-field-drop` (includes the generic guard test:
  `set(serialize(row)) - set(Model.model_fields)` must be empty).
- **A code fix is not retroactive over a positive cache.** Correcting how a value is *computed* leaves
  already-cached rows holding the old value for their full TTL — the two consent-interstitial rows
  (`status=OK`, 7-day TTL) kept their wrong titles until `expires_at` was forced into the past so the
  next chat-open re-resolved them. Always pair a compute-path fix with a cache-invalidation step.

## Operational quick hits — full detail in `reference/production-ops.md`

- **Push is not deploy.** Prod `/opt/tezlify` is a git checkout **deliberately left dirty** as the deploy
  marker — never `git checkout .` / `git reset --hard` / `git clean` there. Production is **PostgreSQL**
  (`docker exec tezlify-db psql -U tezlify -d tezlify`); the repo-root `tezlify.db` is stale.
- The gateway container has **no `curl`**; probe it with `node` inside it. Run API probes **from the
  production host** — the local sandbox proxy turns `app.tezlify.com` into a 502.
- **Never run pytest on the dev DB** (schema-only copy instead; some tests assert global row counts), and
  **falsify before trusting** — see the `scoped-stash-falsification` skill.
- **Parallel `Edit` calls on one file clobber each other** — edit sequentially or rewrite with one `Write`.

## Skills covering reusable procedures

`git-checkout-prod-partial-service-deploy` (subset/deferred deploy, rebase-and-delta, `--no-deps`),
`scoped-stash-falsification` (prove a fix is load-bearing / a failure is pre-existing by stashing only
the source and re-running), `esbuild-frontend-verification` (executed frontend checks with
no test runner), `real-browser-cdp-verification`, `stack-latency-parity-diagnosis`,
`non-destructive-schema-constraint-migration`, `hermetic-service-process-harness`,
`asymmetric-resource-guard-detection`, `client-lifecycle-cancels-server-promotion`,
`cross-tenant-lookup-isolation`, `symlink-served-release-fast-forward-deploy`,
`fastapi-response-model-silent-field-drop` (a serializer key absent from the `response_model` is
silently dropped by Pydantic v2 — detect it on the wire, close it with a key-set contract test),
`bootstrap-model-registration-parity` (a hand-provisioned test DB must import **every** model module,
not just `app/models/` — otherwise tables are silently absent and unrelated tests die on "no such table";
add a `Base.metadata.tables - actual` hard gate), `tezlify-push-verification-gate` (the exact 3-suite
pre-push sequence + the four sandbox traps that fake a signal: dev-DB prohibition, `tmp_path` EEXIST,
the Vite bulk-delete guard, and piped output masking the exit code).

## WhatsApp delete sync — the two app-state collections are NOT the same collection

`chatModify({ delete: true, lastMessages })` writes a `deleteChatAction` into **`regular_high`**
(`apiVersion: 6`), whereas read/archive (`markChatAsReadAction`, `archiveChatAction`) write to
**`regular_low`**. Measured on prod: `regular_high` was still advancing while `regular_low` was frozen,
so the outbound delete is **independent** of the app-state fault — never assume one fix covers both
symptoms, and never conclude "app-state is dead" from one frozen collection.

`lastMessages` is validated by Baileys `getMessageRange` and **throws instead of degrading**: every
entry needs `key.remoteJid`, `key.id` and a convertible `messageTimestamp`; a group entry with
`fromMe: false` also needs `participant`. Ship a **one-element** list (the newest message) — the
multi-element ordering is ambiguous because `lastMessageTimestamp` is read from the LAST element while
the docstring says "reverse chronologically".

Clearing the in-memory chat caches on a successful remote delete is load-bearing: leaving them lets
the next chat discovery re-create the chat, i.e. the delete undoes itself. On failure, do NOT clear
them — a chat we failed to delete must not vanish from our own view.

## WhatsApp identity + unread — three separate mechanisms inside "the sync looks broken"

**"Owner unresolved" means EARLY, not garbage.** `resolve_event_owner_and_session` looks the session
up by `gateway_id`; during a QR pairing the `whatsapp_sessions` row does not exist yet, so it raises
`EventOwnerUnresolved` and the dispatch path used to discard the event. That single drop starved the
**entire** LID identity repair (`_heal_lid_contact_identity` +
`reconcile_legacy_split_conversation`, whose only caller is the `lid_mapped` handler) — the machine
existed and was never fed. Events are now held in a bounded, TTL'd queue and replayed when a later
event for the same gateway session resolves an owner. Before blaming a missing mechanism, check
whether the existing one is merely starved of input.

**`WAMessageKey.remoteJidAlt` / `participantAlt` carry the same entity's other address.** Reading them
files a message under its phone identity at INGEST time. Without it, a LID-addressed message is held
(`lidHold`) and only emitted if a mapping event arrives later — so during a first pairing, when no
mapping is learned yet, the messages the user can see on their phone are exactly the held ones. When
deriving a LID→PN pair, validate the phone side strictly: `asPn` passes anything containing `@`
through, so a GROUP jid would be accepted and would poison `lidToJid` with a LID→group mapping.

**A local counter must count only what was PUBLISHED.** The gateway incremented its in-memory
`unread_count` for every inbound message, including held ones it never emitted, so its list disagreed
with the backend (measured: gateway 2 / DB 1). The mismatch is a second contradictory truth, not a
richer one. Note what was deliberately NOT done: publishing the increment so the backend adopts it
changes who OWNS the counter and would require redesigning the downward-only
`should_apply_unread_count` gate. Fix only the wrong part.

**QR-window events skipping the durable outbox is not a bug.** The outbox has a `gateway_sessions` FK
and an ephemeral pairing session has no row by design (PG 23503, ~24 logged failures/day), so durable
storage is only promised for registered sessions.

**A repair job can be starved by the cleanup that runs first.** Two mechanisms addressed the same
LID split: `reconcile_legacy_split_conversation` MOVES the ghost's messages onto the canonical
conversation, while the startup migration `purge_raw_jid_identity_data` DELETED the ghost, its
conversation and its messages. The purge documented itself as cleaning *unresolved* LID ghosts but
its SQL asked no question about the bridge — and the bridge is exactly what makes a row repairable.
Measured in production: **208 known LID→phone bridges, 0 ghost contacts, 0 ghost conversations**,
while the deploy report attributed `conversations 449 → 447` to that same purge. The repair reported
`0 candidates` forever because the purge always won the race. Before concluding a repair finds
nothing to fix, verify its input still exists.

**"0 results" is not evidence until each stage of the discovery query is measured.** The same run
showed 17300 `lid_mappings` rows (17288 `@lid`), 208 surviving a `whatsapp_sessions` JOIN, and 0
ghost contacts — the bottleneck was the material, not the query. A single `0` cannot distinguish
"nothing to do" from "the query can never match".

**Probe table existence WITHOUT running the query in Postgres.** A `try/except` around
`SELECT 1 FROM some_table` does not work: the failed statement puts the transaction into the
*aborted* state and every subsequent statement fails too. Use `to_regclass('schema.table')` (PG) or
`sqlite_master` (SQLite) — both return NULL rather than raising. Also pick the table name by dialect:
`whatsapp_private.lid_mappings` in PG, plain `lid_mappings` in SQLite. Startup order makes this safe
(`ensure_whatsapp_gateway_private_schema` runs before the purge).

**An assertion about the whole table is a trap when the test DB persists.** `tezlify.db` is a file
that survives between runs, and `+905551112233` is a fixture phone shared by ~17 test files. An
assertion phrased "this phone exists nowhere" fails on another file's residue instead of on a
regression — and did, intermittently. Scope assertions to the test's own user. Related: writers
disagree on whether `user_id` keeps its dashes, so a cleanup that deletes only one form leaves the
row for the next run.
