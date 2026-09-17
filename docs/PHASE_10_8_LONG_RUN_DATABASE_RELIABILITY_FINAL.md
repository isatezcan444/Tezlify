# Phase 10.8 Long-Run Database Reliability — Final

**Phase:** `Phase 10.8B — Extended 48h Production Observation & Final Closure`  
**Execution Timestamp:** 2026-09-17 08:00 UTC (`11:00 UTC+3`)  
**Target Environments:**
- Local Workspace: `/Users/isatezcan/Documents/Github/Scoutify`
- Production Host: Oracle Cloud VM `130.162.247.20` (`/opt/tezlify`)

---

## Effective Phase 10.7 Deployment Time

To establish the exact baseline for the 48-hour observation window without estimates or assumptions, git, database catalog, and container logs were cross-referenced:

| Evidence Artifact | Proven Timestamp (UTC) | Local Timestamp (UTC+3) | Description |
| :--- | :--- | :--- | :--- |
| **Git Commit `55334bb`** | `2026-09-16 22:39:37 UTC` | `2026-09-17 01:39:37` | Phase 10.7 optimization commit pushed to `main` |
| **Partial Index Creation** | `2026-09-16 22:40:44 UTC` | `2026-09-17 01:40:44` | Migration created `ix_event_outbox_cleanup` in Postgres |
| **Container Initialization** | `2026-09-16 22:45:16 UTC` | `2026-09-17 01:45:16` | `tezlify-backend` started with 10m / LIMIT 1000 cleanup config |
| **First Batch Cleanup** | `2026-09-16 22:45:00 - 22:50:00 UTC` | `2026-09-17 01:45:00 - 01:50:00` | `outbox.total` dropped from 35,220 to 34,233 rows |

```text
PHASE_10_7_EFFECTIVE_DEPLOYMENT_TIME = 2026-09-16 22:45:00 UTC (2026-09-17 01:45:00 UTC+3)
```

---

## 48h Observation Window

The mandatory 48-hour observation window is computed strictly from the verified deployment timestamp:

```text
48H_OBSERVATION_START = 2026-09-16 22:45:00 UTC
48H_OBSERVATION_END   = 2026-09-18 22:45:00 UTC (2026-09-19 01:45:00 UTC+3)
```

---

## Observation Coverage

At the time of this evaluation:
- **Current Observation Time:** `2026-09-17 08:00:00 UTC`
- **Elapsed Duration:** **9 hours 15 minutes** (~9.25 hours)
- **Remaining Duration:** **38 hours 45 minutes** (~38.75 hours)
- **Window Completion:** **19.3%**

*(Clarification note: Prior references to an ~18-hour telemetry window accounted for pre-deployment telemetry dating back to `2026-09-16 14:11 UTC`. The true post-Phase 10.7 active observation window is 9.25 hours).*

---

## Event Outbox Ingress

- **Pre-10.7 Ingress Pattern:** Outbox accumulated 30 to 50 rows net per hour because cleanup occurred only once every 60 minutes with `LIMIT 500`.
- **Post-10.7 Steady-State Ingress:** Telemetry measures an ingress rate of **~120 to ~250 events/hour** during normal operational load.
- **Queue Stability:** Ingress is smoothly queued and dispatched without spikes or serialization contention.

---

## Event Outbox Cleanup

- **Cadence & Batching:** Configured for execution every 10 minutes with a batch size of `LIMIT 1000`.
- **Maximum Theoretical Throughput:** `6,000 events / hour`.
- **Demonstrated Catch-Up Capacity:** Following deployment, the cleanup job drained **32,282 backlog rows in ~9.2 hours**, averaging a net reduction of **3,508 rows/hour** until reaching the 24-hour rolling boundary.
- **Index Optimization Reality:**
  - Previous reports incorrectly referred to eliminating a "35,000+ sequential table scan".
  - *Technical correction:* The query was not executing a full table sequential scan. Rather, the cleanup query now executes a highly selective index scan utilizing the dedicated partial index `ix_event_outbox_cleanup`.
- **Query Execution Plan (`EXPLAIN (BUFFERS)`):**
```text
Limit  (cost=2508.61..2508.64 rows=12 width=8)
  ->  Sort  (cost=2508.61..2508.64 rows=12 width=8)
        Sort Key: sequence
        ->  Bitmap Heap Scan on event_outbox  (cost=126.11..2508.40 rows=12 width=8)
              Recheck Cond: ((state)::text = ANY ('{DELIVERED,DEAD_LETTER}'::text[]))
              Filter: ((((state)::text = 'DELIVERED'::text) AND (delivered_at < (now() - '24:00:00'::interval))) 
                    OR (((state)::text = 'DEAD_LETTER'::text) AND (created_at < (now() - '7 days'::interval))))
              ->  Bitmap Index Scan on ix_event_outbox_cleanup  (cost=0.00..126.11 rows=3386 width=0)
Planning:
  Buffers: shared hit=192
```

---

## Event Outbox Retention

The 24-hour retention requirement for delivered events is strictly verified:

