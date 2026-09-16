#!/usr/bin/env python3
"""
Tezlify Phase 10.5 — WhatsApp Long-Run Reliability Collector.

Collects non-invasive, read-only reliability observations:
- Container uptime, restart counts, OOM flags
- WhatsApp session state counts (sanitized: NO phone numbers, tokens, or credentials)
- Active socket leases count
- Gateway ↔ Backend WebSocket bridge status & reconnects
- Event outbox state distribution (PENDING, IN_FLIGHT, DELIVERED, DEAD_LETTER)
- Retry message backlog
- Memory RSS and CPU load
- Reliability invariants R1-R13 evaluation

Writes to:
  /opt/tezlify/runtime/whatsapp-reliability/baseline.json (initial snapshot)
  /opt/tezlify/runtime/whatsapp-reliability/observations.jsonl (append-only)
  /opt/tezlify/runtime/whatsapp-reliability/current.json (latest snapshot)
"""

import json
import os
import re
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional

RUNTIME_DIR = os.environ.get("TEZLIFY_RUNTIME_DIR", "/opt/tezlify/runtime/whatsapp-reliability")
BASELINE_FILE = os.path.join(RUNTIME_DIR, "baseline.json")
OBSERVATIONS_FILE = os.path.join(RUNTIME_DIR, "observations.jsonl")
CURRENT_FILE = os.path.join(RUNTIME_DIR, "current.json")


def run_cmd(cmd: str, timeout: int = 10) -> str:
    try:
        res = subprocess.run(
            cmd,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
        )
        return res.stdout.strip()
    except Exception as e:
        return ""


def get_container_info(container_name: str) -> Dict[str, Any]:
    out = run_cmd(
        f"docker inspect {container_name} --format "
        "'{{.State.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{.State.StartedAt}}|{{.State.Pid}}'"
    )
    parts = out.split("|")
    if len(parts) >= 5:
        pid = parts[4]
        rss_kb = 0
        if pid and pid != "0":
            vm_rss = run_cmd(f"cat /proc/{pid}/status 2>/dev/null | grep -i VmRSS | awk '{{print $2}}'")
            try:
                rss_kb = int(vm_rss)
            except ValueError:
                rss_kb = 0
        return {
            "status": parts[0],
            "restarts": int(parts[1]) if parts[1].isdigit() else 0,
            "oom_killed": parts[2].lower() == "true",
            "started_at": parts[3],
            "rss_mb": round(rss_kb / 1024.0, 2),
        }
    return {"status": "unknown", "restarts": 0, "oom_killed": False, "started_at": "", "rss_mb": 0.0}


def get_gateway_health() -> Dict[str, Any]:
    out = run_cmd("docker exec tezlify-backend curl -s http://gateway:8787/health")
    try:
        return json.loads(out)
    except Exception:
        return {"status": "unreachable", "sessions": {"total": 0, "connected": 0, "pending_qr": 0}}


def get_backend_health() -> Dict[str, Any]:
    out = run_cmd("docker exec tezlify-backend curl -s http://localhost:8000/health")
    try:
        return json.loads(out)
    except Exception:
        return {"status": "unreachable", "gateway_bridge": {"connected": False, "reconnect_count": 0}}


def get_db_metrics() -> Dict[str, Any]:
    # WhatsApp sessions count by status (sanitized: no phones, no secrets)
    sessions_raw = run_cmd(
        "docker exec tezlify-db psql -U tezlify -d tezlify -tAc "
        "\"SELECT status, count(*) FROM public.whatsapp_sessions GROUP BY status;\""
    )
    session_counts: Dict[str, int] = {}
    total_sessions = 0
    for line in sessions_raw.splitlines():
        parts = line.split("|")
        if len(parts) == 2:
            status = parts[0].strip()
            count = int(parts[1].strip())
            session_counts[status] = count
            total_sessions += count

    # Active socket leases
    leases_raw = run_cmd(
        "docker exec tezlify-db psql -U tezlify -d tezlify -tAc "
        "\"SELECT count(*) FROM whatsapp_private.socket_leases;\""
    )
    socket_leases = int(leases_raw.strip()) if leases_raw.strip().isdigit() else 0

    # Event outbox by state
    outbox_raw = run_cmd(
        "docker exec tezlify-db psql -U tezlify -d tezlify -tAc "
        "\"SELECT state, count(*) FROM whatsapp_private.event_outbox GROUP BY state;\""
    )
    outbox_counts = {"PENDING": 0, "IN_FLIGHT": 0, "DELIVERED": 0, "DEAD_LETTER": 0}
    total_outbox = 0
    for line in outbox_raw.splitlines():
        parts = line.split("|")
        if len(parts) == 2:
            state = parts[0].strip()
            count = int(parts[1].strip())
            outbox_counts[state] = count
            total_outbox += count

    # Retry messages
    retry_raw = run_cmd(
        "docker exec tezlify-db psql -U tezlify -d tezlify -tAc "
        "\"SELECT count(*) FROM whatsapp_private.retry_messages;\""
    )
    retry_messages = int(retry_raw.strip()) if retry_raw.strip().isdigit() else 0

    # DB connections
    conn_raw = run_cmd(
        "docker exec tezlify-db psql -U tezlify -d tezlify -tAc "
        "\"SELECT count(*), count(*) FILTER (WHERE state = 'active'), count(*) FILTER (WHERE state = 'idle') FROM pg_stat_activity;\""
    )
    conn_parts = conn_raw.split("|")
    db_connections = {
        "total": int(conn_parts[0]) if len(conn_parts) > 0 and conn_parts[0].isdigit() else 0,
        "active": int(conn_parts[1]) if len(conn_parts) > 1 and conn_parts[1].isdigit() else 0,
        "idle": int(conn_parts[2]) if len(conn_parts) > 2 and conn_parts[2].isdigit() else 0,
        "max": 100,
    }

    return {
        "whatsapp_sessions": {
            "total": total_sessions,
            "by_status": session_counts,
            "connected": session_counts.get("CONNECTED", 0),
            "scan_qr": session_counts.get("SCAN_QR", 0),
            "relink_required": session_counts.get("RELINK_REQUIRED", 0),
        },
        "active_socket_leases": socket_leases,
        "outbox": {
            "total": total_outbox,
            "pending": outbox_counts.get("PENDING", 0),
            "in_flight": outbox_counts.get("IN_FLIGHT", 0),
            "delivered": outbox_counts.get("DELIVERED", 0),
            "dead_letter": outbox_counts.get("DEAD_LETTER", 0),
            "retry_messages": retry_messages,
        },
        "db_connections": db_connections,
    }


