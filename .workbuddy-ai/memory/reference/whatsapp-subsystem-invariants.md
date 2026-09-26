# Tezlify — WhatsApp subsystem invariants (full reference)

Every entry verified against source or a read-only production query. Follow them; do not "fix" code
that satisfies them. `MEMORY.md` is the index; this file is the detail.

## A. Identity, ordering, payload contract

- **A1 Identity authority:** `resolve_contact_identity()` (`services/whatsapp/identity.py`) owns
  display name / phone / identity_state. `NAME_RANK = {addressbook:5, verified:4, group_subject:4,
  history:3, push:2, phone:1}`. `name_source=="push"` = the counterparty's OWN WA profile name — never
  a stranger's display name (show `+90...`); store in `custom_attributes["push_name"]`, never
  `display_name`. `_set_contact_name` refuses at `current_rank > 2`, and `2 > 2` is False, so it cannot
  clear push pollution → **guard at the writer**.
- **A2 REST/WS canonical payload ("I-3" class):** both transports use identical field names —
  `session_id, contact_id, lead_id, name, phone, identity_state, is_group, is_archived, avatar_url,
  last_message_preview, last_message_at, created_at, updated_at, unread_count, status`. **Never
  `lead_phone`.** `mapConversation` copies a field only when present: merge is `{...existing, ...mapped}`,
  so an explicit `undefined` ERASES known state ("Kişi kimliği çözülüyor…").
- **A3 `identity != ordering`.** Sort = activity only: `last_message_at` → `created_at` → `id`.
  Identity/name/phone presence never affect sort. Message-less conversations sort last. The three tiers
  agree: gateway `sessionManager.listConversations`, backend `whatsapp_service.list_conversations`
  (`ORDER BY last_message_at DESC NULLS LAST, id DESC`), frontend `compareConversationsByActivityDesc`
  (`whatsappOrdering.ts`). `GetConversationActivityTimestamp` returns `0` for a missing
  `last_message_at` so message-less chats sink — it does NOT fall back to `updated_at`.
- **A4 The ordering VALUE must be the ABSOLUTE last message, not the last RECEIVED one** (fixed
  `4fc791a`). WhatsApp Web sorts by `proto.Conversation.conversationTimestamp` (field 12). Baileys' own
  type doc: `lastMsgRecvTimestamp` = "the last message received from the other party";
  `lastMsgTimestamp` = "the absolute last message in the chat". `socket-events.js`'s
  `messaging-history.set` handler used `Number(chat.lastMessageRecvTimestamp || newest?.timestamp_s)` as
  its FIRST choice, so every chat whose newest message was OUTBOUND sank below its WhatsApp Web
  position. Precedence is now `resolveChatActivitySeconds()` in `message-store.js`:
  `conversationTimestamp -> lastMsgTimestamp -> newest local message (sent OR received) ->
  lastMessageRecvTimestamp`. Coerce via `toPositiveSeconds` — `Number(Long)` is `NaN`, which silently
  discards a valid stamp. Guard the SCALE too: these are uint64 SECONDS, and the backend only moves
  `last_message_at` FORWARD (`sync.py` `gw_ts > conv.last_message_at`; `events.py` `last_at >
  conv.last_message_at`, applied unconditionally outside the preview gate), so a millisecond value would
  latch a chat to the top permanently.
- **A5 `messaging-history.set` must apply the same monotonic rule as `chats.update` and `_touchChat`.**
  History sync arrives in many chunks (28 ingests in one day on production); a late chunk carrying an
  older stamp must never drag a chat back down. Those two already refused to move a stamp backwards;
  history sync did not, until `4fc791a`.
- **A6 The gateway's `chats` and `messagesByChat` are memory-only and are NOT rebuilt on reconnect.**
  WhatsApp does not resend a history sync for an existing session (log: `First connection, awaiting
  history sync notification with a 20s timeout` → `History sync finalized`, **0** `History sync
  ingested`). Measured 2026-09-26: after a restart the gateway held **12 of 113** chats and no messages.
  So (a) a restart silently discards ordering data and the DB is the only durable copy, (b) a fix whose
  effect flows through history sync cannot be observed in vivo in the same session, and (c) the
  gateway's list must never be read as "the current chats".
