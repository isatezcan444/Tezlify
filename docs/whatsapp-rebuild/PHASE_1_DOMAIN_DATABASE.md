# Tezlify WhatsApp Rebuild — Phase 1: Domain + Database Foundation

## 1. Executive Summary

Phase 1 establishes the canonical domain and database architecture for Tezlify's WhatsApp Business Platform (Cloud API v21+) overhaul. It establishes multi-number, multi-tenant, idempotent persistence while cleanly decoupling CRM Leads from messaging conversations and eliminating all destructive cascade side-effects.

---

## 2. Domain Model

```
                ┌────────────────────────────────┐
                │         WhatsAppNumber         │
                │  (phone_number_id UNIQUE, WABA)│
                └───────────────┬────────────────┘
                                │ 1
                                │ *
                ┌───────────────▼────────────────┐
                │          Conversation          │
                │(lead_id NULLABLE, 24h window)  │
                └──┬───────────────────────────┬─┘
                 * │                           │ *
┌──────────────────▼──────────┐      ┌─────────▼─────────────────────┐
│           Contact           │      │            Message            │
│  (normalized E.164 phone)   │      │(wamid UNIQUE, client_id UNIQUE│
│  (lead link is OPTIONAL)    │      │ direction, monotonic status)  │
└─────────────────────────────┘      └───────────────────────────────┘
                                                     ▲
                                                     │ idempotency
                                     ┌───────────────┴───────────────┐
                                     │         WebhookEvent          │
                                     │(event_hash UNIQUE, SHA-256)   │
                                     └───────────────────────────────┘
```

### Core Entities:
1. **`WhatsAppNumber`**: Canonical entity for registered WhatsApp Business Cloud API numbers (`phone_number_id`, `waba_id`, `business_account_id`, `credential_reference`, `status`, `quality_rating`, `verified_name`).
2. **`Contact`**: Canonical representation of an external customer or phone interlocutor (`phone_e164`, `display_name`, `whatsapp_profile_name`, optional `lead_id`).
3. **`Conversation`**: Contextual dialogue thread between a `WhatsAppNumber` and a `Contact`. Multi-number capable (`whatsapp_number_id` + `contact_id`). CRM `lead_id` is **strictly nullable**.
4. **`Message`**: Discrete chat communication (`direction` [INBOUND/OUTBOUND], `message_type`, `body`, `wa_message_id`/`external_message_id`, `client_message_id`, monotonic `status`, error tracking, and UTC lifecycle timestamps).
5. **`WebhookEvent`**: Audit and deduplication ledger for incoming Meta webhooks (`event_hash`, `provider`, `event_type`, `external_message_id`, `status`, `received_at`, `processed_at`).

---

## 3. Entity Relationships

| Parent Entity | Child Entity | Foreign Key | Delete Constraint | Business Rule |
| :--- | :--- | :--- | :--- | :--- |
| `User` (Tenant) | `WhatsAppNumber` | `user_id` | `CASCADE` | Tenancy isolation boundary |
| `WhatsAppNumber` | `Conversation` | `whatsapp_number_id` | `SET NULL` | Disconnecting/deleting a number NEVER deletes conversations or CRM data |
| `Contact` | `Conversation` | `contact_id` | `SET NULL` | Contact record lives independently of any single conversation |
| `Lead` (CRM) | `Conversation` | `lead_id` | `SET NULL` | Lead is optional; deleting a lead NEVER deletes chat history |
| `Lead` (CRM) | `Contact` | `lead_id` | `SET NULL` | Lead link is optional enrichment |
| `Conversation` | `Message` | `conversation_id` | `CASCADE` | Messages belong to the conversation thread |

---

## 4. Database Schema

