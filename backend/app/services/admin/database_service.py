"""Database metrics service for Admin Center.

Invariants:
- Read-only async queries on pg_stat_activity and pg_database_size.
- Safe fallbacks when running under SQLite test fixtures or if queries fail.
- Zero mutations.
"""

import logging
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.schemas.admin import AdminDatabaseInfo

logger = logging.getLogger(__name__)


async def get_database_metrics(db: AsyncSession) -> AdminDatabaseInfo:
    """Collects database health, connection statistics, and size."""
    health = "healthy"
    total_conns = 0
    active_conns = 0
    idle_conns = 0
    size_mb = 0.0

    try:
        # 1. Connectivity check
        await db.execute(text("SELECT 1"))

        # 2. Connection counts
        try:
            conn_stmt = text(
                "SELECT count(*), "
                "count(*) FILTER (WHERE state = 'active'), "
                "count(*) FILTER (WHERE state = 'idle') "
                "FROM pg_stat_activity;"
            )
            conn_res = await db.execute(conn_stmt)
            conn_row = conn_res.fetchone()
            if conn_row:
                total_conns = int(conn_row[0] or 0)
                active_conns = int(conn_row[1] or 0)
                idle_conns = int(conn_row[2] or 0)
        except Exception as ce:
            logger.debug("pg_stat_activity query not supported or failed (likely SQLite/mock): %s", ce)
            total_conns = 1
            active_conns = 1
            idle_conns = 0

        # 3. Database size
        try:
            size_stmt = text("SELECT pg_database_size(current_database());")
            size_res = await db.execute(size_stmt)
            size_row = size_res.fetchone()
            if size_row and size_row[0]:
                size_bytes = int(size_row[0])
                size_mb = round(size_bytes / (1024.0 * 1024.0), 2)
        except Exception as se:
            logger.debug("pg_database_size query not supported or failed: %s", se)
            size_mb = 0.0

    except Exception as e:
        logger.warning("Database health probe failed: %s", e)
        health = "unreachable"

    return AdminDatabaseInfo(
        health=health,
        connections_total=total_conns,
        connections_active=active_conns,
        connections_idle=idle_conns,
        database_size_mb=size_mb,
    )
