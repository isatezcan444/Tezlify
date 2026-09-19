# Tezlify — Project Memory (curated, long-term)

All entries verified against source or a read-only production query. Follow them; do not "fix" code
that satisfies them.

## A. Identity, ordering, payload contract

- **A1. Identity authority:** `resolve_contact_identity()` (`services/whatsapp/identity.py`) owns
  display name / phone / identity_state. `NAME_RANK = {addressbook:5, verified:4, group_subject:4,
  history:3, push:2, phone:1}`. `name_source=="push"` = counterparty's own WA profile name — never a
  stranger's display name (show `+90...`); store in `custom_attributes["push_name"]`, never
  `display_name`. `_set_contact_name` won't overwrite at `current_rank > 2`, and `2 > 2` is False, so
  it can't clear push pollution → **guard at the writer**.
- **A2. REST/WS canonical payload ("I-3" class):** both transports use the same field names —
  `session_id, contact_id, lead_id, name, phone, identity_state, is_group, is_archived, avatar_url,
  last_message_preview, last_message_at, created_at, updated_at, unread_count, status`. **Never
  `lead_phone`.** `mapConversation` copies a field only when present: merge is `{...existing,
  ...mapped}`, so explicit `undefined` ERASES known state ("Kişi kimliği çözülüyor…").
- **A3. `identity != ordering`.** Sort = activity only: `last_message_at` → `created_at` → `id`.
  Contact existence / identity state / name+phone presence never affect sort. Message-less
  conversations sort last.

## B. Unread badge — one policy, two places (P5-2/3, P6-1/2)

The gateway **owns** `unread_count` and reports DECREASES (read on phone → 0), so monotonic
`max(local, incoming)` is always wrong.

- Authority: `should_apply_unread_count()` (`preview_normalization.py`) via
  `apply_conversation_unread_count()` (`repositories/conversations.py`).
- **Staleness guard must be SYMMETRIC** (`inc_ts < cur_ts` blocks both directions). Anchoring only on
  `last_read_at` is not enough — an EXTERNAL read never sets it (P6-1).
- **P6-2: an authoritative drop to 0 IS read evidence** → stamp `last_read_at = last_message_at`. An
  external read changes neither field, so a same-ts snapshot was evidence-identical and resurrected
  the badge (8→0→8). Not `utcnow()`: wall-clock now is newer than every provider ts and blocks all
  later raises. Do NOT require "a raise needs strictly newer activity" (`inc_ts <= cur_ts`) — broke 3
  tests; a snapshot legitimately reporting the full count (0→5, 1→7) at an unchanged ts is normal.
  Discriminator is READ EVIDENCE, not value+ts.
- `mark_conversation_read()` writes only inside the success path (`gateway_ok`) — fail closed. The
  `conversation_read` handler must stamp `last_read_at` or the guard has nothing to compare.
- **Fix in BOTH layers:** `WhatsAppHubPage.tsx` routes the badge through `resolveUnreadCount()`
  (`whatsappUnread.ts`), never `Math.max`. Rule: when a backend policy primitive is added, grep the
  frontend for the same arithmetic.

## C. Frontend React defects (Phase 6)

Root cause class: **per-conversation state in an unkeyed / length-based component**.

- **P6-3 (pill):** "new message" is decided by the identity of the **newest** message, not list
  length. The prepend-restore `useLayoutEffect` clears `isPrependingRef`, and layout effects run
  before passive effects in the same commit, so auto-scroll sees the guard gone → spurious pill on
  every older-page load.
- **P6-4 (viewport):** hub page MUST render `<ChatThread key={selectedConv.id} …>`. Unkeyed, a switch
  reuses the instance so DOM `scrollTop`/`isNearBottom` carry over and the new chat opens mid-history.
  A switch remounts; a *reorder* (same id) does not — which the active-chat case needs.
- **P6-5 (composer draft) — CRITICAL:** composer also unkeyed, owns the draft in private state, and
  its props carry **no conversation identifier at all** → text typed in chat A is delivered to B.
  Fixed with `key={selectedConv.id}`. A key beats a reset effect: there is no prop to watch.
- Second call site **VERIFIED NOT AFFECTED:** `LeadDetailDrawer.tsx:321/340` — `Drawer.tsx:52` returns
  null when closed, `:66-67` backdrop `onClose` means `lead` can't change while open, `:188` gates
  chat on `activeTab==='chat'`. Lesson: check EVERY sibling in the pane before claiming a bug.
