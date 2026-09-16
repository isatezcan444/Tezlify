# Phase 10.7 Database Optimization Baseline

**Document Status:** RECORDED & VERIFIED  
**Date / Timestamp:** 2026-09-17T01:28:00+03:00  
**Audit Scope:** Local Workspace (`/Users/isatezcan/Documents/Github/Scoutify`) & Production Deployment (`/opt/tezlify` on Oracle Cloud VM `130.162.247.20`)  
**Safety Protocol:** Read-Only Snapshot. Zero mutations applied prior to recording.

---

## 1. Git Repository State

### Local Workspace (`/Users/isatezcan/Documents/Github/Scoutify`)
* **Branch:** `main`
* **Head Commit:** `d4af42f35da1490143cae9277eff57659cbef1b1`
* **Working Tree:** Clean (no untracked files, no uncommitted changes)

### Production Host (`130.162.247.20` at `/opt/tezlify`)
* **Branch:** `main`
* **Head Commit:** `d4af42f35da1490143cae9277eff57659cbef1b1` (In exact sync with origin)

---

## 2. Production Docker & Container State

```text
NAME              IMAGE                COMMAND                  SERVICE   STATUS
tezlify-backend   tezlify-backend      "python3 start.py"       backend   Up (healthy)
tezlify-caddy     caddy:2-alpine       "caddy run --config …"   caddy     Up (healthy)
tezlify-db        postgres:17-alpine   "docker-entrypoint.s…"   db        Up (healthy)
tezlify-gateway   tezlify-gateway      "docker-entrypoint.s…"   gateway   Up (healthy)
```

All 4 production services are in a healthy, running state.

---

## 3. Production Database Metrics Baseline

Measured directly via `psql -U tezlify -d tezlify` inside `tezlify-db`:

| Metric | Measured Value | Operational Assessment |
| :--- | :--- | :--- |
| **`event_outbox` Total Rows** | **35,688 rows** | Bloat from hourly 500-row limit deficit |
| **`event_outbox` Delivered Rows** | **35,579 rows** | 99.7% of table is delivered events |
| **`event_outbox` Pending Rows** | **0 rows** | Ingestion pipeline is currently cleared |
| **`event_outbox` Dead Letter Rows**| **109 rows** | Retained under 7-day policy |
| **Oldest `delivered_at`** | `2026-09-15 20:58:47.150857+00` | > 28 hours old (exceeds 24h retention) |
| **`event_outbox` Total Size** | **85 MB** | Table and index disk footprint |
| **`processed_events` Total Rows** | **65,809 rows** | Deduplication ledger (7-day window) |
| **Total Database Indexes** | **131 indexes** | Public + whatsapp_private schemas |

---

## 4. Confirmed 12 Duplicate Primary Key Indexes

Each of the following 12 secondary non-unique B-tree indexes is created on the single column `(id)` despite the existence of the unique primary key constraint index:

| # | Table Name | Duplicate Secondary Index Name | Primary Key Index Name | Column |
| :-: | :--- | :--- | :--- | :---: |
| 1 | `blacklist` | `ix_blacklist_id` | `blacklist_pkey` | `(id)` |
| 2 | `campaign_groups` | `ix_campaign_groups_id` | `campaign_groups_pkey` | `(id)` |
| 3 | `campaigns` | `ix_campaigns_id` | `campaigns_pkey` | `(id)` |
| 4 | `contacts` | `ix_contacts_id` | `contacts_pkey` | `(id)` |
| 5 | `conversations` | `ix_conversations_id` | `conversations_pkey` | `(id)` |
| 6 | `discovery_runs` | `ix_discovery_runs_id` | `discovery_runs_pkey` | `(id)` |
| 7 | `leads` | `ix_leads_id` | `leads_pkey` | `(id)` |
| 8 | `message_logs` | `ix_message_logs_id` | `message_logs_pkey` | `(id)` |
| 9 | `messages` | `ix_messages_id` | `messages_pkey` | `(id)` |
| 10 | `raw_candidates` | `ix_raw_candidates_id` | `raw_candidates_pkey` | `(id)` |
| 11 | `scraper_jobs` | `ix_scraper_jobs_id` | `scraper_jobs_pkey` | `(id)` |
| 12 | `whatsapp_sessions` | `ix_whatsapp_sessions_id` | `whatsapp_sessions_pkey` | `(id)` |

*Note: In PostgreSQL, all 12 indexes currently have `idx_scan = 0` because PostgreSQL always uses `<table>_pkey` for single-row lookups.*

---

## 5. WhatsApp Session & Observer Baseline

### Active WhatsApp Sessions (`public.whatsapp_sessions`)
```text
 id | session_name |     status      | is_phone_online 
----+--------------+-----------------+-----------------
  5 | diag         | RELINK_REQUIRED | f
  4 | diag         | SCAN_QR         | f
 45 | Hat 1        | SCAN_QR         | f
```
*Total Sessions:* 3 sessions. All session states will be preserved without modification.

### Phase 10.5 Systemd Observer / Monitoring Timers
```text
tezlify-wa-observer.timer: active
tezlify-monitor.timer:     active
```
Both monitoring timers are running normally on the host.
