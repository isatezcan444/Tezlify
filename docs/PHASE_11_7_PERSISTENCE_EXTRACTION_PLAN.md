# Phase 11.7 — WhatsApp Persistence Boundary Extraction Plan

**Document Status**: APPROVED & ACTIVE  
**Phase**: 11.7 — WhatsApp Persistence Boundary Extraction  
**Scope**: Classification of database-bound methods in `backend/app/services/whatsapp_service.py`, persistence audit matrix, safe extraction candidates, transaction boundaries, and phased batch plan.

---

## 1. Architectural Invariants & Rules

1. **Transaction Ownership Invariant**:
   - Repositories (`backend/app/services/whatsapp/repositories/*`) **NEVER** own transactions.
   - Repositories receive `db: AsyncSession`. They **DO NOT** call `await db.commit()` or `await db.rollback()`.
   - Transaction boundaries, commit timing, and rollback semantics remain strictly inside the service orchestrator layer (`whatsapp_service.py`).
2. **Savepoints & Locks Isolation**:
   - Operations using `async with db.begin_nested():` (savepoints) or `FOR UPDATE` / `SKIP LOCKED` remain in the orchestrator layer during initial batches unless covered by exact characterization tests.
   - In-memory `_conversation_locks` and `_sync_lock` remain strictly in the orchestration layer.
3. **No Schema Changes / No Migrations**:
   - Zero modifications to SQLAlchemy models or database tables.
4. **No Generic Repository Framework**:
   - Direct, typed, domain-focused functions without `BaseRepository`, `GenericRepository`, or `UnitOfWork` abstractions.
5. **Acyclic Dependency Flow**:
   - `whatsapp_service.py` $\rightarrow$ `backend/app/services/whatsapp/repositories/*` $\rightarrow$ `models`.
   - Repositories **never** import `whatsapp_service.py`.

---

## 2. Comprehensive Persistence Audit Matrix (`whatsapp_service.py`)

Below is the exhaustive classification of all 55 database-bound methods in [whatsapp_service.py](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp_service.py):

