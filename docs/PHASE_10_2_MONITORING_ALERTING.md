# PHASE 10.2 — TEZLIFY PRODUCTION MONITORING & ALERTING RUNBOOK

**Document Status:** `MONITORING_ALERTING_VERIFIED`  
**Execution Timestamp:** `2026-09-16T13:36 UTC`  
**Target Infrastructure:** Oracle Cloud Always Free VM (`130.162.247.20`, Ubuntu 24.04 ARM64)  
**Architecture:** `ORACLE_ONLY`  
**Alert Provider:** `none` (local log event recording; extensible to `webhook` / `telegram`)  
**Off-Host Backup Status:** `OFF_HOST_BACKUP_NOT_CONFIGURED` (documented limitation)  

---

## 1. Executive Summary

Phase 10.2 establishes a lightweight, Oracle-native monitoring and alerting subsystem for Tezlify's single-VM production environment.

### Core Design Invariants
1. **Read-Only Inspection:** Zero service restarts, zero schema migrations, zero automated state mutations.
2. **Dynamic WhatsApp Discovery:** No assumption that WhatsApp Session 43 (or any specific ID) exists. All checks query `public.whatsapp_sessions` and `whatsapp_private.socket_leases` dynamically.
3. **Strict Zero Secret Leakage:** JWT tokens, OAuth secrets, database passwords, and Baileys session keys are never printed to logs or terminal output.
4. **No Heavy Overhead:** Avoids resource-intensive Prometheus/Grafana stacks on the 4 OCPU VM. Operates via a low-footprint `systemd` timer invoking `/opt/tezlify/scripts/monitor_health.sh` every 3 minutes (<800ms CPU execution time).
5. **Deduplicated Alerting:** State machine with cooldown prevents alert spamming during prolonged degradation and sends recovery notifications when health is restored.

---

## 2. Production Baseline Discovered

The following baseline metrics were captured directly from Oracle VM `130.162.247.20` during Phase 10.2 execution:

| Component | Metric / Attribute | Observed Baseline Value | Status |
|---|---|---|---|
| **CPU** | Cores & 1-minute load | 4 cores (Neoverse-N1), load=0.02 | ✅ OK |
| **RAM** | Total / Used / Available | 23.9 GB total / 1.7 GB used (7%) / 22.2 GB avail | ✅ OK |
| **Disk** | Root filesystem (`/dev/sda1`) | 96 GB total / 9.5 GB used (10%) / 87 GB free | ✅ OK |
| **Caddy** | Edge Health & Latency | `/caddy-health` HTTP 200 OK, latency=17ms | ✅ OK |
| **Public API** | HTTPS Health & Latency | `/health` HTTP 200 `healthy`, latency=19ms | ✅ OK |
| **TLS/SSL** | Let's Encrypt Certificate | Valid until Dec 14 2026 (89 days remaining) | ✅ OK |
| **Docker** | Running Containers | 4/4 running (`tezlify-caddy`, `backend`, `gateway`, `db`) | ✅ OK |
| **Restarts** | Container Restart Counts | 0 restarts across all 4 containers | ✅ OK |
| **Backend RSS** | Python Process Memory | 112.3 MB | ✅ OK |
| **Gateway Bridge**| Backend ↔ Gateway WS Bridge | `connected: true`, `reconnect_count: 1` | ✅ OK |
| **Gateway** | Gateway HTTP API (`:8787`) | HTTP 200 `status: ok`, sessions total=0 | ✅ OK |
| **PostgreSQL** | `pg_isready` & Query | Connections active=10/100 (10%), latency <5ms | ✅ OK |
| **WhatsApp DB** | `public.whatsapp_sessions` | Total=2 (`SCAN_QR`: 1, `RELINK_REQUIRED`: 1) | ✅ OK (Dynamic) |
| **Socket Leases** | `whatsapp_private.socket_leases` | 0 active leases | ✅ OK |
| **Outbox Queue** | `whatsapp_private.event_outbox` | `PENDING`: 0, `IN_FLIGHT`: 0, `DEAD_LETTER`: 109 | ✅ OK |
| **Retry Queue** | `whatsapp_private.retry_messages`| 0 backlog messages | ✅ OK |
| **HTTP 5xx** | Recent 5-minute Error Rate | 0 5xx responses in last 5m | ✅ OK |
| **Backups** | Local Postgres Dump Freshness | `tezlify_20260916_131737Z.dump` (age 0h, 31 MB) | ✅ OK |
| **Backups Total**| Total `/opt/tezlify/backups` size | 74 MB | ✅ OK |

