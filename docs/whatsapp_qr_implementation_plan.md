# TEZLIFY — WHATSAPP QR / LINKED DEVICE MIGRATION
## PHASE 0.5: VALIDATED ARCHITECTURE PLAN & DOMAIN SPECIFICATION

> **Document Status**: ARCHITECTURE VALIDATED & HARDENED  
> **Package / Dependencies**: `@whiskeysockets/baileys` `^7.0.0-rc14`, `qrcode` `^1.5.3` (verified from `wa-gateway/package.json`)  
> **Target**: Unified WhatsApp Live Chat in Tezlify supporting both **Linked Device (Baileys QR)** and **Official Meta Cloud API** via a single, cohesive domain model.

---

## 1. Executive Summary & Key Architectural Decisions

Following forensic evaluation of the existing domain models, endpoints, and microservice capabilities, the architecture plan has been revised and hardened with the following non-negotiable architectural invariants:

### 1.1 Decision 1: Single Source of Truth — `WhatsAppNumber` is the Domain Root
- **Decision**: `WhatsAppNumber` is the **only domain aggregate root** representing a WhatsApp line/account in Tezlify.
- **ER Model**:
  ```
  ┌─────────────────────────────────────────────────────────┐
  │                     WhatsAppNumber                      │
  │                   (Domain Root Entity)                  │
  │  - id: Integer (PK)                                     │
  │  - user_id: UUID (Tenant)                               │
  │  - name: String ("Ahmet Satış Hattı")                   │
  │  - phone_number_e164: String ("+905321234567")          │
  │  - display_phone_number: String ("+90 532 123 45 67")    │
  │  - provider: Enum ('META_CLOUD', 'BAILEYS_QR')          │
  │  - status: Enum ('ACTIVE', 'DISCONNECTED', 'ERROR')     │
  └──────────────┬────────────────────────────┬─────────────┘
                 │ 1                          │ 1
                 │                            │
                 ▼ 0..1                       ▼ 0..N
  ┌──────────────────────────────┐  ┌─────────────────────────────────┐
  │       WhatsAppSession        │  │          Conversation           │
  │   (Baileys Technical State)  │  │        (Inbox Threads)          │
  │  - id: Integer (PK)          │  │  - id: Integer (PK)             │
  │  - whatsapp_number_id: FK    │  │  - user_id: UUID (Tenant)       │
  │  - session_name: String      │  │  - whatsapp_number_id: FK       │
  │  - qr_code: Text (Ephemeral) │  │  - contact_id: FK               │
  │  - status: Enum              │  │  - status: Enum ('ACTIVE', ...) │
  │  - battery_level: Integer    │  │  - unread_count: Integer        │
  │  - is_phone_online: Boolean  │  │  - last_message_at: DateTime    │
  └──────────────────────────────┘  └─────────────────────────────────┘
  ```
- **Rationale**: 
  - Having two separate line entities would fracture the application.
  - A physical phone number connected via QR is fundamentally a `WhatsAppNumber` with `provider = 'BAILEYS_QR'`.
  - The technical Baileys connection details (`qr_code`, `battery_level`, `session_name`) live in `WhatsAppSession`, linked 1:1 to `WhatsAppNumber`.

### 1.2 Decision 2: `Conversation` Schema Remains Pristine — Zero Redundant FKs
- **Decision**: **NO `whatsapp_session_id` column will be added to the `conversations` table.**
- **Rationale**: 
  - Every `Conversation` already has `user_id`, `whatsapp_number_id`, and `contact_id`.
  - `conv.whatsapp_number_id` answers the question: *"Bu konuşma hangi Tezlify kullanıcısının hangi WhatsApp hesabına ait?"*
  - If `conv.whatsapp_number.provider == 'BAILEYS_QR'`, the system accesses its 1:1 linked `WhatsAppSession` directly.
  - This avoids dual foreign keys, avoids `COALESCE(number_id, session_id)` queries, and protects existing database queries from breaking.

### 1.3 Decision 3: Clean Transport Dispatcher in `conversations.py`
- **Decision**: `POST /api/v1/conversations/{conversation_id}/messages` acts as the single unified outbound endpoint.
- **Routing**:
  - `conv.whatsapp_number.provider == 'BAILEYS_QR'` ➔ **Bypasses Meta 24h window** ➔ Routes directly to `wa-gateway` (`gateway_client.send_message`).
  - `conv.whatsapp_number.provider == 'META_CLOUD'` ➔ **Enforces Meta 24h window** ➔ Enqueues into `OutboxMessage` for Meta Cloud Outbound Worker.
