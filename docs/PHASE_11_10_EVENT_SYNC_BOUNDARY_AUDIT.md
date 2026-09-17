# Phase 11.10 — WhatsApp Inbound Event & Sync Boundary Audit

## 1. Executive Summary

This forensic audit classifies all 45 remaining functions in `backend/app/services/whatsapp_service.py` following the extraction of pure policies (Phase 11.6), persistence repositories (Phase 11.7), gateway boundaries (Phase 11.8), and session/messaging orchestration (Phase 11.9).

The two primary remaining responsibility domains are:
1. **Inbound Gateway Event Ingestion** (`ingest_gateway_event`, `_ingest_message`, event mappers)
2. **Sync & History Orchestration** (`_run_sync_job`, `_persist_chat_snapshot`, `_run_bulk_message_sync`, `_hydrate_messages_on_demand`, `get_messages`)

---

## 2. Forensic AST Inventory

| Function Name | Lines | Callers | Repo Dependencies | Gateway Calls | Tx (Commit/Rollback/Savepoint) | Lock Usage | Outbox / Dedup | WS Broadcast | Risk Level | Target Recommendation |
|---|---|---|---|---|---|---|---|---|---|---|
| `_get_conversation_lock` | 100-106 | `get_messages`, `reconcile` | None | None | None | `_conversation_locks` | None | None | LOW | Keep in facade / shared lock store |
| `get_sync_status` | 178-214 | API `/sync/status` | `sessions` | None | None | None | None | None | LOW | Facade delegate |
| `delete_session` | 222-225 | API `/sessions/{id}` | `orchestration.sessions` | None | None | None | None | None | LOW | Facade delegate |
| `sync_contacts` | 233-265 | Sync job | `contacts`, `conversations` | `gw.fetch_contacts` | Commit | None | None | None | MEDIUM | Sync Coordinator helper |
| `_bulk_upsert_contacts` | 269-364 | `sync_contacts` | `contacts` | None | Savepoint (`begin_nested`) | None | None | WS | MEDIUM | Sync Coordinator helper |
| `_ensure_conversations_bulk` | 367-477 | Sync snapshot | `conversations` | None | Savepoint (`begin_nested`) | None | None | None | MEDIUM | Sync Coordinator helper |
| `_upsert_contact` | 480-550 | Inbound message | `contacts` | None | Savepoint (`begin_nested`) | None | None | WS | MEDIUM | Event Coordinator helper |
| `_ensure_conversation` | 559-623 | Inbound message | `conversations` | None | None | None | None | None | LOW | Event Coordinator helper |
| `_ensure_conversation_race_safe`| 626-661 | Inbound message | `conversations` | None | Rollback | None | None | None | MEDIUM | Event Coordinator helper |
| `_persist_gateway_message` | 667-700 | Inbound message | `messages` | None | None | None | None | WS | LOW | Event Coordinator helper |
| `_repair_last_message_previews` | 703-765 | Sync completion | `conversations`, `messages` | None | None | None | None | None | LOW | Sync Coordinator helper |
| `sync_conversations` | 776-791 | API `/conversations?sync` | `sessions` | None | None | None | None | None | LOW | Facade delegate |
| `_sync_conversations_impl` | 794-904 | Legacy sync | `conversations`, `sessions` | `gw.list_conversations` | Commit | None | None | WS | HIGH | Legacy fallback / Sync |
| `list_conversations` | 907-1085 | API `/conversations` | `conversations` | None | None | None | None | WS | MEDIUM | Conversation Query Facade |
| `_hydrate_messages_on_demand` | 1093-1192| `get_messages` | `messages`, `conversations` | `gw.fetch_chat_messages`| Commit | None | None | None | HIGH | History / Pagination Core |
| `get_messages` | 1199-1319| API `/messages` | `messages`, `conversations` | None | None | `_conversation_locks` | In-flight Future dedupe | None | HIGH | Read-path / Keyset pagination |
| `send_text_message` | 1325-1328| API `/messages/send` | `orchestration.messaging` | None | None | None | None | None | LOW | Facade delegate |
| `send_media_message` | 1331-1334| API `/messages/media` | `orchestration.messaging` | None | None | None | None | None | LOW | Facade delegate |
| `mark_conversation_read` | 1337-1338| API `/read` | `orchestration.messaging` | None | None | None | None | None | LOW | Facade delegate |
| `send_typing` | 1341-1342| API `/typing` | `orchestration.messaging` | None | None | None | None | None | LOW | Facade delegate |
| `get_media_bytes` | 1345-1346| API `/media/{id}` | `orchestration.messaging` | None | None | None | None | None | LOW | Facade delegate |
| `_schedule_chats_bootstrap` | 1390-1411| Inbound live stream | None | None | None | None | None | WS (throttled) | LOW | Shared WS streamer |
| `_bulk_channel_available` | 1469-1491| Sync job | None | `gw.test_bulk_messages` | None | None | None | None | LOW | Sync probe |
| `_broadcast_sync_event` | 1494-1511| Sync stages | None | None | None | None | None | WS (`whatsapp_sync_*`) | LOW | Sync streamer |
| `_sync_event` | 1514-1516| Sync job | None | None | None | None | None | None | LOW | Pure event formatter |
| `request_sync` | 1519-1532| API `/sync` | None | None | None | None | None | None | LOW | Sync job starter |
| `get_sync_job` | 1535-1538| API `/sync/status` | None | None | None | None | None | None | LOW | Sync job reader |
| `_cancel_stale_sync_jobs` | 1541-1549| Session delete | None | None | None | None | None | None | LOW | Sync cleanup |
| `_reapply_chat_names` | 1552-1595| Sync chats phase | `contacts` | None | Commit | None | None | None | MEDIUM | Sync contact rank tie-break |
| `_schedule_metadata_enrichment` | 1601-1614| Sync groups | None | `gw.sync_group_subjects`| None | None | None | None | LOW | Async background task |
| `_run_sync_job` | 1618-1789| Background task | `sessions`, `conversations` | `gw.list_conversations` | Commit | None | Watermark tracking | WS | HIGH | Sync Job Coordinator |
| `_persist_chat_snapshot` | 1797-1884| Sync chats | `conversations` | None | Commit | None | None | WS | MEDIUM | Sync Snapshot handler |
| `_run_bulk_message_sync` | 1890-2044| Sync messages | `messages`, `conversations` | `gw.fetch_all_messages` | Commit | None | Watermark / Dedup | WS | HIGH | Sync Bulk Hydrator |
| `_schedule_initial_sync` | 2058-2065| Session connect | None | None | None | None | None | None | LOW | Inbound event trigger |
| `_run_initial_sync` | 2068-2097| Background task | None | None | None | None | None | None | MEDIUM | Inbound event trigger |
| `_run_background_history_expansion` | 2104-2156| Background task | `messages`, `conversations` | `gw.fetch_chat_messages`| None | `_conversation_locks` | Keyset cursor | None | HIGH | History Expansion Task |
| `_passthrough_event` | 2178-2191| Inbound router | `conversations` | None | None | None | None | WS | LOW | Event Coordinator helper |
| `_skip_event` | 2194-2204| Inbound router | None | None | None | None | None | None | LOW | Event Coordinator helper |
| `_log_orphan_event` | 2214-2234| Inbound router | None | None | None | None | None | None | LOW | Event Coordinator helper |
| `ingest_gateway_event` | 2238-2348| `/ws/gateway` | `sessions` | None | Commit + Rollback | None | `processed_events` SQL | WS | CRITICAL | Inbound Event Switchboard |
| `_ingest_message` | 2351-2473| Inbound router | `messages`, `contacts`, `convs`| None | Commit | None | Msg ID deduplication | WS | CRITICAL | Message Ingress Processor |
| `_ingest_contact_synced` | 2486-2533| Inbound router | `contacts` | None | Commit | None | Contact avatar update | WS | MEDIUM | Contact Ingress Processor |
| `reconcile_legacy_split_conversation` | 2536-2619| Inbound message | `conversations`, `messages`| None | Commit | `_conversation_locks` (dual) | Identity merge | WS | HIGH | Split Conversation Healer |
| `_map_conversation_event` | 2625-2785| Inbound router | `conversations` | None | Commit | None | Preview & unread update | WS | HIGH | Conversation Ingress Processor |
| `_map_session_event` | 2788-2840| Inbound router | `sessions` | None | None | None | Session status transition | WS | MEDIUM | Session Ingress Processor |