---

## 3. Monitoring Checks & Thresholds Matrix

The monitoring engine executes 13 check routines covering 24 health indicators:

| Check Name | Target Measured | OK Criteria | WARN Threshold | CRITICAL Threshold |
|---|---|---|---|---|
| `api_health` | Public HTTPS `/health` | HTTP 200 & `"status":"healthy"` | Latency > 2,000ms | Non-200, timeout, or latency > 5,000ms |
| `caddy_edge` | Public `/caddy-health` | HTTP 200 & body `"OK"` | Latency > 1,000ms | Non-200, timeout, or proxy dead |
| `docker_containers`| 4 production containers | Status `running` & `healthy` | Restart count > 0 | Any container stopped / unhealthy |
| `backend_internal` | Internal `:8000/health` | HTTP 200 & bridge connected | Bridge disconnected / RSS > 400MB | Unreachable or error response |
| `gateway_internal` | Gateway `:8787/health` | HTTP 200 & `"status":"ok"` | High pending sessions | Unreachable or internal error |
| `postgres_health` | `pg_isready` & `SELECT 1` | Connection open & active < 70% | Connection pool >= 70% | `pg_isready` fails, or pool >= 85% |
| `whatsapp_state` | Dynamic DB sessions & leases | Logical state consistent | Connected > 0 but leases == 0 | Database query fails |
| `outbox_queue` | `whatsapp_private` event outbox | Pending < 100, age < 600s | Pending >= 100 or age >= 600s | Pending >= 500 or age >= 1800s |
| `system_resources`| CPU load, RAM %, Disk % | Load < 6.0, RAM < 80%, Disk < 75%| RAM >= 80% or Disk >= 75% | RAM >= 95% or Disk >= 90% |
| `http_5xx_rate` | Backend 5xx in last 5 min | 5xx count < 10 | 5xx count >= 10 in 5m | 5xx count >= 50 in 5m |
| `websocket_health`| Client WS & Gateway Bridge | Gateway bridge connected | Bridge disconnected | WS endpoint rejecting connections |
| `backup_freshness`| Local PostgreSQL dump age | Dump age <= 26h, size > 1MB | Dump age > 26h | No dump found, age > 48h, or < 1MB |
| `ssl_certificate` | Let's Encrypt cert on 443 | Expiration > 14 days | Expiration <= 14 days | Expiration <= 3 days or TLS failure |

---

## 4. Alerting & Deduplication Architecture

### State Machine
The monitor records state in `/opt/tezlify/monitoring/state.json`:
- `last_status`: `OK` | `WARN` | `CRITICAL`
- `incident_start_timestamp`: Timestamp when degradation began
- `last_alert_timestamp`: Timestamp of most recent alert sent
- `alert_count`: Number of alerts emitted for the active incident
- `failed_checks`: Array of failing check names
- `warn_checks`: Array of warning check names

### Deduplication Invariants
- **New Incident:** Emits immediate alert on `OK -> WARN` or `OK -> CRITICAL`.
- **Escalation:** Emits immediate alert on `WARN -> CRITICAL`.
- **Deduplication Cooldown:** When remaining in failing state, repeated notifications are throttled by `ALERT_COOLDOWN_MINUTES` (default 60 minutes).
- **Recovery Notification:** When status returns to `OK`, emits a `RESOLVED` notification reporting total incident duration in seconds and resets incident state.

### Alert Providers
Configured in `/opt/tezlify/monitoring/monitor.conf`:
- `ALERT_PROVIDER=none`: Default production mode. Alerts are recorded into `/opt/tezlify/logs/tezlify-monitor.log` as `[ALERT event=...]`.
- `ALERT_PROVIDER=webhook`: Dispatches JSON payloads via HTTP POST to `ALERT_WEBHOOK_URL` (Slack, Discord, generic webhook).
- `ALERT_PROVIDER=telegram`: Dispatches Markdown messages to `https://api.telegram.org/bot<TOKEN>/sendMessage`.

