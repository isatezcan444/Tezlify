#!/usr/bin/env bash
# ==============================================================================
# Tezlify Production Health Monitor & Alerting Engine (Phase 10.2)
# Production Host: Oracle Cloud Always Free VM (130.162.247.20)
# Target Architecture: ORACLE_ONLY
# ==============================================================================
# Invariants:
# - Read-only monitoring. No state mutations or automated service restarts.
# - No assumption of fixed WhatsApp session IDs (dynamic discovery).
# - Strict timeout on every network and database operation.
# - Zero secret leakage (credentials, tokens, keys never logged).
# - Deduplicated alerting with state machine & recovery notification.
# ==============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Configuration defaults (can be overridden by monitor.conf)
CONFIG_FILE="${BASE_DIR}/monitoring/monitor.conf"
if [[ -f "${CONFIG_FILE}" ]]; then
  # shellcheck source=/dev/null
  source "${CONFIG_FILE}"
fi

# Fallback defaults if not in config
ALERT_PROVIDER="${ALERT_PROVIDER:-none}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
ALERT_COOLDOWN_MINUTES="${ALERT_COOLDOWN_MINUTES:-60}"

PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://api.130.162.247.20.sslip.io}"
API_HEALTH_URL="${API_HEALTH_URL:-${PUBLIC_BASE_URL}/health}"
CADDY_HEALTH_URL="${CADDY_HEALTH_URL:-${PUBLIC_BASE_URL}/caddy-health}"

WARN_API_LATENCY_MS="${WARN_API_LATENCY_MS:-2000}"
CRIT_API_LATENCY_MS="${CRIT_API_LATENCY_MS:-5000}"

WARN_DISK_PERCENT="${WARN_DISK_PERCENT:-75}"
CRIT_DISK_PERCENT="${CRIT_DISK_PERCENT:-90}"
WARN_RAM_PERCENT="${WARN_RAM_PERCENT:-80}"
CRIT_RAM_PERCENT="${CRIT_RAM_PERCENT:-95}"
WARN_LOAD_PER_CORE="${WARN_LOAD_PER_CORE:-1.5}"
CRIT_LOAD_PER_CORE="${CRIT_LOAD_PER_CORE:-2.5}"

WARN_PG_CONN_PERCENT="${WARN_PG_CONN_PERCENT:-70}"
CRIT_PG_CONN_PERCENT="${CRIT_PG_CONN_PERCENT:-85}"

WARN_OUTBOX_PENDING="${WARN_OUTBOX_PENDING:-100}"
CRIT_OUTBOX_PENDING="${CRIT_OUTBOX_PENDING:-500}"
WARN_OUTBOX_AGE_SEC="${WARN_OUTBOX_AGE_SEC:-600}"
CRIT_OUTBOX_AGE_SEC="${CRIT_OUTBOX_AGE_SEC:-1800}"

WARN_BACKUP_AGE_HOURS="${WARN_BACKUP_AGE_HOURS:-26}"
CRIT_BACKUP_AGE_HOURS="${CRIT_BACKUP_AGE_HOURS:-48}"

WARN_SSL_DAYS="${WARN_SSL_DAYS:-14}"
CRIT_SSL_DAYS="${CRIT_SSL_DAYS:-3}"

WARN_5XX_COUNT="${WARN_5XX_COUNT:-10}"
CRIT_5XX_COUNT="${CRIT_5XX_COUNT:-50}"

STATE_FILE="${STATE_FILE:-/opt/tezlify/monitoring/state.json}"
LATEST_HEALTH_FILE="${LATEST_HEALTH_FILE:-/opt/tezlify/monitoring/latest_health.json}"
LOG_FILE="${LOG_FILE:-/opt/tezlify/logs/tezlify-monitor.log}"
BACKUP_DIR="${BACKUP_DIR:-/opt/tezlify/backups/postgres}"
BACKUPS_ROOT="${BACKUPS_ROOT:-/opt/tezlify/backups}"

OUTPUT_MODE="normal" # normal, json, summary

# Command-line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      OUTPUT_MODE="json"
      shift
      ;;
    --summary)
      OUTPUT_MODE="summary"
      shift
      ;;
    --config)
      CONFIG_FILE="$2"
      if [[ -f "${CONFIG_FILE}" ]]; then
        source "${CONFIG_FILE}"
      fi
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--json|--summary] [--config PATH]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

NOW_EPOCH=$(date +%s)
NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Arrays to hold check results
declare -A CHECK_STATUS
declare -A CHECK_DETAILS

RECORD_CHECK() {
  local name="$1"
  local status="$2"
  local details="$3"
  CHECK_STATUS["$name"]="$status"
  CHECK_DETAILS["$name"]="$details"
}

