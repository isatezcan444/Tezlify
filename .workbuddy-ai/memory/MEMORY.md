# Tezlify — Project Memory (curated, long-term)

Every entry verified against source or a read-only production query. Follow them; do not "fix" code
that satisfies them. Procedural harness detail lives in the named skills, not here.

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
  Identity/name/phone presence never affect sort. Message-less conversations sort last.

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
