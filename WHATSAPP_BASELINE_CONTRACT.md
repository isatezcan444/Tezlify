# WHATSAPP BASELINE CONTRACT — PHASE 0 FREEZE

> **Status:** FROZEN. No code may be merged that violates this contract without an explicit Phase-N amendment.
> **Audience:** Any engineer or AI agent extending the WhatsApp subsystem in Tezlify.
> **Output of:** Phase 0 — Baseline Freeze & Architecture Contract.
> **Next phase entry condition:** A failure against any "MUST NOT REGRESS" invariant in §4 is a release blocker.

This document captures **the system as it actually is** at revision `359fe6d` on `main`. It is descriptive, not aspirational. Code in the repository is the source of truth; this file is the index of *what must not change* and *why*.

---

## 1. Current Revision

| Field | Value |
| --- | --- |
| Commit SHA | `359fe6dea9b4396a256e62df4efad600fa3d3a49` |
| Branch | `main` |
| Working tree | clean (no uncommitted changes) |
| Local vs `origin/main` | identical — no ahead, no behind |
| Last 5 WhatsApp-related commits | `359fe6d` merge: integrate origin/main with local enhancements, fail-closed gateway auth and chat rendering · `6a1a2bf` feat: enhance WhatsApp chat rendering, optional session metrics, and gateway authentication · `2f04e36` 1 · `8ce8e6f` fix(whatsapp): improve error handling during QR connection and enhance group chat seeding logic · `249e94a` feat: Enhance chat loading experience and error handling |
| Prior phase reports on disk | `WHATSAPP_PHASE2_REPORT.md` … `WHATSAPP_PHASE6_8_PROMOTION_REPORT.md`, plus `WHATSAPP_FORENSIC_AUDIT.md`, `WHATSAPP_PRODUCTION_DRIFT_AUDIT.md`, `WHATSAPP_NO_CONNECTED_LINE_DIAGNOSIS.md`, `WHATSAPP_EPHEMERAL_SESSION_LEAK_DIAGNOSIS.md`, `WHATSAPP_QR_LATENCY_DIAGNOSIS.md` — read alongside this contract to understand the *defect history* the contract freezes against. |

**No uncommitted changes were touched, stashed, or discarded during Phase 0.**

---

## 2. Architecture Map

The WhatsApp subsystem spans four processes: the **browser frontend**, the **FastAPI backend**, the **Baileys gateway** (Node), and the **shared PostgreSQL database** (with an encrypted `whatsapp_private` schema). Events flow gateway → backend WebSocket → frontend CustomEvent bus.

### A. Frontend (`/Users/isatezcan/Documents/Github/Tezlify/frontend/`)

| File | Role | Key symbols |
| --- | --- | --- |
| `src/pages/WhatsAppHubPage.tsx` | The page-level orchestrator. Owns *all* chat-list and per-conversation state. Houses: `loadConversations`, `loadMoreConversations`, `hydrateConversationMessages`, `activeSendMessage`, `activeSendMedia`, `activeSendMediaFile`, `activeSendTemplate`, `activeRetryMessage`, `handleStatusChange`, `handleSyncChats`, the WebSocket `handleWsEvent` listener, the optimistic-merge logic. Holds the `seenWaMessageIdsRef` ring (SEEN_WA_IDS_MAX = 1000), the `conversationsGenerationRef`, the `bootstrapFetchRef` 2-second debounce, the `backgroundBackfillRef` (MAX_BACKGROUND_CONVERSATION_PAGES = 5), the `peerTypingExpiryRef` TTL map, and the `loadConversationsRef`/`loadMoreConversationsRef` indirection. Computes sync progress via `computeSyncProgress(stage, chatsSynced, contactsSynced, messagesSynced, messagesTotal)`. Loads first page at `CONVERSATION_PAGE_SIZE = 200`, history at `limit: 50` and `before: oldestMessageId`. | `WhatsAppHubPage`, `computeSyncProgress`, `hydrateConversation`, `restoreConversationActivity`, `reportReadSync`, `scheduleBackgroundBackfill` |
| `src/features/whatsapp/hooks/useWhatsAppConversation.ts` | Lead/conversation detail hook with optimistic send and reconciliation by `client_message_id`. Has its own `fetchGenerationRef` so A→B switching does not let A's slow response write under B's header. | `useWhatsAppConversation`, `sortMessagesChronologically`, `sendMessage` (with `cmsg_…` temp id) |
| `src/features/whatsapp/api/whatsappApi.ts` | The FastAPI client. `mapConversation` is a **partial-merge mapper** (only copies fields that are `!== undefined`; an explicit `null` *is* authoritative). `buildConversationUpdatedPayload` normalises gateway `conversation_updated` payloads into the same `BackendConversation` shape so REST and WS cannot diverge. Live probe goes to `GET /whatsapp/gateway/health` only (NOT `/whatsapp/sessions`, which falsely reports "live" when the gateway is down). `useLiveMode` revalidates only on `LIVE_SESSION_EVENTS` (`session_connected`/`session_disconnected`/`session_deleted`/`session_qr_updated`/`session_sync_completed`/`gateway_connected`) or `ws_connected`. | `WhatsAppApi`, `probeLive`, `invalidateLiveProbe`, `useLiveMode`, `mapConversationItem`, `mapMessageItem`, `buildConversationUpdatedPayload` |
| `src/features/whatsapp/data/whatsappRepository.ts` | Live-only data access. `getConversation` and `getLeadConversation` issue a targeted `conversation_id`/`lead_id` query (NOT a 200-row list). `retryMessage` re-POSTs the original body with the original `client_message_id` (idempotent). `startConversation` and `getTemplates`/`sendTemplate` throw `WhatsAppApiError` — they are *deliberately not implemented* and the UI must not fake them. | `WhatsAppRepository`, `requireLive`, `subscribeGatewayEvents` |
| `src/features/whatsapp/components/ConversationList.tsx` | Renders the list, search debounce, filter tabs (`ALL`/`UNREAD`/`GROUPS`/`ARCHIVED`). Server-side filters: `group_only` for GROUPS, `archived_only` for ARCHIVED, `unread_only` for UNREAD. Empty state is shown **only when `convLoadState === 'ready'` and the list is empty**. | `ConversationList`, `FilterTab`, `getConversationDisplayName`, `extractCleanPhone`, `formatPhoneNumber`, `stripJidPrefix` |
| `src/features/whatsapp/components/ChatThread.tsx` | The chat pane. Owns scroll restoration via `prevScrollHeightRef` + `pendingPrependRef`. Initial-mount guard via `initialScrollDoneRef` (P6-7). Shows typing bubble, "new message" pill, load-older spinner, and per-conversation `error` / `pagingError`. | `ChatThread`, `TypingBubble` |
| `src/features/whatsapp/components/ChatComposer.tsx` | Composer. | `ChatComposer` |
| `src/features/whatsapp/components/ChatBubble.tsx` | Single message bubble. | `ChatBubble` |
| `src/features/whatsapp/components/SessionCard.tsx` | One WhatsApp line in the Sessions tab. | `SessionCard` |
| `src/features/whatsapp/components/WhatsAppQrConnectModal.tsx` | QR-pairing modal. Polls `GET /whatsapp/pairing/{token}/qr` and reacts to the `session_connected` WS event. | `WhatsAppQrConnectModal` |
| `src/features/whatsapp/components/NewChatModal.tsx` | Phone-entry modal (gated by the fail-closed repository — see §3.F). | `NewChatModal` |
| `src/features/whatsapp/components/TemplateSelectModal.tsx` | Template select (also fail-closed; templates are NOT part of the Baileys contract). | `TemplateSelectModal` |
| `src/features/whatsapp/lib/whatsappSync.ts` | `PEER_TYPING_TTL_MS`, `pruneExpiredTyping`, `resolveSyncDisplayCounts`. | — |
| `src/features/whatsapp/lib/whatsappUnread.ts` | Unread-count helpers. | — |
| `src/features/whatsapp/lib/whatsappPreview.ts` | `buildChatPreview` (per-type, group-aware), `normalizePreviewText`, `shouldApplyPreview`. The single canonical preview rule. | — |
| `src/features/whatsapp/lib/whatsappConversationPatch.ts` | `applyConversationEvent` — single canonical WS-merge rule used by every event handler. | — |
| `src/features/whatsapp/lib/whatsappMessageMerge.ts` | `mergeWhatsAppMessages` and `mergeDeliveryStatus` — the only canonical message dedup + status-merge used by refresh / reconnect / sync-chunk / pagination / live WS. | — |
| `src/features/whatsapp/lib/whatsappIdentity.ts` | `isRawWhatsAppJid`, name-source rank constants used by the UI. The single authoritative JID predicate — duplicated predicates are forbidden. | — |
| `src/features/whatsapp/lib/whatsappOrdering.ts` | `compareConversationsByActivityDesc`, `getConversationActivityTimestamp`, `restoreConversationActivity`. The single sort key. | — |
| `src/features/whatsapp/lib/whatsappLatency.ts` | `startWaLatency` / `finishWaLatency` markers (no UI effect). | — |
| `src/features/whatsapp/lib/translateError.ts` | Maps API error codes → i18n keys. | — |

### B. Backend (`/Users/isatezcan/Documents/Github/Tezlify/backend/app/`)

