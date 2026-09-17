# Phase 10.11 — Runtime Query Profiling & Data-Driven Performance Optimization Report

**Date:** 2026-09-17  
**Local Environment:** `/Users/isatezcan/Documents/Github/Scoutify`  
**Production Host:** `ubuntu@130.162.247.20:/opt/tezlify`  
**Deployment SHA:** `b319bb4d5af75a9bf1d8033dc1a4bfe939101893`  
**Final Status:** `PHASE_10_11_OPTIMIZATION_COMPLETE`

---

## 1. Runtime Telemetry Availability

An empirical read-only check on the production PostgreSQL engine (`tezlify-db`) was performed:

```sql
SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements';
-- Output: (0 rows)

SELECT extname, extversion FROM pg_extension;
-- Output:
--   extname  | extversion 
-- -----------+------------
--  plpgsql   | 1.0
--  uuid-ossp | 1.1
--  pgcrypto  | 1.3
```

- **`pg_stat_statements` Availability:** Not installed in `pg_extension`. Per Hard Safety Rules (§1: no speculative extensions or schema changes), runtime profiling was conducted using PostgreSQL native performance views (`pg_stat_database`, `pg_stat_user_tables`, `pg_stat_user_indexes`, `pg_statio_user_tables`) combined with read-only execution plan analysis (`EXPLAIN (ANALYZE, BUFFERS)`).
- **Application Latency Telemetry:** Access logs reflect standard uvicorn HTTP logs without per-request execution duration stamps.
- **Classification:** `APPLICATION_LATENCY_TELEMETRY_UNAVAILABLE` (recorded transparently without speculative metrics).

---

## 2. Table-Level Activity & Scan Distribution Baseline

From production `pg_stat_user_tables` (sorted by `seq_tup_read DESC`):

| Rank | Schema | Table | Seq Scans | Seq Tuples Read | Index Scans | Index Tuples Fetched | Inserts | Updates | Deletes | Live Tuples | Dead Tuples |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `whatsapp_private` | `event_outbox` | 16,138 | 877,237,001 | 3,189,477 | 1,262,126,503 | 81,633 | 4,587,791 | 84,277 | 3,397 | 471 |
| 2 | `public` | `messages` | 9,895 | 223,050,934 | 1,032,877 | 78,677,846 | 25,413 | 51 | 34,770 | 0 | 0 |
| 3 | `public` | `contacts` | 13,332 | 23,203,551 | 134,886 | 1,505,220 | 335 | 1,038 | 692 | 1,430 | 0 |
| 4 | `public` | `conversations` | 53,991 | 16,139,652 | 1,409 | 133,251 | 351 | 863 | 692 | 0 | 0 |
| 5 | `whatsapp_private` | `signal_keys` | 495 | 926,458 | 54,294 | 104,065 | 2,842 | 50,651 | 10,967 | 0 | 0 |
| 6 | `whatsapp_private` | `processed_events` | 14 | 765,426 | 136,721 | 74,103 | 63,592 | 0 | 0 | 67,178 | 0 |
| 7 | `public` | `whatsapp_sessions` | 155,499 | 533,813 | 0 | 0 | 3 | 2,185 | 4 | 3 | 42 |
| 8 | `whatsapp_private` | `gateway_sessions` | 84,546 | 388,620 | 4 | 1 | 3 | 6 | 0 | 3 | 6 |
| 9 | `public` | `auth_staging_sessions` | 4,259 | 44,378 | 444 | 444 | 45 | 2,287 | 13 | 28 | 32 |
| 10 | `whatsapp_private` | `socket_leases` | 7,534 | 7,340 | 380 | 363 | 17 | 7,200 | 17 | 0 | 21 |
| 11 | `public` | `profiles` | 2,123 | 6,365 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 12 | `public` | `scraper_jobs` | 19 | 1,211 | 0 | 0 | 2 | 4 | 0 | 2 | 4 |
| 13 | `public` | `auth_staging_users` | 59 | 167 | 2,181 | 2,176 | 4 | 0 | 1 | 3 | 1 |
| 14 | `public` | `auth_staging_oauth_states` | 14 | 156 | 16 | 16 | 37 | 6 | 0 | 37 | 6 |
| 15 | `public` | `system_settings` | 32 | 64 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 16 | `public` | `auth_staging_oauth_accounts` | 38 | 46 | 6 | 4 | 2 | 0 | 0 | 2 | 0 |
| 17 | `whatsapp_private` | `session_credentials` | 340 | 34 | 163 | 161 | 2 | 158 | 4 | 0 | 16 |
| 18 | `public` | `leads` | 2,253 | 6 | 896 | 5 | 3 | 0 | 0 | 3 | 0 |
| 19 | `public` | `message_logs` | 888 | 4 | 881 | 1 | 2 | 0 | 0 | 2 | 0 |
| 20 | `whatsapp_private` | `retry_messages` | 619 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