---

## 3. Inbound Gateway Event Ingress Sequence

The strict invariant lifecycle for inbound gateway events across Baileys gateway and FastAPI backend:

```text
Baileys Gateway Event (/ws/gateway)
    │
    ▼ [GATEWAY_EVENT_DECODE]
    JSON payload deserialization & event type extraction
    │
    ▼ [EVENT_AUTH / SESSION_RESOLUTION]
    resolve_event_owner_and_session(db, event)
    (Fail-closed: raises EventOwnerUnresolved on orphan/unpaired sessions -> tx rollback)
    │
    ▼ [EVENT_IDEMPOTENCY]
    INSERT INTO whatsapp_private.processed_events (event_id) ON CONFLICT DO NOTHING
    │
    ▼ [ENTITY_HYDRATION & PERSISTENCE]
    Dispatch based on event type:
    ├── message_new / message_upsert:
    │     ├── Check message wa_message_id existence (Deduplication)
    │     ├── Resolve contact (upsert_contact)
    │     ├── Resolve conversation race-safe (_ensure_conversation_race_safe)
    │     ├── Reconcile split conversations if LID vs Phone JID mismatch (Acquire dual conversation locks)
    │     ├── Persist Message row with status RECEIVED (or update PENDING -> SENT if fromMe echo)
    │     └── Update conversation last_message preview & unread count
    ├── contact_synced:
    │     └── Upsert contact name rank & avatar URL
    ├── conversation_updated:
    │     └── Update unread count, timestamp, and name preview
    ├── session_connecting / session_connected / session_disconnected / session_qr_updated:
    │     └── Map session state & phone identity
    └── presence / typing / labels:
          └── Passthrough event mapping to numeric conversation ID
    │
    ▼ [OUTBOX & TRANSACTION COMMIT]
    await db.commit()
    │
    ▼ [ACK / NACK]
    Send ACK to gateway (or discard on idempotency hit)
    │
    ▼ [WEBSOCKET BROADCAST]
    ws_manager.broadcast to tenant WebSocket clients
```