| File | Role | Key symbols |
| --- | --- | --- |
| `api/v1/endpoints/whatsapp.py` | Thin router. Maps exceptions to HTTP: `LookupError → 404`, `NoWhatsAppSession → 409`, `WhatsAppRelinkRequired → 409 + X-WhatsApp-State: RELINK_REQUIRED`, gateway failure → `502`. `gateway/health` is fail-closed (`503` on any error). All WhatsApp endpoints require `get_current_user`. | all route handlers |
| `api/v1/websocket.py` | The shared `ws_manager.broadcast(payload, target_user_id=…)`. **Fail-closed tenant routing:** if `target_user_id` cannot be resolved, the message is delivered to NO ONE (and the rejection is logged as `WS broadcast REDDEDILDI`). The single `/ws` endpoint serves scraper progress, campaign progress, and the gateway bridge. The gateway bridge is `/ws/gateway` (token-auth via `WHATSAPP_GATEWAY_SECRET`). | `ConnectionManager`, `ws_manager` |
| `services/whatsapp_gateway.py` | HTTP client to the Node gateway. **All routes are now session-scoped** (`/sessions/{gateway_id}/…`); pre-tenant-isolation routes were a security defect. `_request` injects `X-Gateway-Secret` (≥32-byte), logs only PII-safe `_diagnostic_route` shapes, and times out at `WHATSAPP_GATEWAY_TIMEOUT` (default 30s). | `gateway_base`, `gateway_auth_headers`, `_request`, `health`, `list_sessions`, `create_session`, `get_session_qr`, `refresh_session_qr`, `request_pairing_code`, `list_contacts`, `list_conversations`, `sync_group_subjects`, `get_messages`, `request_older_history`, `list_all_messages` (the bulk channel), `send_text_message`, `send_media_message`, `mark_conversation_read`, `send_typing`, `fetch_media` |
| `services/whatsapp_service.py` | The service façade exposed to endpoints. | — |
| `services/whatsapp/orchestration/sessions.py` | The pairing session lifecycle. Owns the in-memory `_ephemeral_pairings` map (cache, not source of truth), `_logical_to_ephemeral` map, and the `start_pairing_session` / `get_pairing_qr` / `cancel_pairing_session` / `get_session_qr` / `refresh_session_qr` / `request_pairing_code` / `request_pairing_code_for_token` (P6-8) / `logout_session` / `delete_session` / `purge_whatsapp_data` entry points. `cancel_pairing_session` is **promotion-aware** (Phase 6.8): if the gateway already reported `CONNECTED`, it finalises the pairing instead of deleting the socket. `_gateway_op_or_mark_relink` runs a gateway op and, on `session not found`, marks the row `RELINK_REQUIRED` + WS-broadcasts. | `list_sessions`, `create_session`, `start_pairing_session`, `get_pairing_qr`, `cancel_pairing_session`, `refresh_contact_avatar`, `get_session_qr`, `refresh_session_qr`, `request_pairing_code`, `request_pairing_code_for_token`, `logout_session`, `purge_whatsapp_data`, `delete_session`, `WhatsAppSessionOrchestrator` |
| `services/whatsapp/orchestration/promotion.py` | `promote_ephemeral_pairing` — the **single idempotent entry point** that completes a first-time promotion from the `session_connected` event alone. Resolves owner via in-memory map → durable pairing record → explicit owner on event, **fail-closed otherwise**. Reuses the relink path first, then reuses an existing non-CONNECTED row for the same phone, then creates a new `WhatsAppSession` row. Uses `phone_from_self_jid` (accepts only `@s.whatsapp.net` with all-digit local part; LIDs are never phone numbers per AGENTS.md §1.3). | `promote_ephemeral_pairing`, `phone_from_self_jid` |
| `services/whatsapp/orchestration/pairing_registry.py` | The **durable** side of the ephemeral registry. Writes `EphemeralPairing` rows at `pairing/start`, reads them for owner resolution, marks them `consumed_at` on promotion/cancel. **Unconsumed-only** lookups: a consumed record NEVER re-resolves an owner (a late duplicate event cannot re-promote). | `record_pairing`, `resolve_open_pairing`, `resolve_open_pairing_by_token`, `resolve_pairing_by_token` (test-only), `consume_pairing`, `consume_pairing_by_token` |
| `services/whatsapp/orchestration/relink.py` | `perform_atomic_relink` — locks a `RELINK_REQUIRED` row by primary key, rebinds `gateway_id`, migrates unverified `history_sync_states` (provider_checked = 0 preserved), commits. Idempotent. Cross-tenant ambiguous candidates raise `RelinkCandidateAmbiguous` (fail closed). | `perform_atomic_relink`, `find_existing_session_for_phone` |
| `services/whatsapp/orchestration/recovery.py` | Orphan lineage recovery: scans `whatsapp_private.gateway_sessions` for entries holding `history_sync_states` with no `public.whatsapp_sessions` row, and creates a new `RELINK_REQUIRED` row (no sequence manipulation, no hardcoded IDs). Idempotent. | `detect_orphaned_gateway_lineages`, `RecoveryResult`, `OrphanGatewayEvidence` |
| `services/whatsapp/orchestration/events.py` | The inbound gateway event orchestrator. **The** persistence path for messages, contact updates, conversation updates, presence, reads, status changes, LID mappings, and session lifecycle. `_map_session_event` is the only path that turns a `session_connected` into a durable row. `_map_conversation_event` emits the SAME canonical conversation shape as REST so WS payloads cannot erase known state on the frontend's `{...existing, ...mapped}` merge. `_ingest_lid_mapped` triggers `reconcile_legacy_split_conversation` and `_heal_lid_contact_identity` (write-path repair, never on a GET). | `WhatsAppEventOrchestrator`, `_upsert_contact`, `_ensure_conversation`, `_ensure_conversation_race_safe`, `_persist_gateway_message`, `_ingest_message`, `_ingest_contact_synced`, `_ingest_lid_mapped`, `reconcile_legacy_split_conversation`, `reconcile_self_identity`, `_heal_lid_contact_identity`, `_map_conversation_event`, `_map_session_event` |
| `services/whatsapp/orchestration/messaging.py` | Message serialization for WS payloads. | `serialize_message` |
| `services/whatsapp/orchestration/sync.py` | The initial-sync state machine. `SyncJob` (`SYNCING` / `COMPLETED` / `FAILED`) and its in-memory registry `_sync_jobs`. Constants: `_SYNC_BULK_PAGE_SIZE=1000`, `_SYNC_PERSIST_BATCH=200`, `_SYNC_EVENT_CHUNK=100`, `_SYNC_CHAT_PAGE_SIZE=40`, `_SYNC_PER_CHAT_LIMIT=50`, `_BOOTSTRAP_EMIT_INTERVAL_S=2.0`, `_ON_DEMAND_PROVIDER_WINDOW_S=10.0`, `_ON_DEMAND_PROVIDER_MAX_PER_WINDOW=6`. The single-flight `request_sync` returns the existing `SYNCING` job instead of starting a new one. `_schedule_chats_bootstrap` throttles the live chats-refresh signal to one every 2s per owner. `_run_background_history_expansion` is kill-switched via `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED`. S-5 reconciles are per-session single-flight with coalesced counts. | `SyncJob`, `WhatsAppSyncOrchestrator`, `request_sync`, `get_sync_job`, `_run_sync_job`, `_run_bulk_message_sync`, `_persist_chat_snapshot`, `_bulk_upsert_contacts`, `_ensure_conversations_bulk`, `_reapply_chat_names`, `_repair_last_message_previews`, `_schedule_initial_sync`, `_run_initial_sync`, `_run_background_history_expansion`, `_schedule_metadata_enrichment`, `_schedule_chats_bootstrap` |
| `services/whatsapp/orchestration/history_evidence.py` | `history_sync_states` — per-`session_id+jid` provider-exhaustion tracking. | `get_history_evidence`, `is_history_exhausted_or_stalled`, `record_on_demand_provider_result` |
| `services/whatsapp/identity.py` | Pure JID/phone policy. `jid_to_phone` returns `None` for `@lid` and `@g.us` (never synthesises a phone). `is_degenerate_jid` rejects `<5` digits and all-zero. `is_broadcast_only_jid` rejects `status@broadcast` and `@newsletter`. `safe_display_name` returns `None` for raw-JID-shaped names. `extract_clean_phone` is the only phone-extraction function. `resolve_contact_identity` returns `(name, state)` per WhatsApp Web parity. `NAME_RANK` rank order: `addressbook(5) > verified(4) = group_subject(4) > history(3) > push(2) > phone(1)`. **Push names are NEVER shown as a contact's display name on strangers' numbers** — only on a pure-LID fallback. | all |
| `services/whatsapp/preview_normalization.py` | The canonical preview/last-message rules. `should_apply_unread_count` is the **single decision point** for the unread `max()` vs. monotonic debate. **`should_apply_last_message` decides the PREVIEW ONLY — it is not the decision point for `last_message_at`** (see the timestamp/preview invariant in §B). `TYPE_PREVIEW_LABELS` mirrors the gateway table and must stay in parity with it. | `build_last_message_summary`, `should_apply_last_message`, `should_apply_unread_count`, `TYPE_PREVIEW_LABELS` |
| `services/whatsapp/status_policy.py` | `parse_session_status` and `advance_message_status` (monotonic: `PENDING(0) → SENT(1) → DELIVERED(2) → READ(3) → FAILED(0)`). | — |
| `services/whatsapp/exceptions.py` | `NoWhatsAppSession`, `WhatsAppRelinkRequired`, `EventOwnerUnresolved`. | — |
| `services/whatsapp/repositories/sessions.py` | DB layer for `WhatsAppSession`. Includes `resolve_event_owner` and `resolve_event_owner_and_session` — the canonical JID/LID/phone → (user_id, ws_session_id) resolution. | `resolve_event_owner`, `resolve_event_owner_and_session` |
| `services/whatsapp/repositories/conversations.py` | DB layer for `Conversation`. `_conversation_locks[(user_id, conv_id)]` is the per-conversation async lock (manual scroll ↔ background hydration isolation). `apply_conversation_last_message` and `apply_conversation_unread_count` enforce the time-stamped rules. | `get_conversation_lock`, `get_conversation_scope_filters`, `find_whatsapp_conversation`, `apply_conversation_last_message`, `apply_conversation_unread_count` |
| `services/whatsapp/repositories/messages.py` | DB layer for `Message`. `build_message_from_gateway` and the dedup SELECT by `(conversation_id, wa_message_id)`. `message_exists_by_wa_id`, `sync_watermark_epoch` (initial-sync `since`), `hydration_cursor_ms`. | `build_message_from_gateway`, `message_exists_by_wa_id`, `get_sync_watermark_epoch`, `hydration_cursor_ms` |
| `services/whatsapp/repositories/contacts.py` | DB layer for `Contact`. `set_contact_name` / `set_contact_avatar` honour the name-source rank. | — |
| `services/whatsapp/repositories/lid_mappings.py` | Tenant-scoped LID → phone resolution. The resolver prefers the caller's own session and stops at the tenant boundary. | `resolve_lid_phone` |
| `models/whatsapp_session.py` | The `public.whatsapp_sessions` table. `SessionStatus` enum: `SCAN_QR, RESTORING, CONNECTING, CONNECTED, DISCONNECTED, RELINK_REQUIRED, UNAVAILABLE, ERROR, BANNED`. | `WhatsAppSession` |
| `models/conversation.py` | `public.conversations`. `ConversationStatus`: `ACTIVE, ARCHIVED, CLOSED`. Unique constraint `uq_conv_user_session_contact_channel` on `(user_id, session_id, contact_id, channel)` — the DB-level duplicate guard. `is_group` and `is_archived` are persistent columns, not derived on read. | `Conversation` |
| `models/message.py` | `public.messages`. `MessageDirection` (`INBOUND, OUTBOUND`), `MessageType` (TEXT, IMAGE, DOCUMENT, AUDIO, VIDEO, STICKER, LOCATION, CONTACT, TEMPLATE, UNKNOWN, OTHER), `ConversationMessageStatus` (PENDING, SENT, DELIVERED, READ, FAILED, RECEIVED). Partial-unique indexes: `uq_msg_conv_client_message_id` and `uq_msg_conv_wa_message_id` — both scoped to a single conversation; a `wa_message_id` is only unique per conversation, never globally. | `Message` |
| `models/contact.py` | `public.contacts`. `phone_e164` is normalised E.164. Unique constraint `uq_contact_user_phone` on `(user_id, phone_e164)` — DB-level duplicate guard. `custom_attributes` JSON holds `name_source`, `push_name`, `avatar_url`. | `Contact` |
| `models/ephemeral_pairing.py` | The durable ephemeral registry table. The PK is `pair_token`; `gateway_session_id` is UNIQUE (one gateway session → exactly one pairing attempt). `consumed_at` marks the pairing finished; unconsumed-only resolution is enforced at the lookup site. | `EphemeralPairing` |
| `services/whatsapp_profiling.py` | `@profiled` decorator for sync-job profiling. | — |
| `services/admin/whatsapp_admin_service.py` | Admin operations (out of sync-path scope). | — |
| `services/whatsapp/gateway/` | `payloads.py`, `responses.py`, `errors.py` — gateway response/payload normalisation. | — |

### C. Gateway (`/Users/isatezcan/Documents/Github/Tezlify/whatsapp-gateway/src/`)

| File | Role | Key symbols |
| --- | --- | --- |
| `session-manager.js` | The session registry, factory, and lifecycle owner. **Single source of `sessions` Map** and per-session `store` (`{contacts, chats, messagesByChat, retryCounterCache, ...}`). Owns `createSession`, `restoreSessions`, `refreshQr`, `requestPairingCode`, `logoutSession`, `deleteSession`, `listContacts`, `listConversations` (gateway-side in-memory; backend *never* sees this — it goes via the gateway REST API), `getMessages`, `requestOlderHistory` (the only `sock.fetchMessageHistory` consumer), `listAllMessages` (the bulk channel), `sendTextMessage`, `sendMediaMessage`, `sendTyping`, `markConversationRead`, `_ingestUpsertMessage`, `_ingestContactUpdates`, `_recordOutbound`, `_confirmOutboundSent`, `_failOutbound`, `_applyMessageAck`, `_applyLidMapping`, `_touchChat`, `_ensureChatAvatar`, `_ensureGroupSubjects`, `_resolveDisplayName`, `_startSocket`, `_connectSocket`. Generation-tracked socket replacement (`SocketLifecycle`) prevents stale sockets from owning events. | `createSessionManager`, `_requireSession`, `_requireConnectedSession`, `_storeOf`, `_ingestUpsertMessage`, `_touchChat`, `_confirmOutboundSent`, `_failOutbound`, `_applyMessageAck`, `_applyLidMapping` |
| `socket/socket-connector.js` | `createSocketForSession` — wraps Baileys `makeWASocket` with auth state, encryption, retry cache, and `onLidMappingDiscovered` callback. | `createSocketForSession` |
| `socket/socket-events.js` | All Baileys event handlers: `creds.update`, `connection.update`, `messages.upsert`, `contacts.update`, `contacts.upsert`, `chats.phoneNumberShare`, `chats.update`, `messaging-history.set`, `groups.update`, `presence.update`, `messages.update`. **`messages.upsert` is the single source of `message_new` events** (both inbound and phone-sent outbound; `inbound_reply`/`new_message`/`outbound_message_sent` are NOT emitted by the gateway or backend — old code that expected them was deleted). `messaging-history.set` ingests chunks in batches with a 3 s quiet-period timer and a 45 s no-chunk fallback. `connection.update` handles `qr`, `connecting`, `open`, `close`; `restartRequired` (515) reconnects in 500 ms; `loggedOut`/`badSession` is terminal. | `bindSocketEvents`, `finalizeHistorySync` |
| `lease/lease-coordinator.js` | The lease lifecycle. `acquireLease` returns `true` on success, sets status `RESTORING` + schedules a 5–6s retry on contention. `armLeaseRenewal` runs at `ttl/3` (≥10s) intervals. `clearLeaseTimers`/`releaseLease` are idempotent. | `acquireLease`, `armLeaseRenewal`, `releaseLease`, `clearLeaseTimers` |
| `lease/postgres-session-lease.js` | Postgres lease repository (the actual `acquire/renew/release` calls). | — |
| `lid/lid-repository.js` | `lid_mappings` persistence, scoped to the gateway session. | `persistLidMappingToDb`, `loadLidMappingsFromDb`, `lidScopeSessionIds` |
| `domain/bounded-cache.js` | Bounded LRU/TTL cache used by retry counter caches. | — |
| `domain/socket-lifecycle.js` | Generation-based socket-attachment guard. | `SocketLifecycle` |
| `messages/message-classifier.js` | `classifyMessageType`, `summarizeWaMessage`, `hasRecognizedContent`, `buildMediaContent`, **`systemContentMarker`** — the single producer of the `[MARKER]` preview body for text-less content (protocol/REVOKE, reaction, call, poll, event, `messageStubType`). `classifyMessageType` still falls through to `TEXT` for all of these; the marker lives in `body`, never in `message_type`. | `systemContentMarker` |
| `messages/message-store.js` | `createSessionStore`, `rememberRawMessage`, `lookupRawMessage`, `messageTimestampMs`. `RAW_MESSAGE_STORE_MAX` bounds the in-memory raw-message store. When `sessionDir` is supplied the `contacts` map is wrapped so any mutation schedules a debounced save (see `messages/contact-cache.js`); the store then also carries `contactCache`. | — |
| `contacts/contact-repository.js` | Bootstraps `store.contacts` from the backend `contacts` table. The store is per-process and is **not** repopulated on reconnect ("skipping history sync wait"), so without this every restart left sender labels degrading to raw phone numbers. Owner is resolved `whatsapp_sessions.gateway_id -> user_id` and the contact query is joined on that `user_id` — never on phone alone. Names are inserted at `history` rank through `mergeContactName`, so a fresher live name wins and a later `push` nickname cannot clobber it. Fail-open: a DB error logs and returns 0. | `createContactRepository`, `jidFromContactPhone` |
| `messages/contact-cache.js` | Durable mirror of `store.contacts` at `<sessionDir>/contacts-cache.json`. Exists because `_resolveDisplayName()` resolves a sender label as contact-store name → `msg.pushName` → phone, and the store used to be memory-only, so every restart downgraded labels to raw phone numbers. Only entries with a usable *name* are written; raw identities and phone-shaped names are rejected on both save and load. A cached `session_phone` that differs from the current one discards the cache, and logout/`LOGGED_OUT`/`BANNED` clears it. | `createContactCache`, `CONTACTS_CACHE_FILE` |
| `media/media-store.js` | Media file storage. | `storeIncomingMedia`, `clearSessionMedia` |
| `auth/postgres-auth-repository.js` | Encrypted auth credentials persistence (`creds` + `keys` AES-GCM at rest). | `registerSession`, `saveCredentials`, `clearAuth`, `setSessionActive` |
| `auth/encrypted-codec.js` | AES-GCM codec. | — |
| `security/gateway-auth.js` | `X-Gateway-Secret` validator on the incoming `/ws/gateway` side. | — |
| `utils/whatsapp-identity.js` | JID/LID/phone primitives. `isLidJid`, `isStatusBroadcastJid`, `isNewsletterJid`, `isBroadcastOnlyJid`, `isDegenerateJid`, `isRawIdentityName`, `isPhoneLikeName`, `contactPhoneJid`, `normalizePairingPhone`, `mergeContactName`, `rememberLidPair`, `resolveJidKey`, `jidToPhone`, `asLid`, `asPn`. The single source of identity primitives. | — |
| `utils/whatsapp-formatting.js` | `TYPE_PREVIEW_LABELS` (incl. the marker kinds `CALL`, `REACTION`, `REVOKED`, `SYSTEM`, `POLL`, `EVENT` — must stay in parity with the backend and frontend copies), `normalizePreviewText`, `buildChatPreview`, `sanitizeChatForEmit`, `sanitizeOutboundEvent`, `resolveSyncState`. | — |
| `utils/baileys-logger.js` | Pino logger + Baileys error extractor. | — |
| `outbox/postgres-event-outbox.js` | Persists outbound events to a DB outbox (durable publish). | — |
| `database/postgres-pool.js` | Shared pool. | — |
| `observability.js` | `diagnostic`, `sessionRef`, `latency` markers. | — |
| `index.js` | HTTP server, route registration, WebSocket upgrade, Postgres pool bootstrap, session restore on boot. | — |

### D. Database