- **A7 Sender labels come from the message row, not the contact record.** `ChatBubble.tsx` renders
  `message.sender_name` / `sender_phone`, frozen at ingest by `_resolveDisplayName()` =
  `store.contacts` name → `msg.pushName` → phone. `store.contacts` is memory-only too, so a restart used
  to downgrade group labels to raw phones. Two durable paths: `<sessionDir>/contacts-cache.json` (fast
  path, loaded before the socket) and `contacts/contact-repository.js` hydration from `public.contacts`
  scoped by `whatsapp_sessions.gateway_id → user_id` (backstop). Hydrated names enter at `history` rank,
  so a live `addressbook`/`group_subject` name is never downgraded. `backfill_phone_sender_names`
  repairs already-degraded rows.
- **A8 `GET /sessions/{sid}/contacts` is NOT a store health check.** `listContacts()` returns only
  `name_source in ('addressbook','verified')`, so it reads **0** even with hundreds of `history`-rank
  names present. Prove store contents via `contacts-cache.json` (mirrors the store) or the `Hydrated
  contact names from backend database` / `Restored contact names from disk cache` log lines.
- **A9 Ordering-value provenance in the DB:** message-derived when the chat has local messages
  (`external_timestamp` is always populated — all 529 rows had it, so the `created_at` ingest fallback is
  NOT in play), otherwise inherited from the gateway. Measured 2026-09-26 across 113 chats: 24 stamps
  older than their own newest message (23 with an OUTBOUND newest; worst 36 days), 4 newer, 18 with no
  local messages. Those message-less chats are exactly where gateway-derived (and previously wrong)
  stamps live.
- **A10 `contacts` has no `name_source` column** (`phone_e164`, `display_name`, `lead_id`,
  `custom_attributes`); source/rank lives only in the gateway store and `mergeContactName()`.
- **A11 `last_message_at` and `last_message_preview` are TWO INDEPENDENT decisions — an empty preview
  must never gate the activity timestamp.** `should_apply_last_message` decides the **preview only**;
  `apply_conversation_last_message` advances the stamp on `ts is strictly newer` regardless of the
  summary, and both snapshot sites in `sync.py` (`_persist_chat_snapshot` ~L887,
  `sync_session_history` ~L1733) apply `gw_ts` in an `elif` **outside** `if gw_summary:`. A text-less
  last message — reaction, `protocolMessage` REVOKE, call log, `messageStubType` group notice (settings
  change / participant added / username created), audio-only — has an empty summary, so the old
  coupling froze exactly those chats at their old list position while the rest of the list stayed
  correct. Live proof 2026-09-26: 21/113 chats empty-preview and 5 with a null stamp, conv 14458
  ("Hat 1") pinned at 09:35:56 against a newest message at 09:44:25. The tell is the **asymmetry** —
  `events.py::_map_conversation_event` always applied the stamp unconditionally, which is why only
  notification-only chats were wrong. `ts is None` never seeds a stamp (Faz 10 RC-1).
- **A12 Text-less system content gets a bracketed preview MARKER, never a new `message_type`.**
  `MessageType` has no `SYSTEM`/`REACTION` member and adding one needs a migration, so the marker
  travels in `body` and `normalizePreviewText` resolves it through the label table:
  `[CALL]`, `[REACTION]`, `[REVOKED]`, `[SYSTEM]`, `[POLL]`, `[EVENT]`. `systemContentMarker()`
  (`messages/message-classifier.js`) is the single producer; the live path
  (`session-manager.js::_ingestUpsertMessage`) falls back to it when `buildChatPreview` yields nothing.
  Trigger = `messageStubType > 0` (may be a protobuf `Long` — use `toNumber()`) or `protocolMessage`
  (`type === 0` = REVOKE) or reaction/call/poll/event content. `messageStubType` `0`/absent must produce
  **no** marker. **Three parallel label tables must stay in parity** — gateway
  `utils/whatsapp-formatting.js`, backend `preview_normalization.py`, frontend
  `whatsappPreview.ts` (+ `locales/{en,tr}.ts`); the frontend copy had drifted six labels behind and
  would have rendered the generic "Mesaj". Guard: `whatsapp-gateway/scripts/test-system-content-preview.mjs`
  (14 checks, wired into `npm test`).
- **A13 A chat learned ONLY from a group subject has no timestamp at all.** `_ensureGroupSubjects` /
  `seedGroupChat` create the row from `groupFetchAllParticipating` with `last_message_at: null` and
  `name_source: "group_subject"` (live 2026-09-26: 5 chats, `created_at == updated_at`). WhatsApp
  supplied neither a message nor a timestamp, so no code path can recover one — they sort last
  (`NULLS LAST`) by design. Distinguish this class from A11 (stamp frozen by a bug) before "fixing".

## B. Unread badge — one policy, two places

