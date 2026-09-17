# Phase 11.5 — WhatsApp Event & WebSocket Contract Map

**Document Status**: COMPLETE & VERIFIED  
**Phase**: 11.5 — WhatsApp Architecture Preparation & Characterization  
**Scope**: Complete inventory of WhatsApp event contracts, schemas, producers, consumers, ordering requirements, idempotency guarantees, and fail-closed behaviors.

---

## 1. Gateway-to-Backend Protocol (`/ws/gateway`)

Events transmitted from the Node.js Gateway to the FastAPI Backend over `/ws/gateway`:

| Event Name | Producer | Consumer | Transport | Key Payload Fields | Ordering Requirement | Idempotency Guarantee | Failure / Retry Behavior |
|---|---|---|---|---|---|---|---|
| `message_new` | Gateway `session-manager.js` | Backend `_ingest_message()` | WebSocket (Outbox Pump) | `event_id`, `gateway_session_id`, `conversation_id`, `message` (`id`, `wa_message_id`, `from_me`, `body`, `status`) | Strict (Monotonic sequence in outbox) | Deduplicated via `event_id` and `(conversation_id, wa_message_id)` | NACK on failure; retried up to 10 times |
| `message_status_updated` | Gateway `session-manager.js` | Backend `_map_conversation_event()` | WebSocket (Outbox Pump) | `event_id`, `gateway_session_id`, `conversation_id`, `wa_message_id`, `status` (`SENT`, `DELIVERED`, `READ`) | Monotonic Status: Higher status never downgraded | Deduplicated via `event_id`; status ranking monotonic | Outbox retries with exponential backoff |
| `conversation_updated` | Gateway `session-manager.js` | Backend `_map_conversation_event()` | WebSocket (Outbox Pump) | `event_id`, `gateway_session_id`, `conversation` (`id`, `name`, `last_message_at`, `unread_count`) | Relaxed (Latest timestamp wins) | Timestamp comparison: older preview does not overwrite newer | Outbox retries |
| `conversation_read` | Gateway `session-manager.js` | Backend `_map_conversation_event()` | WebSocket (Outbox Pump) | `event_id`, `gateway_session_id`, `conversation_id`, `jid` | Relaxed | Sets unread count to 0; idempotent | Outbox retries |
| `presence_updated` | Gateway `session-manager.js` | Backend `_map_conversation_event()` | WebSocket (Ephemeral) | `event_id`, `gateway_session_id`, `jid`, `typing` (boolean) | Real-time (Drop on lag) | Volatile state; 10s client timeout | Not queued in durable outbox |
| `contact_synced` | Gateway `session-manager.js` | Backend `_ingest_contact_synced()` | WebSocket (Outbox Pump) | `event_id`, `gateway_session_id`, `contact` (`jid`, `lid`, `name`, `phone_number`) | Relaxed | Savepoint upsert; AddressBook > GroupSubject > PushName | Outbox retries |
| `session_qr_updated` | Gateway `session-manager.js` | Backend `_map_session_event()` | WebSocket (Ephemeral) | `event_id`, `gateway_session_id`, `qr_code`, `session_id` | Latest QR string replaces previous | Overwrites `qr_code` column in `whatsapp_sessions` | Ephemeral; next QR generated automatically |
| `session_connected` | Gateway `session-manager.js` | Backend `_map_session_event()` | WebSocket (Outbox Pump) | `event_id`, `gateway_session_id`, `phone`, `session_name` | Critical lifecycle barrier | Sets `status='CONNECTED'`, triggers initial sync | Outbox retries |
| `session_disconnected` | Gateway `session-manager.js` | Backend `_map_session_event()` | WebSocket (Outbox Pump) | `event_id`, `gateway_session_id`, `reason` (`LOGGED_OUT`, `BANNED`) | Critical lifecycle barrier | Sets `status='DISCONNECTED'`; clears credentials if logged out | Outbox retries |
| `session_sync_progress` | Gateway `session-manager.js` | Backend `_passthrough_event()` | WebSocket (Ephemeral direct) | `event_id`, `gateway_session_id`, `sync` (`phase`, `progress`, `stage`) | Monotonic progress | Pure ephemeral UI feedback | Bypasses durable outbox; unqueued |
| `history_sync_completed` | Gateway `session-manager.js` | Backend `_passthrough_event()` | WebSocket (Outbox Pump) | `event_id`, `gateway_session_id`, `chats_synced`, `messages_synced` | End of Baileys history stream | Triggers backend DB hydration reconciliation | Outbox retries |

