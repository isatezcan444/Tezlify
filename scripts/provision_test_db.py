"""Provision the schema-only SQLite test DB with FULL startup parity.

`Base.metadata.create_all` alone is not enough: several startup migrations create
tables that are NOT in the ORM metadata (e.g. `history_sync_states`,
`lid_mappings`) and add columns to existing tables (e.g.
`whatsapp_sessions.initial_sync_completed_at`). Tests run against this DB without
executing the startup sequence, so it must be provisioned the same way the app
provisions production.

Usage:
    PYTHONPATH=. DATABASE_URL="sqlite+aiosqlite:////tmp/tezlify_clean.db" \
        python scripts/provision_test_db.py
"""
import asyncio
import os
import sys

DB_PATH = os.environ.get("TEST_DB_PATH", "/tmp/tezlify_clean.db")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{DB_PATH}"


async def main() -> int:
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    from backend.app.core.database import Base, engine
    import backend.app.models  # noqa: F401  (register all ORM tables)
    # `backend/app/auth/infrastructure/sql_models.py` is the ONLY model module
    # outside `backend/app/models/` (tables `auth_staging_users`,
    # `auth_staging_oauth_accounts`, `auth_staging_sessions`,
    # `auth_staging_oauth_states`). `main.py` gets these registered for free via
    # `api_router`, so a bare `import backend.app.models` silently omits them and
    # every auth/multitenancy test then dies on "no such table".
    import backend.app.auth.infrastructure.sql_models  # noqa: F401
    from backend.app.core.migrations import (
        ensure_leads_phone_nullable,
        ensure_contacts_table,
        ensure_contacts_unique_phone,
        ensure_conversations_columns,
        ensure_messages_media_columns,
        ensure_message_status_enum,
        ensure_messages_sender_phone_nullable,
        ensure_user_id_columns,
        ensure_whatsapp_sessions_table,
        ensure_whatsapp_session_sync_columns,
        ensure_whatsapp_gateway_private_schema,
        ensure_messages_wa_message_id,
        ensure_messages_wa_message_id_unique,
        ensure_phase_10_7_indexes,
        ensure_whatsapp_private_lid_and_history_tables,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Same order as `backend/app/main.py`'s lifespan, minus the destructive
    # legacy purge and the (disabled) demo seeding.
    await ensure_leads_phone_nullable(engine)
    await ensure_contacts_table(engine)
    await ensure_contacts_unique_phone(engine)
    await ensure_conversations_columns(engine)
    status = await ensure_messages_media_columns(engine)
    if status != "OK":
        raise SystemExit(f"messages schema migration failed: {status}")
    await ensure_messages_sender_phone_nullable(engine)
    await ensure_message_status_enum(engine)
    await ensure_user_id_columns(engine)
    await ensure_whatsapp_sessions_table(engine)
    await ensure_whatsapp_session_sync_columns(engine)
    await ensure_whatsapp_gateway_private_schema(engine)
    await ensure_messages_wa_message_id(engine)
    await ensure_messages_wa_message_id_unique(engine)
    await ensure_phase_10_7_indexes(engine)
    await ensure_whatsapp_private_lid_and_history_tables(engine)

    await engine.dispose()

    import sqlite3
    con = sqlite3.connect(DB_PATH)
    tables = sorted(r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))
    sess_cols = [r[1] for r in con.execute("PRAGMA table_info(whatsapp_sessions)")]
    print(f"provisioned {DB_PATH}: {len(tables)} tables")
    print("  history_sync_states:", "history_sync_states" in tables)
    print("  lid_mappings:", "lid_mappings" in tables)
    print("  initial_sync_completed_at:", "initial_sync_completed_at" in sess_cols)

    # Hard gate: every table the ORM knows about MUST exist, or the suite will
    # fail later with a misleading "no such table" in an unrelated module.
    missing = sorted(set(Base.metadata.tables) - set(tables))
    if missing:
        raise SystemExit(f"provisioning incomplete, missing tables: {missing}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
