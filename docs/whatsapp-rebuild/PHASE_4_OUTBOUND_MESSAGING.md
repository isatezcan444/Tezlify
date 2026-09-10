# Tezlify WhatsApp Rebuild — Phase 4: Outbound Messaging Pipeline + 24h Customer Window + Template Enforcement

## 1. Outbound Messaging Architecture

Phase 4 establishes an enterprise-grade, durable, multi-tenant outbound WhatsApp messaging pipeline communicating exclusively with the official Meta WhatsApp Cloud API (Graph API `v21.0`).

### End-to-End Outbound Pipeline Flow

```
Frontend / Client
      │
      ▼ POST /api/v1/conversations/{conversation_id}/messages
┌────────────────────────────────────────────────────────┐
│ 1. Authorization & Tenant Isolation Boundary           │
│    - Current user identity resolved via Supabase JWT   │
│    - Conversation verified: conversation.user_id       │
│    - WhatsAppNumber verified: number.user_id           │
│    - Fail-closed: 404 (Not Found) or 403 (Forbidden)   │
├────────────────────────────────────────────────────────┤
│ 2. WhatsApp Line & Recipient Validation                │
│    - Active line verification: status == ACTIVE        │
│    - Recipient strictly resolved from:                 │
│        Conversation -> Contact -> phone_e164           │
│    - Zero client override of recipient destination     │
├────────────────────────────────────────────────────────┤
│ 3. 24-Hour Customer Window Enforcement                 │
│    - Evaluated via CustomerWindowService               │
│    - If Open (<= 24h from last customer inbound):      │
│        Freeform TEXT is permitted                      │
│    - If Expired (> 24h or no customer inbound):        │
│        Freeform TEXT rejected: HTTP 422                │
│        (CUSTOMER_SERVICE_WINDOW_EXPIRED)               │
│        Pre-approved TEMPLATE is permitted              │
├────────────────────────────────────────────────────────┤
│ 4. Transactional Outbox Persistence (Single Atomicity) │
│    - Server generates client_message_id (cmsg_...)     │
│    - Create Message (status=PENDING, wa_message_id=None│
│    - Create OutboxMessage (status=PENDING)             │
│    - Commit DB (Message + OutboxMessage atomically)    │
│    - HTTP 201 Created (Safe MessageResponse DTO)       │
└────────────────────────────────────────────────────────┘
                           │ (Asynchronous Outbound Worker)
                           ▼
┌────────────────────────────────────────────────────────┐
│ 5. Durable Outbound Worker Execution                   │
│    - Atomic row leasing (locked_at, locked_by)         │
│    - Token decryption strictly at send boundary        │
│    - POST https://graph.facebook.com/{v}/{pid}/messages│
│    - Extract wamid from Meta response                  │
├────────────────────────────────────────────────────────┤
│ 6. Monotonic State Transition & WebSocket Broadcast    │
│    - Message.wa_message_id = wamid                     │
│    - MessageStateMachine: PENDING -> SENT (sent_at set)│
│    - OutboxMessage: status = COMPLETED                 │
│    - Commit DB                                         │
│    - Post-commit WebSocket broadcast:                  │
│        message_status_updated (SENT)                   │
├────────────────────────────────────────────────────────┤
│ 7. Meta Inbound Status Webhook Integration (Phase 3)   │
│    - Meta delivers status: delivered, read, failed     │
│    - Lookup Message by wa_message_id                   │
│    - Monotonic forward progression:                    │
│        SENT -> DELIVERED -> READ                       │
│    - Monotonic regression guard: READ -> SENT rejected │
└────────────────────────────────────────────────────────┘
```

---

## 2. API Contract

### `POST /api/v1/conversations/{conversation_id}/messages`

**Headers**:
- `Authorization: Bearer <JWT>`
- `Content-Type: application/json`
- `X-Idempotency-Key`: Optional client idempotency key.

**Request Payload (Freeform Text)**:
```json
{
  "message_type": "text",
  "body": "Merhaba, teklifinizle ilgili detayları iletmek istedim."
}
```

**Request Payload (Approved Template)**:
```json
{
  "message_type": "template",
  "template_name": "re_engagement_notice_v1",
  "template_language": "tr",
  "template_parameters": [
    {
      "type": "text",
      "text": "Ahmet Bey"
    }
  ]
}
```

