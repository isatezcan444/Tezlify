#!/usr/bin/env python3
"""
Tezlify - Phase 4.1: Supabase Frankfurt Authenticated PostgreSQL Benchmark.

Validates the Frankfurt Supabase project with REAL authenticated connections.
Uses IDENTICAL engine configuration to backend/app/core/database.py.

Safety rules:
  - Reads TARGET_DATABASE_URL from environment only; never hardcodes or prints credentials.
  - Strictly READ-ONLY: zero schema mutations, zero data writes, zero application startup.
  - Does NOT trigger WhatsApp restore, migrations, or background job recovery.
  - Masks passwords in ALL output automatically.

Production pool config (must match backend/app/core/database.py):
  pool_size=3, max_overflow=0, pool_recycle=300, pool_pre_ping=True
  connect_args: statement_cache_size=0, idle_in_transaction_session_timeout=30000, lock_timeout=5000
"""

import asyncio
import os
import re
import socket
import ssl
import statistics
import sys
import time
import urllib.parse
from typing import Any, Dict, List, Optional


# ─── Credential Safety ───────────────────────────────────────────────────────

def mask_url(url: str) -> str:
    """Masks passwords from PostgreSQL connection strings in ALL output."""
    if not url:
        return "[NOT_PROVIDED]"
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.password:
            return url.replace(f":{parsed.password}@", ":********@")
        return url
    except Exception:
        return re.sub(r"://([^:]+):([^@]+)@", r"://\1:********@", url)


def connection_metadata(url: str) -> Dict[str, str]:
    """Extracts safe-to-print metadata from a connection string."""
    try:
        parsed = urllib.parse.urlparse(url)
        return {
            "host": parsed.hostname or "unknown",
            "port": str(parsed.port or 5432),
            "database": parsed.path.lstrip("/") or "unknown",
            "user": parsed.username or "unknown",
            "ssl_mode": "require (Supabase enforced)",
        }
    except Exception:
        return {"error": "unparseable URL"}


# ─── Stats ───────────────────────────────────────────────────────────────────

def stats(lst: List[float]) -> Dict[str, float]:
    if not lst:
        return {"min": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0, "n": 0}
    s = sorted(lst)
    p95 = s[min(int(len(s) * 0.95), len(s) - 1)]
    return {
        "min": round(min(lst), 2),
        "median": round(statistics.median(lst), 2),
        "p95": round(p95, 2),
        "max": round(max(lst), 2),
        "n": len(lst),
    }


def fmt(d: Dict[str, float]) -> str:
    return f"min={d['min']}ms  median={d['median']}ms  p95={d['p95']}ms  max={d['max']}ms  (n={d.get('n','?')})"


# ─── Network Layer (no credentials needed) ───────────────────────────────────

def benchmark_network(host: str, port: int, iterations: int = 20) -> Dict[str, Any]:
    print(f"\n[NET] Benchmarking {host}:{port} ({iterations} iterations) ...")
    dns_t, tcp_t, tls_t = [], [], []
    ips: set = set()

    for _ in range(iterations):
        t0 = time.monotonic()
        try:
            ip = socket.gethostbyname(host)
            ips.add(ip)
            dns_t.append((time.monotonic() - t0) * 1000)
        except Exception as e:
            print(f"  [!] DNS fail: {e}"); continue

        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5.0)
        t0 = time.monotonic()
        try:
            s.connect((ip, port))
            tcp_t.append((time.monotonic() - t0) * 1000)
        except Exception as e:
            print(f"  [!] TCP fail: {e}"); s.close(); continue

        try:
            s.sendall(b"\x00\x00\x00\x08\x04\xd2\x16\x2f")
            reply = s.recv(1)
            if reply == b"S":
                ctx = ssl._create_unverified_context()
                t0 = time.monotonic()
                ss = ctx.wrap_socket(s, server_hostname=host)
                tls_t.append((time.monotonic() - t0) * 1000)
                ss.close()
            else:
                s.close()
        except Exception as e:
            print(f"  [!] TLS fail: {e}"); s.close()

    return {
        "resolved_ips": sorted(ips),
        "dns": stats(dns_t),
        "tcp": stats(tcp_t),
        "tls": stats(tls_t),
    }


