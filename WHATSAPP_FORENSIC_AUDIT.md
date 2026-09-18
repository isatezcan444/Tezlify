# TEZLIFY WHATSAPP — FORENSIC AUDIT

**Checkout:** `main` @ `f6ec68d` ("fix(whatsapp): isolate stranger push names from address book contacts and conversation identity")
**Working tree at audit start:** clean (`git status --short` → empty)
**Method:** source + test + control-flow verification. Previous reports ("PASS"/"FIXED"/"PRODUCTION READY") were treated as **non-evidence**. Every claim below is anchored to `file:line` and was re-read from this checkout.
**Baseline test run (this checkout):** `975 passed` (backend pytest, 54.8s) — reproduced independently.

---

## 1. CURRENT ARCHITECTURE (verified)

```
WhatsApp phone
    ↓  Baileys (multi-device)
Node Gateway  whatsapp-gateway/src/index.js  (Express + ws, binds 127.0.0.1)
    ↓  createSessionManager()  src/session-manager.js (3363 lines)
       in-RAM session store: contacts / chats / messages / lid maps
    ↓  createEventBridge()  src/events.js  → durable outbox (postgres-event-outbox.js)
    ↓  ws  + token (WHATSAPP_GATEWAY_SECRET)
FastAPI  /ws/gateway  (backend/app/main.py:238-243, fail-closed auth)
    ↓  whatsapp_service.ingest_gateway_event()
WhatsApp public facade  backend/app/services/whatsapp_service.py (909 lines)
    ↓  orchestration/{sessions,messaging,events,sync}.py
    ↓  repositories/{contacts,conversations,messages,sessions}.py
PostgreSQL (public schema + whatsapp_private schema)
    ↓  REST /api/v1/whatsapp/*   +   ws_manager.broadcast() on /ws
React  WhatsAppHubPage → ConversationList / ChatThread / ChatBubble
```

**Layer-by-layer responsibilities (as implemented, not as documented):**

| Layer | Entry point | State | Persistence | Ordering / dedup |
|---|---|---|---|---|
| Baileys | `session.sock` | — | encrypted auth state (AES-256, `GATEWAY_ENCRYPTION_KEY`) | — |
| Gateway session mgr | `createSessionManager()` | `sessions` Map, per-session `store` (contacts/chats/messages), `mediaIndex`, `lidMap` | `whatsapp_private.lid_mappings`, session JSON on disk, media files | `wa_message_id` / `client_message_id` dedup for outbound; ACK rank monotonic (`ACK_RANK`, `_applyMessageAck`) |
| Event bridge | `createEventBridge()` | outbox queue | `postgres-event-outbox` with ACK/NACK + replay | Priority-ordered queue (status/ACK before sync progress) |
| Backend facade | `whatsapp_service.py` | `_in_flight_history_fetches`, `_conversation_locks` | — (no commit/rollback in facade) | — |
| Orchestration | `events.py` / `sync.py` / `messaging.py` / `sessions.py` | job registry (`get_sync_job`) | owns transactions | `processed_events` event-id dedup; `wa_message_id` dedup |
| Repositories | `repositories/*` | — | SQL | unique constraints: `uq_contact_user_phone`, `uq_conv_user_session_contact_channel`, `client_message_id UNIQUE` |
| Realtime | `ws_manager.broadcast(msg, target_user_id)` | per-user socket sets | — | fail-closed: no `user_id` → no broadcast |
| Frontend | `WhatsAppHubPage.tsx` (2400+ lines) | `conversations`, `messagesMap`, `peerTypingMap`, `sessionSync` | `localStorage` (lang) | sort by `compareConversationsByActivityDesc`; dedup by `conversation.id` |

---

## 2. GIT HISTORY FINDINGS

178 commits match `whatsapp`. The WhatsApp subsystem has been rewritten/repatched across ~20 phases (Phase 7 → Phase 17). Recent window (last 6 commits, all 2026-09-18):

| Commit | Subject | Files |
|---|---|---|
| `f6ec68d` | isolate stranger push names from address book contacts and conversation identity | `identity.py`, `sync.py`, `repositories/contacts.py`, gateway `session-manager.js` |
| `d29c227` | advance group and outbound messages to SENT immediately upon successful dispatch | `messaging.py`, gateway `session-manager.js` |
| `190c4c7` | sync disk LID mappings, heal contact phone numbers, filter generic contact names | `whatsapp_service.py`, `ConversationList.tsx`, gateway |
| `65ca54b` | format phone identity by locale, persist Baileys LID mappings | `events.py`, `whatsapp_service.py`, `ConversationList.tsx`, `WhatsAppHubPage.tsx`, gateway |
| `d3a4441` | normalize 10/11 digit TR phone formats, extend payload field resolution | `identity.py`, `ConversationList.tsx` |
| `d1c594f` | handle device indices in JIDs, refine contact identity resolution | `identity.py`, `ConversationList.tsx`, `WhatsAppHubPage.tsx` |

**Findings:**

- **Layered-on-top-of-each-other, not consolidated.** The last six commits are all `fix(...)` touching the *same* three identity surfaces (backend `identity.py`, gateway `mergeContactName`/LID, frontend `ConversationList`). Each added a new guard without removing the previous one. Result: **four independent name/identity resolution implementations** (see §6).
- **The push-name fix is incomplete by construction.** `f6ec68d` hardened `resolve_contact_identity` (`identity.py:244`) and `set_contact_name` (`repositories/contacts.py:76-88`) — but the *new-contact* branch of `_upsert_contact` (`events.py:212-219`) still writes the raw push name into `contact.display_name`. The commit fixed the readers and one writer, and missed the other writer. This is exactly the "report says FIXED but the old path is still active" pattern.
- **`safe_display_name` was never updated.** `identity.py:106-119` returns `contact.display_name` without consulting `name_source`, so every consumer of `safe_display_name` (notably the sync WS snapshot builder) still leaks push names.
- **A helper exists that would have prevented the pagination bug and is dead.** `_conversation_gateway_id` is imported at `whatsapp_service.py:81` and **never used anywhere** (`grep` confirms zero call sites). It is precisely the correct resolver for the `history_sync_states` session key (§10).
- **Test counts in prior reports (975 / 967 / 970) are not reproducible as a set.** This checkout yields exactly **975 passed**. Prior reports citing 967/970 were from other checkouts.

