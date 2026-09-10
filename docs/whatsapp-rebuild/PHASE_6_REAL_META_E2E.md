# Tezlify WhatsApp Rebuild — Phase 6: Real Meta Cloud API E2E & Production Verification

## 1. Executive Summary

Phase 6 marks the final verification and production readiness phase of the Official Meta WhatsApp Cloud API rebuild. This phase audits live credentials, Graph API version compliance, public webhook accessibility, outbox worker production execution, webhook durability recovery, cryptographic verification, error forensics, and multi-tenant isolation.

**Current Production Status**:
- **Architecture & Codebase Status**: **PRODUCTION-READY** (All 636 tests passing, zero regressions).
- **Live Meta E2E Status**: **BLOCKED / NOT RUN**.
  - **Forensic Blocker 1**: The access token currently configured in `.env` has expired (`OAuthException`, code `190`, subcode `463`: *"Session has expired on Friday, 28-Aug-26"*).
  - **Forensic Blocker 2**: `REAL_META_TEST_RECIPIENT` is not configured in the environment.
  - **Forensic Blocker 3**: Localhost environment does not have a public HTTPS domain / reverse proxy configured for Meta Cloud API webhook ingress.

---

## 2. Meta Environment & System Requirements

### 2.1 Required Environment Variables
| Variable | Description | Production Requirement |
|---|---|---|
| `META_CLOUD_ACCESS_TOKEN` / `WHATSAPP_CLOUD_ACCESS_TOKEN` | System User Permanent Access Token with `whatsapp_business_messaging` | **Permanent System User Token** (Never use 24h short-lived temporary user token) |
| `META_PHONE_NUMBER_ID` / `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | WhatsApp Business Phone Number ID from App Dashboard | Required |
| `META_WABA_ID` / `WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID` | WhatsApp Business Account ID | Required |
| `META_APP_SECRET` / `WHATSAPP_CLOUD_APP_SECRET` | App Secret from Meta Developer Dashboard | Required for HMAC-SHA256 signature verification |
| `META_WEBHOOK_VERIFY_TOKEN` / `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN` | Random high-entropy token configured in Webhook section | Required for handshake challenge |
| `META_GRAPH_API_VERSION` | Centralized Graph API version | Current default: `v21.0` |
| `TEZLIFY_CREDENTIAL_ENCRYPTION_KEY` | Symmetric Fernet key (32 base64 bytes) | Required for Vault encryption |
| `REAL_META_TEST_RECIPIENT` | E.164 authorized test phone number (e.g. `+90532...`) | Required for live test dispatch |
| `REAL_META_E2E` | Explicit opt-in flag for live testing (`true` / `false`) | Set to `true` only when credentials are live |

---

## 3. Meta App & WABA Configuration

1. **Meta App Type**: Business App.
2. **Product**: WhatsApp.
3. **Permissions**:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
4. **WABA Subscribed Apps**:
   - Webhooks must be subscribed via `POST /{WABA_ID}/subscribed_apps`.
   - Webhook field subscription: `messages`.

---

## 4. Webhook Ingress & Public HTTPS Contract

1. **Public Reachability**:
   - Meta Cloud API sends HTTPS POST requests directly from Meta servers to your webhook callback URL.
   - Localhost (`127.0.0.1`, `localhost`) cannot receive live Meta webhooks.
   - Production requires a publicly resolvable domain with valid SSL (e.g., `https://api.tezlify.com/api/v1/whatsapp/webhook` or an ngrok/Cloudflare tunnel for staging).
2. **Verification Handshake Contract (GET)**:
   - Request: `GET /api/v1/whatsapp/webhook?hub.mode=subscribe&hub.challenge=<val>&hub.verify_token=<token>`
   - Contract: If `hub.verify_token` matches, returns HTTP 200 with raw `<val>` text body (`text/plain`, never JSON). If mismatched, returns HTTP 403.
3. **Cryptographic Ingestion Contract (POST)**:
   - Request: `POST /api/v1/whatsapp/webhook`
   - Header: `X-Hub-Signature-256: sha256=<hmac_hex>`
   - Verification: Computes HMAC-SHA256 on raw body bytes using `META_APP_SECRET`. Compares with timing-safe comparison (`hmac.compare_digest`).

---

