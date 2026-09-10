# Tezlify WhatsApp Rebuild — Phase 2: Active Numbers + Real Meta Cloud API Connection

## 1. Architecture

Phase 2 transforms the **"Aktif Numaralar"** module into a production-grade Meta WhatsApp Cloud API (Graph API v21+) line management system. All legacy Baileys sessions, mock pairing mechanisms, and QR-code simulations have been decommissioned from the numbers lifecycle.

### Layered Architecture

```
┌────────────────────────────────────────────────────────┐
│                   Frontend UI Layer                    │
│   (Vuexy Design, WhatsAppNumberCard, Real Connect Modal)│
└───────────────────────────┬────────────────────────────┘
                            │ REST / JSON (No Token Returns)
┌───────────────────────────▼────────────────────────────┐
│                    API Router Layer                    │
│  (/api/v1/whatsapp/numbers - Authentication & Tenant)  │
└───────────────────────────┬────────────────────────────┘
                            │ Domain DTOs
┌───────────────────────────▼────────────────────────────┐
│               Application Service Layer                │
│    (WhatsAppNumberService - Lifecycle & Invariants)    │
└─────────────┬────────────────────────────┬─────────────┘
              │                            │
┌─────────────▼──────────────┐  ┌──────────▼─────────────┐
│      CredentialVault       │  │   MetaCloudApiClient   │
│  (Fernet Authenticated     │  │  (Graph API v21+       │
│   AES-128-CBC + HMAC)      │  │   Connection Pool,     │
└─────────────┬──────────────┘  │   Exponential Backoff, │
              │                 │   Error Normalization) │
┌─────────────▼──────────────┐  └──────────┬─────────────┘
│    Database Storage        │             │ HTTPS
│  (encrypted_access_token)  │  ┌──────────▼─────────────┐
└────────────────────────────┘  │  Meta Graph API v21+   │
                                └────────────────────────┘
```

---

## 2. Meta API Operations

Operations are executed strictly via the `MetaCloudApiClient` adapter:

1. **`GET /{phone_number_id}`**:
   - Queries `fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status`.
   - Used during pre-flight validation and connection verification.
2. **`GET /{waba_id}/phone_numbers`**:
   - Lists all phone numbers owned by the specified WhatsApp Business Account (WABA).
   - Validates that the submitted `phone_number_id` belongs strictly to the submitted `waba_id`.
3. **`POST /{waba_id}/subscribed_apps`**:
   - Subscribes the application to the WABA's webhooks.
   - Idempotent operation: safely succeeds even if the app was previously subscribed.
4. **`GET /debug_token`** (if app access token available):
   - Inspects granular scopes such as `whatsapp_business_messaging`.

---

## 3. Credential Storage

### Security Invariants:
1. **Authenticated Symmetric Encryption**:
   - Uses `cryptography.fernet.Fernet` (AES-128 in CBC mode with PKCS7 padding and HMAC-SHA256 authenticated signature).
   - Plaintext access tokens are **never** written to database columns, temporary tables, or cache stores.
2. **Key Resolution**:
   - Sourced from `settings.TEZLIFY_CREDENTIAL_ENCRYPTION_KEY`.
   - In development/test mode, falls back to a deterministic 32-byte key derived from `SECRET_KEY` + application salt via SHA-256, ensuring credentials survive server restarts during local evaluation.
   - In production mode (`ENVIRONMENT=production`), missing key triggers fail-fast on startup.
3. **Zero Token Leakage**:
   - `encrypted_access_token` and raw tokens are excluded from all Pydantic Read schemas (`WhatsAppNumberRead`).
   - Token masking and redaction regex (`SECRET_REDACT_PATTERNS`) scrubs tokens from exception traces, internal developer logs, and client HTTP payloads.

---

## 4. Connect Flow

```
User (Frontend)
   │
   ├─► Enters: Name, WABA ID, Phone Number ID, Access Token
   │
   ├─► Clicks "Bağlantıyı Doğrula" (Pre-Flight Validation)
   │     │
   │     ├─► POST /api/v1/whatsapp/numbers/validate
   │     ├─► Backend calls Meta Graph API (WABA check + Phone details)
   │     └─► Returns: { is_valid: true, verified_name, quality_rating, display_phone_number }
   │
   ├─► UI renders Meta Verification badge with green status
   │
   ├─► Clicks "Hattı Kaydet ve Aktif Et"
   │     │
   │     ├─► POST /api/v1/whatsapp/numbers
   │     ├─► Unique constraint verified for phone_number_id
   │     ├─► Token encrypted with Fernet
   │     ├─► WABA subscribed_apps verified/registered
   │     ├─► WhatsAppNumber saved with status = ACTIVE
   │     └─► Returns WhatsAppNumberRead (WITHOUT TOKEN)
   │
   └─► UI updates Active Numbers grid with WhatsAppNumberCard
```