# ─── PostgreSQL Authenticated Benchmark ──────────────────────────────────────

async def benchmark_postgres(db_url: str) -> Dict[str, Any]:
    """
    Full authenticated PostgreSQL benchmark using production-identical SQLAlchemy config.
    pool_size=3, max_overflow=0 — matches backend/app/core/database.py exactly.
    """
    try:
        from sqlalchemy.ext.asyncio import create_async_engine
        from sqlalchemy import text
    except ImportError:
        return {"error": "sqlalchemy not installed — run: pip install sqlalchemy asyncpg"}

    # Normalise URL scheme for asyncpg driver
    url = db_url
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+asyncpg://", 1)
    elif url.startswith("postgresql://") and "+asyncpg" not in url:
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)

    # ── PRODUCTION-IDENTICAL ENGINE CONFIG ───────────────────────────────────
    engine = create_async_engine(
        url,
        echo=False,
        future=True,
        connect_args={
            "statement_cache_size": 0,                       # Supavisor/PgBouncer required
            "server_settings": {
                "idle_in_transaction_session_timeout": "30000",
                "lock_timeout": "5000",
            },
        },
        pool_size=3,          # matches DATABASE_POOL_SIZE default
        max_overflow=0,       # matches DATABASE_MAX_OVERFLOW default
        pool_recycle=300,     # matches pool_recycle
        pool_pre_ping=True,   # matches pool_pre_ping
    )

    results: Dict[str, Any] = {}

    try:
        # ── A) FIRST CONNECTION (cold acquire) ───────────────────────────────
        print("\n[DB-A] First connection (cold acquire) ...")
        t0 = time.monotonic()
        async with engine.connect() as conn:
            results["first_connect_ms"] = round((time.monotonic() - t0) * 1000, 2)
            print(f"  Cold connect: {results['first_connect_ms']} ms")

            # System info queries
            ver = (await conn.execute(text("SELECT version();"))).scalar()
            results["pg_version"] = ver[:80] if ver else None

            db = (await conn.execute(text("SELECT current_database();"))).scalar()
            results["current_database"] = db

            usr = (await conn.execute(text("SELECT current_user;"))).scalar()
            results["current_user"] = usr

            pid0 = (await conn.execute(text("SELECT pg_backend_pid();"))).scalar()
            results["initial_pid"] = pid0

            ts = (await conn.execute(text("SELECT now();"))).scalar()
            results["server_now"] = str(ts)

            print(f"  PostgreSQL : {ver[:60]}...")
            print(f"  Database   : {db}")
            print(f"  User       : {usr}")
            print(f"  Backend PID: {pid0}")
            print(f"  Server time: {ts}")

            # ── B) Schemas ──────────────────────────────────────────────────
            schemas_r = await conn.execute(
                text("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name;")
            )
            results["schemas"] = [r[0] for r in schemas_r.fetchall()]
            print(f"  Schemas    : {results['schemas']}")

            # ── C) Extensions ───────────────────────────────────────────────
            ext_r = await conn.execute(
                text("SELECT extname, extversion FROM pg_extension ORDER BY extname;")
            )
            results["extensions"] = {r[0]: r[1] for r in ext_r.fetchall()}
            print(f"  Extensions : {list(results['extensions'].keys())}")

            # ── D) Table inventory (public schema) ──────────────────────────
            tbl_r = await conn.execute(text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' ORDER BY table_name;"
            ))
            results["public_tables"] = [r[0] for r in tbl_r.fetchall()]
            print(f"  Tables(pub): {results['public_tables'] or '(empty — expected, not yet migrated)'}")

            # ── E) whatsapp_private schema check ────────────────────────────
            wp_r = await conn.execute(text(
                "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'whatsapp_private';"
            ))
            results["whatsapp_private_exists"] = bool(wp_r.fetchone())
            print(f"  whatsapp_private: {'EXISTS' if results['whatsapp_private_exists'] else 'NOT YET CREATED (expected)'}")

            # ── F) WARM SELECT 1 — 20 consecutive on SAME connection ────────
            print("\n[DB-B] Warm SELECT 1 x20 (same physical connection) ...")
            sel1_times = []
            for _ in range(20):
                q0 = time.monotonic()
                await conn.execute(text("SELECT 1;"))
                sel1_times.append((time.monotonic() - q0) * 1000)
            results["warm_select_1_20"] = stats(sel1_times)
            print(f"  {fmt(results['warm_select_1_20'])}")

            # ── G) WARM SELECT 1 — 50 consecutive ──────────────────────────
            print("[DB-C] Warm SELECT 1 x50 (same connection) ...")
            sel1_50 = []
            for _ in range(50):
                q0 = time.monotonic()
                await conn.execute(text("SELECT 1;"))
                sel1_50.append((time.monotonic() - q0) * 1000)
            results["warm_select_1_50"] = stats(sel1_50)
            print(f"  {fmt(results['warm_select_1_50'])}")

            # ── H) WARM SELECT now() — 50 consecutive ───────────────────────
            print("[DB-D] Warm SELECT now() x50 ...")
            now_times = []
            for _ in range(50):
                q0 = time.monotonic()
                await conn.execute(text("SELECT now();"))
                now_times.append((time.monotonic() - q0) * 1000)
            results["warm_select_now_50"] = stats(now_times)
            print(f"  {fmt(results['warm_select_now_50'])}")

        # ── I) POOL REUSE — pg_backend_pid() across 5 pool acquires ─────────
        print("\n[DB-E] Pool reuse verification (5 pool acquires → pg_backend_pid) ...")
        reuse_pids = []
        for i in range(5):
            async with engine.connect() as conn:
                pid = (await conn.execute(text("SELECT pg_backend_pid();"))).scalar()
                reuse_pids.append(pid)
                print(f"  acquire #{i+1}: pid={pid}")
        results["pool_pids"] = reuse_pids
        unique_pids = len(set(reuse_pids))
        results["pool_pid_reuse"] = unique_pids < len(reuse_pids)
        print(f"  Unique PIDs: {unique_pids} / {len(reuse_pids)} acquires")
        print(f"  Pool reuse : {'YES (connection recycled)' if results['pool_pid_reuse'] else 'NO (Supavisor TX pooler — expected: different PIDs each time)'}")

        # ── J) CONCURRENT BENCHMARK — production pool_size=3 ─────────────────
        print("\n[DB-F] Concurrent benchmark (production config: pool_size=3, max_overflow=0) ...")
        results["concurrency"] = {}

        for workers in (5, 10, 20):
            print(f"  [{workers} workers] ...")

            async def worker(wid: int) -> Optional[float]:
                try:
                    w0 = time.monotonic()
                    async with engine.connect() as conn:
                        await conn.execute(text("SELECT 1;"))
                        await conn.execute(text("SELECT now();"))
                    return (time.monotonic() - w0) * 1000
                except Exception as e:
                    print(f"    worker-{wid} FAILED: {type(e).__name__}: {str(e)[:60]}")
                    return None

            t_start = time.monotonic()
            times_raw = await asyncio.gather(*[worker(i) for i in range(workers)])
            elapsed = (time.monotonic() - t_start) * 1000

            valid = [t for t in times_raw if t is not None]
            failures = len(times_raw) - len(valid)

            results["concurrency"][f"{workers}_workers"] = {
                "total_elapsed_ms": round(elapsed, 2),
                "failures": failures,
                "stats": stats(valid),
            }
            r = results["concurrency"][f"{workers}_workers"]
            print(f"    Total={r['total_elapsed_ms']}ms  {fmt(r['stats'])}  failures={failures}")

        # ── K) HIGH POOL BENCHMARK (benchmark-only, not production config) ───
        print("\n[DB-G] High-pool concurrent benchmark (pool_size=10 — benchmark only, NOT production config) ...")
        results["concurrency_highpool"] = {}

        engine_hp = create_async_engine(
            url,
            echo=False,
            future=True,
            connect_args={"statement_cache_size": 0},
            pool_size=10,
            max_overflow=10,
            pool_recycle=300,
            pool_pre_ping=True,
        )
        try:
            for workers in (5, 10, 20):
                print(f"  [{workers} workers, pool_size=10] ...")

                async def hp_worker(wid: int) -> Optional[float]:
                    try:
                        w0 = time.monotonic()
                        async with engine_hp.connect() as conn:
                            await conn.execute(text("SELECT 1;"))
                        return (time.monotonic() - w0) * 1000
                    except Exception as e:
                        return None

                t_start = time.monotonic()
                times_raw = await asyncio.gather(*[hp_worker(i) for i in range(workers)])
                elapsed = (time.monotonic() - t_start) * 1000
                valid = [t for t in times_raw if t is not None]
                failures = len(times_raw) - len(valid)

                results["concurrency_highpool"][f"{workers}_workers"] = {
                    "total_elapsed_ms": round(elapsed, 2),
                    "failures": failures,
                    "stats": stats(valid),
                }
                r = results["concurrency_highpool"][f"{workers}_workers"]
                print(f"    Total={r['total_elapsed_ms']}ms  {fmt(r['stats'])}  failures={failures}")
        finally:
            await engine_hp.dispose()

    except Exception as e:
        results["error"] = f"{type(e).__name__}: {str(e)}"
        print(f"\n[DB ERROR] {results['error']}")
    finally:
        await engine.dispose()

    return results


