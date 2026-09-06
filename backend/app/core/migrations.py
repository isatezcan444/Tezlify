"""
Başlangıç (startup) veritabanı uyumluluk geçişleri.

Proje henüz Alembic kullanmadığı için, model şeması ile mevcut SQLite/PostgreSQL
şeması arasındaki bilinen kırıcı farklar burada idempotent şekilde giderilir.
Her geçiş yalnızca gerektiğinde çalışır; hata halinde uygulama açık hata ile
başlamayı reddeder (sessiz şema sapması kabul edilmez).
"""
import logging
from typing import Any, Dict, List

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)


def _sqlite_columns(raw_rows: List[Any]) -> Dict[str, bool]:
    """PRAGMA table_info satırlarından {kolon_adı: notnull} haritası çıkarır."""
    return {row[1]: bool(row[3]) for row in raw_rows}


async def ensure_leads_phone_nullable(engine: AsyncEngine) -> None:
    """`leads.phone_e164` kolonunu nullable yapar (uydurma numara üretimi kaldırıldı).

    - PostgreSQL: ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL
    - SQLite: ALTER COLUMN desteklenmediği için yedek tablo üzerinden rebuild.
    """
    if engine.dialect.name == "postgresql":
        async with engine.begin() as conn:
            await conn.execute(
                text("ALTER TABLE leads ALTER COLUMN phone_e164 DROP NOT NULL")
            )
        logger.info("[MIGRATION] leads.phone_e164 -> NULLABLE (postgresql)")
        return

    if engine.dialect.name != "sqlite":
        logger.warning("[MIGRATION] Bilinmeyen dialect %r; phone_e164 kontrolü atlandı.", engine.dialect.name)
        return

    async with engine.begin() as conn:
        exists = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'")
        )
        if exists.first() is None:
            return  # Tablo henüz yok; create_all yeni şemayı doğru kurar.

        info_rows = (await conn.execute(text("PRAGMA table_info(leads)"))).fetchall()
        columns = _sqlite_columns(info_rows)
        if "phone_e164" not in columns:
            return
        if not columns["phone_e164"]:
            return  # Zaten nullable.

        # Rebuild: yedekle -> düşür -> model şemasıyla yeniden oluştur -> geri yükle.
        await conn.execute(text("DROP TABLE IF EXISTS _leads_migrate_backup"))
        await conn.execute(text("CREATE TABLE _leads_migrate_backup AS SELECT * FROM leads"))
        await conn.execute(text("DROP TABLE leads"))

        await conn.run_sync(_create_leads_only)

        backup_info = (await conn.execute(text("PRAGMA table_info(_leads_migrate_backup)"))).fetchall()
        backup_cols = {row[1] for row in backup_info}

        new_info = (await conn.execute(text("PRAGMA table_info(leads)"))).fetchall()
        new_cols = {row[1] for row in new_info}

        shared = [c for c in new_cols if c in backup_cols]
        shared_sorted = sorted(shared)
        col_list = ", ".join(shared_sorted)
        await conn.execute(
            text(f"INSERT INTO leads ({col_list}) SELECT {col_list} FROM _leads_migrate_backup")
        )
        await conn.execute(text("DROP TABLE _leads_migrate_backup"))
        logger.info("[MIGRATION] leads.phone_e164 -> NULLABLE (sqlite rebuild, %d kolon taşındı)", len(shared_sorted))


async def ensure_conversations_columns(engine: AsyncEngine) -> None:
    """Adds unread_count and last_read_at to conversations if missing."""
    if engine.dialect.name != "sqlite":
        return

    async with engine.begin() as conn:
        exists = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
        )
        if exists.first() is None:
            return

        info_rows = (await conn.execute(text("PRAGMA table_info(conversations)"))).fetchall()
        columns = _sqlite_columns(info_rows)
        if "unread_count" not in columns:
            await conn.execute(text("ALTER TABLE conversations ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0"))
            logger.info("[MIGRATION] Added conversations.unread_count")
        if "last_read_at" not in columns:
            await conn.execute(text("ALTER TABLE conversations ADD COLUMN last_read_at DATETIME"))
            logger.info("[MIGRATION] Added conversations.last_read_at")


