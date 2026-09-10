# Tezlify WhatsApp Rebuild — Phase 3: Real Meta Webhook Ingestion + Inbound Message Pipeline

## 1. Webhook Architecture

Phase 3 establishes an asynchronous, multi-tenant, cryptographically verified, and idempotent webhook ingestion and inbound message pipeline directly connected to Meta WhatsApp Cloud API.

### End-to-End Ingestion Flow

```
   Meta WhatsApp Cloud API
              │
              ▼ HTTPS POST /api/v1/whatsapp/webhook
┌────────────────────────────────────────────────────────┐
│ 1. Raw Body Verification (Timing-Safe HMAC-SHA256)     │
│    - X-Hub-Signature-256 header check                  │
│    - Fail-closed: invalid signature -> HTTP 403        │
├────────────────────────────────────────────────────────┤
│ 2. Fast ACK & Audit Ingestion Barrier                  │
│    - Compute payload SHA-256 event_hash                │
│    - Immediate duplicate check on event_hash           │
│    - Validate envelope: object == whatsapp_business...│
│    - Persist WebhookEvent (status=RECEIVED)            │
│    - Dispatch asynchronous processor                   │
│    - Fast HTTP 200 {"status": "received"}              │
└────────────────────────────────────────────────────────┘
                          │ (Async Background Task)
                          ▼
┌────────────────────────────────────────────────────────┐
│ 3. Asynchronous Domain Processor                       │
│    - Transition WebhookEvent status -> PROCESSING      │
│    - Extract metadata.phone_number_id                  │
│    - Lookup WhatsAppNumber -> resolve user_id (tenant) │
│      └─ If unknown/inactive: PROCESSED without mutation│
├────────────────────────────────────────────────────────┤
│ 4. Inbound Message Pipeline                            │
│    - Canonical Idempotency: messages.wa_message_id     │
│      └─ If duplicate: skip mutation & realtime         │
│    - Contact Resolution: (user_id, phone_e164)         │
│    - Conversation Resolution:                          │
│        (user_id, whatsapp_number_id, contact_id)       │
│    - Customer 24h Window Extension via                 │
│        CustomerWindowService                           │
│    - Insert Message entity (direction=INBOUND)         │
├────────────────────────────────────────────────────────┤
│ 5. Outbound Delivery Status Pipeline                   │
│    - Lookup Message by wa_message_id                   │
│      └─ If orphan: audit log, no exception/crash       │
│    - Monotonic Transition via MessageStateMachine      │
│        (SENT -> DELIVERED -> READ / FAILED)            │
│    - Record error_code and error_message on failure    │
├────────────────────────────────────────────────────────┤
│ 6. Commit & Realtime Broadcast Boundary                │
│    - Atomic Database Transaction COMMIT                │
│    - Transition WebhookEvent status -> PROCESSED       │
│    - Post-commit domain events broadcast via WebSocket│
│        (inbound_reply, message_status_updated)         │
│    - Invariant: Zero realtime emitted on rollback      │
└────────────────────────────────────────────────────────┘
```

---

## 2. GET Verification Handshake

- **Endpoint**: `GET /api/v1/whatsapp/webhook`
- **Query Parameters**:
  - `hub.mode`: Expected to be `subscribe`.
  - `hub.verify_token`: Compared strictly against `settings.effective_meta_verify_token`.
  - `hub.challenge`: Plaintext verification challenge supplied by Meta.
- **Behavior**:
  - Valid token & mode: Returns `HTTP 200` with the raw `challenge` string in `text/plain`.
  - Invalid token or invalid mode: Returns `HTTP 403 Forbidden`.

---

## 3. POST Signature Verification

- **Header**: `X-Hub-Signature-256` in format `sha256=<hex_digest>`.
- **Methodology**:
  - Evaluates the raw request body bytes prior to JSON parsing.
  - Generates HMAC-SHA256 hash using `settings.effective_meta_app_secret`.
  - Compares expected vs received signatures using constant-time string comparison (`hmac.compare_digest`) to prevent timing attacks.
  - If signature mismatch or missing secret: Immediately halts with `HTTP 403 Forbidden`.
  - Raw App Secret and tokens are never included in log messages.

---

## 4. Phone Number Routing & Tenant Isolation

- **Canonical Identity**: `metadata.phone_number_id` inside webhook payload `entry[].changes[].value.metadata`.
- **Tenant Resolution**:
  $$\text{value.metadata.phone_number_id} \longrightarrow \text{whatsapp\_numbers.phone\_number\_id} \longrightarrow \text{whatsapp\_numbers.user\_id}$$
- **Invariants**:
  - Payload-provided `user_id` is never trusted. Tenant ownership is resolved exclusively from the registered `WhatsAppNumber`.
  - Unknown `phone_number_id`:
    - Safely recorded in `webhook_events` with `failure_reason = "Unknown phone_number_id: <id>"`.
    - Returns HTTP 200 to Meta to prevent retry storms.
    - Zero mutation occurs in domain tables (`contacts`, `conversations`, `messages`, `leads`).
  - Tenant A cannot access or resolve Tenant B's contacts, conversations, or messages.