Gateway **owns** `unread_count` and reports DECREASES (read on phone → 0), so monotonic
`max(local, incoming)` is always wrong. Authority `should_apply_unread_count()`
(`preview_normalization.py`) via `apply_conversation_unread_count()` (`repositories/conversations.py`).

- **Staleness guard must be SYMMETRIC** (`inc_ts < cur_ts` blocks both directions). Anchoring only on
  `last_read_at` is not enough — an EXTERNAL read never sets it (P6-1).
- **P6-2: an authoritative drop to 0 IS read evidence** → stamp `last_read_at = last_message_at`, not
  `utcnow()`. Do NOT require "a raise needs strictly newer activity" — a snapshot legitimately
  reporting the full count (0→5, 1→7) at an unchanged ts is normal. Discriminator is READ EVIDENCE.
- `mark_conversation_read()` writes only inside the success path (`gateway_ok`) — fail closed.
- **Fix in BOTH layers:** `WhatsAppHubPage.tsx` routes the badge through `resolveUnreadCount()`
  (`whatsappUnread.ts`), never `Math.max`. When a backend policy primitive is added, grep the frontend
  for the same arithmetic.

## C. Frontend React defects (Phase 6)

Root-cause class: **per-conversation state in an unkeyed / length-based component.**

- **P6-3 (pill):** "new message" is decided by the identity of the **newest** message, not list length.
  The prepend-restore `useLayoutEffect` clears `isPrependingRef`, and layout effects run before passive
  effects in the same commit → auto-scroll sees the guard gone → spurious pill on every older-page load.
- **P6-4 (viewport):** the hub page MUST render `<ChatThread key={selectedConv.id} …>`. Unkeyed, a switch
  reuses the instance so DOM `scrollTop`/`isNearBottom` carry over. A switch remounts; a *reorder* (same
  id) does not — which the active-chat case needs.
- **P6-5 (composer draft) — CRITICAL:** the composer is also unkeyed, owns the draft in private state,
  and its props carry **no conversation identifier at all** → text typed in chat A is delivered to B.
  Fixed with `key={selectedConv.id}`. A key beats a reset effect: there is no prop to watch. Second call
  site **VERIFIED NOT AFFECTED** (`LeadDetailDrawer.tsx:321/340` — `Drawer.tsx:52` returns null when
  closed). Check EVERY sibling in the pane before claiming a bug.
- **P6-6 ONE canonical merge.** Live WS must use `mergeWhatsAppMessages(prev[convId] || [], [newMsg])`
  — never its own `findIndex`. Only the helper collapses two slots when a later event links both
  identities; an inline match orphans a row → duplicate render + duplicate React key.
  `mergeDeliveryStatus` is status-only.
- **P6-7 `scrollIntoView({behavior:'auto'})` DEFERS TO CSS.** The thread container carries
  `scroll-smooth`, so the initial jump animated from `scrollTop 0` through the `< 60` pagination trigger
  → a spurious older-page fetch per open. Fix: `behavior:'instant'` + `initialScrollDoneRef`.
  **jsdom cannot see this** — the one place browser ≠ jsdom.
- `ChatThread` arms its prepend-restore guard ONLY inside `handleLoadOlder`; an older page must arrive
  via the `onLoadOlder` prop.

## D. Dedup and uniqueness

- **D1 `messages` (C-4):** `wa_message_id` nullable, single-column index non-unique. Guard is
  `uq_msg_conv_wa_message_id` = `UNIQUE (conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL`
  — conversation-scoped on purpose (LID→PN re-keying merges via `reconcile_legacy_split_conversation`;
  a global index would be wrong). Declared byte-identical in `models/message.py` AND `migrations.py`
  (existence check matches on name only). Migration REFUSES on duplicates (`[MIGRATION][BLOCKED]`).
  `ingest_gateway_event` catches `IntegrityError` at commit and drops the loser.
- **D2 Conversation uniqueness — SOLVED, do not re-add.** `uq_conv_user_session_contact_channel
  (user_id, session_id, contact_id, channel)` in `Conversation.__table_args__`, created by
  `ensure_conversations_columns` (main.py:111). NULL `session_id` rows coexist intentionally. An asyncio
  lock does NOT close check-then-create (different DB sessions) — the guard is the constraint +
  `_ensure_conversation_race_safe` (IntegrityError → rollback → re-resolve → retry). No upserts.
