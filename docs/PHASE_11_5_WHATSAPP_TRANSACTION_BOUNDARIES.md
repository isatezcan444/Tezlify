# Phase 11.5 — WhatsApp Transaction Boundary Map

**Document Status**: COMPLETE & VERIFIED  
**Phase**: 11.5 — WhatsApp Architecture Preparation & Characterization  
**Scope**: Explicit mapping of database transactions, savepoints, row locks, table mutations, and external network boundaries in WhatsApp code paths.

> [!CAUTION]
> **ABSOLUTE RULE — NO TRANSACTION REFACTORING IN THIS PHASE**:
> This document maps existing transaction boundaries for architectural clarity. Do NOT alter transaction scopes, commit timings, savepoints, or row locking semantics during Phase 11.5.

---

## 1. Transaction Architectural Invariants

1. **Fail-Closed External Calls**:
   - In `send_text_message()` and `send_media_message()`, an initial optimistic message row (`PENDING`) is committed BEFORE dispatching the HTTP call to the Node.js gateway. This guarantees that if the gateway times out or fails, the database retains an auditable record of the attempt without locking PostgreSQL rows during remote HTTP transit.
2. **Savepoint Concurrency Isolation**:
   - Bulk upsert operations (`_bulk_upsert_contacts`, `_ensure_conversations_bulk`, `_upsert_contact`) wrap individual records inside `async with db.begin_nested():` savepoints. A duplicate key collision or constraint failure on a single contact rolls back only that specific record's savepoint without aborting the overarching transaction.
3. **Gateway Event Deduplication Transaction**:
   - `ingest_gateway_event()` starts its own transaction (`async with AsyncSessionLocal() as db:`). It checks `whatsapp_private.processed_events` for duplicates before delegating to domain handlers. On error, it rolls back cleanly and returns `None` to prevent unpersisted data from reaching the UI.
4. **Outbox Claiming Isolation**:
   - Gateway outbox polling in `postgres-event-outbox.js` executes `SELECT ... FOR UPDATE SKIP LOCKED` inside a Common Table Expression (CTE) combined with an `UPDATE ... SET state = 'IN_FLIGHT' RETURNING ...`. This guarantees zero contention between concurrent gateway workers and zero duplicate deliveries.

---

## 2. Backend Transaction Matrix (`whatsapp_service.py`)