| Method Name | Lines | Classification | Tables Touched | Reads | Writes | Commit? | Rollback? | Savepoint? | Row Lock? | Memory Lock? | Gateway Call? | Events Emitted? | Safe Extraction? | Risk Rating |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `_user_sessions` | L405-421 | `READ_ONLY_QUERY` | `WhatsAppSession` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_require_user_session` | L428-448 | `READ_ONLY_QUERY` | `WhatsAppSession` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_get_session_or_404` | L471-480 | `READ_ONLY_QUERY` | `WhatsAppSession` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_conversation_gateway_id` | L451-461 | `READ_ONLY_QUERY` | `Conversation`, `WhatsAppSession` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_conversation_session` | L464-468 | `READ_ONLY_QUERY` | `Conversation`, `WhatsAppSession` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_resolve_event_owner_and_session` | L3280-3299 | `READ_ONLY_QUERY` | `WhatsAppSession` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_resolve_event_session_id` | L3302-3317 | `READ_ONLY_QUERY` | `WhatsAppSession` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_resolve_event_owner` | L3320-3358 | `READ_ONLY_QUERY` | `WhatsAppSession` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_get_conversation_or_404` | L1606-1615 | `READ_ONLY_QUERY` | `Conversation` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_resolve_jid` | L1618-1641 | `READ_ONLY_QUERY` | `Conversation`, `Contact` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_find_whatsapp_conversation` | L3497-3552 | `READ_ONLY_QUERY` | `Conversation`, `Contact` | YES | NO (flush legacy) | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW-MED** |
| `_conversation_scope_filters` | L1005-1016 | `READ_ONLY_QUERY` | `Conversation` | Pure filter | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `_sync_watermark_epoch` | L2652-2674 | `READ_ONLY_QUERY` | `Message` | YES | NO | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 1)** | **LOW** |
| `list_conversations` | L1423-1601 | `READ_ONLY_QUERY` | `Conversation`, `Contact`, `Lead`, `Message` | YES | NO | NO | NO | NO | NO | NO | NO | NO | DEFERRED | MEDIUM |
| `_repair_last_message_previews`| L1219-1281 | `READ_ONLY_QUERY` | `Conversation`, `Message`, `Contact` | YES | NO (flush) | NO | NO | NO | NO | NO | NO | NO | DEFERRED | MEDIUM |
| `get_messages` | L1790-1910 | `TRANSACTION_ORCHESTRATOR` | `Message`, `Conversation` | YES | NO | NO | NO | NO | NO | YES | NO | NO | DEFERRED (Queries in Batch 1) | MEDIUM |
| `get_media_bytes` | L2093-2112 | `READ_ONLY_QUERY` | `Message`, `Conversation` | YES | NO | NO | NO | NO | NO | NO | YES | NO | NO (Gateway call) | HIGH |
| `_persist_gateway_message` | L1179-1216 | `WRITE_WITHOUT_COMMIT` | `Message`, `Conversation` | YES | YES | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 2)** | **MEDIUM** |
| `_ensure_conversation` | L1018-1082 | `WRITE_WITHOUT_COMMIT` | `Conversation`, `Contact` | YES | YES | NO | NO | NO | NO | NO | NO | NO | **YES (Batch 3)** | **MEDIUM** |
| `_ensure_conversation_race_safe`| L1085-1120 | `TRANSACTION_ORCHESTRATOR`| `Conversation` | YES | YES | NO | **YES** | NO | NO | NO | NO | NO | NO (Owns rollback) | HIGH |
| `_bulk_upsert_contacts` | L717-812 | `TRANSACTION_ORCHESTRATOR` | `Contact` | YES | YES | NO | NO | **YES** | NO | NO | NO | NO | NO (Savepoint loop) | HIGH |
| `_ensure_conversations_bulk` | L815-925 | `TRANSACTION_ORCHESTRATOR` | `Conversation`, `Contact` | YES | YES | NO | NO | **YES** | NO | NO | NO | NO | NO (Savepoint loop) | HIGH |
| `_upsert_contact` | L928-998 | `TRANSACTION_ORCHESTRATOR` | `Contact` | YES | YES | NO | NO | **YES** | NO | NO | NO | NO | NO (Savepoint) | HIGH |
| `send_text_message` | L1916-1974 | `TRANSACTION_ORCHESTRATOR` | `Message`, `Conversation` | YES | YES | **YES** | NO | NO | NO | YES | YES | YES | NO (Multi-commit/GW) | HIGH |
| `send_media_message` | L1977-2043 | `TRANSACTION_ORCHESTRATOR` | `Message`, `Conversation` | YES | YES | **YES** | NO | NO | NO | YES | YES | YES | NO (Multi-commit/GW) | HIGH |
| `mark_conversation_read` | L2046-2077 | `TRANSACTION_ORCHESTRATOR` | `Conversation`, `Message` | YES | YES | **YES** | NO | NO | NO | NO | YES | NO | NO (Gateway/commit) | HIGH |
| `send_typing` | L2080-2090 | `TRANSACTION_ORCHESTRATOR` | None | NO | NO | NO | NO | NO | NO | NO | YES | NO | NO | MEDIUM |
| `reconcile_legacy_split_conversation` | L3411-3494 | `TRANSACTION_ORCHESTRATOR` | `Conversation`, `Message`, `Contact` | YES | YES | **YES** | NO | NO | NO | YES | NO | YES | NO (Lock/commit) | HIGH |
| `create_session` | L383-402 | `SESSION_OPERATION` | `WhatsAppSession` | NO | YES | **YES** | NO | NO | NO | NO | YES | YES | NO | HIGH |
| `get_session_qr` | L483-493 | `SESSION_OPERATION` | `WhatsAppSession` | YES | YES | **YES** | NO | NO | NO | NO | YES | NO | NO | HIGH |
| `refresh_session_qr` | L496-505 | `SESSION_OPERATION` | `WhatsAppSession` | YES | YES | **YES** | NO | NO | NO | NO | YES | NO | NO | HIGH |
| `request_pairing_code` | L508-528 | `SESSION_OPERATION` | `WhatsAppSession` | YES | YES | **YES** | NO | NO | NO | NO | YES | NO | NO | HIGH |
| `logout_session` | L531-550 | `SESSION_OPERATION` | `WhatsAppSession` | YES | YES | **YES** | NO | NO | NO | NO | YES | NO | NO | HIGH |
| `delete_session` | L630-656 | `SESSION_OPERATION` | `WhatsAppSession`, `Message`, `Conversation` | YES | YES | **YES** | NO | NO | NO | NO | YES | YES | NO | HIGH |
| `purge_whatsapp_data` | L553-627 | `SESSION_OPERATION` | `WhatsAppSession`, `Message`, `Conversation`, `Contact`, `Lead` | YES | YES | NO | NO | NO | NO | NO | NO | NO | NO | HIGH |
| `sync_contacts` | L681-713 | `SESSION_OPERATION` | `WhatsAppSession`, `Contact` | YES | YES | **YES** | NO | NO | NO | YES | YES | YES | NO | HIGH |
| `_gateway_op_or_mark_relink` | L236-279 | `SESSION_OPERATION` | `WhatsAppSession` | YES | YES | **YES** | NO | NO | NO | NO | NO | NO | NO | HIGH |
| `_list_sessions_internal` | L286-336 | `SESSION_OPERATION` | `WhatsAppSession` | YES | YES | **YES** | NO | NO | NO | NO | YES | NO | NO | HIGH |
| `list_sessions` | L339-341 | `SESSION_OPERATION` | None | NO | NO | NO | NO | NO | NO | NO | NO | NO | NO | LOW |
| `get_sync_status` | L344-380 | `SESSION_OPERATION` | None | NO | NO | NO | NO | NO | NO | NO | NO | NO | NO | LOW |
| `_run_sync_job` | L2383-2554 | `TRANSACTION_ORCHESTRATOR` | `WhatsAppSession`, `Conversation`, `Contact` | YES | YES | **YES** | NO | NO | NO | YES | YES | YES | NO | HIGH |
| `_persist_chat_snapshot` | L2562-2649 | `TRANSACTION_ORCHESTRATOR` | `Conversation`, `Contact` | YES | YES | **YES** | NO | NO | NO | NO | NO | NO | NO | HIGH |
| `_run_bulk_message_sync` | L2677-2831 | `TRANSACTION_ORCHESTRATOR` | `Message`, `Conversation`, `WhatsAppSession` | YES | YES | **YES** | NO | NO | NO | NO | YES | YES | NO | HIGH |
| `_run_initial_sync` | L2855-2884 | `TRANSACTION_ORCHESTRATOR` | `WhatsAppSession` | NO | NO | NO | NO | NO | NO | NO | NO | NO | NO | HIGH |
| `_run_background_history_expansion` | L2891-2943 | `TRANSACTION_ORCHESTRATOR` | `Message`, `Conversation` | YES | NO | NO | NO | NO | NO | NO | NO | NO | NO | HIGH |
| `_hydrate_messages_on_demand` | L1644-1743 | `TRANSACTION_ORCHESTRATOR` | `Message`, `Conversation` | YES | YES | **YES** | NO | NO | NO | NO | YES | NO | NO | HIGH |
| `sync_conversations` | L1292-1307 | `TRANSACTION_ORCHESTRATOR` | None | NO | NO | NO | NO | NO | NO | NO | NO | NO | NO | MEDIUM |
| `_sync_conversations_impl` | L1310-1420 | `TRANSACTION_ORCHESTRATOR` | `Conversation`, `Contact` | YES | YES | **YES** | NO | NO | NO | YES | YES | YES | NO | HIGH |
| `_reapply_chat_names` | L2317-2360 | `TRANSACTION_ORCHESTRATOR` | `Conversation`, `Contact` | YES | YES | **YES** | NO | NO | NO | NO | NO | NO | NO | HIGH |
| `request_sync` | L2284-2297 | `TRANSACTION_ORCHESTRATOR` | None | NO | NO | NO | NO | NO | NO | NO | NO | YES | NO | LOW |
| `_passthrough_event` | L2965-2978 | `EVENT_PROCESSING` | None | NO | NO | NO | NO | NO | NO | NO | NO | NO | NO | LOW |
| `ingest_gateway_event` | L3025-3135 | `EVENT_PROCESSING` | `whatsapp_private.processed_events` | YES | YES | **YES** | **YES** | NO | NO | NO | NO | YES | NO | EXTREME |
| `_ingest_message` | L3138-3260 | `EVENT_PROCESSING` | `Message`, `Conversation` | YES | YES | **YES** | NO | NO | NO | YES | NO | YES | NO | HIGH |
| `_ingest_contact_synced` | L3361-3408 | `EVENT_PROCESSING` | `Contact`, `Conversation` | YES | YES | **YES** | NO | NO | NO | NO | NO | YES | NO | HIGH |
| `_map_conversation_event` | L3555-3715 | `EVENT_PROCESSING` | `Conversation`, `Message` | YES | YES | **YES** | NO | NO | NO | NO | NO | YES | NO | HIGH |
| `_map_session_event` | L3718-3770 | `EVENT_PROCESSING` | `WhatsAppSession` | YES | YES | NO | NO | NO | NO | NO | NO | YES | NO | HIGH |

