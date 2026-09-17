# Phase 10.11 — Runtime Query Profiling & Database Baseline

**Date:** 2026-09-17  
**Host:** Production Oracle VM (`ubuntu@130.162.247.20`)  
**Database:** PostgreSQL 16 on Docker (`tezlify-db`)  
**Status:** `BASELINE_COLLECTED`

---

## 1. Runtime Telemetry Availability

A read-only inspection was executed on the production database to verify query performance extensions:

```sql
SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements';
-- Result: (0 rows)

SELECT extname, extversion FROM pg_extension;
-- Result:
--   extname  | extversion 
-- -----------+------------
--  plpgsql   | 1.0
--  uuid-ossp | 1.1
--  pgcrypto  | 1.3
```

- **`pg_stat_statements`:** Not loaded in `pg_extension`. Per Hard Safety Rules (§1: no speculative extensions or new infra), runtime query profiling is conducted using PostgreSQL cumulative performance views (`pg_stat_database`, `pg_stat_user_tables`, `pg_stat_user_indexes`, `pg_statio_user_tables`), real-time `EXPLAIN (ANALYZE, BUFFERS)` execution traces, and targeted query profiling.
- **Application Latency Telemetry:** Access logs reflect standard uvicorn HTTP access format (`"GET /health HTTP/1.1" 200 OK`) without per-request execution duration stamps.
- **Status:** `APPLICATION_LATENCY_TELEMETRY_UNAVAILABLE`. Per Section 10 rules, numbers are not fabricated.

---

## 2. Database-Level Performance Metrics (`pg_stat_database`)

```sql
SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted 
FROM pg_stat_database WHERE datname = 'tezlify';
```

| Metric | Value | Interpretation |
| :--- | :--- | :--- |
| **Connected Backends** | 4 | Healthy pool connection baseline |
| **Transactions Committed** | 454,378 | Production transaction volume |
| **Transactions Rolled Back** | 2,187,244 | High frequency status/health check poll rollbacks |
| **Blocks Hit (Cache)** | 1,461,856,664 | Exceptional buffer cache efficiency |
| **Blocks Read (Disk)** | 5,398 | Minimal disk I/O |
| **Buffer Cache Hit Ratio** | **99.9996%** | Data is almost entirely served from RAM |
| **Tuples Returned** | 2,587,853,038 | Scanned rows across all operations |
| **Tuples Fetched** | 1,356,985,010 | Successfully matched/fetched rows |
| **Tuples Inserted** | 9,673,865 | Event ingestion and message activity |
| **Tuples Updated** | 4,657,139 | Outbox and ACK status state transitions |
| **Tuples Deleted** | 9,623,778 | Event outbox cleanup lifecycle |

---

## 3. Table Activity & Scan Distribution (`pg_stat_user_tables`)

Sorted by sequential tuples read (`seq_tup_read DESC`):