Below is the complete audit of the 29 transactional functions in [whatsapp_service.py](file:///Users/isatezcan/Documents/Github/Tezlify/backend/app/services/whatsapp_service.py):

| Method Name | Tx Starts? | Tx Inherited? | Committed? | Rolled Back? | Savepoint (`begin_nested`)? | Row Lock (`FOR UPDATE`)? | Tables Touched | External Call Inside Tx? |
|---|---|---|---|---|---|---|---|---|
| `ingest_gateway_event` | **YES** (`AsyncSessionLocal`) | NO | **YES** | **YES** (on error) | NO | NO | `whatsapp_private.processed_events`, `messages`, `conversations`, `contacts`, `whatsapp_sessions` | NO |
| `_ingest_message` | NO | **YES** | **YES** | NO | NO | NO | `messages`, `conversations` | NO |
| `_ingest_contact_synced` | NO | **YES** | **YES** | NO | NO | NO | `contacts`, `conversations` | NO |
| `_map_conversation_event` | NO | **YES** | **YES** | NO | NO | NO | `conversations`, `messages` | NO |
| `_map_session_event` | NO | **YES** | **YES** | NO | NO | NO | `whatsapp_sessions` | NO |
| `_ensure_conversation_race_safe` | NO | **YES** | NO | **YES** (on conflict) | NO | NO | `conversations` | NO |
| `_bulk_upsert_contacts` | NO | **YES** | NO | NO | **YES** | NO | `contacts` | NO |
| `_ensure_conversations_bulk` | NO | **YES** | NO | NO | **YES** | NO | `conversations` | NO |
| `_upsert_contact` | NO | **YES** | NO | NO | **YES** | NO | `contacts` | NO |
| `_reapply_chat_names` | NO | **YES** | **YES** | NO | NO | NO | `conversations` | NO |
| `_sync_conversations_impl` | NO | **YES** | **YES** | NO | NO | NO | `conversations`, `contacts`, `whatsapp_sessions` | **YES** (Gateway REST) |
| `_hydrate_messages_on_demand` | NO | **YES** | **YES** | NO | NO | NO | `messages`, `conversations` | **YES** (Gateway REST) |
| `_persist_chat_snapshot` | NO | **YES** | **YES** | NO | NO | NO | `conversations`, `contacts` | NO |
| `_run_bulk_message_sync` | NO | **YES** | **YES** | NO | NO | NO | `messages`, `conversations` | **YES** (Gateway REST) |
| `_run_sync_job` | **YES** (`AsyncSessionLocal`) | NO | **YES** | NO | NO | NO | `conversations`, `contacts`, `messages` | **YES** (Gateway REST) |
| `_run_initial_sync` | **YES** (`AsyncSessionLocal`) | NO | NO | NO | NO | NO | Delegates to `_run_sync_job` | NO |
| `_run_background_history_expansion` | **YES** (`AsyncSessionLocal`) | NO | NO | NO | NO | NO | Delegates to `_run_sync_job` | NO |
| `send_text_message` | NO | **YES** | **YES** (multiple) | NO | NO | NO | `messages`, `conversations`, `whatsapp_sessions` | **YES** (Gateway REST) |
| `send_media_message` | NO | **YES** | **YES** (multiple) | NO | NO | NO | `messages`, `conversations`, `whatsapp_sessions` | **YES** (Gateway REST) |
| `mark_conversation_read` | NO | **YES** | **YES** | NO | NO | NO | `conversations`, `messages` | **YES** (Gateway REST) |
| `reconcile_legacy_split_conversation` | NO | **YES** | **YES** | NO | NO | NO | `conversations`, `messages` | NO |
| `create_session` | NO | **YES** | **YES** | NO | NO | NO | `whatsapp_sessions` | **YES** (Gateway REST) |
| `get_session_qr` | NO | **YES** | **YES** | NO | NO | NO | `whatsapp_sessions` | **YES** (Gateway REST) |
| `refresh_session_qr` | NO | **YES** | **YES** | NO | NO | NO | `whatsapp_sessions` | **YES** (Gateway REST) |
| `request_pairing_code` | NO | **YES** | **YES** | NO | NO | NO | `whatsapp_sessions` | **YES** (Gateway REST) |
| `logout_session` | NO | **YES** | **YES** | NO | NO | NO | `whatsapp_sessions` | **YES** (Gateway REST) |
| `delete_session` | NO | **YES** | **YES** | NO | NO | NO | `whatsapp_sessions`, `messages`, `conversations`, `contacts` | **YES** (Gateway REST) |
| `sync_contacts` | NO | **YES** | **YES** | NO | NO | NO | `contacts`, `whatsapp_sessions` | **YES** (Gateway REST) |
| `_gateway_op_or_mark_relink` | NO | **YES** | **YES** | NO | NO | NO | `whatsapp_sessions` | NO |

---

## 3. Gateway Transaction & Locking Matrix (`whatsapp-gateway/`)

| File / Component | Operation | SQL Pattern / Locking Semantics | Tables Touched | Isolation Rationale |
|---|---|---|---|---|
| `postgres-event-outbox.js` | `enqueue()` | `INSERT INTO whatsapp_private.event_outbox ... ON CONFLICT (event_id) DO NOTHING` | `event_outbox` | Idempotent insertion of encrypted event. |
| `postgres-event-outbox.js` | `claimPending()` | `WITH claimed AS (SELECT sequence FROM event_outbox WHERE state IN ('PENDING', 'IN_FLIGHT') AND next_attempt_at <= NOW() ORDER BY ... FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE ... SET state = 'IN_FLIGHT' RETURNING ...` | `event_outbox` | **FOR UPDATE SKIP LOCKED**: Prevents duplicate claims across concurrent gateway instances. |
| `postgres-event-outbox.js` | `acknowledge()` | `UPDATE event_outbox SET state = 'DELIVERED', delivered_at = NOW() WHERE event_id = $1` | `event_outbox` | Marks event as permanently processed upon backend ACK. |
| `postgres-event-outbox.js` | `reject()` / `nack()` | `UPDATE event_outbox SET state = CASE WHEN $2 OR attempts >= 10 THEN 'DEAD_LETTER' ELSE 'PENDING' END, next_attempt_at = ...` | `event_outbox` | Exponential backoff retry or terminal dead letter routing. |
| `postgres-event-outbox.js` | `requeueInflight()`| `UPDATE event_outbox SET state = 'PENDING', next_attempt_at = NOW() WHERE state = 'IN_FLIGHT'` | `event_outbox` | Resets abandoned in-flight events when event bridge reconnects. |
| `postgres-session-lease.js` | `acquire()` | `INSERT INTO socket_leases (...) VALUES (...) ON CONFLICT (session_id) DO UPDATE SET ... WHERE expires_at <= NOW() OR instance_id = EXCLUDED.instance_id` | `socket_leases` | Distributed lock: only one gateway instance can open a Baileys socket for a given WhatsApp account. |
| `postgres-auth-repository.js`| `setSignalKeys()` | `BEGIN ... INSERT / UPDATE signal_keys ... COMMIT` | `signal_keys` | Atomic persistence of Signal Protocol pre-keys and session state on dedicated pool client. |

---

## 4. In-Memory Concurrency Controls

In addition to PostgreSQL transaction boundaries, `whatsapp_service.py` enforces application-level concurrency control:
1. `_conversation_locks: Dict[str, asyncio.Lock]`:
   - Keyed by `f"{user_id}:{jid}"`.
   - Protects `_ingest_message`, `send_text_message`, `send_media_message`, and `reconcile_legacy_split_conversation`.
   - Prevents race conditions between concurrent inbound message ingestion and outbound message creation targeting the same contact.
2. `_sync_lock: asyncio.Lock`:
   - Serializes contact and conversation bulk synchronization per session.
3. `_initial_sync_inflight: Set[str]`:
   - Prevents duplicate background sync worker jobs for the same tenant.
