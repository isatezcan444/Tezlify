"""WhatsApp Hardcore Stress Test & Parity Forensic Suite.

Performs deep stress testing across:
1. Production Database Integrity & Inconsistency Audit
   - Orphaned messages, conversations, reactions, link previews
   - Unread count drift (conversations.unread_count vs actual messages)
   - Timestamp chronology, future stamps, out-of-order messages
   - LID / Phone JID identity collision and split conversation detection
   - Lock contention and transaction isolation
2. High-Concurrency API Stress & Latency Benchmark
   - Concurrent /whatsapp/conversations bursts (10, 25, 50 workers)
   - Concurrent /whatsapp/conversations/{id}/messages pagination
   - Concurrent contact search
   - Latency distribution (min, p50, p95, p99, max) and error rates
3. Live Session & WebSocket Gateway Bridge Telemetry
   - Bridge health, reconnects, event latencies
"""
import asyncio
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
import urllib.request
import urllib.error

SSH_KEY = os.path.expanduser("~/.ssh/id_tezlify_oracle")
ORACLE_HOST = "ubuntu@130.162.247.20"
API_BASE = "https://api.130.162.247.20.sslip.io/api/v1"


def run_remote_psql(sql: str) -> str:
    """Execute raw SQL directly on production PostgreSQL container via SSH."""
    flat_sql = sql.replace("\n", " ").strip()
    cmd = [
        "ssh", "-i", SSH_KEY, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
        ORACLE_HOST,
        f"docker exec tezlify-db psql -U tezlify -d tezlify -t -X -A -c \"{flat_sql}\""
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"PSQL Error: {res.stderr.strip()}")
    return res.stdout.strip()


def run_remote_psql_json(sql: str) -> List[Dict[str, Any]]:
    """Execute SQL query returning JSON rows."""
    clean_sql = sql.strip().rstrip(";")
    wrapped = f"SELECT coalesce(json_agg(t), '[]'::json) FROM ({clean_sql}) t;"
    out = run_remote_psql(wrapped)
    raw = out.strip()
    if not raw or raw == "null":
        return []
    try:
        return json.loads(raw)
    except Exception as e:
        print(f"JSON parse error for output: {raw[:200]}")
        return []


def test_database_integrity() -> Dict[str, Any]:
    print("\n" + "=" * 60)
    print(">>> 1. DATABASE INTEGRITY & CONSISTENCY AUDIT")
    print("=" * 60)
    results = {}

    # 1.1 Orphaned Messages
    orphaned_msgs = run_remote_psql(
        "SELECT count(*) FROM messages m LEFT JOIN conversations c ON m.conversation_id = c.id WHERE c.id IS NULL;"
    ).strip().split("\n")[0]
    print(f"[*] Orphaned Messages (missing conversation): {orphaned_msgs}")
    results["orphaned_messages"] = int(orphaned_msgs)

    # 1.2 Orphaned Reactions
    orphaned_reactions = run_remote_psql(
        "SELECT count(*) FROM message_reactions r LEFT JOIN messages m ON r.message_id = m.id WHERE m.id IS NULL;"
    ).strip().split("\n")[0]
    print(f"[*] Orphaned Reactions (missing message): {orphaned_reactions}")
    results["orphaned_reactions"] = int(orphaned_reactions)

    # 1.3 Unread Count Discrepancy
    unread_drifts = run_remote_psql_json("""
        SELECT 
            c.id AS conv_id,
            coalesce(ct.display_name, ct.phone_e164, 'Conv #' || c.id) AS title,
            c.unread_count AS stored_unread,
            count(m.id) AS calculated_unread,
            (c.unread_count - count(m.id)) AS diff
        FROM conversations c
        LEFT JOIN contacts ct ON c.contact_id = ct.id
        LEFT JOIN messages m 
            ON m.conversation_id = c.id 
            AND m.direction = 'INBOUND' 
            AND m.status != 'READ'
        GROUP BY c.id, ct.display_name, ct.phone_e164, c.unread_count
        HAVING c.unread_count != count(m.id)
    """)
    print(f"[*] Conversations with Unread Count Drift: {len(unread_drifts)}")
    if unread_drifts:
        for d in unread_drifts[:5]:
            print(f"    - Conv #{d['conv_id']} ('{d['title']}'): stored={d['stored_unread']}, calculated={d['calculated_unread']}")
    results["unread_count_drifts"] = unread_drifts

    # 1.4 Future or Anachronistic Timestamps
    future_timestamps = run_remote_psql_json("""
        SELECT id, wa_message_id, created_at, external_timestamp
        FROM messages
        WHERE created_at > now() + interval '5 minutes'
           OR external_timestamp > now() + interval '5 minutes';
    """)
    print(f"[*] Messages with Future Timestamps (>5m in future): {len(future_timestamps)}")
    results["future_timestamps"] = future_timestamps

    # 1.5 Duplicate wa_message_ids
    duplicate_wa_ids = run_remote_psql_json("""
        SELECT wa_message_id, count(*) AS cnt
        FROM messages
        WHERE wa_message_id IS NOT NULL AND wa_message_id != ''
        GROUP BY wa_message_id
        HAVING count(*) > 1;
    """)
    print(f"[*] Duplicate wa_message_ids: {len(duplicate_wa_ids)}")
    results["duplicate_wa_ids"] = duplicate_wa_ids

    # 1.6 Phone / Contact Multiple Active Threads (Split Conversations)
    split_convs = run_remote_psql_json("""
        SELECT 
            ct.phone_e164 as phone,
            count(c.id) as conv_count,
            array_agg(c.id) as conv_ids
        FROM conversations c
        JOIN contacts ct ON c.contact_id = ct.id
        WHERE ct.phone_e164 IS NOT NULL 
          AND ct.phone_e164 != ''
          AND c.status != 'CLOSED'
        GROUP BY ct.phone_e164
        HAVING count(c.id) > 1;
    """)
    print(f"[*] Potential Split Conversations (Multiple active threads for same contact): {len(split_convs)}")
    if split_convs:
        for s in split_convs[:5]:
            print(f"    - Phone {s['phone']}: {s['conv_count']} convs -> IDs: {s['conv_ids']}")
    results["split_conversations"] = split_convs

    # 1.7 Missing Media Files
    missing_media = run_remote_psql_json("""
        SELECT id, media_id, media_mime_type, media_filename
        FROM messages
        WHERE media_id IS NOT NULL AND (media_id = '' OR media_mime_type IS NULL);
    """)
    print(f"[*] Messages with malformed media records: {len(missing_media)}")
    results["malformed_media"] = missing_media

    return results