---

## 3. EXISTING IMPLEMENTED CHANGES (what is actually there)

| Subsystem | Mechanism | Verdict |
|---|---|---|
| Name precedence | `NAME_RANK = {addressbook:5, verified:4, group_subject:4, history:3, push:2, phone:1}` — `identity.py:13-20` | ✅ present and applied in `set_contact_name` |
| Push-name isolation (read path) | `resolve_contact_identity` skips `name_source == "push"` — `identity.py:244` | ✅ present |
| Push-name isolation (write path) | `set_contact_name` stores push into `custom_attributes.push_name` only — `contacts.py:76-88` | ✅ present |
| Push-name isolation (contact-create path) | `_upsert_contact` new-contact branch | ❌ **MISSING** — writes push into `display_name` |
| Degenerate JID guard | `is_degenerate_jid`, `jid_to_phone` — `identity.py:44,49-60` | ✅ present |
| LID persistence | in-RAM + `whatsapp_private.lid_mappings` + Baileys disk files — gateway `session-manager.js:648-742` | ✅ present |
| LID hold (suppress unresolved LID events) | `lidHold` — gateway `session-manager.js:1666,1722,2920` | ✅ present |
| Two-step exhaustion | `history_evidence.py:282-296` | ✅ present (on-demand path) |
| Background history kill-switch | `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED=false` — `config.py:180`, double-gated `sync.py:1044-1050` + `1128-1134` | ✅ present, OFF |
| Activity-only ordering | `whatsapp_service.py:409`, `whatsappOrdering.ts:31-48` | ✅ present |
| REST/WS message parity | both use `_serialize_message` | ✅ present |
| REST/WS **conversation** parity | three different shapes | ❌ **BROKEN** |
| Session lease | `postgres-session-lease.js` | ✅ present |
| Outbound echo dedup | `_recordOutbound` + `upsert` fromMe skip — gateway `1657-1662`, `1743-1755` | ✅ present, permutation-tested |

---

## 4. ACTIVE CODE PATHS vs. DEAD CODE

**Active (real traffic):**
- `whatsapp_service.py` is a genuine **public facade** (Phase 11.11), not legacy. Endpoints (`api/v1/endpoints/whatsapp.py:37-38`) and `/ws` ingestion (`main.py:236`) both go through it. **Do not delete.**
- `orchestration/{sessions,messaging,events,sync}.py` — all four are reachable.
- `_ensure_conversation_race_safe` → `_ensure_conversation` (the non-race-safe entry is only reachable through the safe wrapper).

**Dead / duplicated (evidence-backed):**

| Item | Location | Evidence |
|---|---|---|
| `gateway/payloads.py` — entire module | `services/whatsapp/gateway/payloads.py` | zero importers; `whatsapp_gateway.py:208-219` re-implements it inline |
| `whatsapp_gateway.request_older_history` | `whatsapp_gateway.py:222-243` | never called |
| `_conversation_gateway_id` import | `whatsapp_service.py:81` | imported, **never used** |
| `_PASSTHROUGH_EVENTS` duplicate | `events.py:80` and `whatsapp_service.py:871` | only `events.py` is consulted |
| `session_deleted` handling | `events.js:188-189`, `session-manager.js:844` | no producer exists |
| `logger` in `index.js` | `index.js:77` | used, never imported → `ReferenceError` |
| Frontend `getLiveMessages`, `WhatsAppApi.subscribe`, `subscribeGatewayEvents`, `markLeadConversationAsRead`, `fetchConversations`, `leadLoading`/`setLeadLoading`, `activeChatLoading=false`, `leadPhone` prop, `initialLimit` option | `whatsappApi.ts:684-711`, `whatsappRepository.ts:41-43,228-233`, `WhatsAppHubPage.tsx:148,264,889-891`, `ChatThread.tsx:35`, `useWhatsAppConversation.ts:21` | zero call sites |
| `contacts_updated` WS event | frontend | **not handled anywhere** (0 grep hits) |
| Competing name resolvers (7) | `mergeContactName` (`session-manager.js:609-626`), `_resolveDisplayName` (`:2197-2206`), `sanitizeChatForEmit`/`sanitizeOutboundEvent` (`:560-602`), `listConversations` read-time re-resolution (`:1194-1199`), `_applyLidMapping` merges (`:1865,1912`), `applySubject` (`:2132-2154`), `groups.update` (`:3313-3329`) | can disagree |
| Competing frontend identity helpers (3 raw-JID predicates, 3 phone cleaners, 4 message sorters) | `ConversationList.tsx:142-152`, `WhatsAppHubPage.tsx:79-89`, `whatsappPreview.ts:62-73`; `ConversationList.tsx:127-140` + inline `.replace(/\D/g,'').slice(-10)` ×3; `useWhatsAppConversation.ts:7-14`, `ChatThread.tsx:69-78`, `WhatsAppHubPage.tsx:284-288,513-520,1069-1076` | drift risk |

---

## 5. CONVERSATION ORDERING (verified CORRECT)

**Invariant `identity != ordering` HOLDS.**

- Backend: `base.order_by(Conversation.last_message_at.desc().nullslast()).order_by(Conversation.id.desc())` — `whatsapp_service.py:409`. No identity/name field participates.
- Frontend: `compareConversationsByActivityDesc` — `whatsappOrdering.ts:31-48` reads **only** `last_message_at`, tie-breaks on `created_at` then unique `id` (total order ⇒ no comparator flicker). All 11 sort call sites use it.
- Identity update does **not** re-sort: `WhatsAppHubPage.tsx:1210-1213` re-sorts only when `last_message_at` changed.
- Inbound message **does** move the row to the top: `WhatsAppHubPage.tsx:1017-1018`.

**Residual ordering defects (P2):**
1. ~~`_repair_last_message_previews` writes `conv.last_message_at = ts` with no monotonic guard (`sync.py:410-412`).~~ **WITHDRAWN — false positive.** The repair's candidate filter (`sync.py:363-377`) only selects conversations whose `last_message_preview` is NULL / empty / legacy-bracketed, i.e. rows sync never populated and whose timestamp is therefore untrusted. Moving `last_message_at` *backward* to the newest real message is the intended "poisoned timestamp" repair and is pinned by `test_whatsapp_faz10_preview_groupnames.py::test_repair_fixes_poisoned_timestamp`. Adding a monotonic guard broke that test; the change was reverted. A clarifying comment was added instead.
2. Optimistic send is not rolled back on failure: `WhatsAppHubPage.tsx:617-628` appends the message and moves the conversation to the top with a preview that never happened; the catch block (`:647-663`) only marks the bubble `FAILED`. The list ordering/preview lie until the next server refresh.
3. `NewChatModal` success insert is unsorted — `WhatsAppHubPage.tsx:2642-2649` returns `[newConv, ...prev]` without `.sort(...)`, unlike every other insertion path.