| Table / Schema | Where | Purpose | Notes |
| --- | --- | --- | --- |
| `public.whatsapp_sessions` | `models/whatsapp_session.py` | The **logical** session (one per WhatsApp line). `gateway_id` is UNIQUE and references the gateway's UUID. The tenant filter is `user_id`. | Status flow: `SCAN_QR → CONNECTING → CONNECTED ⇄ DISCONNECTED → RELINK_REQUIRED`. The public row is **NOT** created at `pairing/start`; it appears at promotion (Phase 6.8) or relink. |
| `public.conversations` | `models/conversation.py` | One row per `user_id + session_id + contact_id + channel` (DB-enforced). `is_group` and `is_archived` are persistent. | `session_id` is nullable for legacy rows; backfilled on first session-scoped event. |
| `public.messages` | `models/message.py` | Individual messages. `wa_message_id` and `client_message_id` are partial-unique **per conversation** only. `sender_phone` is nullable (LID senders are NULL per AGENTS.md §1.3). | `media_*` columns carry IMAGE/DOCUMENT/AUDIO/VIDEO/STICKER metadata; the bytes live in the gateway's media dir. |
| `public.contacts` | `models/contact.py` | The canonical contact table. `phone_e164` unique per user. `custom_attributes` JSON holds `name_source` + `push_name` + `avatar_url`. | Push names never become `display_name` on a stranger. |
| `whatsapp_private.gateway_sessions` | (private schema, scanned by `recovery.py`) | Persistent record of the gateway session's auth state, encryption, and registration timestamp. | The "lineage anchor" used by `perform_atomic_relink`. |
| `whatsapp_private.history_sync_states` | `orchestration/history_evidence.py` | One row per `session_id + jid`. Tracks `provider_checked`, `provider_exhausted`, `state` (`NOT_CHECKED` / partial / `EXHAUSTED` / `STALLED`). | Initialised as `NOT_CHECKED` on first encounter. |
| `whatsapp_private.lid_mappings` | `lid/lid-repository.js`, `repositories/lid_mappings.py` | `lid_jid → phone_jid` per gateway session. | Read with tenant scoping at the resolver; never global. |
| `whatsapp_private.ephemeral_pairings` | `models/ephemeral_pairing.py` | Durable record of in-flight QR pairings. `consumed_at` is the only "done" signal. | Source of truth for `session_connected` owner resolution. |
| `whatsapp_private.socket_leases` | `lease/postgres-session-lease.js`, `services/whatsapp/orchestration/sessions.py::fetch_held_lease_gateway_ids` | `(session_id, instance_id, generation, expires_at, updated_at)`. One row per actively-held socket. `session_id` is the gateway UUID (the same value that lives in `public.whatsapp_sessions.gateway_id`). | **The source of truth for "is this session's socket currently held by a gateway instance?"** The gateway's in-memory `session._leaseValidUntil` is a cache; only the DB row answers multi-instance ownership correctly. The CONNECTED invariant in §2 requires this row to exist. |
| `whatsapp_private.processed_events` | (used by events.py) | Idempotency log for inbound events. | — |
| Outbox | `outbox/postgres-event-outbox.js` | Outbound event durability. | — |

---

## 3. Critical Data Flows

Each flow lists the source files in execution order. "Source" is a function name; "Owner" is the user_id the operation is scoped to; "Conv" is the canonical conversation id (`public.conversations.id`).

### FLOW A — QR → CONNECTED

1. User opens the pairing modal → `WhatsAppQrConnectModal`.
2. `POST /api/v1/whatsapp/pairing/start` → `endpoints/whatsapp.py::start_pairing` → `services.whatsapp.orchestration.sessions.start_pairing_session` → `services.whatsapp_gateway.create_session(name, ephemeral=True)` → `whatsapp-gateway/session-manager.js::createSession({ephemeral:true})` returns a fresh `SCAN_QR` gateway session with a UUID.
3. Backend stores in `_ephemeral_pairings[pair_token] = {user_id, gateway_id, session_name, pair_token, …}` and writes `public.ephemeral_pairings` (`pairing_registry.record_pairing`).
4. Modal polls `GET /api/v1/whatsapp/pairing/{pair_token}/qr` → `get_pairing_qr` → `gw.get_session_qr(gateway_id)`. Gateway returns `{status: SCAN_QR, qr_code, phone}`.
5. User scans with phone. Baileys emits `connection.update` with `connection='open'`. `whatsapp-gateway/socket/socket-events.js` sets `session.status='CONNECTED'`, populates `self_jid`/`self_lid`, persists durable auth via `authRepository.registerSession` + `saveCredentials`, **acquires the lease** (`leaseRepository.acquire`), then emits `session_connected` to the backend.
6. The `/ws/gateway` handler delivers `session_connected` into `services.whatsapp.orchestration.events._map_session_event`. Because the gateway UUID is not yet bound to a `public.whatsapp_sessions` row, the branch goes through `promote_ephemeral_pairing` (`orchestration/promotion.py`):
   - resolve owner via in-memory map → `pairing_registry.resolve_open_pairing` → explicit owner (fail closed if all three miss),
   - reuse `RELINK_REQUIRED` candidate via `perform_atomic_relink` if the phone matches,
   - else reuse a non-CONNECTED existing row for the phone via `find_existing_session_for_phone`,
   - else INSERT a new `public.whatsapp_sessions` row (`status=CONNECTED`, `is_active=True`, `is_phone_online=True`).
7. `_consume_pairing` removes the in-memory + durable record.
8. `reconcile_self_identity` is called for the self-phone so a pre-existing LID or PN JID for the same number is folded into the canonical conversation.
9. Backend broadcasts `session_updated` (and `conversations_updated` when the reconcile produces a deletion) on `/ws` to the owner's UI.
10. Modal sees the `session_connected` WS event, flips to "CONNECTED", auto-closes after 1.5 s; the modal's cleanup effect calls `POST /whatsapp/pairing/{pair_token}/cancel`. `cancel_pairing_session` is promotion-aware: if the gateway status is already `CONNECTED`, it finalises the pairing (idempotent re-promotion) and **does not delete the socket**.

### FLOW B — INITIAL CHAT LOAD

1. User opens `/whatsapp` → `WhatsAppHubPage` mounts.
2. `useLiveMode` (in `whatsappApi.ts`) sets `LIVE_CONNECTING` and probes `GET /whatsapp/gateway/health`. On the result, status becomes `LIVE_CONNECTED` or `LIVE_DISCONNECTED`. A subsequent `ws_connected` or any `LIVE_SESSION_EVENTS` revalidates the probe.
3. `loadConversations()` (first page only): `GET /api/v1/whatsapp/conversations?limit=200&offset=0` with the current `convFilter`/`convSearch`.
4. Endpoint → `services.whatsapp_service.list_conversations` → returns `{items, total, has_more, next_offset}`. `has_more = (offset + len(items)) < total`.
5. Frontend merges into state with the partial-merge rule: if `has_more`, the first page REPLACES the visible rows and the prior state's *non-returned* rows are RETAINED (so a live activity that the first page missed is not lost); if `!has_more`, the first page is authoritative.
6. If `page.items` is non-empty and no `selectedConv`, the first item is auto-selected.
7. The user-triggered `selectedConv` change runs `hydrateConversationMessages(convId)`:
   - `GET /api/v1/whatsapp/conversations/{id}/messages?limit=50`,
   - merges into `messagesMap[convId]` with `mergeWhatsAppMessages` (dedup by id / wa_message_id / client_message_id; in-flight or realtime rows are kept if not present in the fetch),
   - updates `messagePaging[convId] = {hasMore, oldest, loading:false, error:false}`,
   - if `(selectedConv.unread_count ?? 0) > 0`, optimistically zeros the count AND calls `POST /conversations/{id}/read` (gateway may report `success=false`; that is logged, not swallowed).
8. The `computeSyncProgress`-driven banner listens to `whatsapp_sync_*` WS events and re-issues `GET /sync/job` only on `ws_connected` (reconnect recovery).

### FLOW C — FULL CHAT SYNC ("Eşitle")

1. User clicks "Eşitle" → `WhatsAppApi.startSync` → `POST /api/v1/whatsapp/sync` → `services.whatsapp_service.request_sync` → `orchestration/sync.py::request_sync`.
2. `request_sync` is **single-flight**: if a `SYNCING` job exists for the owner, it is returned unchanged (same `sync_id`).
3. `_run_sync_job(job)`:
   1. `whatsapp_sync_started` event broadcast.
   2. For each `WhatsAppSession` of the user in `CONNECTED`/`is_active`:
      - `stage = "chats"`: `gw.list_conversations(gateway_id)` → `_persist_chat_snapshot` (upsert contacts, ensure conversations, apply last-message summary, apply unread count via `should_apply_unread_count`, **emit persisted `last_message_at` not the gateway value** — H-6), broadcast `whatsapp_sync_chats_snapshot` in 40-row pages.
      - `_schedule_metadata_enrichment(gateway_id)` runs `gw.sync_group_subjects(force=True)` in the background.
      - `stage = "contacts"`: `_bulk_upsert_contacts` + `whatsapp_sync_contacts_snapshot` (chunked to 100).
      - `stage = "messages"`: if the bulk channel probe returns OK, `_run_bulk_message_sync` paginates `gw.list_all_messages(limit=1000, offset, since=<last_synced_epoch>, perChatLimit=50)`; otherwise legacy per-chat sync runs.
   3. `stage = "finalizing"`: `_repair_last_message_previews` retroactively repairs `last_message_preview` for rows where it is NULL/empty/`[…]` legacy-shaped.
   4. `state = COMPLETED`; broadcast `whatsapp_sync_complete` with `conversations` payload and `stage_timings`.
   5. If `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED`, kick off `_run_background_history_expansion` for each gateway id (gated by `_history_expansion_running` + cooldown).
4. WS events are delivered to the frontend which merges them via the same canonical partial-merge mappers; a coalesced `chats_bootstrap` signal is emitted by `_schedule_chats_bootstrap` at most every 2 s per owner.
5. Failure paths broadcast `whatsapp_sync_failed` with `error_code = RELINK_REQUIRED` if the gateway reports a missing session; the frontend `FAILED_SYNC_ACK_KEY` in `sessionStorage` keeps the banner from re-appearing on every page load for the same `(sync_id | finished_at)`.

### FLOW D — MESSAGE HISTORY

1. User opens ChatThread for conversation C. `useLayoutEffect` finishes `chat_request_to_commit_ms` once messages are mounted.
2. `initialScrollDoneRef` is `false` on mount so a 0-`scrollTop` event cannot trigger a load-older.
3. User scrolls up; `scrollTop < 60` AND `hasMore && !loadingOlder && initialScrollDoneRef.current` → `onLoadOlder`.
4. `onLoadOlder` snapshots `pendingPrependRef = {firstId, count}`; `isPrependingRef = true`; `handleLoadOlder()` reads `oldestMessageId` (a real numeric DB id; optimistic string ids are never sent as `before`) and calls `WhatsAppRepository.getConversationMessages(convId, {limit:50, before:oldest})`.
5. Endpoint → `whatsapp_service.get_messages(...)` returns `{messages, has_more, oldest_message_id, newest_message_id, history_evidence}`.
6. Frontend merges: `seen = existing(id+wa_id+client_message_id)`; `older = filtered(seen) ∪ existing`; sort chronologically by `created_at`/`external_timestamp` then numeric `id`.
7. `messagePaging[convId] = {hasMore, oldest: res.oldest_message_id ?? prev, loading:false, error:false}`. On error, `error: true` is set WITHOUT clearing `messagesMap[convId]` (per-conversation retryable state).
8. `useLayoutEffect` on `[messages]` reads `pendingPrependRef` and applies `scrollTop = prevScrollTop + (newHeight − prevScrollHeight)` so prepend does not jump the user away from the position they were reading.

### FLOW E — REALTIME MESSAGE

1. Baileys `messages.upsert` → `whatsapp-gateway/socket/socket-events.js` → `session-manager._ingestUpsertMessage` dedup-checks by `wa_message_id`, persists into `session.store.messagesByChat`, touches the chat (preview + timestamp), increments `chat.unread_count` for inbound, and **emits** `{event:'message_new', conversation_id: jid, message: …}`.
2. Backend `/ws/gateway` consumer ingests via `events._ingest_message`:
   - resolve owner + ws_session_id via `repositories/sessions.resolve_event_owner_and_session`,
   - `_ensure_conversation_race_safe` (re-keyed SELECT → INSERT with `IntegrityError` retry),
   - `messages.uq_msg_conv_wa_message_id` and `uq_msg_conv_client_message_id` reject duplicates; the WS event is deduped and the canonical row is returned with `event['message']` swapped for the DB row,
   - `apply_conversation_last_message` and `apply_unread_count` are applied,
   - `event['conversation_id']` is rewritten to the numeric `Conv.id`; `event['message']` is `serialize_message(row)`.
3. Backend broadcasts the event to the owner's WS connections via `ws_manager.broadcast(target_user_id=user_id)` (fail-closed: missing target = no broadcast, logged).
4. Frontend `window` `tezlify:ws_event` handler:
   - `seenWaMessageIdsRef` (ring) dedups replayed events — counters/preview do NOT bump on a replay,
   - `phoneMatches` resolution chooses the conversation by `eventPhone` only when EXACTLY ONE line matches; multi-line ambiguity refuses to attribute the message,
   - `buildChatPreview` produces the preview (group: `Name: text`; media: type-tag; never raw JID; never stale `last_message_at`),
   - `selectedConv.id === convId` path appends the message via `mergeWhatsAppMessages` (the same canonical merger used by refresh/reconnect/sync-chunk/pagination),
   - inbound + selected → auto-`markConversationAsRead` (silent on failure, logged).
5. `message_status_updated` events find the existing row by `wa_message_id` (preferred), then `client_message_id`, then numeric `id`, and advance via `status_policy.advance_message_status` (monotonic). `F-6` does NOT make a FAILED write from a non-pending status.

### FLOW F — IDENTITY

1. **Phone JID (PN) ↔ LID.** A new contact or chat message arrives with a JID like `…@s.whatsapp.net` (PN) or `…@lid` (LID). The gateway's `Baileys` may emit `lidPnMappings` or `chats.phoneNumberShare` mid-stream; `_applyLidMapping(session, lid, phoneJid)` stores the pair in `session.store.lidPairs`, persists to `whatsapp_private.lid_mappings`, deletes the LID-keyed contact/chat, merges into the PN-keyed contact (using `mergeContactName` with the source rank), migrates LID-keyed messages into the PN conversation (deduped by `wa_message_id`), and emits `contact_synced`/`conversation_updated`/`message_new`/`lid_mapped` so the backend sees canonical shapes.
2. **Backend LID mapping** (`events._ingest_lid_mapped`) calls `_heal_lid_contact_identity` (write-path) and `reconcile_legacy_split_conversation` to merge the LID conversation into the canonical PN conversation (in one transaction with the conversation lock for both rows).
3. **Self identity.** When `session_connected` promotes a session, `reconcile_self_identity` deletes LID/duplicate-PN contacts and conversations that match the session's own phone (and `self_lid` if known), folding their messages into the canonical self conversation.
4. **Identity resolution for display.** `services.whatsapp.identity.resolve_contact_identity(contact, phone, is_group)` is the ONLY canonical rule (Faz 1 GROUP_MATCH, Faz 2 ADDRESS_BOOK_MATCH non-push, Faz 3 PHONE_JID, Faz 4 LID_PROFILE_FALLBACK, Faz 5 GROUP_JID/LID_JID, Faz 6 RESOLVING_TRANSIENT, Faz 7 UNRESOLVED_PERMANENT). Push names are NEVER shown as a contact's display name on a stranger. Raw JIDs (`is_raw_jid_name` matches `jid:…`, `@lid`, `@c.us`, `@s.whatsapp.net`, `@g.us`) never reach the UI; the frontend mapper drops them or the display rule returns `None`.
5. **Backend REST/WS parity.** The WS `conversation` payload (in `_map_conversation_event` and `_ingest_lid_mapped`) is constructed with the SAME `resolve_contact_identity` rule and the same field names as `REST list_conversations`, so a partial-merge `{...existing, ...mapped}` on the frontend never erases known state.

