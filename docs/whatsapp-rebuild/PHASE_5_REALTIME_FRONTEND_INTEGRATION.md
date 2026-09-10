# Tezlify WhatsApp Rebuild — Phase 5: Realtime WebSocket + Frontend Integration

## 1. Executive Summary & Architectural Invariants

Phase 5 completes the end-to-end integration between the official Meta WhatsApp Cloud API backend (Phases 1–4) and the existing Vuexy-themed frontend WhatsApp Hub interface. The integration replaces legacy polling and reverse-engineered abstractions with a production-grade, multi-tenant, event-driven WebSocket pipeline.

### Core Architectural Invariants
1. **No Baileys / No WhatsApp Web Reverse-Engineering**:
   - Zero legacy QR codes, pairing routines, or browser-to-Meta API calls.
   - All browser communications go exclusively through Tezlify backend endpoints (`/api/v1/...`).
2. **WebSocket as Primary Transport**:
   - Inbound messages and outbound message status updates are pushed in real time via `/ws?token=<JWT>`.
   - Legacy 4-second Baileys delta polling interval (`syncWhatsAppChatsDelta`) has been completely removed.
3. **Multi-Tenant Connection Isolation**:
   - Every WebSocket connection is tagged with the authenticated user ID (`user_id`).
   - The backend `ConnectionManager` guarantees that private customer data, conversation updates, and status receipts are dispatched strictly to the owning tenant's active sockets.
4. **Security & Zero Secret Leakage**:
   - Meta access tokens, encrypted vault keys, and webhook secrets are never exposed in WebSocket frames or REST responses.
5. **Preserved Vuexy Aesthetic & Responsive Layout**:
   - The visual layout, cards, badges, and tabs of `WhatsAppHubPage.tsx`, `ConversationList.tsx`, `ChatThread.tsx`, `ChatComposer.tsx`, and `ChatBubble.tsx` are fully preserved.

---

## 2. Realtime Event Pipeline Architecture

```
                                  INBOUND FLOW
                                  ────────────
Meta Cloud API Webhook
        │
        ▼ POST /api/v1/whatsapp/webhook?sync=true
┌────────────────────────────────────────────────────────┐
│ 1. Ingestion Barrier (HMAC-SHA256 & Deduplication)     │
│    - X-Hub-Signature-256 verified                      │
│    - Deduplicated on event_hash & wa_message_id        │
├────────────────────────────────────────────────────────┤
│ 2. Domain Processing & Commit                          │
│    - Contact resolved & Conversation resolved          │
│    - 24h Customer Window updated                       │
│    - Message inserted (INBOUND, DELIVERED)             │
│    - DB COMMIT                                         │
├────────────────────────────────────────────────────────┤
│ 3. Post-Commit Realtime Dispatch                       │
│    - ws_manager.broadcast(event, target_user_id)       │
└────────────────────────────────────────────────────────┘
        │ WebSocket (/ws?token=<JWT>)
        ▼
Frontend WhatsApp Hub (handleWsEvent)
  ├── 1. Deduplicate by wa_message_id
  ├── 2. Increment unread_count (or auto-mark read if thread active)
  ├── 3. Reorder ConversationList to top
  └── 4. Append message to active ChatThread with audio ping

                                 OUTBOUND FLOW
                                 ─────────────
Frontend ChatComposer
        │
        ▼ POST /api/v1/conversations/{id}/messages
┌────────────────────────────────────────────────────────┐
│ 1. Optimistic UI Append                                │
│    - status = 'PENDING'                                │
│    - client_message_id = 'cmsg_...'                    │
│    - ChatBubble displays pulsating Clock icon          │
├────────────────────────────────────────────────────────┤
│ 2. Backend Outbox & Window Validation                  │
│    - Freeform text verified against 24h window         │
│    - Message(PENDING) + OutboxMessage(PENDING) created │
│    - HTTP 201 Created                                  │
├────────────────────────────────────────────────────────┤
│ 3. OutboundWorker Dispatch                             │
│    - Meta Cloud API call with decrypted token          │
│    - Success: wamid assigned, status -> SENT           │
│    - DB COMMIT                                         │
├────────────────────────────────────────────────────────┤
│ 4. WebSocket Broadcast                                 │
│    - ws_manager.broadcast("message_status_updated",    │
│                           target_user_id)              │
└────────────────────────────────────────────────────────┘
        │
        ▼
Meta Delivery/Read Webhook ──► status -> DELIVERED ──► status -> READ
```

---

## 3. WebSocket Connection Layer (`/ws`)

### Endpoint & Authentication
- **Path**: `GET /ws?token=<Supabase_JWT>`
- **Handshake Flow**:
  1. The client passes the session JWT via query parameter `token`.
  2. The server decodes and extracts `sub` (`user_id`).
  3. `ConnectionManager.connect(websocket, user_id)` registers the socket in `active_connections` and maps `user_connections[user_id].add(websocket)`.
  4. On disconnect or network drop, `ConnectionManager.disconnect(websocket)` removes the socket from both collections, avoiding memory leaks.