---

## 3. Top Index Utilization Baseline

From production `pg_stat_user_indexes` (sorted by `idx_scan DESC`):

| Rank | Schema | Table | Index Name | Index Scans | Tuples Read | Tuples Fetched | Primary Access Path |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `whatsapp_private` | `event_outbox` | `event_outbox_pkey` | 3,017,240 | 1,275,698,408 | 1,261,821,537 | Outbox worker claim & lock |
| 2 | `public` | `messages` | `ix_messages_conversation_id` | 1,028,801 | 128,404,421 | 13,113,809 | Keyset message paging & counts |
| 3 | `whatsapp_private` | `event_outbox` | `event_outbox_event_id_key` | 154,142 | 252,855 | 119,857 | Event deduplication |
| 4 | `whatsapp_private` | `processed_events` | `processed_events_pkey` | 136,523 | 9,110 | 7,837 | Idempotency verification |
| 5 | `public` | `contacts` | `ix_contacts_phone_e164` | 134,850 | 435,914 | 17,379 | Phone lookup on event arrival |
| 6 | `whatsapp_private` | `signal_keys` | `signal_keys_pkey` | 54,294 | 104,184 | 103,434 | Signal key resolution |
| 7 | `whatsapp_private` | `event_outbox` | `ix_wa_outbox_pending` | 18,027 | 88,652 | 32,618 | Polling worker cursor |
| 8 | `public` | `messages` | `ix_messages_direction` | 3,983 | 20,799,970 | 16,689,768 | Directional analytics |
| 9 | `public` | `auth_staging_users` | `auth_staging_users_pkey` | 2,152 | 2,149 | 2,149 | User authentication |
| 10 | `public` | `conversations` | `ix_conversations_session_id` | 1,401 | 127,115 | 123,961 | Session-scoped chats |
| 11 | `public` | `message_logs` | `ix_message_logs_status` | 881 | 1 | 0 | Dispatch queue polling |
| 12 | `public` | `leads` | `ix_leads_status` | 588 | 0 | 0 | Lead status filters |
| 13 | `public` | `campaigns` | `ix_campaigns_status` | 443 | 0 | 0 | Campaign runner checks |
| 14 | `whatsapp_private` | `socket_leases` | `socket_leases_pkey` | 380 | 376 | 363 | Gateway lock management |
| 15 | `public` | `auth_staging_sessions` | `auth_staging_sessions_session_token_hash_key` | 224 | 224 | 224 | Session token lookup |
| 16 | `public` | `auth_staging_sessions` | `auth_staging_sessions_pkey` | 220 | 220 | 220 | Session ID lookup |
| 17 | `whatsapp_private` | `processed_events` | `ix_wa_processed_event_expiry` | 198 | 536,105 | 66,266 | Idempotency record cleanup |
| 18 | `whatsapp_private` | `session_credentials` | `session_credentials_pkey` | 163 | 162 | 161 | Auth credentials fetch |
| 19 | `public` | `leads` | `idx_lead_status_created` | 155 | 3 | 0 | Lead pagination ordering |
| 20 | `public` | `leads` | `idx_leads_whatsapp_eligible` | 150 | 0 | 0 | WhatsApp outreach qualification |

---

## 4. Classification of Major Cost Centers

```text
A. WhatsApp conversations: list_conversations, get_conversation_metadata
   -> High user-facing volume. Impacted by contact filtering subqueries.
B. WhatsApp messages: list_messages, get_messages (keyset pagination)
   -> 1.03M index scans on ix_messages_conversation_id. Highly efficient index usage.
C. WhatsApp history/sync: _map_conversation_event, _repair_last_message_previews
   -> Bulk ingest from gateway event bridge.
D. ACK/status updates: message_status_updated, _find_whatsapp_conversation
   -> High-frequency stream (delivery receipts, read receipts, outbound acks).
E. Event outbox: event_outbox workers (3.01M pkey scans, 4.58M updates).
F. Leads/CRM: lead deduplication, phone normalization, campaign group memberships.
G. Authentication: session validation and token verification.
```