```sql
SELECT
    CASE
        WHEN delivered_at >= NOW() - INTERVAL '24 hours' THEN '<24h'
        WHEN delivered_at >= NOW() - INTERVAL '48 hours' THEN '24-48h'
        WHEN delivered_at >= NOW() - INTERVAL '72 hours' THEN '48-72h'
        ELSE '>72h'
    END AS bucket,
    count(*)
FROM whatsapp_private.event_outbox
WHERE state='DELIVERED'
GROUP BY 1 ORDER BY 1;
```

**Delivered Event Retention Distribution:**
- `<24h`: **3,297 rows (100.0%)**
- `24-48h`: **0 rows (0.0%)**
- `48-72h`: **0 rows (0.0%)**
- `>72h`: **0 rows (0.0%)**

**Queue State Summary:**
- Total Rows: **3,406**
- Delivered Rows: **3,297**
- Pending Rows: **0**
- In-Flight Rows: **0**
- Dead Letter Rows: **109** (historical test records, aged < 7 days)
- Oldest Delivered Record: `2026-09-16 08:08:53 UTC` (Age: 23.85 hours)

---

## Event Outbox Retry Behaviour

An exhaustive analysis of event delivery attempts was conducted across all outbox states:

```sql
SELECT state, attempts, count(*)
FROM whatsapp_private.event_outbox
GROUP BY state, attempts
ORDER BY state, attempts;
```

| Outbox State | Delivery Attempts | Row Count | Operational Significance |
| :--- | :--- | :--- | :--- |
| **`DELIVERED`** | **1** | **3,297** | **100.0% delivered on first attempt** |
| **`DELIVERED`** | **> 1** | **0** | Zero delivery retries required |
| **`PENDING`** | **> 1** | **0** | Zero stuck pending events |
| **`IN_FLIGHT`** | **> 1** | **0** | Zero stuck in-flight events |
| **`DEAD_LETTER`** | **10 to 142** | **109** | 100% legacy test events from Sept 14–16 |

- **New Dead Letters Generated:** **0**
- **Retry Amplification Verdict:** **NO RETRY AMPLIFICATION DETECTED**.

---

## Processed Events Retention

`whatsapp_private.processed_events` functions as an idempotent deduplication ledger governed by a 7-day retention policy:

| Age Bucket | Criteria | Row Count | Percentage | Retention Compliance |
| :--- | :--- | :--- | :--- | :--- |
| **`< 24h`** | `processed_at >= NOW() - 24h` | 3,297 | 4.9% | Matches active outbox throughput |
| **`24h - 48h`** | `processed_at >= NOW() - 48h` | 61,138 | 91.0% | Normal deduplication window |
| **`48h - 72h`** | `processed_at >= NOW() - 72h` | 2,741 | 4.1% | Normal deduplication window |
| **`3d - 7d`** | `processed_at >= NOW() - 7d` | 0 | 0.0% | Clean |
| **`> 7d`** | `processed_at < NOW() - 7d` | **0** | **0.0%** | **100% Invariant Compliant** |

- Total Processed Rows: **67,176**
- Oldest Processed Event: `2026-09-14 15:12:10 UTC` (~2.7 days old).
- Zero rows exceed the 7-day threshold.

---

## Database Growth

Storage footprint comparison between pre-Phase 10.7 peak bloat and current steady state:

| Relation Name | Pre-10.7 Peak | Current Post-10.7 | Absolute Delta | Percentage Change |
| :--- | :--- | :--- | :--- | :--- |
| `whatsapp_private.event_outbox` (Rows) | 35,973 rows | 3,406 rows | -32,567 rows | **-90.5%** |
| `whatsapp_private.event_outbox` (Table Size) | 62.0 MB | 25.9 MB | -36.1 MB | **-58.1%** |
| `whatsapp_private.event_outbox` (Total Size) | 85.0 MB | 62.8 MB | -22.2 MB | **-26.1%** |
| `whatsapp_private.processed_events` | 82,311 rows | 67,176 rows | -15,135 rows | **-18.4%** |
| `whatsapp_private.processed_events` (Total Size) | 9.8 MB | 7.9 MB | -1.9 MB | **-19.4%** |
| `public.contacts` (Total Size) | 816 KB | 816 KB | 0 KB | 0.0% (Stable) |
| `public.auth_staging_sessions` (Total Size) | 40 KB | 40 KB | 0 KB | 0.0% (Stable) |

---

## Dead Tuple / Bloat Trends

Catalog inspection of dead tuples and update mechanisms across critical relations:

| Relation Name | Live Tuples | Dead Tuples | Dead Tuple % | HOT Update % | Auto-Vacuum Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `whatsapp_private.event_outbox` | 3,406 | 462 | 11.9% | 0.0% (state-indexed) | Regularly vacuumed, stable |
| `whatsapp_private.processed_events` | 67,178 | 0 | 0.0% | N/A (append-only) | Healthy |
| `public.contacts` | 1,430 | 0 | 0.0% | **88.7%** | Healthy |
| `public.conversations` | 0 | 0 | 0.0% | 1.3% | Healthy |
| `public.messages` | 0 | 0 | 0.0% | 5.9% | Healthy |
| `public.whatsapp_sessions` | 3 | 42 | 93.3% | **69.4%** | Small heap (8 KB), healthy |
| `whatsapp_private.socket_leases` | 0 | 21 | 100.0% | **100.0%** | Small heap (8 KB), healthy |
| `public.auth_staging_sessions` | 28 | 32 | 53.3% | **100.0%** | Small heap (8 KB), healthy |

---

## Auth Write Pressure

Throttling of auth session activity on `public.auth_staging_sessions`:
- **Active Session Rows:** 28
- **Inserts Recorded:** 45
- **Updates Recorded:** 2,287
- **HOT Updates Recorded:** 2,287 (**100.0% HOT update ratio**)
- **Hourly Delta in Steady State:** `0.0 updates/hour` during idle periods.
- **Heap & Index Footprint:** 8 KB heap, 32 KB index (40 KB total). Zero index bloat or table growth.

---

## WhatsApp Runtime Integrity

Production sessions monitored continuously:

```sql
SELECT id, session_name, status, is_phone_online
FROM public.whatsapp_sessions
ORDER BY id;
```

| Session ID | Session Name | Status | Phone Online | State Mutation Detected |
| :--- | :--- | :--- | :--- | :--- |
| **4** | `diag` | `SCAN_QR` | `false` | **None** |
| **5** | `diag` | `RELINK_REQUIRED` | `false` | **None** |
| **45** | `Hat 1` | `SCAN_QR` | `false` | **None** |

**Runtime Infrastructure Verification:**
- `tezlify-gateway`: Healthy, Memory RSS ~84.2 MB, zero unhandled errors.
- `tezlify-backend`: Healthy, Memory RSS ~102.3 MB, zero 5xx responses.
- `gateway_bridge`: Connected continuously, `reconnect_count = 1` (initial container launch).
- `active_socket_leases`: 0 (leases properly released on idle).
- `tezlify-wa-observer.timer`: Active (fires every 5 minutes).
- `tezlify-monitor.timer`: Active (fires every 3 minutes).

---

## Query Activity Trends

PostgreSQL query access ratios measured from `pg_stat_user_tables`:

| Relation Name | Sequential Scans | Index Scans | Index Ratio | Performance Classification |
| :--- | :--- | :--- | :--- | :--- |
| `event_outbox` | 16,110 | 3,188,798 | **99.5% Index-driven** | Highly Selective |
| `processed_events` | 14 | 136,710 | **99.99% Index-driven**| Highly Selective |
| `contacts` | 13,325 | 134,885 | **91.0% Index-driven** | Healthy |
| `messages` | 9,891 | 1,032,877 | **99.0% Index-driven** | Highly Selective |

- The removal of 12 duplicate secondary PK indexes in Phase 10.7 has resulted in **no query degradation**, as all primary lookups natively resolve against the primary key indexes (`<table>_pkey`).
- Single-lookup contact resolution in `_ensure_conversation` preserves reduced lookup frequency.

---

## Incidents

- **Incidents Recorded:** `0`
- **Container Restarts (Unexpected):** `0`
- **Out of Memory Kills:** `0`

---

## Anomalies

- **Anomalies Recorded:** `0`
- **Session State Deviations:** `0`
- **WebSocket Bridge Drops:** `0`

---

## Evidence Limitations

1. **Window Duration:** The observation period since Phase 10.7 deployment has reached **9.25 hours**. Although all operational indicators are completely stable and trending positively, the full 48-hour continuous observation window has not yet elapsed.
2. **Catalog-Level Telemetry:** Runtime SQL query measurements are derived non-invasively from PostgreSQL catalog views (`pg_stat_user_tables`, `pg_stat_user_indexes`) and explain plans. Because dynamic SQL proxy tracing is not enabled in production, claims regarding duplicate queries are classified as **NO STATIC REGRESSION DETECTED** and **NO CATALOG-LEVEL WRITE ANOMALY DETECTED**.

---

## Final Decision

```text
STATUS: INSUFFICIENT_OBSERVATION
DECISION: INSUFFICIENT_OBSERVATION
```

### Rationale:
- **Mandatory Window Invariant:** Phase 10.8 cannot be closed as `COMPLETE` or declared final `STABLE` prior to the expiration of the full 48-hour observation window (`48H_OBSERVATION_END = 2026-09-18 22:45:00 UTC`).
- **Interim Performance:** All operational parameters (outbox size, 24h retention, 7d deduplication retention, 100% HOT updates on auth sessions, 0 dead-letter additions, and 0 WhatsApp session mutations) are functioning in full compliance with system requirements.
- **Action Plan:** Telemetry will continue to be collected append-only in `/opt/tezlify/runtime/database-reliability/observations.jsonl` via `db_long_run_observer.py` and existing systemd timers until `2026-09-18 22:45 UTC`, at which time final closure certification will be evaluated.