### FLOW G — RECONNECT

1. Baileys `connection.update {connection:'close'}`.
2. `socket-events.js` decides:
   - `restartRequired (515)` → `SocketLifecycle.scheduleReconnect(generation, sock, 500, _startSocket)`. The 500 ms socket is replaced; the lease is renewed; events for the old socket are dropped via `ignoreStaleSocketEvent`.
   - `loggedOut` or `badSession` → `leaseCoordinator.releaseLease`, `deactivatePersistentSession`, `mediaStore.clearSessionMedia`, `clearSessionHistoryFetches`, `resetRetryCounterCache`, then `emit('session_disconnected', reason)`. Backend `_map_session_event` marks the row `DISCONNECTED`/`BANNED`.
   - transient → exponential backoff `min(30000, 1000 * 2^min(_connFailures-1, 5))` plus 0–20% jitter, scheduled via `lifecycle.scheduleReconnect`.
3. If a transient reconnect storm emits many `session_sync_completed` events, the backend's S-5 reconcile single-flight coalesces them per `(owner, gateway_session_id)` — one active reconcile at a time, the rest are counted.
4. When the socket comes back, `connection.update {connection:'open'}` runs the same path as Flow A's step 5, but for a non-ephemeral session: no new public row (the existing one is rebound to the new socket generation if needed), no new pairing record, no consume.
5. Frontend `useLiveMode` revalidates on `ws_connected` and on the new `session_connected` event. `WhatsAppHubPage.loadConversations` is invoked by `scheduleBootstrapFetch` (2-second debounce). The `backgroundBackfillRef` is reset only on a user-initiated reload, not on a silent one.
6. Reconnect does NOT replay chats history; the user-driven or initial-sync-driven path does that. The cursor (`nextConvOffsetRef`) is preserved across reconnect, so the user's scroll position is not lost.

---

## 4. Protected Invariants

This section lists the behaviour that **MUST NOT REGRESS**. Each invariant states: what it is, where it lives, and the consequence of breaking it.

### PAIRING

- **INVARIANT: Zero `public.whatsapp_sessions` rows exist for a pairing that has not yet reached `connection.open`.**
  - CURRENT IMPLEMENTATION: `_ephemeral_pairings` + `public.ephemeral_pairings` (durable). `start_pairing_session` never INSERTs into `public.whatsapp_sessions`. The first INSERT happens in `promote_ephemeral_pairing` step 4 (Phase 6.8) or in `_map_session_event`'s relink branch, both gated by `connection.open`.
  - SOURCE: `backend/app/services/whatsapp/orchestration/sessions.py`, `backend/app/services/whatsapp/orchestration/promotion.py`, `backend/app/services/whatsapp/orchestration/pairing_registry.py`.
  - MUST NOT REGRESS: YES. Violating this lets a "paired but not connected" session pollute the Sessions tab and break the CONNECTED-only state machine.

- **INVARIANT: A `session_connected` event whose gateway UUID is not yet in `public.whatsapp_sessions` resolves its owner fail-closed from the pairing registry (in-memory → durable → explicit).**
  - CURRENT IMPLEMENTATION: `events._map_session_event` calls `promote_ephemeral_pairing` which delegates to `_resolve_owner`. If all three resolution paths miss, the function returns `None`, the event is logged, and a `RELINK_REQUIRED` row is NOT silently created.
  - SOURCE: `backend/app/services/whatsapp/orchestration/promotion.py::_resolve_owner` (lines 146–173), `backend/app/services/whatsapp/orchestration/pairing_registry.py::resolve_open_pairing`.
  - MUST NOT REGRESS: YES. The defect chain that produced "2 904 events dropped in 60 s" was driven by an unresolvable gateway UUID being silently assigned.

- **INVARIANT: A `cancel_pairing_session` call for a `pair_token` whose gateway has already reached `CONNECTED` MUST finalise the promotion and MUST NOT delete the socket.**
  - CURRENT IMPLEMENTATION: `orchestration.sessions.cancel_pairing_session` checks the gateway's own status; if `CONNECTED`, it calls `promote_ephemeral_pairing` and `consume_pairing`, then returns `{success: true, cancelled: false, promoted}`.
  - SOURCE: `backend/app/services/whatsapp/orchestration/sessions.py::cancel_pairing_session` (lines 457–552).
  - MUST NOT REGRESS: YES. Phase 6.8 was the production incident that demonstrated the previous behaviour destroyed a freshly-promoted socket 1.8 s after `connection.open`.

- **INVARIANT: The lease for a non-ephemeral session is acquired INSIDE the `connection.open` handler; ephemeral sessions acquire the lease during the promotion path.**
  - CURRENT IMPLEMENTATION: `socket/socket-events.js::connection.update` `if (connection === 'open')` block.
  - SOURCE: `whatsapp-gateway/src/socket/socket-events.js` (lines 240–263).
  - MUST NOT REGRESS: YES. The lease's TTL is the single point of multi-instance ownership; acquiring it before `open` invites races.

- **INVARIANT (Phase 1.1 + Phase 1.1 CLOSURE): The `CONNECTED` state in `public.whatsapp_sessions` is the product of two separately-enforced responsibilities. The list call only checks the external (backend-visible) truth; lifecycle correctness is enforced inside the gateway.**

  ### External truth — checked by the backend's `_list_sessions_internal` reconciliation

  A row's `public.whatsapp_sessions.status` is the public truth the UI sees. To be allowed to read `CONNECTED` on a list call, ALL of the following must hold. If any one of them is false, the row is demoted during that same list call (and the demote is broadcast to connected UIs over the `session_updated` WS event).

  1. A `public.whatsapp_sessions` row exists with `status=CONNECTED` (the row itself, not the truth of its status; the row's status is the very thing being checked here).
  2. The gateway's `GET /sessions` list contains a session whose `id` matches the row's `gateway_id`.
  3. A row in `whatsapp_private.socket_leases` with `session_id = row.gateway_id` AND `expires_at > NOW()` exists. (Lease truthfulness.)
  4. The DB lease read SUCCEEDED. A read failure does NOT satisfy (3) — it is "lease truth unknown for this call", not "lease missing".

  ### Lifecycle invariant — enforced inside the gateway (NOT by the list call)

  A `CONNECTED` row is only ever allowed to receive the next event if the gateway's in-memory `SocketLifecycle` has the current generation attached for the row's `gateway_id`, and if the socket emitting the event is bound to that generation. This is enforced by:

  - `SocketLifecycle.isCurrent(generation, sock)` checks in every event handler.
  - Stale-event guards in `loseLease`, `acquireLease` onContended, and the `_startSocket` reconnect timer.
  - Phase 1 §1 closure-on-`._deleted` checks in every async callback.
  - The `instance_id + generation` columns on `socket_leases` (multi-instance ownership).

  The list call does NOT directly verify (4). The list call is sufficient to keep the row truthful against the next `session_*` event that the gateway will emit, because the gateway-side guards above filter stale events before they reach `_map_session_event`.

  ### Failure-mode mapping (list call demote, ordered by severity)

  - (1) absent → no row; nothing to demote.
  - (2) absent + (1) `CONNECTED` → demote to `RELINK_REQUIRED`, `error_message="WHATSAPP_GATEWAY_SESSION_MISSING"` (Phase 1 §13).
  - (3) absent + (1) `CONNECTED` + (2) present + gateway reports `CONNECTED` + (4) DB read succeeded → demote to `DISCONNECTED`, `error_message="WHATSAPP_LEASE_LOST"`, `error_reason='LEASE_LOST'`. A WS `session_updated` broadcast is emitted on that call.
  - (3) absent + (1) `CONNECTED` + (2) present + gateway reports `CONNECTING` → leave as `CONNECTING` (transient reconnect, E/F). The lease is intentionally still held during the in-flight replacement; demoting here would cause a false `RELINK_REQUIRED`.
  - (3) absent + (1) `CONNECTED` + (2) present + gateway reports `RESTORING` / `DISCONNECTED` / `BANNED` → already handled by the gateway-status branch above; the row follows the gateway.
  - (3) `None` (DB read failed) + (1) `CONNECTED` + (2) present + gateway reports `CONNECTED` → **DO NOT demote**. Lease truth is unknown for this call. The reconciliation is deferred to the next successful read. The row stays `CONNECTED` until the next read either proves the lease is gone (then demotes) or proves it is still held (then keeps it).

  ### State semantics — gateway `UNAVAILABLE` vs backend `DISCONNECTED`

  These are two distinct semantic states living in two different layers. They are NOT used interchangeably.

  - Gateway in-memory `UNAVAILABLE` is set in three places, all in `whatsapp-gateway/src/session-manager.js`:
    - `WHATSAPP_AUTH_STORE_UNAVAILABLE` (auth store path failure; auth-retry tries to recover).
    - Auth-retry path: if a session is `UNAVAILABLE` and `_deleted=false` and `is_active=true`, a retry is scheduled.
    - The `loseLease` callback (Phase 1). The gateway in-memory state is set to `UNAVAILABLE` because the lease-loss is a *transient* owner-loss — a future `_startSocket` may recover. `UNAVAILABLE` does not propagate to the backend DB as `UNAVAILABLE`; it propagates only when `_map_session_event` processes the next `session_disconnected` event the gateway emits.
  - Backend `public.whatsapp_sessions.status = DISCONNECTED` is the user-facing truth. The list-call lease demote writes `DISCONNECTED` with `error_reason='LEASE_LOST'` because that is the backend-side semantic the UI understands as "this line is no longer connected; re-pair". The backend has no use for the gateway's `UNAVAILABLE` value (it is not a member of `SessionStatus`).
  - Consequence: a gateway `UNAVAILABLE` row is not necessarily a backend `DISCONNECTED` row. The list-call lease demote is the only path that writes `DISCONNECTED + LEASE_LOST`; it is the path the UI relies on for "lease loss was verified by the DB".

  ### Event timing — what `session_updated` does and does NOT guarantee

  The `session_updated(DISCONNECTED + LEASE_LOST)` broadcast is emitted from the **list call**, on a successful reconciliation. It is NOT emitted from the gateway's `loseLease` callback (that callback does not emit a backend event). The actual delivery latency therefore matches the list-call interval (typically 30–60 s for a page-load UI; a connected UI sees it as soon as the list call that produced the demote completes).

  - The right way to describe this in user-facing language: "lease loss is demoted on the next successful list reconciliation; a `session_updated` broadcast is then sent to connected UIs."
  - The wrong way to describe this: "lease loss → immediate WS notification" or "CONNECTED + no lease → immediately demoted". Neither is what the implementation does.

  ### CURRENT IMPLEMENTATION

  - `services/whatsapp/orchestration/sessions.py::fetch_held_lease_gateway_ids(db) -> Optional[set]`
    - returns `set()` on a successful zero-row query
    - returns a non-empty `set` of held gateway ids on a successful query
    - returns `None` on a DB exception (read failure); the demote branch is bypassed
  - `services/whatsapp/orchestration/sessions.py::_list_sessions_internal`
    - reads the held-lease set once per list call
    - if `None`, skips the demote branch entirely for this call
    - if `set()`, runs the demote branch only for rows where the gateway still reports `CONNECTED` and the row's `gateway_id` is not in the held set

  ### SOURCE

  `backend/app/services/whatsapp/orchestration/sessions.py` (`fetch_held_lease_gateway_ids`, the `live` branch in `_list_sessions_internal`).

  ### MUST NOT REGRESS

  - A row whose gateway reported `CONNECTED` but whose lease had expired or been lost to a contending instance MUST be demoted to `DISCONNECTED + LEASE_LOST` on the next successful list call.
  - A DB read failure MUST NOT be interpreted as "no lease held"; healthy CONNECTED rows MUST stay `CONNECTED` on a failed read and the demote is deferred.
  - A transient reconnect (gateway reports `CONNECTING`) MUST NOT be demoted to `RELINK_REQUIRED` even if (somehow) the lease is unconfirmed for that call — the lease is intentionally still held during the in-flight replacement.

- **INVARIANT: `requestPairingCode` (8-digit code) is single-flight per `session_id` and is rejected if the session is already `CONNECTED`.**
  - CURRENT IMPLEMENTATION: `session-manager.requestPairingCode` (the `pairingCodeInFlight` Map) and `_requestPairingCodeOnce` `if (session.status === 'CONNECTED') throw`.
  - SOURCE: `whatsapp-gateway/src/session-manager.js` (lines 362–407).
  - MUST NOT REGRESS: YES.

- **INVARIANT: A QR refresh while the session is `CONNECTED` is a no-op (does NOT re-create the socket).**
  - CURRENT IMPLEMENTATION: `session-manager.refreshQr` early-returns when `status === 'CONNECTED'`.
  - SOURCE: `whatsapp-gateway/src/session-manager.js::refreshQr` (lines 332–360).
  - MUST NOT REGRESS: YES.

- **INVARIANT: 515/`restartRequired` is a fast 500 ms reconnect; `loggedOut`/`badSession` is terminal and the auth state is destroyed; transient is exponential backoff with jitter up to 30 s.**
  - CURRENT IMPLEMENTATION: `socket-events.js::connection.update` `connection === 'close'` branch.
  - SOURCE: `whatsapp-gateway/src/socket/socket-events.js` (lines 290–372).
  - MUST NOT REGRESS: YES.

- **INVARIANT: `WhatsAppApi.startPairing` / `startSync` / `markAsRead` etc. all `await requireLive()` from the repository — the UI cannot reach the gateway without a healthy `GET /whatsapp/gateway/health` probe.**
  - CURRENT IMPLEMENTATION: `whatsappRepository.ts::requireLive` and `whatsappApi.ts::probeLive` cache for 30 s; the probe is revalidated only on `LIVE_SESSION_EVENTS` and `ws_connected` (no setInterval).
  - SOURCE: `frontend/src/features/whatsapp/data/whatsappRepository.ts` (lines 49–55), `frontend/src/features/whatsapp/api/whatsappApi.ts` (lines 47–85, 360–409).
  - MUST NOT REGRESS: YES. A polling probe was a previous network-storm source.

### IDENTITY

- **INVARIANT: `jid_to_phone` returns `None` for `@lid`, `@g.us`, and any JID with < 5 digits or all-zero digits. No fake phone numbers are ever synthesised.**
  - CURRENT IMPLEMENTATION: `services/whatsapp/identity.py::jid_to_phone`, `is_degenerate_jid`.
  - SOURCE: `backend/app/services/whatsapp/identity.py` (lines 23–60).
  - MUST NOT REGRESS: YES. AGENTS.md §1.3 is a hard invariant.

- **INVARIANT: A contact's `display_name` is NEVER set to a `push_name` on a stranger's chat. The `push_name` lives in `custom_attributes.push_name` and is used only as a display fallback when the phone is unresolvable (LID with no mapping).**
  - CURRENT IMPLEMENTATION: `services/whatsapp/orchestration/events.py::_upsert_contact` (the `is_push_name` check) and `services/whatsapp/identity.py::safe_display_name`.
  - SOURCE: `backend/app/services/whatsapp/orchestration/events.py` (lines 232–270), `backend/app/services/whatsapp/identity.py` (lines 106–141).
  - MUST NOT REGRESS: YES. AGENTS.md §1.1 truthfulness depends on it.

- **INVARIANT: LID → phone mapping is tenant-scoped. The resolver prefers the caller's own session and stops at the tenant boundary.**
  - CURRENT IMPLEMENTATION: `services/whatsapp/repositories/lid_mappings.py::resolve_lid_phone` plus the owner-resolved `gateway_session_id`.
  - SOURCE: `backend/app/services/whatsapp/repositories/lid_mappings.py`, `backend/app/services/whatsapp/orchestration/events.py::_upsert_contact` `@lid` branch.
  - MUST NOT REGRESS: YES. G-3 — a tenant once read another tenant's LID mapping.

- **INVARIANT: When a contact has both a raw-JID name (`…@lid`, `…@c.us`, `jid:…`) AND a real name, the real name wins. Raw-JID strings never reach the UI.**
  - CURRENT IMPLEMENTATION: `identity.safe_display_name` returns `None` for raw-JID-shaped names; `_resolve_contact_identity` checks `is_raw_jid_name`.
  - SOURCE: `backend/app/services/whatsapp/identity.py::is_raw_jid_name`, `safe_display_name`, `resolve_contact_identity`.
  - MUST NOT REGRESS: YES.

- **INVARIANT: Group subjects (`@g.us`) are NEVER derived to a phone number.**
  - CURRENT IMPLEMENTATION: `identity.jid_to_phone` returns `None` for `@g.us`. `contact_phone_for_jid` returns `f"jid:{jid}"` for groups.
  - SOURCE: `backend/app/services/whatsapp/identity.py` (lines 36–39, 144–154).
  - MUST NOT REGRESS: YES. Otherwise the UI shows `+1203632…` for groups.

- **INVARIANT: Self-identity reconciliation deletes the LID/duplicate-PN contact + conversation rows for the session's own phone in the SAME transaction.**
  - CURRENT IMPLEMENTATION: `events.reconcile_self_identity` moves messages and deletes the duplicate conversation + (if orphaned) contact in one `await db.commit()`.
  - SOURCE: `backend/app/services/whatsapp/orchestration/events.py` (lines 858–1017).
  - MUST NOT REGRESS: YES. A partial reconciliation would produce a second row for the user's own number.

### MESSAGES

- **INVARIANT: A `wa_message_id` is unique ONLY within a single conversation. The same `wa_message_id` MAY legally exist in two different conversations during a LID → PN key migration.**
  - CURRENT IMPLEMENTATION: `Message` partial unique index `uq_msg_conv_wa_message_id` is `(conversation_id, wa_message_id)` with `WHERE wa_message_id IS NOT NULL`.
  - SOURCE: `backend/app/models/message.py` (lines 115–122), `backend/app/services/whatsapp/orchestration/events.py::reconcile_legacy_split_conversation`.
  - MUST NOT REGRESS: YES. A global unique index would break the LID→PN migration.

- **INVARIANT: A `client_message_id` is unique ONLY within a single conversation. Idempotency on send is conversation-scoped, not global.**
  - CURRENT IMPLEMENTATION: `Message` partial unique index `uq_msg_conv_client_message_id` is `(conversation_id, client_message_id)`.
  - SOURCE: `backend/app/models/message.py` (lines 97–104).
  - MUST NOT REGRESS: YES.

- **INVARIANT: An optimistic message in the UI carries a `client_message_id` (e.g. `cmsg_…`, `tmpl_…`, `media_…`, `file_…`) and a string `id` (`optimistic_<client_mid>`). It is reconciled with the backend response by `client_message_id` (or `id` if the response carries the optimistic id). The optimistic id is NEVER used as a numeric DB id.**
  - CURRENT IMPLEMENTATION: `frontend/src/pages/WhatsAppHubPage.tsx` (`activeSendMessage`, `activeSendMedia`, `activeSendTemplate`, `activeRetryMessage`) and `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts::sendMessage`. `useWhatsAppConversation.retryMessage` refuses to retry an optimistic row by re-POSTing with the existing `client_message_id`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 832–919, 921–966, 968–1031, 1033–1101, 1103–1155), `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` (lines 184–312).
  - MUST NOT REGRESS: YES.