- **P6-6: ONE canonical merge.** Live WS must use `mergeWhatsAppMessages(prev[convId] || [], [newMsg])`
  — never its own `findIndex`. Only the helper collapses two slots when a later event links both
  identities (optimistic `C1` + echo `W1` + later `C1`+`W1`); an inline match orphans a row → sent
  message renders twice with a duplicate React key. `mergeDeliveryStatus` is status-only.
- **P6-7: `scrollIntoView({behavior:'auto'})` DEFERS TO CSS.** The thread container carries
  `scroll-smooth`, so the initial jump animated from `scrollTop 0` through the `< 60` pagination
  trigger → a spurious older-page fetch per open, whose prepend-restore then knocked the viewport off
  the newest message (defeated P6-4 in production). Fix: `behavior:'instant'` + `initialScrollDoneRef`.
  **jsdom cannot see this** — the one place browser ≠ jsdom.
- `ChatThread` arms its prepend-restore guard ONLY inside `handleLoadOlder`, so an older page must
  arrive via the `onLoadOlder` prop; mutating the array directly gets no restore.

## D. Dedup and uniqueness

- **D1. `messages` (C-4):** `wa_message_id` nullable, single-column index non-unique. Guard is
  `uq_msg_conv_wa_message_id` = `UNIQUE (conversation_id, wa_message_id) WHERE wa_message_id IS NOT
  NULL` — conversation-scoped on purpose (LID→PN re-keying merges via
  `reconcile_legacy_split_conversation`; a global index would be wrong). Declared byte-identical in
  `models/message.py` AND `migrations.py` (existence check matches on name only). Migration REFUSES on
  duplicates (`[MIGRATION][BLOCKED]`). `ingest_gateway_event` catches `IntegrityError` at commit and
  drops the loser (re-broadcast = duplicate event storm).
- **D2. Conversation uniqueness — SOLVED, do not re-add.**
  `uq_conv_user_session_contact_channel (user_id, session_id, contact_id, channel)` in
  `Conversation.__table_args__`, created by `ensure_conversations_columns` (main.py:111), present in
  production (0 dup groups). NULL `session_id` rows coexist intentionally. An asyncio lock does NOT
  close check-then-create (different DB sessions) — the real guard is the constraint +
  `_ensure_conversation_race_safe` (IntegrityError → rollback → re-resolve → retry). No upserts.
- **D3. History evidence (Phase 17):** `whatsapp_private.history_sync_states.session_id` is TEXT
  holding the **gateway UUID**, not the integer `Conversation.session_id` — resolve via
  `_conversation_gateway_id()`. Cache hits never mutate evidence; timeout/error evidence commits
  BEFORE the exception; exhaustion is two-step (`EXHAUSTION_CANDIDATE` → `FULLY_EXHAUSTED`); cursor is
  `(wa_message_id, from_me, timestamp_ms)`, never the auto-increment id. Keep
  `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED=false`.

## E. Tenant isolation (G-3 — CLOSED)

Safe unscoped reads only for synthetic globally-unique keys. `processed_events.event_id` SAFE;
`lid_mappings.lid_jid` and `history_sync_states.jid` LEAK (natural keys repeat across tenants).

Route (`gateway_sessions` has NO `user_id`): `lid_mappings.session_id` → `gateway_sessions.session_id`
→ `whatsapp_sessions.gateway_id` → `whatsapp_sessions.user_id`. Order: own session → same user's other
session → never another user. Orphans readable by nobody. Resolver: `repositories/lid_mappings.py`.
**Never `get_user_filter`** here (matches `IS NULL` under pytest). Gateway: `lidScopeSessionIds()`.
Legitimately global, do NOT "fix": admin aggregates, `recovery.py:118` orphan scan, gateway
`listRestorableSessions`/`claimPending`/`socket_leases`. `get_history_evidence` REQUIRES `session_id`
(fail-closed `NOT_CHECKED`).

## F. Gateway / provider contracts

