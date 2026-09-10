# TEZLIFY — WHATSAPP CONVERSATIONS REBUILD
# PHASE 0 — FORENSIC AUDIT & TARGET ARCHITECTURE SPECIFICATION

> **Status**: PHASE 0 COMPLETE  
> **Document**: `docs/whatsapp-rebuild/PHASE_0_FORENSIC_AUDIT.md`  
> **Target System**: Meta WhatsApp Business Platform (Cloud API / Graph API v21+)  
> **Execution Constraint**: Forensic analysis & architecture only. No premature implementation, no mock code preservation, no destructive database drops, and 100% frontend Vuexy design preservation.

---

## 1. Current Architecture

### 1.1 The Dual-Identity Architectural Flaw
The existing codebase suffers from a fundamental architectural contradiction: it attempts to be both a **reverse-engineered WhatsApp Web automation gateway (via Baileys / Puppeteer / QR code / Signal protocol sessions)** and an **incomplete wrapper around the official Meta WhatsApp Cloud API (Graph API v21.0)**.

```
                    CURRENT FRAGMENTED ARCHITECTURE
                    
                         ┌────────────────────┐
                         │   Tezlify Frontend │
                         │ (WhatsAppHubPage)  │
                         └─────────┬──────────┘
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
        [Baileys / Web Flow]                [Meta Cloud Flow]
      /api/v1/whatsapp/sessions             /api/v1/conversations
      /api/v1/conversations/sync            /api/v1/whatsapp/cloud-webhook
                 │                                   │
                 ▼                                   ▼
      ┌─────────────────────┐             ┌─────────────────────┐
      │  wa-gateway (Node)  │             │ WhatsAppCloudClient │
      │  Baileys / Protocol │             │ (Single Global .env)│
      └──────────┬──────────┘             └──────────┬──────────┘
                 │                                   │
                 ▼                                   ▼
        [WhatsApp Web Client]                [Meta Graph API]
        (Unofficial / Fragile)             (Official / Business)
```

1. **Baileys Gateway (`wa-gateway`)**:
   - A standalone Node.js microservice (`wa-gateway/src/index.js`, `sessionManager.js`) connecting to WhatsApp Web using the unofficial Baileys WebSocket protocol.
   - Requires browser-like QR code pairing, manages ephemeral session stores (`chats_store.json`), and handles Multi-Device Linked Identifiers (LID vs PN) with complex heuristics.
   - Backed into the FastAPI server via `whatsapp_gateway_client.py` and `whatsapp_chat_sync_service.py`.
   - The frontend continuously polls `/api/v1/conversations/sync-whatsapp/delta` every 4 seconds to reconcile changes.

2. **Meta Cloud API Endpoints**:
   - An independent set of endpoints (`/api/v1/whatsapp/cloud-webhook`) and services (`whatsapp_cloud_client.py`, `whatsapp_cloud_service.py`).
   - Reads a single set of global credentials from `.env` (`WHATSAPP_CLOUD_ACCESS_TOKEN`, `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_WABA_ID`).
   - Completely disconnected from multi-account/multi-number routing; unable to bind different phone numbers to different users or channels.

3. **Conflicting Outbound Message Dispatching**:
   - `WhatsAppOutboundService.send_conversation_message`:
     - Checks if a Baileys session exists (`active_session`) -> calls `gateway_client.send_message`.
     - Else checks `is_sim` -> creates a dummy `wamid.SIM_...`.
     - Else calls `WhatsAppCloudApiClient` using global environment variables.
   - `whatsapp_sender.py`:
     - Defines `WhatsAppSender` protocol with three conflicting implementations: `SimulatedSender`, `GatewaySender`, and `CloudApiSender`.
     - Used by `CampaignRunner` and `OutreachManager` for bulk campaigns, completely disconnected from `Conversation` threads.

### 1.2 Data Boundary Violation (Meta vs. Tezlify Canonical DB)
- The existing chat sync mechanism treated the connected WhatsApp Web client as the primary message source, polling the gateway and inserting/mutating `Lead` and `Conversation` records in bulk.
- Conversations were forced to depend on `Lead` records (`conversations.lead_id NOT NULL`), meaning an inbound WhatsApp conversation could not exist without creating or mutating a CRM Lead.
- No dedicated `WhatsAppNumber` entity exists. As a result, incoming webhooks cannot distinguish whether a message arrived at Number A or Number B.

---

## 2. Frontend WhatsApp Components

The frontend is built using React 18, TypeScript, Tailwind CSS, and the Vuexy design system.