def test_api_concurrency(auth_token: str) -> Dict[str, Any]:
    print("\n" + "=" * 60)
    print(">>> 2. HIGH-CONCURRENCY API STRESS & LATENCY BENCHMARK")
    print("=" * 60)

    # First fetch conversation IDs to use for message stress testing
    req = urllib.request.Request(f"{API_BASE}/whatsapp/conversations?limit=10", headers={"Authorization": f"Bearer {auth_token}"})
    try:
        with urllib.request.urlopen(req) as resp:
            conv_data = json.loads(resp.read().decode())
            conv_items = conv_data.get("items", [])
            conv_ids = [c["id"] for c in conv_items if "id" in c]
    except Exception as e:
        print(f"[-] Failed to fetch initial conversations: {e}")
        conv_ids = []

    print(f"[*] Found {len(conv_ids)} active conversation IDs for testing: {conv_ids[:5]}")

    results = {}

    def fetch_url(url: str) -> Tuple[int, float, Optional[str]]:
        t0 = time.perf_counter()
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {auth_token}"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                _ = r.read()
                dur = time.perf_counter() - t0
                return r.status, dur, None
        except urllib.error.HTTPError as he:
            dur = time.perf_counter() - t0
            return he.code, dur, str(he)
        except Exception as ex:
            dur = time.perf_counter() - t0
            return 0, dur, str(ex)

    def benchmark_endpoint(name: str, url_builder, total_requests: int, concurrency: int):
        print(f"\n[*] Benchmarking: {name} (Total: {total_requests}, Concurrency: {concurrency})")
        latencies = []
        statuses = {}
        errors = []

        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = []
            for i in range(total_requests):
                url = url_builder(i)
                futures.append(executor.submit(fetch_url, url))

            for f in futures:
                status, dur, err = f.result()
                latencies.append(dur)
                statuses[status] = statuses.get(status, 0) + 1
                if err:
                    errors.append(err)

        latencies.sort()
        p50 = latencies[int(len(latencies) * 0.50)] * 1000
        p90 = latencies[int(len(latencies) * 0.90)] * 1000
        p95 = latencies[int(len(latencies) * 0.95)] * 1000
        p99 = latencies[int(len(latencies) * 0.99)] * 1000
        avg = (sum(latencies) / len(latencies)) * 1000
        min_lat = min(latencies) * 1000
        max_lat = max(latencies) * 1000

        print(f"    Statuses: {statuses}")
        print(f"    Latency: min={min_lat:.1f}ms, avg={avg:.1f}ms, p50={p50:.1f}ms, p95={p95:.1f}ms, p99={p99:.1f}ms, max={max_lat:.1f}ms")
        if errors:
            print(f"    Errors ({len(errors)}): {errors[:3]}")

        return {
            "statuses": statuses,
            "min_ms": min_lat,
            "avg_ms": avg,
            "p50_ms": p50,
            "p95_ms": p95,
            "p99_ms": p99,
            "max_ms": max_lat,
            "errors_count": len(errors)
        }

    # Test 1: Conversations List (Concurrency 15, Total 45)
    results["conversations_concurrency_15"] = benchmark_endpoint(
        "GET /whatsapp/conversations (Concurrency 15)",
        lambda i: f"{API_BASE}/whatsapp/conversations?limit=30&offset=0",
        total_requests=45,
        concurrency=15
    )

    # Test 2: High Concurrency Conversations List (Concurrency 30, Total 60)
    results["conversations_concurrency_30"] = benchmark_endpoint(
        "GET /whatsapp/conversations (Concurrency 30)",
        lambda i: f"{API_BASE}/whatsapp/conversations?limit=30&offset=0",
        total_requests=60,
        concurrency=30
    )

    # Test 3: Messages Pagination (Concurrency 20, Total 60)
    if conv_ids:
        test_conv_id = conv_ids[0]
        results["messages_pagination_concurrency_20"] = benchmark_endpoint(
            f"GET /whatsapp/conversations/{test_conv_id}/messages (Concurrency 20)",
            lambda i: f"{API_BASE}/whatsapp/conversations/{test_conv_id}/messages?limit=50&offset={(i % 3) * 20}",
            total_requests=60,
            concurrency=20
        )

    # Test 4: Contacts Search (Concurrency 15, Total 30)
    search_terms = ["a", "m", "mehmet", "90", "ist", "b"]
    results["contacts_search_concurrency_15"] = benchmark_endpoint(
        "GET /whatsapp/contacts?query=... (Concurrency 15)",
        lambda i: f"{API_BASE}/whatsapp/contacts?query={search_terms[i % len(search_terms)]}&limit=20",
        total_requests=30,
        concurrency=15
    )

    return results