---

## 4. Sync & History Orchestration Classification

1. **`SYNC_JOB_ORCHESTRATION`**:
   - `request_sync`, `get_sync_job`, `_cancel_stale_sync_jobs`, `_run_sync_job`, `_schedule_initial_sync`.
   - Manages state machine: `IDLE` -> `STARTED` -> `CHATS` -> `CONTACTS` -> `MESSAGES` -> `COMPLETED`/`FAILED`.
2. **`CONVERSATION_SNAPSHOT`**:
   - `_persist_chat_snapshot`, `_ensure_conversations_bulk`.
   - Ingests batch of chat records from gateway `list_conversations`, deduplicating and generating numeric DB IDs.
3. **`MESSAGE_HYDRATION`**:
   - `_run_bulk_message_sync`.
   - High-throughput streaming message hydration using bulk endpoint (`_bulk_channel_available`).
4. **`HISTORY_EXPANSION & CURSOR MANAGEMENT`**:
   - `_hydrate_messages_on_demand`, `get_messages`, `_run_background_history_expansion`.
   - Protected by `_conversation_locks` and `_in_flight_history_fetches`.
   - Manages keyset pagination (`(external_timestamp, id)` cursor) and hydration watermarks.
5. **`GROUP METADATA SYNC`**:
   - `_schedule_metadata_enrichment` background task via `gw.sync_group_subjects`.

---

## 5. Architectural Recommendations & Batch Strategy

- **Batch 1 (Inbound Events)**:
  - Extract all inbound event processing functions into `backend/app/services/whatsapp/orchestration/events.py`.
  - Encapsulate in `WhatsAppEventOrchestrator` with dynamic helper resolution for test parity and monkeypatch support.
  - Wire `whatsapp_service.py` to delegate `ingest_gateway_event` and sub-mappers.
- **Batch 2 (Sync Orchestration)**:
  - Extract background sync job, bulk hydration, and snapshot persist into `backend/app/services/whatsapp/orchestration/sync.py`.
  - Encapsulate in `WhatsAppSyncOrchestrator`.
- **Batch 3 (History / Read-path Pagination)**:
  - Keep `get_messages` and `list_conversations` as read-path facades in `whatsapp_service.py` to prevent any keyset pagination drift or lock contention regression.
