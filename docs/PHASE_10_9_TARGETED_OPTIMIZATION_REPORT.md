# Phase 10.9 Targeted Production Optimization & Safe Performance Improvements Report

**Phase:** `Phase 10.9 — Targeted Production Optimization & Safe Performance Improvements`  
**Execution Timestamp:** 2026-09-17 08:15 UTC (`11:15 UTC+3`)  
**Target Environments:**
- Local Workspace: `/Users/isatezcan/Documents/Github/Scoutify`
- Production Host: Oracle Cloud VM `130.162.247.20` (`/opt/tezlify`)
**Status:** `PHASE_10_9_OPTIMIZATION_COMPLETE`  
**Phase 10.8 Status:** `INSUFFICIENT_OBSERVATION` (Independent 48h observation window continues running in parallel)

---

## 1. Baseline

A forensic pre-optimization snapshot was captured from PostgreSQL catalog views (`pg_stat_user_tables`) at `2026-09-17 08:04:45 UTC`:

| Relation | Live Tuples | Dead Tuples | Inserts | Updates | Deletes | HOT Updates | Seq Scans | Index Scans | Index Fetches | Total Size |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `whatsapp_private.event_outbox` | 3,406 | 462 | 81,633 | 4,587,791 | 84,268 | 0 | 16,121 | 3,188,928 | 1,262,112,697 | 62.8 MB |
| `whatsapp_private.signal_keys` | 0 | 0 | 2,842 | 50,651 | 10,967 | 50,598 | 495 | 54,294 | 104,065 | 10.0 MB |
| `whatsapp_private.processed_events`| 67,178 | 0 | 63,592 | 0 | 0 | 0 | 14 | 136,714 | 65,645 | 7.9 MB |
| `public.messages` | 0 | 0 | 25,413 | 51 | 34,770 | 3 | 9,891 | 1,032,877 | 78,677,846 | 5.9 MB |
| `public.contacts` | 1,430 | 0 | 335 | 1,038 | 692 | 921 | 13,325 | 134,885 | 1,505,220 | 816 KB |
| `public.conversations` | 0 | 0 | 351 | 863 | 692 | 11 | 53,983 | 1,409 | 133,251 | 424 KB |
| `public.whatsapp_sessions` | 3 | 42 | 3 | 2,185 | 4 | 1,517 | 155,482 | 0 | 0 | 264 KB |
| `whatsapp_private.socket_leases` | 0 | 21 | 17 | 7,200 | 17 | 7,200 | 7,518 | 380 | 363 | 64 KB |
| `public.auth_staging_sessions` | 28 | 32 | 45 | 2,287 | 13 | 2,287 | 4,259 | 444 | 444 | 40 KB |

---

## 2. Candidate Optimization List

From the source-level AST and hot-path audit, five potential candidate areas were analyzed:

1. **Candidate Group 1: Outbound ACK Duplicate Query Elimination (`message_status_updated`)**
   - *Evidence:* In `backend/app/services/whatsapp_service.py:_map_conversation_event`, `matching_msg` is resolved at line 3789 to obtain `conv.id`. Then, at line 3868, an identical `select(Message)` query was executed with the exact same predicates (`wa_message_id`, `client_message_id`, `conv.id`).
   - *Current cost:* 1 redundant SQL round-trip per outbound delivery acknowledgment event.
   - *Expected benefit:* Eliminates 1 duplicate SELECT per ACK event (~50% query reduction on this event path).
   - *Risk:* LOW.
   - *Decision:* **APPLY**

2. **Candidate Group 2: Elimination of Redundant Post-Commit `db.refresh()` Calls**
   - *Evidence:* In `backend/app/core/database.py`, `expire_on_commit=False` is explicitly set on `AsyncSessionLocal`. In `whatsapp_service.py`, `send_text_message` (line 2158) and `send_media_message` (line 2228) called `await db.refresh(row)` immediately after `await db.commit()` and before `_serialize_message(row)`. Additionally, `_ingest_message` (line 3443) called `await db.refresh(row)` immediately after `await db.flush()`. Each refresh issues a `SELECT messages.* FROM messages WHERE id = :id`.
   - *Current cost:* 1–2 redundant SELECT queries per message lifecycle.
   - *Expected benefit:* Eliminates redundant round-trips; in-memory message object attributes are already populated.
   - *Risk:* LOW. (Note: pre-status-advance refresh after gateway call was preserved to protect against concurrent early ACK arrival tested in `test_whatsapp_races.py`).
   - *Decision:* **APPLY**