---

## 5. EXPLAIN Findings & Candidate Bottlenecks

### Candidate 1: Duplicate `Conversation` Lookup in `message_status_updated`
- **Source:** [`whatsapp_service.py:L3803-L3814`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_service.py#L3803-L3814)
- **Problem:** For every inbound ACK/status event, the service joined `Message` and `Conversation` to find the matching message, but then immediately issued a second query: `conv = await db.get(Conversation, matching_msg.conversation_id)`.
- **EXPLAIN (ANALYZE, BUFFERS):**
  - Query 1 (Join): `Nested Loop (cost=0.00..0.01 rows=1)` | Execution Time: 0.127 ms
  - Query 2 (PK Fetch): Extra roundtrip `SELECT ... FROM conversations WHERE id = :id`
- **Total Overhead:** 2 sequential roundtrips per message status event.

### Candidate 2: Two-Step Lookup in `_find_whatsapp_conversation`
- **Source:** [`whatsapp_service.py:L3714-L3725`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_service.py#L3714-L3725)
- **Problem:** Presence, read, and fallback status updates executed `select(Contact.id)` followed by `select(Conversation).where(*filters)`.
- **EXPLAIN (ANALYZE, BUFFERS):**
  - Step 1: `Index Scan using uq_contact_user_phone on contacts (cost=0.28..2.50 rows=1)` | Planning: 1.415 ms
  - Step 2: `Seq Scan on conversations` | Planning: ~4.6 ms
  - Total: 2 sequential roundtrips (~6.1 ms planning overhead).

### Candidate 3: Unindexed Subquery Sequential Scan in `list_conversations`
- **Source:** [`whatsapp_service.py:L1640-L1648`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_service.py#L1640-L1648)
- **Problem:** `NOT IN (SELECT Contact.id WHERE phone_e164 LIKE '%@broadcast%'...)` forced PostgreSQL to perform a full sequential scan on all 1,430 rows of `contacts` to build a hash table (`hashed SubPlan 1`). This was executed twice per listing (count query + data fetch).
- **EXPLAIN (ANALYZE, BUFFERS) Before:**
  ```text
  Limit (cost=66.61..66.62 rows=1 width=144)
    -> Sort (cost=66.61..66.62 rows=1 width=144)
      -> Seq Scan on conversations (cost=66.60..66.60 rows=1 width=144)
           Filter: ((NOT (ANY (contact_id = (hashed SubPlan 1).col1))) ...)
           SubPlan 1
             -> Seq Scan on contacts (cost=0.00..66.60 rows=2 width=4)
  Estimated Cost: 66.62
  ```
- **EXPLAIN (ANALYZE, BUFFERS) After (Correlated NOT EXISTS with Aliased Contact):**
  ```text
  Limit (cost=4.74..4.75 rows=1 width=144)
    -> Sort (cost=4.74..4.75 rows=1 width=144)
      -> Nested Loop Anti Join (cost=0.28..4.73 rows=1 width=144)
           -> Seq Scan on conversations (cost=0.00..0.00 rows=1 width=144)
           -> Index Scan using contacts_pkey on contacts (cost=0.28..2.51 rows=1 width=4)
                Index Cond: (id = conversations.contact_id)
  Estimated Cost: 4.75 (92.8% planner cost reduction)
  ```

---

## 6. Applied Optimizations (Max 3 Groups)

### Optimization Group 1: Joint `(Message, Conversation)` Projection
- **File:** [`backend/app/services/whatsapp_service.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_service.py)
- **Change:** Projected both `Message` and `Conversation` in `select(Message, Conversation).join(...)`. Extracted `matching_msg, conv = first_pair`, completely eliminating `await db.get(Conversation, matching_msg.conversation_id)`.
- **Impact:** `STATIC_QUERY_REDUCTION` (1 roundtrip eliminated per ACK/status event).

### Optimization Group 2: Single Outer-Joined Conversation Lookup
- **File:** [`backend/app/services/whatsapp_service.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_service.py)
- **Change:** Combined the separate `Contact.id` scalar lookup and `Conversation` query into a single outer-joined query: `select(Contact.id, Conversation).outerjoin(Conversation, ...).where(Contact.phone_e164 == phone, ...)`.
- **Impact:** `STATIC_QUERY_REDUCTION` (halved the roundtrips and queries for status/read/presence event resolution).

### Optimization Group 3: Correlated `NOT EXISTS` with `aliased(Contact)`
- **File:** [`backend/app/services/whatsapp_service.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/app/services/whatsapp_service.py)
- **Change:** Replaced the `~Conversation.contact_id.in_(junk_contacts_subquery)` full-table sequential scan with `junk_contact_alias = aliased(Contact)` and `~junk_contacts.exists()`.
- **Impact:** `STATIC_QUERY_REDUCTION` + 92.8% PostgreSQL planner cost reduction (cost 66.62 -> 4.75), converting sequential table scans into primary-key index anti-joins.

---

## 7. Automated Test & Regression Verification

### 1. Targeted Regression Suite
Created [`backend/tests/test_phase_10_11_profiling_optimizations.py`](file:///Users/isatezcan/Documents/Github/Scoutify/backend/tests/test_phase_10_11_profiling_optimizations.py):
- `test_opt1_message_status_updated_joint_projection`: Confirmed `db.get(Conversation)` is bypassed and status updates persist correctly.
- `test_opt2_find_whatsapp_conversation_outer_joined`: Confirmed single-query resolution across matching, missing, wrong session, and tenant-isolated cases.
- `test_opt3_list_conversations_correlated_not_exists`: Confirmed broadcast/newsletter exclusions work without correlation collisions.

```bash
source venv/bin/activate && PYTHONPATH=. pytest backend/tests/test_phase_10_11_profiling_optimizations.py -v
# Result: 3 passed, 0 failures (0.42s)
```

### 2. Full Test Suite & Frontend Build
```bash
source venv/bin/activate && PYTHONPATH=. pytest backend/tests/ -q
# Result: 715 passed, 0 failures in 45.42s

cd frontend && npm run build
# Result: built in 1.56s (0 errors)
```

---

## 8. Production Deployment & Verification

### Deployment Log
- **Git Commit:** `b319bb4d5af75a9bf1d8033dc1a4bfe939101893`
- **Docker Build:** Rebuilt image `tezlify-backend:latest` on Oracle VM (`130.162.247.20`).
- **Container Lifecycle:** `docker compose -f docker-compose.prod.yml up -d --no-deps backend` (recreated cleanly).
- **Source Verification:** Verified running container executed code containing `aliased` in `list_conversations`.

### Post-Deployment Health Checks
1. **API Health Endpoint:**
   ```json
   {
     "status": "healthy",
     "service": "Tezlify Backend API",
     "version": "1.0.0",
     "memory_mb": 102.3,
     "gateway_bridge": {
       "connected": true,
       "last_connected_at": "2026-09-17T08:40:51.109700+00:00",
       "reconnect_count": 1
     }
   }
   ```
2. **Gateway WebSocket Bridge:** `connected: true`
3. **Database Connectivity:** Operational.
4. **WhatsApp Session State:** Read-only inspection verified:
   - Session 4: `SCAN_QR` (Preserved)
   - Session 5: `RELINK_REQUIRED` (Preserved)
   - Session 45: `SCAN_QR` (Preserved)
   - Mutations: Exactly 0.

### Post-Deployment Runtime Observation Note
Per Section 15 and 16 guidelines:
- **Status:** `POST_DEPLOY_RUNTIME_SAMPLE_INSUFFICIENT` / `NO_RUNTIME_PROOF_YET`.
- As deployment was completed minutes ago, production traffic sample size is insufficient to assert cumulative runtime time differences.
- The optimizations are verified as `STATIC_QUERY_REDUCTION` and query plan cost reductions via `EXPLAIN (ANALYZE, BUFFERS)`.

---

## 9. Phase 10.8 Long-Run Observation Status

The independent 48-hour reliability observation suite continues uninterrupted:
- `tezlify-wa-observer.timer`: `active`
- `tezlify-monitor.timer`: `active`
- Observation files:
  - `/opt/tezlify/runtime/database-reliability/observations.jsonl`: 5 records
  - `/opt/tezlify/runtime/whatsapp-reliability/observations.jsonl`: 224 records
- Status: **`PHASE_10_8 = INSUFFICIENT_OBSERVATION`** (untouched per Section 17 rules).

---

## 10. Summary & Sign-Off

All hard safety invariants were strictly respected: zero session mutations, zero QR resets, zero schema changes, zero speculative indexes. All 3 high-confidence optimizations were verified by unit and integration tests (715 passing), deployed to production, and confirmed live.

**Final Status:** `PHASE_10_11_OPTIMIZATION_COMPLETE`