# ─── Extension / Auth Readiness Check ────────────────────────────────────────

async def check_extensions_and_auth(db_url: str) -> Dict[str, Any]:
    """Check required extensions and schema structure for migration readiness."""
    required_extensions = {"pgcrypto", "uuid-ossp", "pg_stat_statements"}
    results: Dict[str, Any] = {}

    try:
        from sqlalchemy.ext.asyncio import create_async_engine
        from sqlalchemy import text

        url = db_url
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+asyncpg://", 1)
        elif url.startswith("postgresql://") and "+asyncpg" not in url:
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)

        engine = create_async_engine(
            url,
            connect_args={"statement_cache_size": 0},
            pool_size=2,
            max_overflow=0,
        )
        try:
            async with engine.connect() as conn:
                ext_r = await conn.execute(
                    text("SELECT extname FROM pg_extension ORDER BY extname;")
                )
                present = {r[0] for r in ext_r.fetchall()}
                results["extensions_present"] = sorted(present)
                results["extensions_missing"] = sorted(required_extensions - present)
                results["extensions_ok"] = len(results["extensions_missing"]) == 0

                # Auth schema check
                auth_r = await conn.execute(text(
                    "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'auth';"
                ))
                results["auth_schema_exists"] = bool(auth_r.fetchone())

                # Check auth.users table (Supabase GoTrue managed)
                if results["auth_schema_exists"]:
                    users_r = await conn.execute(text(
                        "SELECT count(*) FROM information_schema.tables "
                        "WHERE table_schema='auth' AND table_name='users';"
                    ))
                    results["auth_users_table_exists"] = (users_r.scalar() or 0) > 0
        finally:
            await engine.dispose()
    except Exception as e:
        results["error"] = f"{type(e).__name__}: {str(e)}"

    return results


