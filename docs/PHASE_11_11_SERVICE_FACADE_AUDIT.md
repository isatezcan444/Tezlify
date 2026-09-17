# Phase 11.11 — WhatsApp Service Facade Forensic Audit

**Document Date:** 2026-09-17  
**Target Module:** `backend/app/services/whatsapp_service.py` (861 lines baseline)  
**System Status:** Production Phase 11.10 verified healthy (`b87af0a`, 4/4 containers healthy, Oracle DB exact session baseline captured)

---

## 1. Executive Summary & Objective

Following the architectural extraction across Phases 11.6–11.10, the WhatsApp subsystem has been partitioned into:
- **Domain Repositories** (`repositories/{contacts,conversations,messages,sessions}.py`)
- **Gateway Transport Boundary** (`gateway/{client,errors,responses}.py`)
- **Pure Policies & Normalizers** (`identity.py`, `status_policy.py`, `preview_normalization.py`)
- **Domain Orchestrators** (`orchestration/{sessions,messaging,events,sync}.py`)

`backend/app/services/whatsapp_service.py` is now an ~861 line canonical facade.
The objective of Phase 11.11 is **not** to artificially strip lines or create new abstraction layers, but to:
1. Conduct a rigorous forensic AST audit of all remaining functions and module symbols.
2. Formally classify each method into standard architectural categories.
3. Verify shared state ownership (`_conversation_locks`, `_in_flight_history_fetches`).
4. Prove zero transactional mutations in the facade layer (strict delegative boundary).
5. Identify dead imports and unused aliases resulting from past extraction phases for safe cleanup.
6. Preserve the canonical public API and query facades (`list_conversations`, `get_messages`, `get_sync_status`).

---

## 2. AST Method Classification

Every method in `whatsapp_service.py` is classified into one of the designated categories:

| Category | Count | Methods |
| :--- | :---: | :--- |
| **`PUBLIC_FACADE`** | 12 | `delete_session`, `sync_contacts`, `sync_conversations`, `send_text_message`, `send_media_message`, `mark_conversation_read`, `send_typing`, `get_media_bytes`, `request_sync`, `get_sync_job`, `ingest_gateway_event`, `reconcile_legacy_split_conversation` *(plus module re-exports: `create_session`, `get_session_qr`, `refresh_session_qr`, `request_pairing_code`, `list_sessions`, `logout_session`, `purge_whatsapp_data`)* |
| **`QUERY_FACADE`** | 3 | `list_conversations`, `get_messages`, `get_sync_status` |
| **`LOCK_OWNER`** | 2 | `_get_conversation_lock`, `get_messages` (lock acquisition) |
| **`SHARED_STATE`** | 2 | `_get_conversation_lock`, `get_messages` (`_in_flight_history_fetches`) |
| **`TRANSACTION_OWNER`** | 0 | None (0 direct `db.commit()` or `db.rollback()` calls in `whatsapp_service.py`) |
| **`LEGACY_FALLBACK`** | 2 | `sync_conversations`, `_sync_conversations_impl` |
| **`COMPATIBILITY_ALIAS`**| 24 | `_bulk_upsert_contacts`, `_ensure_conversations_bulk`, `_upsert_contact`, `_ensure_conversation`, `_ensure_conversation_race_safe`, `_persist_gateway_message`, `_repair_last_message_previews`, `_sync_conversations_impl`, `_hydrate_messages_on_demand`, `_schedule_chats_bootstrap`, `_bulk_channel_available`, `_broadcast_sync_event`, `_sync_event`, `_cancel_stale_sync_jobs`, `_reapply_chat_names`, `_schedule_metadata_enrichment`, `_run_sync_job`, `_persist_chat_snapshot`, `_run_bulk_message_sync`, `_schedule_initial_sync`, `_run_initial_sync`, `_run_background_history_expansion`, `_passthrough_event`, `_ingest_message`, `_ingest_contact_synced`, `_map_conversation_event`, `_map_session_event` |
| **`PURE_HELPER`** | 0 | None (all pure helpers migrated to `identity.py`, `preview_normalization.py`, `status_policy.py`) |
| **`DUPLICATE`** | 0 | None in executable code (redundant imports identified in Section 6) |
| **`UNUSED`** | 0 | No executable functions are completely unreferenced when accounting for dynamic orchestrator lookup (`self._get_helper`) and test suites |
| **`DEFERRED`** | 0 | None |