---

## 2. Backend-to-Gateway Control Protocol (`/ws/gateway`)

| Message Type | Producer | Consumer | Purpose | Payload Fields |
|---|---|---|---|---|
| `gateway_event_ack` | Backend `main.py` | Gateway `events.js` | Confirms durable persistence of event in PostgreSQL | `{"type": "gateway_event_ack", "event_id": "<UUID>"}` |
| `gateway_event_nack` | Backend `main.py` | Gateway `events.js` | Signals ingestion rejection; triggers retry or dead-letter | `{"type": "gateway_event_nack", "event_id": "<UUID>", "permanent": false}` |
| `ping` | Backend `main.py` | Gateway `events.js` | Keepalive heartbeat every 20 seconds | `{"type": "ping"}` |
| `pong` | Gateway `events.js` | Backend `main.py` | Heartbeat response confirming bridge socket liveness | `{"type": "pong"}` |

---

## 3. Backend-to-Frontend WebSocket Events (`/ws`)

Events broadcast by Backend `ws_manager` to all authenticated UI clients:

| Event Name | Producer Service | UI Handler | Payload Schema & Key Fields | UI Reaction |
|---|---|---|---|---|
| `message_new` | `_ingest_message()` | `WhatsAppHubPage.tsx` | `{ event: "message_new", conversation_id: number, message: MessageDTO, user_id: string }` | Appends to `messagesMap[cid]`, auto-reads if open, updates conversation last message preview |
| `message_status_updated` | `_map_conversation_event()` | `WhatsAppHubPage.tsx` | `{ event: "message_status_updated", conversation_id: number, wa_message_id: string, status: string }` | Updates delivery status via `mergeDeliveryStatus()` |
| `conversation_updated` | `_map_conversation_event()` | `WhatsAppHubPage.tsx` | `{ event: "conversation_updated", conversation_id: number, conversation: ConversationPatchDTO }` | Patches conversation preview, re-sorts list by `last_message_at` desc |
| `conversation_read` | `mark_conversation_read()` | `WhatsAppHubPage.tsx` | `{ event: "conversation_read", conversation_id: number }` | Resets `unread_count` to 0 in conversation list |
| `presence_updated` | Gateway pass-through | `WhatsAppHubPage.tsx` | `{ event: "presence_updated", conversation_id: number, typing: boolean }` | Sets `peerTypingMap[cid] = true`; sets 10s auto-expiry timer |
| `session_qr_updated` | `_map_session_event()` | `WhatsAppQrConnectModal.tsx` | `{ event: "session_qr_updated", session_id: string, qr_code: string }` | Re-renders QR canvas; restarts countdown timer |
| `session_connected` | `_map_session_event()` | `WhatsAppHubPage.tsx` | `{ event: "session_connected", session_id: string, phone: string }` | Closes QR modal; displays connected status badge |
| `session_disconnected` | `_map_session_event()` | `WhatsAppHubPage.tsx` | `{ event: "session_disconnected", session_id: string, reason: string }` | Flags session disconnected; prompts user to re-link |
| `whatsapp_sync_started` | `_run_sync_job()` | `WhatsAppHubPage.tsx` | `{ event: "whatsapp_sync_started", sync_id: string, stage: "starting", progress: 4 }` | Opens sync banner, initializes progress bar |
| `whatsapp_sync_chats_snapshot` | `_run_sync_job()` | `WhatsAppHubPage.tsx` | `{ event: "whatsapp_sync_chats_snapshot", sync_id: string, conversations: ConversationDTO[] }` | Incrementally merges chat list; zero DOM freeze |
| `whatsapp_sync_messages_chunk` | `_run_sync_job()` | `WhatsAppHubPage.tsx` | `{ event: "whatsapp_sync_messages_chunk", sync_id: string, messages: MessageDTO[] }` | Merges into `syncMsgBufferRef`; updates open chat if active |
| `whatsapp_sync_complete` | `_run_sync_job()` | `WhatsAppHubPage.tsx` | `{ event: "whatsapp_sync_complete", sync_id: string, finished_at: string, conversations: ConversationDTO[] }` | Closes sync banner; displays 100% complete state |
| `whatsapp_sync_failed` | `_run_sync_job()` | `WhatsAppHubPage.tsx` | `{ event: "whatsapp_sync_failed", sync_id: string, error: string, error_code: string }` | Displays error toast; if `RELINK_REQUIRED`, prompts re-pairing |