3. **Candidate Group 3: Campaign Runner Batch Blacklist Pre-Resolution & Lightweight Query**
   - *Evidence:* In `backend/app/services/campaign_runner.py`, `_execute_campaign_worker` looped over target leads (e.g. 50 leads) and called `OutreachManager.process_single_outreach`, which invoked `is_blacklisted(db, lead.phone_e164)` individually. Each check executed `select(Blacklist)` hydrating the full ORM entity, resulting in N database round-trips for N leads.
   - *Current cost:* N individual database queries per campaign execution batch.
   - *Expected benefit:* Pre-resolving candidate phones with `select(Blacklist.phone_e164).where(Blacklist.phone_e164.in_(phones))` replaces N queries with exactly 1 single batch query. Single-check query optimized from `select(Blacklist)` to `select(Blacklist.id).limit(1)`.
   - *Risk:* LOW.
   - *Decision:* **APPLY**

4. **Candidate Group 4: `processed_events` Atomic Upsert Transformation**
   - *Evidence:* Ingest currently does `SELECT 1 FROM processed_events WHERE event_id = :id` followed by processing, then `INSERT ... ON CONFLICT DO NOTHING`.
   - *Assessment:* Consolidating into a single speculative insert prior to message processing changes transaction rollback boundaries on `EventOwnerUnresolved` and partial commits.
   - *Decision:* **DEFERRED_HIGH_RISK** (Preserves fail-closed error boundaries).

5. **Candidate Group 5: Secondary Zero-Scan Index Dropping**
   - *Evidence:* 92 secondary indexes have `idx_scan = 0`.
   - *Assessment:* Phase 10.7 established that zero-scan indexes must not be removed without production query tracing.
   - *Decision:* **SKIP** (Rule 14/15 compliant).

---

## 3. Evidence for Selected Optimizations

### Optimization Group 1: Outbound ACK Duplicate Query Elimination
- In `backend/app/services/whatsapp_service.py` (`_map_conversation_event`):
  - Lines 3775–3791 resolve the conversation by looking up the message:
    ```python
    msg_res = await db.execute(
        select(Message).join(Conversation, Message.conversation_id == Conversation.id).where(...)
    )
    matching_msg = msg_res.scalars().first()
    if matching_msg:
        conv = await db.get(Conversation, matching_msg.conversation_id)
    ```
  - When lines 3863–3876 were reached for `message_status_updated`, `matching_msg` was discarded, and a new database query was executed:
    ```python
    res = await db.execute(select(Message).where(...))
    row = res.scalars().first()
    ```
  - **Correction Applied:** `row = matching_msg if matching_msg is not None else (fallback query)`.
  - **Verified Result:** Exactly 1 query eliminated per status update acknowledgment.

### Optimization Group 2: Elimination of Redundant Post-Commit `db.refresh()`
- `backend/app/core/database.py:51` establishes:
  ```python
  AsyncSessionLocal = async_sessionmaker(
      bind=engine,
      class_=AsyncSession,
      expire_on_commit=False,
      autocommit=False,
      autoflush=False,
  )
  ```
- Because `expire_on_commit=False`, calling `await db.commit()` does not evict instance state.
- In `send_text_message` (line 2158) and `send_media_message` (line 2228), `await db.refresh(row)` immediately followed `await db.commit()`.
- In `_ingest_message` (line 3443), `await db.refresh(row)` immediately followed `await db.flush()`.
- **Correction Applied:** Removed unnecessary `await db.refresh(row)` calls after commit/flush.
- **Race Protection Verified:** In `send_text_message` and `send_media_message`, `await db.refresh(row)` immediately after `_gateway_op_or_mark_relink` was retained to ensure concurrent early ACK mutations survive as verified by `test_pending_committed_before_provider_and_early_ack_survives`.