---

## 3. Comprehensive Method Audit Table

| Method Name | Lines | Category | Caller(s) | Endpoint Dep | Test Dep | DB Access | GW Access | Lock Access | WS Access | Background Task | Recommendation |
| :--- | :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `_get_conversation_lock` | 100-106 | `LOCK_OWNER` | `get_messages`, orchestrators | No | No | No | No | Owner | No | No | **PRESERVE**: Single source of truth for per-conversation concurrency lock. |
| `get_sync_status` | 236-272 | `QUERY_FACADE` | `endpoints/whatsapp.py` | Yes | No | Yes (via sessions) | Yes | No | No | No | **PRESERVE**: Read-only gateway memory status query; fail-closed contract. |
| `delete_session` | 280-283 | `PUBLIC_FACADE` | `endpoints/whatsapp.py` | Yes | 4 | Yes | No | No | No | No | **PRESERVE**: Bridges session deletion and cancels stale sync jobs. |
| `sync_contacts` | 291-294 | `PUBLIC_FACADE` | `endpoints/whatsapp.py` | Yes | 6 | Yes | Yes | No | No | No | **PRESERVE**: Public delegation to `WhatsAppSyncOrchestrator`. |
| `_bulk_upsert_contacts` | 297-303 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper` | No | 0 | Yes | No | No | No | No | **PRESERVE**: Facilitates dynamic helper resolution and backward compatibility. |
| `_ensure_conversations_bulk` | 306-311 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper` | No | 0 | Yes | No | No | No | No | **PRESERVE**: Facilitates dynamic helper resolution and backward compatibility. |
| `_upsert_contact` | 314-321 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper` | No | 4 | Yes | No | No | No | No | **PRESERVE**: Facilitates dynamic helper resolution and mock compatibility. |
| `_ensure_conversation` | 324-335 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper` | No | 3 | Yes | No | No | No | No | **PRESERVE**: Facilitates dynamic helper resolution and mock compatibility. |
| `_ensure_conversation_race_safe` | 338-349 | `COMPATIBILITY_ALIAS` | `test_whatsapp_races.py` | No | 2 | Yes | No | No | No | No | **PRESERVE**: Direct mock point for race-safety acceptance tests. |
| `_persist_gateway_message` | 352-353 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper` | No | 0 | Yes | Yes | No | No | No | **PRESERVE**: Helper resolution for sync message persistence. |
| `_repair_last_message_previews` | 357-359 | `COMPATIBILITY_ALIAS` | `sync.py`, test suites | No | 2 | Yes | No | No | No | No | **PRESERVE**: Helper resolution for preview repairing. |
| `sync_conversations` | 362-364 | `PUBLIC_FACADE` / `LEGACY` | test suites | No | 6 | Yes | Yes | No | No | No | **PRESERVE**: Legacy fallback sync interface; tested by 6 suites. |
| `_sync_conversations_impl` | 367-368 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper` | No | 1 | Yes | Yes | No | No | No | **PRESERVE**: Helper resolution for legacy sync implementation. |
| `list_conversations` | 372-550 | `QUERY_FACADE` | `endpoints/whatsapp.py`, `sync.py` | Yes | 12 | Yes | No | No | No | No | **PRESERVE**: Production-tuned conversation query, junk JID exclusion, CRM join. |
| `_hydrate_messages_on_demand` | 558-569 | `COMPATIBILITY_ALIAS` | `get_messages`, test suites | No | 5 | Yes | Yes | No | No | No | **PRESERVE**: Critical delegation for lazy on-demand chat scrolling. |
| `get_messages` | 576-696 | `QUERY_FACADE` / `LOCK_OWNER` | `endpoints/whatsapp.py` | Yes | 12 | Yes | Yes | Yes | No | No | **PRESERVE**: Primary message query, keyset pagination, in-flight dedup, lock ownership. |
| `send_text_message` | 702-705 | `PUBLIC_FACADE` | `endpoints/whatsapp.py` | Yes | 6 | Yes | Yes | Yes | Yes | No | **PRESERVE**: Outbound text dispatch delegation. |
| `send_media_message` | 708-711 | `PUBLIC_FACADE` | `endpoints/whatsapp.py` | Yes | 4 | Yes | Yes | Yes | Yes | No | **PRESERVE**: Outbound media dispatch delegation. |
| `mark_conversation_read` | 714-715 | `PUBLIC_FACADE` | `endpoints/whatsapp.py` | Yes | 2 | Yes | Yes | No | Yes | No | **PRESERVE**: Conversation read receipt delegation. |
| `send_typing` | 718-719 | `PUBLIC_FACADE` | `endpoints/whatsapp.py` | Yes | 3 | Yes | Yes | No | No | No | **PRESERVE**: Outbound presence/typing delegation. |
| `get_media_bytes` | 722-723 | `PUBLIC_FACADE` | `endpoints/whatsapp.py` | Yes | 1 | Yes | Yes | No | No | No | **PRESERVE**: Media byte retrieval proxy delegation. |
| `_schedule_chats_bootstrap` | 732-733 | `COMPATIBILITY_ALIAS` | `events.py`, tests | No | 1 | No | No | No | No | Yes | **PRESERVE**: Async task bootstrap scheduling delegation. |
| `_bulk_channel_available` | 736-737 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper`, tests | No | 3 | No | Yes | No | No | No | **PRESERVE**: Gateway channel capability check delegation. |
| `_broadcast_sync_event` | 740-741 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper`, tests | No | 6 | No | No | No | Yes | No | **PRESERVE**: Real-time sync progress broadcast delegation. |
| `_sync_event` | 744-745 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper`, tests | No | 7 | No | No | No | No | No | **PRESERVE**: Sync event formatting delegation. |
| `request_sync` | 748-749 | `PUBLIC_FACADE` | `endpoints/whatsapp.py`, tests | Yes | 5 | Yes | Yes | No | Yes | Yes | **PRESERVE**: Public sync initiation facade. |
| `get_sync_job` | 752-753 | `PUBLIC_FACADE` | `endpoints/whatsapp.py` | Yes | 1 | No | No | No | No | No | **PRESERVE**: In-memory sync job status retrieval facade. |
| `_cancel_stale_sync_jobs` | 756-757 | `COMPATIBILITY_ALIAS` | `delete_session`, tests | No | 3 | No | No | No | No | No | **PRESERVE**: Stale job cancellation delegation. |
| `_reapply_chat_names` | 760-763 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper`, tests | No | 2 | Yes | No | No | No | No | **PRESERVE**: Chat name reapplication delegation. |
| `_schedule_metadata_enrichment` | 766-767 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper` | No | 0 | No | Yes | No | No | Yes | **PRESERVE**: Async metadata enrichment delegation. |
| `_run_sync_job` | 771-772 | `COMPATIBILITY_ALIAS` | tests | No | 2 | Yes | Yes | No | Yes | Yes | **PRESERVE**: Sync job background runner delegation. |
| `_persist_chat_snapshot` | 775-779 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper`, tests | No | 2 | Yes | No | No | No | No | **PRESERVE**: Chat snapshot batch persistence delegation. |
| `_run_bulk_message_sync` | 782-791 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper`, tests | No | 3 | Yes | Yes | No | Yes | Yes | **PRESERVE**: Bulk message sync execution delegation. |
| `_schedule_initial_sync` | 794-795 | `COMPATIBILITY_ALIAS` | `events.py`, tests | No | 1 | No | No | No | No | Yes | **PRESERVE**: Initial sync scheduling delegation. |
| `_run_initial_sync` | 798-799 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper`, tests | No | 2 | Yes | Yes | No | Yes | Yes | **PRESERVE**: Initial sync execution delegation. |
| `_run_background_history_expansion` | 802-803 | `COMPATIBILITY_ALIAS` | `sync.py` via `_get_helper` | No | 0 | Yes | Yes | No | No | Yes | **PRESERVE**: History expansion runner delegation. |
| `_passthrough_event` | 825-827 | `COMPATIBILITY_ALIAS` | tests | No | 1 | Yes | Yes | No | Yes | No | **PRESERVE**: Ephemeral UI event pass-through delegation. |
| `ingest_gateway_event` | 831-833 | `PUBLIC_FACADE` | `main.py` (`/ws/gateway`), tests | Yes | 11 | Yes | Yes | Yes | Yes | No | **PRESERVE**: Inbound WebSocket gateway event processing facade. |
| `_ingest_message` | 836-837 | `COMPATIBILITY_ALIAS` | tests | No | 6 | Yes | No | Yes | Yes | No | **PRESERVE**: Inbound message ingestion delegation. |
| `_ingest_contact_synced` | 840-841 | `COMPATIBILITY_ALIAS` | `migrations.py`, tests | No | 2 | Yes | No | No | Yes | No | **PRESERVE**: Contact sync event ingestion delegation. |
| `reconcile_legacy_split_conversation` | 844-851 | `PUBLIC_FACADE` | tests | No | 2 | Yes | No | Yes | No | No | **PRESERVE**: Non-destructive split-identity reconciliation facade. |
| `_map_conversation_event` | 854-855 | `COMPATIBILITY_ALIAS` | tests | No | 3 | Yes | No | No | No | No | **PRESERVE**: Gateway conversation payload mapping delegation. |
| `_map_session_event` | 858-859 | `COMPATIBILITY_ALIAS` | tests | No | 2 | Yes | No | No | No | No | **PRESERVE**: Gateway session payload mapping delegation. |