| Schema | Table | Seq Scans | Seq Tuples Read | Index Scans | Index Tuples Fetched | Inserts | Updates | Deletes | Live Tuples | Dead Tuples |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `whatsapp_private` | `event_outbox` | 16,138 | 877,237,001 | 3,189,477 | 1,262,126,503 | 81,633 | 4,587,791 | 84,277 | 3,397 | 471 |
| `public` | `messages` | 9,895 | 223,050,934 | 1,032,877 | 78,677,846 | 25,413 | 51 | 34,770 | 0 | 0 |
| `public` | `contacts` | 13,332 | 23,203,551 | 134,886 | 1,505,220 | 335 | 1,038 | 692 | 1,430 | 0 |
| `public` | `conversations` | 53,991 | 16,139,652 | 1,409 | 133,251 | 351 | 863 | 692 | 0 | 0 |
| `whatsapp_private` | `signal_keys` | 495 | 926,458 | 54,294 | 104,065 | 2,842 | 50,651 | 10,967 | 0 | 0 |
| `whatsapp_private` | `processed_events` | 14 | 765,426 | 136,721 | 74,103 | 63,592 | 0 | 0 | 67,178 | 0 |
| `public` | `whatsapp_sessions` | 155,499 | 533,813 | 0 | 0 | 3 | 2,185 | 4 | 3 | 42 |
| `whatsapp_private` | `gateway_sessions` | 84,546 | 388,620 | 4 | 1 | 3 | 6 | 0 | 3 | 6 |
| `public` | `auth_staging_sessions`| 4,259 | 44,378 | 444 | 444 | 45 | 2,287 | 13 | 28 | 32 |
| `whatsapp_private` | `socket_leases` | 7,534 | 7,340 | 380 | 363 | 17 | 7,200 | 17 | 0 | 21 |
| `public` | `profiles` | 2,123 | 6,365 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `public` | `scraper_jobs` | 19 | 1,211 | 0 | 0 | 2 | 4 | 0 | 2 | 4 |
| `public` | `auth_staging_users` | 59 | 167 | 2,181 | 2,176 | 4 | 0 | 1 | 3 | 1 |

---

## 4. Top Index Utilization (`pg_stat_user_indexes`)

Sorted by scan volume (`idx_scan DESC`):

| Schema | Table | Index Name | Index Scans | Tuples Read | Tuples Fetched | Primary Use Case |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `whatsapp_private` | `event_outbox` | `event_outbox_pkey` | 3,017,240 | 1,275,698,408 | 1,261,821,537 | Outbox ID lookup & lock |
| `public` | `messages` | `ix_messages_conversation_id` | 1,028,801 | 128,404,421 | 13,113,809 | Conversation message queries |
| `whatsapp_private` | `event_outbox` | `event_outbox_event_id_key` | 154,142 | 252,855 | 119,857 | Event deduplication |
| `whatsapp_private` | `processed_events` | `processed_events_pkey` | 136,523 | 9,110 | 7,837 | Idempotency verification |
| `public` | `contacts` | `ix_contacts_phone_e164` | 134,850 | 435,914 | 17,379 | Contact phone lookup |
| `whatsapp_private` | `signal_keys` | `signal_keys_pkey` | 54,294 | 104,184 | 103,434 | Baileys cryptographic auth |
| `whatsapp_private` | `event_outbox` | `ix_wa_outbox_pending` | 18,027 | 88,652 | 32,618 | Outbox worker poll |
| `public` | `messages` | `ix_messages_direction` | 3,983 | 20,799,970 | 16,689,768 | Directional filtering |
| `public` | `auth_staging_users` | `auth_staging_users_pkey` | 2,152 | 2,149 | 2,149 | Tenant user lookup |
| `public` | `conversations` | `ix_conversations_session_id` | 1,401 | 127,115 | 123,961 | Session-scoped chats |

---

## 5. Storage Footprint

| Schema | Table | Total Size | Table Data | Index Size |
| :--- | :--- | :--- | :--- | :--- |
| `whatsapp_private` | `event_outbox` | 63 MB | 26 MB | 37 MB |
| `whatsapp_private` | `signal_keys` | 10,192 kB | 0 bytes | 10,192 kB |
| `whatsapp_private` | `processed_events` | 8,048 kB | 3,576 kB | 4,472 kB |
| `public` | `messages` | 6,080 kB | 0 bytes | 6,080 kB |
| `public` | `contacts` | 816 kB | 304 kB | 512 kB |
| `public` | `conversations` | 424 kB | 0 bytes | 424 kB |
| `public` | `leads` | 320 kB | 8,192 bytes | 312 kB |
| `public` | `whatsapp_sessions` | 264 kB | 8,192 bytes | 256 kB |

---

## 6. Query Analysis & Profiling