### Table: `whatsapp_numbers`
- `id` (INTEGER, PK, Autoincrement)
- `user_id` (CHAR(32), FK `users.id`, Indexed)
- `name` (VARCHAR(100), NOT NULL) — internal label (e.g. "Support Line")
- `display_phone_number` (VARCHAR(50), NOT NULL) — formatted string (+90 (541) 111 22 33)
- `phone_number_e164` (VARCHAR(50), NOT NULL, Indexed)
- `phone_number_id` (VARCHAR(100), UNIQUE, NOT NULL, Indexed) — Meta Graph API identifier
- `waba_id` (VARCHAR(100), Indexed) — WhatsApp Business Account ID
- `business_account_id` (VARCHAR(100), Nullable)
- `credential_reference` (VARCHAR(255), Nullable) — Token vault reference, never plaintext
- `status` (VARCHAR(12), NOT NULL, Default: 'ACTIVE') — Enum: `ACTIVE`, `INACTIVE`, `DISCONNECTED`, `ERROR`
- `quality_rating` (VARCHAR(50), Nullable) — Meta rating: `GREEN`, `YELLOW`, `RED`, `UNKNOWN`
- `verified_name` (VARCHAR(150), Nullable) — Certificate name approved by Meta
- `last_verified_at` (DATETIME, Nullable)
- `deleted_at` (DATETIME, Nullable) — Soft delete / disconnect timestamp
- `created_at` (DATETIME, NOT NULL, Default: UTC now)
- `updated_at` (DATETIME, NOT NULL, Default: UTC now)

### Table: `contacts`
- `id` (INTEGER, PK, Autoincrement)
- `user_id` (CHAR(32), FK `users.id`, Indexed)
- `phone_e164` (VARCHAR(50), NOT NULL, Indexed) — Canonical E.164 phone
- `display_name` (VARCHAR(150), Nullable)
- `whatsapp_profile_name` (VARCHAR(150), Nullable)
- `lead_id` (INTEGER, FK `leads.id` ON DELETE SET NULL, Nullable, Indexed)
- `custom_attributes` (JSON, Nullable)
- `created_at` (DATETIME, NOT NULL, Default: UTC now)
- `updated_at` (DATETIME, NOT NULL, Default: UTC now)

### Table: `conversations`
- `id` (INTEGER, PK, Autoincrement)
- `user_id` (CHAR(32), FK `users.id`, Indexed)
- `whatsapp_number_id` (INTEGER, FK `whatsapp_numbers.id` ON DELETE SET NULL, Nullable, Indexed)
- `contact_id` (INTEGER, FK `contacts.id` ON DELETE SET NULL, Nullable, Indexed)
- `lead_id` (INTEGER, FK `leads.id` ON DELETE SET NULL, **Nullable**, Indexed)
- `channel` (VARCHAR(30), NOT NULL, Default: 'whatsapp')
- `status` (VARCHAR(8), NOT NULL, Default: 'ACTIVE') — `ACTIVE`, `ARCHIVED`, `CLOSED`
- `last_message_at` (DATETIME, Nullable, Indexed)
- `last_customer_message_at` (DATETIME, Nullable, Indexed)
- `customer_service_window_expires_at` (DATETIME, Nullable, Indexed)
- `last_message_preview` (TEXT, Nullable)
- `unread_count` (INTEGER, NOT NULL, Default: 0)
- `last_read_at` (DATETIME, Nullable)
- `archived_at` (DATETIME, Nullable)
- `closed_at` (DATETIME, Nullable)
- `created_at` (DATETIME, NOT NULL, Default: UTC now)
- `updated_at` (DATETIME, NOT NULL, Default: UTC now)

### Table: `messages`
- `id` (INTEGER, PK, Autoincrement)
- `conversation_id` (INTEGER, FK `conversations.id` ON DELETE CASCADE, NOT NULL, Indexed)
- `user_id` (VARCHAR(36), Nullable, Indexed)
- `direction` (VARCHAR(8), NOT NULL) — `INBOUND`, `OUTBOUND`
- `message_type` (VARCHAR(8), NOT NULL) — `TEXT`, `IMAGE`, `VIDEO`, `AUDIO`, `DOCUMENT`, etc.
- `body` (TEXT, Nullable)
- `wa_message_id` (VARCHAR(150), **UNIQUE**, Nullable, Indexed) — Synonymous with `external_message_id` (wamid)
- `client_message_id` (VARCHAR(100), **UNIQUE**, Nullable, Indexed) — Client outbound idempotency key
- `sender_phone` (VARCHAR(50), NOT NULL, Indexed)
- `recipient_phone` (VARCHAR(50), NOT NULL, Indexed)
- `sender_name` (VARCHAR(100), Nullable)
- `status` (VARCHAR(9), NOT NULL, Default: 'PENDING') — `PENDING`, `SENT`, `DELIVERED`, `READ`, `FAILED`
- `error_code` (INTEGER, Nullable)
- `error_message` (TEXT, Nullable)
- `sent_at` (DATETIME, Nullable)
- `delivered_at` (DATETIME, Nullable)
- `read_at` (DATETIME, Nullable)
- `failed_at` (DATETIME, Nullable)
- `media_id` / `media_mime_type` / `media_filename` / `media_caption` (Media metadata)
- `created_at` (DATETIME, NOT NULL, Default: UTC now)
- `updated_at` (DATETIME, NOT NULL, Default: UTC now)

