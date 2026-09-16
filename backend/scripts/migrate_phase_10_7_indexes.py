#!/usr/bin/env python3
"""
Tezlify - Phase 10.7 Database Optimization Migration Script

Handles:
1. Creating partial index on whatsapp_private.event_outbox:
   `ix_event_outbox_cleanup` ON whatsapp_private.event_outbox (sequence ASC)
   WHERE state IN ('DELIVERED', 'DEAD_LETTER')
2. Safely dropping 12 duplicate secondary indexes on (id) that mirror primary key indexes.
3. Rollback (--down) support to re-create duplicate indexes and drop cleanup index.
4. Status verification (--check).

All PostgreSQL index mutations execute with `CONCURRENTLY` under AUTOCOMMIT to prevent table locks.
"""

import argparse
import asyncio
import logging
import os
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# Ensure project root is in python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from backend.app.core.config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("phase_10_7_migration")

# Target secondary duplicate indexes on primary key `id`
DUPLICATE_PK_INDEXES = [
    ("blacklist", "ix_blacklist_id"),
    ("blacklist", "ix_blacklists_id"),
    ("campaign_groups", "ix_campaign_groups_id"),
    ("campaigns", "ix_campaigns_id"),
    ("contacts", "ix_contacts_id"),
    ("conversations", "ix_conversations_id"),
    ("discovery_runs", "ix_discovery_runs_id"),
    ("leads", "ix_leads_id"),
    ("message_logs", "ix_message_logs_id"),
    ("messages", "ix_messages_id"),
    ("raw_candidates", "ix_raw_candidates_id"),
    ("scraper_jobs", "ix_scraper_jobs_id"),
    ("profiles", "ix_profiles_id"),
    ("whatsapp_sessions", "ix_whatsapp_sessions_id"),
]

PARTIAL_OUTBOX_INDEX = {
    "schema": "whatsapp_private",
    "table": "event_outbox",
    "name": "ix_event_outbox_cleanup",
    "def": "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_event_outbox_cleanup ON whatsapp_private.event_outbox (sequence ASC) WHERE state IN ('DELIVERED', 'DEAD_LETTER')",
}


async def get_index_map(conn) -> dict:
    """Returns mapping of index_name -> (schemaname, tablename, indexdef)"""
    res = await conn.execute(
        text("SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes")
    )
    return {row[2]: (row[0], row[1], row[3]) for row in res.fetchall()}


async def check_status(engine):
    async with engine.connect() as conn:
        dialect = conn.dialect.name
        if dialect != "postgresql":
            logger.info("Dialect is %s (not postgresql). Skipping PostgreSQL index audit.", dialect)
            return

        index_map = await get_index_map(conn)

        logger.info("=== Phase 10.7 Index Audit ===")
        # 1. Partial Outbox Index
        outbox_name = PARTIAL_OUTBOX_INDEX["name"]
        if outbox_name in index_map:
            logger.info("[PARTIAL INDEX] %s: PRESENT (%s)", outbox_name, index_map[outbox_name][2])
        else:
            logger.info("[PARTIAL INDEX] %s: MISSING", outbox_name)

        # 2. Duplicate PK Indexes
        logger.info("--- Duplicate PK Secondary Indexes ---")
        present_count = 0
        for table, idx_name in DUPLICATE_PK_INDEXES:
            if idx_name in index_map:
                present_count += 1
                logger.info("  [DUPLICATE] %s (on %s): PRESENT", idx_name, table)
            else:
                logger.info("  [CLEAN] %s: REMOVED / NOT PRESENT", idx_name)

        logger.info("Total duplicate PK indexes currently present: %d", present_count)