---

## 3. Safe Extraction Strategy & Phased Batches

Based on our empirical persistence audit, extraction is organized into 3 controlled batches strictly conforming to the non-negotiable rules of Phase 11.7:

### BATCH 1: Read-Only WhatsApp Persistence Repositories
Extract pure query methods that perform zero writes, zero commits, zero rollbacks, and hold no locks.

1. **`backend/app/services/whatsapp/repositories/conversations.py`**:
   - `get_conversation_scope_filters(user_id, contact_id, session_id)`: Canonical tenant/line query filters.
   - `get_conversation_by_id(db, user_id, conversation_id)`: Single conversation lookup with tenant boundary; raises `LookupError`.
   - `resolve_conversation_jid(db, user_id, conversation_id)`: Loads conversation with contact to derive canonical JID.
   - `find_whatsapp_conversation(db, user_id, jid, session_id)`: Deterministic existing conversation lookup without creating new rows.
2. **`backend/app/services/whatsapp/repositories/sessions.py`**:
   - `get_user_sessions(db, user_id, connected_only)`: Tenant-scoped session listing.
   - `get_session_by_id(db, user_id, session_id)`: Single session lookup with tenant verification.
   - `require_user_session(db, user_id, session_id)`: Resolves active session or fails closed with `NoWhatsAppSession`.
   - `resolve_event_owner_and_session(db, jid, gw_session_id)`: Single-query resolution of `(user_id, session_id)` from `gateway_id`.
   - `resolve_event_session_id(db, gw_session_id)`: Backend session ID resolution from `gateway_id`.
   - `resolve_event_owner(db, jid, gw_session_id)`: Fail-closed tenant owner resolution.