### Table: `webhook_events`
- `id` (INTEGER, PK, Autoincrement)
- `user_id` (CHAR(32), Nullable, Indexed)
- `provider` (VARCHAR(50), NOT NULL, Default: 'meta')
- `event_type` (VARCHAR(50), NOT NULL) — `messages`, `statuses`, etc.
- `event_hash` (VARCHAR(64), **UNIQUE**, NOT NULL, Indexed) — SHA-256 deterministic payload digest
- `external_message_id` (VARCHAR(150), Nullable, Indexed) — wamid
- `status` (VARCHAR(9), NOT NULL, Default: 'PENDING') — `PENDING`, `PROCESSED`, `FAILED`, `DUPLICATE`
- `failure_reason` (TEXT, Nullable)
- `payload_json` (TEXT, Nullable) — Sanitized payload
- `received_at` (DATETIME, NOT NULL, Default: UTC now)
- `processed_at` (DATETIME, Nullable)
- `created_at` (DATETIME, NOT NULL, Default: UTC now)

---

## 5. Constraints & Indexes

### Unique Constraints:
1. `whatsapp_numbers.phone_number_id`: Database-enforced UNIQUE constraint ensuring a single physical Meta phone number cannot be duplicated across or within tenants.
2. `messages.wa_message_id` (`external_message_id`): Unique index guaranteeing that duplicate inbound Meta webhooks cannot produce multiple message rows.
3. `messages.client_message_id`: Unique index guaranteeing outbound idempotency against rapid double-clicks or client retries.
4. `webhook_events.event_hash`: Unique index guaranteeing deterministic webhook deduplication.

### Strategic Composite Indexes:
- `idx_wanum_user_status` on `whatsapp_numbers(user_id, status)`
- `idx_contact_user_phone` on `contacts(user_id, phone_e164)`
- `idx_conv_number_contact` on `conversations(whatsapp_number_id, contact_id)`
- `idx_conv_cust_window` on `conversations(customer_service_window_expires_at)`
- `idx_msg_conv_created` on `messages(conversation_id, created_at, id)` (optimized for Keyset / Cursor pagination)

---

## 6. Idempotency Strategy

1. **Inbound Webhook Deduplication (Two-Tier Guard)**:
   - **Tier 1 (Event Level)**: Webhook events compute a deterministic SHA-256 hash over payload bytes (`event_hash`). If Meta re-delivers the exact same payload packet, SQLite/Postgres rejects the insertion via `IntegrityError`.
   - **Tier 2 (Message Level)**: Inbound messages are keyed by `wa_message_id` (`wamid`). If a webhook re-delivers a message ID, `messages.wa_message_id` UNIQUE constraint catches it and prevents duplicate message rows or duplicate notification side-effects.

2. **Outbound User Dispatch Idempotency**:
   - Outbound requests accept or generate a `client_message_id` (UUIDv4).
   - If the user double-clicks "Send" or the network retries the dispatch, the second insert hits the `client_message_id` UNIQUE constraint.

---

## 7. Message Status State Machine

The domain state machine `MessageStateMachine` strictly enforces monotonic forward progression. Backward status regressions are rejected with `InvalidMessageStatusTransitionError`.

```
                  ┌─────────┐
                  │ PENDING │
                  └──┬───┬──┘
                     │   │
        ┌────────────┘   └─────────────┐
        ▼                              ▼
    ┌───────┐                      ┌────────┐
    │ SENT  │                      │ FAILED │◄─── (From any non-terminal)
    └───┬───┘                      └────────┘
        │
        ├───────────────┐
        ▼               ▼
  ┌───────────┐     ┌────────┐
  │ DELIVERED │     │ FAILED │
  └─────┬─────┘     └────────┘
        │
        ▼
    ┌──────┐
    │ READ │ (Terminal State - Cannot revert)
    └──────┘
```