- **D3 History evidence (Phase 17):** `history_sync_states.session_id` is TEXT holding the **gateway
  UUID**, not the integer `Conversation.session_id` — resolve via `_conversation_gateway_id()`. Cache
  hits never mutate evidence; timeout/error evidence commits BEFORE the exception; exhaustion is
  two-step (`EXHAUSTION_CANDIDATE` → `FULLY_EXHAUSTED`); cursor is
  `(wa_message_id, from_me, timestamp_ms)`. Keep `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED=false`.

## E. Tenant isolation (G-3 — CLOSED)

Safe unscoped reads only for synthetic globally-unique keys. `processed_events.event_id` SAFE;
`lid_mappings.lid_jid` and `history_sync_states.jid` LEAK (natural keys repeat across tenants).

Route (`gateway_sessions` has NO `user_id`): `lid_mappings.session_id` → `gateway_sessions.session_id` →
`whatsapp_sessions.gateway_id` → `whatsapp_sessions.user_id`. Order: own session → same user's other
session → never another user. Orphans readable by nobody. Resolver `repositories/lid_mappings.py`.
**Never `get_user_filter`** here (matches `IS NULL` under pytest). Gateway: `lidScopeSessionIds()`.
Legitimately global, do NOT "fix": admin aggregates, `recovery.py:118` orphan scan, gateway
`listRestorableSessions`/`claimPending`/`socket_leases`. `get_history_evidence` REQUIRES `session_id`.

**Owner resolution refuses when ambiguous.** An event carrying no `session_id` (only a
`conversation_id`) resolves its owner from the jid and **fails closed if >1 session matches** —
`Gateway olayi sahibi cozulemedi, atlandi (… bagli tenant sayisi=N)`, `ingest_gateway_event` → `None`.
Correct behaviour; also why the backend suite is DB-state sensitive (see H).

## F. Gateway / provider contracts

- **F1 Outbound media (P5-1):** `buildMediaContent()` (`session-manager.js`) is the single builder.
  Baileys `getStream()` accepts only `Buffer | {stream} | {url: string|URL}`. **Never wrap a Buffer in
  `{url}`** → `createReadStream(<Buffer>)` → `ERR_INVALID_ARG_VALUE`. `mimetype` is a SIBLING of
  `image`/`video`/`audio`/`document`, never nested.
- **F2 Truthfulness is load-bearing in the gateway too.** Provider ops fail closed. Delivery ranks
  `PENDING:0, FAILED:0, SENT:1, DELIVERED:2, READ:3`, strictly-greater advance only.
- **F3** `ws_manager.broadcast` param is `target_user_id` (not `tenant_id`) — a wrong kwarg raises
  `TypeError`, easy to swallow in a broad `except`. Never log a broadcast failure at `debug`.

## G. Pairing — ephemeral lifecycle (Phase 6.4/6.5)

- **No-Create lifecycle:** zero `public.whatsapp_sessions` rows until the QR is scanned and the
  connection opens. The ephemeral pairing lives in the in-memory registry `_ephemeral_pairings`, keyed
  by `pair_token` (UUID). Promotion to a real row is atomic (`perform_atomic_relink`).
- **S-2 invariant:** a candidate phone must never be persisted before successful pairing — registry only.
- **P6-8 (FIXED):** a *new* pairing has no DB session id, so the id-addressed code endpoint could never
  serve it and "Kod Al" was a silent no-op that also re-fired `startPairing`. Fix: owner-scoped
  `POST /whatsapp/pairing/{pair_token}/pair` → `request_pairing_code_for_token`.
- **P6-9 (FIXED):** `_map_session_event` resolved the owner from a DB row, and the relink branch fires
  only for `session_connected`; so `session_qr_updated` for an ephemeral pairing raised
  `EventOwnerUnresolved` → `ingest_gateway_event` returned `None` → `main.py` counted it `skipped` and
  never broadcast (Case A). Fix: resolve the owner from `_ephemeral_pairings` by gateway id — **owner
  association, NEVER a global broadcast** (would regress G-3). The `bf6b0ce` diff is **24 insertions,
  0 deletions**: purely additive, it did not alter the `message_new` path.
- **QR delivery is DUAL-PATH:** 2.5 s polling of `GET /pairing/{token}/qr` **and** the
  `session_qr_updated` event. The real gateway payload keys are exactly
  `['event','gateway_session_id','qr_code','session_id']` — **no `session_name`**. Polling worked before
  and after 6.4; only the event path was fixed.