- **F1. Outbound media (P5-1):** `buildMediaContent()` (`session-manager.js`) is the single builder.
  Baileys `getStream()` accepts only `Buffer | {stream} | {url: string|URL}`. **Never wrap a Buffer in
  `{url}`** → `createReadStream(<Buffer>)` → `ERR_INVALID_ARG_VALUE`. `mimetype` is a SIBLING of
  `image`/`video`/`audio`/`document`, never nested.
- **F2. Truthfulness is load-bearing in the gateway too.** Provider ops fail closed. Delivery ranks
  `PENDING:0, FAILED:0, SENT:1, DELIVERED:2, READ:3`, strictly-greater advance only.
- **F3.** `ws_manager.broadcast` param is `target_user_id` (not `tenant_id`) — wrong kwarg raises
  `TypeError`, easy to swallow in a broad `except`. Never log a broadcast failure at `debug`.

## G. Pairing (Phase 6.4) — ephemeral lifecycle

- **No-Create lifecycle:** zero `public.whatsapp_sessions` rows until the QR is scanned and the
  connection opens. Ephemeral pairing lives in the in-memory registry `_ephemeral_pairings`, keyed by
  `pair_token` (UUID). Promotion to a real row is atomic (`perform_atomic_relink`).
- **S-2 invariant:** a candidate phone must never be persisted before successful pairing — record it
  only in the registry.
- **P6-8 (FIXED):** a *new* pairing has no DB session id, so the id-addressed code endpoint could never
  serve it and "Kod Al" was a silent no-op that also re-fired `startPairing`. Fix: owner-scoped
  `POST /whatsapp/pairing/{pair_token}/pair` → `request_pairing_code_for_token`.
- **P6-9 (FIXED):** `_map_session_event` resolves the owner from a DB row, and the relink branch fires
  only for `session_connected`; so `session_qr_updated` for an ephemeral pairing raised
  `EventOwnerUnresolved` → `ingest_gateway_event` returned `None` → `main.py` counted it `skipped` and
  never broadcast (Case A). Fix: resolve owner from `_ephemeral_pairings` by gateway id — **owner
  association, NEVER a global broadcast** (would regress G-3).
- **§12 single-flight:** `pairingCodeInFlight` map in `session-manager.js`; `pairingInFlightRef` in
  `WhatsAppQrConnectModal.tsx`. Concurrent requests collapse to one provider call.
  **ARM AN IN-FLIGHT REF ONLY INSIDE A `try` WHOSE `finally` RELEASES IT.** An early `return`
  between the arm and the release latches the guard forever — one failed `initSession()` would
  have killed "Kod Al" permanently. Audit every early return in such a function.
- `normalizePairingPhone` (gateway) is correct and is the ONLY normalizer — React must forward the RAW
  phone. `+90…`/`90…`/`0090…`/`0541…` → `905413749073`; it must NOT rewrite `+1…`/`0055…`.

## H. Test baselines and harness

- **Backend `pytest backend/tests -q` → 1088 passed** (2026-09-19, after P6-8/P6-9 fixes). Scope
  matters: `pytest backend -q` also collects `backend/scripts/test_staging_playwright_auth.py`, a
  manual staging script with no `@pytest.mark.asyncio` — fails at setup on a clean checkout too.
- **Gateway 19/19** (`node whatsapp-gateway/scripts/test-*.mjs`), +7 in `test-pairing-lifecycle.mjs`.
- **Frontend:** `npx tsc --noEmit` 0; `npm run build` ok; `verify:logic` → **43**; `verify:dom` →
  **20**; `verify:merge` + `verify:merge-equivalence` → PASS; `verify:browser` → **7/7**. No
  vitest/jest — see the `esbuild-frontend-verification` skill.
- **Real browser harness (`npm run verify:browser`).** No Playwright/e2e installed: drives installed
  Google Chrome over CDP using **Node's built-in WebSocket**, serving real components bundled into
  `os.tmpdir()` with the real built CSS from `dist/assets/*.css`.
  - Chrome needs **`--no-sandbox`** here (its own sandbox fails → GPU/network die → CDP never
    replies). Also `--disable-dev-shm-usage --disable-software-rasterizer`.
  - Connect to a `/json/list` **page** target's `webSocketDebuggerUrl`, not `/json/version`
    (browser-level endpoint lacks Page/Runtime: `'Page.enable' wasn't found`).
  - Tailwind CSS is mandatory or `flex-1`/`overflow-y-auto` are inert → nothing scrolls.
  - esbuild must `define` `import.meta.env` (`whatsappLatency.ts` reads `import.meta.env.DEV`).
  - Backticks inside the entry-source template literal silently terminate it — never use them there.
  - `scroll-behavior: smooth` animates `el.scrollTop = x`; use `scrollTo({top,behavior:'instant'})`.
  - Where jsdom and the browser disagree, **the browser is authoritative**.
