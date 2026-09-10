# Tezlify WhatsApp QR / Linked Device — Phase 5: Outbound Messaging Architecture

## Overview
Phase 5 introduces outbound text messaging from **Canlı Diyaloglar** (Live Conversations) composer over Baileys QR-connected lines (`BAILEYS_QR`).

## Architecture & Data Flow

```
Canlı Diyaloglar (Composer)
       │ POST /api/v1/conversations/{conversation_id}/messages
       ▼
Endpoint: send_message_to_conversation
       ├── 1. Authenticate user & tenant isolation
       ├── 2. Verify conversation ownership
       ├── 3. Resolve Contact & recipient phone_e164
       ├── 4. Resolve WhatsAppNumber & provider (BAILEYS_QR vs META_CLOUD)
       ├── 5. Text payload validation (non-empty, strip control characters, max length 4096)
       ├── 6. Provider routing:
       │       ├── META_CLOUD: Verify 24h customer window, decrypt access token
       │       └── BAILEYS_QR: Bypass 24h window & token, authoritatively resolve WhatsAppSession (CONNECTED)
       ├── 7. Reject group recipients (@g.us) fail-closed
       ├── 8. Persist Message (direction=OUTBOUND, status=PENDING, sender_phone=wanum.phone_number_e164)
       ├── 9. Persist OutboxMessage (status=PENDING, payload_json={"provider": "BAILEYS_QR", ...})
       └── 10. Commit DB transaction & trigger OutboundWorker
               │
               ▼
Worker: OutboundWorker.process_outbox_job
       ├── 1. Check daily outbound rate limits (daily_sent_count < max_daily_limit)
       ├── 2. Dispatch via WhatsAppGatewayClient.send_message:
       │       └── POST /api/tenants/{tenant_id}/sessions/{session_id}/messages/send
       │           ├── Baileys sock.sendMessage(recipientJid, { text })
       │           └── Return real Baileys key.id
       ├── 3. Success:
       │       ├── Update Message status = SENT
       │       ├── Store real Baileys wa_message_id (e.g. 3EB0...)
       │       ├── Mark OutboxMessage status = COMPLETED
       │       ├── Increment session daily_sent_count
       │       └── Commit DB transaction
       ├── 4. Broadcast tezlify:ws_event (event="message_status_updated", status="SENT", wa_message_id=key.id)
       └── 5. Ambiguous Failure Handling:
               └── If ReadTimeout / unknown network state: set AMBIGUOUS_PROVIDER_RESULT, no blind retry
```

## Key Invariants
1. **Zero META_CLOUD Regression**:
   - Meta Cloud outbound continues using encrypted access tokens, approved templates, and 24-hour customer service window checks.
   - Provider resolution strictly separates `META_CLOUD` and `BAILEYS_QR` pipelines.
2. **Authoritative Session Resolution**:
   - Client-provided session IDs are never blindly trusted.
   - Session is resolved authoritatively from `Conversation.whatsapp_number_id` -> `WhatsAppNumber.session`.
   - Must belong to the same tenant and be in `CONNECTED` status.
3. **Fail-Closed Recipient Validation**:
   - Recipient JID resolved from canonical `contact.phone_e164`.
   - Group JIDs (`@g.us`) are rejected fail-closed.
4. **Real Message ID Durability**:
   - `wa_message_id` is set to the genuine Baileys `key.id` returned by the gateway. No synthesized or fake IDs.
5. **Idempotency**:
   - `client_message_id` LRU deduplication at both backend outbox and gateway layers prevents duplicate sends from double-clicking the composer.
6. **Ambiguous Network Safety**:
   - Network timeouts / unknown gateway results mark jobs as ambiguous without blind retries to prevent duplicate WhatsApp messages.
7. **Post-Commit WebSocket Broadcast**:
   - UI updates (`message_status_updated`) are broadcast via WebSocket strictly after the database commit succeeds.