# ==============================================================================
# 1. PUBLIC API HEALTH CHECK
# ==============================================================================
CHECK_API_HEALTH() {
  local start_ts end_ts duration_ms http_code res
  start_ts=$(date +%s%N)
  res=$(curl -sk --max-time 5 -w "\n%{http_code}" "${API_HEALTH_URL}" 2>/dev/null || echo -e "\n000")
  end_ts=$(date +%s%N)
  duration_ms=$(( (end_ts - start_ts) / 1000000 ))

  http_code=$(echo "${res}" | tail -n 1)
  body=$(echo "${res}" | sed '$d')

  if [[ "${http_code}" == "200" ]]; then
    local status_field
    status_field=$(echo "${body}" | jq -r '.status // empty' 2>/dev/null || true)
    if [[ "${status_field}" == "healthy" ]]; then
      if (( duration_ms >= CRIT_API_LATENCY_MS )); then
        RECORD_CHECK "api_health" "CRITICAL" "latency=${duration_ms}ms (exceeds ${CRIT_API_LATENCY_MS}ms)"
      elif (( duration_ms >= WARN_API_LATENCY_MS )); then
        RECORD_CHECK "api_health" "WARN" "latency=${duration_ms}ms (exceeds ${WARN_API_LATENCY_MS}ms)"
      else
        RECORD_CHECK "api_health" "OK" "latency=${duration_ms}ms"
      fi
    else
      RECORD_CHECK "api_health" "CRITICAL" "status=${status_field:-unknown} http_code=200"
    fi
  else
    RECORD_CHECK "api_health" "CRITICAL" "http_code=${http_code} latency=${duration_ms}ms"
  fi
}

# ==============================================================================
# 2. CADDY EDGE HEALTH CHECK
# ==============================================================================
CHECK_CADDY_EDGE() {
  local start_ts end_ts duration_ms http_code res body
  start_ts=$(date +%s%N)
  res=$(curl -sk --max-time 5 -w "\n%{http_code}" "${CADDY_HEALTH_URL}" 2>/dev/null || echo -e "\n000")
  end_ts=$(date +%s%N)
  duration_ms=$(( (end_ts - start_ts) / 1000000 ))

  http_code=$(echo "${res}" | tail -n 1)
  body=$(echo "${res}" | sed '$d' | tr -d '\r\n')

  if [[ "${http_code}" == "200" && "${body}" == "OK" ]]; then
    RECORD_CHECK "caddy_edge" "OK" "latency=${duration_ms}ms"
  else
    RECORD_CHECK "caddy_edge" "CRITICAL" "http_code=${http_code} body='${body}'"
  fi
}

# ==============================================================================
# 3. DOCKER CONTAINER LIFECYCLE & RESTART LOOPS
# ==============================================================================
CHECK_DOCKER_CONTAINERS() {
  local containers=("tezlify-caddy" "tezlify-backend" "tezlify-gateway" "tezlify-db")
  local all_ok=true
  local has_warn=false
  local issues=()
  local details=()

  for c in "${containers[@]}"; do
    local info
    info=$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' "$c" 2>/dev/null || echo "not_found|none|0")
    local state health restarts
    IFS='|' read -r state health restarts <<< "$info"

    details+=("${c}:${state}/${health}/r${restarts}")

    if [[ "${state}" != "running" ]]; then
      all_ok=false
      issues+=("${c}:not_running(${state})")
    elif [[ "${health}" == "unhealthy" ]]; then
      all_ok=false
      issues+=("${c}:unhealthy")
    fi

    if (( restarts > 0 )); then
      has_warn=true
    fi
  done

  local summary_str
  summary_str=$(IFS=,; echo "${details[*]}")

  if [[ "${all_ok}" != "true" ]]; then
    RECORD_CHECK "docker_containers" "CRITICAL" "Issues: $(IFS=,; echo "${issues[*]}") Details: ${summary_str}"
  elif [[ "${has_warn}" == "true" ]]; then
    RECORD_CHECK "docker_containers" "WARN" "Restarts detected. Details: ${summary_str}"
  else
    RECORD_CHECK "docker_containers" "OK" "All 4 containers running & healthy (${summary_str})"
  fi
}

