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
7. Runtime container health and query execution plan verification.

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
from typing import Any, Dict, List, Optional

RUNTIME_DIR = os.environ.get("TEZLIFY_DB_OBSERVER_DIR", "/opt/tezlify/runtime/database-reliability")
BASELINE_FILE = os.path.join(RUNTIME_DIR, "baseline.json")
LATEST_FILE = os.path.join(RUNTIME_DIR, "latest.json")
OBSERVATIONS_LOG = os.path.join(RUNTIME_DIR, "observations.jsonl")

CRITICAL_TABLES = [
    "whatsapp_private.event_outbox",
    "whatsapp_private.processed_events",
    "public.contacts",
    "public.conversations",
    "public.messages",
    "public.whatsapp_sessions",
    "whatsapp_private.socket_leases",
    "public.auth_staging_sessions",
]


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
        coalesce(max(delivered_at)::text, ''),
        pg_relation_size('whatsapp_private.event_outbox'::regclass),
        pg_indexes_size('whatsapp_private.event_outbox'::regclass),
        pg_total_relation_size('whatsapp_private.event_outbox'::regclass)
    FROM whatsapp_private.event_outbox;
    """
    raw = run_psql(sql)
    if not raw:
        return {}
    parts = raw.split("|")
    if len(parts) < 12:
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
        "table_size": int(parts[9] or 0),
        "index_size": int(parts[10] or 0),
        "total_size": int(parts[11] or 0),
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


def get_outbox_attempts_breakdown() -> Dict[str, Dict[str, int]]:
    sql = """
    SELECT state, attempts, count(*)
    FROM whatsapp_private.event_outbox
    GROUP BY state, attempts
    ORDER BY state, attempts;
    """
    raw = run_psql(sql)
    breakdown: Dict[str, Dict[str, int]] = {}
    if not raw:
        return breakdown
    for line in raw.splitlines():
        parts = line.split("|")
        if len(parts) == 3:
            st = parts[0]
            att = str(parts[1] or 0)
            cnt = int(parts[2] or 0)
            if st not in breakdown:
                breakdown[st] = {}
            breakdown[st][att] = cnt
    return breakdown


def get_processed_events_stats() -> Dict[str, Any]:
    sql = """
    SELECT
        count(*),
        coalesce(min(processed_at)::text, ''),
        coalesce(max(processed_at)::text, ''),
        count(*) FILTER (WHERE processed_at >= NOW() - INTERVAL '24 hours'),
        count(*) FILTER (WHERE processed_at >= NOW() - INTERVAL '48 hours' AND processed_at < NOW() - INTERVAL '24 hours'),
        count(*) FILTER (WHERE processed_at >= NOW() - INTERVAL '72 hours' AND processed_at < NOW() - INTERVAL '48 hours'),
        count(*) FILTER (WHERE processed_at >= NOW() - INTERVAL '7 days' AND processed_at < NOW() - INTERVAL '72 hours'),
        count(*) FILTER (WHERE processed_at < NOW() - INTERVAL '7 days'),
        pg_relation_size('whatsapp_private.processed_events'::regclass),
        pg_indexes_size('whatsapp_private.processed_events'::regclass),
        pg_total_relation_size('whatsapp_private.processed_events'::regclass)
    FROM whatsapp_private.processed_events;
    """
    raw = run_psql(sql)
    if not raw:
        return {}
    parts = raw.split("|")
    if len(parts) < 11:
        return {}
    return {
        "total": int(parts[0] or 0),
        "oldest_processed": parts[1],
        "newest_processed": parts[2],
        "<24h": int(parts[3] or 0),
        "24-48h": int(parts[4] or 0),
        "48-72h": int(parts[5] or 0),
        "3-7d": int(parts[6] or 0),
        ">7d": int(parts[7] or 0),
        "table_size": int(parts[8] or 0),
        "index_size": int(parts[9] or 0),
        "total_size": int(parts[10] or 0),
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
        seq_tup_read,
        idx_scan,
        idx_tup_fetch
    FROM pg_stat_user_tables;
    """
    raw = run_psql(sql)
    tables: Dict[str, Dict[str, Any]] = {}
    if not raw:
        return tables
    for line in raw.splitlines():
        parts = line.split("|")
        if len(parts) >= 15:
            schema = parts[0]
            name = parts[1]
            key = f"{schema}.{name}"
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
                "seq_tup_read": int(parts[12] or 0),
                "idx_scan": int(parts[13] or 0),
                "idx_tup_fetch": int(parts[14] or 0),
            }
    return tables


def get_whatsapp_sessions() -> List[Dict[str, Any]]:
    sql = "SELECT id, session_name, status, is_phone_online FROM public.whatsapp_sessions ORDER BY id;"
    raw = run_psql(sql)
    sessions: List[Dict[str, Any]] = []
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