- **INVARIANT: `loadOlderMessages` (and `activeLoadOlder` in the page) uses ONLY real numeric DB ids as the `before` cursor. A string optimistic id is never sent as `before`.**
  - CURRENT IMPLEMENTATION: `useWhatsAppConversation.ts::loadOlderMessages` finds `firstNumericId`; `WhatsAppHubPage.tsx::activeLoadOlder` uses `activePaging.oldest` from the server.
  - SOURCE: `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` (lines 101–151), `frontend/src/pages/WhatsAppHubPage.tsx` (lines 325–364).
  - MUST NOT REGRESS: YES.

- **INVARIANT: Status transitions are monotonic: `PENDING(0) → SENT(1) → DELIVERED(2) → READ(3)`; `FAILED(0)` is reachable only from `PENDING`. A `message_status_updated` event with a lower rank than the current is ignored.**
  - CURRENT IMPLEMENTATION: `services/whatsapp/status_policy.py::advance_message_status` and gateway `_applyMessageAck` `if (ACK_ORDER[newStatus] <= (ACK_ORDER[msg.status] ?? 0)) return`.
  - SOURCE: `backend/app/services/whatsapp/status_policy.py`, `whatsapp-gateway/src/session-manager.js::_applyMessageAck` (lines 1106–1123), `whatsapp-gateway/src/session-manager.js::_confirmOutboundSent`.
  - MUST NOT REGRESS: YES.

- **INVARIANT: An inbound message that is being shown in the active chat auto-marks the conversation read. If the gateway call fails, the read is silently dropped (logged) — NOT surfaced as a toast (spam avoidance).**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx::handleWsEvent` `if (!isOutbound) { … markConversationAsRead(convId).then(reportReadSync).catch(...) }`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 1337–1344).
  - MUST NOT REGRESS: YES.

- **INVARIANT: A user-driven mark-read (clicking a conversation) does surface a `readSyncFailed` toast on `success=false`. Truthfulness — see AGENTS.md §1.1.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx::reportReadSync({notify: true})`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 204–216, 726–736).
  - MUST NOT REGRESS: YES.

- **INVARIANT: A history-pagination failure on a single conversation does NOT clear the existing messages and does NOT block other conversations. The error is per-conversation retryable.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx::activeLoadOlder` sets `messagePaging[convId].error = true`; `hydrateConversationMessages` sets `messageLoadState[convId] = 'error'` without mutating `messagesMap[convId]`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 325–364, 647–709).
  - MUST NOT REGRESS: YES. AGENTS.md §1.1 — no false-positive failure.

- **INVARIANT: Conversation ordering is strictly by `last_message_at DESC, created_at DESC`. The UI never re-sorts by `message_count`, `unread_count`, or any other field.**
  - CURRENT IMPLEMENTATION: `frontend/src/features/whatsapp/lib/whatsappOrdering.ts::compareConversationsByActivityDesc` is the SINGLE sort key; the page uses it for every sort. Backend `_persist_chat_snapshot` writes the persisted `last_message_at` to the WS payload, not the gateway's value (H-6).
  - SOURCE: `frontend/src/features/whatsapp/lib/whatsappOrdering.ts`, `frontend/src/pages/WhatsAppHubPage.tsx`, `backend/app/services/whatsapp/orchestration/sync.py::_persist_chat_snapshot` (lines 772–806).
  - MUST NOT REGRESS: YES.

- **INVARIANT: `last_message_at` and `last_message_preview` are TWO INDEPENDENT decisions. An empty preview MUST NEVER block the activity timestamp.**
  - CURRENT IMPLEMENTATION: `repositories/conversations.py::apply_conversation_last_message` advances `last_message_at` whenever `ts` is strictly newer (or the existing is null), and consults `should_apply_last_message` **only** for the preview. Both snapshot sites in `orchestration/sync.py` (`_persist_chat_snapshot` ~L887 and `sync_session_history` ~L1733) apply `gw_ts` in an `elif gw_ts is not None …` branch that sits **outside** `if gw_summary:`. `ts is None` never seeds a stamp (Faz 10 RC-1: no future-timestamp seeding).
  - WHY: a message carrying no text — a reaction, `protocolMessage` REVOKE ("you deleted this message"), a call log, a `messageStubType` group notice (settings change / participant added / username created), an audio-only last message — yields an empty summary. Gating the stamp on the summary froze exactly those chats at their old list position while the rest of the list stayed correct (live 2026-09-26: conv 14458 "Hat 1" pinned at 09:35:56 with its newest message at 09:44:25; 21 of 113 chats had an empty preview, 5 had a null stamp). The asymmetry is the tell: `events.py::_map_conversation_event` applied `last_message_at` unconditionally, which is why most chats looked right and only the notification-only ones were wrong.
  - SOURCE: `backend/app/services/whatsapp/repositories/conversations.py`, `backend/app/services/whatsapp/orchestration/sync.py`, `backend/tests/test_whatsapp_tenant_isolation.py::test_apply_last_message_empty_summary_keeps_preview_but_advances_stamp`, `backend/tests/test_whatsapp_phase2_b_sync_reconciliation.py::test_snapshot_with_empty_preview_still_applies_timestamp`.
  - MUST NOT REGRESS: YES. Re-coupling them silently sinks every notification-only chat to the bottom of the list.

- **INVARIANT: text-less system content gets a bracketed `[MARKER]` preview body; `message_type` is NEVER widened for it.**
  - CURRENT IMPLEMENTATION: `MessageType` has no `SYSTEM`/`REACTION` member and adding one needs a migration, so the marker travels in `body` and is resolved by `normalizePreviewText` through the label table. `systemContentMarker()` is the single producer; the gateway live path (`session-manager.js::_ingestUpsertMessage`) falls back to it when `buildChatPreview` yields nothing. Trigger: `messageStubType > 0` (may be a protobuf `Long` — use `toNumber()`), or `protocolMessage` present (`type === 0` = REVOKE, else SYSTEM), or reaction / call / poll / event content. `messageStubType` `0` or absent means "not a stub" and MUST produce **no** marker — never fabricate one for ordinary text.
  - THREE PARALLEL LABEL TABLES must stay in parity: gateway `whatsapp-formatting.js`, backend `preview_normalization.py`, frontend `whatsappPreview.ts`. The frontend copy had already drifted six labels behind (it would have rendered the generic "Mesaj"); when adding a kind, update all three plus `frontend/src/locales/{en,tr}.ts`.
  - SOURCE: `whatsapp-gateway/src/messages/message-classifier.js`, `whatsapp-gateway/scripts/test-system-content-preview.mjs` (14 checks, in the `npm test` chain), `frontend/src/features/whatsapp/lib/whatsappPreview.ts`.
  - MUST NOT REGRESS: YES.

- **INVARIANT: A replayed WS event does NOT increment `message_count` or `unread_count`. The `seenWaMessageIdsRef` ring (1000 entries) is the only replay-suppression mechanism.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx::rememberWaMessageId` and the `isReplayedEvent` branch in `handleWsEvent`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 244–260, 1203–1280).
  - MUST NOT REGRESS: YES.

- **INVARIANT: A `last_message_at` update is applied iff it is strictly newer than the existing `last_message_at` (or the existing is null). The preview is a separate decision driven by `shouldApplyPreview`.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx::handleWsEvent` separates `tsFresh = shouldApplyPreview(msgTime, existing.last_message_at)` from the preview decision.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 1250–1269), `frontend/src/features/whatsapp/lib/whatsappPreview.ts::shouldApplyPreview`.
  - MUST NOT REGRESS: YES. A late WS event should not bump a chat to the top.

### FRONTEND

- **INVARIANT: `selectedConv.id` is the key for `<ChatThread>` AND `<ChatComposer>` (P6-4). A selection change MUST unmount the previous and mount the new so that scroll state (`isNearBottom`, `initialScrollDoneRef`, `pendingPrependRef`, `isPrependingRef`) and the draft are reset. A list reorder that keeps the same `selectedConv.id` MUST NOT remount.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx:2327–2328` (ChatThread `key={selectedConv.id}`), `WhatsAppHubPage.tsx:2359–2360` (ChatComposer `key={selectedConv.id}`). The page also renders `<ChatThread messages={messagesMap[selectedConv.id] ?? []}>`; the `useEffect` on `[selectedConv?.id, ...]` runs `hydrateConversationMessages(convId)`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 311–323, 719–739, 2327–2360).
  - MUST NOT REGRESS: YES. Removing the key re-introduces "send the previous draft to the new chat" + "new chat opens mid-history". Adding a different changing-value key remounts on every inbound and breaks prepend-anchor scroll restoration. See §7 for the full state rationale.

- **INVARIANT: Per-conversation `messageLoadState` is tracked in a `Record<number, 'loading'|'ready'|'error'>` map, not a single boolean. A single conversation's hydration failure MUST NOT collapse the entire chat UI to an error state.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx::messageLoadState`, `messageLoadError`, `messagePaging`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 152–153, 647–709).
  - MUST NOT REGRESS: YES. AGENTS.md §1.1.

- **INVARIANT: The conversation list's `convLoadState` separates `'loading' | 'ready' | 'error'`. The empty state is shown ONLY when `state === 'ready' && items.length === 0`. A first-load error is a separate state with a toast.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx::convLoadState`, `convLoadError`, the empty-state branch in `ConversationList`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 150–151, 380–474), `frontend/src/features/whatsapp/components/ConversationList.tsx`.
  - MUST NOT REGRESS: YES.