async def ensure_messages_media_columns(engine: AsyncEngine) -> None:
    """Adds media_id, media_mime_type, media_filename, media_caption to messages if missing, and ensures indexes."""
    if engine.dialect.name != "sqlite":
        return

    async with engine.begin() as conn:
        # 1. Message media columns
        exists_msgs = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        )
        if exists_msgs.first() is not None:
            info_rows = (await conn.execute(text("PRAGMA table_info(messages)"))).fetchall()
            columns = _sqlite_columns(info_rows)
            if "media_id" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN media_id VARCHAR(255)"))
                logger.info("[MIGRATION] Added messages.media_id")
            if "media_mime_type" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN media_mime_type VARCHAR(100)"))
                logger.info("[MIGRATION] Added messages.media_mime_type")
            if "media_filename" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN media_filename VARCHAR(255)"))
                logger.info("[MIGRATION] Added messages.media_filename")
            if "media_caption" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN media_caption TEXT"))
                logger.info("[MIGRATION] Added messages.media_caption")

            # Composite cursor index
            await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_msg_conv_id ON messages (conversation_id, id)"))

        # 2. Unique partial index on active conversations to prevent race condition duplicates
        exists_convs = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
        )
        if exists_convs.first() is not None:
            await conn.execute(
                text("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_conv ON conversations (lead_id, channel) WHERE status = 'ACTIVE'")
            )

        # 3. Campaign group_id column
        exists_camps = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
        )
        if exists_camps.first() is not None:
            info_rows = (await conn.execute(text("PRAGMA table_info(campaigns)"))).fetchall()
            columns = _sqlite_columns(info_rows)
            if "group_id" not in columns:
                await conn.execute(text("ALTER TABLE campaigns ADD COLUMN group_id INTEGER"))
                logger.info("[MIGRATION] Added campaigns.group_id")


async def ensure_user_id_columns(engine: AsyncEngine) -> None:
    """Ensures user_id column exists on all domain tables and profiles table is created."""
    tables = [
        "leads", "discovery_runs", "campaign_groups", "campaigns", 
        "conversations", "messages", "scraper_jobs", "whatsapp_sessions", "blacklist", "message_logs"
    ]
    if engine.dialect.name == "sqlite":
        async with engine.begin() as conn:
            # Create profiles table if not exists
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS profiles (
                    id VARCHAR(36) PRIMARY KEY,
                    email VARCHAR(255) NOT NULL,
                    full_name VARCHAR(255),
                    avatar_url VARCHAR(500),
                    plan_tier VARCHAR(50) DEFAULT 'STARTER',
                    leads_monthly_limit INTEGER DEFAULT 50,
                    leads_used_this_month INTEGER DEFAULT 0,
                    messages_daily_limit INTEGER DEFAULT 20,
                    created_at TIMESTAMP,
                    updated_at TIMESTAMP
                )
            """))

            for tbl in tables:
                exists = await conn.execute(
                    text(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{tbl}'")
                )
                if exists.first() is not None:
                    info_rows = (await conn.execute(text(f"PRAGMA table_info({tbl})"))).fetchall()
                    columns = _sqlite_columns(info_rows)
                    if "user_id" not in columns:
                        await conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN user_id VARCHAR(36)"))
                        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{tbl}_user_id ON {tbl} (user_id)"))
                        logger.info(f"[MIGRATION] Added {tbl}.user_id")
    elif engine.dialect.name == "postgresql":
        async with engine.begin() as conn:
            for tbl in tables:
                await conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE"))
                await conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{tbl}_user_id ON {tbl} (user_id)"))


def _create_leads_only(sync_conn: Any) -> None:
    """Yalnızca `leads` tablosunu model metadata'sından oluşturur."""
    from backend.app.core.database import Base
    from backend.app.models.lead import Lead  # noqa: F401 — metadata'ya kayıt için

    Lead.__table__.create(sync_conn, checkfirst=True)