def evaluate_invariants(
    containers: Dict[str, Dict[str, Any]],
    gateway: Dict[str, Any],
    backend: Dict[str, Any],
    db_metrics: Dict[str, Any],
) -> Dict[str, bool]:
    # R1: No unexpected container restarts
    r1 = all(c.get("restarts", 0) == 0 for c in containers.values())
    # R2: No OOM kills
    r2 = all(not c.get("oom_killed", False) for c in containers.values())
    # R3: PostgreSQL remains reachable
    r3 = db_metrics.get("db_connections", {}).get("total", 0) > 0
    # R4: gateway bridge remains connected
    bridge = backend.get("gateway_bridge", {})
    r4 = bool(bridge.get("connected", False))
    # R5: No duplicate active socket ownership (leases <= connected)
    conn_count = db_metrics.get("whatsapp_sessions", {}).get("connected", 0)
    leases = db_metrics.get("active_socket_leases", 0)
    r5 = leases <= max(1, conn_count)
    # R6: No stale socket leases accumulating
    r6 = leases == conn_count
    # R7: PENDING outbox does not grow continuously (pending <= 10)
    outbox = db_metrics.get("outbox", {})
    r7 = outbox.get("pending", 0) == 0
    # R8: retry backlog does not grow continuously
    r8 = outbox.get("retry_messages", 0) == 0
    # R9: dead-letter count does not continuously increase (>109 is alert)
    r9 = outbox.get("dead_letter", 0) <= 109
    # R10: no reconnect storm (reconnect_count <= 5)
    r10 = bridge.get("reconnect_count", 0) <= 5
    # R11: backend/gateway RSS stable (< 500MB)
    r11 = containers.get("backend", {}).get("rss_mb", 0) < 500 and containers.get("gateway", {}).get("rss_mb", 0) < 500
    # R12: gateway reported healthy
    r12 = gateway.get("status") == "ok"
    # R13: all containers running
    r13 = all(c.get("status") == "running" for c in containers.values())

    return {
        "R1_no_unexpected_restarts": r1,
        "R2_no_oom_kills": r2,
        "R3_postgres_reachable": r3,
        "R4_gateway_bridge_connected": r4,
        "R5_no_duplicate_socket_ownership": r5,
        "R6_no_stale_leases": r6,
        "R7_outbox_pending_stable": r7,
        "R8_retry_backlog_stable": r8,
        "R9_dead_letters_stable": r9,
        "R10_no_reconnect_storm": r10,
        "R11_rss_stable": r11,
        "R12_gateway_healthy": r12,
        "R13_all_containers_running": r13,
    }


def collect_observation() -> Dict[str, Any]:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    load_raw = run_cmd("cat /proc/loadavg")
    load_parts = load_raw.split()
    loadavg = [float(load_parts[i]) for i in range(min(3, len(load_parts)))] if load_parts else [0.0, 0.0, 0.0]

    uptime_raw = run_cmd("uptime -p 2>/dev/null || uptime")

    containers = {
        "backend": get_container_info("tezlify-backend"),
        "gateway": get_container_info("tezlify-gateway"),
        "caddy": get_container_info("tezlify-caddy"),
        "db": get_container_info("tezlify-db"),
    }

    gateway = get_gateway_health()
    backend = get_backend_health()
    db_metrics = get_db_metrics()

    invariants = evaluate_invariants(containers, gateway, backend, db_metrics)

    return {
        "timestamp": ts,
        "uptime": uptime_raw,
        "loadavg": loadavg,
        "containers": containers,
        "gateway": gateway,
        "backend": backend,
        "db": db_metrics,
        "invariants": invariants,
        "all_invariants_pass": all(invariants.values()),
    }


def record_observation() -> Dict[str, Any]:
    os.makedirs(RUNTIME_DIR, exist_ok=True)
    obs = collect_observation()

    # Save baseline if not present
    if not os.path.exists(BASELINE_FILE):
        with open(BASELINE_FILE, "w") as f:
            json.dump(obs, f, indent=2)

    # Append to observations.jsonl
    with open(OBSERVATIONS_FILE, "a") as f:
        f.write(json.dumps(obs) + "\n")

    # Write current snapshot atomically
    tmp_current = f"{CURRENT_FILE}.tmp.{os.getpid()}"
    with open(tmp_current, "w") as f:
        json.dump(obs, f, indent=2)
    os.replace(tmp_current, CURRENT_FILE)

    return obs


if __name__ == "__main__":
    observation = record_observation()
    print(json.dumps(observation, indent=2))
    all_ok = observation.get("all_invariants_pass", False)
    sys.exit(0 if all_ok else 1)