### Query Profile Group Classification
```
A. WhatsApp conversations: list_conversations, get_conversation_counts, get_conversation_metadata
B. WhatsApp messages: list_messages, sync_conversation_messages
C. WhatsApp history/sync: _map_conversation_event, _repair_last_message_previews
D. ACK/status updates: message_status_updated, _find_whatsapp_conversation
E. Campaign execution: campaign runner worker
F. Leads/blacklist: lead deduplication, phone normalization
G. Authentication: session token verification
H. Analytics/dashboard: stats aggregation
I. Event outbox: outbox poller, outbox dispatch, outbox cleanup
J. processed_events: idempotency key verification
K. Other: health probes
```

### Targeted Forensic Profile & EXPLAIN Plans

#### 1. Candidate 1: Redundant `Conversation` SELECT in `message_status_updated`
- **Location:** `backend/app/services/whatsapp_service.py` (L3803–L3814)
- **Classification:** D. ACK/status updates
- **Pattern:**
  ```python
  # Current:
  msg_res = await db.execute(
      select(Message).join(Conversation, Message.conversation_id == Conversation.id).where(...)
  )
  matching_msg = msg_res.scalars().first()
  if matching_msg:
      conv = await db.get(Conversation, matching_msg.conversation_id)  # <-- EXTRA QUERY
  ```
- **Cost:** Forces 2 roundtrips (1 join query + 1 single PK fetch) on every ACK/status update event.
- **Optimization:** Select `(Message, Conversation)` in the initial joined query.
- **EXPLAIN (ANALYZE, BUFFERS) for Combined Projection:**
  ```text
  Nested Loop  (cost=0.00..0.01 rows=1 width=8) (actual time=0.014..0.015 rows=0 loops=1)
    Join Filter: (messages.conversation_id = conversations.id)
    ->  Seq Scan on messages  (cost=0.00..0.00 rows=1 width=8)
    ->  Seq Scan on conversations  (cost=0.00..0.00 rows=1 width=4)
  Planning Time: 4.592 ms
  Execution Time: 0.127 ms
  ```
- **Benefit:** Completely eliminates the second roundtrip `SELECT ... FROM conversations WHERE id = :id`.

#### 2. Candidate 2: Two-Step Lookup in `_find_whatsapp_conversation`
- **Location:** `backend/app/services/whatsapp_service.py` (L3714–L3725)
- **Classification:** D. ACK/status updates / C. WhatsApp history
- **Pattern:**
  ```python
  # Current:
  contact_id = await db.scalar(select(Contact.id).where(Contact.phone_e164 == phone, ...))
  if contact_id is None:
      return None
  filters = _conversation_scope_filters(user_id, contact_id, session_id)
  res = await db.execute(select(Conversation).where(*filters)...)
  ```
- **Cost:** Every presence, read, or status event performs 2 sequential database queries.
- **Optimization:** Single combined query with outer join:
  `select(Contact.id, Conversation).outerjoin(Conversation, ...).where(Contact.phone_e164 == phone, ...)`
- **EXPLAIN (ANALYZE, BUFFERS) Before (Query 1):**
  ```text
  Index Scan using uq_contact_user_phone on contacts (cost=0.28..2.50 rows=1 width=4)
  Planning Time: 1.415 ms | Execution Time: 0.064 ms
  -- Followed by Conversation query (Planning ~4.6ms + Exec ~0.1ms)
  Total: 2 roundtrips, ~6.1ms overhead
  ```
- **EXPLAIN (ANALYZE, BUFFERS) After (Single Joined Query):**
  ```text
  Nested Loop Left Join (cost=0.28..2.51 rows=1 width=8) (actual time=0.025..0.025 rows=0 loops=1)
    Join Filter: (conversations.contact_id = contacts.id)
    ->  Index Scan using uq_contact_user_phone on contacts (cost=0.28..2.50 rows=1 width=20)
    ->  Seq Scan on conversations (never executed if contact missing)
  Planning Time: 4.619 ms | Execution Time: 0.114 ms
  Total: 1 roundtrip, ~4.7ms total overhead (23% planning/latency reduction)
  ```