| Component Path | Visual Role & UX Responsibilities | Current Backend Coupling / Flaws | Preservation Strategy |
| :--- | :--- | :--- | :--- |
| [`frontend/src/pages/WhatsAppHubPage.tsx`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/pages/WhatsAppHubPage.tsx) | Main hub container. Hosts 3 segmented tabs: *Canlı Diyaloglar*, *Aktif Numaralar*, *Anti-Ban Politikası*. Houses top stats, lead drawer, modals, and layout wrappers. | Monolithic file (1932 lines). Directly coordinates Baileys QR code countdowns, pairing code requests, 4-second polling delta loops, and optimistic state wipes. | **KEEP DESIGN**: Retain exact layout, spacing, cards, and tab transitions. Decouple from Baileys QR polling. Bind to clean REST API & WebSocket streams. |
| [`frontend/src/components/domain/ConversationList.tsx`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/components/domain/ConversationList.tsx) | Left sidebar list. Displays search input, filter tabs (`Tümü`, `Aktif`, `Okunmamış`, `Arşiv`, `Kapalı`), `Yeni Sohbet` button, `Eşitle` button, unread count badges, avatar initials, and last message previews. | Contains client-side deduplication heuristics (`seen.set(key)`) matching last 10 digits to mask gateway split bugs. | **KEEP DESIGN**: Retain 100% of the UI, badges, filters, search, and avatar design. Feed cleanly from paginated `/api/v1/conversations` query. |
| [`frontend/src/components/domain/ChatThread.tsx`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/components/domain/ChatThread.tsx) | Center/Right panel chat stream. Chronological bubble feed, smart scroll anchoring, "New message" jump pill, date separators (*Bugün*, *Dün*), and skeleton states. | Client-side sorts messages by timestamps. Lacks server cursor pagination coordination. | **KEEP DESIGN**: Retain thread styling, auto-scroll behavior, and date grouping. Bind to cursor-based `/messages` loader. |
| [`frontend/src/components/domain/ChatComposer.tsx`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/components/domain/ChatComposer.tsx) | Bottom message action bar. Input text field, send action, attachment popup (Image, Document modals), template selection trigger, and closed-dialog reopen button. | Optimistically assumes message send is always synchronous. Lacks 24-hour customer window enforcement indicators. | **KEEP DESIGN**: Retain Vuexy button styling, attachment modal triggers, and keyboard bindings (`Enter` to send). Add 24h window policy status indicator. |
| [`frontend/src/components/domain/ChatBubble.tsx`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/components/domain/ChatBubble.tsx) | Individual message bubble. Differentiates INBOUND (left/neutral) vs OUTBOUND (right/Vuexy purple-gradient). Status ticks: SENT (single tick), DELIVERED (double tick), READ (cyan double tick), FAILED (red alert + retry). Lightbox for media. | Tightly bound to legacy `Message` interface; hardcoded retry calling legacy endpoint. | **KEEP DESIGN**: Retain the exact bubble aesthetic, status icons, lightbox, and typography. Bind status transitions to Meta Cloud status updates. |
| [`frontend/src/components/domain/SessionCard.tsx`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/components/domain/SessionCard.tsx) | Active number display card. Shows warmup day, daily quota progress bar, connection status badge, QR scan trigger, disconnect, and delete actions. | Designed exclusively around Baileys QR sessions (shows battery level, socket live, warmup). Does not display Meta Cloud API fields (WABA ID, Phone Number ID, Quality Rating). | **REFACTOR TO CLOUD**: Preserve the exact card structure, badges, and progress bars, but repurpose fields to show Meta Phone Number ID, Display Number, Verified Name, WABA ID, and Quality Rating. |
| [`frontend/src/components/domain/NewChatModal.tsx`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/components/domain/NewChatModal.tsx) | Modal to initiate outreach to a new recipient phone number with optional name and initial message. | Calls `ApiClient.startConversation` which directly invokes legacy `/conversations/start`. | **KEEP DESIGN**: Preserve exact modal form, labels, validation, and styling. Route to clean conversation initiation endpoint. |
| [`frontend/src/components/domain/TemplateSelectModal.tsx`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/components/domain/TemplateSelectModal.tsx) | Modal to select pre-approved business templates, dynamically populate parameter inputs, view live rendered preview, and submit. | Uses hardcoded mock templates from `whatsapp_template_service.py`. | **KEEP DESIGN**: Preserve modal styling and preview layout. Connect to real Meta Cloud API Template Management API. |
| [`frontend/src/hooks/useWhatsAppConversation.ts`](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/hooks/useWhatsAppConversation.ts) | React custom hook managing conversation selection, cursor pagination (`loadOlderMessages`), optimistic outbound updates, and mark-as-read triggers. | Contains mixed optimistic simulation IDs (`-Date.now()`) and redundant mark-as-read calls. | **REFACTOR**: Retain signature and reactive interface. Clean up optimistic state reconciliation with canonical server IDs. |

---

## 3. Backend WhatsApp Components

