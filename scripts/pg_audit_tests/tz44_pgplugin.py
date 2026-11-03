"""Test-only harness shim for the AŞAMA 4.4 isolated-PostgreSQL run.

Problem it solves
-----------------
`backend/tests/conftest.py::run_db_migrations` is a SESSION-scoped *sync*
fixture that drives the shared async engine through its own throwaway event
loop (`asyncio.get_event_loop().run_until_complete(...)`).  The engine is a
module-global created with `AsyncAdaptedQueuePool`, so the connection it opens
there stays parked in the pool and is handed to the first test, which runs in
pytest-asyncio's loop.  With SQLite (aiosqlite) this is harmless; with asyncpg
the pool's `pool_pre_ping` decides the connection is stale, tries to terminate
it inside the wrong loop, and raises `RuntimeError: ... attached to a different
loop` — which surfaces as a SETUP error that silently skips one test.

Replacing the pool with `NullPool` removes cross-loop reuse: every checkout
opens and closes its own connection in the caller's loop.

This file is NOT part of the repository. It is loaded with `-p tz44_pgplugin`.
"""
import sys


def pytest_configure(config):
    try:
        from sqlalchemy.pool import NullPool

        import backend.app.core.database as db

        sync_engine = db.engine.sync_engine
        if not isinstance(sync_engine.pool, NullPool):
            sync_engine.pool = NullPool(sync_engine.pool._creator)
        print(
            "\n[tz44_pgplugin] engine pool -> NullPool "
            f"(target={db.settings.DATABASE_URL.split('@')[-1]})",
            file=sys.stderr,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"\n[tz44_pgplugin] WARN could not swap pool: {exc}", file=sys.stderr)