- **Rationale**: The frontend `ChatComposer` never needs to know which transport is used; it simply posts to `/conversations/{id}/messages`.

### 1.4 Decision 4: Existing `wa_message_id` Column Used for Idempotency
- **Decision**: **NO new message ID column will be added to the `messages` table.**
- **Rationale**: 
  - `Message.wa_message_id` (and its synonym `external_message_id`) already has a strict `UNIQUE` constraint index.
  - Baileys message key `key.id` (e.g. `3EB0C8B...`) is stored directly in `Message.wa_message_id`.
  - Inbound webhook deduplication checks `where(Message.wa_message_id == payload.wa_message_id)` to prevent replay duplicates.

### 1.5 Decision 5: Official Baileys `WAMessageStatus` Enum Alignment
- **Decision**: Baileys status updates are mapped using `@whiskeysockets/baileys` exports (`WAMessageStatus`), not arbitrary integers:
  - `WAMessageStatus.SERVER_ACK (2)` ➔ `SENT`
  - `WAMessageStatus.DELIVERY_ACK (3)` ➔ `DELIVERED`
  - `WAMessageStatus.READ (4)` / `PLAYED (5)` ➔ `READ`
  - `WAMessageStatus.ERROR (0)` ➔ `FAILED`
- **Rationale**: Directly conforms to the Baileys protocol specification and preserves monotonic progression in `MessageStateMachine`.

### 1.6 Decision 6: Session Directory Isolation via Immutable IDs
- **Decision**: Session directories in `wa-gateway` are strictly isolated on disk as:
  `wa-gateway/sessions/tenant_{user_id}/session_{session_id}/`
- **Rationale**:
  - User-editable names (`session_name`) can change or contain invalid characters.
  - Using immutable `user_id` and `session_id` guarantees stability, prevents path traversal (`..`), and ensures cross-tenant filesystem isolation.

---

## 2. Inbound Message Resolution Matrix

When `@whiskeysockets/baileys` receives `messages.upsert`:

```
┌─────────────────────────┐
│     messages.upsert     │
│   (Baileys Event)       │
└────────────┬────────────┘
             │
             ├─► 1. Check `key.fromMe`:
             │      - If true: Outbound message sent from phone. Process sync or skip.
             │      - If false: Inbound message from contact.
             │
             ├─► 2. Resolve Sender Identity:
             │      - If `key.remoteJid` ends with `@s.whatsapp.net`: 1:1 Direct Chat.
             │      - If `key.remoteJid` ends with `@lid`: Resolve via `findPnForLid(sessionData)`.
             │      - If `key.remoteJid` ends with `@g.us`: Group Chat. `participant` is the sender.
             │
             ├─► 3. Webhook Dispatch to FastAPI:
             │      POST /api/v1/whatsapp/webhook/inbound
             │      Header: X-Webhook-Secret: <SECRET>
             │      Payload: {
             │          "session_id": session.id,
             │          "session_name": session.session_name,
             │          "wa_message_id": msg.key.id,
             │          "remote_jid": cleanJid,
             │          "phone": normalizedPhone,
             │          "message": extractMessageText(msg),
             │          "push_name": msg.pushName,
             │          "is_group": isGroup,
             │          "timestamp": extractTimestamp(msg.messageTimestamp)
             │      }
             ▼
┌─────────────────────────┐
│     FastAPI Backend     │
│ (/webhook/inbound)      │
└────────────┬────────────┘
             │
             ├─► 4. Authenticate `X-Webhook-Secret` (Timing-safe comparison).
             │
             ├─► 5. Resolve Tenant & WhatsAppNumber:
             │      Query `WhatsAppSession` where `id == payload.session_id`.
             │      Resolve linked `WhatsAppNumber` via `session.whatsapp_number_id`.
             │      `user_id = session.user_id`.
             │
             ├─► 6. Idempotency Check:
             │      Query `select(Message.id).where(Message.wa_message_id == payload.wa_message_id)`.
             │      If exists: RETURN 200 OK (Skip duplicate).
             │
             ├─► 7. Resolve / Upsert Contact:
             │      Match `Contact` on `(user_id, phone_e164)`.
             │      If missing: Insert `Contact(user_id, phone_e164, display_name=push_name)`.
             │
             ├─► 8. Resolve / Upsert Conversation:
             │      Match `Conversation` on `(user_id, whatsapp_number_id, contact_id)`.
             │      If missing: Insert `Conversation(user_id, whatsapp_number_id, contact_id)`.
             │
             ├─► 9. Insert Message & Update Conversation:
             │      Insert `Message(direction=INBOUND, status=DELIVERED, wa_message_id=key.id, ...)`.
             │      Update `conv.unread_count += 1`, `conv.last_message_at = timestamp`.
             │
             ├─► 10. COMMIT Transaction:
             │       `await db.commit()` (DB state guaranteed before notification).
             │
             └─► 11. Realtime Broadcast:
                     `await ws_manager.broadcast({"event": "inbound_reply", ...}, target_user_id=user_id)`
```