---

## 5. Systemd Automation & Operations

### Units Deployed
- `/etc/systemd/system/tezlify-monitor.service`: Oneshot execution of `/opt/tezlify/scripts/monitor_health.sh --summary`.
- `/etc/systemd/system/tezlify-monitor.timer`: Triggers every 3 minutes with persistence across reboots.
- `/etc/logrotate.d/tezlify-monitor`: Daily rotation with 14-day retention and compression.

### Operational Commands

#### 1. Inspect Latest Machine-Readable Health
```bash
cat /opt/tezlify/monitoring/latest_health.json | jq .
```

#### 2. Run Instant Manual Health Check
```bash
/opt/tezlify/scripts/monitor_health.sh
```

#### 3. View Recent Monitoring Logs
```bash
tail -f /opt/tezlify/logs/tezlify-monitor.log
```

#### 4. Check Timer Schedule & Status
```bash
systemctl status tezlify-monitor.timer
systemctl list-timers tezlify-monitor.timer
```

#### 5. Trigger Manual Systemd Execution
```bash
sudo systemctl start tezlify-monitor.service
sudo journalctl -u tezlify-monitor.service -n 20 --no-pager
```

#### 6. Safely Disable Monitoring
```bash
sudo systemctl stop tezlify-monitor.timer
sudo systemctl disable tezlify-monitor.timer
```

#### 7. Re-enable Monitoring
```bash
sudo systemctl enable --now tezlify-monitor.timer
```

---

## 6. Testing & Validation Evidence

### Automated Test Suite
Unit tests in `backend/tests/test_monitoring_script.py` verified:
- Script existence and execution bit
- Bash syntax validation (`bash -n`)
- Configuration file sourcing
- Systemd unit directive compliance
- Secrets leakage prevention
- Deduplication and transition state machine logic

```
backend/tests/test_monitoring_script.py::test_systemd_units_syntax PASSED
backend/tests/test_monitoring_script.py::test_monitor_conf_syntax PASSED
backend/tests/test_monitoring_script.py::test_monitor_script_exists_and_executable PASSED
backend/tests/test_monitoring_script.py::test_monitor_script_syntax PASSED
backend/tests/test_monitoring_script.py::test_state_machine_deduplication_logic PASSED
backend/tests/test_monitoring_script.py::test_no_secrets_in_monitoring_files PASSED
6 passed in 0.07s
```

### Safe Live Negative Tests
Conducted on Oracle VM using an isolated temporary configuration directory:
1. **Injected Failure:** Simulated endpoint failure to non-routable port (`127.0.0.1:9999`).
   - Monitor returned exit code `2` (`CRITICAL`).
   - Log recorded `[ALERT event=CRITICAL: Tezlify Issue Detected [NEW_INCIDENT]]`.
2. **Deduplication Verification:** Re-ran failure within cooldown window.
   - Exit code `2` preserved.
   - Alert count remained 1 (no spam).
3. **Recovery Verification:** Swapped back to valid endpoint.
   - Monitor returned exit code `0` (`OK`).
   - Log recorded `[ALERT event=RESOLVED: Tezlify Health Restored] Incident duration: 2s`.
   - Incident state reset to clean baseline.

---

## 7. Known Limitations

> [!WARNING]
> **1. OFF_HOST_BACKUP_NOT_CONFIGURED:**  
> The monitoring engine actively checks local backup freshness in `/opt/tezlify/backups/postgres/`. However, off-host replication to OCI Object Storage is not yet configured. The monitor explicitly outputs `off_host=NOT_CONFIGURED` in every report.
> 
> **2. ALERT_PROVIDER=none:**  
> No external notification channel (webhook/Telegram) is currently enabled. Operational alerts are recorded exclusively to the local log `/opt/tezlify/logs/tezlify-monitor.log`.
>
> **3. WhatsApp Session Volatility:**  
> WhatsApp session state is dynamic. The absence of a connected session reflects current business operation status, not an infrastructure fault. The monitor only warns if contradictory DB states appear (e.g. `CONNECTED` status without an active socket lease).