3. **`backend/app/services/whatsapp/repositories/messages.py`**:
   - `get_sync_watermark_epoch(db, owner)`: Epoch watermark from latest inbound message.
   - `get_message_by_id(db, message_id, conversation_id)`: Keyset anchor lookup.
   - `select_messages_keyset(db, user_id, conversation_id, limit, before_row, before_id)`: Deterministic keyset paginated message query.
   - `has_older_messages(db, user_id, conversation_id, oldest_row)`: Check for pagination termination.

### BATCH 2: Simple Message Persistence
Extract atomic write-without-commit message row construction & dedup check:
- `persist_gateway_message_row(db, owner, msg, conv)` in `repositories/messages.py`:
  - Validates broadcast/newsletter.
  - Checks duplicate by `wa_message_id`.
  - Builds `Message` entity via `_message_row_from_gateway`.
  - Flushes to session (`await db.flush()`), but **NEVER COMMITS**.

### BATCH 3: Simple Conversation Persistence
Extract atomic conversation creation helper:
- `ensure_conversation_entity(db, user_id, contact_id, session_id, preview, is_group)` in `repositories/conversations.py`:
  - Pure persistence of `Conversation` row without transaction orchestration.
  - Transaction-sensitive retry (`_ensure_conversation_race_safe`) retains its rollback and retry loop inside `whatsapp_service.py`.

---

## 4. Verification Protocol for Each Batch

1. Run Python compilation check:
   ```bash
   python3 -m compileall backend/app
   ```
2. Run targeted persistence tests:
   ```bash
   source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_whatsapp_pure_*.py backend/tests/test_whatsapp_characterization.py -v
   ```
3. Run full backend pytest suite:
   ```bash
   source venv/bin/activate && PYTHONPATH=. pytest backend/tests/ -q
   ```
4. Run circular dependency check:
   ```bash
   python3 scratch/check_circular_dependencies.py
   ```
5. Run frontend compilation:
   ```bash
   npm --prefix frontend run build
   ```
6. Run gateway test suite:
   ```bash
   for f in whatsapp-gateway/scripts/test-*.mjs; do node "$f" || exit 1; done
   ```