# ─── Main ─────────────────────────────────────────────────────────────────────

def print_final_report(net: Dict, pg: Dict, ext: Dict, masked_url: str, meta: Dict) -> None:
    sep = "=" * 72
    print(f"\n{sep}")
    print("  PHASE 4.1 — SUPABASE FRANKFURT AUTHENTICATED VALIDATION REPORT")
    print(sep)

    print("\n── CONNECTION METADATA (safe) ──")
    for k, v in meta.items():
        print(f"  {k:<20}: {v}")

    print(f"\n── NETWORK LAYER (Oracle Frankfurt VM → Supabase Frankfurt :6543) ──")
    print(f"  Resolved IPs : {', '.join(net.get('resolved_ips', []))}")
    print(f"  DNS          : {fmt(net['dns'])}")
    print(f"  TCP Connect  : {fmt(net['tcp'])}")
    print(f"  TLS Handshake: {fmt(net['tls'])}")

    if "error" in pg:
        print(f"\n── POSTGRESQL AUTH: FAILED ──")
        print(f"  Error: {pg['error']}")
        print("\n  Diagnosis checklist:")
        err = pg["error"].lower()
        if "password" in err or "authentication" in err:
            print("  → password authentication failed")
            print("    Check: Supabase dashboard Settings→Database→Connection String")
            print("    Format: postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")
        elif "ssl" in err:
            print("  → SSL required but not negotiated — add ?sslmode=require to URL")
        elif "prepared statement" in err or "cache" in err:
            print("  → statement_cache_size=0 not applied correctly")
        elif "timeout" in err:
            print("  → Connection timeout — check firewall / pooler host")
        return

    print(f"\n── POSTGRESQL ENGINE ──")
    print(f"  Version      : {pg.get('pg_version', 'N/A')}")
    print(f"  Database     : {pg.get('current_database', 'N/A')}")
    print(f"  Current User : {pg.get('current_user', 'N/A')}")
    print(f"  Backend PID  : {pg.get('initial_pid', 'N/A')}")
    print(f"  Server Time  : {pg.get('server_now', 'N/A')}")
    print(f"  Schemas      : {', '.join(pg.get('schemas', []))}")
    print(f"  Extensions   : {', '.join(pg.get('extensions', {}).keys())}")
    print(f"  Public Tables: {pg.get('public_tables', []) or '(empty — awaiting migration)'}")
    print(f"  whatsapp_private schema: {'EXISTS' if pg.get('whatsapp_private_exists') else 'NOT YET (expected before migration)'}")

    print(f"\n── WARM QUERY BENCHMARKS ──")
    print(f"  First connect (cold)    : {pg.get('first_connect_ms', 'N/A')} ms")
    print(f"  SELECT 1 x20 (warm)     : {fmt(pg.get('warm_select_1_20', {}))}")
    print(f"  SELECT 1 x50 (warm)     : {fmt(pg.get('warm_select_1_50', {}))}")
    print(f"  SELECT now() x50 (warm) : {fmt(pg.get('warm_select_now_50', {}))}")

    print(f"\n── POOL REUSE (Supavisor transaction pooler behavior) ──")
    print(f"  PIDs across 5 acquires: {pg.get('pool_pids', [])}")
    print(f"  PID reuse detected    : {pg.get('pool_pid_reuse', 'N/A')}")
    print(f"  Note: With Supabase Transaction Pooler (Supavisor), PIDs may differ per acquire")
    print(f"        as each transaction can route to a different backend. This is EXPECTED.")

    print(f"\n── CONCURRENT BENCHMARK (pool_size=3, max_overflow=0 — PRODUCTION CONFIG) ──")
    for k, v in pg.get("concurrency", {}).items():
        print(f"  {k:12}: total={v['total_elapsed_ms']}ms  {fmt(v['stats'])}  failures={v['failures']}")

    print(f"\n── CONCURRENT BENCHMARK (pool_size=10 — BENCHMARK ONLY, not production) ──")
    for k, v in pg.get("concurrency_highpool", {}).items():
        print(f"  {k:12}: total={v['total_elapsed_ms']}ms  {fmt(v['stats'])}  failures={v['failures']}")

    print(f"\n── EXTENSIONS & AUTH READINESS ──")
    print(f"  Required exts present : {ext.get('extensions_present', [])}")
    print(f"  Missing exts          : {ext.get('extensions_missing', []) or 'NONE (all present)'}")
    print(f"  auth schema           : {'EXISTS' if ext.get('auth_schema_exists') else 'NOT FOUND'}")
    print(f"  auth.users table      : {'EXISTS' if ext.get('auth_users_table_exists') else 'NOT FOUND'}")

    # Final comparison table
    TOKYO = {
        "DNS median": "0.56 ms", "TCP median": "231.55 ms", "TLS median": "234.57 ms",
        "First connect (cold)": "940-980 ms", "SELECT 1 warm median": "~237 ms",
        "SELECT now() warm median": "~237 ms",
        "5 workers total": "~1,190 ms", "10 workers total": "~2,370 ms", "20 workers total": "~4,740 ms",
    }

    c = pg.get("concurrency", {})
    FRANKFURT = {
        "DNS median": f"{net['dns']['median']} ms",
        "TCP median": f"{net['tcp']['median']} ms",
        "TLS median": f"{net['tls']['median']} ms",
        "First connect (cold)": f"{pg.get('first_connect_ms', '?')} ms",
        "SELECT 1 warm median": f"{pg.get('warm_select_1_50', {}).get('median', '?')} ms",
        "SELECT now() warm median": f"{pg.get('warm_select_now_50', {}).get('median', '?')} ms",
        "5 workers total": f"{c.get('5_workers', {}).get('total_elapsed_ms', '?')} ms",
        "10 workers total": f"{c.get('10_workers', {}).get('total_elapsed_ms', '?')} ms",
        "20 workers total": f"{c.get('20_workers', {}).get('total_elapsed_ms', '?')} ms",
    }

    print(f"\n── TOKYO vs FRANKFURT COMPARISON ──")
    print(f"  {'Metric':<30} {'Tokyo (Baseline)':>20} {'Frankfurt (Real)':>20}")
    print(f"  {'-'*70}")
    for metric in TOKYO:
        t_val = TOKYO[metric]
        f_val = FRANKFURT.get(metric, "?")
        print(f"  {metric:<30} {t_val:>20} {f_val:>20}")

    print(f"\n{sep}")
    print("  PRODUCTION SYSTEM STATUS")
    print(sep)
    print("  Tokyo production     : UNCHANGED")
    print("  Render               : UNCHANGED")
    print("  Vercel               : UNCHANGED")
    print("  Production WhatsApp  : UNCHANGED")
    print("  Frankfurt target     : TESTED (read-only)")
    print("  Production migration : NOT STARTED")
    print(sep + "\n")