---

## 3. Outbound Message Routing & Transport Matrix

```
                      POST /api/v1/conversations/{id}/messages
                                          │
                                          ▼
                         Tenant Authorization & Validation
                         - conv.user_id == current_user.id
                         - conv.status != CLOSED
                         - payload.body non-empty
                                          │
                                          ▼
                      Inspect conv.whatsapp_number.provider
                                          │
                   ┌──────────────────────┴──────────────────────┐
                   ▼                                             ▼
         provider == 'BAILEYS_QR'                      provider == 'META_CLOUD'
                   │                                             │
                   ├─► Skip Meta 24h Window Check                ├─► Enforce Meta 24h Window Check
                   │                                             │   (422 if expired and freeform text)
                   ├─► Insert Message(status=PENDING)            │
                   │                                             ├─► Insert Message(status=PENDING)
                   ├─► Fetch linked WhatsAppSession              │   + OutboxMessage(status=PENDING)
                   │                                             │
                   ├─► Call wa-gateway /api/send:                ├─► Commit DB Transaction
                   │   `gateway_client.send_message(...)`        │
                   │                                             ├─► Return HTTP 201 Created
                   ├─► On Success:                               │
                   │   - Update Message(status=SENT,             └─► OutboundWorker Daemon (Lifespan)
                   │                    wa_message_id=msgId)           - Claims OutboxMessage
                   │   - Commit DB Transaction                         - Decrypts token at send boundary
                   │   - Broadcast "message_status_updated"            - POST Graph API /messages
                   │                                                   - Updates Message to SENT
                   ├─► On Gateway Failure:                             - Broadcasts WebSocket event
                   │   - Rollback / Update Message(FAILED)
                   │   - Raise HTTP 502 with clean error
                   │
                   └─► Return HTTP 201 Created
```

---

## 4. History Synchronization Strategy

To prevent memory spikes, gateway locks, or multi-gigabyte database bloat, the initial sync operates under strict, bounded guarantees:

1. **Initial Connection (`messaging-history.set`)**:
   - **Chat Threads**: Syncs up to **100 most recent chats**. Each chat is mapped into a `Contact` and `Conversation` under `conv.whatsapp_number_id`.
   - **Message Depth**: Syncs up to **10 most recent messages per chat**.
   - **Age Cutoff**: Messages older than **30 days** are ignored during initial sync.
2. **Delta Poll & WebSocket Updates**:
   - Live incoming messages are appended in real time via `messages.upsert`.
   - The user can click **"Eşitle" (Sync)** in the UI to trigger a fast delta sync (`GET /api/sessions/:sessionName/chats/delta?since=rev`).
3. **Database as Single Source of Truth**:
   - The left sidebar (`ConversationList`) queries Tezlify's database.
   - All filters (`Tümü`, `Aktif`, `Okunmamış`, `Arşiv`, `Kapalı`) operate strictly over `conversations` records.

---

## 5. Security & Multi-Tenant Isolation Specifications

1. **Elimination of Development Fallbacks**:
   - Remove `if settings.SECRET_KEY == "dev-only-insecure-secret-key": return True` from `_can_manage_session`.
   - Remove `if session.user_id is None: return True`.
   - Every session request must verify: `session.user_id == current_user.id`.