---

## 4. Shared State Ownership Analysis

`whatsapp_service.py` houses and manages the following runtime state:

1. **`_conversation_locks: Dict[Tuple[str, int], asyncio.Lock]`**
   - **Owner:** `whatsapp_service.py` (`_get_conversation_lock`).
   - **Readers:** `get_messages`, `WhatsAppMessagingOrchestrator`, `WhatsAppEventOrchestrator`.
   - **Lifecycle:** Process lifetime, keyed by `(user_id, conversation_id)`. Created lazily on first access.
   - **Reset Semantics:** In-memory; safe across restarts.
   - **Concurrency Assumption:** Guarantees strict serialization for simultaneous inbound/outbound mutations on the same conversation row.
   - **Verdict:** Single source of truth. Stays in `whatsapp_service.py`.

2. **`_in_flight_history_fetches: Dict[Tuple[int, Optional[int]], asyncio.Future]`**
   - **Owner:** `whatsapp_service.py` (`get_messages`).
   - **Readers/Writers:** `get_messages`.
   - **Lifecycle:** Request-scoped; future created before acquiring lock, resolved and popped in `finally` block.
   - **Reset Semantics:** Auto-cleared in `finally`.
   - **Concurrency Assumption:** Prevents duplicate concurrent gateway requests when rapid scrolling fires overlapping `before` pagination calls for the same conversation page.
   - **Verdict:** Co-located with `get_messages`. Stays in `whatsapp_service.py`.

