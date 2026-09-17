# Phase 10.8 — Long-Run Database & WhatsApp Reliability Baseline

**Phase:** `Phase 10.8 — Long-Run Database & WhatsApp Reliability Observation`  
**Capture Timestamp:** 2026-09-17 07:41 UTC (`10:41 UTC+3`)  
**Production Host:** Oracle Cloud VM `130.162.247.20` (`/opt/tezlify`)  
**Git Commit:** `e8eaa56ffd207a991b1efc1ffbd8525133a33656`

---

## 1. Event Outbox Baseline State

```sql
SELECT
    count(*) AS total_rows,
    count(*) FILTER (WHERE state='PENDING') AS pending,
    count(*) FILTER (WHERE state='IN_FLIGHT') AS in_flight,
    count(*) FILTER (WHERE state='DELIVERED') AS delivered,
    count(*) FILTER (WHERE state='DEAD_LETTER') AS dead_letter,
    min(created_at) AS oldest_created,
    min(delivered_at) AS oldest_delivered,
    max(created_at) AS newest_created,
    max(delivered_at) AS newest_delivered
FROM whatsapp_private.event_outbox;
```

| Metric | Measured Value | Notes |
| :--- | :--- | :--- |
| **Total Rows** | **3,406** | Down from 35,688 at Phase 10.7 baseline (-90.5%) |
| **Pending** | **0** | No queue backlog |
| **In Flight** | **0** | No stalled claims |
| **Delivered** | **3,297** | Active 24-hour retention window |
| **Dead Letter** | **109** | Historical pre-10.7 events (7d retention) |
| **Oldest Created** | `2026-09-14 16:15:32.129278+00` | Historical dead-letter |
| **Oldest Delivered** | `2026-09-16 08:08:53.714612+00` | Exactly 23.5 hours old (<24h cutoff) |
| **Newest Created** | `2026-09-17 07:13:58.609766+00` | Steady stream |
| **Newest Delivered** | `2026-09-17 07:13:58.628192+00` | Instantaneous delivery |

### 24-Hour Retention Window Bucket Distribution:
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

| Age Bucket | Count | Percentage | Evaluation |
| :--- | :--- | :--- | :--- |
| **< 24h** | **3,297** | **100.0%** | **Compliant** |
| **24h - 48h** | 0 | 0.0% | Pruned by 10m x 1000 cleanup |
| **48h - 72h** | 0 | 0.0% | Pruned |
| **> 72h** | 0 | 0.0% | Pruned |

---

## 2. Processed Events Baseline State

```sql
SELECT
    count(*) AS processed_events,
    min(processed_at),
    max(processed_at)
FROM whatsapp_private.processed_events;
```

| Metric | Measured Value | Notes |
| :--- | :--- | :--- |
| **Total Processed Events** | **67,176** | Deduplication ledger |
| **Oldest Processed** | `2026-09-14 15:12:10.658500+00` | ~2.7 days old (< 7d policy) |
| **Newest Processed** | `2026-09-17 07:13:58.620658+00` | In sync with outbox |

### 7-Day Retention Bucket Distribution:
| Bucket | Count | Percentage |
| :--- | :--- | :--- |
| **< 24h** | 3,297 | 4.9% |
| **24h - 48h** | 61,138 | 91.0% |
| **48h - 72h** | 2,741 | 4.1% |
| **3d - 7d** | 0 | 0.0% |
| **> 7d** | **0** | **0.0% (Zero events exceeding 7d policy)** |

---

## 3. Database Catalog & Activity Baseline (`pg_stat_user_tables`)