---

## 5. Verify Flow

- **Operation**: `POST /api/v1/whatsapp/numbers/{id}/verify`
- **Mechanism**:
  1. Retrieves `WhatsAppNumber` under tenant context.
  2. Decrypts `encrypted_access_token` from vault.
  3. Queries Meta Graph API `GET /{phone_number_id}`.
  4. On success: Updates `status = ACTIVE`, `last_verified_at = now()`, `verified_name`, `quality_rating`.
  5. On failure: Updates `status = ERROR`, preserves credential, returns normalized `MetaApiError`.
  6. **No Fake Success**: If Meta is unreachable or token is invalid, returns `verified: false` with exact failure reason.

---

## 6. Update Flow

- **Operation**: `PUT /api/v1/whatsapp/numbers/{id}`
- **Immutable Canonical Identity**:
  - `phone_number_id` **CANNOT** be modified.
  - `waba_id` **CANNOT** be modified.
  - `display_phone_number` **CANNOT** be arbitrarily modified by the user (only canonical Meta numbers).
- **Mutable Attributes**:
  - `name`: User-facing line label (e.g. "İstanbul Satış Hattı").
  - `access_token`: Optional credential rotation.

---

## 7. Token Rotation

### Atomic Credential Rotation Contract:
1. User provides a new access token in `PUT /api/v1/whatsapp/numbers/{id}`.
2. The service queries Meta Graph API using the **new** token before touching the database.
3. **If new token is valid**:
   - Encrypts new token.
   - Replaces `encrypted_access_token` inside an atomic transaction.
   - Updates `status = ACTIVE` and `last_verified_at = now()`.
4. **If new token is invalid / rejected by Meta**:
   - Transaction aborts immediately.
   - The existing working encrypted token is **preserved intact**.
   - Line continues functioning with the previous valid credential.

---

## 8. Disconnect Flow

- **Operation**: `POST /api/v1/whatsapp/numbers/{id}/disconnect`
- **Behavior**:
  1. Sets `status = DISCONNECTED`.
  2. Sets `deleted_at = now()`.
  3. Sets `encrypted_access_token = NULL` (token invalidated and wiped).
  4. Line is excluded from active campaign routing and outbound dispatching.
  5. **Data Preservation**:
     - `conversations` remain intact.
     - `messages` remain intact.
     - `leads` and `contacts` remain untouched.

---

## 9. Remove Flow

- **Operation**: `DELETE /api/v1/whatsapp/numbers/{id}`
- **Behavior**:
  - Default soft delete (`hard_delete=False`): Marks `status = DISCONNECTED` with timestamp.
  - Physical hard delete (`hard_delete=True`):
    - Table constraint `conversations.whatsapp_number_id` is configured with `ON DELETE SET NULL`.
    - Deleting the number resets `conversations.whatsapp_number_id = NULL`.
    - Conversations, messages, contacts, and leads are **never** cascaded or deleted.

---

## 10. Tenant Isolation

All queries enforce tenant boundaries via `user_id`:
- `GET /numbers`: Filtered by `user_id`.
- `GET /numbers/{id}`: Returns `404 Not Found` if the number belongs to a different tenant.
- `PUT /numbers/{id}`: Returns `404 Not Found` without modifying data.
- `POST /numbers/{id}/verify`: Returns `404 Not Found`.
- `POST /numbers/{id}/disconnect`: Returns `404 Not Found`.
- `DELETE /numbers/{id}`: Returns `404 Not Found`.
- ID enumeration attacks are impossible.

---

## 11. Error Handling

Meta error codes are normalized into `MetaApiError`:
- **401 Unauthorized**: Mapped to humanized `"Geçersiz veya süresi dolmuş Meta erişim token'ı."`
- **400 Bad Request**: Mapped to humanized `"Geçersiz parametre veya eşleşmeyen WABA / Telefon ID."`
- **403 Forbidden**: Mapped to humanized `"Meta uygulamasının WhatsApp Business izinleri yetersiz."`
- **Raw token scrubbing**: Tokens never appear in error messages or client toasts.

---

## 12. Retry Policy

