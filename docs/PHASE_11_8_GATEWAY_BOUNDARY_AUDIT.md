# Phase 11.8 — WhatsApp Gateway Boundary Forensic Audit

**Document Status**: COMPLETE & VERIFIED  
**Phase**: 11.8 — WhatsApp Gateway Boundary Extraction  
**Files Audited**:
- `backend/app/services/whatsapp_gateway.py` (311 lines)
- `backend/app/services/whatsapp_service.py` (3,354 lines)
- `backend/app/api/v1/endpoints/whatsapp.py` (476 lines)

---

## 1. Executive Summary & Context

Phase 11.6 established pure identity, preview normalization, and status policies (`backend/app/services/whatsapp/`).  
Phase 11.7 extracted database persistence into focused domain repositories (`backend/app/services/whatsapp/repositories/`).

Phase 11.8 focuses on the **Gateway Boundary**:
```text
backend/app/services/whatsapp_service.py
                ↓
    Application orchestration
                ↓
   Gateway boundary / adapters
      (payloads, responses, errors)
                ↓
backend/app/services/whatsapp_gateway.py
                ↓
      Node / Baileys Gateway
```

### Invariants Preserved
- **Baileys Protocol & Gateway State**: 100% untouched. No socket changes, no session-manager modifications.
- **Transaction Ownership**: Repositories and gateway helpers NEVER call `commit()`, `rollback()`, or manage savepoints.
- **Lock Ownership**: In-memory locks (`_conversation_locks`, `_sync_lock`) remain exclusively in `whatsapp_service.py`.
- **Outbox Invariant**: Outbox state machine (`PENDING`, `IN_FLIGHT`, `DELIVERED`, `DEAD_LETTER`) and ACK/NACK protocol remain untouched.
- **Fail-Closed Semantics**: Gateway unreachable or 4xx/5xx errors always raise domain/HTTP exceptions; zero false-positive success.

---

## 2. Classification Taxonomy

Each analyzed gateway-related function is classified according to its architectural responsibility:

| Classification | Definition | Target Layer | Allowed in 11.8? |
|---|---|---|---|
| **PURE_GATEWAY_POLICY** | Pure logic determining gateway routing, prefix formatting, or deterministic rules | `whatsapp/gateway/` | **YES** |
| **GATEWAY_PAYLOAD_BUILDER** | Pure builders constructing request dicts/params sent to gateway | `whatsapp/gateway/payloads.py` | **YES** |
| **GATEWAY_RESPONSE_NORMALIZER** | Pure parsers extracting and normalizing gateway response structures | `whatsapp/gateway/responses.py` | **YES** |
| **GATEWAY_TRANSPORT** | Async HTTP I/O talking directly to Node/Baileys gateway | `whatsapp_gateway.py` | **RETAIN** (no duplicate client) |
| **SESSION_ORCHESTRATOR** | High-level session lifecycle managing DB state and transactions | `whatsapp_service.py` | **DEFERRED** |
| **TRANSACTION_ORCHESTRATOR** | Database transaction coordination, savepoint handling, commit timing | `whatsapp_service.py` | **FORBIDDEN** |
| **OUTBOX_ORCHESTRATOR** | Outbox event delivery, claim, and status tracking | `whatsapp_service.py` | **FORBIDDEN** |
| **EVENT_ORCHESTRATOR** | Processing incoming WebSocket/webhook gateway events with DB updates | `whatsapp_service.py` | **DEFERRED** |
| **DEFERRED** | Operations involving multi-step coordination to be tackled in later phases | `whatsapp_service.py` | **DEFERRED** |

---

## 3. Forensic Audit Table: `whatsapp_gateway.py`

`whatsapp_gateway.py` is the existing HTTP transport layer (311 lines). It uses `httpx.AsyncClient` with fail-closed exception handling wrapping errors in `WhatsAppGatewayError`.

