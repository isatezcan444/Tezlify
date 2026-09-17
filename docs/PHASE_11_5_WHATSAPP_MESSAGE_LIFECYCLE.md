# Phase 11.5 — WhatsApp Message Lifecycle Map

**Document Status**: COMPLETE & VERIFIED  
**Phase**: 11.5 — WhatsApp Architecture Preparation & Characterization  
**Scope**: Complete step-by-step trace of outbound and inbound message lifecycles verified against current implementation.

---

## 1. Outbound Message End-to-End Lifecycle Trace

This trace follows a user typing a message in the Tezlify web app until it is delivered and read by the recipient.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Composer as ChatComposer.tsx
    participant Hub as WhatsAppHubPage.tsx
    participant Repo as WhatsAppRepository
    participant API as FastAPI (whatsapp.py)
    participant Service as whatsapp_service.py
    participant DB as PostgreSQL (public)
    participant GWClient as whatsapp_gateway.py
    participant GW as Gateway (session-manager.js)
    participant Baileys as Baileys Socket
    participant WA as WhatsApp Meta Network
    participant Recipient as Recipient Phone

    User->>Composer: Enters text & clicks Send
    Composer->>Hub: onSend({ text })
    Hub->>Hub: Optimistic insert: client_message_id, status='PENDING'
    Hub->>Repo: sendMessage(convId, text, clientMsgId)
    Repo->>API: POST /api/v1/whatsapp/messages
    API->>Service: send_text_message(...)
    Service->>Service: acquire _get_conversation_lock(user_id, jid)
    Service->>DB: INSERT INTO messages (status='PENDING', client_message_id)
    Service->>DB: COMMIT (Persist attempt)
    Service->>GWClient: POST /sessions/{id}/messages
    GWClient->>GW: HTTP POST :8787/sessions/{id}/messages
    GW->>Baileys: sock.sendMessage(jid, { text })
    Baileys->>WA: NoiseSocket Encrypted Message Frame
    WA-->>Baileys: Wire ACK (wa_message_id)
    Baileys-->>GW: { messageId: "WAMID_123" }
    GW-->>GWClient: 200 OK { success: true, messageId: "WAMID_123" }
    GWClient-->>Service: GatewayResponse
    Service->>DB: UPDATE messages SET status='SENT', wa_message_id='WAMID_123'
    Service->>DB: UPDATE conversations SET last_message_at=NOW(), preview=text
    Service->>DB: COMMIT
    Service-->>API: MessageResponse DTO
    API-->>Repo: 200 OK
    Repo-->>Hub: Resolves optimistic message with server ID & wa_message_id

    Note over WA,Recipient: Delivery to Recipient Device
    Recipient-->>WA: Delivered Receipt
    WA-->>Baileys: messages.update (status=DELIVERED)
    Baileys->>GW: ev.on('messages.update')
    GW->>GW: enqueue(message_status_updated)
    GW->>API: WSS /ws/gateway: message_status_updated
    API->>Service: _map_conversation_event()
    Service->>DB: UPDATE messages SET status='DELIVERED' WHERE wa_message_id='WAMID_123'
    Service->>DB: COMMIT
    API->>GW: WSS: gateway_event_ack
    API->>Hub: WSS /ws: broadcast(message_status_updated)
    Hub->>Hub: mergeDeliveryStatus('SENT', 'DELIVERED') -> updates ChatBubble to double grey ticks
```

---

## 2. Inbound Message End-to-End Lifecycle Trace

This trace follows an incoming message from a contact arriving at the gateway until it renders in the user's viewport.

```mermaid
sequenceDiagram
    autonumber
    actor Sender as External Contact
    participant WA as WhatsApp Meta Network
    participant Baileys as Baileys Socket
    participant GW as Gateway (session-manager.js)
    participant Outbox as postgres-event-outbox.js
    participant Bridge as events.js (Outbox Pump)
    participant GatewayWS as /ws/gateway (main.py)
    participant Service as whatsapp_service.py
    participant DB as PostgreSQL (public & private)
    participant WSManager as ws_manager (/ws)
    participant Hub as WhatsAppHubPage.tsx

    Sender->>WA: Sends message to Tezlify phone number
    WA->>Baileys: Inbound Encrypted Message Frame
    Baileys->>GW: ev.on('messages.upsert')
    GW->>GW: sanitizeChatForEmit() & _recordInboundMessage()
    GW->>Outbox: enqueue(message_new) [AES-256-GCM]
    Outbox->>DB: INSERT INTO whatsapp_private.event_outbox (state='PENDING')
    
    loop Every Outbox Pump Cycle
        Bridge->>Outbox: claimPending(50) [FOR UPDATE SKIP LOCKED]
        Outbox->>DB: UPDATE event_outbox SET state='IN_FLIGHT' RETURNING...
        Bridge->>GatewayWS: WSS Send JSON event (event_id, message_new)
    end

    GatewayWS->>Service: ingest_gateway_event(event)
    Service->>DB: SELECT 1 FROM whatsapp_private.processed_events WHERE event_id=:id
    Note over Service,DB: Dedup Check: Not processed yet
    Service->>Service: acquire _get_conversation_lock(user_id, jid)
    Service->>Service: _ensure_conversation_race_safe(db, user_id, jid)
    Service->>DB: INSERT INTO messages (direction='INBOUND', status='RECEIVED')
    Service->>DB: UPDATE conversations SET last_message_at=NOW(), preview=body, unread_count=unread_count+1
    Service->>DB: INSERT INTO whatsapp_private.processed_events (event_id)
    Service->>DB: COMMIT
    
    GatewayWS->>Bridge: WSS Send: {"type": "gateway_event_ack", "event_id": id}
    Bridge->>Outbox: acknowledge(event_id)
    Outbox->>DB: UPDATE event_outbox SET state='DELIVERED'
    
    GatewayWS->>WSManager: broadcast(persisted_message_event)
    WSManager->>Hub: WSS /ws: 'tezlify:ws_event' (event: 'message_new')
    Hub->>Hub: mergeWhatsAppMessages(existing, [incoming])
    Hub->>Hub: Play notification sound if enabled
    
    opt If Conversation is Actively Focused in UI
        Hub->>Service: POST /api/v1/whatsapp/conversations/{id}/read
        Service->>DB: UPDATE conversations SET unread_count=0
        Service->>DB: COMMIT
    end
```

---

## 3. Critical Safety Guarantees During Lifecycle Transitions

1. **Identity Unification**:
   - `mergeWhatsAppMessages` in [whatsappMessageMerge.ts](file:///Users/isatezcan/Documents/Github/Tezlify/frontend/src/features/whatsapp/lib/whatsappMessageMerge.ts) unifies message identities across three distinct keys: `id:${message.id}`, `wa:${message.wa_message_id}`, and `client:${message.client_message_id}`.
   - When the optimistic message (`client_message_id`) meets the server confirmation (`id`), they merge into a single entity without flicker.
2. **Delivery Status Monotonicity**:
   - `mergeDeliveryStatus` enforces strict monotonic ranking:
     $$\text{PENDING} \le \text{SENT} \le \text{DELIVERED} \le \text{READ} \equiv \text{RECEIVED}$$
   - An out-of-order `SENT` echo received after a `DELIVERED` receipt will never downgrade the message status.
3. **Multi-Tenant Fail-Closed Isolation**:
   - In `ingest_gateway_event`, if the gateway session ID cannot be mapped to an authenticated user ID, the event is immediately discarded (`EventOwnerUnresolved`), transaction rolled back, and NACK returned to the gateway outbox. Orphaned events are never broadcast to the UI.