2. **Filesystem Tenant Namespacing**:
   - Directory format: `wa-gateway/sessions/tenant_{user_id}/session_{session_id}/`.
   - Path components are strictly sanitized integers and UUIDs, preventing directory traversal (`../`).
3. **Zero Credential Exposure**:
   - `session.qr_code` is set to `None` immediately upon reaching `CONNECTED` or `DISCONNECTED`.
   - Session keys (`creds.json`) are never logged or returned in any REST API response.
4. **Denial-of-Service & Duplicate Protection**:
   - Gateway uses an in-flight initialization map (`inFlightInits`) to reject concurrent duplicate connect requests for the same session.

---

## 6. Revised Phase Roadmap (Phases 1–10)

```
PHASE 1: Unified Domain Model & WhatsAppNumber 1:1 Linkage
PHASE 2: wa-gateway Port 3001 Hardening & Immutable Paths
PHASE 3: Frontend "QR ile Telefon Bağla" Modal & SessionCard
PHASE 4: Inbound Webhook Event Bridge with wa_message_id Deduplication
PHASE 5: Outbound Message Dispatcher (Baileys Transport in conversations.py)
PHASE 6: Live Delivery & Read Receipts (messages.update ➔ WAMessageStatus)
PHASE 7: Bounded History Synchronization (Top 100 chats, 10 msgs/chat)
PHASE 8: Auto-Reconnect, Heartbeat & Reliability Daemon
PHASE 9: Multi-Tenant Security Audit & Negative Access Tests
PHASE 10: Real Physical Device Verification & Acceptance Walkthrough
```

---

## 7. File Change Impact Matrix (Minimal Surface Area)

| File Path | Current Status | Planned Modification | Rationale |
|---|---|---|---|
| `backend/app/models/whatsapp_number.py` | Meta Cloud API entity | 1. Add `provider = Column(String(20), default="META_CLOUD")`<br>2. Make `phone_number_id` nullable (or populated as `qr_{session_id}` for QR lines)<br>3. Add 1:1 relation to `WhatsAppSession` | Unifies all WhatsApp lines under `WhatsAppNumber` as Domain Aggregate Root. |
| `backend/app/models/whatsapp_session.py` | Baileys session entity | Add `whatsapp_number_id = Column(Integer, ForeignKey("whatsapp_numbers.id"), nullable=True, unique=True)` | Establishes strict 1:1 linkage to the parent `WhatsAppNumber`. |
| `backend/app/models/conversation.py` | Conversation entity | **NO CHANGES NEEDED.** | Preserves clean existing schema; `whatsapp_number_id` remains the sole line identifier. |
| `backend/app/api/v1/endpoints/conversations.py` | Outbound messaging endpoint | In `send_message_to_conversation`: check `conv.whatsapp_number.provider`. If `BAILEYS_QR`, dispatch via `gateway_client.send_message` without 24h window check. | Seamless dual-transport outbound routing from a single endpoint. |
| `backend/app/api/v1/endpoints/whatsapp.py` | Session management & webhooks | 1. Remove insecure dev bypasses in `_can_manage_session`.<br>2. Deduplicate inbound messages by `Message.wa_message_id`.<br>3. Add `POST /webhook/message-status` for delivery/read acks. | Multi-tenant security, idempotent message storage, and tick status updates. |
| `wa-gateway/src/sessionManager.js` | Baileys gateway manager | 1. Use immutable directory `tenant_{user_id}/session_{session_id}`.<br>2. Pass `wa_message_id` in inbound webhook.<br>3. Emit `messages.update` using `WAMessageStatus` constants. | Filesystem tenant isolation, deduplication, and read receipt tracking. |
| `frontend/src/pages/WhatsAppHubPage.tsx` | Main WhatsApp Hub UI | 1. Add "QR ile Telefon Bağla" button in "Aktif Numaralar".<br>2. Render `SessionCard` for linked devices alongside `WhatsAppNumberCard`.<br>3. Wire up `isQRModalOpen` with countdown and WebSocket refresh. | User interface for scanning QR code and viewing connected devices. |
| `frontend/src/components/domain/WhatsAppQrConnectModal.tsx` | New component | Encapsulate QR display, 25s countdown timer, refresh action, and pairing code tab. | Clean, reusable modal adhering to Vuexy design rules. |