- **DOM harness:** jsdom only (one devDependency) + existing esbuild pattern; React 18.3.1 exports
  `act`, no RTL. Renders real `ChatThread`/`ConversationList`/`ChatComposer`/`I18nProvider`.
  - No layout engine (`scrollHeight`=0) → harness installs a box model (uniform ROW_H, fixed
    VIEWPORT, clamped `scrollTop`) on `HTMLElement.prototype` — per-element is too late, React
    effects run inside `act` during the update that creates the node.
  - `pretendToBeVisual` keeps a rAF timer → **process hangs**; always `dom.window.close()` +
    `process.exit(0)`.
  - Node 22: `navigator` is a getter-only global → `Object.defineProperty`; expose `localStorage`,
    `matchMedia`, `ResizeObserver`, `IntersectionObserver`; stub `scrollIntoView`.
  - npm **workspace root**: `npm install` from `frontend/` hoists to ROOT `node_modules`.
  - **Build into `os.tmpdir()`** (crashed runs leave `.tmp-*` in the tree); esbuild needs
    `absWorkingDir: frontendRoot` + `nodePaths` and React **bundled, not external**.
  - Modal uses `createPortal(…, document.body)` → query `document.body`, not the host. Provider order
    is `I18nProvider > ToastProvider` (Toast consumes i18n).
- **Test-infra gotchas.** Module globals keyed by DB ids break test order (SQLite REUSES ids) →
  autouse `reset_whatsapp_module_globals`. Clear `"$TMPDIR"pytest-of-root`/`pytest-of-unknown` before
  reruns (else `PermissionError: EEXIST`). `processed_events` dedup is PostgreSQL-only.
  `ingest_gateway_event` requires `event_id` to be a real UUID — a non-UUID returns `None` SILENTLY and
  looks exactly like a dropped event (this once caused a false "CONFIRMED bug"). Cleaning test
  tenants: delete BOTH uuid forms (dashed + hex) and children before parents.
- **Falsification control:** break the invariant, see it fail, restore. Delayed provider: block on an
  `asyncio.Event`. Cross-layer: `main.py:319` broadcasts exactly the dict `ingest_gateway_event`
  returns — no WS mock needed. `scratch/p6_dump_ws_payloads.py` → `scripts/fixtures/phase6-ws-payloads.json`.

## I. Production topology

- Host `130.162.247.20` (hostname `tezlify-oracle` does NOT resolve from this shell), Oracle Always
  Free. Repo `/opt/tezlify`. Containers `tezlify-gateway`, `-backend`, `-caddy`, `-db`
  (postgres:17-alpine). SSH user **`ubuntu`**, key `~/.ssh/id_tezlify_oracle` (`opc` rejected).
- **Read-only pattern:** `ssh … "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on'
  tezlify-db psql -U tezlify -d tezlify"`; assert `SHOW default_transaction_read_only;` → `on`.
- **Deploy gap:** production `f6ec68d`. All Phase 3–6.4 work is committed locally but **NOT
  deployed**. Production lacks C-4, G-3, P5-1/2/3, P6-1…P6-9. Live: 1832 messages, `RECEIVED 970 /
  SENT 837 / READ 23 / FAILED 2`. **Local test results and production health are different claims —
  never conflate them.**

## J. Known-open — need a decision, do not silently "fix"

- **New Chat** (`startConversation`) is an unconditional `throw` — `PRODUCT DECISION` (F-5).
- Background sweep promotes `FULLY_EXHAUSTED` from a single provider call — fix before enabling the
  flag. Production has 10 such rows (4 with no provider evidence); pre-existing.
- P5-1 has no live end-to-end confirmation: one media send to a self-owned number after deploy.
- `jsdom` is a new devDependency — deliberate, needs review.
- **No live-device pairing was ever run** — QR and phone-code are verified against a faked network
  boundary only. Report `LIVE DEVICE E2E = NOT RUN`; never imply otherwise.