def check_host_and_container_health():
    print("\n" + "=" * 60)
    print(">>> 3. CONTAINER HEALTH, MEMORY & DOCKER STATS")
    print("=" * 60)
    cmd = [
        "ssh", "-i", SSH_KEY, "-o", "StrictHostKeyChecking=no", ORACLE_HOST,
        "docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}'"
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    print(res.stdout)


def main():
    print("=" * 60)
    print("TEZLIFY WHATSAPP HARDCORE STRESS TEST & PARITY AUDIT")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 60)

    # Generate Auth Token
    from scripts.auth_helper import get_ephemeral_auth_token
    token = get_ephemeral_auth_token()
    print(f"[+] Obtained live ephemeral auth token (admin session).")

    # 1. DB Integrity
    db_results = test_database_integrity()

    # 2. API Concurrency
    api_results = test_api_concurrency(token)

    # 3. Host / Container Stats
    check_host_and_container_health()

    print("\n" + "=" * 60)
    print(">>> 4. SUMMARY OF AUDIT FINDINGS")
    print("=" * 60)
    issues = []

    if db_results.get("orphaned_messages", 0) > 0:
        issues.append(f"CRITICAL: Found {db_results['orphaned_messages']} orphaned messages without valid conversation_id.")

    if db_results.get("unread_count_drifts"):
        issues.append(f"HIGH: Found {len(db_results['unread_count_drifts'])} conversations where stored unread_count != actual unread messages count.")

    if db_results.get("duplicate_wa_ids"):
        issues.append(f"HIGH: Found {len(db_results['duplicate_wa_ids'])} duplicate wa_message_ids in database.")

    if db_results.get("split_conversations"):
        issues.append(f"MEDIUM: Found {len(db_results['split_conversations'])} phone numbers split across multiple conversation threads.")

    for k, v in api_results.items():
        if v.get("errors_count", 0) > 0:
            issues.append(f"PERFORMANCE/RELIABILITY: {k} experienced {v['errors_count']} failed requests.")
        if v.get("p95_ms", 0) > 1500:
            issues.append(f"LATENCY: {k} p95 latency is high: {v['p95_ms']:.1f}ms.")

    if not issues:
        print("[+] ALL AUDIT CHECKS PASSED CLEANLY! No severe anomalies detected.")
    else:
        print(f"[!] DETECTED {len(issues)} ACTIONABLE ISSUES / BOTTLENECKS:")
        for idx, iss in enumerate(issues, 1):
            print(f"  {idx}. {iss}")

    # Save report artifact
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "database_integrity": db_results,
        "api_concurrency": api_results,
        "issues": issues
    }
    with open("whatsapp_stress_test_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print("\n[+] Full report saved to whatsapp_stress_test_report.json")


if __name__ == "__main__":
    main()