- `PENDING` $\rightarrow$ `SENT`, `FAILED`
- `SENT` $\rightarrow$ `DELIVERED`, `READ`, `FAILED`
- `DELIVERED` $\rightarrow$ `READ`, `FAILED`
- `READ` is terminal. Attempts to transition `READ` $\rightarrow$ `DELIVERED` or `DELIVERED` $\rightarrow$ `SENT` are blocked.

---

## 8. 24-Hour Customer Service Window Model

Governed by `CustomerWindowService`:
- On every inbound customer message, `last_customer_message_at` is set to the event's UTC timestamp.
- `customer_service_window_expires_at` is calculated as `last_customer_message_at + 24 hours` (strictly in UTC).
- Policy evaluation:
  - `datetime.now(timezone.utc) < customer_service_window_expires_at` $\implies$ `CustomerWindowPolicy.FREEFORM_ALLOWED`
  - Otherwise $\implies$ `CustomerWindowPolicy.TEMPLATE_REQUIRED`

---

## 9. Number Lifecycle & Delete Semantics

### Lifecycle States:
- **`ACTIVE`**: Registered, validated, and actively routing incoming/outgoing messages.
- **`INACTIVE`**: Temporarily paused or administrative hold.
- **`DISCONNECTED`**: Disconnected line. Phone credentials removed or deactivated.
- **`ERROR`**: Meta authentication or webhook validation error requiring credential re-auth.

### Safe Delete Invariant (Non-Destructive):
Deleting or disconnecting a `WhatsAppNumber` **NEVER** deletes CRM Leads, Contacts, Conversations, or Message history:
- `WhatsAppNumberService.disconnect_number(...)` transitions status to `DISCONNECTED` and sets `deleted_at`.
- Physical deletion sets `conversations.whatsapp_number_id = NULL` (`ON DELETE SET NULL`), preserving the complete conversational thread, lead association, and historical audit trail.

---

## 10. Migration Strategy & SQLite Safety

### SQLite Non-Destructive Table Rebuild:
In SQLite, changing an existing column from `NOT NULL` to `NULL` (`lead_id`) cannot be done using `ALTER COLUMN`.
`backend/app/core/migrations.py` implements a migration pattern:
1. Back up existing rows into a temporary table `conversations_v1_backup`.
2. Drop the old table and recreate `conversations` with nullable `lead_id`, new foreign keys, and indexes.
3. Copy 100% of historical rows back from the backup into the new table.
4. Clean up the backup table.
5. All migrations run idempotently on application startup.

### Legacy Data Compatibility:
Existing conversation rows without a `whatsapp_number_id` remain with `whatsapp_number_id = NULL`. They are NOT forcibly assigned to arbitrary numbers, avoiding false historical attribution.
Existing `messages.wa_message_id` is preserved and bound to `external_message_id` via SQLAlchemy synonym, ensuring 100% backwards compatibility with existing queries.

---

## 11. Security & Credential Protection

- Access tokens are never stored plaintext in the database.
- A vault token reference (`vault:meta:<phone_number_id>:<token_hash>`) is persisted in `credential_reference`.
- `WhatsAppNumberRead` schema excludes tokens and secrets from API serializations.
- Raw webhook payloads exclude tokens or authorization headers.

---

## 12. Test Results

### Test Suite Execution:
- **Phase 1 Domain Suite (`backend/tests/test_whatsapp_phase1_domain.py`)**:
  - **34 tests ran, 34 passed, 0 failed (100% pass rate in 0.45s)**.
- **Complete Application Test Suite (`pytest backend/tests/`)**:
  - **521 tests ran, 521 passed, 0 failed (100% pass rate in 30.21s)**.
  - Zero regressions across adversarial tests, concurrency tests, and data stability tests.
- **Frontend Compilation (`npm run build`)**:
  - `tsc && vite build` succeeded in 1.83s with zero errors.

---

## 13. Phase 2 Prerequisites

1. Meta Graph API v21+ HTTP client adapter (`backend/app/services/meta_cloud_client.py`).
2. Webhook verification endpoint (`GET /api/v1/whatsapp/webhook` with `hub.verify_token`).
3. Asynchronous webhook event consumer with idempotency lock.
4. Outbound template dispatcher and freeform message router.