---

## 5. Contact Resolution

- Resolved by `(user_id, phone_e164)` tuple:
  - Phone numbers are normalized using `PhoneService.normalize_to_e164(from_phone)`.
  - If Contact exists: `whatsapp_profile_name` is updated from webhook `contacts[].profile.name`.
  - If Contact does not exist: Creates a new `Contact` linked to the resolved `user_id`.
  - If a matching CRM `Lead` exists for `(user_id, phone_e164)`, `contact.lead_id` is linked.

---

## 6. Multi-Number Conversation Resolution

- Resolved by `(user_id, whatsapp_number_id, contact_id)`:
  - **Multi-Line Isolation Invariant**: The same external phone number speaking to two different business numbers (e.g. Sales Hat vs Support Hat) belongs to two completely separate `Conversation` threads.
  - If Conversation exists: Reopens thread if not active, increments `unread_count`, updates `last_message_at` and `last_message_preview`.
  - If Conversation does not exist: Provisions a new `Conversation` thread.

---

## 7. Canonical Idempotency (`messages.wa_message_id`)

- Level 1: `webhook_events.event_hash` (SHA-256 of raw body) detects re-sent raw webhook payloads and skips re-execution.
- Level 2 (Canonical): `messages.wa_message_id = webhook messages[].id`.
  - Looked up prior to insertion. If `existing_msg` is present:
    - Skipped as `duplicate_message`.
    - No duplicate `Message` inserted.
    - `unread_count` not incremented.
    - 24-hour customer window not re-extended.
    - No duplicate WebSocket realtime event broadcast.
- Level 3 (Safety Net): Database `UNIQUE` constraint on `messages.wa_message_id`. Concurrent webhook deliveries encountering an `IntegrityError` rollback cleanly without corrupting state or crashing the server.

---

## 8. Customer 24-Hour Service Window

- Inbound customer messages invoke `CustomerWindowService.update_conversation_window(conversation, message_timestamp)`.
- Sets:
  - `last_customer_message_at = message_timestamp` (UTC)
  - `customer_service_window_expires_at = message_timestamp + 24 hours` (UTC)
- Policy Enforcement:
  - Freeform text/media is allowed while `now < customer_service_window_expires_at`.
  - Beyond 24 hours, templates are required (`CustomerWindowPolicy.TEMPLATE_REQUIRED`).
- Replay/duplicate webhooks do not reset or inappropriately extend the window.

---

## 9. Message Delivery Status Webhooks

- Webhook `statuses[]` maps to `ConversationMessageStatus`:
  - `sent` $\rightarrow$ `ConversationMessageStatus.SENT`
  - `delivered` $\rightarrow$ `ConversationMessageStatus.DELIVERED`
  - `read` $\rightarrow$ `ConversationMessageStatus.READ`
  - `failed` $\rightarrow$ `ConversationMessageStatus.FAILED`
- **Monotonic State Machine**:
  - Enforced via `MessageStateMachine.transition(...)`.
  - Backward status regressions (e.g. `READ -> SENT` or `DELIVERED -> SENT`) are rejected without error.
  - For `FAILED` statuses, Meta `errors[0].code` and `errors[0].message` are parsed and stored in `message.error_code` and `message.error_message`.
- **Orphan Status Handling**:
  - Status updates for unrecorded message IDs are logged as orphan without raising exceptions or causing 500 retry storms.

---

## 10. Realtime Event Emission Boundary

- All domain notifications (`inbound_reply`, `message_status_updated`) are queued in-memory and emitted via `ws_manager.broadcast(...)` **strictly after** the database transaction has committed.
- Invariant: If a database transaction rolls back (e.g. due to an IntegrityError or unhandled exception), zero WebSocket events are broadcast to frontend clients.

---

## 11. Security & Redaction

- Constant-time HMAC-SHA256 signature verification protects all webhook ingestion.
- `META_APP_SECRET` and permanent access tokens are never written to application logs, console traces, or database payloads.
- `sanitize_payload_for_persistence` aggressively filters and redacts any keys containing `token`, `secret`, or `authorization`.

---

## 12. Test Results

### Suite Breakdown
- **Phase 1 Domain & Database Tests**: 34 passed
- **Phase 2 Active Numbers & Meta Client Tests**: 16 passed, 1 skipped (Real Meta E2E)
- **Phase 3 Real Webhook Ingestion Tests**: 33 passed, 1 skipped (Real Meta E2E)
- **Total Combined Rebuild Suite**: **83 passed, 2 skipped in 1.03s**
- **Full Backend Test Suite**: **570 passed, 2 skipped in 30.02s**
- **Frontend TypeScript & Production Build**: **PASS** (`npm run build` cleanly compiled in 1.64s)

---

## 13. Real Meta E2E Status

- **Status**: `REAL META E2E: NOT RUN`
- **Rationale**: Local test and CI environments operate without live Meta App Secret and Permanent User Token credentials in the environment. All unit, integration, signature verification, routing, idempotency, and concurrency checks are fully verified through the test suite.