### Optimization Group 3: Campaign Batch Blacklist Pre-Resolution
- In `OutreachManager`:
  - Added `get_blacklisted_phones(db: AsyncSession, phones: list[str]) -> set[str]`.
  - Updated `is_blacklisted` to query `select(Blacklist.id).where(...).limit(1)` avoiding complete ORM entity hydration.
  - Updated `process_single_outreach` to accept optional `blacklisted_phones: Optional[set[str]]`.
- In `CampaignRunner`:
  - Pre-resolved target lead phone numbers in a single query prior to iterating:
    ```python
    candidate_phones = [l.phone_e164 for l in leads if l.phone_e164]
    blacklisted_phones = await OutreachManager.get_blacklisted_phones(db, candidate_phones)
    ```
  - Passed `blacklisted_phones` to `process_single_outreach`, reducing N queries to 1.

---

## 4. Exact Code Changes

### A. `backend/app/services/whatsapp_service.py`
```diff
@@ -2153,7 +2153,6 @@
         ),
     )
     await db.commit()
-    await db.refresh(row)
     return _serialize_message(row)
 
@@ -2222,7 +2221,6 @@
         ),
     )
     await db.commit()
-    await db.refresh(row)
     return _serialize_message(row)
 
@@ -3441,7 +3439,6 @@
     if direction == MessageDirection.INBOUND:
         conv.unread_count = (conv.unread_count or 0) + 1
     await db.flush()
-    await db.refresh(row)
 
     event["conversation_id"] = conv.id
     event["message"] = _serialize_message(row)
@@ -3775,6 +3772,7 @@
     elif evt_name == "message_status_updated":
         conv = None
+        matching_msg = None
         wa_id = event.get("wa_message_id")
         client_mid = event.get("client_message_id")
         if wa_id or client_mid:
@@ -3865,15 +3863,17 @@
         wa_id = event.get("wa_message_id")
         new_status = (event.get("status") or "").upper()
         if wa_id and new_status in ConversationMessageStatus.__members__:
-            res = await db.execute(
-                select(Message).where(
-                    or_(Message.wa_message_id == wa_id,
-                        Message.client_message_id == event["client_message_id"]
-                        if event.get("client_message_id") else False),
-                    Message.conversation_id == conv.id,
-                )
-            )
-            row = res.scalars().first()
+            # Reuse matching_msg if already resolved during conversation mapping; avoids redundant SELECT
+            row = matching_msg
+            if row is None:
+                res = await db.execute(
+                    select(Message).where(
+                        or_(Message.wa_message_id == wa_id,
+                            Message.client_message_id == event["client_message_id"]
+                            if event.get("client_message_id") else False),
+                        Message.conversation_id == conv.id,
+                    )
+                )
+                row = res.scalars().first()
```

### B. `backend/app/services/outreach_manager.py`
```diff
@@ -38,7 +38,16 @@
     @classmethod
     async def is_blacklisted(cls, db: AsyncSession, phone_e164: str) -> bool:
         """Checks if phone number is present in Blacklist."""
-        stmt = select(Blacklist).where(Blacklist.phone_e164 == phone_e164)
+        stmt = select(Blacklist.id).where(Blacklist.phone_e164 == phone_e164).limit(1)
+        result = await db.execute(stmt)
+        return result.scalar_one_or_none() is not None
+
+    @classmethod
+    async def get_blacklisted_phones(cls, db: AsyncSession, phones: list[str]) -> set[str]:
+        """Batch checks phone numbers against Blacklist in a single query."""
+        if not phones:
+            return set()
+        stmt = select(Blacklist.phone_e164).where(Blacklist.phone_e164.in_(phones))
         result = await db.execute(stmt)
-        return result.scalar_one_or_none() is not None
+        return set(result.scalars().all())
 
@@ -52,6 +61,7 @@
         session_id: Optional[int] = None,
         lead: Optional[Lead] = None,
         campaign: Optional[Campaign] = None,
+        blacklisted_phones: Optional[set[str]] = None,
     ) -> Tuple[bool, str, Optional[int]]:
@@ -71,4 +81,9 @@
-        # 2. Check Blacklist
-        if await cls.is_blacklisted(db, lead.phone_e164):
+        # 2. Check Blacklist (use batch pre-resolved set if provided, else single-query)
+        is_bl = (
+            lead.phone_e164 in blacklisted_phones
+            if blacklisted_phones is not None
+            else await cls.is_blacklisted(db, lead.phone_e164)
+        )
+        if is_bl:
             lead.status = LeadStatus.UNSUBSCRIBED
             await db.commit()
```

