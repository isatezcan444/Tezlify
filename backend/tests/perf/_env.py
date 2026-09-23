"""PHASE 2.C benchmark environment setup.

Sets DATABASE_URL to the isolated `scoutify_perf` PostgreSQL database
BEFORE any backend.app.core.database import, so the benchmark never
touches the dev SQLite database or the `tezlify` dev PostgreSQL DB.
"""
import os

os.environ["DATABASE_URL"] = "postgresql+asyncpg://isatezcan@localhost:5432/scoutify_perf"
# Keep pool bounded; benchmark uses few concurrent sessions.
os.environ.setdefault("DATABASE_POOL_SIZE", "10")
os.environ.setdefault("DATABASE_MAX_OVERFLOW", "5")