def get_socket_lease_count() -> int:
    sql = "SELECT count(*) FROM whatsapp_private.socket_leases;"
    raw = run_psql(sql)
    try:
        return int(raw.strip())
    except Exception:
        return 0


def get_container_health(name: str) -> bool:
    res = run_cmd(f"docker inspect --format '{{{{.State.Health.Status}}}}' {name} 2>/dev/null")
    if not res:
        status = run_cmd(f"docker inspect --format '{{{{.State.Status}}}}' {name} 2>/dev/null")
        return status == "running"
    return res.strip() in ("healthy", "running")


def get_system_health() -> Dict[str, Any]:
    observer_active = run_cmd("systemctl is-active tezlify-wa-observer.timer") == "active"
    monitor_active = run_cmd("systemctl is-active tezlify-monitor.timer") == "active"
    health_raw = run_cmd("curl -ks https://api.130.162.247.20.sslip.io/health")
    health_json: Dict[str, Any] = {}
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
        "backend_healthy": get_container_health("tezlify-backend"),
        "gateway_healthy": get_container_health("tezlify-gateway"),
        "db_healthy": get_container_health("tezlify-db"),
        "caddy_healthy": get_container_health("tezlify-caddy"),
    }


def get_cleanup_explain_plan() -> str:
    sql = """
    EXPLAIN (BUFFERS)
    SELECT sequence
    FROM whatsapp_private.event_outbox
    WHERE
        (state='DELIVERED' AND delivered_at < NOW() - INTERVAL '24 hours')
     OR (state='DEAD_LETTER' AND created_at < NOW() - INTERVAL '7 days')
    ORDER BY sequence ASC
    LIMIT 1000;
    """
    return run_psql(sql)