- **§12 single-flight:** `pairingCodeInFlight` map in `session-manager.js`; `pairingInFlightRef` in
  `WhatsAppQrConnectModal.tsx`. **ARM AN IN-FLIGHT REF ONLY INSIDE A `try` WHOSE `finally` RELEASES
  IT** — an early `return` between arm and release latches the guard forever. The two guards are
  separate refs and must stay mode-aware.
- `normalizePairingPhone` (gateway) is the ONLY normalizer — React must forward the RAW phone.
  `+90…`/`90…`/`0090…`/`0541…` → `905413749073`; it must NOT rewrite `+1…`/`0055…`.
- **G-LEASE (the real QR killer — fixed Phase 6.5).** `_connectSocket` skips
  `leaseRepository.acquire()` for an ephemeral pairing (`leaseRepository && !session.ephemeral`) — the
  lease belongs to the *persistent* session a completed pairing is promoted into, taken only on connect.
  The renewal timer, however, was armed with a bare `if (leaseRepository)`, so it ran for sessions
  holding **no `socket_leases` row**: the first tick's `renew()` hit `return result.rowCount === 1` →
  `false` → `loseLease()` → `status='UNAVAILABLE'`, `error_message='WHATSAPP_SESSION_LEASE_LOST'`,
  socket torn down. Interval is `max(10_000, TTL/3)`; at the production TTL of 45 s that is **15 s**,
  i.e. the pairing died ~15 s after its socket opened, **before any QR**. Fix: `armLeaseRenewal()` is a
  named function armed only where a lease is held — `if (!session.ephemeral) armLeaseRenewal()` at
  attach, and from the promotion branch immediately after `acquire()` succeeds. Guarding the arming
  *alone* is **incomplete**: a session ephemeral at attach would then hold its promotion lease with
  nothing renewing it (silent expiry → split-brain). Present on BOTH `f6ec68d` and `c512755`; **not** a
  Phase 6.4 regression. Guard: `scripts/test-phase6-5-ephemeral-lease.mjs`.
- **Real FK (found 2026-09-19):** `socket_leases.session_id → whatsapp_private.gateway_sessions(session_id)`.
  `acquire` (INSERT) fails **23503** for a session with no `gateway_sessions` row; `renew` (UPDATE) is a
  silent no-op returning `rowCount 0`. This is why G-LEASE surfaced as a *silent* lease loss.
  Real-PG guard: `scripts/test-phase6-6-lease-real-pg.mjs` (7 checks, needs `GATEWAY_LEASE_TEST_URL`).
- **G-PROMOTION-SINGLE-WRITER (fixed 2026-09-26): the durable `public.whatsapp_sessions` row has exactly
  ONE writer — `promote_ephemeral_pairing`.** `GET /pairing/{token}/qr` must NEVER relink, reuse or INSERT;
  on a gateway `CONNECTED` it delegates (lazy import, the same pattern `cancel_pairing_session` uses).
  It used to hand-roll the sequence, making it a **second writer** for the same `gateway_id`; the
  event-driven promotion fires on the very same `connection.open`, so both read "no row yet" and then
  wrote, and the poll died on `ix_whatsapp_sessions_gateway_id`. Live **2026-09-26 11:43:56 UTC**: the poll
  returned **502** (`UniqueViolationError … Key (gateway_id)=(f157eca0-…) already exists`) while promotion
  committed session 87 for that same gateway id **7 ms later** — i.e. the pairing had SUCCEEDED and the
  modal showed a false failure. The hand-rolled branches logged **zero** hits in 7 days, and its rebind
  branch contradicted promotion.py's own documented invariant ("a session already CONNECTED under a
  different gateway id is never overwritten"). A refusal now raises `PairingPromotionRefused` → **409**,
  never 502. Guards: `test_p68_qr_poll_survives_concurrent_promotion`,
  `test_p68_qr_poll_refusal_is_409_not_502`.
- **Two writers on one unique key is the generalisable lesson.** Whenever two code paths can both INSERT a
  row guarded by a unique index (here `gateway_id`), the loser must **roll back and adopt** the winner's
  row, never surface the IntegrityError. Check BOTH writers when only one has the try/except.

## H. Test baselines (procedural detail → the skills)

- **Backend `pytest backend/tests -q` → 1089 passed, 4 skipped** (`c512755`). The 4 skips are the live
  QR-seam tests (no `WHATSAPP_LIVE_GATEWAY_URL`). Scope matters: `pytest backend -q` also collects
  `backend/scripts/test_staging_playwright_auth.py`, a manual staging script with no
  `@pytest.mark.asyncio` — fails at setup on a clean checkout too. Use `backend/tests`.
  - **⚠️ Only green against a DB with no other `whatsapp_sessions` rows.** The suite runs against the
    local `tezlify.db`; leftover dev sessions (`local-test`, `Q-walk`) make owner resolution ambiguous
    for events without a `session_id`, producing **28 spurious failures** that look exactly like a
    regression. Never mutate the real DB — copy it and point `DATABASE_URL` at the copy
    (`sqlite+aiosqlite:////tmp/<copy>.db`) after deleting `whatsapp_sessions` rows.