---

## 6. IDENTITY SYSTEM

### 6.1 Hierarchy actually implemented

`resolve_contact_identity` (`identity.py:208-270`) — 7 steps:

1. `is_group` → `display_name` → `RESOLVED_PROFILE`; else `RESOLVED_JID`
2. 1:1 → `display_name` **only if** `name_source != "push"` **and** not raw-JID **and** not phone-like → `RESOLVED_PROFILE`
3. clean E.164 (from `phone` arg or `contact.phone_e164`) → `RESOLVED_PHONE`
4. push_name fallback (no `name_source` check) → `RESOLVED_PROFILE`
5. `@g.us` / `@lid` → `RESOLVED_JID`
6. `is_transient_resolving` → `RESOLVING_TRANSIENT`
7. → `UNRESOLVED_PERMANENT`

**Step 4 is a contradiction.** The stated rule (§5 of the task, and the docstring of `set_contact_name`) is that a push name must never be a stranger's primary display name. Step 4 returns `push_name` as `RESOLVED_PROFILE`. It only fires when there is no resolvable phone — but `Lead.phone_e164`/`Contact.phone_e164` are **nullable** (`models/contact.py`), so the branch is reachable.

**Step 2 is bypassable via legacy rows.** `name_source` is only written when the name came through a path that sets it. Any contact row written before `name_source` existed (or written by `_upsert_contact`'s create branch, §7) has `name_src = None ≠ "push"`, so its polluted `display_name` resolves as `RESOLVED_PROFILE`.

### 6.2 `RESOLVING_TRANSIENT` / "Kişi kimliği çözülüyor…"

- Backend emits it **only** when `is_transient_resolving=True` — `identity.py:266-267`, default `False` (`identity.py:212`).
- The sole production call site passes no such flag: `whatsapp_service.py:522` → `_resolve_contact_identity(contact, phone=phone, is_group=is_grp)`. `identity_state` is written in exactly one place (`whatsapp_service.py:533`).
- Therefore **the spinner is currently unreachable**; unresolved identities fall to `whatsapp.contactFallback` = `"Kişi"` / `"Contact"` (`ConversationList.tsx:231`).

**But there is no escape hatch.** `ConversationList.tsx:226` reads `identity_state === 'RESOLVING_TRANSIENT'`; nothing in the frontend ever writes or times out that state, and `conversation_updated` cannot clear it (the payload has no `identity_state`). If the backend ever emits it, the row sticks until a full REST refresh. → **latent P2, defence-in-depth gap.**

### 6.3 Identity leak vectors still open

| # | Vector | Location |
|---|---|---|
| I-1 | push name written into `contact.display_name` on contact create | `events.py:212-219` |
| I-2 | `safe_display_name` ignores `name_source` → push name broadcast as WS `name` | `identity.py:106-119` + `sync.py:701` |
| I-3 | `conversations_updated` payload uses `lead_phone`, mapper reads `phone` → name+phone wiped | `events.py:648-654` vs `whatsappApi.ts:195-196` |
| I-4 | `conversation_updated` bypasses `mapConversationItem`; ignores `phone`/`identity_state` | `WhatsAppHubPage.tsx:1165-1217` |
| I-5 | raw `@lid`/`jid:` rendered verbatim as group sender label | `ChatBubble.tsx:251-254` (no guard, unlike `whatsappPreview.ts:62-78`) |
| I-6 | `data-phone={rawPhone}` leaks raw JID into the DOM | `ConversationList.tsx:476` |
| I-7 | frontend dedup key truncates phone to last 10 digits | `ConversationList.tsx:300-310` vs backend `conversations.py:104` (`contact_phone_for_jid` → full E.164 / `jid:` sentinel) |

### 6.4 Group identity

`@g.us` → group subject via `is_group` branch ✅. Frontend group fallback `whatsapp.groupFallback` ✅. Gateway drops the sender prefix for phone-like names (`session-manager.js:448-463`), which for push-only contacts stored as `name = phone` (`:2929`) removes the `"Ahmet: "` prefix that WhatsApp Web shows → cosmetic P2.

### 6.5 LID

- `jid_to_phone` returns `None` for `@lid` (`identity.py:34-35`) ✅ — no fake phone.
- Gateway `lidHold` suppresses events for unresolved LIDs ✅; `_applyLidMapping` emits `lid_mapped` + re-emits affected entities ✅.
- **Unmapped LID with no phone and no name** → `RESOLVED_JID` → frontend `contactFallback` `"Kişi"`. Deterministic, not an infinite spinner ✅.
- **Cross-session contamination (P1/P2):** `loadLidMappingsFromDb` runs `SELECT DISTINCT ON (lid_jid) … FROM whatsapp_private.lid_mappings ORDER BY lid_jid, (session_id = $1) DESC, created_at DESC` with **no `WHERE session_id`** (`session-manager.js:737-742`), and `syncLidMappingsFromDisk` scans **all** session directories and then persists them under the **current** `sessionId` (`:656-665, 698-703`). The code contract at `:302-304` says mappings are per-session. LID↔PN is arguably a global fact, so this may be intentional reuse — but the DB attribution is definitely wrong.

---

## 7. CONTACT SYSTEM

**Correct:**
- Bulk upsert is N+1-free: one phone-set SELECT + one batched insert (`sync.py:435-450`), with legacy `jid:` → canonical migration (`sync.py:455-460`) and `IntegrityError` retry (`sync.py:487-503`).
- Uniqueness enforced at DB level: `UniqueConstraint("user_id","phone_e164")` (`models/contact.py:38`).
- Bulk path correctly excludes push names: `sync.py:462-463` — `is_push = str(source or "") == "push"` → `safe_name = None → jid_to_phone(jid)`.

**BROKEN — inconsistent writer:**

```python
# events.py:212-219  (new-contact branch of _upsert_contact)
contact = Contact(
    user_id=user_id,
    phone_e164=phone_e164,
    display_name=(None if _is_raw_jid_name(display_name) else display_name) or jid_to_phone(clean_jid),
)
if display_name and str(name_source or "") in _NAME_RANK:
    contact.custom_attributes = {"name_source": str(name_source)}
```

There is **no `name_source == "push"` exclusion**, while the bulk path (`sync.py:462-463`) and the update path (`contacts.py:76-88`) both have one. `_ingest_message` feeds it `msg["sender_name"]` / `msg["sender_name_source"]` (`events.py:388-396`), and the gateway sends `sender_name_source='push'` for push-only strangers (`session-manager.js:1707`). **A stranger's push name becomes `contact.display_name` in the database.**

Once written:
- `resolve_contact_identity` (step 2) skips it (name_source=='push') → REST shows `+90…` ✅
- `safe_display_name` does **not** skip it → WS `name` = push name ❌
- `_set_contact_name(contact, …, 'push')` cannot clear it (`2 > 2` is False, `contacts.py:77`) ❌

**Also broken:**

| # | Issue | Location |
|---|---|---|
| C-1 | `UnboundLocalError`: if `_is_self_identity` matches but no self contact exists, `phone_e164` is never assigned before use | `events.py:161-193` |
| C-2 | `contacts.update` is the only ingestion path missing `isDegenerateJid` → ghost `0@s.whatsapp.net` contact possible | `session-manager.js:2902-2936` |
| C-3 | `@c.us` not canonicalized to `@s.whatsapp.net` → same person can occupy two store keys | `session-manager.js:544-545` vs `:322` |
| C-4 | no DB uniqueness on `messages.wa_message_id`; inbound dedup is SELECT-then-INSERT → concurrent duplicate possible | `models/message.py:56` |
| C-5 | `list_conversations` (a GET) mutates `contact.phone_e164` + `messages.sender_phone` and can poison the session on a failed commit | `whatsapp_service.py:494-503, 551-555` |

---

## 8. MESSAGE LIFECYCLE (verified SOLID)

`send → PENDING → gateway → WhatsApp → SENT → DELIVERED → READ`, plus echo reconciliation:

- Fail-closed send: `_requireConnectedSession` requires `status==='CONNECTED' && sock` (`session-manager.js:1593-1601`); provider errors mark `FAILED` and rethrow (`:1409-1414, 1823-1831`). Backend `messaging.py:154-161, 240-247` sets `FAILED` and re-raises. **No false success in the live send path.**
- ACK is monotonic: `ACK_RANK` (`:214`), `_applyMessageAck` refuses regression (`:1839`), `_confirmOutboundSent` only advances (`:1795`).
- Self-echo dedup both directions: `upsert` skips a `fromMe` id already stored (`:1657-1662`); `_recordOutbound` dedups by `wa_message_id`/`client_message_id` (`:1743-1755`). Verified by `test-outbound-races.mjs` + `test-faz10-p3-fromme.mjs` (both PASS).
- Backend dedup: `processed_events` event-id + `wa_message_id`/`client_message_id` SELECT (`events.py:398-418, 1141-1186`).

**Residual (P2):**
- Gateway live inbound upsert has **no** dedup key (only `fromMe` is deduped, `:1657-1662`) while history ingestion dedups by `wa_message_id` (`:3164`). Re-delivery produces duplicate gateway records + event noise (backend still dedups).
- `status=msg.get("status") or "SENT"` at the HTTP boundary (`endpoints/whatsapp.py:436, 476`) — latent false-success fallback.
- `_recordOutbound` uses `id: Date.now()` (`:1757`) — two sends in the same ms share the sort/pagination key.

---

## 9. SESSION LIFECYCLE

`created → QR → connecting → connected → sync → ready → disconnect → reconnect → relink → logout → delete`

**Correct:** `SocketLifecycle` generation guard (`domain/socket-lifecycle.js:19-57`) rejects stale socket attaches (`session-manager.js:2471-2500`); all handlers bail via `ignoreStaleSocketEvent` (`:2543-2552`). Leases: `acquire` only steals expired/same-instance (`postgres-session-lease.js:18-34`), `renew` is generation-bound, lost lease tears down the socket (`:2505-2516`).

**Broken:**
- **S-1 (P1) relink notification is dead.** `sessions.py:113-128` calls `ws_manager.broadcast({...}, tenant_id=str(row.user_id))`, but the signature is `broadcast(self, message, target_user_id=None)` (`api/v1/websocket.py:34`). → `TypeError`, swallowed by `except Exception … logger.debug` (`sessions.py:129-130`). The UI is never told a relink is required.
- **S-2 (P2)** pairing phone persisted before pairing succeeds: `session.phone_number = "+"+digits` at `:1054-1067` immediately after `requestPairingCode`; `_isRegistered` then derives from it (`:2371`) and `refreshQr` never clears it (`:986-1015`), permanently disabling the "never saw QR" fail-loud guard (`:2831-2832`).
- **S-3 (P2)** `deleteSession` emits nothing (`:1114-1146`) although the bridge and emit-guard both special-case `session_deleted`.
- **S-4 (P2)** `skip_locked=True` in `resolve_relink_candidate` (`relink.py:103`) makes a concurrent-relink 0-row result indistinguishable from "no candidate" → `get_pairing_qr` can create a duplicate `WhatsAppSession` for the same phone (no unique constraint on `whatsapp_sessions.phone_number`).
- **S-5 (P2)** every reconnect re-emits `session_sync_completed` (`:2752-2758`), and the backend schedules a `reconcile=True` sync on it (`events.py:1189-1194`) → a reconcile job per transient disconnect.

---

## 10. HISTORY SYSTEM (Phase 17)

**Correct (verified):**
- Cache hit does **not** mutate evidence: `history_evidence.py:129-131` returns early on `provider_status == "NOT_REQUESTED"`; gateway only emits `provider_status` when `fetchProvider` was actually invoked (`index.js:363`, `session-manager.js:1316-1326`).
- Timeout/error are durably committed **before** the exception propagates: `sync.py:1681-1682` commits then `raise` (`:1688`); `sync.py:1644-1659` records `ERROR` + commits then raises.
- Two-step exhaustion on the on-demand path: `history_evidence.py:282-296` — a single zero yields `EXHAUSTION_CANDIDATE`, never `FULLY_EXHAUSTED`.
- Cursor is `(wa_message_id, from_me, timestamp_ms)`, never a DB id: `sync.py:1622-1631`, `session-manager.js:1248-1252`, `repositories/messages.py:40-51`.
- Background sweep is **OFF** and double-gated (`config.py:180`, `sync.py:1044-1050` + `1128-1134`); the gateway has **no** history sweep of its own (`requestOlderHistory` only reachable from `getMessages(fetchProvider=true)` = user scroll, and `POST /history`).

**BROKEN:**
- **H-1 (P1) session key mismatch — the exhaustion short-circuit is dead and `has_more` is always `True`.**
  - `history_sync_states.session_id` is `TEXT REFERENCES whatsapp_private.gateway_sessions(session_id)` (`core/migrations.py:1294-1304`) and is written as `str(session_row.gateway_id)` (`sync.py:1610, 1648-1650, 1671-1674`).
  - The facade queries it with the **integer PK**: `sid_opt = str(conv.session_id)` (`whatsapp_service.py:641`) and `session_id=str(conv.session_id)` (`whatsapp_service.py:718`). `Conversation.session_id` is `Integer FK → whatsapp_sessions.id` (`models/conversation.py:40-42`).
  - Consequence 1: `is_history_exhausted_or_stalled` always returns `False` → the provider is re-requested on **every** scroll even after `FULLY_EXHAUSTED`/`CURSOR_STALLED`.
  - Consequence 2: `get_history_evidence` returns the default (`state=NOT_CHECKED`, `has_more=True`) → `whatsapp_service.py:725-730` flips `has_more` back to `True` every time. **"Load older messages" never terminates.**
  - The correct helper (`conversation_gateway_id`) is already imported at `whatsapp_service.py:81` and unused.
- **H-2 (P2, latent)** the background sweep sets `FULLY_EXHAUSTED` from a **single** provider call (`sync.py:1383-1402`), contradicting `history_evidence.py:11-14`; it also uses a timestamp-only stall test (`sync.py:1299`) vs. the id+timestamp test at `history_evidence.py:263-267`. Unreachable while the flag is off.
- **H-3 (P2)** partial timeout: if `provider_status == "TIMEOUT"` **and** `gw_msgs` is non-empty, `state='TIMEOUT'` is written, messages are persisted, and no exception is raised (`sync.py:1681-1688`) — evidence contradicts the returned data.
- **H-4 (P2)** `SOCKET_UNAVAILABLE` is nearly unreachable: the gateway only calls `requestOlderHistory` when `sock` is truthy (`session-manager.js:1317`), so a disconnected socket yields `NOT_REQUESTED` (treated as cache hit). The backend branch at `history_evidence.py:180` is effectively dead.
- **H-5 (P2)** no per-conversation request budget on the scroll path (the `>= 3` attempt cap exists only in the flag-gated sweep, `sync.py:1219`) → client-driven amplification.
- **H-6 (P2)** `_persist_chat_snapshot` emits the gateway `last_message_at` even when `apply_last_message` rejected it (`sync.py:686-689` vs `:707`), so a WS snapshot can carry an older timestamp than the DB row.

---

## 11. REALTIME / WEBSOCKET EVENT AUDIT

### 11.1 REST vs WebSocket conversation payloads — **NOT normalized through the same helper**

Three shapes exist for the same entity:

| Source | Fields | `identity_state` | phone field |
|---|---|---|---|
| REST `list_conversations` (`whatsapp_service.py:523-549`) | full canonical | ✅ | `phone` |
| Sync WS `_persist_chat_snapshot` (`sync.py:695-715`) | `name: safe_display_name(contact)`, `message_count: 0` | ❌ absent | `phone` |
| Gateway WS `conversation_updated` (`events.py:886-922`) | raw gateway dict forwarded | ❌ absent | ❌ absent |
| LID-reconcile WS `conversations_updated` (`events.py:648-654`) | partial | ❌ absent | **`lead_phone`** |

Frontend `mapConversation` (`whatsappApi.ts:183-210`) reads `c.name`, `c.phone`, `c.identity_state`, `c.message_count`, `c.last_message_state`.

**The `lead_phone` / `phone` divergence is a live bug.** `WhatsAppHubPage.tsx:1261-1272` does:

```ts
const mapped = mapConversationItem(eventData.conversation);
setConversations((prev) =>
  prev.some((c) => c.id === mapped.id)
    ? prev.map((c) => (c.id === mapped.id ? { ...c, ...mapped } : c)).sort(...)
    : [mapped, ...prev].sort(...));
```

`mapped` contains `lead_name: undefined` and `lead_phone: undefined` (because the payload has neither `name` nor `phone`). Spreading an explicit `undefined` **overwrites** the existing values. The row therefore loses both its name and its phone and falls to `whatsapp.contactFallback` → **"Kişi" / "Contact"**, exactly the reported identity loss. The subsequent `last_message_preview`/`last_message_at` survive because the payload has them.

**Correction to a prior hypothesis:** the specific chain "REST gives `lead_phone`, WS gives only `phone` → `lead_phone: undefined` → spinner" does **not** hold for `conversation_updated`, because `patch()` (`:1182-1201`) spreads `...c` and only overrides fields it actually read, and unknown rows are hydrated by REST (`:1203`). The real defect is the `conversations_updated` emitter's field naming (§11.1 above) plus `conversation_updated` dropping `phone`/`identity_state`.

### 11.2 Event inventory (handler → state write → semantics)

`message_new`/`inbound_reply`/`new_message`/`outbound_message_sent` → merge; `message_status_updated` → merge (status); `conversation_status_updated` → merge; `conversation_read` → merge; `conversation_updated` → merge (no phone/identity_state); `contact_synced` → merge (avatar); `new_conversation`/`conversations_updated` → **mapConversationItem merge (bug §11.1)** or full `loadConversations(true)` replace; `whatsapp_sync_*` (10 event types) → merge except `bootstrap`/`failed`/session events which trigger a full replace; `presence_updated` → merge + 10s timer; `session_*`/`number_updated` → sessions + silent refetch; `conversations_cleared` → replace.

**`contacts_updated` is emitted nowhere and handled nowhere.**

### 11.3 Duplicate-conversation check

No double-add: state dedups on the unique numeric `conversation.id`. Backend creation is race-safe (`events.py:298-325` `IntegrityError` → rollback → re-resolve → retry; `sync.py:572-595`) with DB constraint `uq_conv_user_session_contact_channel`. The **display** dedup key (`ConversationList.tsx:300-310`, last-10 digits) diverges from the backend canonical key (`conversations.py:104` → full E.164 / `jid:` sentinel) → two distinct contacts can merge into one visible row (P2).

---

## 12. FRONTEND STATE AUDIT

**Correct:** ordering (§5); locale dictionaries exactly in sync (1324/1324 keys, 0 gaps); no `window.alert`/`window.confirm`; modals portaled at `z-[99999]`; `mergeDeliveryStatus` never downgrades; WS replay protection via a bounded `wa_message_id` seen-set (`WhatsAppHubPage.tsx:229-244`).

**Broken:**

| # | Bug | Location | Symptom |
|---|---|---|---|
| F-1 (P1) | **Archive/Close/Reopen is a phantom action with a fake success toast.** `handleStatusChange` mutates local state + `toast.success(...)` but never calls the repository; the only persistence route `updateConversationStatus` unconditionally throws. There is **no** backend status endpoint (`grep` of `endpoints/*.py` → no PATCH/PUT for conversation status). | `WhatsAppHubPage.tsx:587-595`; `whatsappRepository.ts:324-329` | Green "Durum güncellendi", badge flips, reverts on next refresh, never appears in the ARCHIVED/CLOSED tab. **AGENTS.md §1.1 violation.** |
| F-2 (P1) | **`search` param never sent.** Declared in the signature and passed by callers, but never appended to the querystring. Backend fully supports it (`endpoints/whatsapp.py:340,367`; `whatsapp_service.py:392-402` filters on `display_name`/`phone_e164`). | `whatsappApi.ts:460-505` | Search only filters the ≤50 in-memory rows; for >50 conversations a known contact returns the empty state. |
| F-3 (P1) | **`loadConversations` replaces the list with page 1**, discarding loaded pages and resetting the offset. Callers include silent refresh paths (session events, `conversations_updated` w/o payload, WS reconnect). | `WhatsAppHubPage.tsx:327` (+ `:1544,1274,1470,456,1515,1706`) | Scrolled pages 51-150 silently vanish on any session event. |
| F-4 (P1) | **Stale-response race** in `useWhatsAppConversation`: no generation guard / `AbortController` around the fetch. | `useWhatsAppConversation.ts:37-84` | Switching leads A→B can render A's conversation under B's header. |
| F-5 (P1) | **New Chat is a guaranteed failure.** `startConversation` is an unconditional `throw`; no live path. | `NewChatModal.tsx:40-54`; `whatsappRepository.ts:293-295` | Prominent CTA always errors; `onSuccess` unreachable. |
| F-6 (P2) | Optimistic send not rolled back on failure (§5.2) | `WhatsAppHubPage.tsx:617-663` | Conversation pinned at top with a preview that never happened. |
| F-7 (P2) | Duplicate success toast on retry | `WhatsAppHubPage.tsx:699,709,2032-2035` | Two identical toasts. |
| F-8 (P2) | NewChatModal insert unsorted (§5.3) | `WhatsAppHubPage.tsx:2642-2649` | New row pinned top until refresh. |
| F-9 (P2) | `t(key) \|\| 'literal'` — fallbacks unreachable because `t()` returns the key string on miss (`I18nContext.tsx:68-71`). Dynamic key leak: `` t(`whatsapp.syncStage.${stage}`) `` renders `whatsapp.syncStage.idle` (backend emits `stage="idle"`, `endpoints/whatsapp.py:302`). | `ConversationList.tsx:208,227,231,344,389,399`; `WhatsAppHubPage.tsx:1845` | Raw key strings in the sync banner. |
| F-10 (P2) | `isPrependingRef` can get stuck: set before `onLoadOlder()`, but the parent early-returns without state change when there is nothing more to page → the restore effect never runs → a later unrelated message change applies a bogus `scrollTop`. | `ChatThread.tsx:99-105,108-115`; `WhatsAppHubPage.tsx:271` | Scroll jump. |
| F-11 (P2) | Typing indicator cleared only for the open conversation | `WhatsAppHubPage.tsx:1029-1089` | "yazıyor…" persists up to 10s in background conversations. |
| F-12 (P2) | Filtered empty state is misleading (same copy for UNREAD/GROUPS/ARCHIVED/no-match) | `ConversationList.tsx:457-461` | Wrong empty copy. |
| F-13 (P2) | raw `@lid`/`jid:` reachable as group sender label; `data-phone` leaks raw JID into DOM | `ChatBubble.tsx:251-254`; `ConversationList.tsx:476` | Raw identifier visible. |

---

## 13. GATEWAY AUDIT (Node / Baileys)

**Correct:** fail-closed sends; no fake-phone synthesis (`jidToPhone` nulls for `@lid`/`@g.us`/degenerate); `mergeContactName` never writes a name for `source==='push'` (`:609-626`, rank map at `:555`); `name_source` propagated in contact DTOs; `lidHold`; outbound echo dedup + monotonic ACK; stale-socket rejection; single-owner leases; durable outbox with ACK/NACK/replay; `/ws/gateway` fail-closed token auth.

**Broken:**

| # | Bug | Location | Impact |
|---|---|---|---|
| G-1 (P1) | **"Read" reported to the UI even when WhatsApp never received the receipt.** The catch sets `gatewayOk=false`, then `chat.unread_count = 0` and `emitEvent({event:'conversation_read', unread_count:0})` run unconditionally; the function returns `{success:false}`. | `session-manager.js:1502-1515` | UI shows read, the counterparty still sees unread. **AGENTS.md §1.1 violation.** |
| G-2 (P2) | `logger` used but never imported → `ReferenceError` masks the original error and silently skips LID application | `index.js:77` | LID mapping silently dropped |
| G-3 (P2) | cross-session LID contamination (§6.5) | `session-manager.js:737-742, 656-665, 698-703` | Wrong session attribution in `lid_mappings` |
| G-4 (P2) | `contacts.update` missing `isDegenerateJid` guard (all other paths have it) | `:2902-2936` vs `:2955,3024,3125,3194` | Ghost contact |
| G-5 (P2) | live inbound upsert has no `wa_message_id` dedup | `:1657-1662` vs `:3164` | Duplicate gateway records + event noise |
| G-6 (P2) | sync counters are cumulative event counts, not unique entities; `contacts_synced` is `contacts.size` (unique) → inconsistent semantics; counters re-increment after per-chat cache eviction (2000 msgs/chat) | `:3243-3263, 3170` | Misleading sync progress |
| G-7 (P2) | `@c.us` not canonicalized (§7 C-3) | `:544-545` | Split identity |
| G-8 (P2) | `normalizePairingPhone` hardcodes TR for any 10-digit `5…` | `:350` | Non-TR number silently rewritten |
| G-9 (P2) | unbounded `mediaIndex` + `avatarFetchAttemptedAt` | `:646,129` | Memory growth |
| G-10 (P2) | `session_deleted` handling with no producer; `_applyLidMapping` emits up to 4 event types per learned pair (burst); `session_sync_progress` bypasses the durable outbox | `:844`, `:1880-1953`, `events.js:192-198` | Dead code / burst / dropped progress |

---

## 14. PRODUCTION / DATA INTEGRITY

**No production mutation was performed.** Production DB access was not exercised in this session (no credentials used, no queries run against a live instance). The following are **code-level** integrity findings that a production audit must confirm read-only:

| Check | Query to run (READ-ONLY) | Expected defect |
|---|---|---|
| push names in `display_name` | `SELECT id, phone_e164, display_name, custom_attributes FROM contacts WHERE custom_attributes->>'name_source' = 'push' AND display_name IS NOT NULL AND display_name <> phone_e164` | rows from §7 (contact-create path) |
| duplicate contacts per phone | `SELECT user_id, phone_e164, COUNT(*) FROM contacts GROUP BY 1,2 HAVING COUNT(*)>1` | should be 0 (`uq_contact_user_phone`) |
| duplicate conversations | `SELECT user_id, session_id, contact_id, channel, COUNT(*) FROM conversations GROUP BY 1,2,3,4 HAVING COUNT(*)>1` | should be 0 (`uq_conv_user_session_contact_channel`) |
| `@lid`/`jid:` still in `contacts.phone_e164` | `SELECT COUNT(*) FROM contacts WHERE phone_e164 LIKE '%@lid'` | unmapped LIDs |
| orphan messages | `SELECT COUNT(*) FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id WHERE c.id IS NULL` | FK should prevent |
| stale sessions | `SELECT id, gateway_id, status, is_active, updated_at FROM whatsapp_sessions WHERE is_active AND status <> 'CONNECTED'` | stale rows |
| history evidence rows | `SELECT state, COUNT(*) FROM whatsapp_private.history_sync_states GROUP BY 1` | `FULLY_EXHAUSTED` likely absent (H-1) |
| LID attribution | `SELECT session_id, COUNT(*) FROM whatsapp_private.lid_mappings GROUP BY 1` | misattributed rows (G-3) |

**Do not run any of these as writes.** No remediation was applied in this pass.

---

## 15. KNOWN BUGS — THE 20-ITEM REGRESSION LIST (status re-verified)

| # | Reported problem | Status | Evidence |
|---|---|---|---|
| 1 | "Kişi kimliği çözülüyor…" for unsaved contacts | **FIXED (by unreachability)** | Backend never emits `RESOLVING_TRANSIENT` (`identity.py:212,266`; sole call site `whatsapp_service.py:522`). Unresolved → `contactFallback` `"Kişi"`. *No escape hatch exists* (latent P2, §6.2) |
| 2 | Unsaved contacts shown with a wrong pushName | **PARTIALLY FIXED** | REST read path guarded (`identity.py:244`) ✅; DB write path not (`events.py:212-219`) ❌; WS `safe_display_name` not (`identity.py:106-119`) ❌ |
| 3 | pushName overwriting an addressbook contact | **FIXED on update, BROKEN on create** | `set_contact_name` guards (`contacts.py:76-88`) ✅; create branch does not ❌ |
| 4 | Ordering broken by identity state | **FIXED** | `whatsapp_service.py:409`, `whatsappOrdering.ts:31-48`; identity updates don't touch `last_message_at` ✅ (residual: `_repair_last_message_previews` non-monotonic, `sync.py:410-412`) |
| 5 | WS payload producing different identity than REST | **STILL BROKEN** | `events.py:648-654` (`lead_phone`) vs `whatsappApi.ts:195-196` (`phone`); `conversation_updated` carries no `phone`/`identity_state` |
| 6 | Duplicate conversation | **FIXED** | `events.py:298-325`, `sync.py:572-595`, DB constraint; frontend dedups by `id` ✅ (residual: display dedup key divergence, P2) |
| 7 | Raw LID JID displayed | **MOSTLY FIXED** | `jid_to_phone` nulls `@lid`; `is_raw_jid_name` guards; residual leak in `ChatBubble.tsx:251-254` |
| 8 | Group ID instead of group name | **FIXED** | `is_group` branch in `resolve_contact_identity`; frontend group fallback ✅ (residual: gateway sender-prefix suppression, P2) |
| 9 | `+0` / broken phone contacts | **MOSTLY FIXED** | `is_degenerate_jid` + `jid_to_phone` guards; residual: `contacts.update` missing the guard (G-4) |
| 10 | Conversations missing after initial sync | **NOT VERIFIED** | requires live runtime; `schedule_chats_bootstrap` + `whatsapp_sync_chats_bootstrap` path exists but was not exercised |
| 11 | Manual history pagination | **STILL BROKEN** | H-1 session key mismatch → `has_more` always `True` |
| 12 | Provider timeout losing evidence | **FIXED** | `sync.py:1681-1688` commits before raising ✅ (residual: partial-timeout inconsistency, H-3) |
| 13 | `FULLY_EXHAUSTED` from a single call | **FIXED on-demand / BROKEN in sweep (flag OFF)** | `history_evidence.py:282-296` ✅; `sync.py:1383-1402` ❌ but unreachable |
| 14 | Cursor stall infinite loop | **STILL BROKEN (amplified)** | `CURSOR_STALLED` can never be read back because of H-1 |
| 15 | Background sweep breaking Chrome sync | **FIXED (disabled)** | `config.py:180` default `False`, double-gated; gateway has no sweep |
| 16 | Session reconnect / relink races | **PARTIALLY FIXED** | socket generation guard + leases ✅; relink UI notification dead (S-1), duplicate-session race (S-4), premature pairing phone (S-2) |
| 17 | Outbound self-echo duplication | **FIXED** | `:1657-1662`, `:1743-1755` + permutation tests |
| 18 | ACK reconciliation | **FIXED** | monotonic `ACK_RANK`/`_applyMessageAck`/`_confirmOutboundSent` |
| 19 | Message ordering | **FIXED** | 4 equivalent sort implementations (drift risk only) |
| 20 | Scroll restoration | **PARTIALLY FIXED** | `isPrependingRef` can stick (F-10) |

---

## 16. RISK CLASSIFICATION

### P0 — Critical
**None confirmed.** No path was found where a failed send is reported as success in the live send flow, no message loss, no wrong-session send, no conversation loss. (The send FSM at `messaging.py:150-179` + `session-manager.js:1593-1601` is truthful and fail-closed.)

### P1 — High
| ID | Bug |
|---|---|
| H-1 | History evidence session-key mismatch → dead exhaustion short-circuit, `has_more` always `True`, provider re-requested on every scroll |
| I-1 | push name written to `contact.display_name` on contact create (+ `safe_display_name` blind to `name_source`) |
| I-3 | `conversations_updated` emits `lead_phone` while the mapper reads `phone` → name+phone wiped on LID reconcile |
| S-1 | relink `session_updated` broadcast raises `TypeError` (wrong kwarg) → UI never told a relink is required |
| G-1 | gateway reports read + emits `conversation_read: 0` when the WhatsApp read receipt failed |
| F-1 | archive/close/reopen is a phantom action with a fake success toast (no backend support) |
| F-2 | conversation `search` param never sent (server-side search effectively disabled) |
| F-3 | `loadConversations` replaces the list, discarding loaded pages |
| F-4 | stale-response race in `useWhatsAppConversation` (wrong chat shown) |
| F-5 | New Chat always fails (unconditional `throw`) |
| H-2' | background sweep violates two-step exhaustion — **latent, flag OFF** |

### P2 — Medium
I-4, I-5, I-6, I-7, C-1 (`UnboundLocalError`), C-2, C-3, C-4, C-5, S-2, S-3, S-4, S-5, H-2, H-3, H-4, H-5, H-6, G-2 (`logger`), G-3, G-4, G-5, G-6, G-7, G-8, G-9, G-10, F-6…F-13, `status or "SENT"` fallback, missing `wa_message_id` unique constraint.

> **Withdrawn (verified false positive):** the "non-monotonic `last_message_at` in `_repair_last_message_previews`" finding. The backward move is intentional and test-pinned — see §5.

---

## 17. RECOMMENDED FIXES (minimum safe change, in priority order)

Fixes applied in this pass are marked **[DONE]**; see `WHATSAPP_FINAL_REPORT.md`.

1. **[DONE] H-1** — `whatsapp_service.get_messages`: resolve the gateway session id via the already-imported `_conversation_gateway_id` for both `is_history_exhausted_or_stalled` and `get_history_evidence`. No new helper, no schema change.
2. **[DONE] I-1** — `events._upsert_contact` create branch: never write a push name into `display_name`; store it as `push_name` metadata only (mirrors `set_contact_name` and the bulk path). Optionally harden `safe_display_name` to skip `name_source == 'push'`.
3. **[DONE] I-3** — `events`: emit canonical `name`/`phone`/`identity_state`/`is_group`/`avatar_url`/`unread_count` on `conversations_updated` (and stop emitting `lead_phone`).
4. **[DONE] S-1** — `sessions.py`: `tenant_id=` → `target_user_id=`.
5. **[DONE] G-1** — gateway `markConversationRead`: clear `unread_count` and emit `conversation_read` **only** on the success path.
6. **[DONE] G-2** — `index.js`: import/define `logger`.
7. **[DONE] C-1** — `_upsert_contact`: fix the `UnboundLocalError` on self-identity with no existing self contact.
8. **[DONE] F-2** — `whatsappApi.getConversations`: append the `search` querystring param.
9. **[DONE] F-1** — add a minimal `PATCH /conversations/{id}/status` + facade function + repository wiring so the archive/close/reopen control is truthful and actually persists.
10. **[DONE] F-3** — `loadConversations`: merge by `id` instead of replacing the array (preserve loaded pages).
11. **[DONE] F-4** — `useWhatsAppConversation`: generation guard against stale responses.
12. **[WITHDRAWN] "P2 ordering"** — the `_repair_last_message_previews` monotonic-guard fix was attempted and **reverted**: the backward `last_message_at` move is intentional poison repair, pinned by an existing test. Only a clarifying comment was added.
13. **NOT DONE (documented, requires a live device):** #10 initial-sync conversation completeness, G-3 LID scoping semantics (arguably intentional — changing it risks regressing LID resolution), F-5 New Chat (needs a real product decision on whether starting a chat with an unknown number is desired), S-2/S-4 session races, H-4/H-5 history budget, F-6/F-7/F-8/F-9/F-10/F-11/F-12/F-13, G-4…G-10, C-2…C-5, I-4…I-7, H-2/H-3/H-6, `status or "SENT"` fallback, missing `wa_message_id` unique constraint.

**Regression coverage added for the applied fixes:**

| Fix | Test |
|---|---|
| H-1 | `backend/tests/test_whatsapp_forensic_fixes.py::test_history_evidence_uses_gateway_session_uuid_not_integer_pk` (+ `…skipped_when_no_session_resolvable`) |
| I-1 | `…::test_upsert_contact_create_never_writes_push_name_as_display_name`, `…::test_safe_display_name_never_returns_push_nickname_for_phone_contact` |
| I-3 | `…::test_conversations_updated_payload_is_canonical_rest_shape` + `frontend/scripts/verify-whatsapp-logic.mjs` (partial-merge checks) |
| S-1 | `…::test_relink_notification_broadcasts_with_target_user_id` |
| C-1 | `…::test_upsert_contact_self_identity_without_existing_self_contact` |
| F-1 | `…::test_update_conversation_status_persists_and_broadcasts` (+ invalid / idempotent) |
| G-1 | `whatsapp-gateway/scripts/test-read-truthfulness.mjs` |
| Ordering invariant | `frontend/scripts/verify-whatsapp-logic.mjs` (5 ordering checks) |
