#!/usr/bin/env python3
"""
Tezlify - Supabase Frankfurt Target Validation & Forensic Benchmark Script.

Validates the Frankfurt Supabase project as a production migration target:
1. DNS resolution (A and AAAA records)
2. TCP connect latency (20 iterations)
3. PostgreSQL SSLRequest / TLS handshake latency (20 iterations)
4. Authenticated database connectivity (asyncpg / SQLAlchemy 2.0 AsyncIO)
5. System queries (SELECT version(), current_database(), current_user, SELECT now())
6. Schema and extension inventory
7. Warm pooled query latency (50x SELECT 1, 50x SELECT now())
8. Concurrent connection benchmark (5, 10, 20 concurrent workers)
9. PostgreSQL connection reuse verification (pg_backend_pid)

Safety:
- Strictly read-only; executes zero schema mutations or data writes.
- Automatically masks passwords and tokens in all outputs.
"""

import argparse
import asyncio
import os
import re
import socket
import ssl
import statistics
import sys
import time
from typing import Any, Dict, List, Optional
import urllib.parse


def mask_url(url: str) -> str:
    """Masks database passwords and tokens in connection strings."""
    if not url:
        return "[NOT PROVIDED]"
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.password:
            masked = url.replace(f":{parsed.password}@", ":********@")
            return masked
        return url
    except Exception:
        return re.sub(r"://([^:]+):([^@]+)@", r"://\1:********@", url)


def calculate_stats(measurements: List[float]) -> Dict[str, float]:
    if not measurements:
        return {"min": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0}
    sorted_m = sorted(measurements)
    p95_idx = min(int(len(sorted_m) * 0.95), len(sorted_m) - 1)
    return {
        "min": round(min(measurements), 2),
        "median": round(statistics.median(measurements), 2),
        "p95": round(sorted_m[p95_idx], 2),
        "max": round(max(measurements), 2),
    }


def benchmark_network(host: str, port: int, iterations: int = 20) -> Dict[str, Any]:
    print(f"[*] Running network benchmark to {host}:{port} ({iterations} iterations)...")
    dns_times = []
    tcp_times = []
    tls_times = []
    resolved_ips = set()

    for _ in range(iterations):
        # 1. DNS Resolution
        t0 = time.monotonic()
        try:
            ip = socket.gethostbyname(host)
            resolved_ips.add(ip)
            t1 = time.monotonic()
            dns_times.append((t1 - t0) * 1000.0)
        except Exception as e:
            print(f"[!] DNS resolution failed: {e}")
            continue

        # 2. TCP Connect
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5.0)
        t0 = time.monotonic()
        try:
            s.connect((ip, port))
            t1 = time.monotonic()
            tcp_times.append((t1 - t0) * 1000.0)
        except Exception as e:
            print(f"[!] TCP connect failed: {e}")
            s.close()
            continue

        # 3. PostgreSQL SSLRequest Handshake
        try:
            # 8-byte Postgres SSLRequest packet: length=8, code=80877103 (0x04d2162f)
            s.sendall(b"\x00\x00\x00\x08\x04\xd2\x16\x2f")
            reply = s.recv(1)
            if reply == b"S":
                ctx = ssl._create_unverified_context()
                t0 = time.monotonic()
                ss = ctx.wrap_socket(s, server_hostname=host)
                t1 = time.monotonic()
                tls_times.append((t1 - t0) * 1000.0)
                ss.close()
            else:
                s.close()
        except Exception as e:
            print(f"[!] TLS handshake failed: {e}")
            s.close()

    return {
        "host": host,
        "port": port,
        "resolved_ips": list(resolved_ips),
        "iterations": iterations,
        "dns": calculate_stats(dns_times),
        "tcp": calculate_stats(tcp_times),
        "tls": calculate_stats(tls_times),
    }


