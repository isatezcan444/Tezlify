# Phase 11.9 — WhatsApp Orchestration Boundary Forensic Audit

**Document Status**: COMPLETE & VERIFIED  
**Phase**: 11.9 — WhatsApp Orchestration Boundary & Coordinator Decomposition  
**Target File**: `backend/app/services/whatsapp_service.py` (3,346 lines, 57 functions)  

---

## 1. Executive Summary

Phases 11.6 to 11.8 decomposed:
- Pure identity, preview normalization, and status policy (`backend/app/services/whatsapp/`)
- Database persistence and read-only entity lookups (`backend/app/services/whatsapp/repositories/`)
- Gateway transport payload builders, response parsers, and error classification (`backend/app/services/whatsapp/gateway/`)

`whatsapp_service.py` currently contains 57 functions and coordinates:
1. **Session Lifecycle & QR/Pairing**: Tenant session operations, durable gateway link health, relink detection.
2. **Outbound Messaging**: Optimistic persistence (`PENDING`), locks, gateway dispatch, status advancement to `SENT` or `FAILED`.
3. **Contact & Conversation Ingestion**: Contact upserts, name ranking, conversation creation with savepoints (`begin_nested`).
4. **Sync & History Expansion**: Initial sync, bulk history streaming, delta syncing, and background watermark workers.
5. **Inbound Event Processing**: Gateway WebSocket ingestion, processed event deduplication, outbox coordination, and WebSocket client broadcasting.

The objective of Phase 11.9 is to decompose these into cohesive domain orchestration modules under `backend/app/services/whatsapp/orchestration/`, leaving `whatsapp_service.py` as the clean public facade.

---

## 2. Invariants & Strict Protections

| Invariant | Protection Rule |
|---|---|
| **Transaction Semantics** | Commit and rollback sequences (`PENDING` $\rightarrow$ dispatch $\rightarrow$ `SENT`/`FAILED`) are immutable. Savepoint isolation (`begin_nested()`) for collisions must remain intact. |
| **Lock Ownership** | `_conversation_locks` and `_sync_lock` must remain in their exact acquisition order. Zero new global locks. |
| **Outbox & ACK/NACK** | Outbox states (`PENDING`, `IN_FLIGHT`, `DELIVERED`, `DEAD_LETTER`) and gateway ACK/NACK timing remain 100% unchanged. |
| **Baileys Gateway** | `whatsapp-gateway/src/session-manager.js` is strictly read-only. Zero protocol changes. |
| **Public API Facade** | All public functions in `whatsapp_service.py` must retain identical signatures and return types for endpoints and tests. |
| **Fail-Closed Semantics** | If gateway or backend is unreachable, operations raise exceptions; zero false-positive success. |

---

## 3. Comprehensive Function Classification & Risk Audit