`MetaCloudApiClient` uses an async HTTP connection pool (`httpx.AsyncClient`) with granular timeouts:
- Connect: 5.0s
- Read: 15.0s
- Write: 10.0s
- Pool: 10.0s

### Retry Matrix:
| Error Condition | Status Code | Policy | Backoff |
| :--- | :--- | :--- | :--- |
| Network Timeout / Reset | 503 / ConnectError | **Retry** (up to 3x) | Exponential + Jitter |
| Server Error | 500, 502, 503, 504 | **Retry** (up to 3x) | Exponential + Jitter |
| Rate Limit | 429 | **Retry** (up to 3x) | Exponential + Jitter |
| Auth Failure | 401 | **Fail Fast** (0 retries) | Immediate abort |
| Permission Denied | 403 | **Fail Fast** (0 retries) | Immediate abort |
| Validation Error | 400 | **Fail Fast** (0 retries) | Immediate abort |
| Resource Not Found | 404 | **Fail Fast** (0 retries) | Immediate abort |

---

## 13. Security

1. **At-Rest Encryption**: Fernet authenticated encryption for all access tokens.
2. **In-Flight Protection**: Graph API communication over TLS 1.3.
3. **No Credential Echo**: Read DTOs omit tokens completely.
4. **Idempotency & Race Protection**: Unique constraint on `phone_number_id` prevents duplicate lines. Concurrent connects resolve deterministically.

---

## 14. Test Matrix & Results

### Automated Test Suite: `backend/tests/test_whatsapp_phase2_numbers.py`
| Test Case | Category | Status |
| :--- | :--- | :--- |
| `test_credential_vault_encrypt_decrypt` | Unit (Crypto) | **PASSED** |
| `test_credential_vault_masking` | Unit (Security) | **PASSED** |
| `test_credential_vault_empty_and_invalid` | Unit (Crypto) | **PASSED** |
| `test_meta_error_normalization_and_redaction` | Unit (Meta Adapter) | **PASSED** |
| `test_meta_client_retry_classification` | Unit (Meta Adapter) | **PASSED** |
| `test_meta_phone_number_details_parsing` | Unit (Meta Adapter) | **PASSED** |
| `test_validate_credentials_success_mock` | Integration (Validation) | **PASSED** |
| `test_connect_number_end_to_end_mock` | Integration (Connect) | **PASSED** |
| `test_atomic_token_rotation_success` | Integration (Lifecycle) | **PASSED** |
| `test_atomic_token_rotation_failure_preserves_old_credential`| Integration (Lifecycle) | **PASSED** |
| `test_disconnect_number_preserves_conversations_and_leads` | Integration (Data Integrity) | **PASSED** |
| `test_remove_number_hard_delete_nullifies_conversation_foreign_key` | Integration (Data Integrity) | **PASSED** |
| `test_tenant_isolation_unauthorized_access_rejected` | Security (Multi-Tenancy) | **PASSED** |
| `test_token_non_disclosure_in_api_responses` | Security (Token Leakage) | **PASSED** |
| `test_duplicate_phone_number_id_rejected_application_layer` | Concurrency & Validation | **PASSED** |
| `test_concurrent_connect_deterministic_handling` | Concurrency | **PASSED** |
| `test_real_meta_cloud_api_live` | E2E Live Integration | **SKIPPED (NOT RUN)** |

**Suite Result**: 16 Passed, 1 Skipped (50 total passed when combined with Phase 1).

---

## 15. Real Meta Test Result

```
REAL META E2E TEST NOT RUN
```
*(No live Meta credentials provided in the testing environment. Per Section 34 & 41 invariants, this test is explicitly marked as NOT RUN rather than mocked.)*

---

## 16. Known Limitations

1. **Embedded Signup Flow**: Current UI supports manual credential entry (WABA ID, Phone ID, System User Permanent Token). Meta Embedded Signup (OAuth pop-up dialog) will be introduced in an enterprise onboarding addon.
2. **Automatic Token Expiry Detection**: Long-lived permanent tokens are validated on-demand and on verification. Background cron polling for health will be coordinated with Phase 3/4.

---

## 17. Phase 3 Prerequisites

With Phase 2 successfully completing Active Numbers and Meta Cloud API adapter connectivity:
1. Webhook processing pipeline (`/webhook/whatsapp`) can ingest incoming messages with verified tenant mapping (`whatsapp_number_id`).
2. Outbound message dispatching can leverage `MetaCloudApiClient` using decrypted line credentials.
3. Multi-number conversation routing can safely reference active lines.