- **Benefit:** Halves the roundtrips and queries for all status/read/presence event resolution paths.

#### 3. Candidate 3: Subquery Table Scan in `list_conversations`
- **Location:** `backend/app/services/whatsapp_service.py` (L1640–L1648)
- **Classification:** A. WhatsApp conversations
- **Pattern:**
  ```python
  # Current:
  junk_contacts = select(Contact.id).where(or_(
      Contact.phone_e164 == "status",
      Contact.phone_e164 == "broadcast",
      Contact.phone_e164.like("%@broadcast%"),
      Contact.phone_e164.like("%@newsletter%"),
  ))
  base = base.where(~Conversation.contact_id.in_(junk_contacts))
  ```
- **EXPLAIN (ANALYZE, BUFFERS) Before:**
  ```text
  Limit  (cost=66.61..66.62 rows=1 width=144)
    ->  Sort  (cost=66.61..66.62 rows=1 width=144)
          ->  Seq Scan on conversations  (cost=66.60..66.60 rows=1 width=144)
                Filter: ((NOT (ANY (contact_id = (hashed SubPlan 1).col1))) ...)
                SubPlan 1
                  ->  Seq Scan on contacts  (cost=0.00..66.60 rows=2 width=4)
  Planning Time: 3.966 ms
  Execution Time: 0.164 ms
  Estimated Cost: 66.62
  ```
- **Analysis:** `NOT IN (Subquery)` forces PostgreSQL to run a sequential scan on all rows of the `contacts` table to build a hash table (`hashed SubPlan 1`). This is executed TWICE per conversation listing (once for count, once for rows).
- **Optimization:** Rewrite as correlated `NOT EXISTS`:
  ```python
  junk_contacts = select(1).where(
      Contact.id == Conversation.contact_id,
      or_(
          Contact.phone_e164 == "status",
          Contact.phone_e164 == "broadcast",
          Contact.phone_e164.like("%@broadcast%"),
          Contact.phone_e164.like("%@newsletter%"),
      ),
  )
  base = base.where(~junk_contacts.exists())
  ```
- **EXPLAIN (ANALYZE, BUFFERS) After:**
  ```text
  Limit  (cost=4.74..4.75 rows=1 width=144)
    ->  Sort  (cost=4.74..4.75 rows=1 width=144)
          ->  Nested Loop Anti Join  (cost=0.28..4.73 rows=1 width=144)
                ->  Seq Scan on conversations  (cost=0.00..0.00 rows=1 width=144)
                ->  Index Scan using contacts_pkey on contacts  (cost=0.28..2.51 rows=1 width=4)
                      Index Cond: (id = conversations.contact_id)
  Planning Time: 4.346 ms
  Execution Time: 0.330 ms
  Estimated Cost: 4.75 (92.8% planner cost reduction)
  ```
- **Benefit:** Replaces full-table sequential scan on `contacts` with direct primary key index lookup (`contacts_pkey`) via `Nested Loop Anti Join`.

---

## 7. Cost Model Ranking & Candidate Selection

| Rank | Query / Path | Source Function | Root Cause | Frequency / Path | Optimization Candidate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `message_status_updated` | `_map_conversation_event` | Redundant second `Conversation` query after join | HIGH_FREQUENCY / ACK stream | **Candidate 1: Joint projection** |
| **2** | `_find_whatsapp_conversation` | `_find_whatsapp_conversation` | 2 sequential queries (`Contact.id` then `Conversation`) | HIGH_FREQUENCY / Presence & ACK | **Candidate 2: Outer-joined lookup** |
| **3** | `list_conversations` | `list_conversations` | `NOT IN (SubPlan)` forces full `contacts` seq scan | HIGH_TOTAL_COST / User-facing read | **Candidate 3: Correlated NOT EXISTS** |