| Method | Line Range | Lines | Repositories Called | Gateway Called | Commits | Rollbacks | Savepoints | Locks | Outbox | WS / Broadcast | Session Mutated | Background Task | API Caller? | Classification | Risk | Target Phase 11.9 Action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `_get_conversation_lock` | L84-90 | 7 | None | None | 0 | 0 | 0 | 1 | No | No | No | No | No | SHARED_ORCHESTRATION | LOW | Shared lock registry helper |
| `_serialize_message` | L114-138 | 25 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | No | SHARED_ORCHESTRATION | LOW | Extract to `messaging.py` / shared |
| `_session_dict` | L141-154 | 14 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | No | SESSION_ORCHESTRATION | LOW | Extract to `sessions.py` |
| `_apply_gateway_live` | L178-188 | 11 | None | None | 0 | 0 | 0 | 0 | No | No | Yes | No | No | SESSION_ORCHESTRATION | LOW | Extract to `sessions.py` |
| `_gateway_op_or_mark_relink` | L212-255 | 44 | `WhatsAppSession` | lambda op | 1 | 0 | 0 | 0 | No | Yes | Yes | No | No | SESSION_ORCHESTRATION | MEDIUM | Extract to `sessions.py` |
| `_list_sessions_internal` | L262-308 | 47 | `WhatsAppSession` | `list_sessions` | 1 | 0 | 0 | 0 | No | No | Yes | No | No | SESSION_ORCHESTRATION | MEDIUM | Extract to `sessions.py` |
| `list_sessions` | L311-313 | 3 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | Yes | PUBLIC_FACADE | LOW | Facade delegation to `sessions.py` |
| `get_sync_status` | L316-352 | 37 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | Yes | SYNC_ORCHESTRATION | LOW | Extract to `sync.py` |
| `create_session` | L355-374 | 20 | `WhatsAppSession` | `create_session` | 1 | 0 | 0 | 0 | No | No | Yes | No | Yes | SESSION_ORCHESTRATION | LOW-MED | Extract to `sessions.py` |
| `get_session_qr` | L382-392 | 11 | `WhatsAppSession` | `get_session_qr` | 1 | 0 | 0 | 0 | No | No | Yes | No | Yes | SESSION_ORCHESTRATION | LOW-MED | Extract to `sessions.py` |
| `refresh_session_qr` | L395-404 | 10 | `WhatsAppSession` | `refresh_session_qr` | 1 | 0 | 0 | 0 | No | No | Yes | No | Yes | SESSION_ORCHESTRATION | LOW-MED | Extract to `sessions.py` |
| `request_pairing_code` | L407-427 | 21 | `WhatsAppSession` | `request_pairing_code` | 1 | 0 | 0 | 0 | No | No | Yes | No | Yes | SESSION_ORCHESTRATION | LOW-MED | Extract to `sessions.py` |
| `logout_session` | L430-449 | 20 | `WhatsAppSession` | `logout_session` | 1 | 0 | 0 | 0 | No | No | Yes | No | Yes | SESSION_ORCHESTRATION | LOW-MED | Extract to `sessions.py` |
| `purge_whatsapp_data` | L452-526 | 75 | Multiple models | None | 0 | 0 | 0 | 0 | No | No | Yes | No | No | SESSION_ORCHESTRATION | MEDIUM | Extract to `sessions.py` |
| `delete_session` | L529-555 | 27 | `WhatsAppSession` | `delete_session` | 1 | 0 | 0 | 0 | No | No | Yes | No | Yes | SESSION_ORCHESTRATION | LOW-MED | Extract to `sessions.py` |
| `sync_contacts` | L563-595 | 33 | `WhatsAppSession` | `list_contacts` | 1 | 0 | 0 | 0 | No | No | No | No | Yes | CONVERSATION_ORCHESTRATION | MEDIUM | Extract to `sync.py` / `conversations.py` |
| `_bulk_upsert_contacts` | L599-694 | 96 | `Contact` | None | 0 | 0 | 1 | 0 | No | No | No | No | No | CONVERSATION_ORCHESTRATION | HIGH | Retain or move to `conversations.py` |
| `_ensure_conversations_bulk` | L697-807 | 111 | `Conversation` | None | 0 | 0 | 1 | 0 | No | No | No | No | No | CONVERSATION_ORCHESTRATION | HIGH | Retain or move to `conversations.py` |
| `_upsert_contact` | L810-880 | 71 | `Contact` | None | 0 | 0 | 1 | 0 | No | No | No | No | No | CONVERSATION_ORCHESTRATION | HIGH | Retain or move to `conversations.py` |
| `_ensure_conversation` | L889-953 | 65 | `Conversation` | None | 0 | 0 | 0 | 0 | No | No | No | No | No | CONVERSATION_ORCHESTRATION | MEDIUM | Retain / delegate |
| `_ensure_conversation_race_safe` | L956-991 | 36 | `Conversation` | None | 0 | 1 | 0 | 0 | No | No | No | No | No | CONVERSATION_ORCHESTRATION | HIGH | Retain / delegate |
| `_persist_gateway_message` | L997-1030 | 34 | `Message` | None | 0 | 0 | 0 | 0 | No | No | No | No | No | SHARED_ORCHESTRATION | LOW | Retain / delegate |
| `_repair_last_message_previews` | L1033-1095 | 63 | `Conversation` | None | 0 | 0 | 0 | 0 | No | No | No | No | No | CONVERSATION_ORCHESTRATION | LOW-MED | Retain / delegate |
| `sync_conversations` | L1106-1121 | 16 | `WhatsAppSession` | None | 0 | 0 | 0 | 0 | No | No | No | No | No | SYNC_ORCHESTRATION | MEDIUM | Delegate to `sync.py` |
| `_sync_conversations_impl` | L1124-1234 | 111 | `Conversation`, `Message` | `list_conversations`, `get_messages`, `sync_group_subjects` | 1 | 0 | 0 | 0 | No | No | No | No | No | SYNC_ORCHESTRATION | HIGH | Retain / extract to `sync.py` |
| `list_conversations` | L1237-1415 | 179 | `Conversation`, `Contact` | None | 0 | 0 | 0 | 0 | No | No | No | No | Yes | CONVERSATION_ORCHESTRATION | MEDIUM | Facade / extract to `conversations.py` |
| `_hydrate_messages_on_demand` | L1423-1522 | 100 | `Message` | `get_messages` | 1 | 0 | 0 | 0 | No | No | No | No | No | HISTORY_ORCHESTRATION | HIGH | Retain / extract to `sync.py` |
| `get_messages` | L1529-1649 | 121 | `Message` | None | 0 | 0 | 0 | 1 | No | No | No | Yes | Yes | HISTORY_ORCHESTRATION | MEDIUM | Facade / extract to `messaging.py` |
| `send_text_message` | L1655-1714 | 60 | `Conversation`, `Message` | `send_text_message` | 3 | 0 | 0 | 1 | No | No | No | No | Yes | OUTBOUND_MESSAGE_ORCHESTRATION | HIGH | Extract to `messaging.py` |
| `send_media_message` | L1717-1784 | 68 | `Conversation`, `Message` | `send_media_message` | 3 | 0 | 0 | 1 | No | No | No | No | Yes | MEDIA_ORCHESTRATION | HIGH | Extract to `messaging.py` |
| `mark_conversation_read` | L1787-1818 | 32 | `Conversation` | `mark_conversation_read` | 1 | 0 | 0 | 0 | No | No | No | No | Yes | OUTBOUND_MESSAGE_ORCHESTRATION | LOW-MED | Extract to `messaging.py` |
| `send_typing` | L1821-1831 | 11 | `WhatsAppSession` | `send_typing` | 0 | 0 | 0 | 0 | No | No | No | No | Yes | OUTBOUND_MESSAGE_ORCHESTRATION | LOW | Extract to `messaging.py` |
| `get_media_bytes` | L1834-1853 | 20 | `Conversation` | `fetch_media` | 0 | 0 | 0 | 0 | No | No | No | No | Yes | MEDIA_ORCHESTRATION | LOW | Extract to `messaging.py` |
| `_schedule_chats_bootstrap` | L1896-1917 | 22 | None | None | 0 | 0 | 0 | 0 | No | No | No | Yes | No | SYNC_ORCHESTRATION | LOW | Extract to `sync.py` |
| `_bulk_channel_available` | L1975-1997 | 23 | None | `list_all_messages` | 0 | 0 | 0 | 0 | No | No | No | No | No | SYNC_ORCHESTRATION | LOW | Extract to `sync.py` |
| `_broadcast_sync_event` | L2000-2017 | 18 | None | None | 0 | 0 | 0 | 0 | No | Yes | No | No | No | SYNC_ORCHESTRATION | LOW | Extract to `sync.py` |
| `_sync_event` | L2020-2022 | 3 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | No | SYNC_ORCHESTRATION | LOW | Extract to `sync.py` |
| `request_sync` | L2025-2038 | 14 | None | None | 0 | 0 | 0 | 0 | No | No | No | Yes | Yes | SYNC_ORCHESTRATION | LOW | Facade / extract to `sync.py` |
| `get_sync_job` | L2041-2044 | 4 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | Yes | SYNC_ORCHESTRATION | LOW | Facade / extract to `sync.py` |
| `_cancel_stale_sync_jobs` | L2047-2055 | 9 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | No | SYNC_ORCHESTRATION | LOW | Extract to `sync.py` |
| `_reapply_chat_names` | L2058-2101 | 44 | `Conversation`, `Contact` | None | 1 | 0 | 0 | 0 | No | No | No | No | No | SYNC_ORCHESTRATION | MEDIUM | Extract to `sync.py` |
| `_schedule_metadata_enrichment` | L2107-2120 | 14 | None | `sync_group_subjects` | 0 | 0 | 0 | 0 | No | No | No | Yes | No | SYNC_ORCHESTRATION | LOW | Extract to `sync.py` |
| `_run_sync_job` | L2124-2295 | 172 | Multiple | `list_conversations` | 1 | 0 | 0 | 0 | No | Yes | No | Yes | No | SYNC_ORCHESTRATION | HIGH | Extract to `sync.py` |
| `_persist_chat_snapshot` | L2303-2390 | 88 | `Conversation` | None | 1 | 0 | 0 | 0 | No | No | No | No | No | SYNC_ORCHESTRATION | MEDIUM | Extract to `sync.py` |
| `_run_bulk_message_sync` | L2396-2550 | 155 | `Message` | `list_all_messages` | 1 | 0 | 0 | 0 | No | Yes | No | Yes | No | SYNC_ORCHESTRATION | HIGH | Extract to `sync.py` |
| `_schedule_initial_sync` | L2564-2571 | 8 | None | None | 0 | 0 | 0 | 0 | No | No | No | Yes | No | SYNC_ORCHESTRATION | LOW | Extract to `sync.py` |
| `_run_initial_sync` | L2574-2603 | 30 | None | None | 0 | 0 | 0 | 0 | No | No | No | Yes | No | SYNC_ORCHESTRATION | LOW-MED | Extract to `sync.py` |
| `_run_background_history_expansion` | L2610-2662 | 53 | `Message` | None | 0 | 0 | 0 | 0 | No | No | No | Yes | No | HISTORY_ORCHESTRATION | MEDIUM | Extract to `sync.py` |
| `_passthrough_event` | L2684-2697 | 14 | `WhatsAppSession` | None | 0 | 0 | 0 | 0 | No | No | No | No | No | INBOUND_EVENT_ORCHESTRATION | LOW | Extract to `events.py` |
| `_skip_event` | L2700-2710 | 11 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | No | INBOUND_EVENT_ORCHESTRATION | LOW | Extract to `events.py` |
| `_log_orphan_event` | L2720-2740 | 21 | None | None | 0 | 0 | 0 | 0 | No | No | No | No | No | INBOUND_EVENT_ORCHESTRATION | LOW | Extract to `events.py` |
| `ingest_gateway_event` | L2744-2854 | 111 | Multiple | None | 1 | 0 | 0 | 0 | Yes | Yes | Yes | Yes | No | INBOUND_EVENT_ORCHESTRATION | CRITICAL | Extract to `events.py` / coordinator |
| `_ingest_message` | L2857-2979 | 123 | `Conversation`, `Message` | None | 1 | 0 | 0 | 1 | Yes | Yes | No | No | No | INBOUND_EVENT_ORCHESTRATION | CRITICAL | Extract to `events.py` |
| `_ingest_contact_synced` | L2992-3039 | 48 | `Contact`, `Conversation` | None | 2 | 0 | 0 | 0 | No | Yes | No | No | No | INBOUND_EVENT_ORCHESTRATION | MEDIUM | Extract to `events.py` |
| `reconcile_legacy_split_conversation` | L3042-3125 | 84 | `Conversation`, `Message` | None | 1 | 0 | 0 | 1 | No | No | No | No | No | INBOUND_EVENT_ORCHESTRATION | HIGH | Extract to `events.py` |
| `_map_conversation_event` | L3131-3291 | 161 | `Conversation` | None | 3 | 0 | 0 | 0 | No | Yes | No | No | No | INBOUND_EVENT_ORCHESTRATION | HIGH | Extract to `events.py` |
| `_map_session_event` | L3294-3346 | 53 | `WhatsAppSession` | None | 0 | 0 | 0 | 0 | No | No | Yes | No | No | INBOUND_EVENT_ORCHESTRATION | MEDIUM | Extract to `events.py` |