3. **Orchestrator In-Memory Registries (Re-exported via `sync.py`)**
   - `_sync_jobs: Dict[str, SyncJob]`
   - `_initial_sync_inflight: Set[str]`
   - `_initial_sync_pending: Set[str]`
   - `_bulk_channel_cache: Dict[str, Tuple[float, bool]]`
   - `_metadata_tasks: Dict[str, asyncio.Task]`
   - `_last_bootstrap_emit: Dict[str, float]`
   - **Owner:** `WhatsAppSyncOrchestrator` (`orchestration/sync.py`).
   - **Re-exported:** In `whatsapp_service.py` for test mocking parity (verified: 8+ test files inspect or mock `whatsapp_service._sync_jobs` and `_bulk_channel_cache`).
   - **Verdict:** Primary state in `sync.py`; re-exported aliases maintained in `whatsapp_service.py` for full test compatibility.

---

## 5. Transaction Ownership Audit

A complete AST scan confirmed:
```text
direct db.commit() in whatsapp_service.py: 0
direct db.rollback() in whatsapp_service.py: 0
direct db.begin_nested() in whatsapp_service.py: 0
```
- **Rationale:** The facade layer is strictly delegative.
- **Write Operations:** Transaction boundaries are managed entirely inside the respective orchestrators (`sessions.py`, `messaging.py`, `events.py`, `sync.py`).
- **Read Operations:** `list_conversations`, `get_messages`, and `get_sync_status` execute read-only queries with no state-altering commits. On-demand hydration triggered inside `get_messages` delegates to `_sync_orchestrator._hydrate_messages_on_demand`, which owns its own session and transaction lifecycle.