## 5. End-to-End Realtime Flows

### 5.1 Inbound Message Flow
```
Meta Cloud API
  └─► POST /api/v1/whatsapp/webhook
        ├─► 1. Verify HMAC-SHA256 signature (403 on invalid)
        ├─► 2. Persist WebhookEvent (status=RECEIVED, event_hash deduplication)
        ├─► 3. Parse normalized envelope
        ├─► 4. Resolve Tenant via metadata.phone_number_id
        ├─► 5. Resolve Contact by (user_id, phone_e164)
        ├─► 6. Resolve Conversation by (user_id, whatsapp_number_id, contact_id)
        ├─► 7. Update 24h Customer Service Window
        ├─► 8. Insert Message (direction=INBOUND, status=DELIVERED, wa_message_id=wamid)
        ├─► 9. Transaction COMMIT
        └─► 10. Realtime dispatch: ws_manager.broadcast("inbound_reply", user_id)
                  └─► WhatsApp Hub UI updates active thread & reorders conversation list
```

### 5.2 Outbound Message Flow
```
ChatComposer (Frontend)
  └─► POST /api/v1/conversations/{id}/messages
        ├─► 1. Validate 24h Customer Service Window (HTTP 422 if expired and freeform text)
        ├─► 2. Insert Message (status=PENDING, client_message_id='cmsg_...')
        ├─► 3. Insert OutboxMessage (status=PENDING)
        ├─► 4. Transaction COMMIT (Returns HTTP 201)
        └─► 5. OutboundWorker Daemon (in-process or background loop):
                  ├─► Atomically leases outbox job (row-level lock)
                  ├─► Decrypts Meta token strictly at send boundary
                  ├─► POST /v21.0/{phone_number_id}/messages
                  ├─► Extracts wamid, transitions Message status PENDING -> SENT
                  ├─► OutboxMessage status -> COMPLETED
                  └─► Broadcasts WebSocket "message_status_updated" (status=SENT)
```

### 5.3 Delivery & Read Status Lifecycle
```
Customer receives message
  └─► Meta Webhook: status = "delivered"
        └─► Message transitions: SENT -> DELIVERED (Monotonic forward progression)
Customer opens message
  └─► Meta Webhook: status = "read"
        └─► Message transitions: DELIVERED -> READ (Monotonic forward progression)
```

---

## 6. Worker & Durability Architecture