---

## 4. Proposed Modular Orchestration Architecture

```text
backend/app/services/whatsapp/
├── __init__.py
├── exceptions.py
├── identity.py
├── preview_normalization.py
├── status_policy.py
├── repositories/
│   ├── __init__.py
│   ├── contacts.py
│   ├── conversations.py
│   ├── messages.py
│   └── sessions.py
├── gateway/
│   ├── __init__.py
│   ├── payloads.py
│   ├── responses.py
│   └── errors.py
└── orchestration/                         [NEW Phase 11.9]
    ├── __init__.py                        Public coordinator barrel
    ├── sessions.py                        Tenant session lifecycle, QR/pairing, relink recovery
    ├── messaging.py                       Outbound messaging, locks, media dispatch, typing
    ├── sync.py                            Sync jobs, watermarks, history expansion, background workers
    └── events.py                          Inbound gateway event bridge, ACK/NACK, outbox & WS broadcast
```

### Phased Execution Strategy (Max 3 Batches)

1. **Batch 1: Session Orchestrator (`orchestration/sessions.py`)**:
   - `create_session`, `get_session_qr`, `refresh_session_qr`, `request_pairing_code`, `logout_session`, `delete_session`, `purge_whatsapp_data`, `_list_sessions_internal`, `_gateway_op_or_mark_relink`, `_apply_gateway_live`, `_session_dict`.
   - Characterization tests in `test_whatsapp_orchestration_sessions.py`.
   - Wire `whatsapp_service.py` to delegate to `sessions.py`.

