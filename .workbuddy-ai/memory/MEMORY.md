# Tezlify — project index

Curated index only. Detail lives elsewhere, deliberately:

| Where | What |
| --- | --- |
| `reference/whatsapp-subsystem-invariants.md` | WhatsApp subsystem invariants, sections **A–J** (the numbered `A11`-style refs below point here) |
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
`cross-tenant-lookup-isolation`, `symlink-served-release-fast-forward-deploy`.