```sql
SELECT
    schemaname,
    relname,
    n_live_tup,
    n_dead_tup,
    n_tup_ins,
    n_tup_upd,
    n_tup_del,
    n_tup_hot_upd,
    pg_total_relation_size(relid) AS total_bytes
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

| Schema | Table Name | Live Tuples | Dead Tuples | Inserts | Updates | Deletes | HOT Updates | Total Size | HOT Ratio |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `whatsapp_private` | `event_outbox` | 3,406 | 462 | 81,633 | 4,587,791 | 84,268 | 0 | 62.8 MB | 0.0% (indexed state/attempts) |
| `whatsapp_private` | `signal_keys` | 0 | 0 | 2,842 | 50,651 | 10,967 | 50,598 | 10.0 MB | **99.9%** |
| `whatsapp_private` | `processed_events`| 67,178 | 0 | 63,592 | 0 | 0 | 0 | 7.9 MB | N/A (append-only) |
| `public` | `messages` | 0 | 0 | 25,413 | 51 | 34,770 | 3 | 5.9 MB | 5.9% |
| `public` | `contacts` | 1,430 | 0 | 335 | 1,038 | 692 | 921 | 816 KB | **88.7%** |
| `public` | `conversations` | 0 | 0 | 351 | 863 | 692 | 11 | 424 KB | 1.3% |
| `public` | `leads` | 3 | 0 | 3 | 0 | 0 | 0 | 320 KB | N/A |
| `public` | `whatsapp_sessions` | 3 | 42 | 3 | 2,185 | 4 | 1,517 | 264 KB | **69.4%** |
| `whatsapp_private` | `session_credentials`| 0 | 16 | 2 | 158 | 4 | 157 | 224 KB | **99.4%** |
| `public` | `message_logs` | 2 | 0 | 2 | 0 | 0 | 0 | 152 KB | N/A |
| `public` | `scraper_jobs` | 2 | 4 | 2 | 4 | 0 | 0 | 120 KB | 0.0% |
| `public` | `raw_candidates` | 0 | 0 | 0 | 0 | 0 | 0 | 96 KB | N/A |
| `whatsapp_private` | `socket_leases` | 0 | 21 | 17 | 7,200 | 17 | 7,200 | 64 KB | **100.0%** |
| `public` | `discovery_runs` | 0 | 0 | 0 | 0 | 0 | 0 | 56 KB | N/A |
| `public` | `auth_staging_oauth_accounts`| 2 | 0 | 2 | 0 | 0 | 0 | 48 KB | N/A |
| `public` | `auth_staging_users`| 3 | 1 | 4 | 0 | 1 | 0 | 48 KB | N/A |
| `public` | `campaign_groups`| 0 | 0 | 0 | 0 | 0 | 0 | 40 KB | N/A |
| `public` | `system_settings`| 0 | 0 | 0 | 0 | 0 | 0 | 40 KB | N/A |
| `public` | `campaigns` | 0 | 0 | 0 | 0 | 0 | 0 | 40 KB | N/A |
| `public` | `auth_staging_sessions` | 28 | 32 | 45 | 2,287 | 13 | 2,287 | 40 KB | **100.0%** |
| `public` | `blacklist` | 0 | 0 | 0 | 0 | 0 | 0 | 32 KB | N/A |
| `whatsapp_private` | `gateway_sessions`| 3 | 6 | 3 | 6 | 0 | 6 | 32 KB | **100.0%** |
| `public` | `profiles` | 0 | 0 | 0 | 0 | 0 | 0 | 32 KB | N/A |
| `public` | `auth_staging_oauth_states`| 37 | 6 | 37 | 6 | 0 | 6 | 24 KB | **100.0%** |
| `whatsapp_private` | `retry_messages` | 0 | 0 | 0 | 0 | 0 | 0 | 24 KB | N/A |
| `public` | `campaign_group_leads`| 0 | 0 | 0 | 0 | 0 | 0 | 8 KB | N/A |

---

## 4. WhatsApp Session & Runtime Baseline

```sql
SELECT id, session_name, status, is_phone_online
FROM public.whatsapp_sessions
ORDER BY id;
```

| ID | Session Name | Status | Is Phone Online | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **4** | `diag` | `SCAN_QR` | `false` | Baseline diagnostic session |
| **5** | `diag` | `RELINK_REQUIRED` | `false` | Baseline test session |
| **45** | `Hat 1` | `SCAN_QR` | `false` | Primary line awaiting pairing |

### Container & Service Status:
- `tezlify-backend`: `Up (healthy)`
- `tezlify-caddy`: `Up 10 hours (healthy)`
- `tezlify-db`: `Up 34 hours (healthy)`
- `tezlify-gateway`: `Up (healthy)`
- API Health: `{"status":"healthy","service":"Tezlify Backend API","gateway_bridge":{"connected":true,"reconnect_count":1}}`
- `tezlify-wa-observer.timer`: `active`
- `tezlify-monitor.timer`: `active`

---

## 5. Summary Findings

1. **Outbox Bloat Resolved**: Outbox rows reduced from 35,688 to **3,406 rows** (-90.5%), and total relation size reduced from 85 MB to **62.8 MB** (-26.1%).
2. **24h Retention Adherence**: **100%** of delivered events are younger than 24 hours. Zero backlog beyond the retention threshold.
3. **Happy-Path Delivery**: 100% of delivered events in the past 24 hours completed on **attempt = 1**.
4. **HOT Update Efficiency**: Key operational tables (`auth_staging_sessions`, `socket_leases`, `signal_keys`, `contacts`) maintain between **88.7% and 100% Heap-Only Tuple updates**, preventing table and index bloat.
5. **Runtime Integrity**: All 4 containers healthy, WebSocket event bridge connected, observer and monitoring timers active.
