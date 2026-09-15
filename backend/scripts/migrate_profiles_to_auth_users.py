#!/usr/bin/env python3
"""Idempotent migration script for populating native auth_users from existing profiles.

Preserves exact user UUIDs to maintain complete foreign-key compatibility
across conversations, campaigns, contacts, and WhatsApp sessions.

Usage:
    python backend/scripts/migrate_profiles_to_auth_users.py --dry-run
    python backend/scripts/migrate_profiles_to_auth_users.py --apply
    python backend/scripts/migrate_profiles_to_auth_users.py --rollback
"""
import sys
import argparse
import asyncio
import logging
from sqlalchemy import text
from backend.app.core.database import AsyncSessionLocal

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("auth-migration")


async def run_migration(dry_run: bool = True, rollback: bool = False):
    logger.info("Starting Profile -> Native Auth migration probe (dry_run=%s, rollback=%s)", dry_run, rollback)

    async with AsyncSessionLocal() as db:
        # Check if auth_staging_users table exists
        check_table = await db.execute(text("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' AND table_name = 'auth_staging_users'
            );
        """))
        table_exists = check_table.scalar()

        if not table_exists:
            logger.info("Table auth_staging_users does not exist. Creating table structure...")
            if not dry_run:
                ddl_statements = [
                    """
                    CREATE TABLE IF NOT EXISTS auth_staging_users (
                        id UUID PRIMARY KEY,
                        email VARCHAR(255) UNIQUE NOT NULL,
                        display_name VARCHAR(255),
                        avatar_url VARCHAR(500),
                        is_active BOOLEAN NOT NULL DEFAULT TRUE,
                        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
                        updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now()
                    );
                    """,
                    """
                    CREATE TABLE IF NOT EXISTS auth_staging_oauth_accounts (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES auth_staging_users(id) ON DELETE CASCADE,
                        provider VARCHAR(50) NOT NULL,
                        provider_subject VARCHAR(255) NOT NULL,
                        provider_email VARCHAR(255) NOT NULL,
                        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
                        updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
                        CONSTRAINT uq_staging_oauth_provider_subject UNIQUE (provider, provider_subject)
                    );
                    """,
                    """
                    CREATE TABLE IF NOT EXISTS auth_staging_sessions (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES auth_staging_users(id) ON DELETE CASCADE,
                        session_token_hash VARCHAR(64) UNIQUE NOT NULL,
                        expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
                        last_seen_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
                        revoked_at TIMESTAMP WITHOUT TIME ZONE
                    );
                    """,
                    """
                    CREATE TABLE IF NOT EXISTS auth_staging_oauth_states (
                        state_hash VARCHAR(64) PRIMARY KEY,
                        expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
                        consumed_at TIMESTAMP WITHOUT TIME ZONE
                    );
                    """
                ]
                for stmt in ddl_statements:
                    await db.execute(text(stmt))
                await db.commit()
                logger.info("Staging auth tables created successfully.")

        if rollback:
            if dry_run:
                logger.info("[DRY-RUN] Would truncate auth_staging_oauth_accounts and auth_staging_users.")
                return
            logger.warning("Executing rollback: truncating staging auth tables...")
            await db.execute(text("TRUNCATE TABLE auth_staging_sessions, auth_staging_oauth_accounts, auth_staging_users CASCADE;"))
            await db.commit()
            logger.info("Rollback completed successfully.")
            return

        # Query existing profiles
        res = await db.execute(text("SELECT id, email, full_name, avatar_url, created_at FROM profiles;"))
        profiles = res.fetchall()
        logger.info("Found %d existing profile records to migrate.", len(profiles))

        migrated_count = 0
        skipped_count = 0

        for p in profiles:
            uid = str(p[0])
            email = str(p[1])
            name = p[2]
            avatar = p[3]
            created = p[4]
            masked_email = email[:3] + "***@" + email.split("@")[1] if "@" in email else "***"

            # Check if user already exists in auth_staging_users
            if table_exists:
                existing_check = await db.execute(
                    text("SELECT id FROM auth_staging_users WHERE id = :uid OR email = :email;"),
                    {"uid": uid, "email": email}
                )
                if existing_check.scalar_one_or_none():
                    logger.info("  [SKIP] User %s (%s) already exists in auth_staging_users.", uid[:8] + "...", masked_email)
                    skipped_count += 1
                    continue

            if dry_run:
                logger.info("  [DRY-RUN] Would migrate profile: %s (%s, Name: %s)", uid[:8] + "...", masked_email, name)
                migrated_count += 1
            else:
                await db.execute(
                    text("""
                        INSERT INTO auth_staging_users (id, email, display_name, avatar_url, is_active, created_at, updated_at)
                        VALUES (:id, :email, :display_name, :avatar_url, TRUE, :created_at, now())
                        ON CONFLICT (id) DO UPDATE SET updated_at = now();
                    """),
                    {
                        "id": uid,
                        "email": email,
                        "display_name": name,
                        "avatar_url": avatar,
                        "created_at": created,
                    }
                )
                logger.info("  [APPLIED] Migrated profile: %s (%s)", uid[:8] + "...", masked_email)
                migrated_count += 1

        if not dry_run:
            await db.commit()

        logger.info("Migration summary: %d migrated/planned, %d skipped.", migrated_count, skipped_count)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate profiles to native auth_users")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Simulate migration without modifications")
    parser.add_argument("--apply", action="store_true", help="Execute live migration")
    parser.add_argument("--rollback", action="store_true", help="Rollback migrated data")
    args = parser.parse_args()

    is_dry_run = not args.apply
    asyncio.run(run_migration(dry_run=is_dry_run, rollback=args.rollback))