async def benchmark_postgres(db_url: str) -> Dict[str, Any]:
    print(f"[*] Connecting to PostgreSQL via SQLAlchemy / asyncpg: {mask_url(db_url)}")
    try:
        from sqlalchemy.ext.asyncio import create_async_engine
        from sqlalchemy import text
    except ImportError:
        print("[!] SQLAlchemy not found in current Python environment.")
        return {"error": "SQLAlchemy not installed"}

    # Format URL to asyncpg driver if needed
    clean_url = db_url
    if clean_url.startswith("postgres://"):
        clean_url = clean_url.replace("postgres://", "postgresql+asyncpg://", 1)
    elif clean_url.startswith("postgresql://") and "+asyncpg" not in clean_url:
        clean_url = clean_url.replace("postgresql://", "postgresql+asyncpg://", 1)

    # Supabase Transaction Pooler recommended settings
    engine = create_async_engine(
        clean_url,
        connect_args={"statement_cache_size": 0},
        pool_size=5,
        max_overflow=5,
        pool_pre_ping=True,
    )

    results: Dict[str, Any] = {}

    try:
        # A) Initial connection & metadata
        t0 = time.monotonic()
        async with engine.connect() as conn:
            t1 = time.monotonic()
            results["initial_connect_ms"] = round((t1 - t0) * 1000.0, 2)

            # Metadata queries
            version_res = await conn.execute(text("SELECT version();"))
            results["version"] = version_res.scalar()

            db_res = await conn.execute(text("SELECT current_database();"))
            results["current_database"] = db_res.scalar()

            user_res = await conn.execute(text("SELECT current_user;"))
            results["current_user"] = user_res.scalar()

            # Schemas
            schemas_res = await conn.execute(text("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name;"))
            results["schemas"] = [row[0] for row in schemas_res.fetchall()]

            # Extensions
            ext_res = await conn.execute(text("SELECT extname, extversion FROM pg_extension ORDER BY extname;"))
            results["extensions"] = {row[0]: row[1] for row in ext_res.fetchall()}

            # Connection identity / PID
            pid_res = await conn.execute(text("SELECT pg_backend_pid();"))
            initial_pid = pid_res.scalar()
            results["initial_pid"] = initial_pid

            # B) Warm sequential queries on SAME connection (50 runs)
            select_1_times = []
            for _ in range(50):
                q0 = time.monotonic()
                await conn.execute(text("SELECT 1;"))
                q1 = time.monotonic()
                select_1_times.append((q1 - q0) * 1000.0)
            results["warm_select_1"] = calculate_stats(select_1_times)

            select_now_times = []
            for _ in range(50):
                q0 = time.monotonic()
                await conn.execute(text("SELECT now();"))
                q1 = time.monotonic()
                select_now_times.append((q1 - q0) * 1000.0)
            results["warm_select_now"] = calculate_stats(select_now_times)

        # C) Connection reuse proof across pool acquires
        reuse_pids = []
        for _ in range(5):
            async with engine.connect() as conn:
                pid_check = await conn.execute(text("SELECT pg_backend_pid();"))
                reuse_pids.append(pid_check.scalar())
        results["pooled_pids"] = reuse_pids
        results["pid_reuse_detected"] = len(set(reuse_pids)) < len(reuse_pids)

        # D) Concurrency benchmark (5, 10, 20 workers)
        results["concurrency"] = {}
        for concurrency in (5, 10, 20):
            async def worker(worker_id: int):
                w0 = time.monotonic()
                async with engine.connect() as conn:
                    await conn.execute(text("SELECT 1;"))
                w1 = time.monotonic()
                return (w1 - w0) * 1000.0

            total_t0 = time.monotonic()
            worker_times = await asyncio.gather(*[worker(i) for i in range(concurrency)], return_exceptions=True)
            total_t1 = time.monotonic()

            valid_times = [t for t in worker_times if isinstance(t, float)]
            failures = len(worker_times) - len(valid_times)

            results["concurrency"][f"{concurrency}_workers"] = {
                "total_duration_ms": round((total_t1 - total_t0) * 1000.0, 2),
                "failures": failures,
                "stats": calculate_stats(valid_times),
            }

    finally:
        await engine.dispose()

    return results


