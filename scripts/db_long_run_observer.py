#!/usr/bin/env python3
"""
Tezlify Phase 10.8 — Long-Run Database & WhatsApp Reliability Observer.

Non-invasive, strictly read-only observation tool for:
1. Outbox queue size, state distribution, and 24h retention window tracking.
2. Ingress vs. cleanup deletion throughput and net accumulation.
3. Processed events table size, count, and 7-day retention verification.
4. Database bloat, dead tuples, and HOT update ratios.
5. Auth session write pressure and last_seen throttling.
6. WhatsApp session state integrity (verifying zero unexpected mutations).

Usage:
  python3 scripts/db_long_run_observer.py --snapshot
  python3 scripts/db_long_run_observer.py --baseline
  python3 scripts/db_long_run_observer.py --compare
  python3 scripts/db_long_run_observer.py --json
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
from typing import Any, Dict, Optional

RUNTIME_DIR = os.environ.get("TEZLIFY_DB_OBSERVER_DIR", "/opt/tezlify/runtime/db-reliability")
BASELINE_FILE = os.path.join(RUNTIME_DIR, "baseline.json")
LATEST_FILE = os.path.join(RUNTIME_DIR, "latest.json")
OBSERVATIONS_LOG = os.path.join(RUNTIME_DIR, "observations.jsonl")


def run_psql(sql: str, db_container: str = "tezlify-db") -> str:
    """Runs a read-only SQL query against the Postgres container."""
    cmd = [
        "docker", "exec", db_container,
        "psql", "-U", "tezlify", "-d", "tezlify", "-t", "-A", "-F", "|",
        "-c", f"SET TRANSACTION READ ONLY; {sql}"
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
        if res.returncode != 0:
            return ""
        lines = [l for l in res.stdout.strip().splitlines() if l.strip() != "SET"]
        return "\n".join(lines).strip()
    except Exception:
        return ""


def run_cmd(cmd: str) -> str:
    try:
        res = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        return res.stdout.strip()
    except Exception:
        return ""


def get_outbox_stats() -> Dict[str, Any]:
    sql = """
    SELECT
        count(*),
        count(*) FILTER (WHERE state='PENDING'),
        count(*) FILTER (WHERE state='IN_FLIGHT'),
        count(*) FILTER (WHERE state='DELIVERED'),
        count(*) FILTER (WHERE state='DEAD_LETTER'),
        coalesce(min(created_at)::text, ''),
        coalesce(min(delivered_at)::text, ''),
        coalesce(max(created_at)::text, ''),
        coalesce(max(delivered_at)::text, '')
    FROM whatsapp_private.event_outbox;
    """
    raw = run_psql(sql)
    if not raw:
        return {}
    parts = raw.split("|")
    if len(parts) < 9:
        return {}
    return {
        "total": int(parts[0] or 0),
        "pending": int(parts[1] or 0),
        "in_flight": int(parts[2] or 0),
        "delivered": int(parts[3] or 0),
        "dead_letter": int(parts[4] or 0),
        "oldest_created": parts[5],
        "oldest_delivered": parts[6],
        "newest_created": parts[7],
        "newest_delivered": parts[8],
    }


def get_outbox_retention_buckets() -> Dict[str, int]:
    sql = """
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
    GROUP BY 1;
    """
    raw = run_psql(sql)
    buckets = {"<24h": 0, "24-48h": 0, "48-72h": 0, ">72h": 0}
    if not raw:
        return buckets
    for line in raw.splitlines():
        parts = line.split("|")
        if len(parts) == 2 and parts[0] in buckets:
            buckets[parts[0]] = int(parts[1] or 0)
    return buckets


def get_processed_events_stats() -> Dict[str, Any]:
    sql = """
    SELECT
        count(*),
        coalesce(min(processed_at)::text, ''),
        coalesce(max(processed_at)::text, ''),
        count(*) FILTER (WHERE processed_at >= NOW() - INTERVAL '24 hours'),
        count(*) FILTER (WHERE processed_at >= NOW() - INTERVAL '48 hours' AND processed_at < NOW() - INTERVAL '24 hours'),
        count(*) FILTER (WHERE processed_at >= NOW() - INTERVAL '7 days' AND processed_at < NOW() - INTERVAL '48 hours'),
        count(*) FILTER (WHERE processed_at < NOW() - INTERVAL '7 days')
    FROM whatsapp_private.processed_events;
    """
    raw = run_psql(sql)
    if not raw:
        return {}
    parts = raw.split("|")
    if len(parts) < 7:
        return {}
    return {
        "total": int(parts[0] or 0),
        "oldest_processed": parts[1],
        "newest_processed": parts[2],
        "bucket_lt_24h": int(parts[3] or 0),
        "bucket_24_48h": int(parts[4] or 0),
        "bucket_3_7d": int(parts[5] or 0),
        "bucket_gt_7d": int(parts[6] or 0),
    }


def get_table_metrics() -> Dict[str, Dict[str, Any]]:
    sql = """
    SELECT
        schemaname,
        relname,
        pg_relation_size(relid),
        pg_indexes_size(relid),
        pg_total_relation_size(relid),
        n_live_tup,
        n_dead_tup,
        n_tup_ins,
        n_tup_upd,
        n_tup_del,
        n_tup_hot_upd,
        seq_scan,
        idx_scan
    FROM pg_stat_user_tables;
    """
    raw = run_psql(sql)
    tables = {}
    if not raw:
        return tables
    for line in raw.splitlines():
        parts = line.split("|")
        if len(parts) >= 13:
            schema = parts[0]
            name = parts[1]
            key = f"{schema}.{name}" if schema != "public" else name
            upd = int(parts[8] or 0)
            hot = int(parts[10] or 0)
            hot_pct = round((hot / upd * 100), 2) if upd > 0 else 0.0
            live = int(parts[5] or 0)
            dead = int(parts[6] or 0)
            dead_pct = round((dead / (live + dead) * 100), 2) if (live + dead) > 0 else 0.0
            tables[key] = {
                "table_bytes": int(parts[2] or 0),
                "index_bytes": int(parts[3] or 0),
                "total_bytes": int(parts[4] or 0),
                "n_live_tup": live,
                "n_dead_tup": dead,
                "dead_tup_pct": dead_pct,
                "n_tup_ins": int(parts[7] or 0),
                "n_tup_upd": upd,
                "n_tup_del": int(parts[9] or 0),
                "n_tup_hot_upd": hot,
                "hot_ratio_pct": hot_pct,
                "seq_scan": int(parts[11] or 0),
                "idx_scan": int(parts[12] or 0),
            }
    return tables


def get_whatsapp_sessions() -> list:
    sql = "SELECT id, session_name, status, is_phone_online FROM public.whatsapp_sessions ORDER BY id;"
    raw = run_psql(sql)
    sessions = []
    if not raw:
        return sessions
    for line in raw.splitlines():
        parts = line.split("|")
        if len(parts) >= 4:
            sessions.append({
                "id": int(parts[0]),
                "session_name": parts[1],
                "status": parts[2],
                "is_phone_online": parts[3].lower() in ("t", "true", "1"),
            })
    return sessions


def get_system_health() -> Dict[str, Any]:
    observer_active = run_cmd("systemctl is-active tezlify-wa-observer.timer") == "active"
    monitor_active = run_cmd("systemctl is-active tezlify-monitor.timer") == "active"
    health_raw = run_cmd("curl -ks https://api.130.162.247.20.sslip.io/health")
    health_json = {}
    try:
        health_json = json.loads(health_raw)
    except Exception:
        pass
    return {
        "observer_timer": observer_active,
        "monitor_timer": monitor_active,
        "api_healthy": health_json.get("status") == "healthy",
        "gateway_bridge_connected": health_json.get("gateway_bridge", {}).get("connected", False),
        "reconnect_count": health_json.get("gateway_bridge", {}).get("reconnect_count", 0),
    }


def take_snapshot() -> Dict[str, Any]:
    now = datetime.datetime.now(datetime.timezone.utc)
    return {
        "timestamp": now.isoformat(),
        "epoch": int(now.timestamp()),
        "outbox": get_outbox_stats(),
        "outbox_buckets": get_outbox_retention_buckets(),
        "processed_events": get_processed_events_stats(),
        "tables": get_table_metrics(),
        "whatsapp_sessions": get_whatsapp_sessions(),
        "system": get_system_health(),
    }


def format_bytes(num_bytes: int) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:3.1f} {unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} TB"


def print_summary(snap: Dict[str, Any]):
    print(f"\n========================================================")
    print(f"Tezlify DB Reliability Snapshot — {snap['timestamp']}")
    print(f"========================================================")

    ob = snap.get("outbox", {})
    buckets = snap.get("outbox_buckets", {})
    print(f"\n[1] EVENT OUTBOX QUEUE:")
    print(f"  Total Rows:     {ob.get('total', 0):,}")
    print(f"  Delivered:      {ob.get('delivered', 0):,} (<24h: {buckets.get('<24h', 0):,}, >24h: {buckets.get('24-48h', 0) + buckets.get('48-72h', 0) + buckets.get('>72h', 0):,})")
    print(f"  Pending:        {ob.get('pending', 0):,}")
    print(f"  Dead Letter:    {ob.get('dead_letter', 0):,}")
    print(f"  Oldest Delivered: {ob.get('oldest_delivered', 'N/A')}")
    print(f"  Newest Delivered: {ob.get('newest_delivered', 'N/A')}")

    pe = snap.get("processed_events", {})
    print(f"\n[2] PROCESSED EVENTS TABLE:")
    print(f"  Total Rows:     {pe.get('total', 0):,}")
    print(f"  <24h:           {pe.get('bucket_lt_24h', 0):,}")
    print(f"  24h-48h:        {pe.get('bucket_24_48h', 0):,}")
    print(f"  3d-7d:          {pe.get('bucket_3_7d', 0):,}")
    print(f"  >7d:            {pe.get('bucket_gt_7d', 0):,} (Policy: 7 days)")

    tables = snap.get("tables", {})
    print(f"\n[3] CRITICAL TABLE SIZES & BLOAT:")
    print(f"  {'Table Name':<30} {'Table Size':<12} {'Index Size':<12} {'Total Size':<12} {'Dead %':<8} {'HOT %':<8}")
    print(f"  {'-'*30} {'-'*12} {'-'*12} {'-'*12} {'-'*8} {'-'*8}")
    target_tables = [
        "whatsapp_private.event_outbox",
        "whatsapp_private.processed_events",
        "whatsapp_private.signal_keys",
        "messages",
        "contacts",
        "conversations",
        "whatsapp_sessions",
        "auth_staging_sessions",
    ]
    for tbl in target_tables:
        if tbl in tables:
            m = tables[tbl]
            print(f"  {tbl:<30} {format_bytes(m['table_bytes']):<12} {format_bytes(m['index_bytes']):<12} {format_bytes(m['total_bytes']):<12} {m['dead_tup_pct']:<7.1f}% {m['hot_ratio_pct']:<7.1f}%")

    sessions = snap.get("whatsapp_sessions", [])
    print(f"\n[4] WHATSAPP SESSION INTEGRITY:")
    for s in sessions:
        print(f"  ID {s['id']}: name={s['session_name']} | status={s['status']} | online={s['is_phone_online']}")

    sys_info = snap.get("system", {})
    print(f"\n[5] SYSTEM HEALTH & TIMERS:")
    print(f"  API Health:             {'HEALTHY' if sys_info.get('api_healthy') else 'DOWN'}")
    print(f"  Gateway Bridge:         {'CONNECTED' if sys_info.get('gateway_bridge_connected') else 'DISCONNECTED'}")
    print(f"  Observer Timer:         {'ACTIVE' if sys_info.get('observer_timer') else 'INACTIVE'}")
    print(f"  Monitor Timer:          {'ACTIVE' if sys_info.get('monitor_timer') else 'INACTIVE'}")
    print(f"========================================================\n")


def compare_snapshots(b: Dict[str, Any], c: Dict[str, Any]):
    print(f"\n========================================================")
    print(f"Tezlify DB Reliability Comparison")
    print(f"Baseline: {b.get('timestamp')} -> Current: {c.get('timestamp')}")
    print(f"========================================================")

    dt_sec = max(1, c.get("epoch", 0) - b.get("epoch", 0))
    dt_hours = dt_sec / 3600.0

    b_ob = b.get("outbox", {})
    c_ob = c.get("outbox", {})

    delta_total = c_ob.get("total", 0) - b_ob.get("total", 0)
    delta_deliv = c_ob.get("delivered", 0) - b_ob.get("delivered", 0)

    print(f"Time Elapsed: {dt_hours:.2f} hours")
    print(f"\nOutbox Row Delta:")
    print(f"  Total:     {b_ob.get('total', 0):,} -> {c_ob.get('total', 0):,} (Delta: {delta_total:+,})")
    print(f"  Delivered: {b_ob.get('delivered', 0):,} -> {c_ob.get('delivered', 0):,} (Delta: {delta_deliv:+,})")
    print(f"  Pending:   {b_ob.get('pending', 0):,} -> {c_ob.get('pending', 0):,}")
    print(f"  Dead Letter: {b_ob.get('dead_letter', 0):,} -> {c_ob.get('dead_letter', 0):,}")

    rate_per_hour = delta_total / dt_hours
    print(f"  Net Row Change Rate: {rate_per_hour:+.1f} rows/hour")

    status = "STABLE"
    if delta_total < -100:
        status = "STABILIZING"
    elif delta_total > 500:
        status = "GROWING"
    elif abs(delta_total) <= 100:
        status = "STABLE"

    print(f"\nOverall Outbox Dynamics: {status}")
    print(f"========================================================\n")


def main():
    parser = argparse.ArgumentParser(description="Tezlify Phase 10.8 DB Reliability Observer")
    parser.add_argument("--snapshot", action="store_true", help="Capture snapshot and print summary")
    parser.add_argument("--baseline", action="store_true", help="Save current snapshot as baseline")
    parser.add_argument("--compare", action="store_true", help="Compare current state with saved baseline")
    parser.add_argument("--json", action="store_true", help="Output raw JSON snapshot")
    args = parser.parse_args()

    snap = take_snapshot()

    if args.json:
        print(json.dumps(snap, indent=2))
        return

    if args.baseline:
        os.makedirs(RUNTIME_DIR, exist_ok=True)
        with open(BASELINE_FILE, "w") as f:
            json.dump(snap, f, indent=2)
        print(f"Saved baseline snapshot to {BASELINE_FILE}")
        print_summary(snap)
        return

    if args.compare:
        if not os.path.exists(BASELINE_FILE):
            print(f"No baseline found at {BASELINE_FILE}. Run with --baseline first.")
            sys.exit(1)
        with open(BASELINE_FILE, "r") as f:
            baseline = json.load(f)
        compare_snapshots(baseline, snap)
        return

    print_summary(snap)


if __name__ == "__main__":
    main()