- **INVARIANT: User-typed search is debounced (300 ms) before triggering a list reload. Polling MUST NOT replace events.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx` useEffect with `setTimeout(..., convSearch ? 300 : 0)`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 637–642).
  - MUST NOT REGRESS: YES.

- **INVARIANT: A draft message is per-conversation. Switching conversations does NOT clear another conversation's draft.**
  - CURRENT IMPLEMENTATION: `ChatComposer` state is owned by the composer; the page passes `selectedConv` as the key. (Per-conversation draft storage lives in `ChatComposer` itself; verify any future refactor preserves this.)
  - SOURCE: `frontend/src/features/whatsapp/components/ChatComposer.tsx` (560 lines), `frontend/src/pages/WhatsAppHubPage.tsx` (renders composer below `ChatThread`).
  - MUST NOT REGRESS: YES.

- **INVARIANT: Scroll position is preserved across a prepend via `prevScrollHeightRef + scrollTop + (newHeight − prevHeight)`. The `pendingPrependRef` snapshot disambiguates a real prepend from an unrelated re-render.**
  - CURRENT IMPLEMENTATION: `ChatThread.tsx`.
  - SOURCE: `frontend/src/features/whatsapp/components/ChatThread.tsx` (lines 65–123).
  - MUST NOT REGRESS: YES.

- **INVARIANT: A live WS event's `last_message_at`/`preview` is merged into the canonical conversation via `applyConversationEvent` (single helper). No ad-hoc local merges outside the helper.**
  - CURRENT IMPLEMENTATION: `frontend/src/features/whatsapp/lib/whatsappConversationPatch.ts::applyConversationEvent`. The page calls this in the `conversation_updated`/`presence_updated` branches of `handleWsEvent`.
  - SOURCE: `frontend/src/features/whatsapp/lib/whatsappConversationPatch.ts`, `frontend/src/pages/WhatsAppHubPage.tsx`.
  - MUST NOT REGRESS: YES.

- **INVARIANT: A live WS event's `message_new` is merged into the messages array via `mergeWhatsAppMessages`. No ad-hoc local `findIndex` merges.**
  - CURRENT IMPLEMENTATION: `frontend/src/features/whatsapp/lib/whatsappMessageMerge.ts::mergeWhatsAppMessages` (P6-6: the single canonical merger).
  - SOURCE: `frontend/src/features/whatsapp/lib/whatsappMessageMerge.ts`, `frontend/src/pages/WhatsAppHubPage.tsx` (line 1334), `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts`.
  - MUST NOT REGRESS: YES.

- **INVARIANT: Hardcoded user-facing strings are forbidden. Every label, toast, badge, and placeholder flows through `useI18n().t('domain.key')`.**
  - CURRENT IMPLEMENTATION: `frontend/src/locales/{en,tr}.json`, `useI18n` in every component. `AGENTS.md §3.`
  - SOURCE: `AGENTS.md`, `frontend/src/context/I18nContext.tsx`, all components in `frontend/src/features/whatsapp/components/`.
  - MUST NOT REGRESS: YES.

- **INVARIANT: The `useLiveMode` hook does NOT poll. Re-probe happens only on `ws_connected` and `LIVE_SESSION_EVENTS` (`session_connected`/`session_disconnected`/`session_deleted`/`session_qr_updated`/`session_sync_completed`/`gateway_connected`).**
  - CURRENT IMPLEMENTATION: `frontend/src/features/whatsapp/api/whatsappApi.ts::useLiveMode`.
  - SOURCE: `frontend/src/features/whatsapp/api/whatsappApi.ts` (lines 357–409).
  - MUST NOT REGRESS: YES. A `setInterval(probe, 30_000)` was a previous network-storm source.

- **INVARIANT: A FAILED sync job banner is acknowledged in `sessionStorage` (`tezlify_wa_failed_sync_ack`) once shown. It does NOT re-render on every page load for the same `sync_id | finished_at`.**
  - CURRENT IMPLEMENTATION: `WhatsAppHubPage.tsx::acknowledgeFailedSync`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 536–556, 588–600).
  - MUST NOT REGRESS: YES.

- **INVARIANT: Hardcoded user-facing numbers (e.g. page sizes) MUST come from a module-level constant. Inline `200` / `50` / `1000` magic numbers are forbidden.**
  - CURRENT IMPLEMENTATION: `CONVERSATION_PAGE_SIZE = 200`, `MAX_BACKGROUND_CONVERSATION_PAGES = 5`, `SEEN_WA_IDS_MAX = 1000` in `WhatsAppHubPage.tsx`; `_SYNC_BULK_PAGE_SIZE = 1000`, `_SYNC_PERSIST_BATCH = 200`, `_SYNC_EVENT_CHUNK = 100`, `_SYNC_CHAT_PAGE_SIZE = 40`, `_SYNC_PER_CHAT_LIMIT = 50` in `sync.py`.
  - SOURCE: `frontend/src/pages/WhatsAppHubPage.tsx` (lines 111–118), `backend/app/services/whatsapp/orchestration/sync.py` (lines 94–105).
  - MUST NOT REGRESS: YES.

---

## 5. Domain Model

The two principal aggregates are **Conversation** and **Message**. They are deliberately distinct: a Conversation is the chat thread, a Message is one entry in that thread. The contact is a third, denormalised-looking-but-actually-canonical aggregate, joined to Conversation by `contact_id`.

### Conversation identity

| Field | Type | Source of truth | Notes |
| --- | --- | --- | --- |
| `id` | `int` PK | `public.conversations.id` | The numeric id the UI uses everywhere (`selectedConv.id`, `messagesMap[id]`, `messagePaging[id]`). |
| `user_id` | `Uuid` (stored as `Uuid(as_uuid=False)`) | `public.conversations.user_id` | Tenant scope. |
| `session_id` | `int?` FK → `whatsapp_sessions.id` | DB | **Nullable for legacy rows.** The line that owns the conversation. |
| `contact_id` | `int?` FK → `contacts.id` | DB | Nullable only for systems-migrated rows. |
| `lead_id` | `int?` FK → `leads.id` | DB | CRM linkage, optional. |
| `channel` | `str(30)` | DB, default `WHATSAPP` | Multi-channel; only WHATSAPP is implemented. |
| `status` | `ConversationStatus` enum | DB | `ACTIVE | ARCHIVED | CLOSED`. CRM-level; not WhatsApp archive. |
| `is_group` | `bool` | DB, persistent column | Source: Baileys `'@g.us'` in JID or `chat.is_group`. |
| `is_archived` | `bool` | DB, persistent column | Source: Baileys `chat.archived`. Distinct from `status=ARCHIVED`. |
| `last_message_at` | `DateTime?` | DB | `idx_conv_last_msg_at` index. Single sort key. |
| `last_message_preview` | `Text?` | DB | Capped at 500 chars by `apply_conversation_last_message`. |
| `unread_count` | `int` | DB | Monotonic by `should_apply_unread_count`. May go DOWN. |
| `last_read_at` | `DateTime?` | DB | Stamped on `unread_count` dropping to 0 — the read evidence that protects against stale snapshot resurrection. |
| `archived_at` | `DateTime?` | DB | Stamped when `status=ARCHIVED` is set. |
| `closed_at` | `DateTime?` | DB | Stamped when `status=CLOSED` is set. |

**Canonical identity:** `id`. The JID/LID/phone is the *gateway* identifier; the conversation id is the *backend* identifier. The mapping lives in the DB (via the `Contact` join). The UI MUST key by `id`, never by JID.

### Contact identity

| Field | Type | Source of truth | Notes |
| --- | --- | --- | --- |
| `id` | `int` PK | `public.contacts.id` | |
| `user_id` | `Uuid` | DB | |
| `phone_e164` | `str(50)` | DB, **unique per user** | The normalised E.164 phone. Group JIDs stored as `jid:<raw>`. LIDs stored as `jid:<raw>` until mapped. |
| `display_name` | `str(150)?` | DB | NEVER a push name. |
| `custom_attributes` | `JSON?` | DB | `{name_source, push_name, avatar_url, …}`. |
| `lead_id` | `int?` FK | DB | Optional CRM link. |

### Message identity

| Field | Type | Source of truth | Notes |
| --- | --- | --- | --- |
| `id` | `int` PK (autoincrement) | `public.messages.id` | Real numeric DB id. Replaces the optimistic `optimistic_<client_mid>` string id at reconciliation time. |
| `user_id` | `Uuid` | DB | Tenant scope. |
| `conversation_id` | `int` FK → `conversations.id` | DB | The conversation the message belongs to. |
| `direction` | `MessageDirection` | DB | `INBOUND | OUTBOUND`. |
| `message_type` | `MessageType` | DB | TEXT, IMAGE, DOCUMENT, AUDIO, VIDEO, STICKER, LOCATION, CONTACT, TEMPLATE, UNKNOWN, OTHER. |
| `body` | `Text?` | DB | Capped at 4000 chars in ingest. |
| `client_message_id` | `str(100)?` | DB | UI-supplied idempotency key. UNIQUE per conversation. |
| `wa_message_id` | `str(255)?` | DB | Provider-supplied id. UNIQUE per conversation. |
| `media_id` | `str(255)?` | DB | Gateway media file id. |
| `sender_phone` | `str(50)?` | DB | **Nullable** — LID senders are NULL. |
| `recipient_phone` | `str(50)` | DB | NOT NULL. |
| `sender_name` | `str(100)?` | DB | `ME` for outbound. |
| `status` | `ConversationMessageStatus` | DB | PENDING, SENT, DELIVERED, READ, FAILED, RECEIVED. |
| `sent_at` / `delivered_at` / `read_at` / `failed_at` | `DateTime?` | DB | Granular lifecycle. |
| `external_timestamp` | `DateTime?` | DB | Provider-supplied (preserved). |
| `created_at` / `updated_at` | `DateTime` | DB | DB stamps. |

**Canonical identity:** `id`. The `client_message_id` and `wa_message_id` are dedup keys, NOT primary keys. A message may be in the UI by any of three keys (id / wa_message_id / client_message_id) at any given time, and `mergeWhatsAppMessages` is the only function that collapses them.

---

## 6. Conversation State Model

The page's `conversations: Conversation[]` array is the single canonical list. Each `Conversation` is the **frontend-shaped** projection of the backend `BackendConversation` produced by `mapConversation` (partial-merge: only fields that are `!== undefined` are copied; `null` IS authoritative).

```ts
// Frontend `Conversation` (whatsappApi.ts)
interface Conversation {
  id: number;                  // CANONICAL
  channel: 'WHATSAPP';
  session_id: number | null;
  contact_id: number | null;
  lead_id: number | null;
  status: ConversationStatus;  // ACTIVE | ARCHIVED | CLOSED
  unread_count: number;
  is_group: boolean;
  is_archived: boolean;
  lead_name?: string;          // mapped from c.name
  lead_phone?: string;         // mapped from c.phone
  identity_state?: string;     // RESOLVED_PROFILE | RESOLVED_PHONE | RESOLVED_JID | RESOLVING_TRANSIENT | UNRESOLVED_PERMANENT
  lead_avatar_url?: string;
  last_message_preview?: string;
  last_message_state?: 'RESOLVED' | 'REPAIRING';
  message_count: number;
  last_message_at?: string;    // ISO timestamp
  created_at?: string;
  updated_at?: string;
}
```

**Minimum data for a row to appear in the list:** a backend `BackendConversation` payload with `id` (numeric, the DB id) and at least a `phone` or a `name` from the contact. The `name` is resolved by `safe_display_name` / `resolve_contact_identity` server-side. A row with `name = null`, `phone = null`, and `last_message_preview = null` still appears (e.g. a group with a `last_message_at` from history sync), but it has no display text.

**Path that causes a conversation to NOT appear in the list:**

1. **Filter mismatch.** The list query passes `group_only=true`/`archived_only=true`/`unread_only=true`/`status=…` server-side; a conversation that does not match the filter is not returned. Switching filter tabs is the user-visible reason.
2. **Pagination truncation.** The backend returns `has_more=true` when `offset + len(items) < total`. The frontend retains non-returned rows from the prior state on the first page (so a row that the user just had is not silently removed by a silent refresh) but the BACKGROUND FILL is bounded by `MAX_BACKGROUND_CONVERSATION_PAGES = 5`. Beyond 5 pages (~1000 rows) the user must scroll/search to see more.
3. **Sync absence.** If the gateway is in `SCAN_QR`/`RESTORING`/`UNAVAILABLE`, the in-memory gateway chats Map is empty; the sync has not yet persisted conversations. The user sees an empty list (or whatever was persisted from a prior connection).
4. **Hard filter — broadcast/degenerate/group subject without a row.** A `status@broadcast` or `@newsletter` JID is rejected by `is_broadcast_only_jid`. A degenerate JID is rejected by `is_degenerate_jid`. These never create a row.
5. **Tenant scoping.** Every list query goes through `get_user_filter(Conversation.user_id, user_id)`. A conversation that belongs to a different tenant is invisible to the query.
6. **No contact, no conversation.** An inbound event with a JID that does not match any existing contact is upserted via `_upsert_contact` (LID mapping → phone). A conversation is created lazily by `_ensure_conversation_race_safe` on the FIRST message or `conversation_updated` for that contact. So a contact that has never received or sent a message has no conversation row. (This is the "3Hacker grubu görünmüyor" case — see §10.)

---

## 7. Chat View State Model

The chat-pane side of the page holds:

```ts
selectedConv: Conversation | null;          // the ONE active chat
messagesMap: Record<number, Message[]>;     // per-conversation message list
messagePaging: Record<number, { hasMore: boolean; oldest?: number; loading: boolean; error?: boolean }>;
messageLoadState: Record<number, 'loading' | 'ready' | 'error'>;
messageLoadError: Record<number, string>;
peerTypingMap: Record<number, boolean>;     // F-11: TTL-pruned every 2 s
peerTypingExpiryRef: Record<number, number>;
```

**`selectedConv.id` is the single keying field** for the chat view. The page's `useEffect([selectedConv?.id, ...])` runs the message hydration for the new conversation. The `ChatThread` is rendered unconditionally with the current `selectedConv.id`; it does not maintain per-conversation instance state.

### A → B → C conversation switching

> **Contract consistency note (Phase 1 §1):** The text below replaces an earlier contradiction in this section. The previous wording claimed that the page renders a SINGLE `ChatThread` instance and that keying by `selectedConv.id` would be a regression. The source code shows the opposite is true, and was committed as P6-4. The correct contract is stated here.

**CURRENT REAL IMPLEMENTATION** (`frontend/src/pages/WhatsAppHubPage.tsx:2327–2328, 2359–2360`):

```tsx
<ChatThread
  key={selectedConv.id}
  messages={activeMessages}
  ...
/>
<ChatComposer
  key={selectedConv.id}
  onSend={...}