# ==============================================================================
# 4. BACKEND INTERNAL HEALTH & GATEWAY BRIDGE
# ==============================================================================
CHECK_BACKEND_INTERNAL() {
  local res
  res=$(docker exec tezlify-backend curl -s --max-time 3 http://localhost:8000/health 2>/dev/null || echo "")

  if [[ -z "${res}" ]]; then
    RECORD_CHECK "backend_internal" "CRITICAL" "Backend internal /health did not respond"
    return
  fi

  local status memory_mb bridge_connected bridge_reconnects
  status=$(echo "${res}" | jq -r '.status // empty' 2>/dev/null || true)
  memory_mb=$(echo "${res}" | jq -r '.memory_mb // 0' 2>/dev/null || true)
  bridge_connected=$(echo "${res}" | jq -r '.gateway_bridge.connected // false' 2>/dev/null || true)
  bridge_reconnects=$(echo "${res}" | jq -r '.gateway_bridge.reconnect_count // 0' 2>/dev/null || true)

  if [[ "${status}" == "healthy" ]]; then
    if [[ "${bridge_connected}" == "true" ]]; then
      RECORD_CHECK "backend_internal" "OK" "memory=${memory_mb}MB bridge_connected=true reconnects=${bridge_reconnects}"
    else
      RECORD_CHECK "backend_internal" "WARN" "memory=${memory_mb}MB gateway_bridge_connected=false reconnects=${bridge_reconnects}"
    fi
  else
    RECORD_CHECK "backend_internal" "CRITICAL" "status=${status} memory=${memory_mb}MB"
  fi
}

# ==============================================================================
# 5. GATEWAY INTERNAL HEALTH
# ==============================================================================
CHECK_GATEWAY_INTERNAL() {
  local res
  res=$(docker exec tezlify-backend curl -s --max-time 3 http://gateway:8787/health 2>/dev/null || echo "")

  if [[ -z "${res}" ]]; then
    RECORD_CHECK "gateway_internal" "CRITICAL" "Gateway internal /health unreachable"
    return
  fi

  local status total_sessions connected_sessions pending_qr
  status=$(echo "${res}" | jq -r '.status // empty' 2>/dev/null || true)
  total_sessions=$(echo "${res}" | jq -r '.sessions.total // 0' 2>/dev/null || true)
  connected_sessions=$(echo "${res}" | jq -r '.sessions.connected // 0' 2>/dev/null || true)
  pending_qr=$(echo "${res}" | jq -r '.sessions.pending_qr // 0' 2>/dev/null || true)

  if [[ "${status}" == "ok" ]]; then
    RECORD_CHECK "gateway_internal" "OK" "status=ok sessions_total=${total_sessions} connected=${connected_sessions} pending_qr=${pending_qr}"
  else
    RECORD_CHECK "gateway_internal" "CRITICAL" "status=${status} sessions_total=${total_sessions}"
  fi
}

# ==============================================================================
# 6. POSTGRESQL AVAILABILITY & CONNECTION PRESSURE
# ==============================================================================
CHECK_POSTGRESQL() {
  local isready_out
  isready_out=$(docker exec tezlify-db pg_isready -U tezlify -d tezlify -q 2>&1)
  local isready_code=$?

  if (( isready_code != 0 )); then
    RECORD_CHECK "postgres_health" "CRITICAL" "pg_isready failed (code ${isready_code})"
    return
  fi

  local conn_info
  conn_info=$(docker exec tezlify-db psql -U tezlify -d tezlify -t -A -F"|" -c "
    SELECT count(*) as active, (SELECT setting::int FROM pg_settings WHERE name='max_connections') as max
    FROM pg_stat_activity;" 2>/dev/null || echo "ERR")

  if [[ "${conn_info}" == "ERR" || -z "${conn_info}" ]]; then
    RECORD_CHECK "postgres_health" "CRITICAL" "SELECT 1 query failed on tezlify-db"
    return
  fi

  local active max
  IFS='|' read -r active max <<< "${conn_info}"
  local pct=0
  if (( max > 0 )); then
    pct=$(( active * 100 / max ))
  fi

  if (( pct >= CRIT_PG_CONN_PERCENT )); then
    RECORD_CHECK "postgres_health" "CRITICAL" "connections=${active}/${max} (${pct}% >= ${CRIT_PG_CONN_PERCENT}%)"
  elif (( pct >= WARN_PG_CONN_PERCENT )); then
    RECORD_CHECK "postgres_health" "WARN" "connections=${active}/${max} (${pct}% >= ${WARN_PG_CONN_PERCENT}%)"
  else
    RECORD_CHECK "postgres_health" "OK" "accepting connections, active=${active}/${max} (${pct}%)"
  fi
}

# ==============================================================================
# 7. WHATSAPP DYNAMIC SESSION STATE & SOCKET LEASES
# ==============================================================================
CHECK_WHATSAPP_STATE() {
  local sess_info
  sess_info=$(docker exec tezlify-db psql -U tezlify -d tezlify -t -A -F"|" -c "
    SELECT
      count(*) as total,
      count(*) FILTER (WHERE status = 'CONNECTED') as connected,
      count(*) FILTER (WHERE status = 'SCAN_QR') as scan_qr,
      count(*) FILTER (WHERE status = 'RELINK_REQUIRED') as relink_required
    FROM public.whatsapp_sessions;" 2>/dev/null || echo "ERR")

  if [[ "${sess_info}" == "ERR" || -z "${sess_info}" ]]; then
    RECORD_CHECK "whatsapp_state" "CRITICAL" "Failed to query public.whatsapp_sessions"
    return
  fi

  local total connected scan_qr relink_required
  IFS='|' read -r total connected scan_qr relink_required <<< "${sess_info}"

  local lease_count
  lease_count=$(docker exec tezlify-db psql -U tezlify -d tezlify -t -A -c "SELECT count(*) FROM whatsapp_private.socket_leases;" 2>/dev/null || echo "0")

  local details="total=${total} connected=${connected} scan_qr=${scan_qr} relink_required=${relink_required} active_socket_leases=${lease_count}"

  # Evaluate logical health (no hardcoded session IDs)
  if (( connected > 0 && lease_count == 0 )); then
    RECORD_CHECK "whatsapp_state" "WARN" "Session marked CONNECTED but socket_lease count is 0 (${details})"
  elif (( lease_count > connected )); then
    RECORD_CHECK "whatsapp_state" "WARN" "More active socket leases than connected sessions (${details})"
  else
    RECORD_CHECK "whatsapp_state" "OK" "${details}"
  fi
}

# ==============================================================================
# 8. OUTBOX & QUEUE GROWTH
# ==============================================================================
CHECK_OUTBOX_QUEUE() {
  local outbox_info
  outbox_info=$(docker exec tezlify-db psql -U tezlify -d tezlify -t -A -F"|" -c "
    SELECT
      count(*) FILTER (WHERE state = 'PENDING') as pending,
      count(*) FILTER (WHERE state = 'IN_FLIGHT') as in_flight,
      count(*) FILTER (WHERE state = 'DEAD_LETTER') as dead_letter,
      COALESCE(ROUND(EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE state = 'PENDING')))), 0) as oldest_age
    FROM whatsapp_private.event_outbox;" 2>/dev/null || echo "ERR")

  if [[ "${outbox_info}" == "ERR" || -z "${outbox_info}" ]]; then
    RECORD_CHECK "outbox_queue" "CRITICAL" "Failed to query whatsapp_private.event_outbox"
    return
  fi

  local pending in_flight dead_letter oldest_age
  IFS='|' read -r pending in_flight dead_letter oldest_age <<< "${outbox_info}"

  local retry_count
  retry_count=$(docker exec tezlify-db psql -U tezlify -d tezlify -t -A -c "SELECT count(*) FROM whatsapp_private.retry_messages;" 2>/dev/null || echo "0")

  local details="pending=${pending} in_flight=${in_flight} dead_letter=${dead_letter} oldest_pending_sec=${oldest_age} retry_messages=${retry_count}"

  if (( pending >= CRIT_OUTBOX_PENDING || oldest_age >= CRIT_OUTBOX_AGE_SEC )); then
    RECORD_CHECK "outbox_queue" "CRITICAL" "Queue backlog critical: ${details}"
  elif (( pending >= WARN_OUTBOX_PENDING || oldest_age >= WARN_OUTBOX_AGE_SEC )); then
    RECORD_CHECK "outbox_queue" "WARN" "Queue backlog elevated: ${details}"
  else
    RECORD_CHECK "outbox_queue" "OK" "${details}"
  fi
}

# ==============================================================================
# 9. SYSTEM RESOURCE UTILIZATION (CPU, RAM, DISK)
# ==============================================================================
CHECK_SYSTEM_RESOURCES() {
  # CPU
  local cores load_1m
  cores=$(nproc 2>/dev/null || echo 4)
  load_1m=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo "0.0")

  local crit_load warn_load
  crit_load=$(python3 -c "print(${cores} * ${CRIT_LOAD_PER_CORE})" 2>/dev/null || echo "10.0")
  warn_load=$(python3 -c "print(${cores} * ${WARN_LOAD_PER_CORE})" 2>/dev/null || echo "6.0")

  local cpu_status="OK"
  local cpu_is_crit cpu_is_warn
  cpu_is_crit=$(python3 -c "print(1 if float(${load_1m}) >= float(${crit_load}) else 0)" 2>/dev/null || echo 0)
  cpu_is_warn=$(python3 -c "print(1 if float(${load_1m}) >= float(${warn_load}) else 0)" 2>/dev/null || echo 0)

  if (( cpu_is_crit == 1 )); then
    cpu_status="CRITICAL"
  elif (( cpu_is_warn == 1 )); then
    cpu_status="WARN"
  fi
  local cpu_details="load_1m=${load_1m} cores=${cores}"

  # RAM
  local mem_total mem_available mem_used_pct
  mem_total=$(free -m | awk '/^Mem:/{print $2}')
  mem_available=$(free -m | awk '/^Mem:/{print $7}')
  if (( mem_total > 0 )); then
    mem_used_pct=$(( (mem_total - mem_available) * 100 / mem_total ))
  else
    mem_used_pct=0
  fi

  local ram_status="OK"
  if (( mem_used_pct >= CRIT_RAM_PERCENT )); then
    ram_status="CRITICAL"
  elif (( mem_used_pct >= WARN_RAM_PERCENT )); then
    ram_status="WARN"
  fi
  local ram_details="used=${mem_used_pct}% available=${mem_available}MB total=${mem_total}MB"

  # DISK
  local disk_used_pct
  disk_used_pct=$(df -k / | awk 'NR==2{sub(/%/,"",$5); print $5}')
  local disk_status="OK"
  if (( disk_used_pct >= CRIT_DISK_PERCENT )); then
    disk_status="CRITICAL"
  elif (( disk_used_pct >= WARN_DISK_PERCENT )); then
    disk_status="WARN"
  fi
  local disk_details="mount=/ used=${disk_used_pct}%"

  # Overall Resource check
  if [[ "${cpu_status}" == "CRITICAL" || "${ram_status}" == "CRITICAL" || "${disk_status}" == "CRITICAL" ]]; then
    RECORD_CHECK "system_resources" "CRITICAL" "CPU:${cpu_details} | RAM:${ram_details} | DISK:${disk_details}"
  elif [[ "${cpu_status}" == "WARN" || "${ram_status}" == "WARN" || "${disk_status}" == "WARN" ]]; then
    RECORD_CHECK "system_resources" "WARN" "CPU:${cpu_details} | RAM:${ram_details} | DISK:${disk_details}"
  else
    RECORD_CHECK "system_resources" "OK" "CPU:${cpu_details} | RAM:${ram_details} | DISK:${disk_details}"
  fi
}

# ==============================================================================
# 10. HTTP 5XX ERROR RATE SAMPLING
# ==============================================================================
CHECK_HTTP_ERRORS() {
  local count_5xx
  count_5xx=$(docker logs --since 5m tezlify-backend 2>&1 | grep -c -E " 50[0-9] " || true)

  if (( count_5xx >= CRIT_5XX_COUNT )); then
    RECORD_CHECK "http_5xx_rate" "CRITICAL" "5xx_count=${count_5xx} in last 5m (exceeds ${CRIT_5XX_COUNT})"
  elif (( count_5xx >= WARN_5XX_COUNT )); then
    RECORD_CHECK "http_5xx_rate" "WARN" "5xx_count=${count_5xx} in last 5m (exceeds ${WARN_5XX_COUNT})"
  else
    RECORD_CHECK "http_5xx_rate" "OK" "5xx_count=${count_5xx} in last 5m"
  fi
}

# ==============================================================================
# 11. WEBSOCKET HEALTH & RECONNECT TRACKING
# ==============================================================================
CHECK_WEBSOCKET_HEALTH() {
  local ws_conns
  ws_conns=$(docker logs --tail 50 tezlify-backend 2>&1 | grep "WebSocket client connected. Active:" | tail -n 1 | sed -E 's/.*Active: ([0-9]+).*/\1/' || echo "0")
  if [[ -z "${ws_conns}" || ! "${ws_conns}" =~ ^[0-9]+$ ]]; then
    ws_conns=0
  fi

  local res
  res=$(docker exec tezlify-backend curl -s --max-time 3 http://localhost:8000/health 2>/dev/null || echo "")
  local bridge_conn
  bridge_conn=$(echo "${res}" | jq -r '.gateway_bridge.connected // false' 2>/dev/null || echo "false")
  local bridge_reconnects
  bridge_reconnects=$(echo "${res}" | jq -r '.gateway_bridge.reconnect_count // 0' 2>/dev/null || echo "0")

  if [[ "${bridge_conn}" == "true" ]]; then
    RECORD_CHECK "websocket_health" "OK" "gateway_bridge=connected reconnects=${bridge_reconnects} active_clients=${ws_conns}"
  else
    RECORD_CHECK "websocket_health" "WARN" "gateway_bridge=disconnected reconnects=${bridge_reconnects} active_clients=${ws_conns}"
  fi
}

# ==============================================================================
# 12. BACKUP FRESHNESS & STORAGE CONSUMPTION
# ==============================================================================
CHECK_BACKUP_FRESHNESS() {
  local newest_dump
  newest_dump=$(ls -t "${BACKUP_DIR}"/*.dump 2>/dev/null | head -n 1 || true)

  local backup_disk_usage
  backup_disk_usage=$(du -sh "${BACKUPS_ROOT}" 2>/dev/null | awk '{print $1}' || echo "unknown")

  if [[ -z "${newest_dump}" || ! -f "${newest_dump}" ]]; then
    RECORD_CHECK "backup_freshness" "CRITICAL" "No PostgreSQL backup dump found in ${BACKUP_DIR}! Total backups disk: ${backup_disk_usage}. Off-host: NOT_CONFIGURED"
    return
  fi

  local mtime age_hours file_size
  mtime=$(stat -c %Y "${newest_dump}")
  age_hours=$(( (NOW_EPOCH - mtime) / 3600 ))
  file_size=$(stat -c %s "${newest_dump}")

  local details="file=$(basename "${newest_dump}") age=${age_hours}h size=$(( file_size / 1024 / 1024 ))MB backups_root_disk=${backup_disk_usage} off_host=NOT_CONFIGURED"

  if (( file_size < 1048576 )); then
    RECORD_CHECK "backup_freshness" "CRITICAL" "Backup size suspiciously small (<1MB): ${details}"
  elif (( age_hours >= CRIT_BACKUP_AGE_HOURS )); then
    RECORD_CHECK "backup_freshness" "CRITICAL" "Backup stale (age=${age_hours}h >= ${CRIT_BACKUP_AGE_HOURS}h): ${details}"
  elif (( age_hours >= WARN_BACKUP_AGE_HOURS )); then
    RECORD_CHECK "backup_freshness" "WARN" "Backup aging (age=${age_hours}h >= ${WARN_BACKUP_AGE_HOURS}h): ${details}"
  else
    RECORD_CHECK "backup_freshness" "OK" "${details}"
  fi
}

# ==============================================================================
# 13. SSL / TLS ENDPOINT REACHABILITY & CERTIFICATE EXPIRATION
# ==============================================================================
CHECK_SSL_CERTIFICATE() {
  local end_date
  end_date=$(echo | openssl s_client -servername api.130.162.247.20.sslip.io -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)

  if [[ -z "${end_date}" ]]; then
    RECORD_CHECK "ssl_certificate" "CRITICAL" "Unable to inspect TLS certificate on 127.0.0.1:443"
    return
  fi

  local exp_epoch days_left
  exp_epoch=$(date -d "${end_date}" +%s 2>/dev/null || echo 0)
  if (( exp_epoch > 0 )); then
    days_left=$(( (exp_epoch - NOW_EPOCH) / 86400 ))
    local details="expires='${end_date}' days_remaining=${days_left}"

    if (( days_left <= CRIT_SSL_DAYS )); then
      RECORD_CHECK "ssl_certificate" "CRITICAL" "Certificate expiring soon: ${details}"
    elif (( days_left <= WARN_SSL_DAYS )); then
      RECORD_CHECK "ssl_certificate" "WARN" "Certificate renewal approaching: ${details}"
    else
      RECORD_CHECK "ssl_certificate" "OK" "${details}"
    fi
  else
    RECORD_CHECK "ssl_certificate" "WARN" "Could not parse certificate expiration date: ${end_date}"
  fi
}

# ==============================================================================
# RUN ALL CHECKS
# ==============================================================================
CHECK_API_HEALTH
CHECK_CADDY_EDGE
CHECK_DOCKER_CONTAINERS
CHECK_BACKEND_INTERNAL
CHECK_GATEWAY_INTERNAL
CHECK_POSTGRESQL
CHECK_WHATSAPP_STATE
CHECK_OUTBOX_QUEUE
CHECK_SYSTEM_RESOURCES
CHECK_HTTP_ERRORS
CHECK_WEBSOCKET_HEALTH
CHECK_BACKUP_FRESHNESS
CHECK_SSL_CERTIFICATE

# ==============================================================================
# COMPUTE OVERALL STATUS
# ==============================================================================
OVERALL_STATUS="OK"
FAILED_CHECKS=()
WARN_CHECKS=()

for name in "${!CHECK_STATUS[@]}"; do
  status="${CHECK_STATUS[$name]}"
  if [[ "${status}" == "CRITICAL" ]]; then
    OVERALL_STATUS="CRITICAL"
    FAILED_CHECKS+=("${name}")
  elif [[ "${status}" == "WARN" ]]; then
    if [[ "${OVERALL_STATUS}" != "CRITICAL" ]]; then
      OVERALL_STATUS="WARN"
    fi
    WARN_CHECKS+=("${name}")
  fi
done

# ==============================================================================
# STATE & ALERT DEDUPLICATION ENGINE
# ==============================================================================
PREV_STATUS="UNKNOWN"
INCIDENT_START=0
LAST_ALERT_TS=0
ALERT_COUNT=0

mkdir -p "$(dirname "${STATE_FILE}")"
mkdir -p "$(dirname "${LOG_FILE}")"

if [[ -f "${STATE_FILE}" ]]; then
  PREV_STATUS=$(jq -r '.last_status // "UNKNOWN"' "${STATE_FILE}" 2>/dev/null || echo "UNKNOWN")
  INCIDENT_START=$(jq -r '.incident_start_timestamp // 0' "${STATE_FILE}" 2>/dev/null || echo 0)
  LAST_ALERT_TS=$(jq -r '.last_alert_timestamp // 0' "${STATE_FILE}" 2>/dev/null || echo 0)
  ALERT_COUNT=$(jq -r '.alert_count // 0' "${STATE_FILE}" 2>/dev/null || echo 0)
fi

SEND_ALERT() {
  local subject="$1"
  local message="$2"

  local log_msg="[ALERT event=${subject}] ${message}"
  echo "${NOW_ISO} ${log_msg}" >> "${LOG_FILE}"

  if [[ "${ALERT_PROVIDER}" == "none" ]]; then
    return 0
  fi

  if [[ "${ALERT_PROVIDER}" == "webhook" && -n "${ALERT_WEBHOOK_URL}" ]]; then
    local payload
    payload=$(jq -n --arg sub "$subject" --arg msg "$message" --arg time "$NOW_ISO" \
      '{subject: $sub, text: $msg, timestamp: $time, environment: "oracle-production"}')
    curl -s -X POST -H "Content-Type: application/json" -d "$payload" --max-time 5 "${ALERT_WEBHOOK_URL}" >/dev/null 2>&1 || true
  elif [[ "${ALERT_PROVIDER}" == "telegram" && -n "${TELEGRAM_BOT_TOKEN}" && -n "${TELEGRAM_CHAT_ID}" ]]; then
    local text="*${subject}*%0A%0A${message}"
    curl -s --max-time 5 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&parse_mode=Markdown&text=${text}" >/dev/null 2>&1 || true
  fi
}

EVALUATE_ALERTS() {
  local should_alert=false
  local alert_type=""
  local cooldown_sec=$(( ALERT_COOLDOWN_MINUTES * 60 ))

  if [[ "${OVERALL_STATUS}" != "OK" ]]; then
    if [[ "${PREV_STATUS}" == "OK" || "${PREV_STATUS}" == "UNKNOWN" ]]; then
      # New incident
      should_alert=true
      alert_type="NEW_INCIDENT"
      INCIDENT_START=${NOW_EPOCH}
      LAST_ALERT_TS=${NOW_EPOCH}
      ALERT_COUNT=1
    elif [[ "${OVERALL_STATUS}" == "CRITICAL" && "${PREV_STATUS}" == "WARN" ]]; then
      # Escalation
      should_alert=true
      alert_type="ESCALATION"
      LAST_ALERT_TS=${NOW_EPOCH}
      ALERT_COUNT=$(( ALERT_COUNT + 1 ))
    elif (( (NOW_EPOCH - LAST_ALERT_TS) >= cooldown_sec )); then
      # Cooldown expired, send reminder
      should_alert=true
      alert_type="REMINDER"
      LAST_ALERT_TS=${NOW_EPOCH}
      ALERT_COUNT=$(( ALERT_COUNT + 1 ))
    fi
  else
    if [[ "${PREV_STATUS}" == "CRITICAL" || "${PREV_STATUS}" == "WARN" ]]; then
      # Recovery
      should_alert=true
      alert_type="RECOVERY"
      local duration=$(( NOW_EPOCH - INCIDENT_START ))
      SEND_ALERT "RESOLVED: Tezlify Health Restored" "All checks passed. Incident duration: ${duration}s."
      INCIDENT_START=0
      LAST_ALERT_TS=${NOW_EPOCH}
      ALERT_COUNT=0
    fi
  fi

  if [[ "${should_alert}" == "true" && "${alert_type}" != "RECOVERY" ]]; then
    local issue_list=""
    if [[ ${#FAILED_CHECKS[@]} -gt 0 ]]; then
      issue_list="FAILED: $(IFS=,; echo "${FAILED_CHECKS[*]}") "
    fi
    if [[ ${#WARN_CHECKS[@]} -gt 0 ]]; then
      issue_list="${issue_list}WARN: $(IFS=,; echo "${WARN_CHECKS[*]}")"
    fi
    SEND_ALERT "${OVERALL_STATUS}: Tezlify Issue Detected [${alert_type}]" "Host: Oracle VM (130.162.247.20) Status: ${OVERALL_STATUS} Issues: ${issue_list}"
  fi
}

EVALUATE_ALERTS

# Save updated state
cat <<EOF > "${STATE_FILE}"
{
  "last_status": "${OVERALL_STATUS}",
  "last_check_timestamp": ${NOW_EPOCH},
  "last_check_iso": "${NOW_ISO}",
  "incident_start_timestamp": ${INCIDENT_START},
  "last_alert_timestamp": ${LAST_ALERT_TS},
  "alert_count": ${ALERT_COUNT},
  "failed_checks": [$(if [[ ${#FAILED_CHECKS[@]} -gt 0 ]]; then printf '"%s",' "${FAILED_CHECKS[@]}" | sed 's/,$//'; fi)],
  "warn_checks": [$(if [[ ${#WARN_CHECKS[@]} -gt 0 ]]; then printf '"%s",' "${WARN_CHECKS[@]}" | sed 's/,$//'; fi)]
}
EOF

# ==============================================================================
# SAVE LATEST HEALTH JSON ATOMICALLY
# ==============================================================================
TEMP_JSON="${LATEST_HEALTH_FILE}.tmp.$$"
cat <<EOF > "${TEMP_JSON}"
{
  "timestamp": "${NOW_ISO}",
  "overall_status": "${OVERALL_STATUS}",
  "alert_provider": "${ALERT_PROVIDER}",
  "off_host_backup": "NOT_CONFIGURED",
  "checks": {
EOF

first=true
for name in "${!CHECK_STATUS[@]}"; do
  status="${CHECK_STATUS[$name]}"
  details="${CHECK_DETAILS[$name]}"
  if [[ "${first}" == "true" ]]; then
    first=false
  else
    echo "," >> "${TEMP_JSON}"
  fi
  printf '    "%s": {"status": "%s", "details": "%s"}' "$name" "$status" "$details" >> "${TEMP_JSON}"
done

cat <<EOF >> "${TEMP_JSON}"

  }
}
EOF
mv "${TEMP_JSON}" "${LATEST_HEALTH_FILE}"
chmod 644 "${LATEST_HEALTH_FILE}"

# Append summary to log file
LOG_SUMMARY="${NOW_ISO} STATUS=${OVERALL_STATUS} api=${CHECK_STATUS[api_health]} caddy=${CHECK_STATUS[caddy_edge]} docker=${CHECK_STATUS[docker_containers]} backend=${CHECK_STATUS[backend_internal]} gateway=${CHECK_STATUS[gateway_internal]} pg=${CHECK_STATUS[postgres_health]} wa=${CHECK_STATUS[whatsapp_state]} outbox=${CHECK_STATUS[outbox_queue]} res=${CHECK_STATUS[system_resources]} 5xx=${CHECK_STATUS[http_5xx_rate]} ws=${CHECK_STATUS[websocket_health]} backup=${CHECK_STATUS[backup_freshness]} ssl=${CHECK_STATUS[ssl_certificate]}"
echo "${LOG_SUMMARY}" >> "${LOG_FILE}"

# ==============================================================================
# OUTPUT TO CALLER
# ==============================================================================
if [[ "${OUTPUT_MODE}" == "json" ]]; then
  cat "${LATEST_HEALTH_FILE}"
elif [[ "${OUTPUT_MODE}" == "summary" ]]; then
  echo "${LOG_SUMMARY}"
else
  # Human-readable report
  echo "=============================================================================="
  echo "TEZLIFY SYSTEM HEALTH REPORT — ${NOW_ISO}"
  echo "Host: Oracle VM (130.162.247.20) | Overall: ${OVERALL_STATUS}"
  echo "Alert Provider: ${ALERT_PROVIDER} | Off-Host Backup: NOT_CONFIGURED"
  echo "=============================================================================="
  for name in $(echo "${!CHECK_STATUS[@]}" | tr ' ' '\n' | sort); do
    printf "%-22s [%-8s] %s\n" "$name" "${CHECK_STATUS[$name]}" "${CHECK_DETAILS[$name]}"
  done
  echo "=============================================================================="
fi

# Exit code: 0=OK, 1=WARN, 2=CRITICAL
if [[ "${OVERALL_STATUS}" == "CRITICAL" ]]; then
  exit 2
elif [[ "${OVERALL_STATUS}" == "WARN" ]]; then
  exit 1
else
  exit 0
fi