- **Gateway 21/21** (`node whatsapp-gateway/scripts/test-*.mjs`).
- **Frontend:** `tsc --noEmit` 0; `npm run build` ok; `verify:logic` **43**; `verify:dom` **20**;
  `verify:merge` + `verify:merge-equivalence` PASS; `verify:browser` **7/7**; `verify:pairing` **8**;
  `verify:pairing-browser` **12/12**. No vitest/jest.
- **Gotchas that silently invalidate a run** (full detail in the skills):
  `esbuild-frontend-verification` · `real-browser-cdp-verification` ·
  `hermetic-service-process-harness` · `asymmetric-resource-guard-detection`.
  - `--import <loader>` only LOADS a module; a resolve hook must `register()`. A "fake" gateway then
    talks to real WhatsApp while looking hermetic — prove the double with a trace flag.
  - A process can print `listening on …` and still not serve; verify via its OWN log, not the port.
  - Two harnesses built before any socket exists share a cursor → the same socket for both.
  - Clear `"$TMPDIR"pytest-of-root`/`pytest-of-unknown` before pytest reruns.
  - `ingest_gateway_event` needs `event_id` to be a real UUID — a non-UUID returns `None` SILENTLY.
  - Cleaning test tenants: delete BOTH uuid forms (dashed + hex), children first — the `_cleanup`
    fixtures compare against the **hex** form because `user_id` is `CHAR(32)`.
  - `processed_events` dedup is PostgreSQL-only. Module globals keyed by DB ids break test order
    (SQLite REUSES ids) → autouse `reset_whatsapp_module_globals`.
  - **Falsification control:** break the invariant, see it fail, restore. Delayed provider: block on an
    `asyncio.Event`. Cross-layer: `main.py:319` broadcasts exactly the dict
    `ingest_gateway_event` returns — no WS mock needed.

## I. Production topology

- Host `130.162.247.20` (hostname `tezlify-oracle` does NOT resolve from this shell), Oracle Always Free.
  Repo `/opt/tezlify`. Containers `tezlify-gateway`, `-backend`, `-caddy`, `-db` (postgres:17-alpine).
  SSH user **`ubuntu`**, key `~/.ssh/id_tezlify_oracle` (`opc` rejected).
- **Read-only pattern:** `ssh … "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on'
  tezlify-db psql -U tezlify -d tezlify"`; assert `SHOW default_transaction_read_only;` → `on`.
- **Deploy gap:** production `f6ec68d`; local HEAD is `5f8d25d` (Phase 6.5 committed + pushed
  2026-09-19). Production lacks C-4, G-3, P5-1/2/3, P6-1…P6-9 **and the G-LEASE fix**.
  **Local test results and production health are different claims — never conflate them.** Pushing is
  not deploying.
- **Production symptom measured 2026-09-19 (read-only):** 5 gateway sessions — 1 `CONNECTED`, **4
  `UNAVAILABLE` with `WHATSAPP_SESSION_LEASE_LOST`**; `socket_leases` held **1** row (the CONNECTED
  session only); **4 × `socket_lease_lost`, 0 × `session_qr_updated`**; `socket_connect_started` →
  `socket_lease_lost` gaps of **15040 / 15058 / 15042 ms** = exactly one 15 s renewal interval.

## J. Known-open — need a decision, do not silently "fix"

- **New Chat** (`startConversation`) is an unconditional `throw` — `PRODUCT DECISION` (F-5).
- Background sweep promotes `FULLY_EXHAUSTED` from a single provider call — fix before enabling the
  flag. Production has 10 such rows (4 with no provider evidence); pre-existing.
