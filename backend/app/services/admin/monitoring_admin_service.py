"""Monitoring & WhatsApp Invariants service for Admin Center.

Invariants:
- Combines Phase 10.2 (system monitor) and Phase 10.5 (WhatsApp observer) data.
- Evaluates R1-R13 invariants and recent observation time-series.
- Robust JSON parsing: never crashes on missing or corrupted files.
- Zero sensitive data or message payloads returned.
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.app.core.config import settings
from backend.app.schemas.admin import (
    AdminTimerInfo,
    AdminObservationMetadata,
    AdminInvariantStatus,
    AdminObservationRecord,
    AdminMonitoringResponse,
)

logger = logging.getLogger(__name__)

INVARIANT_DEFINITIONS = [
    ("R1_no_unexpected_restarts", "Container Restarts", "Zero unexpected container restart events"),
    ("R2_no_oom_kills", "OOM Kill Protection", "Zero out-of-memory container termination flags"),
    ("R3_postgres_reachable", "Database Reachability", "PostgreSQL database actively accepting connections"),
    ("R4_gateway_bridge_connected", "Gateway Bridge Link", "Backend to WhatsApp gateway WebSocket bridge connected"),
    ("R5_no_duplicate_socket_ownership", "Socket Lease Singularity", "At most one active socket lease per connected session"),
    ("R6_no_stale_leases", "Lease Freshness", "Zero orphaned or stale socket leases accumulating in private schema"),
    ("R7_outbox_pending_stable", "Outbox Delivery Throughput", "Event outbox PENDING backlog remains within baseline limits (<= 10)"),
    ("R8_retry_backlog_stable", "Retry Backlog Integrity", "Transient retry message store backlog is stable"),
    ("R9_dead_letters_stable", "Dead Letter Stability", "Dead-letter message count does not grow past historical baseline (<= 109)"),
    ("R10_no_reconnect_storm", "Bridge Reconnect Throttling", "Gateway bridge reconnect attempts remain bounded (<= 5)"),
    ("R11_rss_stable", "Memory RSS Budget", "Backend and Gateway resident set sizes remain within 500MB budget"),
    ("R12_gateway_healthy", "Gateway Health Status", "Baileys WhatsApp gateway HTTP health probe reports OK"),
    ("R13_all_containers_running", "Container Fleet Health", "All 4 core production containers actively running"),
]


def _read_json_file(filepath: str) -> Optional[Dict[str, Any]]:
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else None
    except Exception as e:
        logger.debug("Failed to read JSON from %s: %s", filepath, e)
        return None


def get_monitoring_metrics() -> AdminMonitoringResponse:
    now_iso = datetime.now(timezone.utc).isoformat()

    runtime_dir = getattr(settings, "TEZLIFY_RUNTIME_DIR", "/opt/tezlify/runtime/whatsapp-reliability")
    monitoring_dir = getattr(settings, "TEZLIFY_MONITORING_DIR", "/opt/tezlify/monitoring")

    baseline_path = os.path.join(runtime_dir, "baseline.json")
    current_path = os.path.join(runtime_dir, "current.json")
    observations_path = os.path.join(runtime_dir, "observations.jsonl")
    latest_health_path = os.path.join(monitoring_dir, "latest_health.json")

    baseline_data = _read_json_file(baseline_path)
    current_data = _read_json_file(current_path)
    health_data = _read_json_file(latest_health_path)

    # 1. System Monitor (Phase 10.2)
    sys_latest_run = health_data.get("timestamp") if health_data else None
    sys_status = "active" if health_data else "not_configured"
    system_monitor = AdminTimerInfo(
        timer_status=sys_status,
        interval="every 3m",
        latest_run=sys_latest_run,
    )

    # 2. WhatsApp Observer (Phase 10.5)
    wa_latest_run = current_data.get("timestamp") if current_data else None
    wa_status = "active" if current_data else "not_configured"
    whatsapp_observer = AdminTimerInfo(
        timer_status=wa_status,
        interval="every 5m",
        latest_run=wa_latest_run,
    )

    # 3. Observation Metadata
    baseline_ts = baseline_data.get("timestamp") if baseline_data else None
    latest_ts = wa_latest_run

    observed_duration_str = None
    sample_count = 0
    obs_status = "OBSERVATION_WINDOW_INCOMPLETE"

    # Count samples from observations.jsonl
    recent_records: List[AdminObservationRecord] = []
    if os.path.exists(observations_path):
        try:
            with open(observations_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
                sample_count = len(lines)
                tail_lines = lines[-20:] if len(lines) > 20 else lines
                for line in reversed(tail_lines):
                    line_str = line.strip()
                    if not line_str:
                        continue
                    try:
                        record = json.loads(line_str)
                        c_dict = record.get("containers", {})
                        db_dict = record.get("db", {})
                        ob_dict = db_dict.get("outbox", {})
                        recent_records.append(
                            AdminObservationRecord(
                                timestamp=record.get("timestamp", ""),
                                all_invariants_pass=bool(record.get("all_invariants_pass", False)),
                                loadavg=record.get("loadavg", []),
                                active_socket_leases=int(db_dict.get("active_socket_leases", 0)),
                                outbox_pending=int(ob_dict.get("pending", 0)),
                                dead_letter=int(ob_dict.get("dead_letter", 0)),
                                backend_rss_mb=float(c_dict.get("backend", {}).get("rss_mb", 0.0)),
                                gateway_rss_mb=float(c_dict.get("gateway", {}).get("rss_mb", 0.0)),
                            )
                        )
                    except Exception:
                        continue
        except Exception as oe:
            logger.debug("Could not read observations.jsonl: %s", oe)

    elapsed_sec = None
    target_sec = 72.0 * 3600.0
    remaining_sec = None
    progress_pct = None

    if baseline_ts and latest_ts:
        try:
            b_dt = datetime.fromisoformat(baseline_ts.replace("Z", "+00:00"))
            l_dt = datetime.fromisoformat(latest_ts.replace("Z", "+00:00"))
            diff = l_dt - b_dt
            diff_sec = max(0.0, diff.total_seconds())
            elapsed_sec = round(diff_sec, 1)
            remaining_sec = max(0.0, round(target_sec - diff_sec, 1))
            progress_pct = min(100.0, round((diff_sec / target_sec) * 100.0, 1))
            hours = diff_sec / 3600.0
            observed_duration_str = f"{hours:.1f} hours"
            if hours >= 72.0:
                obs_status = "OBSERVATION_WINDOW_COMPLETE"
        except Exception:
            observed_duration_str = None

    observation_meta = AdminObservationMetadata(
        baseline_timestamp=baseline_ts,
        latest_observation_timestamp=latest_ts,
        observed_duration=observed_duration_str,
        target_duration="72 hours",
        observation_status=obs_status,
        sample_count=sample_count,
        elapsed_seconds=elapsed_sec,
        target_seconds=target_sec,
        remaining_seconds=remaining_sec,
        progress_percent=progress_pct,
    )

    # 4. R1-R13 Invariants evaluation
    invariants_list: List[AdminInvariantStatus] = []
    inv_data = current_data.get("invariants", {}) if current_data else {}

    for inv_id, inv_name, safe_desc in INVARIANT_DEFINITIONS:
        passed = bool(inv_data.get(inv_id, False)) if current_data else False
        invariants_list.append(
            AdminInvariantStatus(
                id=inv_id,
                name=inv_name,
                passed=passed,
                last_evaluated_at=latest_ts,
                safe_summary=safe_desc,
            )
        )

    # 5. Determine deterministic overall monitoring status
    overall_status = "OK"
    overall_status_reasons: List[str] = []

    critical_invs = {"R1_no_unexpected_restarts", "R2_no_oom_kills", "R3_postgres_reachable", "R13_all_containers_running"}
    failing_invariants = [inv for inv in invariants_list if not inv.passed]

    has_critical_failure = any(inv.id in critical_invs for inv in failing_invariants)
    if has_critical_failure:
        overall_status = "CRITICAL"
        for inv in failing_invariants:
            if inv.id in critical_invs:
                overall_status_reasons.append(f"Critical invariant failed: {inv.name}")
    elif failing_invariants:
        overall_status = "WARN"
        for inv in failing_invariants:
            overall_status_reasons.append(f"Invariant advisory: {inv.name}")

    if system_monitor.timer_status != "active":
        if overall_status != "CRITICAL":
            overall_status = "WARN"
        overall_status_reasons.append("System health monitor timer is not active")

    if whatsapp_observer.timer_status != "active":
        if overall_status != "CRITICAL":
            overall_status = "WARN"
        overall_status_reasons.append("WhatsApp reliability observer timer is not active")

    if obs_status == "OBSERVATION_WINDOW_INCOMPLETE":
        if overall_status != "CRITICAL":
            overall_status = "WARN"
        overall_status_reasons.append("WhatsApp reliability 72h observation window incomplete")

    if overall_status == "OK":
        overall_status_reasons.append("All monitoring invariants verified and timers operational")

    return AdminMonitoringResponse(
        timestamp=now_iso,
        overall_status=overall_status,
        overall_status_reasons=overall_status_reasons,
        system_monitor=system_monitor,
        whatsapp_observer=whatsapp_observer,
        observation=observation_meta,
        invariants=invariants_list,
        recent_observations=recent_records,
    )