---

## 6. Dead Code & Redundant Imports Inventory (Batch 1 Scope)

During the migration phases (11.6–11.10), many orchestrator functions were imported into `whatsapp_service.py` with private aliases (`_messaging_*`, `_events_*`, `_sync_*`), but the service methods instead delegate directly to the orchestrator instances (`_messaging_orchestrator.<method>`, `_event_orchestrator.<method>`, `_sync_orchestrator.<method>`).
These unused imports clutter the module header and can be safely eliminated:

### Unused Standard Library / SQLAlchemy Imports:
- `import re`
- `import time`
- `import uuid`
- `from datetime import timezone`
- `from sqlalchemy import delete, text, insert`
- `from sqlalchemy.exc import IntegrityError`

### Unused Repository / Gateway Imports:
- `_set_contact_avatar`
- `_get_session_or_404`, `_user_sessions`, `_require_user_session`, `_resolve_event_owner_and_session`, `_resolve_event_session_id`
- `_message_row_from_gateway`, `_sync_watermark_epoch`, `message_exists_by_wa_id`
- `classify_gateway_error`, `extract_live_session_fields`, `extract_pairing_code`, `extract_send_result`, `extract_session_id`
- `phone_to_jid`

### Unused Private Orchestration Aliases:
- `_apply_gateway_live`, `_session_dict`, `_is_gateway_session_missing`
- `_messaging_get_media_bytes`, `_messaging_mark_conversation_read`, `_messaging_send_media_message`, `_messaging_send_text_message`, `_messaging_send_typing`, `serialize_message`
- `_events_ensure_conversation`, `_events_ensure_conversation_race_safe`, `_events_ingest_contact_synced`, `_events_ingest_gateway_event`, `_events_ingest_message`, `_events_map_conversation_event`, `_events_map_session_event`, `_events_passthrough_event`, `_events_persist_gateway_message`, `_events_reconcile_legacy_split_conversation`, `_events_upsert_contact`, `_log_orphan_event`, `_skip_event`
- `_BOOTSTRAP_EMIT_INTERVAL_S`, `_SYNC_BULK_PAGE_SIZE`, `_SYNC_CHAT_PAGE_SIZE`, `_SYNC_EVENT_CHUNK`, `_SYNC_PERSIST_BATCH`, `_history_expansion_done`, `_history_expansion_running`, `_sync_conversations_inflight`, `_sync_bulk_channel_available`, `_sync_bulk_upsert_contacts`, `_sync_cancel_stale_sync_jobs`, `_sync_ensure_conversations_bulk`, `_sync_get_sync_job`, `_sync_hydrate_messages_on_demand`, `_sync_persist_chat_snapshot`, `_sync_reapply_chat_names`, `_sync_repair_last_message_previews`, `_sync_request_sync`, `_sync_run_background_history_expansion`, `_sync_run_bulk_message_sync`, `_sync_run_initial_sync`, `_sync_run_sync_job`, `_sync_schedule_chats_bootstrap`, `_sync_schedule_initial_sync`, `_sync_schedule_metadata_enrichment`, `_sync_sync_contacts`, `_sync_sync_conversations`, `_sync_sync_conversations_impl`
- `_BRACKET_TYPE_RE`, `_TYPE_PREVIEW_LABELS`, `_as_naive_utc`, `_parse_dt`, `should_apply_last_message`

---

## 7. Plan for Batch 1 & Batch 2 Consolidation

1. **Batch 1 (Safe Cleanup):**
   - Remove dead stdlib, SQLAlchemy, and unused private alias imports in `whatsapp_service.py`.
   - Preserve all public facade functions, compatibility aliases, and test-mocked properties (`gw`, `_sync_jobs`, `_bulk_channel_cache`, `_conversation_locks`, etc.).
   - Verify `compileall` and run full backend test suite (`pytest backend/tests/ -q`).

2. **Batch 2 (Facade Consolidation):**
   - Standardize docstrings and coordinator delegation comments in `whatsapp_service.py`.
   - Ensure clean architectural layer diagram comments documenting the public facade contract.
   - Run complete regression suite across backend, frontend, gateway (15/15), and circular dependency check (0 cycles).