### C. `backend/app/services/campaign_runner.py`
```diff
@@ -162,6 +162,10 @@
                 policy = AntibanPolicy.from_campaign(campaign)
                 was_stopped_early = False
 
+                # Campaign-scoped batch blacklist pre-resolution: 1 query instead of N per-lead queries
+                candidate_phones = [l.phone_e164 for l in leads if l.phone_e164]
+                blacklisted_phones = await OutreachManager.get_blacklisted_phones(db, candidate_phones)
+
                 for idx, lead in enumerate(leads):
@@ -172,7 +176,8 @@
                     success, msg, log_id = await OutreachManager.process_single_outreach(
                         db=db,
                         lead_id=lead.id,
                         campaign_id=campaign.id,
                         lead=lead,
                         campaign=campaign,
+                        blacklisted_phones=blacklisted_phones,
                     )
```

---

## 5. Before / After Metrics

### Measurable Query Reduction Evidence

| Hot Path / Operation | Queries Before Phase 10.9 | Queries After Phase 10.9 | Measured Reduction |
| :--- | :--- | :--- | :--- |
| **Outbound Message ACK (`message_status_updated`)** | 2 queries (`select(Message)` in conv check + `select(Message)` in status update) | 1 query (`matching_msg` reused) | **-50.0% (-1 query / ACK)** |
| **Outbound Text Send (`send_text_message`)** | 3 queries (insert + 2 x `refresh(row)`) | 2 queries (1 refresh after gateway preserved for early ACK race; post-commit refresh eliminated) | **-33.3% (-1 query / send)** |
| **Outbound Media Send (`send_media_message`)** | 3 queries (insert + 2 x `refresh(row)`) | 2 queries (post-commit refresh eliminated) | **-33.3% (-1 query / send)** |
| **Inbound Message Ingest (`_ingest_message`)** | 1 extra SELECT on `messages` via `db.refresh(row)` after flush | 0 extra SELECT queries | **-1 query / inbound message** |
| **Campaign Batch Outreach (N = 50 leads)** | 50 queries (`select(Blacklist)` per lead) | 1 query (`select(Blacklist.phone_e164).in_(...)`) | **-98.0% (-49 queries / batch)** |

### PostgreSQL Post-Deployment Snapshot (`2026-09-17 08:13:24 UTC`)

| Relation | Live Tuples | Dead Tuples | Inserts | Updates | Deletes | HOT % | Total Size |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `whatsapp_private.event_outbox` | 3,406 | 462 | 81,633 | 4,587,791 | 84,268 | 0.0% | 62.8 MB |
| `whatsapp_private.processed_events`| 67,178 | 0 | 63,592 | 0 | 0 | N/A | 7.9 MB |
| `public.messages` | 0 | 0 | 25,413 | 51 | 34,770 | 5.9% | 5.9 MB |
| `public.contacts` | 1,430 | 0 | 335 | 1,038 | 692 | 88.7% | 816 KB |
| `public.conversations` | 0 | 0 | 351 | 863 | 692 | 1.3% | 424 KB |
| `public.whatsapp_sessions` | 3 | 42 | 3 | 2,185 | 4 | 69.4% | 264 KB |
| `public.auth_staging_sessions` | 28 | 32 | 45 | 2,287 | 13 | 100.0% | 40 KB |

---

## 6. Test Results