### 6.1 Outbound Worker Health & Background Daemon
- **In-Process Background Task**: Every new message is immediately scheduled via FastAPI `background_tasks.add_task(OutboundWorker.process_outbox_message_by_id, outbox_job.id)` for 0-latency dispatch.
- **Production Worker Daemon**: In [`backend/app/main.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/main.py), a background daemon `outbound_worker_daemon()` runs periodically inside the application lifespan.
- **Stuck Lease Recovery**: `OutboundWorker.recover_stuck_leases(lease_timeout_seconds=60)` reclaims any job stuck in `PROCESSING` if a server worker crashes mid-dispatch.
- **Boot Recovery**: On application boot (`recover_stuck_jobs`), all stuck leases are reset to `PENDING`.

### 6.2 Webhook Durability Recovery
- `WebhookEvent` records raw payloads with status `RECEIVED` before domain processing.
- `WhatsAppWebhookService.recover_unprocessed_events(batch_size=20)` scans and reprocesses any webhook events left in `RECEIVED` or `PROCESSING` state across container restarts or deployment interruptions.

---

## 7. Security & Tenant Isolation Audit

1. **Zero Secret Leakage**:
   - Meta access tokens, encrypted vault strings, app secrets, and webhook verify tokens are strictly forbidden from REST API serialization and WebSocket frames.
   - `redact_secrets()` strips all tokens matching `Bearer`, `access_token=`, `EAA...`, or `secret:` patterns from exception messages and logs.
2. **WebSocket Scoping**:
   - Sockets are registered under tenant `user_id`.
   - Broadcasts with `target_user_id` dispatch exclusively to that user's active sockets.
3. **No Browser Direct Calls**:
   - The browser never communicates with `graph.facebook.com`. All requests route through `/api/v1/...`.

---

## 8. Meta Error Forensics & Classification

The system maps Meta Graph API errors to clean domain behaviors:
| HTTP Status | Meta Code | Error Subcode | Category | System Behavior |
|---|---|---|---|---|
| `401` | `190` | `463` | Session Expired | Terminal error, fail-fast without retry, alert admin to rotate token |
| `401` | `190` | `467` | Access token has been invalidated | Terminal error, alert admin |
| `429` | `80007` / `130429` | — | Rate Limit Hit | Exponential backoff retry with jitter |
| `400` | `100` | — | Invalid Parameter | Terminal error, outbox marked FAILED |
| `400` | `131047` | — | 24-Hour Window Expired | Reject freeform, mandate pre-approved template |
| `5xx` | `1` / `2` | — | Transient Meta Server Error | Exponential backoff retry up to 3 attempts |
| Network Timeout | — | — | `ReadTimeout` / Disconnect | Flagged as `AMBIGUOUS_PROVIDER_RESULT`, blind retry prevented |

---

## 9. Verification & Test Results

### Phase 6 Targeted Test Suite (`test_whatsapp_phase6_real_meta.py`)
```bash
PYTHONPATH=. ./venv/bin/pytest backend/tests/test_whatsapp_phase6_real_meta.py -v
```
**Results**: **10 PASSED**, **1 SKIPPED** (live Meta call safely skipped due to token expiration):
- `test_credential_audit_and_redaction`: **PASS**
- `test_graph_api_version_centralization`: **PASS**
- `test_webhook_get_verification_handshake`: **PASS**
- `test_webhook_hmac_verification`: **PASS**
- `test_webhook_durability_recovery`: **PASS**
- `test_outbox_worker_stuck_lease_recovery`: **PASS**
- `test_outbox_worker_batch_execution`: **PASS**
- `test_meta_error_forensics`: **PASS**
- `test_security_audit_zero_token_in_endpoints`: **PASS**
- `test_tenant_isolation_safety`: **PASS**
- `test_real_meta_cloud_api_live_e2e`: **SKIPPED (BLOCKED: Token expired)**

### Full Backend Regression Test Suite
```bash
PYTHONPATH=. ./venv/bin/pytest backend/tests/ -q
```
**Results**: **636 PASSED**, **5 SKIPPED** in 35.46s (Zero regressions across all test suites).

### Frontend Production Build
```bash
cd frontend && npm run build
```
**Results**: **PASS** (`tsc && vite build` built in 1.70s with 0 errors).

---

## 10. Production Deployment Checklist

Before switching production traffic to live Meta WhatsApp Cloud API:

- [ ] **Generate Permanent System User Token**:
  - In Meta Business Suite -> Settings -> System Users -> Generate Token.
  - Select scopes: `whatsapp_business_messaging`, `whatsapp_business_management`.
  - Set expiration: **Never** (Permanent).
- [ ] **Update `.env`**:
  - `WHATSAPP_CLOUD_ACCESS_TOKEN=<NEW_PERMANENT_SYSTEM_USER_TOKEN>`
  - `WHATSAPP_CLOUD_PHONE_NUMBER_ID=<YOUR_PHONE_NUMBER_ID>`
  - `WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID=<YOUR_WABA_ID>`
  - `WHATSAPP_CLOUD_APP_SECRET=<YOUR_META_APP_SECRET>`
  - `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=<RANDOM_32_CHAR_SECRET>`
  - `REAL_META_TEST_RECIPIENT=<YOUR_TEST_MOBILE_E164>`
  - `REAL_META_E2E=true`
- [ ] **Configure Meta Developer Dashboard Webhook**:
  - Callback URL: `https://<YOUR_PUBLIC_DOMAIN>/api/v1/whatsapp/webhook`
  - Verify Token: `<MATCHING_VERIFY_TOKEN>`
  - Click **Verify and Save**.
  - Subscribe to field: `messages`.
- [ ] **Subscribe WABA to App**:
  - Ensure `POST /{WABA_ID}/subscribed_apps` has been invoked.
- [ ] **Restart Server**:
  - Verify worker daemon starts: `[WORKER] Outbound & Webhook background worker daemon started.`
- [ ] **Execute Live Dispatch Test**:
  - Run live test: `REAL_META_E2E=true pytest backend/tests/test_whatsapp_phase6_real_meta.py -k test_real_meta_cloud_api_live_e2e -v`