| Module / Class | Path | Responsibility | Dependencies | Forensic Classification |
| :--- | :--- | :--- | :--- | :--- |
| `conversations.py` | [`backend/app/api/v1/endpoints/conversations.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/api/v1/endpoints/conversations.py) | Router for conversation CRUD, message pagination, outbound text/media/template dispatches, and Baileys sync. | `WhatsAppOutboundService`, `gateway_client`, `WhatsAppChatSyncService`, `Conversation`, `Message` | **REFACTOR**: Strip Baileys sync endpoints (`/sync-whatsapp`, `/sync-whatsapp/delta`). Retain clean REST contracts for conversation listing, messages, status, and media. |
| `whatsapp.py` | [`backend/app/api/v1/endpoints/whatsapp.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/api/v1/endpoints/whatsapp.py) | Router for Baileys sessions, QR codes, pairing codes, demo connections, Baileys webhooks, and auth backups. | `WhatsAppSession`, `gateway_client`, `WhatsAppSessionAuth`, `ws_manager` | **REMOVE / REPLACE**: Deprecate Baileys session management. Replace with `/whatsapp/numbers` CRUD for Meta Cloud API phone numbers. |
| `whatsapp_cloud_webhook.py` | [`backend/app/api/v1/endpoints/whatsapp_cloud_webhook.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/api/v1/endpoints/whatsapp_cloud_webhook.py) | Meta Webhook GET (verification challenge) and POST (event ingestion) endpoint. Validates HMAC signature. | `WhatsAppCloudService`, `parse_meta_webhook_payload`, `settings` | **REFACTOR**: Decouple synchronous processing. Return fast HTTP 200 immediately, push raw event to async ingestion worker/queue, preserve HMAC validation. |
| `WhatsAppOutboundService` | [`backend/app/services/whatsapp_outbound_service.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_outbound_service.py) | Outbound message orchestrator. Handles idempotency cache, recipient phone resolution, 24h window checks, and dispatching. | `WhatsAppCloudApiClient`, `gateway_client`, `Conversation`, `Message`, `ws_manager` | **REFACTOR**: Remove Baileys branch. Implement clean Meta Cloud API Adapter dispatching with strict message state machine (`PENDING` -> `SENT`). |
| `WhatsAppCloudService` | [`backend/app/services/whatsapp_cloud_service.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_cloud_service.py) | Ingests incoming webhook messages and status updates from Meta Graph API. | `Lead`, `Blacklist`, `MessageLog`, `Conversation`, `Message`, `ws_manager` | **REFACTOR**: Decouple from single global `.env`. Route events based on `phone_number_id`. Implement strict monotonic message status transitions. |
| `WhatsAppCloudApiClient` | [`backend/app/services/whatsapp_cloud_client.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_cloud_client.py) | Httpx client for Meta Graph API. Constructs payloads for text, template, media, and download endpoints. | `httpx`, `settings` | **REFACTOR**: Allow dynamic instantiation per `WhatsAppNumber` (using number-specific token and `phone_number_id`), rather than static `.env` singletons. |
| `WhatsAppTemplateService` | [`backend/app/services/whatsapp_template_service.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_template_service.py) | Pre-configured template definitions, variable interpolation, and outbound dispatching. | `Conversation`, `Message`, `WhatsAppCloudApiClient` | **REFACTOR**: Transition from static Python dictionaries to dynamic Meta Cloud API Template synchronization. |
| `WhatsAppChatSyncService` | [`backend/app/services/whatsapp_chat_sync_service.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_chat_sync_service.py) | Ingests raw Baileys chat dumps, resolves LID aliases, and creates duplicate leads. | `LeadIngestService`, `PhoneService`, `Conversation`, `Lead` | **REMOVE**: Obsolete. Meta Cloud API delivers events via webhooks; polling chat dumps is an anti-pattern. |
| `WhatsAppGatewayClient` | [`backend/app/services/whatsapp_gateway_client.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_gateway_client.py) | Httpx client communicating with `wa-gateway` microservice on port 3001. | `httpx`, `settings` | **REMOVE**: Obsolete once Baileys gateway is eliminated. |
| `WhatsAppSender` & implementations | [`backend/app/services/whatsapp_sender.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_sender.py) | Protocol with `SimulatedSender`, `GatewaySender`, `CloudApiSender`. | `httpx`, `settings`, `WhatsAppCloudApiClient` | **REFACTOR**: Unify campaign outreach and conversation messaging under a single Meta Cloud API domain port. |
| `wa-gateway/` | [`wa-gateway/src/index.js`](file:///Users/isatezcan/Documents/Github/Scoutify/wa-gateway/src/index.js), `sessionManager.js` | Standalone Node.js Baileys reverse-engineering gateway. | `@whiskeysockets/baileys`, `qrcode`, `pino` | **REMOVE**: Obsolete. Completely eliminate unofficial WhatsApp Web automation layer. |

---

## 4. Database Models

```
CURRENT FRAGMENTED DATABASE SCHEMA
==================================

┌───────────────────────┐             ┌─────────────────────────┐
│     leads             │             │   whatsapp_sessions     │
│───────────────────────│             │─────────────────────────│
│ id (PK)               │◄──────┐     │ id (PK)                 │
│ name                  │       │     │ session_name (UNIQUE)   │
│ phone                 │       │     │ phone_number            │
│ phone_e164            │       │     │ status (SCAN_QR, etc.)  │
│ custom_data (JSON)    │       │     │ qr_code (TEXT)          │
└───────────────────────┘       │     │ warm_up_day             │
                                │     │ auth_bundle (FK)        │
                                │     └─────────────────────────┘
┌───────────────────────┐       │
│   conversations       │       │     ┌─────────────────────────┐
│───────────────────────│       │     │   message_logs          │
│ id (PK)               │       │     │─────────────────────────│
│ lead_id (FK NOT NULL) ├───────┘     │ id (PK)                 │
│ channel ('WHATSAPP')  │             │ lead_id (FK)            │
│ status (ACTIVE, etc.) │             │ session_id (FK NULL)    │
│ unread_count          │             │ target_phone            │
│ last_message_preview  │             │ status (SENT, etc.)     │
└──────────┬────────────┘             │ wa_message_id           │
           │                          └─────────────────────────┘
           ▼
┌───────────────────────┐
│     messages          │
│───────────────────────│
│ id (PK)               │
│ conversation_id (FK)  │
│ direction (IN/OUT)    │
│ wa_message_id (UNIQUE)│
│ status (SENT, etc.)   │
│ body (TEXT)           │
│ media_id, caption...  │
└───────────────────────┘
```

### Critical Deficiencies in Current Schema:
1. **No WhatsApp Number / Channel Model**:
   - `whatsapp_sessions` is a Baileys session table with columns like `qr_code`, `battery_level`, `is_phone_online`, and `warm_up_day`.
   - It completely lacks Meta Cloud API fields: `phone_number_id`, `waba_id`, `access_token`, `webhook_verify_token`, `quality_rating`, and `verified_name`.
2. **Missing Number Foreign Key on `conversations`**:
   - `Conversation` only has `lead_id`, `channel`, and `user_id`. It has no `whatsapp_number_id`.
   - Result: Multi-number isolation is impossible. If Number A and Number B talk to the same customer, their message histories collide into a single conversation.
3. **Mandatory `lead_id` Dependency**:
   - `conversations.lead_id` has `nullable=False`. If an unknown person messages the WhatsApp business number, the system cannot create a conversation without synthesizing a full CRM `Lead` entity.
4. **No Customer Service Window State**:
   - `Conversation` lacks `customer_service_window_expires_at` and `last_customer_message_at`, making it impossible to enforce Meta's 24-hour service window policy cleanly at the database layer.
5. **Duplicate Message Storage (`messages` vs `message_logs`)**:
   - `messages` is used for live conversations (`ConversationMessageStatus`: `RECEIVED`, `SENT`, `DELIVERED`, `READ`, `FAILED`).
   - `message_logs` is used for automated campaigns (`MessageStatus`: `PENDING`, `QUEUED`, `SENDING`, `SENT`, `DELIVERED`, `READ`, `REPLIED`, `FAILED`, `CANCELLED`).
   - Both store `wa_message_id`, leading to data desynchronization and duplicate webhook status updates.

---

## 5. API Endpoints

### 5.1 Conversations API (`/api/v1/conversations`)
| Endpoint | Method | Current Status | Target Action |
| :--- | :--- | :--- | :--- |
| `/` | `GET` | Lists conversations with filters (`status`, `unread_only`, `search`). | **REFACTOR**: Add `whatsapp_number_id` filter; optimize query to return slim summaries with zero N+1 joins. |
| `/{id}` | `GET` | Returns conversation details with initial message batch. | **KEEP**: Preserved for conversation view. |
| `/{id}/messages` | `GET` | Returns chronological messages with before-cursor pagination. | **KEEP**: Preserved for scroll-up history. |
| `/{id}/messages` | `POST` | Dispatches outbound message via `WhatsAppOutboundService`. | **REFACTOR**: Route purely through Meta Cloud API; enforce 24h window and state machine. |
| `/{id}/templates/send` | `POST` | Sends pre-configured template message. | **REFACTOR**: Connect to Meta Cloud API Template endpoint with approved variables. |
| `/{id}/messages/{msg_id}/retry`| `POST` | Retries failed message. | **REFACTOR**: Connect to Meta Cloud API retry dispatcher. |
| `/{id}/media` | `POST` | Sends outbound image or document. | **REFACTOR**: Integrate with Meta Cloud API Media Upload (`POST /{phone_number_id}/media`). |
| `/{id}/status` | `PATCH` | Updates status (`ACTIVE`, `ARCHIVED`, `CLOSED`). | **KEEP**: Preserved for folder organization. |
| `/{id}/read` | `POST` | Marks conversation as read. | **REFACTOR**: Also dispatch Meta Graph API mark-as-read status (`status: "read"`). |
| `/start` | `POST` | Initiates new conversation with phone number. | **REFACTOR**: Associate with specific selected `whatsapp_number_id`. |
| `/sync-whatsapp` | `POST` | Triggers full Baileys chat dump from Node gateway. | **REMOVE**: Obsolete in Meta Cloud API architecture. |
| `/sync-whatsapp/delta` | `POST` | Polled every 4 seconds by frontend for Baileys chat changes. | **REMOVE**: Obsolete. Webhooks + WebSockets provide instant push notifications. |

### 5.2 Legacy WhatsApp API (`/api/v1/whatsapp`)
| Endpoint | Method | Current Flaw | Target Action |
| :--- | :--- | :--- | :--- |
| `/sessions` | `GET`, `POST` | Manages Baileys QR sessions. | **REMOVE**: Replace with `/whatsapp/numbers` CRUD. |
| `/sessions/{id}/qr` | `GET` | Fetches Baileys QR code string. | **REMOVE**: Not applicable to Meta Cloud API. |
| `/sessions/{id}/refresh-qr`| `POST` | Generates new Baileys QR. | **REMOVE**: Not applicable to Meta Cloud API. |
| `/sessions/{id}/pairing-code`| `POST` | Requests Baileys 8-digit code. | **REMOVE**: Not applicable to Meta Cloud API. |
| `/sessions/{id}/connect-demo`| `POST` | Hardcodes fake `CONNECTED` state. | **REMOVE**: Violation of AGENTS.md 1.1 invariant. |
| `/sessions/{id}/disconnect` | `POST` | Disconnects Baileys socket. | **REMOVE**: Replace with deactivate/pause number. |
| `/sessions/{id}` | `DELETE` | Deletes session and aggressively cascades to delete user leads/conversations. | **REMOVE / REPLACE**: Implement safe number unlinking without cascading data loss. |
| `/webhook/inbound` | `POST` | Ingestion endpoint for Baileys Node gateway. | **REMOVE**: Obsolete. |
| `/webhook/chats-synced` | `POST` | Chat dump webhook from Baileys Node gateway. | **REMOVE**: Obsolete. |
| `/webhook/session-status` | `POST` | Socket status webhook from Baileys. | **REMOVE**: Obsolete. |
| `/webhook/session-backup` | `POST` | Dumps Baileys auth tokens into PostgreSQL. | **REMOVE**: Obsolete. |
| `/webhook/session-restore*`| `GET` | Restores Baileys auth tokens into Node container. | **REMOVE**: Obsolete. |

### 5.3 Meta Cloud Webhook API (`/api/v1/whatsapp/cloud-webhook`)
| Endpoint | Method | Current Status | Target Action |
| :--- | :--- | :--- | :--- |
| `/` | `GET` | Validates `hub.challenge` and `hub.verify_token`. | **KEEP & REFACTOR**: Support per-number or global verify tokens. |
| `/` | `POST` | Ingests Meta webhook payload with `X-Hub-Signature-256`. | **REFACTOR**: Return immediate HTTP 200, decouple processing via asynchronous worker, enforce multi-number routing via `phone_number_id`. |

---

## 6. Webhook Implementation

### 6.1 Meta Cloud API Inbound & Verification Contracts
The Meta WhatsApp Business Platform webhook operates on two strict lifecycles:

```
                  META WEBHOOK PROCESSING PIPELINE
                  
[Meta Graph API] ──────── POST /webhook ───────► [FastAPI Webhook Handler]
                                                         │
                                    1. Validate X-Hub-Signature-256
                                    2. Extract phone_number_id
                                    3. Persist Raw WebhookEvent (Idempotency)
                                    4. Enqueue Background Task
                                                         │
                                    ◄──── Return HTTP 200 (Within 3s)
                                                         │
                                                         ▼
                                             [Async Background Worker]
                                                         │
                             ┌───────────────────────────┴───────────────────────────┐
                             ▼                                                       ▼
                  [Incoming Message Event]                                [Status Update Event]
                  - Find WhatsAppNumber by phone_number_id                - Find Message by wamid
                  - Find/Create Contact & Conversation                    - Monotonic check (SENT->DELIVERED->READ)
                  - Check 24h Window & Opt-Out Keywords                   - Update Message status in DB
                  - Insert Message (wamid Idempotency)                    - Broadcast status update via WS
                  - Broadcast to UI via WebSocket
```

### 6.2 Flaws in Existing Webhook Handler:
1. **Synchronous Execution**: The current handler in `whatsapp_cloud_webhook.py` iterates through all messages and status updates synchronously using `await WhatsAppCloudService.process_incoming_message(db=db, msg=msg)`. If database transactions take longer than 3 seconds under burst traffic, Meta marks the webhook as timed out and aggressively retries, causing stampedes.
2. **Metadata Omission**: `parse_meta_webhook_payload` in `whatsapp_cloud.py` drops `metadata.phone_number_id` and `metadata.display_phone_number`. As a result, `WhatsAppCloudService` has no information about which business number received the message.
3. **Missing Raw Webhook Audit Table**: Payloads are parsed in-memory and discarded. If a downstream parsing error occurs, the original Meta webhook payload is permanently lost with no retry capability.

---

## 7. Active Numbers Implementation ("Aktif Numaralar")

### 7.1 Deep Forensic Root Cause Analysis
The "Aktif Numaralar" tab was designed purely for scanning QR codes with Baileys. It provides zero facilities for Meta Cloud API integration:

1. **No Cloud API Onboarding Flow**:
   - Clicking "Yeni Hat Ekle" (`handleCreateSession`) generates an auto-incremented string (`"Line 1"`, `"Line 2"`) and sends `POST /api/v1/whatsapp/sessions`.
   - It immediately opens a QR code modal (`isQRModalOpen`) and polls for a Baileys QR string or 8-digit pairing code.
   - There is no modal to input Meta credentials: **Phone Number ID**, **WABA ID**, **Display Phone Number**, or **Permanent System User Access Token**.

2. **Severe Cascading Data Loss Bug on Deletion**:
   - In [`whatsapp.py` (lines 409-451)](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/api/v1/endpoints/whatsapp.py#L409-L451):
     ```python
     # Aggressive deletion of conversations and leads on session delete:
     if not is_last_session:
         conv_stmt = conv_stmt.join(Lead).where(
             Lead.custom_data["whatsapp_session_name"].as_string() == session_name
         )
     # IF is_last_session is True: IT DELETES ALL CONVERSATIONS OF THE USER!
     for conv in convs:
         await db.delete(conv)
     # AND DELETES ALL LEADS CATEGORIZED AS "WhatsApp Kişisi"!
     for lead in leads:
         await db.delete(lead)
     ```
   - **Critical Vulnerability**: Deleting an active number permanently wipes out customer contact records, conversations, and message history!
   - On the frontend ([`WhatsAppHubPage.tsx` line 779](file:///Users/isatezcan/Documents/Github/Scoutify/frontend/src/pages/WhatsAppHubPage.tsx#L779)), `handleDelete` immediately runs `setConversations([])`, clearing the user's screen before the backend responds.

3. **Global Unique Constraint Collisions**:
   - `WhatsAppSession.session_name` is defined with `unique=True` globally:
     ```python
     session_name = Column(String(100), unique=True, nullable=False, index=True)
     ```
   - In a multi-tenant system, if User A creates `"Line 1"`, User B's creation of `"Line 1"` crashes with a database unique constraint violation (`500 Internal Server Error`).

4. **Missing Update Endpoint**:
   - No `PUT` or `PATCH` endpoint exists for numbers. Modifying credentials, friendly names, or daily limits is impossible without dropping and re-creating the entire row.

---

## 8. Current Bugs / Risks

| Bug / Vulnerability Class | Location | Impact | Risk Level |
| :--- | :--- | :--- | :--- |
| **Catastrophic Data Loss on Number Delete** | `whatsapp.py:delete_session` | Deleting a WhatsApp line cascades into deleting customer leads and entire conversation histories. | **CRITICAL** |
| **Global Session Name Collision** | `whatsapp_session.py:18` | `session_name` is globally unique across all tenants; causes 500 crashes in multi-tenant environments. | **HIGH** |
| **Multi-Number Routing Blindness** | `schemas/whatsapp_cloud.py`, `models/conversation.py` | Dropping `phone_number_id` makes it impossible to route messages to different business numbers. | **HIGH** |
| **Synchronous Webhook Timeout** | `whatsapp_cloud_webhook.py` | Webhooks processed synchronously in HTTP request thread; risks Meta 3s timeout and retry storms. | **HIGH** |
| **Strict Lead Dependency** | `models/conversation.py:23` | `lead_id NOT NULL` prevents direct customer dialogue without mutating the B2B CRM Lead table. | **MEDIUM** |
| **4-Second Polling Resource Drain** | `WhatsAppHubPage.tsx:197` | Continuous polling of `/conversations/sync-whatsapp/delta` degrades server throughput and locks DB rows. | **MEDIUM** |
| **Client-Side Masking Heuristics** | `ConversationList.tsx:81-109` | Client deduplicates conversations by last 10 digits to hide backend chat split bugs. | **MEDIUM** |
| **Missing 24h Window Tracking in DB** | `models/conversation.py` | No timestamps for customer window expiration; UI cannot proactively guide user between freeform and template modes. | **MEDIUM** |

---

## 9. Dead / Duplicate Code

### 9.1 Dead / Obsolete Modules (Scheduled for Full Removal)
1. **`wa-gateway/`**: The entire Node.js application (Baileys client, Signal store, QR generator, session socket managers).
2. **`backend/app/services/whatsapp_gateway_client.py`**: Client communicating with `localhost:3001`.
3. **`backend/app/services/whatsapp_chat_sync_service.py`**: Chat dump parser and LID reconciliation engine.
4. **`backend/app/models/whatsapp_session.py:WhatsAppSessionAuth`**: Serialized session credentials table.
5. **Endpoints in `backend/app/api/v1/endpoints/whatsapp.py`**:
   - `/sessions/{id}/qr`
   - `/sessions/{id}/refresh-qr`
   - `/sessions/{id}/pairing-code`
   - `/sessions/{id}/connect-demo`
   - `/sessions/{id}/disconnect`
   - `/webhook/inbound`
   - `/webhook/chats-synced`
   - `/webhook/session-status`
   - `/webhook/session-qr`
   - `/webhook/session-backup`
   - `/webhook/session-restore*`

### 9.2 Duplicate Models & Abstractions
- **Duplicate Message Models**:
  - `Message` in `backend/app/models/message.py` (used for Conversations).
  - `MessageLog` in `backend/app/models/message_log.py` (used for Campaign outreach).
  - *Resolution*: In target architecture, outbound campaign messages will be first-class messages inside conversations, eliminating model divergence.
- **Duplicate Senders**:
  - `SimulatedSender` (fake delays + fake IDs).
  - `GatewaySender` (wa-gateway HTTP calls).
  - `CloudApiSender` (Meta Cloud API wrapper).
  - *Resolution*: Unified under a single `MetaCloudApiAdapter` implementing a strict protocol.

---

## 10. Keep / Remove / Refactor Matrix

| Category | File / Artifact Path | Classification | Justification & Action Plan |
| :--- | :--- | :---: | :--- |
| **Frontend UI** | `frontend/src/pages/WhatsAppHubPage.tsx` | **KEEP** | Preserves Vuexy tab structure, stats headers, modals, and responsive layout. Replace Baileys QR state with Meta Cloud number management state. |
| **Frontend UI** | `frontend/src/components/domain/ConversationList.tsx` | **KEEP** | Preserves Vuexy search bar, filter tabs, avatar badges, and list styling. Remove ad-hoc phone-digit deduplication. |
| **Frontend UI** | `frontend/src/components/domain/ChatThread.tsx` | **KEEP** | Preserves message stream layout, smart auto-scroll, date dividers, and jump-to-bottom pill. |
| **Frontend UI** | `frontend/src/components/domain/ChatComposer.tsx` | **KEEP** | Preserves composer styling, attachment modal triggers, and key handlers. Add 24h customer window status indicator. |
| **Frontend UI** | `frontend/src/components/domain/ChatBubble.tsx` | **KEEP** | Preserves message bubble styling (INBOUND vs OUTBOUND), delivery checkmarks, and media lightboxes. |
| **Frontend UI** | `frontend/src/components/domain/SessionCard.tsx` | **REFACTOR** | Retain card styling, status badges, and layout. Replace Baileys metrics (warmup/socket) with Meta metrics (Phone ID, WABA ID, Quality Rating). |
| **Frontend UI** | `frontend/src/components/domain/NewChatModal.tsx` | **KEEP** | Preserves modal dialog form and phone input styling. |
| **Frontend UI** | `frontend/src/components/domain/TemplateSelectModal.tsx` | **KEEP** | Preserves template selection, variable input, and preview layout. Bind to real Meta Cloud templates. |
| **Frontend Hook**| `frontend/src/hooks/useWhatsAppConversation.ts` | **REFACTOR** | Retain API interface for components. Streamline message pagination and WebSocket event handling. |
| **Backend Router**| `backend/app/api/v1/endpoints/conversations.py` | **REFACTOR** | Remove `/sync-whatsapp` and `/sync-whatsapp/delta`. Retain clean conversation and message endpoints. |
| **Backend Router**| `backend/app/api/v1/endpoints/whatsapp.py` | **REMOVE / REPLACE** | Deprecate Baileys session endpoints. Introduce `/whatsapp/numbers` CRUD router. |
| **Backend Router**| `backend/app/api/v1/endpoints/whatsapp_cloud_webhook.py`| **REFACTOR** | Retain HMAC verification; decouple synchronous event processing to background worker. |
| **Backend Service**| `backend/app/services/whatsapp_outbound_service.py`| **REFACTOR** | Remove Baileys gateway branch. Dispatch exclusively through Meta Cloud API with strict state transitions. |
| **Backend Service**| `backend/app/services/whatsapp_cloud_service.py` | **REFACTOR** | Refactor for multi-number routing; enforce idempotency and monotonic status progression. |
| **Backend Service**| `backend/app/services/whatsapp_cloud_client.py` | **REFACTOR** | Support per-number dynamic instantiation (token & `phone_number_id`). |
| **Backend Service**| `backend/app/services/whatsapp_template_service.py`| **REFACTOR** | Replace hardcoded mock dictionary with Meta Cloud API Template integration. |
| **Backend Service**| `backend/app/services/whatsapp_sender.py` | **REFACTOR** | Eliminate `GatewaySender` and `SimulatedSender`. Standardize on official Meta Cloud API adapter. |
| **Backend Service**| `backend/app/services/whatsapp_chat_sync_service.py`| **REMOVE** | Completely delete. Webhook-driven architecture replaces chat dump syncing. |
| **Backend Service**| `backend/app/services/whatsapp_gateway_client.py` | **REMOVE** | Completely delete. |
| **Gateway App** | `wa-gateway/` (entire directory) | **REMOVE** | Completely delete unofficial Baileys Node microservice. |
| **DB Model** | `backend/app/models/conversation.py` | **REFACTOR** | Add `whatsapp_number_id`, `customer_service_window_expires_at`, `last_customer_message_at`; make `lead_id` nullable. |
| **DB Model** | `backend/app/models/message.py` | **REFACTOR** | Add `whatsapp_number_id`; enforce monotonic status progression. |
| **DB Model** | `backend/app/models/whatsapp_session.py` | **REFACTOR / REPLACE**| Replace Baileys `WhatsAppSession` with `WhatsAppNumber`. |

---

## 11. Data Migration Risks

### 11.1 Non-Destructive Schema Evolution (Zero Data Loss Invariant)
In accordance with Rule 1 ("DB'deki eski WhatsApp conversation tablolarını hemen fiziksel olarak DROP ETME"):
- Existing `conversations`, `messages`, and `leads` records **MUST NOT be dropped**.
- We will execute additive schema migrations (via `backend/app/core/migrations.py`):
  1. Add new table `whatsapp_numbers` to store Meta Cloud API credentials and identities.
  2. Add nullable column `whatsapp_number_id` to `conversations`.
  3. Add nullable column `whatsapp_number_id` to `messages`.
  4. Make `conversations.lead_id` nullable so conversations can exist independently of CRM Leads.
  5. Add `customer_service_window_expires_at` and `last_customer_message_at` to `conversations`.
  6. Add new table `webhook_events` for raw payload audit and idempotency guarantees.

### 11.2 Historical Data Backfill Strategy
- Existing conversations with valid phone numbers will be linked to a default `WhatsAppNumber` provisioned from existing `.env` credentials.
- Existing messages will retain their `wa_message_id`, body, timestamps, and media records intact.
- Legacy `whatsapp_sessions` table will be marked deprecated and kept in read-only state until complete transition verification.

---

## 12. UI Preservation Plan

### 12.1 Visual Design Contract (Vuexy Standard)
The user interface design, visual hierarchy, color palette, and micro-interactions will be **100% preserved**:

```
+----------------------------------------------------------------------------------------------------+
|  TOP HEADER: Canlı Diyaloglar  [ Canlı Diyaloglar (4) | Aktif Numaralar | Anti-Ban Politikası ]   |
+------------------------------------------+---------------------------------------------------------+
|  LEFT PANEL (ConversationList):          |  RIGHT PANEL (ChatThread & ChatComposer):               |
|                                          |                                                         |
|  [ + Yeni Sohbet ]  [ 🔄 Eşitle ]        |  CUSTOMER HEADER:                                       |
|  [ 🔍 Diyaloglarda ara...            ]   |  [CA] Cevat Aydın (+90 507 638 27 49)  [ Aktif ] [Lead] |
|                                          |  -----------------------------------------------------  |
|  [Tümü] [Aktif] [Okunmamış] [Arşiv]      |  MESSAGE STREAM:                                        |
|  --------------------------------------- |                                                         |
|  [CA] Cevat Aydın                 10:30  |    [ OUTBOUND ]                                         |
|       Selam, teklif hazır mı?            |    Selam Cevat Bey, nasılsınız?               10:28 ✔️   |
|                                          |                                                         |
|  [IT] İsa Tezcan                  Dün    |    [ INBOUND ]                                          |
|       Görüşmek üzere.             (2)    |    Aleykümselam, teklif hazır mı?             10:30     |
|                                          |                                                         |
|                                          |  -----------------------------------------------------  |
|                                          |  24h Window: [ 🟢 Aktif - Serbest Mesaj Gönderilebilir ]|
|                                          |  [ 📎 ] [ Mesajınızı yazın...             ] [ Gönder 🚀]|
+------------------------------------------+---------------------------------------------------------+
```

1. **Left Panel Navigation**:
   - `Yeni Sohbet` modal remains identical.
   - Segmented filter tabs (`Tümü`, `Aktif`, `Okunmamış`, `Arşiv`, `Kapalı`) retain existing badge counters.
   - Conversation items retain active ring (`ring-1 ring-[#7367F0]`), unread badges (`bg-[#28C76F]`), and relative timestamps.
2. **Right Panel Chat Area**:
   - Thread header retains Customer Avatar, Verified Badge, Status Badge, and Lead CRM drawer trigger.
   - Message bubbles retain distinct colors: Outbound (`bg-gradient-to-r from-[#7367F0] to-[#685DD8]`), Inbound (`bg-white dark:bg-[#2F3349]`).
   - Delivery checkmarks (`Check`, `CheckCheck`, cyan read receipt) remain identical.
3. **Active Numbers Tab Transformation**:
   - Replace the QR scanner / Pairing code modal with an elegant Vuexy modal: **"Yeni WhatsApp Numarası Ekle"**.
   - Input fields:
     - **Hat Başlığı / Friendly Name** (e.g. *"Satış Hattı 1"*).
     - **Telefon Numarası** (e.g. *"+90 850 123 45 67"*).
     - **Phone Number ID** (from Meta Developer Dashboard).
     - **WABA ID** (WhatsApp Business Account ID).
     - **Permanent Access Token** (secure password field).
     - **Webhook Verify Token** (auto-generated or custom).
   - Display cards retain exact Vuexy glassmorphism styling, showing verified business status, quality rating, and connection health.

---

## 13. Target Architecture

### 13.1 Clean Architecture & Domain Boundaries
The target system enforces strict Dependency Inversion and Domain-Driven Design:

```
                               TARGET CLEAN ARCHITECTURE
                               
┌────────────────────────────────────────────────────────────────────────┐
│                        Presentation Layer (FastAPI)                    │
│   - /api/v1/conversations (Listing, Threads, Outbound Message, Status) │
│   - /api/v1/whatsapp/numbers (Multi-Number CRUD & Connection Test)     │
│   - /api/v1/whatsapp/cloud-webhook (GET Challenge, POST Event Ingestion)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Application Layer (Services)                    │
│   - WhatsAppOutboundService (Enforces 24h window, validates outbound)  │
│   - WhatsAppInboundService (Idempotent webhook ingestion, contact res) │
│   - WhatsAppNumberService (Validates Meta credentials, manages status) │
│   - WebhookProcessorWorker (Asynchronous event normalization & dispatch)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          Domain Layer (Core)                           │
│   - WhatsAppNumber (Identity, Phone Number ID, WABA ID, Credentials)   │
│   - Conversation (Channel identity, Number FK, 24h Window expiration)  │
│   - Contact (Customer phone, verified name, CRM lead association)      │
│   - Message (Direction, Status State Machine, wamid idempotency)       │
│   - WebhookEvent (Audit log, raw payload, processing status)           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Infrastructure Layer (Adapters)                     │
│   - MetaCloudApiAdapter (Graph API HTTP client, error categorization)  │
│   - MetaWebhookVerifier (HMAC-SHA256 signature verification)           │
│   - WebSocketBroadcaster (Real-time live UI event streaming)           │
└────────────────────────────────────────────────────────────────────────┘
```

### 13.2 Multi-Number Identity & Routing Principle
- Every incoming and outgoing message belongs to a specific `WhatsAppNumber`.
- Incoming webhooks contain `metadata.phone_number_id`. The system resolves the matching `WhatsAppNumber`, then locates or creates the `Conversation` tied to that number:
  $$\text{Target Conversation} = f(\text{WhatsAppNumber.id}, \text{Contact.phone\_e164})$$
- Number A talking to Customer X creates Conversation A. Number B talking to Customer X creates Conversation B. Complete multi-line isolation is guaranteed.

### 13.3 Idempotency Architecture
- **Primary Idempotency Key**: Meta's unique WhatsApp message ID (`wamid`).
- `messages.wa_message_id` has a database `UNIQUE` constraint.
- When an incoming webhook event arrives:
  1. Record raw event in `webhook_events` with unique `wamid`.
  2. If duplicate `wamid` is received: skip database mutations and return success immediately.
  3. Guarantees that duplicate webhooks will never create duplicate messages, double-increment unread counters, or trigger duplicate notifications.

### 13.4 Monotonic Message Status State Machine
Outbound messages adhere to a non-regressive state machine:

$$\text{PENDING} \longrightarrow \text{SENT} \longrightarrow \text{DELIVERED} \longrightarrow \text{READ}$$
$$\text{ANY} \longrightarrow \text{FAILED}$$

- A message in `READ` status will reject any delayed `DELIVERED` status updates received out of order.
- Status updates verify that the incoming event rank is greater than the current message rank.

### 13.5 Meta 24-Hour Customer Service Window Engine
- Meta allows freeform text messaging only within **24 hours of the customer's last incoming message**.
- Once expired, outreach requires pre-approved **Meta Business Templates**.
- Schema fields on `Conversation`:
  - `last_customer_message_at`: Timestamp of the latest inbound message.
  - `customer_service_window_expires_at`: $\text{last\_customer\_message\_at} + 24\text{ hours}$.
- The composer UI checks window status:
  - Within window: Allows freeform text and rich media.
  - Expired window: Displays a clear prompt: *"24 saatlik müşteri iletişim süresi doldu. Lütfen bir şablon mesajı seçin"* and opens `TemplateSelectModal`.

---

## 14. Phase-by-Phase Implementation Plan

```
                   REBUILD IMPLEMENTATION ROADMAP
                   
  [Phase 0] FORENSIC AUDIT & MIGRATION SPECIFICATION (Current)
     │
     ▼
  [Phase 1] DOMAIN MODELING & SAFE DATABASE MIGRATION
     │      - Add `whatsapp_numbers` table
     │      - Add `webhook_events` table
     │      - Add `whatsapp_number_id` and 24h window fields to `conversations`
     │      - Decouple `conversations.lead_id` (make nullable)
     │
     ▼
  [Phase 2] META CLOUD API ADAPTER & ASYNC WEBHOOK ENGINE
     │      - Implement dynamic `MetaCloudApiAdapter`
     │      - Implement fast 200 HTTP webhook receiver with background worker
     │      - Implement HMAC-SHA256 signature verification & DTO parsing
     │
     ▼
  [Phase 3] CONVERSATION APPLICATION SERVICES & STATE MACHINE
     │      - Implement `WhatsAppInboundService` (idempotency, contact resolution)
     │      - Implement `WhatsAppOutboundService` (24h window, template/media send)
     │      - Implement monotonic message status progression
     │
     ▼
  [Phase 4] CLEAN REST ROUTERS & MULTI-NUMBER API
     │      - Implement `/api/v1/whatsapp/numbers` (Add, List, Test, Delete)
     │      - Refactor `/api/v1/conversations` (Clean list, pagination, actions)
     │      - Decommission legacy Baileys endpoints
     │
     ▼
  [Phase 5] FRONTEND INTEGRATION & UI SHELL REFINEMENT
     │      - Update "Aktif Numaralar" tab with Meta Cloud API credentials modal
     │      - Bind ConversationList and ChatThread to clean REST endpoints
     │      - Remove 4-second polling loop; rely on WebSocket push events
     │      - Connect 24h customer window indicators to ChatComposer
     │
     ▼
  [Phase 6] FULL VALIDATION, TEST PASS & BAİLEYS REMOVAL
            - Run full pytest test suite (100% pass)
            - Run frontend production build
            - Safely remove `wa-gateway` directory and legacy code
```

---

## 15. Test Strategy

```
                              TEST COVERAGE MATRIX
                              
┌─────────────────────────┬────────────────────────────────────────────────────────┐
│ Test Layer              │ Key Verification Targets                               │
├─────────────────────────┼────────────────────────────────────────────────────────┤
│ **Unit Tests**          │ - Conversation creation & contact resolution           │
│                         │ - Monotonic status progression (SENT->DELIVERED->READ) │
│                         │ - State machine rejection of out-of-order updates       │
│                         │ - 24-hour service window calculation & expiration      │
│                         │ - Strict idempotency matching on `wamid`               │
├─────────────────────────┼────────────────────────────────────────────────────────┤
│ **Integration Tests**   │ - Outbound text, template, and media dispatching        │
│                         │ - Inbound webhook parsing & DTO normalization          │
│                         │ - Multi-number routing (phone_number_id separation)    │
│                         │ - Real-time WebSocket broadcasting                      │
├─────────────────────────┼────────────────────────────────────────────────────────┤
│ **Security Tests**      │ - X-Hub-Signature-256 HMAC verification & rejection    │
│                         │ - Webhook verification handshake (`hub.challenge`)     │
│                         │ - Zero token leakage in logs or exceptions             │
│                         │ - Tenant isolation (cross-user data access denied)     │
├─────────────────────────┼────────────────────────────────────────────────────────┤
│ **Concurrency Tests**   │ - Simultaneous duplicate webhooks handled idempotently │
│                         │ - Race-free conversation initiation                    │
│                         │ - Rapid message ordering preservation                  │
├─────────────────────────┼────────────────────────────────────────────────────────┤
│ **E2E Tests**           │ - Full user journey: Number added -> Webhook received  │
│                         │   -> Conversation listed -> Outbound reply sent        │
│                         │   -> Status transitions updated in UI                  │
└─────────────────────────┴────────────────────────────────────────────────────────┘
```

---

## 16. Definition of Done (Phase 0)

1. **Forensic Audit Completed**:
   - Every WhatsApp-related file across frontend, backend, gateway, and migrations identified and classified in the Keep/Remove/Refactor matrix.
   - Root causes of conversation splitting, fake number synthesis, and session deletion data loss documented with code citations.
2. **Zero Premature Implementation**:
   - No mock code written.
   - No destructive database tables dropped.
   - No unofficial WhatsApp Web dependencies introduced.
3. **Architecture Specification Approved**:
   - Target Clean Architecture, Multi-Number principles, Idempotency guarantees, and 24-hour customer window policies fully defined.
   - UI Preservation plan guarantees 100% fidelity to the existing Vuexy design system.
4. **Execution Ready**:
   - Implementation plan structured into 6 sequential, test-driven phases ready for execution upon user authorization.