### Targeted Tests
- `backend/tests/test_phase_10_9_optimizations.py`: **3 passed** in 0.38s
  - `test_batch_blacklist_lookup_and_outreach` (PASS)
  - `test_message_status_monotonic_advancement` (PASS)
  - `test_message_serialization_without_refresh` (PASS)
- `backend/tests/test_whatsapp_races.py`: **4 passed** in 0.86s
  - Verified that concurrent early ACK updates survive without regression.
- `backend/tests/test_campaign_runner.py`: **1 passed** in 0.27s

### Full Test Suite
- **Backend Test Suite:** `708 passed` in 44.27s (0 failures, 0 errors).
- **Frontend Derleme:** `cd frontend && npm run build` (TypeScript check & Vite build successful in 1.63s).

---

## 7. Deployment Details

Deployment was executed strictly following production compose standards:
1. **Commit:** `50f27d8f915ad49a07d47d6889b86f190ba35250`
2. **Production Pull:** Clean Fast-Forward merge on `/opt/tezlify`
3. **Docker Build:** `docker compose -f docker-compose.prod.yml build backend`
   - Built manifest: `sha256:baeb25aeea7bdc0b25744061b10a84fb6123246a9af9800d254436a761709cfc`
4. **Container Recreation:** `docker compose -f docker-compose.prod.yml up -d --no-deps backend`
   - Recreated container `tezlify-backend` (`28456f6daa17`)
5. **Consistency Verification:**
   - Host git SHA: `50f27d8f915ad49a07d47d6889b86f190ba35250`
   - In-container code verified: `OutreachManager.get_blacklisted_phones` present, `matching_msg` reuse present in `whatsapp_service.py`.

---

## 8. Production Verification

Post-deployment telemetry verified immediately on Oracle Cloud VM:
- **Containers:**
  - `tezlify-backend`: Up (healthy)
  - `tezlify-gateway`: Up (healthy)
  - `tezlify-caddy`: Up (healthy)
  - `tezlify-db`: Up (healthy)
- **API Health:**
  - `GET https://api.130.162.247.20.sslip.io/health`: HTTP 200 `status: healthy`
  - `memory_mb`: 102.3 MB
  - `gateway_bridge`: `connected: true`, `reconnect_count: 1`
- **WhatsApp Sessions (Read-Only Verification):**
  - ID 4 (`diag`): `SCAN_QR`
  - ID 5 (`diag`): `RELINK_REQUIRED`
  - ID 45 (`Hat 1`): `SCAN_QR`
  - Zero state changes, zero mutations.
- **Timers:**
  - `tezlify-wa-observer.timer`: Active
  - `tezlify-monitor.timer`: Active
  - Observer snapshot logged append-only to `/opt/tezlify/runtime/database-reliability/observations.jsonl`.

---

## 9. Deferred Optimizations

- **`processed_events` Atomic Single-Query Upsert:** Deferred to future architecture phases to ensure fail-closed transaction rollback boundaries and tenant resolution exceptions remain strictly isolated.
- **Dropping Zero-Scan Secondary Indexes:** Deferred in accordance with Phase 10.7 invariant rules requiring runtime dynamic SQL tracing before altering index catalog state.

---

## 10. Remaining Risks

- **Low Risk:** The applied optimizations are confined to Python service-level query deduplication and batch pre-fetching. No database schema, migration, protocol, or state-machine contracts were touched. All 708 automated regression tests pass. Concurrency race protection was verified with active tests.

---

## 11. Phase 10.8 Status

```text
PHASE 10.8 STATUS: INSUFFICIENT_OBSERVATION
48H OBSERVATION END: 2026-09-18 22:45:00 UTC (2026-09-19 01:45:00 UTC+3)
```

In accordance with Hard Safety Rule 17, Phase 10.8 remains completely independent and is currently at ~9.5 hours of elapsed time out of the required 48 hours. Its status remains strictly `INSUFFICIENT_OBSERVATION` and will not be closed until the full 48-hour continuous observation window has elapsed.

---

## 12. Final Decision

```text
STATUS: PHASE_10_9_OPTIMIZATION_COMPLETE
```