2. **Batch 2: Outbound Messaging & Media (`orchestration/messaging.py`)**:
   - `send_text_message`, `send_media_message`, `send_typing`, `mark_conversation_read`, `get_media_bytes`, `_serialize_message`.
   - Retain `_conversation_locks` safely in service layer or shared lock holder.
   - Characterization tests in `test_whatsapp_orchestration_messaging.py`.
   - Wire `whatsapp_service.py` to delegate to `messaging.py`.

3. **Batch 3: Sync & Inbound Events (`orchestration/sync.py` & `orchestration/events.py`)**:
   - `get_sync_status`, `request_sync`, `get_sync_job`, `_run_sync_job`, `_run_bulk_message_sync`, `_schedule_initial_sync`, `_run_initial_sync`.
   - `ingest_gateway_event`, `_ingest_message`, `_ingest_contact_synced`, `_map_conversation_event`, `_map_session_event`, `_passthrough_event`, `_skip_event`, `_log_orphan_event`, `reconcile_legacy_split_conversation`.
   - Wire facade in `whatsapp_service.py`.

---

## 5. Risk Mitigation & Verification Gates

After every batch:
1. `python3 -m compileall backend/app`
2. `PYTHONPATH=. pytest backend/tests/ -q` (must match or exceed 808 tests)
3. `npm --prefix frontend run build`
4. Gateway suite: 15/15 PASS (89 assertions)
5. Circular dependencies: 0 cycles