async def migrate_up(engine):
    async with engine.connect() as conn:
        dialect = conn.dialect.name
        if dialect != "postgresql":
            logger.warning("Dialect is %s; CONCURRENTLY index operations require PostgreSQL.", dialect)
            return

    # In SQLAlchemy asyncpg, execution_options(isolation_level="AUTOCOMMIT") enables CONCURRENTLY
    autocommit_engine = engine.execution_options(isolation_level="AUTOCOMMIT")

    async with autocommit_engine.connect() as conn:
        index_map = await get_index_map(conn)

        # 1. Ensure Partial Outbox Index
        outbox_name = PARTIAL_OUTBOX_INDEX["name"]
        if outbox_name not in index_map:
            logger.info("Creating partial index %s CONCURRENTLY...", outbox_name)
            try:
                await conn.execute(text(PARTIAL_OUTBOX_INDEX["def"]))
                logger.info("Successfully created partial index %s.", outbox_name)
            except Exception as e:
                logger.error("Failed to create %s: %s", outbox_name, e)
                raise
        else:
            logger.info("Partial index %s already exists.", outbox_name)

        # 2. Drop Duplicate PK Secondary Indexes
        dropped_count = 0
        for table, idx_name in DUPLICATE_PK_INDEXES:
            if idx_name in index_map:
                schema = index_map[idx_name][0]
                logger.info("Dropping duplicate secondary index %s.%s CONCURRENTLY...", schema, idx_name)
                try:
                    await conn.execute(text(f"DROP INDEX CONCURRENTLY IF EXISTS {schema}.{idx_name}"))
                    logger.info("Dropped %s.%s successfully.", schema, idx_name)
                    dropped_count += 1
                except Exception as e:
                    logger.error("Failed to drop %s.%s: %s", schema, idx_name, e)
                    raise
            else:
                logger.debug("Index %s already absent.", idx_name)

        logger.info("Phase 10.7 Migration UP complete. Dropped %d duplicate indexes.", dropped_count)


async def migrate_down(engine):
    """Rollback: drop partial outbox index and re-create secondary indexes."""
    async with engine.connect() as conn:
        dialect = conn.dialect.name
        if dialect != "postgresql":
            logger.warning("Dialect is %s; rollback requires PostgreSQL.", dialect)
            return

    autocommit_engine = engine.execution_options(isolation_level="AUTOCOMMIT")

    async with autocommit_engine.connect() as conn:
        # 1. Drop partial outbox index
        outbox_name = PARTIAL_OUTBOX_INDEX["name"]
        logger.info("Rolling back: dropping %s...", outbox_name)
        await conn.execute(text(f"DROP INDEX CONCURRENTLY IF EXISTS whatsapp_private.{outbox_name}"))

        # 2. Re-create duplicate secondary indexes
        tables_to_recreate = [
            ("blacklist", "ix_blacklist_id"),
            ("campaign_groups", "ix_campaign_groups_id"),
            ("campaigns", "ix_campaigns_id"),
            ("contacts", "ix_contacts_id"),
            ("conversations", "ix_conversations_id"),
            ("discovery_runs", "ix_discovery_runs_id"),
            ("leads", "ix_leads_id"),
            ("message_logs", "ix_message_logs_id"),
            ("messages", "ix_messages_id"),
            ("raw_candidates", "ix_raw_candidates_id"),
            ("scraper_jobs", "ix_scraper_jobs_id"),
            ("whatsapp_sessions", "ix_whatsapp_sessions_id"),
        ]
        for table, idx_name in tables_to_recreate:
            logger.info("Recreating %s ON %s (id)...", idx_name, table)
            try:
                await conn.execute(text(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {idx_name} ON public.{table} (id)"))
            except Exception as e:
                logger.warning("Could not recreate %s on %s: %s", idx_name, table, e)

        logger.info("Phase 10.7 Rollback DOWN complete.")


async def main():
    parser = argparse.ArgumentParser(description="Tezlify Phase 10.7 Database Index Migration")
    parser.add_argument("--up", action="store_true", help="Apply Phase 10.7 index migrations")
    parser.add_argument("--down", action="store_true", help="Rollback Phase 10.7 index migrations")
    parser.add_argument("--check", action="store_true", help="Check current status of indexes")
    parser.add_argument("--db-url", type=str, default=None, help="Database connection URL override")
    args = parser.parse_args()

    db_url = args.db_url or settings.DATABASE_URL
    if db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://", 1)

    engine = create_async_engine(db_url, echo=False)
    try:
        if args.down:
            await migrate_down(engine)
            await check_status(engine)
        elif args.up:
            await migrate_up(engine)
            await check_status(engine)
        else:
            await check_status(engine)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
