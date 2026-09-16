#!/usr/bin/env python3
"""Phase 8.5 Production Observation Monitor.

Collects non-intrusive health, bridge, outbox, database, and auth metrics
from the Oracle production deployment without exposing credentials.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone


def run_ssh(cmd: str) -> str:
    full_cmd = [
        "ssh",
        "-i", "/Users/isatezcan/.ssh/id_tezlify_oracle",
        "-o", "StrictHostKeyChecking=no",
        "ubuntu@130.162.247.20",
        cmd,
    ]
    res = subprocess.run(full_cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"SSH command failed: {res.stderr.strip() or res.stdout.strip()}")
    return res.stdout.strip()


def main():
    print("=" * 60)
    print("PHASE 8.5 PRODUCTION OBSERVATION SNAPSHOT")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()} UTC")
    print("=" * 60)

    # 1. Backend Health
    backend_health_raw = run_ssh("docker exec tezlify-backend curl -s http://127.0.0.1:8000/health")
    try:
        bh = json.loads(backend_health_raw)
        print("\n[BACKEND & BRIDGE]")
        print(f"  Service: {bh.get('service')} (v{bh.get('version')})")
        print(f"  Status: {bh.get('status')}")
        print(f"  Memory: {bh.get('memory_mb')} MB")
        gb = bh.get("gateway_bridge", {})
        print(f"  Bridge Connected: {gb.get('connected')}")
        print(f"  Last Connected At: {gb.get('last_connected_at')}")
        print(f"  Last Event At: {gb.get('last_event_at')}")
        print(f"  Reconnect Count: {gb.get('reconnect_count')}")
    except Exception as e:
        print(f"  Failed parsing backend health: {e} | raw: {backend_health_raw[:100]}")

    # 2. Gateway Health
    gw_health_raw = run_ssh("docker exec tezlify-backend curl -s http://gateway:8787/health")
    try:
        gh = json.loads(gw_health_raw)
        print("\n[GATEWAY]")
        print(f"  Service: {gh.get('service')}")
        print(f"  Status: {gh.get('status')}")
        sessions = gh.get("sessions", {})
        print(f"  Sessions Total: {sessions.get('total')}, Connected: {sessions.get('connected')}, Pending QR: {sessions.get('pending_qr')}")
    except Exception as e:
        print(f"  Failed parsing gateway health: {e} | raw: {gw_health_raw[:100]}")

    # 3. WhatsApp Session in DB & Socket Lease
    wa_sql = (
        "SELECT id, phone_number, status, is_phone_online, updated_at "
        "FROM public.whatsapp_sessions ORDER BY id DESC LIMIT 3;"
    )
    lease_sql = (
        "SELECT session_id, generation, expires_at, updated_at "
        "FROM whatsapp_private.socket_leases;"
    )
    print("\n[WHATSAPP SESSIONS IN DB]")
    print(run_ssh(f'docker exec tezlify-db psql -U tezlify -d tezlify -c "{wa_sql}"'))
    print("\n[SOCKET LEASES]")
    print(run_ssh(f'docker exec tezlify-db psql -U tezlify -d tezlify -c "{lease_sql}"'))

    # 4. Outbox & Processed Events
    outbox_sql = "SELECT state, count(*) FROM whatsapp_private.event_outbox GROUP BY state ORDER BY count DESC;"
    proc_sql = "SELECT count(*) as processed_events FROM whatsapp_private.processed_events;"
    print("\n[EVENT OUTBOX COUNTS]")
    print(run_ssh(f'docker exec tezlify-db psql -U tezlify -d tezlify -c "{outbox_sql}"'))
    print("\n[PROCESSED EVENTS]")
    print(run_ssh(f'docker exec tezlify-db psql -U tezlify -d tezlify -c "{proc_sql}"'))

    # 5. Database Counts
    db_counts_sql = """
    SELECT
      (SELECT count(*) FROM public.messages) as messages,
      (SELECT count(*) FROM public.conversations) as conversations,
      (SELECT count(*) FROM public.contacts) as contacts,
      (SELECT count(*) FROM public.profiles) as profiles,
      (SELECT count(*) FROM public.auth_staging_users) as auth_users,
      (SELECT count(*) FROM public.auth_staging_sessions WHERE revoked_at IS NULL AND expires_at > NOW()) as active_sessions;
    """
    print("\n[CORE BUSINESS DATA COUNTS]")
    print(run_ssh(f'docker exec tezlify-db psql -U tezlify -d tezlify -c "{db_counts_sql}"'))

    # 6. Container Status & Uptime
    print("\n[CONTAINER UPTIME]")
    print(run_ssh("docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.RunningFor}}'"))

    # 7. Host Resources
    print("\n[HOST RESOURCES]")
    print("Uptime / Load:", run_ssh("uptime"))
    print("Memory:", run_ssh("free -h | grep Mem:"))
    print("Disk:", run_ssh("df -h / | grep /dev/"))

    print("\n" + "=" * 60)
    print("SNAPSHOT COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