def take_snapshot(record_log: bool = True) -> Dict[str, Any]:
    now = datetime.datetime.now(datetime.timezone.utc)
    all_tables = get_table_metrics()

    # Filter critical tables
    critical_tables = {}
    for tname in CRITICAL_TABLES:
        if tname in all_tables:
            critical_tables[tname] = all_tables[tname]

    # Auth staging sessions stats
    auth_table = all_tables.get("public.auth_staging_sessions", {})
    auth_sessions = {
        "rows": auth_table.get("n_live_tup", 0),
        "inserts": auth_table.get("n_tup_ins", 0),
        "updates": auth_table.get("n_tup_upd", 0),
        "deletes": auth_table.get("n_tup_del", 0),
        "hot_ratio": auth_table.get("hot_ratio_pct", 0.0),
    }

    sessions = get_whatsapp_sessions()
    socket_leases = get_socket_lease_count()
    sys_health = get_system_health()

    snap = {
        "timestamp": now.isoformat(),
        "epoch": int(now.timestamp()),
        "event_outbox": get_outbox_stats(),
        "outbox_buckets": get_outbox_retention_buckets(),
        "outbox_attempts": get_outbox_attempts_breakdown(),
        "processed_events": get_processed_events_stats(),
        "critical_tables": critical_tables,
        "auth_sessions": auth_sessions,
        "whatsapp": {
            "session_count": len(sessions),
            "session_states": {s["id"]: s["status"] for s in sessions},
            "socket_lease_count": socket_leases,
            "sessions": sessions,
        },
        "runtime": {
            "backend_healthy": sys_health.get("backend_healthy", False),
            "gateway_healthy": sys_health.get("gateway_healthy", False),
            "db_healthy": sys_health.get("db_healthy", False),
            "caddy_healthy": sys_health.get("caddy_healthy", False),
            "observer_timer": sys_health.get("observer_timer", False),
            "monitor_timer": sys_health.get("monitor_timer", False),
            "gateway_bridge_connected": sys_health.get("gateway_bridge_connected", False),
            "reconnect_count": sys_health.get("reconnect_count", 0),
        },
    }

    if record_log:
        try:
            os.makedirs(RUNTIME_DIR, exist_ok=True)
            with open(OBSERVATIONS_LOG, "a") as f:
                f.write(json.dumps(snap) + "\n")
            with open(LATEST_FILE, "w") as f:
                json.dump(snap, f, indent=2)
        except Exception:
            pass

    return snap


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

    ob = snap.get("event_outbox", {})
    buckets = snap.get("outbox_buckets", {})
    print(f"\n[1] EVENT OUTBOX QUEUE:")
    print(f"  Total Rows:       {ob.get('total', 0):,}")
    print(f"  Delivered:        {ob.get('delivered', 0):,} (<24h: {buckets.get('<24h', 0):,}, >24h: {buckets.get('24-48h', 0) + buckets.get('48-72h', 0) + buckets.get('>72h', 0):,})")
    print(f"  Pending:          {ob.get('pending', 0):,}")
    print(f"  In-Flight:        {ob.get('in_flight', 0):,}")
    print(f"  Dead Letter:      {ob.get('dead_letter', 0):,}")
    print(f"  Oldest Delivered: {ob.get('oldest_delivered', 'N/A')}")
    print(f"  Newest Delivered: {ob.get('newest_delivered', 'N/A')}")
    print(f"  Table Size:       {format_bytes(ob.get('table_size', 0))}")
    print(f"  Index Size:       {format_bytes(ob.get('index_size', 0))}")
    print(f"  Total Size:       {format_bytes(ob.get('total_size', 0))}")

    pe = snap.get("processed_events", {})
    print(f"\n[2] PROCESSED EVENTS TABLE:")
    print(f"  Total Rows:       {pe.get('total', 0):,}")
    print(f"  <24h:             {pe.get('<24h', 0):,}")
    print(f"  24h-48h:          {pe.get('24-48h', 0):,}")
    print(f"  48h-72h:          {pe.get('48-72h', 0):,}")
    print(f"  3d-7d:            {pe.get('3-7d', 0):,}")
    print(f"  >7d:              {pe.get('>7d', 0):,} (Policy: 7 days, Invariant: 0)")

    ct = snap.get("critical_tables", {})
    print(f"\n[3] CRITICAL TABLE SIZES & BLOAT:")
    print(f"  {'Table Name':<35} {'Table Size':<12} {'Index Size':<12} {'Total Size':<12} {'Dead %':<8} {'HOT %':<8}")
    print(f"  {'-'*35} {'-'*12} {'-'*12} {'-'*12} {'-'*8} {'-'*8}")
    for tbl, m in ct.items():
        print(f"  {tbl:<35} {format_bytes(m['table_bytes']):<12} {format_bytes(m['index_bytes']):<12} {format_bytes(m['total_bytes']):<12} {m['dead_tup_pct']:<7.1f}% {m['hot_ratio_pct']:<7.1f}%")

    auth = snap.get("auth_sessions", {})
    print(f"\n[4] AUTH STAGING SESSIONS:")
    print(f"  Active Rows: {auth.get('rows', 0)} | Inserts: {auth.get('inserts', 0)} | Updates: {auth.get('updates', 0)} | Deletes: {auth.get('deletes', 0)} | HOT Ratio: {auth.get('hot_ratio', 0.0)}%")

    wa = snap.get("whatsapp", {})
    print(f"\n[5] WHATSAPP SUBSYSTEM:")
    print(f"  Session Count:      {wa.get('session_count', 0)}")
    print(f"  Socket Lease Count: {wa.get('socket_lease_count', 0)}")
    for s in wa.get("sessions", []):
        print(f"    Session {s['id']}: name={s['session_name']} | status={s['status']} | online={s['is_phone_online']}")

    rt = snap.get("runtime", {})
    print(f"\n[6] RUNTIME HEALTH:")
    print(f"  Backend: {rt.get('backend_healthy')} | Gateway: {rt.get('gateway_healthy')} | DB: {rt.get('db_healthy')} | Caddy: {rt.get('caddy_healthy')}")
    print(f"  Bridge Connected: {rt.get('gateway_bridge_connected')} | Reconnects: {rt.get('reconnect_count')}")
    print(f"  Observer Timer: {rt.get('observer_timer')} | Monitor Timer: {rt.get('monitor_timer')}")
    print(f"========================================================\n")