### Tenant Isolation Guarantee
```python
async def broadcast(self, message: Union[dict, str], target_user_id: Optional[str] = None):
    # If target_user_id is specified, dispatch ONLY to sockets belonging to that user
    if target_user_id:
        user_sockets = self.user_connections.get(str(target_user_id), set())
        for connection in list(user_sockets):
            await connection.send_text(text)
        return
    # System broadcasts fall back to active connections
    for connection in list(self.active_connections):
        await connection.send_text(text)
```

---

## 4. WebSocket Domain Event Contracts

### 4.1 Inbound Message (`inbound_reply`)
Sent when a customer replies via WhatsApp:
```json
{
  "event": "inbound_reply",
  "provider": "META",
  "user_id": "00000000-0000-0000-0000-000000000000",
  "whatsapp_number_id": 1,
  "conversation_id": 42,
  "contact_id": 105,
  "message_id": "wamid.HBgL...",
  "wa_message_id": "wamid.HBgL...",
  "phone": "+905331112233",
  "sender_name": "Ahmet Yılmaz",
  "message": "Fiyat teklifinizi aldım, teşekkürler.",
  "message_type": "text",
  "unread_count": 1,
  "timestamp": "2026-09-10T12:00:00Z"
}
```

### 4.2 Message Status Progression (`message_status_updated`)
Sent as messages progress through `SENT`, `DELIVERED`, `READ`, or `FAILED`:
```json
{
  "event": "message_status_updated",
  "provider": "META",
  "user_id": "00000000-0000-0000-0000-000000000000",
  "message_id": "wamid.HBgL...",
  "wa_message_id": "wamid.HBgL...",
  "conversation_id": 42,
  "status": "DELIVERED",
  "error_code": null,
  "error_message": null,
  "timestamp": "2026-09-10T12:00:02Z"
}
```

---

## 5. Frontend State Reconciliation & Race Mitigation

### 5.1 Race Condition Mitigation in `loadMessages`
When switching conversations or fetching older history:
- Inbound realtime messages arriving while the HTTP `GET /api/v1/conversations/{id}/messages` request is in-flight are preserved.
- Messages are reconciled using a composite key: `wa_message_id || client_message_id || id`.

### 5.2 Optimistic Outbound Message Lifecycle
1. User clicks **Send**:
   - Message is added to active thread with `status = 'PENDING'` and a generated `client_message_id = 'cmsg_<timestamp>_<rand>'`.
   - UI renders message immediately with a subtle pulsating clock icon.
2. HTTP POST completes:
   - Server returns the persisted message entity (status `PENDING`, ID assigned).
   - Optimistic message is reconciled in-place.
3. OutboundWorker finishes:
   - WebSocket event `message_status_updated` (`status = 'SENT'`, `wa_message_id = 'wamid...'`) arrives.
   - Status transitions to single checkmark (`SENT`).
4. Meta delivers status updates:
   - Transitions to double checkmarks (`DELIVERED`) and blue double checkmarks (`READ`).

### 5.3 Reconnect Reconciliation
When WebSocket reconnects after a network interruption:
- Fires custom event `tezlify:ws_connected`.
- Triggers a silent refresh of `loadConversations()` and re-fetches active conversation messages without clearing the thread or causing layout shifts.

---

## 6. Verification & Test Coverage

### Test Results Summary
- **Phase 5 Dedicated Tests (`backend/tests/test_whatsapp_phase5_realtime.py`)**:
  - **16 Passed, 1 Skipped** (live Meta API check skipped in local mock mode).
- **Full Backend Regression Suite (`backend/tests/`)**:
  - **626 Passed, 4 Skipped** in 36.39 seconds.
  - Zero regressions across CRM, Scraper, Campaigns, Antiban, and WhatsApp.
- **Frontend TypeScript Build**:
  - `cd frontend && npm run build` passed with **0 errors**.

### Scenario Test Coverage Matrix
| Scenario | Description | Status |
|---|---|---|
| A | Inbound message webhook -> DB commit -> WebSocket broadcast | **PASS** |
| B | Outbound message POST -> PENDING -> worker dispatch -> SENT broadcast | **PASS** |
| C | SENT -> DELIVERED status webhook and realtime update | **PASS** |
| D | DELIVERED -> READ status webhook and double checkmark update | **PASS** |
| E | FAILED status webhook with Meta error code propagation | **PASS** |
| F | Duplicate inbound webhook idempotency (single event broadcast) | **PASS** |
| H | Duplicate outbound message submission idempotency | **PASS** |
| I & J | WebSocket disconnect, offline message handling & reconnect reconciliation | **PASS** |
| K | Tenant isolation (no cross-tenant socket leakage) | **PASS** |
| L | Multi-number conversation isolation by `whatsapp_number_id` | **PASS** |
| M & N | Active vs. inactive conversation unread count calculation | **PASS** |
| O | Conversation list sorting by most recent message timestamp | **PASS** |
| R & S | 24-hour customer service window active/expired calculation | **PASS** |
| T | Freeform text rejected (HTTP 422) when 24h window expired | **PASS** |
| U | Pre-approved template outbound allowed when 24h window expired | **PASS** |
| Y | Access token zero-leak verification (never sent to client) | **PASS** |
| Z | Verification that Baileys is not used by new pipeline | **PASS** |
| AA | Live Meta Cloud API end-to-end (requires `REAL_META_E2E=true`) | **SKIPPED (Mock Mode)** |