/>
```

Both `ChatThread` AND `ChatComposer` are explicitly keyed by `selectedConv.id`. A → B → C switching triggers a React unmount/remount of both.

**PROTECTED BEHAVIOR** (the P6-4 reason that justifies the key, and what MUST NOT regress):

- The `ChatThread` component holds four pieces of state that MUST be cleared on a conversation switch: `isNearBottom` (where in the previous chat the user was), `initialScrollDoneRef` (whether the first scroll settled), `pendingPrependRef` (an in-flight prepend anchor), and `isPrependingRef` (the prepend guard). Without a `key`, switching A→B reuses the same `ChatThread` instance; B opens at the previous A viewport position and `isNearBottom` carries over so a B-inbound that should raise the "new message" pill is suppressed (or, conversely, B reuses A's scrollTop and renders mid-history).
- The `ChatComposer` owns the draft (`text`, `pendingFile`, caption). Without a `key`, the A draft leaks into B and `onSend` dispatches to the SELECTED conversation (`activeSendMessage(selectedConv.id, ...)`), so the user would send A's draft to B.
- The reordering case (A stays open, a new inbound bumps a different conversation to the top of the list) does NOT change `selectedConv`, so it does NOT remount `ChatThread` — that is the intended P6-4 carve-out ("reordering keeps the same id").

**Number of `ChatThread` instances rendered at any time: at most 1 per `selectedConv.id`.** Switching unmounts the previous and mounts the new one. A list reorder does not remount.

**REGRESSION RISK:** A future refactor that REMOVES `key={selectedConv.id}` will re-introduce the "send the previous draft to the new chat" defect and the "new chat opens mid-history" defect. A future refactor that ADDS `key={someOtherChangingValue}` (e.g. `messages.length` or `last_message_at`) will remount the thread on every inbound — destroying the prepend-anchor (`pendingPrependRef`) so older-history pagination will jump the scroll position. Both are regressions and the contract below freezes against them.

**Where `selectedConversationId` is stored:** `WhatsAppHubPage.selectedConv` (a `useState<Conversation | null>`). The conversation is stored as a full object (not just an id) so the `ChatComposer` and `ChatThread` see the canonical `lead_phone` / `lead_name` / `is_group` without an extra lookup.

**How the previous state is cleared:** The `useEffect([selectedConv?.id, …])` does NOT explicitly clear `messagesMap[prevId]` — that data is retained for fast re-selection. The visual reset of the `ChatThread`/`ChatComposer` is the React key change (unmount + remount). The `ChatComposer` clears its own input on the new mount (initial `useState` reset).

---

## 8. Sync Limits

| Layer | Limit | Constant | Hard cap or page size? | Why |
| --- | --- | --- | --- | --- |
| Frontend conversation list first page | 200 | `CONVERSATION_PAGE_SIZE` in `WhatsAppHubPage.tsx` | **Page size** (not hard cap on the list — user can scroll to see up to 5 background-filled pages = 1000 rows) | WhatsApp Web parity: "show 200 then fill in the background"; bounded by `MAX_BACKGROUND_CONVERSATION_PAGES = 5`. |
| Frontend background backfill pages | 5 | `MAX_BACKGROUND_CONVERSATION_PAGES` | **Hard cap** (after 5 pages = ~1000 conversations, no more silent fill) | Mirrors WhatsApp Web's "show ~1000 then user must scroll" behaviour without runaway network. |
| Frontend seen-WS-id ring | 1000 | `SEEN_WA_IDS_MAX` | **Hard cap** | Bound memory for replay dedup; FIFO eviction at half. |
| Frontend history page (ChatThread scroll-up) | 50 | `limit: 50` in `activeLoadOlder` and `useWhatsAppConversation.loadOlderMessages` | **Page size** | 50 messages per scroll-up page keeps network round-trips small. |
| Frontend initial chat load | 50 | `limit: 50` in `hydrateConversationMessages` and `useWhatsAppConversation` | **Page size** (not a cap on what the system knows) | First page is 50; older history is loaded on scroll. |
| Frontend peer-typing TTL | 5000 ms (default; per call `duration_ms: 4000`) | `PEER_TYPING_TTL_MS` in `whatsappSync.ts` | **Hard cap** (lifetime of a typing state) | Single expiry map + 2-second sweep interval. |
| Backend GET /conversations default limit | 200 | `Query(200, ge=1, le=1000)` in `endpoints/whatsapp.py` | **Page size** (capped at 1000 per request by the `le=1000` validator) | UI default; the `le=1000` guard prevents a runaway page. |
| Backend GET /conversations max | 1000 | `Query(200, ge=1, le=1000)` | **Hard cap** | Refuses to serve more than 1000 per call. |
| Backend GET /messages default limit | 50 | `Query(50, ge=1, le=100)` in `endpoints/whatsapp.py` | **Page size** | 50 per page keeps `before` pagination cheap. |
| Backend GET /messages max | 100 | `Query(50, ge=1, le=100)` | **Hard cap** | 100 per call. |
| Backend sync — bulk page | 1000 | `_SYNC_BULK_PAGE_SIZE` in `sync.py` | **Page size** | Gateway's bulk endpoint page size. |
| Backend sync — persist batch | 200 | `_SYNC_PERSIST_BATCH` in `sync.py` | **Page size** | Dedup-SELECT + INSERT chunk size. |
| Backend sync — WS event chunk | 100 | `_SYNC_EVENT_CHUNK` in `sync.py` | **Page size** | Per-WS-event payload size. |
| Backend sync — chat snapshot page | 40 | `_SYNC_CHAT_PAGE_SIZE` in `sync.py` | **Page size** | `whatsapp_sync_chats_snapshot` events of 40 rows. |
| Backend sync — per-chat limit | 50 | `_SYNC_PER_CHAT_LIMIT` in `sync.py` | **Hard cap on the FIRST sync per chat** (per-chat history is the newest 50; older history is fetched on-demand by scroll) | Speeds up the initial sync; user-driven scroll is the path to older. |
| Backend sync — bulk probe cache | 300 s | `_bulk_channel_cache` `checked_at` | **Hard cap** | "Bulk endpoint OK?" probe refresh interval. |
| Backend sync — live-chats bootstrap throttle | 2.0 s | `_BOOTSTRAP_EMIT_INTERVAL_S` in `sync.py` | **Hard cap** | Throttles `whatsapp_sync_chats_bootstrap` to once per 2 s per owner. |
| Backend sync — on-demand provider budget | 6 calls / 10 s per `(user, conv)` | `_ON_DEMAND_PROVIDER_MAX_PER_WINDOW` / `_ON_DEMAND_PROVIDER_WINDOW_S` | **Hard cap** | Sliding window; per-conversation, not global. |
| Backend sync — history expansion kill-switch | env-gated | `WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED` | **Hard cap** (off by default) | Disabled by default; the test alias `_HISTORY_EXPANSION_MAX_CONVERSATIONS = 5` is for tests. |
| Backend history expansion — pace | 2.0–2.5 s | `_HISTORY_EXPANSION_INTERVAL_S` | **Hard cap** | Jittered pacing per conversation. |
| Gateway in-memory messages per chat | 2000 | `whatsapp-gateway/src/session-manager.js` `if (chatMsgs.length > 2000) chatMsgs.splice(0, ...)` | **Hard cap** | Sliding window per chat in the in-memory store. |
| Gateway raw-message store | bounded (LRU/TTL) | `RAW_MESSAGE_STORE_MAX` in `messages/message-store.js` | **Hard cap** | Bounded cache for `rememberRawMessage`. |
| Gateway retry counter cache | 10000 / 1 h | `msgRetryCounterCaches` in `session-manager.js` (`createBoundedCache({maxEntries:10_000, ttlMs:60*60*1000})`) | **Hard cap** | Baileys retry counter cache. |
| Gateway history fetch (single chat) | 50 default, 15000 ms timeout | `requestOlderHistory` defaults | **Hard cap** | `sock.fetchMessageHistory` count; the in-flight map dedups identical `(sessionId, jid, targetId)` requests. |
| Gateway group subjects refresh throttle | 10 min | `session-manager.js::_ensureGroupSubjects` `if (!force && Date.now() - last < 10*60*1000) return 'throttled'` | **Hard cap** | 10-minute TTL on `sync_group_subjects` unless `force=true`. |
| Gateway avatar background fetch batch | 3, 100 ms inter-batch | `session-manager.js::_scheduleBackgroundAvatarFetch` | **Hard cap** | Avoids avatar-fetch storms. |
| Gateway avatar retry | 10 min | `avatarFetchAttemptedAt` | **Hard cap** | Per-JID 10-min cool-down. |
| Gateway pairing-code TTL | 10 min | `session-manager.js::_requestPairingCodeOnce` `PAIRING_TTL_MS` | **Hard cap** | A pending pairing-code request expires after 10 min. |
| Gateway lease renewal | `ttlSeconds/3`, ≥10 s | `lease-coordinator.js::armLeaseRenewal` | **Hard cap** | Heartbeat interval. |
| Gateway lease contention retry | 5–6 s | `lease-coordinator.js::acquireLease` `setTimeout(..., 5000 + Math.floor(Math.random() * 1000))` | **Hard cap** | Wait before retry. |

**Important distinction:**
- "A batch returns N messages" ≠ "the system knows N messages." A 50-message page is a window onto an unbounded stream; the system does not claim to have only 50.
- The hard caps are the only place a count is actually a bound on system knowledge: the gateway's 2000-message in-memory ring per chat, the 10000-entry retry counter cache, the bulk channel's 1000-row page, the bulk sync's 50-per-chat newest-only first sync.

---

## 9. Group Discovery Model

Groups can enter the system through four distinct paths:

1. **History sync** (`messaging-history.set`). The gateway ingests `historyChats` from Baileys' `messaging-history.set` event. For each chat with a `@g.us` JID, it is stored in `store.chats` (keyed by JID) and emitted as a `conversation_updated` event. The backend's `events._map_conversation_event` `_ensure_conversation_race_safe` creates a `Conversation` row with `is_group = True` and `last_message_at` set to the newest message timestamp.

2. **Live chats update** (`chats.update`). Each live Baileys `chats.update` event sets a chat row; if `@g.us`, `is_group=True` is applied. The same `_map_conversation_event` path persists the row.

3. **Group subjects** (`groupFetchAllParticipating` + `groupMetadata`).
   - `_ensureGroupSubjects({sessionId, force})` (in `session-manager.js`) calls `sock.groupFetchAllParticipating()`. For every group with a `subject`, it (a) `applySubject` to the existing chat/contact (if it exists) and (b) `seedGroupChat` — creates a chat + contact in the in-memory store even if no message has ever been seen. The seed emits `conversation_updated` so the backend creates a `Conversation` row.
   - If `force=false`, this is throttled to once per 10 min per session. `force=true` is used by `Eşitle` and the initial-sync `_schedule_metadata_enrichment` background task.
   - Unresolved groups (no subject after the first call) get up to 10 targeted `sock.groupMetadata(chat.jid)` lookups in a slow fallback, paced at 500 ms.

4. **Targeted resolve** (`groupMetadata` on the `unresolved` list). The fallback above.

**Group identity in the DB:** `Conversation` row with `is_group=True` and a `Contact` row whose `phone_e164 = "jid:<raw_group_jid>"` (the sentinel set by `contact_phone_for_jid` for `@g.us` JIDs). The group's "name" lives on the `Contact.display_name` (with `name_source = 'group_subject'` per the rank).

**Subject updates** (`groups.update`): when a group's subject changes, the gateway merges the new subject into the contact/chat using `mergeContactName(…, 'group_subject')` (rank 4) — but only if the current name's source rank is ≤ 3, OR the current name is a raw-identity-shaped string. This prevents a group renaming from clobbering a manually-set display name.

**A group with no messages becomes a conversation via path 3** — `_ensureGroupSubjects` `seedGroupChat` creates a chat row + emits `conversation_updated` even when `last_message_at = null`. The backend persists the `Conversation` row on the first `conversation_updated` event it sees for that JID. The DB row's `last_message_at` is `NULL` (no monotonic violation: this is the FIRST data). On the next `chats.update` or `message_new`, the row is updated.

So the answer to "WhatsApp'ta var olan ama hiç mesajı olmayan bir grup bizim sistemde conversation olur mu?" is:

> **Yes** — via the gateway's `_ensureGroupSubjects` `seedGroupChat` path. The trigger is:
> 1. `groupFetchAllParticipating` (called on `connection.open`, on `force=true` from `Eşitle`, and on the initial-sync `_schedule_metadata_enrichment` task), or
> 2. `groupMetadata` (the targeted fallback).
>
> Source: `whatsapp-gateway/src/session-manager.js::_ensureGroupSubjects` (lines 1348–1461). Backend source: `events._map_conversation_event` (lines 1060–1189). DB source: `Conversation` row created by `_ensure_conversation_race_safe`.

The "3Hacker görünmüyor" defect from §10 is the case where `groupFetchAllParticipating` did not return this group AND the targeted fallback `groupMetadata` either failed or was never reached. A successful first sync OR a manual `Eşitle` re-issues `force=true` and seeds it.

---

## 10. Current Known Problems (by layer)

This section classifies the open user-visible problems by which layer owns the fix. **No fixes are proposed in Phase 0.** A future phase will claim one or more.

| # | Problem (Turkish label in `WHATSAPP_*` reports) | FRONTEND | BACKEND | GATEWAY | DATABASE | CROSS-LAYER | Why it happens (current code) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | İlk açılışta sohbetlerin geç/eksik gelmesi | ✓ | ✓ | ✓ | — | ✓ | Three contributing causes: (a) `gateway_available=false` is treated as "IDLE" by the page (it shows a stale banner) — the page's `convLoadState` enters `'ready'` only when the fetch returns, but the FIRST page is small (200) and background fill is capped at 5 pages, so the very first load may not show chats that the user has on the phone. (b) `_initial_sync_inflight` single-flight coalesces across an owner, so a reconnect storm is suppressed but the user has no progress feedback. (c) The gateway's in-memory `chats` Map is empty until `messaging-history.set` lands, which can be 30–60 s after `connection.open`. |
| 2 | "mesajlar yüklenemedi" | ✓ | — | — | — | ✓ | A per-conversation `messageLoadError` is set; the ChatThread renders the error state for that one chat. The page-level error toast is the FIRST-load conv-list error, not the per-conversation message error. The user sees two different error states, which can be confusing. |
| 3 | Bazı kişi/grupların eksik olması | — | ✓ | ✓ | — | ✓ | (a) `groupFetchAllParticipating` is throttled at 10 min; if the phone just connected and the call failed, the user must wait or hit "Eşitle" (`force=true`). (b) Contacts that exist only as `@lid` and were never mapped to a phone have no phone-keyed `Contact` row; the chat appears only if a `contact_synced` or `chats.update` event creates one. (c) The "first time" path is the "no previous `creds.accountSyncCounter`" check in `socket-events.js` — if a previous session's `accountSyncCounter` was incremented on a different gateway, history is re-fetched on a fresh connect. |
| 4 | 3Hacker grubunun görünmemesi | — | — | ✓ | — | — | `groupFetchAllParticipating` did not return the group AND the targeted `groupMetadata` fallback either failed (Baileys network) or was throttled. The DB has no row because no `conversation_updated` was ever emitted for that JID. |
| 5 | "Eşitle"nin eksik sonuç getirmesi | — | ✓ | — | — | ✓ | (a) `_SYNC_PER_CHAT_LIMIT=50` bounds the per-chat first-page; older history is lazy. (b) `since=<last_synced_epoch>` deltas the bulk channel; if the watermark is too recent, the delta is empty even though there is older data the user expects to see. (c) `_run_bulk_message_sync` inserts in `_SYNC_PERSIST_BATCH=200` chunks; the chunks are not retried on per-batch failure (the whole job fails, then `FAILED_SYNC_ACK_KEY` hides the banner). |
| 6 | Conversation ordering | ✓ | — | — | — | ✓ | The page uses `compareConversationsByActivityDesc`; the backend writes the persisted `last_message_at` (H-6). The remaining drift is when the page receives a `conversation_updated` WS event whose `last_message_at` is *older* than the existing one — `shouldApplyPreview` must reject it, and a late WS event from a slow worker can still race. |
| 7 | Chat history WhatsApp Web gibi değil | ✓ | ✓ | ✓ | — | ✓ | The gateway stores the newest 2000 messages per chat in memory. Older history is on-demand via `requestOlderHistory` (a `fetchMessageHistory` PDO). The threshold for "older than what the gateway has cached" is implicit — it is the watermark of `messaging-history.set`. The UI's pagination is bounded by what the gateway knows plus what `fetchMessageHistory` can pull. The 15-second timeout (`timeoutMs`) can return `TIMEOUT`; the UI shows a retryable error. |
| 8 | Sohbet seçince birden fazla chat tab/pane oluşması | ✓ | — | — | — | — | P6-4 fix: `ChatThread` and `ChatComposer` are explicitly keyed by `selectedConv.id` so a switch remounts cleanly. The "multiple tabs/pane" defect was the OLD pre-P6-4 behaviour (no key). The regression risk today is the OPPOSITE — a refactor that removes the key would re-introduce the "previous draft leaks into next chat" + "new chat opens mid-history" defects. See §7 for the full state rationale. |
| 9 | Aktif chat alanının yatay büyümesi | ✓ | — | — | — | — | A long unbreakable token (a URL, a `@lid`-looking push name) in a message bubble can break the layout. The frontend `chat-bubble` and `composer` are expected to wrap with `break-words` / `whitespace-pre-wrap`; verify that no future message rendering drops those classes. |
| 10 | Realtime + sync + history çakışmaları | ✓ | ✓ | — | — | ✓ | The page has THREE merge points: (a) the initial list load (retain non-returned rows if `has_more`); (b) the WS `conversation_updated` event (partial-merge via `applyConversationEvent`); (c) the WS `message_new` event (via `mergeWhatsAppMessages`). The `seenWaMessageIdsRef` ring dedups replays. A new path that bypasses these three and writes a new conversation array directly will reintroduce the "50–150 silently deleted" bug from the production drift audit. |

---

## 11. Phase Dependency Map

The next phases each address a slice of §10 and must preserve §4. A phase's outputs are inputs to the next.

| Phase | Title | Files likely touched | Invariants to preserve (§4) | Depends on |
| --- | --- | --- | --- | --- |
| **Phase 1** | Connection / Session Lifecycle | `whatsapp-gateway/src/session-manager.js`, `whatsapp-gateway/src/socket/socket-events.js`, `whatsapp-gateway/src/lease/lease-coordinator.js`, `backend/app/services/whatsapp/orchestration/sessions.py`, `backend/app/services/whatsapp/orchestration/promotion.py`, `backend/app/services/whatsapp/orchestration/pairing_registry.py`, `backend/app/models/whatsapp_session.py`, `backend/app/api/v1/endpoints/whatsapp.py` | PAIRING-* (entire section), IDENTITY self-identity | — |
| **Phase 2** | Conversation Discovery / Full Sync | `backend/app/services/whatsapp/orchestration/sync.py`, `whatsapp-gateway/src/session-manager.js::_ensureGroupSubjects`, `backend/app/services/whatsapp/orchestration/events.py::_persist_chat_snapshot` (via sync), `backend/app/services/whatsapp/orchestration/events.py::_map_conversation_event` | PAIRING lease+open, IDENTITY contact resolution, MESSAGES dedup, FRONTEND canonical merge, IDENTITY group subject | Phase 1 |
| **Phase 3** | Message History / Pagination | `backend/app/services/whatsapp/orchestration/history_evidence.py`, `whatsapp-gateway/src/session-manager.js::getMessages` + `requestOlderHistory`, `backend/app/services/whatsapp/orchestration/events.py::_ingest_message` dedup, `frontend/src/pages/WhatsAppHubPage.tsx::activeLoadOlder`, `frontend/src/features/whatsapp/components/ChatThread.tsx` scroll restoration, `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts::loadOlderMessages` | MESSAGES monotonic order, MESSAGES `before` cursor is real numeric id, FRONTEND scroll restore | Phase 1, Phase 2 |
| **Phase 4** | Identity / Groups / Ordering | `backend/app/services/whatsapp/identity.py`, `backend/app/services/whatsapp/orchestration/events.py::_ingest_lid_mapped`, `backend/app/services/whatsapp/orchestration/events.py::reconcile_legacy_split_conversation`, `whatsapp-gateway/src/session-manager.js::_applyLidMapping`, `whatsapp-gateway/src/socket/socket-events.js` `chats.phoneNumberShare` + `messaging-history.set` lid mappings | IDENTITY-* (entire section) | Phase 1, Phase 2 |
| **Phase 5** | Chat UI / Conversation Switching | `frontend/src/pages/WhatsAppHubPage.tsx`, `frontend/src/features/whatsapp/components/ChatThread.tsx`, `frontend/src/features/whatsapp/components/ConversationList.tsx`, `frontend/src/features/whatsapp/components/ChatComposer.tsx`, `frontend/src/features/whatsapp/hooks/useWhatsAppConversation.ts` | FRONTEND-* (entire section) | Phase 1–4 (data must be correct first) |
| **Phase 6** | Realtime + Sync + History Reconciliation | `frontend/src/pages/WhatsAppHubPage.tsx::handleWsEvent`, `frontend/src/features/whatsapp/lib/whatsappMessageMerge.ts`, `frontend/src/features/whatsapp/lib/whatsappConversationPatch.ts`, `backend/app/services/whatsapp/orchestration/events.py` `_map_conversation_event` + `_ingest_message` + `_ingest_lid_mapped` | MESSAGES optimistic + provider echo merge, MESSAGES monotonicity, FRONTEND live WS canonical merge | Phase 1–5 |
| **Phase 7** | Real WhatsApp Web E2E Acceptance | Test harness + manual reproduction; no production code change. All §12 acceptance invariants must pass. | All | Phase 1–6 |

**Phase boundaries are NOT optional.** A phase that claims a §10 problem but has not yet preserved the upstream phases' invariants will regress. The contract is the proof artifact: any commit that breaks §4 is a release blocker.

---

## 12. Acceptance Invariant List

These are the only acceptable truths for the system once all phases are complete. They are written in measurable terms; "looks like WhatsApp Web" is not on this list.

### CONVERSATION DISCOVERY

```
# Discoverable on /whatsapp page (after first full sync completes)