**Response (HTTP 201 Created)**:
```json
{
  "id": 1042,
  "conversation_id": 58,
  "direction": "OUTBOUND",
  "message_type": "TEXT",
  "body": "Merhaba, teklifinizle ilgili detayları iletmek istedim.",
  "status": "PENDING",
  "sender_phone": "+908501234567",
  "recipient_phone": "+905321112233",
  "wa_message_id": null,
  "client_message_id": "cmsg_a7b8c9d0e1f24a5b",
  "created_at": "2026-09-10T12:00:00",
  "updated_at": "2026-09-10T12:00:00"
}
```

---

## 3. 24-Hour Customer Window Enforcement

Meta WhatsApp Business Platform policy dictates:
- **Inside 24 Hours**: Freeform text and rich media messages are permitted.
- **Outside 24 Hours**: Businesses are prohibited from initiating freeform messaging. Communication must utilize pre-approved Meta Business Templates.

### Implementation:
- **Centralized Service**: `backend/app/services/customer_window_service.py` (`CustomerWindowService.is_within_24h_window`).
- **Trigger**: Calculated strictly in UTC based on `Conversation.customer_service_window_expires_at`.
- **Policy Enforcement**:
  - If window is closed and client requests `message_type = "text"`, the endpoint raises `HTTP 422 Unprocessable Entity`:
    `CUSTOMER_SERVICE_WINDOW_EXPIRED: 24 saatlik müşteri iletişim penceresi kapandı. Yalnızca onaylı bir Meta şablonu (template) gönderilebilir.`
  - No configuration flags or bypass mechanisms are permitted.
  - Freeform messages are never silently converted to templates.

---

## 4. Template Handling

- When outside the 24-hour window, only `message_type = "template"` is accepted.
- Required attributes:
  - `template_name`: Non-empty string corresponding to the pre-approved template name registered in Meta Business Manager.
  - `template_language`: Two-letter ISO language code (e.g. `"tr"`, `"en"`).
  - `template_parameters` (optional): Component substitution values.
- If `template_name` or `template_language` is missing/empty, request is rejected with `HTTP 422`.

---

## 5. Meta Cloud API Request Format

Outbound dispatches communicate directly with:
`POST https://graph.facebook.com/{META_GRAPH_API_VERSION}/{PHONE_NUMBER_ID}/messages`

### Headers:
- `Authorization: Bearer <DECRYPTED_TOKEN>`
- `Content-Type: application/json`

### Text Payload:
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "905321112233",
  "type": "text",
  "text": {
    "body": "Mesaj metni"
  }
}
```

### Template Payload:
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "905321112233",
  "type": "template",
  "template": {
    "name": "sample_template",
    "language": {
      "code": "tr"
    },
    "components": [...]
  }
}
```

---

## 6. Token Retrieval & Credential Vault Security

1. **At-Rest Storage**: Access tokens are stored as encrypted Fernet ciphertexts (`encrypted_access_token`) in `whatsapp_numbers`.
2. **Send Boundary Decryption**: Decryption (`CredentialVault.decrypt`) occurs strictly inside `OutboundWorker.process_outbox_job` immediately before making the HTTP call to Meta.
3. **Zero Disclosure**:
   - `OutboxMessage` records contain zero tokens (only foreign keys `whatsapp_number_id` and `message_id`).
   - Tokens never appear in exceptions or error logs (`redact_secrets` strips `EAAB...` and `Bearer ...`).
   - API response DTOs (`MessageResponse`) do not serialize credentials.

---

## 7. Durable Transactional Outbox Architecture

To prevent message loss during server restarts or network spikes, Tezlify uses a database-backed Transactional Outbox table `outbox_messages`.

### Schema:
- `id`: Integer Primary Key
- `user_id`: Tenant UUID
- `message_id`: Foreign Key `messages.id` (ON DELETE CASCADE)
- `whatsapp_number_id`: Foreign Key `whatsapp_numbers.id` (ON DELETE CASCADE)
- `event_type`: `"SEND_MESSAGE"`
- `payload_json`: Non-sensitive parameters (template name, language, parameters)
- `status`: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `RETRYABLE`, `AMBIGUOUS_PROVIDER_RESULT`
- `attempt_count`: Integer default 0
- `max_attempts`: Integer default 3
- `available_at`: Timestamp (UTC) for scheduling & exponential backoff
- `locked_at`: Timestamp (UTC) for worker lease
- `locked_by`: Worker instance ID
- `last_error`: Sanitized error description
- `created_at`, `processed_at`

### Transactional Guarantee:
`Message` (status=PENDING) and `OutboxMessage` (status=PENDING) are committed in the **exact same database transaction**. If transaction rolls back, neither is persisted.