| Function | Lines | HTTP Calls | DB Calls | Locks | Exceptions Raised / Caught | Classification | Risk | Extraction Action |
|---|---|---|---|---|---|---|---|---|
| `_diagnostic_route` | 6 (L19-24) | 0 | 0 | 0 | None | PURE_GATEWAY_POLICY | LOW | Keep in `whatsapp_gateway.py` (tested by diagnostic tests) |
| `WhatsAppGatewayError` | 12 (L27-38) | 0 | 0 | 0 | None | PURE_GATEWAY_POLICY | LOW | Canonical error class; retain |
| `gateway_base` | 2 (L41-42) | 0 | 0 | 0 | None | PURE_GATEWAY_POLICY | LOW | Config reader; retain |
| `gateway_timeout` | 2 (L45-46) | 0 | 0 | 0 | None | PURE_GATEWAY_POLICY | LOW | Config reader; retain |
| `_request` | 35 (L49-83) | 1 | 0 | 0 | `WhatsAppGatewayError` / `httpx.HTTPError` | GATEWAY_TRANSPORT | MEDIUM | Core HTTP client; retain |
| `health` | 2 (L90-91) | 1 (via `_request`) | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Retain |
| `list_sessions` | 3 (L94-96) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Retain (patch target in tests) |
| `create_session` | 2 (L99-100) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Payload helper extraction candidate |
| `get_session_status` | 3 (L103-105) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Retain |
| `get_session_qr` | 2 (L107-108) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Retain |
| `refresh_session_qr` | 2 (L111-112) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Retain |
| `request_pairing_code` | 3 (L115-117) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Payload helper extraction candidate |
| `logout_session` | 2 (L120-121) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Retain |
| `delete_session` | 2 (L124-125) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Retain |
| `_s` | 6 (L144-149) | 0 | 0 | 0 | `WhatsAppGatewayError` | PURE_GATEWAY_POLICY | LOW | Pure session prefix formatter; retain / reuse |
| `list_contacts` | 8 (L152-159) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Response normalizer extraction candidate |
| `list_conversations` | 14 (L162-175) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Query param builder extraction candidate |
| `sync_group_subjects` | 11 (L178-188) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Payload builder extraction candidate |
| `get_messages` | 22 (L191-212) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Query param builder extraction candidate |
| `request_older_history` | 22 (L215-236) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Payload builder extraction candidate |
| `list_all_messages` | 30 (L239-268) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Query param builder extraction candidate |
| `send_text_message` | 5 (L275-279) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Payload builder extraction candidate |
| `send_media_message` | 2 (L282-283) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Payload builder extraction candidate |
| `mark_conversation_read`| 2 (L286-287) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Retain |
| `send_typing` | 4 (L290-293) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW | Payload builder extraction candidate |
| `fetch_media` | 11 (L300-310) | 1 | 0 | 0 | `WhatsAppGatewayError` | GATEWAY_TRANSPORT | LOW-MED | Raw bytes retrieval; retain |

---

## 4. Forensic Audit Table: `whatsapp_service.py` Gateway-Bound Functions

Audited functions in `whatsapp_service.py` that invoke `gw.*`, parse gateway responses, or handle gateway errors:

| Function | Lines | Gateway Calls | DB Commits | Locks | Outbox | Classification | Risk | Phase 11.8 Strategy |
|---|---|---|---|---|---|---|---|---|
| `_is_gateway_session_missing` | 11 (L204-214) | 0 | 0 | 0 | No | PURE_GATEWAY_POLICY | LOW | **EXTRACT** to `gateway/errors.py` (pure regex/exception inspect) |
| `_apply_gateway_live` | 12 (L170-181) | 0 | 0 (in-memory) | 0 | No | GATEWAY_RESPONSE_NORMALIZER | LOW | **EXTRACT** field parser to `gateway/responses.py` |
| `_gateway_op_or_mark_relink` | 44 (L217-260) | op() | 1 (`commit`) | 0 | No | TRANSACTION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE** (Rule 7: YASAK EXTRACTION) |
| `_list_sessions_internal` | 51 (L267-317) | `gw.list_sessions` | 1 (`commit`) | 0 | No | SESSION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE**; use normalized response parser |
| `create_session` | 20 (L364-383) | `gw.create_session` | 1 (`commit`) | 0 | No | SESSION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE**; use `extract_session_id` |
| `get_session_qr` | 11 (L391-401) | `gw.get_session_qr` | 1 (`commit`) | 0 | No | SESSION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE** (Rule 7) |
| `refresh_session_qr` | 10 (L404-413) | `gw.refresh_session_qr` | 1 (`commit`) | 0 | No | SESSION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE** (Rule 7) |
| `request_pairing_code` | 21 (L416-436) | `gw.request_pairing_code` | 1 (`commit`) | 0 | No | SESSION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE** (Rule 7); use `extract_pairing_code` |
| `logout_session` | 20 (L439-458) | `gw.logout_session` | 1 (`commit`) | 0 | No | SESSION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE** (Rule 7); use `is_gateway_session_missing` |
| `delete_session` | 27 (L538-564) | `gw.delete_session` | 1 (`commit`) | 0 | No | SESSION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE** (Rule 7) |
| `sync_contacts` | 33 (L572-604) | `gw.list_contacts` | 1 (`commit`) | 0 | No | SESSION_ORCHESTRATOR | HIGH | **RETAIN IN SERVICE** (Rule 7) |
| `_sync_conversations_impl` | 111 (L1133-1243) | `gw.list_conversations`, `gw.get_messages`, `gw.sync_group_subjects` | 1 (`commit`) | 0 | No | DEFERRED | HIGH | **RETAIN IN SERVICE** (Rule 7) |
| `_hydrate_messages_on_demand` | 100 (L1432-1531) | `gw.get_messages` | 1 (`commit`) | 0 | No | DEFERRED | HIGH | **RETAIN IN SERVICE** |
| `send_text_message` | 59 (L1664-1722) | `gw.send_text_message` | 2 (`commit`) | 1 (`_conv_lock`) | No | OUTBOUND_ORCHESTRATOR | CRITICAL | **RETAIN IN SERVICE** (Rule 7); use `build_send_text_payload` |
| `send_media_message` | 67 (L1725-1791) | `gw.send_media_message` | 2 (`commit`) | 1 (`_conv_lock`) | No | OUTBOUND_ORCHESTRATOR | CRITICAL | **RETAIN IN SERVICE** (Rule 7); use `build_send_media_payload` |
| `mark_conversation_read` | 32 (L1794-1825) | `gw.mark_conversation_read` | 1 (`commit`) | 0 | No | DEFERRED | MEDIUM | **RETAIN IN SERVICE** |
| `send_typing` | 11 (L1828-1838) | `gw.send_typing` | 0 | 0 | No | DEFERRED | LOW-MED | **RETAIN IN SERVICE**; use `build_typing_payload` |
| `get_media_bytes` | 20 (L1841-1860) | `gw.fetch_media` | 0 | 0 | No | DEFERRED | LOW | **RETAIN IN SERVICE** |
| `_bulk_channel_available` | 23 (L1982-2004) | `gw.list_all_messages` | 0 | 0 | No | DEFERRED | LOW | **RETAIN IN SERVICE** |
| `_run_sync_job` | 172 (L2131-2302) | `gw.list_conversations` | Multiple | 0 | No | DEFERRED | HIGH | **RETAIN IN SERVICE** (Rule 7) |
| `_run_bulk_message_sync` | 155 (L2403-2557) | `gw.list_all_messages` | Multiple | 0 | No | DEFERRED | HIGH | **RETAIN IN SERVICE** (Rule 7) |
| `ingest_gateway_event` | 111 (L2751-2861) | 0 | Multiple | 0 | Yes | EVENT_ORCHESTRATOR | CRITICAL | **RETAIN IN SERVICE** (Rule 7) |

---

## 5. Forensic Audit Table: `endpoints/whatsapp.py` Error Handlers

| Function | Lines | Purpose | HTTP Status | Detail Sanitization | Classification | Risk | Phase 11.8 Strategy |
|---|---|---|---|---|---|---|---|
| `_not_found` | 2 (L41-42) | Transforms exception to 404 | 404 | Passes exception str | GATEWAY_RESPONSE_NORMALIZER | LOW | Endpoint-level helper; retain |
| `_no_session` | 10 (L45-56) | Transforms `NoWhatsAppSession` to 409 | 409 | Static user guidance | GATEWAY_RESPONSE_NORMALIZER | LOW | Endpoint-level helper; retain |
| `_bad_gateway` | 10 (L58-69) | Transforms `WhatsAppGatewayError` to 502 | 502 | Sanitized message (no internal leak) | GATEWAY_RESPONSE_NORMALIZER | LOW | Endpoint-level helper; retain |
| `_relink_required` | 7 (L71-77) | Transforms `WhatsAppRelinkRequired` to 409 | 409 | Sets `X-WhatsApp-State` header | GATEWAY_RESPONSE_NORMALIZER | LOW | Endpoint-level helper; retain |

---

## 6. Identification of Pure Extraction Targets

Following the mandate of Phase 11.8 (strictly zero transaction/lock moving, zero empty files), the audit identifies three cohesive, pure boundary modules under `backend/app/services/whatsapp/gateway/`:

### 6.1 `backend/app/services/whatsapp/gateway/payloads.py`
**Classification**: `GATEWAY_PAYLOAD_BUILDER`  
**Properties**: Pure functions, deterministic dict construction, zero DB/I/O access.  
- `build_send_text_payload(body: str, client_message_id: Optional[str] = None) -> Dict[str, Any]`
- `build_send_media_payload(media: Dict[str, Any]) -> Dict[str, Any]`
- `build_typing_payload(typing: bool = True, duration_ms: int = 4000) -> Dict[str, Any]`
- `build_pairing_code_payload(phone: str) -> Dict[str, Any]`
- `build_create_session_payload(name: str) -> Dict[str, Any]`
- `build_history_request_payload(...) -> Dict[str, Any]`
- `build_sync_groups_payload(force: bool = False) -> Dict[str, Any]`
- `build_messages_query_params(...) -> Dict[str, Any]`
- `build_bulk_messages_query_params(...) -> Dict[str, Any]`
- `build_conversations_query_params(...) -> Dict[str, Any]`

### 6.2 `backend/app/services/whatsapp/gateway/responses.py`
**Classification**: `GATEWAY_RESPONSE_NORMALIZER`  
**Properties**: Pure functions, extracts fields safely from gateway responses, zero DB mutations.  
- `extract_session_id(gw_session: Dict[str, Any]) -> Optional[str]`
- `extract_pairing_code(data: Dict[str, Any]) -> Optional[str]`
- `extract_live_session_fields(data: Dict[str, Any]) -> Dict[str, Any]` (Extracts `status`, `phone`, `error_message`, `is_phone_online`, `battery_level`, `qr_code`, `sync`)
- `extract_send_result(gateway_result: Dict[str, Any]) -> Dict[str, Any]` (Extracts `wa_message_id`, `status`)
- `normalize_contacts_payload(data: Any) -> List[Dict[str, Any]]`
- `normalize_sessions_payload(data: Any) -> List[Dict[str, Any]]`

### 6.3 `backend/app/services/whatsapp/gateway/errors.py`
**Classification**: `PURE_GATEWAY_POLICY`  
**Properties**: Pure error classification and pattern matching, zero DB access, zero side effects.  
- `is_gateway_session_missing(exc: Exception) -> bool`: Canonical extraction of `_is_gateway_session_missing`.
- `is_gateway_unavailable(exc: Exception) -> bool`: Pure detection of connection timeouts, connection refused, or HTTP 502/503/504.
- `classify_gateway_error(exc: Exception) -> str`: Categorizes errors into `SESSION_NOT_FOUND`, `UNAVAILABLE`, `TIMEOUT`, `UNAUTHORIZED`, `CONFLICT`, `MALFORMED_RESPONSE`, or `UNKNOWN_ERROR`.
- `format_safe_gateway_error(exc: Exception) -> str`: PII-safe and internal-network-safe error string.

---

## 7. Deferred Items Justification

As explicitly enforced by Section 7 of the specification:
- `send_text_message` & `send_media_message`: Contains multi-stage commit (`PENDING` -> dispatch -> `SENT`/`FAILED`), `_conversation_locks`, and status advancement.
- `_gateway_op_or_mark_relink`: Manages DB session commits and WebSocket broadcasts when relink is detected.
- `create_session`, `logout_session`, `delete_session`: Manages DB session lifecycle, tenant user scoping, and commits.
- `_run_sync_job` & `_run_bulk_message_sync`: Background async jobs with complex watermark tracking, chunking, and multiple transaction checkpoints.
- `ingest_gateway_event`: Inbound WebSocket event bridge with distributed idempotency, outbox coordination, and cross-session entity hydration.

All above items are **DEFERRED** to subsequent dedicated phases.

---

## 8. Implementation Plan by Batches

- **Batch 1**: Extract `payloads.py` and `responses.py` under `backend/app/services/whatsapp/gateway/`.
- **Batch 2**: Extract `errors.py` under `backend/app/services/whatsapp/gateway/`.
- **Batch 3**: Wire `whatsapp_service.py` and `whatsapp_gateway.py` to use the gateway boundary modules with backward compatibility aliases.
- **Characterization Testing**: Build `backend/tests/test_whatsapp_gateway_boundary.py` covering all payload builders, response parsers, and error classifiers across HTTP status codes, timeouts, malformed bodies, and edge cases.