def compare_snapshots(b: Dict[str, Any], c: Dict[str, Any]):
    print(f"\n========================================================")
    print(f"Tezlify DB Reliability Snapshot Delta Calculation")
    print(f"Baseline: {b.get('timestamp')} -> Current: {c.get('timestamp')}")
    print(f"========================================================")

    dt_sec = max(1, c.get("epoch", 0) - b.get("epoch", 0))
    dt_hours = dt_sec / 3600.0
    print(f"Elapsed Window: {dt_hours:.2f} hours ({dt_sec} seconds)")

    # Outbox deltas
    b_ob = b.get("event_outbox", b.get("outbox", {}))
    c_ob = c.get("event_outbox", c.get("outbox", {}))
    delta_total = c_ob.get("total", 0) - b_ob.get("total", 0)
    delta_deliv = c_ob.get("delivered", 0) - b_ob.get("delivered", 0)

    # Postgres counter deltas from critical_tables
    b_tables = b.get("critical_tables", b.get("tables", {}))
    c_tables = c.get("critical_tables", c.get("tables", {}))

    b_outbox_tab = b_tables.get("whatsapp_private.event_outbox", {})
    c_outbox_tab = c_tables.get("whatsapp_private.event_outbox", {})

    ins_delta = c_outbox_tab.get("n_tup_ins", 0) - b_outbox_tab.get("n_tup_ins", 0)
    upd_delta = c_outbox_tab.get("n_tup_upd", 0) - b_outbox_tab.get("n_tup_upd", 0)
    del_delta = c_outbox_tab.get("n_tup_del", 0) - b_outbox_tab.get("n_tup_del", 0)
    hot_delta = c_outbox_tab.get("n_tup_hot_upd", 0) - b_outbox_tab.get("n_tup_hot_upd", 0)
    dead_delta = c_outbox_tab.get("n_dead_tup", 0) - b_outbox_tab.get("n_dead_tup", 0)
    size_delta = c_outbox_tab.get("total_bytes", 0) - b_outbox_tab.get("total_bytes", 0)
    net_growth = ins_delta - del_delta

    ingress_rate = ins_delta / dt_hours if dt_hours > 0 else 0
    cleanup_rate = del_delta / dt_hours if dt_hours > 0 else 0
    net_rate = ingress_rate - cleanup_rate

    print(f"\n[A] EVENT OUTBOX DELTAS & METRICS:")
    print(f"  Rows:                 {b_ob.get('total', 0):,} -> {c_ob.get('total', 0):,} (Net Row Change: {delta_total:+,})")
    print(f"  Inserts Delta:        {ins_delta:+,} (Ingress: {ingress_rate:.1f} events/hour)")
    print(f"  Deletes Delta:        {del_delta:+,} (Cleanup: {cleanup_rate:.1f} events/hour)")
    print(f"  Net Growth (ins-del): {net_growth:+,} ({net_rate:+.1f} rows/hour)")
    print(f"  Updates Delta:        {upd_delta:+,}")
    print(f"  Dead Tuple Delta:     {dead_delta:+,} (Current dead: {c_outbox_tab.get('n_dead_tup', 0):,}, {c_outbox_tab.get('dead_tup_pct', 0)}%)")
    print(f"  Total Size Delta:     {format_bytes(size_delta)}")

    # Auth session delta
    b_auth = b_tables.get("public.auth_staging_sessions", {})
    c_auth = c_tables.get("public.auth_staging_sessions", {})
    auth_upd = c_auth.get("n_tup_upd", 0) - b_auth.get("n_tup_upd", 0)
    auth_hot = c_auth.get("n_tup_hot_upd", 0) - b_auth.get("n_tup_hot_upd", 0)
    auth_upd_per_h = auth_upd / dt_hours if dt_hours > 0 else 0
    auth_hot_per_h = auth_hot / dt_hours if dt_hours > 0 else 0
    auth_hot_ratio = round((auth_hot / auth_upd * 100), 2) if auth_upd > 0 else 100.0

    print(f"\n[B] AUTH WRITE PRESSURE DELTA:")
    print(f"  Updates / hour:     {auth_upd_per_h:.1f}")
    print(f"  HOT Updates / hour: {auth_hot_per_h:.1f}")
    print(f"  HOT Update Ratio:   {auth_hot_ratio:.1f}%")

    # Query Activity Deltas
    print(f"\n[C] QUERY ACTIVITY DELTAS (pg_stat_user_tables):")
    print(f"  {'Table Name':<35} {'SeqScanΔ':<10} {'IdxScanΔ':<10} {'TupReturnedΔ':<15} {'TupFetchedΔ':<15}")
    print(f"  {'-'*35} {'-'*10} {'-'*10} {'-'*15} {'-'*15}")
    for tbl in CRITICAL_TABLES:
        b_t = b_tables.get(tbl, {})
        c_t = c_tables.get(tbl, {})
        seq_d = c_t.get("seq_scan", 0) - b_t.get("seq_scan", 0)
        idx_d = c_t.get("idx_scan", 0) - b_t.get("idx_scan", 0)
        ret_d = c_t.get("seq_tup_read", 0) - b_t.get("seq_tup_read", 0)
        fet_d = c_t.get("idx_tup_fetch", 0) - b_t.get("idx_tup_fetch", 0)
        print(f"  {tbl:<35} {seq_d:<10} {idx_d:<10} {ret_d:<15} {fet_d:<15}")

    print(f"========================================================\n")


def main():
    parser = argparse.ArgumentParser(description="Tezlify Phase 10.8 DB Reliability Observer")
    parser.add_argument("--snapshot", action="store_true", help="Capture snapshot and print summary")
    parser.add_argument("--baseline", action="store_true", help="Save current snapshot as baseline")
    parser.add_argument("--compare", action="store_true", help="Compare current state with saved baseline")
    parser.add_argument("--json", action="store_true", help="Output raw JSON snapshot")
    parser.add_argument("--explain", action="store_true", help="Show cleanup EXPLAIN (BUFFERS) plan")
    args = parser.parse_args()

    if args.explain:
        print(get_cleanup_explain_plan())
        return

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