---

## 8. Outbound Worker Lifecycle & Concurrency

- **Lease Semantics**:
  - Worker acquires exclusive lease by atomically updating:
    `status = PROCESSING, locked_at = now, locked_by = worker_id`
    where `status in ('PENDING', 'RETRYABLE') and available_at <= now and (locked_at is None or locked_at < now - 60s)`.
  - Checking `rowcount == 1` guarantees that across concurrent workers or processes, exactly one worker executes the dispatch.
- **Lease Expiration**: If a worker crashes mid-execution, the lease expires after 60 seconds, allowing recovery.

---

## 9. Selective Retry Policy & Ambiguity Handling

| Error Scenario | Meta Code / HTTP | Retry Policy | Outcome |
| :--- | :--- | :--- | :--- |
| Invalid Token | 190 / 401 | **Fail-Fast** | Outbox `FAILED`, Message `FAILED` |
| Permission Denied | 200 / 403 | **Fail-Fast** | Outbox `FAILED`, Message `FAILED` |
| Invalid Parameter | 100 / 400 | **Fail-Fast** | Outbox `FAILED`, Message `FAILED` |
| Rate Limited | 130429 / 429 | **Retryable** | Outbox `RETRYABLE` (Exponential Backoff + Jitter) |
| Server 5xx | 500, 502, 503, 504 | **Retryable** | Outbox `RETRYABLE` (Exponential Backoff + Jitter) |
| Connection Timeout | Network connect | **Retryable** | Safe retry (connection never reached Meta) |
| **Read Timeout / Drop** | **POST read timeout** | **NO RETRY** | Outbox `AMBIGUOUS_PROVIDER_RESULT` |

### Conservative Ambiguity Handling:
When an HTTP `ReadTimeout` occurs during a `POST .../messages` call, the payload has already been transmitted to Meta. If Meta processed the message but the socket timed out while reading the acknowledgment, blindly retrying the POST would cause duplicate WhatsApp messages to be sent to the customer. Tezlify classifies this as `AMBIGUOUS_PROVIDER_RESULT` and halts automatic retries, allowing reconciliation via inbound status webhooks.

---

## 10. Webhook Status Integration

When Meta processes the outbound message, it delivers status events via HTTPS webhooks:
1. `sent`: Meta server has dispatched to WhatsApp infrastructure.
2. `delivered`: Message has landed on recipient's device.
3. `read`: Recipient has opened the conversation thread.
4. `failed`: Message delivery failed (e.g. phone disconnected).

The status pipeline (`WhatsAppWebhookService`) resolves `Message.wa_message_id == statuses[0].id` and advances state via `MessageStateMachine`:
$$\text{PENDING} \longrightarrow \text{SENT} \longrightarrow \text{DELIVERED} \longrightarrow \text{READ}$$
Out-of-order deliveries that attempt backward regressions (e.g. `READ -> DELIVERED`) are rejected without error.

---

## 11. Test Suite Results

```bash
PYTHONPATH=. ./venv/bin/pytest backend/tests/test_whatsapp_phase4_outbound.py -v
================== 40 passed, 1 skipped in 3.80s ==================
```

### Full System Regression Baseline:
```bash
PYTHONPATH=. ./venv/bin/pytest backend/tests/ -q
610 passed, 3 skipped, 1828 warnings in 33.60s
```

- **Phase 1 Domain Tests**: 34 passed
- **Phase 2 Active Numbers Tests**: 16 passed, 1 skipped (Real Meta E2E)
- **Phase 3 Webhook Ingestion Tests**: 33 passed, 1 skipped (Real Meta E2E)
- **Phase 4 Outbound Messaging Tests**: 40 passed, 1 skipped (Real Meta E2E)
- **Total Backend Suite**: 610 passed, 3 skipped, 0 failed

### Frontend Compilation:
```bash
cd frontend && npm run build
✓ 1639 modules transformed.
✓ built in 1.77s
```

---

## 12. Real Meta E2E Status

- **Status**: **NOT RUN**
- **Rationale**: Controlled live Meta Cloud API outbound dispatches require explicit opt-in environment configuration (`REAL_META_E2E=true`, `REAL_META_TEST_RECIPIENT`, `META_PHONE_NUMBER_ID`, `META_CLOUD_ACCESS_TOKEN`). No test credentials were provided in the environment.
- **Compliance**: Adheres strictly to the requirement that Real Meta E2E is never falsely reported as PASS without actual provider execution.
