# Phase 11.5 — WhatsApp State Ownership Map

**Document Status**: COMPLETE & VERIFIED  
**Phase**: 11.5 — WhatsApp Architecture Preparation & Characterization  
**Scope**: Complete inventory of mutable state containers across Backend, Gateway, and Frontend.

---

## 1. Backend Mutable State Inventory (`backend/app/services/whatsapp_service.py` & `main.py`)

| State Container | Type | Owner | Readers | Writers | Lifecycle | Persistence | Safe Extraction Candidate? |
|---|---|---|---|---|---|---|---|
| `_conversation_locks` | `Dict[str, asyncio.Lock]` | `whatsapp_service.py` | `_get_conversation_lock()` | `_get_conversation_lock()` | Process lifetime; lazily allocated per conversation | In-Memory only | **YES** (Conversation Lock Registry) |
| `_initial_sync_inflight` | `Set[str]` | `whatsapp_service.py` | `ingest_gateway_event`, `_schedule_initial_sync` | `_schedule_initial_sync`, `_run_sync_job` | Process lifetime | In-Memory only | **YES** (Sync Coordinator) |
| `_sync_lock` | `asyncio.Lock` | `whatsapp_service.py` | `sync_contacts`, `_sync_conversations_impl` | `sync_contacts`, `_sync_conversations_impl` | Process lifetime | In-Memory only | **YES** (Sync Coordinator) |
| `_orphan_suppressed` | `Dict[str, Dict[str, Any]]` | `whatsapp_service.py` | `_log_orphan_event` | `_log_orphan_event` | Windowed 60s logging throttle | In-Memory only | **YES** (Diagnostics / Logging) |
| `_gateway_bridge` | `Dict[str, Any]` | `main.py` | Admin health check, diagnostics | `gateway_websocket_endpoint` | Process lifetime; updated on connect/event | In-Memory only | **YES** (Gateway Bridge Metrics) |
| `ws_manager.active_connections` | `List[WebSocket]` | `ws_manager` | `broadcast()`, `send_personal_message()` | `connect()`, `disconnect()` | Connection lifetime | In-Memory only | Protected Core Infrastructure |

---

## 2. Gateway Mutable State Inventory (`whatsapp-gateway/`)

| State Container | Type | Owner | Readers | Writers | Lifecycle | Persistence | Safe Extraction Candidate? |
|---|---|---|---|---|---|---|---|
| `sessions` | `Map<string, Session>` | `session-manager.js` | `getSession()`, `listSessions()`, HTTP routes | `createSession()`, `deleteSession()`, `_restorePersistedSessions()` | Gateway process lifetime | Synced to `whatsapp_private.gateway_sessions` | **YES** (Session Registry) |
| `sockets` | `Map<string, WASocket>` | `session-manager.js` | `sendMessage()`, `getSocket()`, RPC | `_initSocket()`, `_destroySocket()` | Socket connection lifetime | In-Memory only | **YES** (Socket Lifecycle Manager) |
| `chats` | `Map<string, ChatRecord>` | `session-manager.js` | `getChats()`, `listConversations()` | `_handleMessagingHistorySet()`, `_touchChat()`, `_handleMessageUpsert()` | Process lifetime per session | Cache; rebuilt from Baileys / DB | **YES** (Chat Cache Adapter) |
| `contacts` | `Map<string, ContactRecord>` | `session-manager.js` | `getContacts()`, `_resolveContactName()` | `_handleContactsUpsert()`, `_handleMessagingHistorySet()` | Process lifetime per session | Cache; synced to PostgreSQL | **YES** (Contact Store Adapter) |
| `messages` | `Map<string, MessageRecord>` | `session-manager.js` | `getMessages()`, `listAllMessages()` | `_recordInbound()`, `_recordOutbound()` | Bounded in-memory sliding window | Cache only; durable in Backend DB | **YES** (Message Buffer Adapter) |
| `fallbackBuffer` | `Array<Event>` | `events.js` | `flushFallbackBuffer()` | `publish()` (when disconnected) | Flushed upon WebSocket reconnection | Bounded in-memory buffer (500 items) | **YES** (Bridge Transport Buffer) |
| `eventOutbox` | Table `event_outbox` | `postgres-event-outbox.js` | `claimPending()`, Outbox Pump | `enqueue()`, `acknowledge()`, `reject()`, `cleanup()` | Durable queue across restarts | PostgreSQL (`whatsapp_private`) | Protected Outbox Architecture |
| `socket_leases` | Table `socket_leases` | `postgres-session-lease.js` | `acquire()`, `renew()` | `acquire()`, `renew()`, `release()` | Distributed TTL lease (45 seconds) | PostgreSQL (`whatsapp_private`) | Protected Lease Architecture |

---

## 3. Frontend Mutable State Inventory (`WhatsAppHubPage.tsx`)

| State Hook / Container | Initial Value | Owner Component | Writers / Updaters | Purpose / Derived Impact | Safe Extraction Candidate? |
|---|---|---|---|---|---|
| `conversations` (`useState`) | `[]` | `WhatsAppHubPage` | `loadConversations()`, `handleWsEvent()`, `setConversations()` | List of conversations sorted by `last_message_at` desc | **YES** (`useWhatsAppConversations`) |
| `selectedConv` (`useState`) | `null` | `WhatsAppHubPage` | User selection, initial load, targeted updates | Currently active chat thread in center viewport | **YES** (`useActiveConversation`) |
| `messagesMap` (`useState`) | `{}` | `WhatsAppHubPage` | Message fetch, `handleSendMessage()`, `handleWsEvent()`, `mergeWhatsAppMessages()` | In-memory message store keyed by `conversation_id` | **YES** (`useWhatsAppMessageStore`) |
| `sessions` (`useState`) | `[]` | `WhatsAppHubPage` | `fetchSessions()`, `handleWsEvent()` | Connected line status (`CONNECTED`, `SCAN_QR`, etc.) | **YES** (`useWhatsAppSessions`) |
| `sessionSync` (`useState`) | `null` | `WhatsAppHubPage` | `handleWsEvent()` (`whatsapp_sync_*`, `session_sync_*`) | Progress banner state (phase, progress %, counts) | **YES** (`useWhatsAppSyncProgress`) |
| `peerTypingMap` (`useState`) | `{}` | `WhatsAppHubPage` | `handleWsEvent()` (`presence_updated`), 10s auto-expiry timer | Peer typing indicator badges in chat list / header | **YES** (`usePeerTyping`) |
| `syncMsgBufferRef` (`useRef`) | `{}` | `WhatsAppHubPage` | `handleWsEvent()` (`whatsapp_sync_messages_chunk`) | Accumulates sync chunk messages before conversation open | **YES** (`useWhatsAppMessageStore`) |
| `activeSyncIdRef` (`useRef`) | `null` | `WhatsAppHubPage` | `handleWsEvent()` (`whatsapp_sync_started`, `complete`) | Filters stale events from completed/superseded syncs | **YES** (`useWhatsAppSyncProgress`) |
| `peerTypingTimersRef` (`useRef`) | `{}` | `WhatsAppHubPage` | `presence_updated` handler | Auto-clears typing state if peer disconnects without pause | **YES** (`usePeerTyping`) |
| `filter` / `searchQuery` (`useState`) | `'ALL'`, `''` | `WhatsAppHubPage` | Filter pills, Search bar input with debouncing | Client-side filtering of conversation list | **YES** (`useConversationFilters`) |
| `isSending` (`useState`) | `false` | `WhatsAppHubPage` | `handleSendMessage()` | Disables composer submit during API transit | **YES** (`useChatComposerState`) |