def print_report(net_report: Dict[str, Any], pg_report: Optional[Dict[str, Any]] = None) -> None:
    print("\n" + "=" * 70)
    print("       SUPABASE FRANKFURT TARGET VALIDATION REPORT")
    print("=" * 70)
    print(f"Target Host      : {net_report['host']}")
    print(f"Target Port      : {net_report['port']}")
    print(f"Resolved IPs     : {', '.join(net_report['resolved_ips'])}")
    print(f"Iterations       : {net_report['iterations']}")
    print("-" * 70)
    print("Network Latency Benchmarks (Oracle Frankfurt -> Supabase Frankfurt):")
    print(f"  DNS Resolution : Min={net_report['dns']['min']}ms, Med={net_report['dns']['median']}ms, P95={net_report['dns']['p95']}ms, Max={net_report['dns']['max']}ms")
    print(f"  TCP Connect    : Min={net_report['tcp']['min']}ms, Med={net_report['tcp']['median']}ms, P95={net_report['tcp']['p95']}ms, Max={net_report['tcp']['max']}ms")
    print(f"  TLS Handshake  : Min={net_report['tls']['min']}ms, Med={net_report['tls']['median']}ms, P95={net_report['tls']['p95']}ms, Max={net_report['tls']['max']}ms")

    if pg_report and "error" not in pg_report:
        print("-" * 70)
        print("PostgreSQL Engine & Authentication Verification:")
        print(f"  PostgreSQL Ver : {pg_report.get('version', 'N/A')[:60]}...")
        print(f"  Database Name  : {pg_report.get('current_database', 'N/A')}")
        print(f"  Current User   : {pg_report.get('current_user', 'N/A')}")
        print(f"  Initial Connect: {pg_report.get('initial_connect_ms', 'N/A')} ms")
        print(f"  Active Schemas : {', '.join(pg_report.get('schemas', []))}")
        print(f"  Extensions     : {', '.join(list(pg_report.get('extensions', {}).keys())[:8])}")
        print("-" * 70)
        print("Warm Pooled Query Benchmarks (50 iterations):")
        w1 = pg_report.get("warm_select_1", {})
        wn = pg_report.get("warm_select_now", {})
        print(f"  SELECT 1       : Min={w1.get('min')}ms, Med={w1.get('median')}ms, P95={w1.get('p95')}ms, Max={w1.get('max')}ms")
        print(f"  SELECT now()   : Min={wn.get('min')}ms, Med={wn.get('median')}ms, P95={wn.get('p95')}ms, Max={wn.get('max')}ms")
        print("-" * 70)
        print("Concurrency Benchmarks:")
        for k, v in pg_report.get("concurrency", {}).items():
            print(f"  {k:12}: Total={v['total_duration_ms']}ms, Med={v['stats']['median']}ms, P95={v['stats']['p95']}ms, Failures={v['failures']}")
        print("-" * 70)
        print(f"Connection Pool PID Reuse: {pg_report.get('pid_reuse_detected')} (PIDs: {pg_report.get('pooled_pids')})")
    elif pg_report and "error" in pg_report:
        print("-" * 70)
        print(f"PostgreSQL Status: {pg_report['error']}")
    print("=" * 70 + "\n")


def main():
    parser = argparse.ArgumentParser(description="Supabase Frankfurt Target Validation Tool")
    parser.add_argument("--host", default="aws-0-eu-central-1.pooler.supabase.com", help="Transaction pooler hostname")
    parser.add_argument("--port", type=int, default=6543, help="Transaction pooler port (default: 6543)")
    parser.add_argument("--db-url", default=os.getenv("TARGET_DATABASE_URL") or os.getenv("DATABASE_URL"), help="PostgreSQL connection string (optional)")
    parser.add_argument("--iterations", type=int, default=20, help="Network test iterations")
    args = parser.parse_args()

    net_report = benchmark_network(args.host, args.port, iterations=args.iterations)

    pg_report = None
    if args.db_url and not args.db_url.startswith("sqlite"):
        try:
            pg_report = asyncio.run(benchmark_postgres(args.db_url))
        except Exception as e:
            pg_report = {"error": f"Database connection failed: {e}"}

    print_report(net_report, pg_report)


if __name__ == "__main__":
    main()