- P5-1 has no live end-to-end confirmation: one media send to a self-owned number after deploy.
- `jsdom` is a new devDependency — deliberate, needs review.
- **Monitoring cannot see a session die holding no lease.** Evaluator is
  `scripts/whatsapp_reliability_collector.py` (the backend only *displays* `current.json` —
  `monitoring_admin_service.py:163`). `R5: leases <= max(1, conn_count)` and `R6: leases == conn_count`
  both PASS with 1 connected session + 1 lease while pairings die, because the dead pairings hold
  **zero** leases (R5 asks "more than one?", R6 asks "orphan?"). R12 passes because the *process* is
  healthy — no per-session dimension. The collector already gathers
  `whatsapp_sessions.by_status` (includes `UNAVAILABLE`) but no invariant consumes it. Recommended,
  **not implemented**: an invariant over `by_status` and/or alerting on `socket_lease_lost`. The
  G-LEASE fix keeps R6 green during a normal pairing, so such a rule fires only on the real failure.
- **Phase 6.5 outcome (RESOLVED, two parts).** (1) "Which 6.4 commit broke QR?" — **none**; QR
  availability passes at all six revisions `ce68359`→`c512755`, and the phone pairing code is what went
  `FAIL → PASS` (at `0c497b1`). (2) "Why was QR pairing dead in production?" — **G-LEASE**, proven by
  code + production DB + production logs, fixed locally with a fail→pass test.
  **Committed and pushed as `5f8d25d`** (user lifted the §19 hold on 2026-09-19). Production still runs
  the broken `f6ec68d`, so **QR pairing remains broken for real users until a deploy** — a push is not
  a deploy.
- **Asymmetric-guard sweep (2026-09-19): the lease renewal was the ONLY instance of the class.**
  `session-manager.js` has one resource-guarded timer; `events.js:250/252` guard on the
  constructor-injected `eventOutbox`; the backend has no lease lifecycle at all.
  `_conversation_locks` (`repositories/conversations.py:16`) is an unbounded `Dict[(user_id, conv_id),
  asyncio.Lock]` — a *different* class (unbounded cache), intentional.
- **No live-device pairing was ever run** — QR and phone-code are verified against a faked network
  boundary only. Report `LIVE DEVICE E2E = NOT RUN`; never imply otherwise.

## K. Archive state — "unknown" must never be written as `false`

**The backend contract is "omit the key, don't assert a value."** All three write sites guard on key
presence — `events.py:1104` (`if "archived" in payload:`), `sync.py:985` and `sync.py:1847`
(`if "archived" in item:`). So the backend already preserves its stored `is_archived` when the gateway
says nothing. **The gateway used to violate this in all four writers** (`socket-events.js:575,695`,
`session-manager.js:1305,1489` — `?? false` / a hardcoded `false`), which made the backend's guard a
**dead guard** and asserted `false` for chats the gateway knew nothing about. Live proof 2026-09-26:
`has_archived_key=112` of 112 chats, 111 of them `false`.

- **Archive state can ONLY arrive via app-state, never via history sync.** `Utils/history.js` in
  Baileys has **no `archived` mapping at all**. So the sole source is `processSyncAction` →
  `chats.update` (`chat-utils.js:694`).
- **On an initial sync that update is conditional and can be swallowed forever.** `chats.js:998` calls
  `resyncAppState(ALL_WA_PATCH_NAMES, true)`. `getChatUpdateConditional` (`chat-utils.js:856`) returns a
  condition **only when `isInitialSync`**, and that condition returns `undefined` when the chat is absent
  from `historySets.chats`/`chatUpserts`. `event-buffer.js` `append()` (`conditionMatches === undefined`)
  parks the update in `chatUpdates`; `flush()` moves it into `newData` and **never emits it** — carried
  indefinitely. Chats with no history payload (large / zero-message groups) therefore never deliver their
  archive state. Live: `resyncing regular from v0` **6× in 72 h**, each one a full snapshot with
  `isInitialSync=true`.
- **Consequence of the `?? false` default: a restart silently wipes known archive state.** The gateway's
  `chats` store is memory-only (see A6). After a restart the store is empty, so the next history pass sees
  `existing.archived === undefined` and used to emit `archived: false` for a chat the DB held as `true`.