COUNT(WhatsApp-side conversations reachable on the phone that have at least one message)
==
COUNT(conversations in public.conversations for the user WHERE last_message_at IS NOT NULL)
   UNION
COUNT(conversations in public.conversations for the user WHERE last_message_at IS NULL AND contact_id IN
      (SELECT id FROM public.contacts WHERE custom_attributes->>'name_source' = 'group_subject'))

==
COUNT(items in /api/v1/whatsapp/conversations response, paginated until has_more=false)

==
COUNT(rows in frontend WhatsAppHubPage.conversations state, after first user-driven load + 5 background-fill pages)
```

Violation: any of the four counts disagree after the sync job reaches `state=COMPLETED`.

### CONVERSATION LIST REFRESH DURING LIVE

```
# When a single message arrives via WS

1. Conversations page is open.
2. Backend receives message_new.
3. Frontend receives WS event.

EXPECTED:
- The conversation's last_message_preview is updated.
- The conversation's last_message_at is updated to the new timestamp.
- The conversation is re-sorted to the top of the list iff its new last_message_at is the newest among all conversations.

INVARIANT:
- The frontend conversation count MUST NOT change (no new row created from a single message event).
- A replayed message (same wa_message_id) MUST NOT change the row.
```

### CONVERSATION ARCHIVE

```
# A conversation that is archived in WhatsApp (chat.archived=true) AND has zero messages
# since the last archive SHOULD appear in the ARCHIVED filter with last_message_at = NULL
# (NOT removed from the list).
```

### MESSAGE

```
# A message M that exists in the gateway's in-memory store for a chat
# AND in the DB (wa_message_id IS NOT NULL)
# AND in the WS broadcast (one or more events with the same wa_message_id)
# AND in the REST /conversations/{id}/messages response
# MUST resolve to exactly one row in the frontend messagesMap[convId] array.

ASSERTION: For any wa_message_id, the cardinality of distinct Message objects in the UI is 1.
```

### OPTIMISTIC SEND

```
# User sends a message. Before the network round-trip returns:
- frontend messagesMap[convId] has the optimistic message with status=PENDING and id starting with 'optimistic_'.
- conversations[convId].last_message_preview and last_message_at reflect the new message.

# After the network round-trip returns:
- The optimistic message is replaced (in place; the array order is preserved) by the canonical row with the real numeric id and the server-reported status.

# If the network round-trip fails:
- The optimistic message's status becomes 'FAILED' with an error_message.
- conversations[convId].last_message_preview and last_message_at are ROLLED BACK to the pre-optimistic state (F-6).
- A user-facing toast is shown by the caller.
```

### CHAT SELECTION

```
# At all times, exactly one ChatThread is rendered in the chat pane.
# The rendered thread's messages come from messagesMap[selectedConv.id ?? 0].
# When selectedConv transitions A -> B -> C, the thread renders B's messages after step 2
# and C's messages after step 3, with A's data preserved in messagesMap[A.id] for fast re-selection.
```

### LAYOUT

```
# The chat pane's width is bounded by the page's grid container. It MUST NOT grow horizontally
# when a single message contains a long unbreakable token.
```

### PAIRING

```
# Real QR scan:
1. pair_token created.
2. Phone scans QR.
3. Baileys emits connection.open.
4. /ws/gateway delivers session_connected.
5. Backend creates / updates a public.whatsapp_sessions row (status=CONNECTED).
6. Backend broadcasts session_updated and conversations_updated.
7. Frontend updates the Sessions tab and the chat list.

EXPECTED: at step 7, the row's status is "CONNECTED", is_active=true, is_phone_online=true.
A subsequent cancelPairing from the modal MUST NOT delete the socket or revert the status.
```

### LIVE PROBE

```
# While the gateway is healthy: probeLive() returns true.
# While the gateway is unreachable: probeLive() returns false and the cache holds for 30 s.
# The probe revalidates only on ws_connected and LIVE_SESSION_EVENTS, not on a setInterval.
```

### LIST EMPTY STATE

```
# When the conversation list is fetched and the response items=[] and has_more=false:
- The page enters convLoadState='ready'.
- ConversationList renders the "no conversations" empty state.
- A toast is NOT shown (this is a real empty, not an error).

# When the fetch returns an error:
- The page enters convLoadState='error' with convLoadError set.
- ConversationList renders the error state with a retry CTA.
- A toast IS shown.
- Existing list items (if any) are NOT cleared.
```

### HISTORY PAGINATION

```
# A user scrolls up on a chat with has_more=true and the oldest message has id=N.
- A GET /conversations/{id}/messages?limit=50&before=N is issued.
- The response is merged into messagesMap[convId]; existing messages are NOT lost.
- The scroll position is restored (scrollTop = prevScrollTop + (newHeight - prevHeight)).

# If the GET fails:
- messagesMap[convId] is unchanged.
- messagePaging[convId].error = true.
- A retryable error is shown in the chat thread.
- Other conversations are NOT affected.
```

### LABEL LOCALISATION

```
# Every user-facing string in /whatsapp resolves to a key in /locales/{en,tr}.json.
# The t('domain.key') function is the ONLY path to a user-facing string.
# A grep for hardcoded Turkish or English in src/features/whatsapp/components/*.tsx yields zero matches.
```

### LOGIN GATEWAY FAILURE

```
# When the gateway returns 5xx or is unreachable:
- /whatsapp/gateway/health returns 503 { gateway_available: false }.
- probeLive() caches false for 30 s.
- The WhatsAppRepository.requireLive() throws WhatsAppApiError('whatsapp.gatewayDown') on every subsequent API call.
- The UI shows the gateway-down state, not a "loaded" state with stale data.
- No false-positive success is returned.
```

### IDENTITY

```
# A contact with phone_e164 = "+905321002030" and display_name = "Mehmet" and name_source = 'addressbook'
# appears in the conversation list as "Mehmet", not "+90 532 100 20 30".

# A contact with phone_e164 = "jid:6277...@lid" and custom_attributes.push_name = "Ayşe"
# appears as "Ayşe" ONLY if no canonical phone is resolvable. As soon as the LID maps to a phone
# (via chats.phoneNumberShare or messaging-history.set lid mappings), the display becomes the
# canonical name (if any) or the normalised phone.

# A group with phone_e164 = "jid:120363...@g.us" and display_name = "3Hacker"
# appears as "3Hacker". The phone column is empty.
```

### STATUS MONOTONICITY

```
# A message's status is a strict monotonic value in {PENDING, SENT, DELIVERED, READ} OR
# {PENDING, FAILED}. A status update that is rank-lower than the current is dropped.
# FAILED is only reachable from PENDING.
```

### UNREAD MONOTONICITY (DOWN-ALLOWED, GHOST-FREE)

```
# A conversation's unread_count may go UP or DOWN. A drop to 0 stamps last_read_at.
# A subsequent WS snapshot that arrives with a higher unread_count but a STALE
# last_message_at (older than last_read_at) MUST NOT resurrect the badge.
# A subsequent WS snapshot that arrives with a higher unread_count and a NEWER
# last_message_at IS applied (a new inbound after the read).
```

### REPLAY DEDUP

```
# A message M is broadcast over WS N times (N > 1) with the same wa_message_id.
# Frontend's messagesMap[convId] has exactly ONE row for M.
# The conversation's message_count and unread_count are not incremented for replays.
# The seenWaMessageIdsRef ring (1000 entries) is the dedup mechanism.
```

### CONTACT UNIQUENESS

```
# Per (user_id, phone_e164) there is exactly one Contact row.
# Per (user_id, session_id, contact_id, channel) there is exactly one Conversation row.
# These are DB-enforced unique constraints.
```

### LIST PAGINATION CORRECTNESS

```
# After the first page (limit=200, offset=0) is loaded, subsequent pages are loaded
# with the next_offset from the response. has_more=true at the first page MUST trigger
# up to MAX_BACKGROUND_CONVERSATION_PAGES (5) background fills, each at 800 ms intervals.
# The first-page response's items REPLACE the visible list, and any prior rows not in
# the first page are RETAINED in state for the duration of the background fill.
# After has_more=false on the first page, the first page is authoritative and the
# displayed list equals the first-page items.
```

### EPHEMERAL PAIRING SAFETY

```
# During a real QR scan:
- The POST /pairing/start returns a pair_token. NO public.whatsapp_sessions row exists.
- The /whatsapp/pairing/{token}/cancel endpoint is a no-op once the gateway has reached
  CONNECTED (idempotent finalisation).
- The /whatsapp/pairing/{token}/cancel endpoint ONLY deletes the gateway session if the
  gateway has not reached CONNECTED.
- A backend restart between QR scan and connection.open does NOT lose the promotion.
```

### GATEWAY OUTAGE

```
# When the gateway HTTP is unreachable:
- The /whatsapp/gateway/health endpoint returns 503.
- The /api/v1/whatsapp/* endpoints that require the gateway return 502.
- The /api/v1/whatsapp/sessions endpoint returns 200 (sessions are persisted in the DB
  and are still useful during a transient outage; actions that need the gateway fail closed).
- No list/message/state mutation is fabricated to mask the outage.
```

### ANTI-BAN

```
# AntibanPolicy.is_within_working_hours returns False if parsing fails.
# All jitter and humanized delays resolve through AntibanPolicy.
# Anti-ban settings are persisted via /api/v1/settings/antiban and reflected in the UI.
```

---

## Closing

The single deliverable of Phase 0 is this document. The single question it answers is: **"What is the system today, and what is forbidden to break tomorrow?"**

The next phase begins only after this contract is reviewed against the on-disk `WHATSAPP_*.md` forensic reports and any disagreement is reconciled in writing.

**No code change, no test run, no commit, no push, no deploy was performed during Phase 0.**