def main() -> None:
    raw_url = os.environ.get("TARGET_DATABASE_URL", "")
    if not raw_url:
        print("\n[ERROR] TARGET_DATABASE_URL environment variable is not set.")
        print("  Set it with: export TARGET_DATABASE_URL='postgresql://postgres.<ref>:<pw>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'")
        sys.exit(1)

    masked = mask_url(raw_url)
    meta = connection_metadata(raw_url)

    print(f"\n{'='*72}")
    print("  PHASE 4.1 — SUPABASE FRANKFURT AUTHENTICATED BENCHMARK")
    print(f"{'='*72}")
    print(f"  Masked URL: {masked}")
    print(f"  Host      : {meta.get('host')}")
    print(f"  Port      : {meta.get('port')}")
    print(f"  Database  : {meta.get('database')}")
    print(f"  User      : {meta.get('user')}")

    # 1. Network (no auth needed)
    host = meta.get("host", "aws-0-eu-central-1.pooler.supabase.com")
    port = int(meta.get("port", 6543))
    net = benchmark_network(host, port, iterations=20)

    # 2. Authenticated PostgreSQL
    pg = asyncio.run(benchmark_postgres(raw_url))

    # 3. Extension & auth readiness
    ext: Dict[str, Any] = {}
    if "error" not in pg:
        ext = asyncio.run(check_extensions_and_auth(raw_url))

    print_final_report(net, pg, ext, masked, meta)


if __name__ == "__main__":
    main()