- **Fix:** `archivedPatch(known)` in `utils/whatsapp-formatting.js` — returns `{}` when unknown (so
  `JSON.stringify` drops the key and the backend's guard fires) and `{archived: Boolean(known)}` when
  known, so an explicit **unarchive still propagates**. Guard:
  `whatsapp-gateway/scripts/test-archive-state-contract.mjs` (8 checks; H is structural — no source line
  may reintroduce `archived ... ?? false`).
- **Honest limit — this stops future loss, it does NOT recover the 111 already-lost chats** (the gateway
  never learned them). Recovery needs a re-delivery of app state: zero the `regular` collection's
  `app-state-sync-version` and call `resyncAppState(ALL_WA_PATCH_NAMES, false)` (version 0 ⇒ the server
  sends a full snapshot; `isInitialSync=false` ⇒ the condition is `undefined` ⇒ archive updates are
  released unconditionally). **Side effect:** every app-state mutation re-fires, and read chats emit
  `unreadCount: 0` — unread badges can be cleared. Hence a **product decision**, not a silent fix. The
  zero-risk alternative: have the user re-archive the affected chats (that path is now durable, because
  non-initial-sync mutations are unconditional).
- **Live 2026-09-26:** prod DB `111 false + 1 true`; the gateway's own store agrees (1 of 112). Symptom
  seen from both sides: archived chats appear in the "All" tab *and* are missing from "Archived" — one
  root cause, two faces. The frontend tab logic (`ConversationList.tsx:216-228`) was already correct;
  do not "fix" it.


## L. Initial-sync message coverage — the watermark is global, the filter is per-chat

- **`since` is a GLOBAL watermark applied PER CHAT — that combination creates permanent holes.**
  `_run_bulk_message_sync` passes `since = get_sync_watermark_epoch(...)` = the owner's newest INBOUND
  `external_timestamp` − 300 s. The gateway applies it inside its per-chat loop
  (`session-manager.js` `listAllMessages`). So every chat whose newest message predates the cutoff
  returns **zero** messages. A chat that ended up with zero local rows — e.g. the gateway's memory-only
  store did not hold it at first-sync time (A6) — can then **never** be recovered by a later sync,
  because the watermark only moves forward.
  **Live 2026-09-26:** 112 conversations, **19 with 0 message rows**, and all 19 had `last_message_at`
  older than the cutoff (2026-01-26 … 2026-08-27 vs a 2026-09-26 11:49:50 cutoff). `zero_older_than_cutoff = 19`.

- **The provider CANNOT fill that hole — `NO_ANCHOR`.** Verified live: for a chat with no message
  anywhere, `GET /conversations/{jid}/messages?fetch_provider=true` returns
  **`provider_status=NO_ANCHOR`, 0 messages, ~3 ms** (no network round-trip). `requestOlderHistory`
  (`session-manager.js:584`) feeds WhatsApp's `fetchMessageHistory`, which pages **backwards from a known
  message key**; with no message there is no anchor. 13 of the 19 prod chats are in exactly this state —
  only a phone-side history sync can supply them, and that is not under our control. The other 6 *are* in
  gateway memory, and for those a provider call would spend a real anchored round-trip merely to hand back
  data we already had. **Do not "fix" an empty conversation by asking the provider.**

- **The recovery path is a scoped, watermark-free bulk read.** The `backfill` stage re-reads the bulk
  channel with `since=None` and `jids=<only the empty chats>`; no provider contact at all. New surface:
  gateway `listAllMessages({jids})` + `/messages/bulk?jids=` (comma-separated), backend
  `list_all_messages(jids=...)`, and `_run_bulk_message_sync(recovery_pass, only_conv_ids)` where
  `recovery_pass` also means "do not overwrite `job.messages_total`".
  `only_conv_ids` → the jid list is derived from the pass's own `conv_by_jid`, so **LID aliases are
  covered** — the store may key a chat by either its phone jid or its LID, and matching on the phone jid
  alone would silently miss the LID-keyed ones.

- **The stage's precondition is CHANNEL availability, never "did we insert rows".** Gating on
  `job.messages_synced` looks natural and is wrong: an ordinary incremental sync that inserts nothing new
  still leaves genuinely empty conversations in need of recovery, so that gate disables the stage exactly
  when it matters. The call site checks `_bulk_channel_available(gateway_id)` once and uses it for both
  the main pass and the recovery pass. §21 ("the initial sync must not issue a request per chat") is
  preserved: the recovery pass is one scoped bulk call, never N per-chat calls.

- **`_get_helper(name, fallback)` prefers the SERVICE attribute over the orchestrator's own method.**
  `whatsapp_service` therefore carries same-named shims that shadow orchestrator methods, and a shim whose
  signature has drifted fails only at runtime, only on the code path that reaches it:
  `TypeError: unexpected keyword argument`. Two such bugs existed (both fixed 2026-09-26):
  `_sync_conversations_impl` did not accept `session=` — so **the legacy no-bulk-channel sync failed
  outright**, and it was already broken at HEAD; and `_run_bulk_message_sync` did not forward
  `recovery_pass`/`only_conv_ids`. When adding a parameter to an orchestrator method, grep for a shim of
  the same name and mirror the signature exactly.
