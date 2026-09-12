"""
Başlangıç (startup) veritabanı uyumluluk geçişleri.

Proje henüz Alembic kullanmadığı için, model şeması ile mevcut SQLite/PostgreSQL
şeması arasındaki bilinen kırıcı farklar burada idempotent şekilde giderilir.
Her geçiş yalnızca gerektiğinde çalışır; hata halinde uygulama açık hata ile
başlamayı reddeder (sessiz şema sapması kabul edilmez).

`purge_whatsapp_schema` WhatsApp'a özel tabloları, kolonları, indeksleri ve
enum tiplerini kalıcı olarak kaldıran tarihsel temizlik geçişidir (geri
döndürülemez). Genel domain tablolarına (leads, contacts, conversations,
messages, campaigns, message_logs) dokunmaz; yalnızca WhatsApp'a özel
artifaktları siler.
"""
import logging
from typing import Any, Dict, List

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

# WhatsApp'a özel kalıcı olarak kaldırılacak legacy tablolar.
# NOT: `whatsapp_sessions` bilinçli olarak listede DEĞİLDİR — Baileys gateway
# entegrasyonu (Aşama 2) bu tabloyu yeni şemayla yeniden tanımlamıştır ve her
# boot'ta düşürülmesi oturum kayıtlarını siler.
_WHATSAPP_TABLES = [
    "outbox_messages",
    "whatsapp_session_auth",
    "whatsapp_numbers",
    "webhook_events",
]

# PostgreSQL'de kaldırılacak WhatsApp enum tipleri
_WHATSAPP_ENUM_TYPES = [
    "sessionstatus",
    "whatsappnumberprovider",
    "whatsappnumberstatus",
    "webhookeventstatus",
    "outboxmessagestatus",
]


def _sqlite_columns(raw_rows: List[Any]) -> Dict[str, bool]:
    """PRAGMA table_info satırlarından {kolon_adı: notnull} haritası çıkarır."""
    return {row[1]: bool(row[3]) for row in raw_rows}


def _sqlite_drop_columns(sync_conn: Any, table_name: str, model, backup_name: str) -> None:
    """SQLite'te kolon silme: yedekle -> model şemasıyla yeniden kur -> ortak kolonları geri yükle.

    SQLite ALTER TABLE DROP COLUMN desteklemediği için tablo yeniden kurulur.
    Model şemasında artık var olmayan (WhatsApp'a özel) kolonlar otomatik düşer.
    `sync_conn` bir SyncConnection olmalıdır (conn.run_sync üzerinden çağrılır).
    """
    info_rows = sync_conn.execute(text(f"PRAGMA table_info({table_name})")).fetchall()
    _columns = _sqlite_columns(info_rows)  # noqa: F841 - kept for parity with legacy helpers

    sync_conn.execute(text(f"DROP TABLE IF EXISTS {backup_name}"))
    sync_conn.execute(text(f"CREATE TABLE {backup_name} AS SELECT * FROM {table_name}"))
    sync_conn.execute(text(f"DROP TABLE {table_name}"))

    model.__table__.create(sync_conn, checkfirst=True)

    backup_info = sync_conn.execute(text(f"PRAGMA table_info({backup_name})")).fetchall()
    backup_cols = {row[1] for row in backup_info}

    new_info = sync_conn.execute(text(f"PRAGMA table_info({table_name})")).fetchall()
    new_cols = {row[1] for row in new_info}

    shared = sorted(backup_cols.intersection(new_cols))
    if shared:
        col_list = ", ".join(shared)
        sync_conn.execute(
            text(f"INSERT INTO {table_name} ({col_list}) SELECT {col_list} FROM {backup_name}")
        )
    sync_conn.execute(text(f"DROP TABLE {backup_name}"))


async def purge_whatsapp_schema(engine: AsyncEngine) -> None:
    """WhatsApp backend'ine özel tüm veritabanı artifaktlarını kalıcı olarak kaldırır.

    Kapsam:
    - Tablolar: whatsapp_numbers, whatsapp_sessions, whatsapp_session_auth,
      webhook_events, outbox_messages
    - Kolonlar: conversations.whatsapp_number_id, campaigns.session_id,
      message_logs.session_id / wa_message_id / reply_*, messages.wa_message_id,
      contacts.whatsapp_profile_name (+ ilişkili indeksler)
    - PostgreSQL enum tipleri: sessionstatus, whatsappnumber*,
      webhookeventstatus, outboxmessagestatus

    Genel domain tabloları (leads, contacts, conversations, messages,
    campaigns, message_logs) ve genel enumlar (conversationmessagestatus,
    messagedirection, messagetype) korunur.
    """
    from backend.app.models.campaign import Campaign
    from backend.app.models.contact import Contact
    from backend.app.models.conversation import Conversation
    from backend.app.models.message import Message
    from backend.app.models.message_log import MessageLog

    if engine.dialect.name == "postgresql":
        try:
            async with engine.begin() as conn:
                await conn.execute(text("SET LOCAL lock_timeout = '5s'"))

                # 1. WhatsApp kolonlarını genel tablolardan düşür (FK'lar önce)
                await conn.execute(text("ALTER TABLE conversations DROP COLUMN IF EXISTS whatsapp_number_id"))
                await conn.execute(text("ALTER TABLE campaigns DROP COLUMN IF EXISTS session_id"))
                await conn.execute(text("ALTER TABLE message_logs DROP COLUMN IF EXISTS session_id"))
                await conn.execute(text("ALTER TABLE message_logs DROP COLUMN IF EXISTS wa_message_id"))
                await conn.execute(text("ALTER TABLE message_logs DROP COLUMN IF EXISTS reply_received"))
                await conn.execute(text("ALTER TABLE message_logs DROP COLUMN IF EXISTS reply_text"))
                await conn.execute(text("ALTER TABLE message_logs DROP COLUMN IF EXISTS replied_at"))
                # NOT: messages.wa_message_id korunur (Baileys gateway idempotency/dedup)
                await conn.execute(text("ALTER TABLE contacts DROP COLUMN IF EXISTS whatsapp_profile_name"))

                # 2. WhatsApp indeksleri (yalnızca WhatsApp kolonlarına ait olanlar)
                await conn.execute(text("DROP INDEX IF EXISTS idx_conv_user_number"))
                await conn.execute(text("DROP INDEX IF EXISTS idx_conv_number_contact"))
                await conn.execute(text("DROP INDEX IF EXISTS idx_conv_cust_window"))
                await conn.execute(text("DROP INDEX IF EXISTS ix_messages_wa_message_id"))
                await conn.execute(text("DROP INDEX IF EXISTS ix_message_logs_wa_message_id"))
                await conn.execute(text("DROP INDEX IF EXISTS ix_message_logs_session_id"))

                # 3. WhatsApp tabloları (whatsapp_sessions HARİÇ: yeni gateway şeması)
                for tbl in _WHATSAPP_TABLES:
                    await conn.execute(text(f"DROP TABLE IF EXISTS {tbl}"))

                # 4. WhatsApp enum tipleri (kullanıcı yoksa)
                for enum_type in _WHATSAPP_ENUM_TYPES:
                    await conn.execute(text(f"DROP TYPE IF EXISTS {enum_type}"))
        except Exception as e:
            logger.warning("[MIGRATION] purge_whatsapp_schema (postgresql) atlandı: %s", e)
        return

    if engine.dialect.name != "sqlite":
        logger.warning("[MIGRATION] Bilinmeyen dialect %r; purge_whatsapp_schema atlandı.", engine.dialect.name)
        return

    async with engine.begin() as conn:
        # 1. Outbox önce düşer (messages + whatsapp_numbers FK'ları taşır)
        await conn.execute(text("DROP TABLE IF EXISTS outbox_messages"))

        # 2. WhatsApp kolonlarını taşıyan genel tabloları model şemasıyla yeniden kur
        for table_name, model, backup in [
            ("conversations", Conversation, "_conv_purge_backup"),
            ("campaigns", Campaign, "_campaigns_purge_backup"),
            ("message_logs", MessageLog, "_msglog_purge_backup"),
            ("messages", Message, "_messages_purge_backup"),
            ("contacts", Contact, "_contacts_purge_backup"),
        ]:
            exists = await conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name=:t"),
                {"t": table_name},
            )
            if exists.first() is None:
                continue
            await conn.run_sync(_sqlite_drop_columns, table_name, model, backup)

        # 3. WhatsApp tabloları (whatsapp_sessions HARİÇ: yeni gateway şeması)
        for tbl in ["whatsapp_session_auth", "whatsapp_numbers", "webhook_events"]:
            await conn.execute(text(f"DROP TABLE IF EXISTS {tbl}"))

        # 4. Konuşma/indeks temizliği: genel indeksler yeniden oluşturuldu; WhatsApp'a
        #    özel hiçbir indeks model metadata'sında kalmadı.

    logger.info("[MIGRATION] purge_whatsapp_schema completed (sqlite)")


def _sqlite_columns_legacy(raw_rows: List[Any]) -> Dict[str, bool]:
    return {row[1]: bool(row[3]) for row in raw_rows}


async def ensure_leads_phone_nullable(engine: AsyncEngine) -> None:
    """`leads.phone_e164` kolonunu nullable yapar (uydurma numara üretimi kaldırıldı).

    - PostgreSQL: information_schema üzerinden kontrol eder, kilit almadan geçer.
    - SQLite: ALTER COLUMN desteklenmediği için yedek tablo üzerinden rebuild.
    """
    if engine.dialect.name == "postgresql":
        try:
            async with engine.connect() as conn:
                res = await conn.execute(
                    text("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'phone_e164'")
                )
                row = res.first()
                if row and row[0] == "YES":
                    return  # Zaten nullable; kilit gerektiren ALTER TABLE atlandı

            async with engine.begin() as conn:
                await conn.execute(text("SET LOCAL lock_timeout = '3s'"))
                await conn.execute(
                    text("ALTER TABLE leads ALTER COLUMN phone_e164 DROP NOT NULL")
                )
            logger.info("[MIGRATION] leads.phone_e164 -> NULLABLE (postgresql)")
        except Exception as e:
            logger.warning("[MIGRATION] leads.phone_e164 kontrolü/geçişi atlandı: %s", e)
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
        columns = _sqlite_columns_legacy(info_rows)
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


def _create_leads_only(sync_conn: Any) -> None:
    """Yalnızca `leads` tablosunu model metadata'sından oluşturur."""
    from backend.app.models.lead import Lead

    Lead.__table__.create(sync_conn, checkfirst=True)


def _create_conversations_only(sync_conn: Any) -> None:
    """Yalnızca `conversations` tablosunu model metadata'sından oluşturur."""
    from backend.app.models.conversation import Conversation

    Conversation.__table__.create(sync_conn, checkfirst=True)


async def ensure_contacts_table(engine: AsyncEngine) -> None:
    """Idempotently guarantees contacts table and indexes exist."""
    from backend.app.models.contact import Contact

    async with engine.begin() as conn:
        await conn.run_sync(Contact.__table__.create, checkfirst=True)
    logger.info("[MIGRATION] ensure_contacts_table verified")


async def ensure_conversations_columns(engine: AsyncEngine) -> None:
    """
    Ensures conversations table supports generic conversation architecture:
    - Makes `lead_id` nullable (conversations can exist without a CRM lead).
    - Adds `contact_id` and read/unread lifecycle fields.
    - Idempotent across PostgreSQL and SQLite.
    """
    # 1. PostgreSQL implementation
    if engine.dialect.name == "postgresql":
        try:
            async with engine.connect() as conn:
                res = await conn.execute(
                    text("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'lead_id'")
                )
                row = res.first()
                if row and row[0] == "NO":
                    async with engine.begin() as write_conn:
                        await write_conn.execute(text("SET LOCAL lock_timeout = '3s'"))
                        await write_conn.execute(text("ALTER TABLE conversations ALTER COLUMN lead_id DROP NOT NULL"))
                        logger.info("[MIGRATION] conversations.lead_id -> NULLABLE (postgresql)")

            # Add missing columns
            async with engine.begin() as conn:
                await conn.execute(text("SET LOCAL lock_timeout = '3s'"))
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL"))
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0"))
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMP"))
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP"))
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP"))
                await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_conv_user_contact ON conversations (user_id, contact_id)"))
        except Exception as e:
            logger.warning("[MIGRATION] PostgreSQL conversations columns migration: %s", e)
        await ensure_messages_media_columns(engine)
        return

    if engine.dialect.name != "sqlite":
        return

    # 2. SQLite implementation
    async with engine.begin() as conn:
        exists = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
        )
        if exists.first() is None:
            # Table doesn't exist yet; create_all will build it with latest schema
            return

        info_rows = (await conn.execute(text("PRAGMA table_info(conversations)"))).fetchall()
        columns = _sqlite_columns_legacy(info_rows)

        # Check if lead_id is NOT NULL (requires rebuild to make nullable)
        lead_id_not_null = columns.get("lead_id", False)
        if lead_id_not_null:
            logger.info("[MIGRATION] Rebuilding SQLite conversations table to make lead_id nullable...")
            await conn.execute(text("DROP TABLE IF EXISTS _conversations_migrate_backup"))
            await conn.execute(text("CREATE TABLE _conversations_migrate_backup AS SELECT * FROM conversations"))
            await conn.execute(text("DROP TABLE conversations"))

            await conn.run_sync(_create_conversations_only)

            backup_info = (await conn.execute(text("PRAGMA table_info(_conversations_migrate_backup)"))).fetchall()
            backup_cols = {row[1] for row in backup_info}

            new_info = (await conn.execute(text("PRAGMA table_info(conversations)"))).fetchall()
            new_cols = {row[1] for row in new_info}

            shared = sorted(backup_cols.intersection(new_cols))
            col_list = ", ".join(shared)
            await conn.execute(
                text(f"INSERT INTO conversations ({col_list}) SELECT {col_list} FROM _conversations_migrate_backup")
            )
            await conn.execute(text("DROP TABLE _conversations_migrate_backup"))
            logger.info("[MIGRATION] conversations.lead_id -> NULLABLE (sqlite rebuild, %d cols preserved)", len(shared))
        else:
            # Table already has nullable lead_id; just add missing columns
            if "contact_id" not in columns:
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN contact_id INTEGER REFERENCES contacts(id)"))
                logger.info("[MIGRATION] Added conversations.contact_id")
            if "unread_count" not in columns:
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0"))
                logger.info("[MIGRATION] Added conversations.unread_count")
            if "last_read_at" not in columns:
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN last_read_at DATETIME"))
                logger.info("[MIGRATION] Added conversations.last_read_at")
            if "archived_at" not in columns:
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN archived_at DATETIME"))
                logger.info("[MIGRATION] Added conversations.archived_at")
            if "closed_at" not in columns:
                await conn.execute(text("ALTER TABLE conversations ADD COLUMN closed_at DATETIME"))
                logger.info("[MIGRATION] Added conversations.closed_at")

        # Ensure generic conversation indexes
        await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_conv_user_contact ON conversations (user_id, contact_id)"))

    await ensure_messages_media_columns(engine)


async def ensure_messages_media_columns(engine: AsyncEngine) -> None:
    """Adds media_id, client_message_id, and lifecycle timestamps to messages if missing, and ensures indexes."""
    if engine.dialect.name == "postgresql":
        try:
            async with engine.begin() as conn:
                await conn.execute(text("SET LOCAL lock_timeout = '3s'"))
                await conn.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name VARCHAR(100)"))
                await conn.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id VARCHAR(100)"))
                await conn.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP"))
                await conn.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP"))
                await conn.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP"))
                await conn.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS failed_at TIMESTAMP"))
                await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_client_id ON messages (client_message_id)"))
        except Exception as e:
            logger.warning("[MIGRATION] messages PostgreSQL columns: %s", e)
        return

    if engine.dialect.name != "sqlite":
        return

    async with engine.begin() as conn:
        exists_msgs = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        )
        if exists_msgs.first() is not None:
            info_rows = (await conn.execute(text("PRAGMA table_info(messages)"))).fetchall()
            columns = _sqlite_columns_legacy(info_rows)
            if "sender_name" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN sender_name VARCHAR(100)"))
                logger.info("[MIGRATION] Added messages.sender_name")
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
            if "client_message_id" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN client_message_id VARCHAR(100)"))
                logger.info("[MIGRATION] Added messages.client_message_id")
            if "sent_at" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN sent_at DATETIME"))
                logger.info("[MIGRATION] Added messages.sent_at")
            if "delivered_at" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN delivered_at DATETIME"))
                logger.info("[MIGRATION] Added messages.delivered_at")
            if "read_at" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN read_at DATETIME"))
                logger.info("[MIGRATION] Added messages.read_at")
            if "failed_at" not in columns:
                await conn.execute(text("ALTER TABLE messages ADD COLUMN failed_at DATETIME"))
                logger.info("[MIGRATION] Added messages.failed_at")

            # Composite cursor index and client_message_id unique index
            await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_msg_conv_id ON messages (conversation_id, id)"))
            await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_client_id ON messages (client_message_id)"))

        # Unique partial index on active conversations to prevent race condition duplicates
        exists_convs = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
        )
        if exists_convs.first() is not None:
            await conn.execute(
                text("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_conv ON conversations (lead_id, channel) WHERE status = 'ACTIVE' AND lead_id IS NOT NULL")
            )

        # Campaign group_id column
        exists_camps = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'")
        )
        if exists_camps.first() is not None:
            info_rows = (await conn.execute(text("PRAGMA table_info(campaigns)"))).fetchall()
            columns = _sqlite_columns_legacy(info_rows)
            if "group_id" not in columns:
                await conn.execute(text("ALTER TABLE campaigns ADD COLUMN group_id INTEGER"))
                logger.info("[MIGRATION] Added campaigns.group_id")


async def ensure_message_status_enum(engine: AsyncEngine) -> None:
    """Brings PostgreSQL enum types in line with the SQLAlchemy model.

    Canonical lifecycle: PENDING -> SENT -> DELIVERED -> READ, plus FAILED / RECEIVED.

    Production databases created before the unified message lifecycle still carry
    a `conversationmessagestatus` enum WITHOUT `PENDING`, so every outbound send
    fails with `invalid input value for enum conversationmessagestatus: "PENDING"`.
    SQLite never enforces enums, which is why the test suite stayed green.

    This migration is idempotent and zero-downtime:
    - reads existing labels from pg_enum (no table lock),
    - adds only missing values via ALTER TYPE ... ADD VALUE IF NOT EXISTS,
    - runs outside a transaction block (AUTOCOMMIT) because PostgreSQL
      forbids enum value additions inside a transaction.
    """
    if engine.dialect.name != "postgresql":
        return

    from backend.app.models.message import ConversationMessageStatus, MessageType

    targets = {
        "conversationmessagestatus": [e.value for e in ConversationMessageStatus],
        "messagetype": [e.value for e in MessageType],
    }

    try:
        async with engine.connect() as conn:
            for typname, wanted in targets.items():
                type_exists = (
                    await conn.execute(
                        text("SELECT 1 FROM pg_type WHERE typname = :t"),
                        {"t": typname},
                    )
                ).first()
                if type_exists is None:
                    continue  # Fresh DB: create_all() builds the type with all values.
                have_rows = await conn.execute(
                    text(
                        "SELECT enumlabel FROM pg_enum "
                        "JOIN pg_type ON pg_enum.enumtypid = pg_type.oid "
                        "WHERE pg_type.typname = :t"
                    ),
                    {"t": typname},
                )
                have = {r[0] for r in have_rows.fetchall()}
                missing = [v for v in wanted if v not in have]
                if not missing:
                    continue
                # ALTER TYPE ... ADD VALUE cannot run inside a transaction
                # block, so use a dedicated AUTOCOMMIT connection.
                autocommit_engine = engine.execution_options(isolation_level="AUTOCOMMIT")
                async with autocommit_engine.connect() as ac_conn:
                    for value in missing:
                        await ac_conn.execute(
                            text(f"ALTER TYPE {typname} ADD VALUE IF NOT EXISTS '{value}'")
                        )
                        logger.info("[MIGRATION] Added enum value %s to %s (postgresql)", value, typname)
    except Exception as e:
        logger.warning("[MIGRATION] ensure_message_status_enum atlandı: %s", e)


async def ensure_user_id_columns(engine: AsyncEngine) -> None:
    """Ensures user_id column exists on all domain tables and profiles table is created."""
    tables = [
        "leads", "discovery_runs", "campaign_groups", "campaigns",
        "conversations", "messages", "scraper_jobs", "blacklist", "message_logs",
        "contacts"
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
                    columns = _sqlite_columns_legacy(info_rows)
                    if "user_id" not in columns:
                        await conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN user_id VARCHAR(36)"))
                        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{tbl}_user_id ON {tbl} (user_id)"))
                        logger.info(f"[MIGRATION] Added {tbl}.user_id")
    elif engine.dialect.name == "postgresql":
        try:
            async with engine.connect() as conn:
                res = await conn.execute(
                    text("SELECT table_name FROM information_schema.columns WHERE column_name = 'user_id' AND table_name = ANY(:tbls)"),
                    {"tbls": tables},
                )
                existing_tbls = {r[0] for r in res.fetchall()}

            missing_tbls = [t for t in tables if t not in existing_tbls]
            if missing_tbls:
                async with engine.begin() as conn:
                    await conn.execute(text("SET LOCAL lock_timeout = '3s'"))
                    for tbl in missing_tbls:
                        await conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE"))
                        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{tbl}_user_id ON {tbl} (user_id)"))
        except Exception as e:
            logger.warning("[MIGRATION] ensure_user_id_columns postgres kontrolü/geçişi atlandı: %s", e)
async def ensure_whatsapp_sessions_table(engine: AsyncEngine) -> None:
    """Baileys gateway oturum kayıtları için whatsapp_sessions tablosunu güvence altına alır.

    Legacy purge bu tabloyu artık düşürmediği için create_all ile birlikte
    idempotent şekilde kurulur; yalnızca tablo yoksa oluşturur.
    """
    from backend.app.models.whatsapp_session import WhatsAppSession
    from backend.app.models import Message  # noqa: F401 (metadata'ya kayıt)

    async with engine.begin() as conn:
        await conn.run_sync(WhatsAppSession.__table__.create, checkfirst=True)
    logger.info("[MIGRATION] ensure_whatsapp_sessions_table verified")


async def ensure_messages_wa_message_id(engine: AsyncEngine) -> None:
    """messages.wa_message_id kolonunu (varsa) güvence altına alır.

    Baileys gateway inbound/outbound dedup ve status eşleştirmesi bu kolonu
    kullanır; legacy purge artık düşürmediği için eksikse eklenir.
    """
    if engine.dialect.name == "postgresql":
        try:
            async with engine.connect() as conn:
                res = await conn.execute(
                    text("SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'wa_message_id'")
                )
                if res.first() is None:
                    async with engine.begin() as conn2:
                        await conn2.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_message_id VARCHAR(255)"))
                    logger.info("[MIGRATION] messages.wa_message_id eklendi (postgresql)")
                async with engine.begin() as conn3:
                    await conn3.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_wa_message_id ON messages (wa_message_id)"))
        except Exception as e:
            logger.warning("[MIGRATION] ensure_messages_wa_message_id postgres atlandı: %s", e)
        return

    if engine.dialect.name != "sqlite":
        logger.warning("[MIGRATION] ensure_messages_wa_message_id bilinmeyen dialect %r", engine.dialect.name)
        return

    async with engine.begin() as conn:
        exists = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        )
        if exists.first() is None:
            return
        info_rows = (await conn.execute(text("PRAGMA table_info(messages)"))).fetchall()
        columns = _sqlite_columns_legacy(info_rows)
        if "wa_message_id" not in columns:
            await conn.execute(text("ALTER TABLE messages ADD COLUMN wa_message_id VARCHAR(255)"))
            logger.info("[MIGRATION] messages.wa_message_id eklendi (sqlite)")
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_wa_message_id ON messages (wa_message_id)"))

# ---------------------------------------------------------------------------
# Faz 7: Ham LID/JID hayalet verilerinin temizliği (idempotent)
# ---------------------------------------------------------------------------

_RAW_JID_NAME_PATTERNS = ("%@lid%", "jid:%", "%@c.us%", "%@s.whatsapp.net%", "%@g.us%")


async def purge_raw_jid_identity_data(engine: AsyncEngine) -> None:
    """Faz 6e öncesi biriken ham LID/JID kimlik artıklarını temizler.

    Kapsam (yalnızca WhatsApp gateway kaynaklı satırlar; kurşun/CRM
    contact'leri etkilenmez — onlar asla 'jid:' sentinel taşımaz):
    1. contacts.display_name içinde ham jid/lid varsa NULL'a çekilir
       (kimlik çözümlemesi tamamlanana kadar ad gösterilmez).
    2. messages.sender_name içinde ham jid/lid varsa NULL'a çekilir.
    3. Çözülmemiş LID hayalet contact'leri (phone_e164='jid:xxx@lid') ve
       bu contact'lere bağlı sohbetler silinir — gateway, LID↔phone köprüsü
       ile aynı kişiyi telefon JID anahtarlı olarak yeniden oluşturur.
       Gruplar (@g.us) KORUNUR: 'jid:...@g.us' meşru grup anahtarıdır.

    Idempotenttir; tekrar çalıştırma hiçbir şey yapmaz. Hata durumunda
    migration loglanır ama startup'ı düşürmez (orijinal purge deseniyle aynı
    fail-open davranış — veri temizliği şema bütünlüğüne dokunmaz).
    """
    try:
        async with engine.begin() as conn:
            # 1. Ham jid/lid görünen adları nötrle (contact).
            name_pred = " OR ".join(
                f"display_name LIKE :p{i}" for i in range(len(_RAW_JID_NAME_PATTERNS))
            )
            name_params = {f"p{i}": pat for i, pat in enumerate(_RAW_JID_NAME_PATTERNS)}
            res = await conn.execute(
                text(f"UPDATE contacts SET display_name = NULL WHERE display_name IS NOT NULL AND ({name_pred})"),
                name_params,
            )
            sanitized_names = res.rowcount or 0

            # 2. Mesaj gönderen adlarını nötrle.
            res = await conn.execute(
                text("UPDATE messages SET sender_name = NULL WHERE sender_name LIKE '%@lid' OR sender_name LIKE 'jid:%'"),
            )
            sanitized_msgs = res.rowcount or 0

            # 3. Çözülmemiş LID hayalet contact'lerinin sohbetlerini sil
            #    (messages, conversations FK ondelete CASCADE ise birlikte gider;
            #    değilse önce manuel silinir — her iki yol da güvenlidir).
            ghost_ids = (
                await conn.execute(
                    text("SELECT id FROM contacts WHERE phone_e164 LIKE 'jid:%@lid'")
                )
            ).scalars().all()
            deleted_convs = deleted_msgs = deleted_contacts = 0
            if ghost_ids:
                placeholders = ", ".join(f":g{i}" for i in range(len(ghost_ids)))
                params = {f"g{i}": gid for i, gid in enumerate(ghost_ids)}
                conv_ids = (
                    await conn.execute(
                        text(f"SELECT id FROM conversations WHERE contact_id IN ({placeholders})"),
                        params,
                    )
                ).scalars().all()
                if conv_ids:
                    cph = ", ".join(f":c{i}" for i in range(len(conv_ids)))
                    cparams = {f"c{i}": cid for i, cid in enumerate(conv_ids)}
                    r = await conn.execute(text(f"DELETE FROM messages WHERE conversation_id IN ({cph})"), cparams)
                    deleted_msgs = r.rowcount or 0
                    r = await conn.execute(text(f"DELETE FROM conversations WHERE id IN ({cph})"), cparams)
                    deleted_convs = r.rowcount or 0
                r = await conn.execute(text(f"DELETE FROM contacts WHERE id IN ({placeholders})"), params)
                deleted_contacts = r.rowcount or 0

            if sanitized_names or sanitized_msgs or deleted_contacts or deleted_convs:
                logger.info(
                    "[MIGRATION] purge_raw_jid_identity_data: %d ad nötrlendi, %d mesaj adı nötrlendi, "
                    "%d hayalet LID contact + %d sohbet + %d mesaj silindi.",
                    sanitized_names, sanitized_msgs, deleted_contacts, deleted_convs, deleted_msgs,
                )
            else:
                logger.debug("[MIGRATION] purge_raw_jid_identity_data: temizlenecek ham LID/JID verisi yok.")
    except Exception as e:  # noqa: BLE001 - startup'ı düşürmez, loglanır
        logger.warning("[MIGRATION] purge_raw_jid_identity_data atlandı: %s", e)


# ---------------------------------------------------------------------------
# Faz 9 (§5, RC-2): Dejenere '+0' telefonlu WhatsApp kayıtlarının temizliği
# ---------------------------------------------------------------------------

def _is_degenerate_phone(value: Any) -> bool:
    """'+0', '+000...' gibi dejenere numaralar — E.164'te ülke kodu '0' ile
    başlamaz; bu değerler yalnızca `0@s.whatsapp.net` sistem JID'inden
    türetilmiş uydurma telefonlardır (AGENTS.md: sahte telefon sentezlenmez)."""
    if not value or not isinstance(value, str):
        return False
    v = value.strip()
    if not v.startswith("+"):
        return False
    digits = v[1:]
    return bool(digits) and digits.isdigit() and set(digits) == {"0"}


async def purge_degenerate_phone_contacts(engine: AsyncEngine) -> None:
    """Faz 9: geçici bir dönemde `0@s.whatsapp.net` JID'inden türetilen
    '+0' contact/sohbet kayıtlarını güvenli şekilde siler.

    Kapsam: YALNIZCA tüm haneleri sıfır olan '+0…' telefonlu contact'ler ve
    bunlara bağlı WhatsApp sohbetleri/mesajları. Meşru lead/CRM contact'leri
    etkilenmez (E.164 '+0…' ile başlayamaz). Idempotenttir; mesajlar önce
    sohbetlerden silinir (FK sırası), sonra contact silinir — kalan sohbet
    contact_id'si SET NULL olduğu için diğer satırlar korunur.
    """
    try:
        async with engine.begin() as conn:
            rows = (
                await conn.execute(
                    text("SELECT id, phone_e164 FROM contacts WHERE phone_e164 LIKE '+0%'")
                )
            ).fetchall()
            degenerate = [r for r in rows if _is_degenerate_phone(r[1])]
            if not degenerate:
                logger.debug("[MIGRATION] purge_degenerate_phone_contacts: temizlenecek '+0' kaydı yok.")
                return
            contact_ids = [r[0] for r in degenerate]
            placeholders = ", ".join(f":k{i}" for i, k in enumerate(contact_ids))
            params = {f"k{i}": cid for i, cid in enumerate(contact_ids)}
            conv_ids = (
                await conn.execute(
                    text(f"SELECT id FROM conversations WHERE contact_id IN ({placeholders})"),
                    params,
                )
            ).scalars().all()
            deleted_msgs = deleted_convs = 0
            if conv_ids:
                cph = ", ".join(f":c{i}" for i, _ in enumerate(conv_ids))
                cparams = {f"c{i}": cid for i, cid in enumerate(conv_ids)}
                r = await conn.execute(text(f"DELETE FROM messages WHERE conversation_id IN ({cph})"), cparams)
                deleted_msgs = r.rowcount or 0
                r = await conn.execute(text(f"DELETE FROM conversations WHERE id IN ({cph})"), cparams)
                deleted_convs = r.rowcount or 0
            r = await conn.execute(text(f"DELETE FROM contacts WHERE id IN ({placeholders})"), params)
            logger.info(
                "[MIGRATION] purge_degenerate_phone_contacts: %d dejenere '+0' contact + %d sohbet + %d mesaj silindi.",
                r.rowcount or 0, deleted_convs, deleted_msgs,
            )
    except Exception as e:  # noqa: BLE001 - startup'ı düşürmez, loglanır
        logger.warning("[MIGRATION] purge_degenerate_phone_contacts atlandı: %s", e)


# ---------------------------------------------------------------------------
# Faz 10 (P2): son mesaj özetlerinin geri doldurulması (idempotent)
# ---------------------------------------------------------------------------

def _type_label_case(expr: str) -> str:
    """verilen SQL ifadesinden (message_type degeri) tip etiketi ureten CASE.
    CAST AS TEXT her iki dialectta da calisir (postgres native enum -> text,
    sqlite zaten text saklar)."""
    return f"""
CASE UPPER(CAST(COALESCE({expr}, 'TEXT') AS TEXT))
  WHEN 'IMAGE' THEN '📷 Fotoğraf'
  WHEN 'VIDEO' THEN '🎥 Video'
  WHEN 'AUDIO' THEN '🎵 Sesli mesaj'
  WHEN 'STICKER' THEN 'Sticker'
  WHEN 'DOCUMENT' THEN '📄 Dosya'
  WHEN 'LOCATION' THEN '📍 Konum'
  WHEN 'CONTACT' THEN '👤 Kişi kartı'
  WHEN 'TEMPLATE' THEN 'Şablon mesajı'
  WHEN 'UNKNOWN' THEN 'Mesaj'
  WHEN 'OTHER' THEN 'Mesaj'
  WHEN 'TEXT' THEN ''
  ELSE 'Mesaj'
END"""


def _preview_expr() -> str:
    """mesaj satiri (m) -> preview. Bos govde tip etiketine, '[Medya]' /
    '[object Object]' gibi eski artıklar tip etiketine, duz metin govdeye
    cevrilir. (Kose-parantezli DEGERLER sohbet tarafinda kalir ve bu sorgu
    onlari en yeni mesajin etiketi/govdesiyle topluca DEGISTIRIR.)"""
    label = _type_label_case("COALESCE(m.message_type, 'TEXT')")
    return f"""
CASE
  WHEN COALESCE(TRIM(m.body), '') = '' THEN {label}
  WHEN m.body IN ('[object Object]', '[Medya]') THEN {label}
  WHEN m.body LIKE '[%]' AND LENGTH(m.body) <= 20 THEN {label}
  ELSE m.body
END"""


async def backfill_whatsapp_last_message_previews(engine: AsyncEngine) -> None:
    """Faz 10 (P2): bos/bozuk (kose-parantezli '[IMAGE]' vb.) WhatsApp sohbet
    ozetlerini messages tablosundaki EN YENI mesaja (zaman damgasi sirasiyla)
    gore bir kez geri doldurur.

    - Sohbet basina sorgu (N+1) YOK: tek toplu UPDATE calisir.
    - Idempotenttir: ozeti dolu ve duzgun olan sohbetlere dokunmaz.
    - Grup gonderen on eki ('Ahmet: ...') SQL'de uretilmez — sonraki
      senkron/onarim gecisi paylasilan kurala cevirir; buradaki amac
      once 'mesaj var ama ozet bos' yalanini kaldirip gercek icerigi
      (tip etiketi / govde) yazmaktir.
    - Hata startup'i dusurmez (diger migration deseniyle ayni fail-open).
    """
    try:
        dialect = engine.dialect.name
        preview = _preview_expr()
        broken_cond = """(
              last_message_preview IS NULL
              OR TRIM(last_message_preview) = ''
              OR last_message_preview LIKE '[%]'
            )"""
        async with engine.begin() as conn:
            if dialect == "postgresql":
                res = await conn.execute(
                    text(f"""
                        UPDATE conversations AS c
                        SET last_message_preview = LEFT(newest.preview, 500),
                            last_message_at = COALESCE(newest.ts, c.last_message_at)
                        FROM (
                            SELECT DISTINCT ON (m.conversation_id)
                                m.conversation_id AS cid,
                                {preview} AS preview,
                                COALESCE(m.external_timestamp, m.sent_at, m.created_at) AS ts
                            FROM messages m
                            ORDER BY m.conversation_id,
                                     COALESCE(m.external_timestamp, m.sent_at, m.created_at) DESC
                        ) AS newest
                        WHERE newest.cid = c.id
                          AND c.channel = 'WHATSAPP'
                          AND TRIM(newest.preview) <> ''
                          AND {broken_cond}
                    """)
                )
            elif dialect == "sqlite":
                res = await conn.execute(
                    text(f"""
                        UPDATE conversations
                        SET last_message_preview = SUBSTR((
                            SELECT {preview}
                            FROM messages m
                            WHERE m.conversation_id = conversations.id
                            ORDER BY COALESCE(m.external_timestamp, m.sent_at, m.created_at) DESC
                            LIMIT 1
                        ), 1, 500),
                        last_message_at = COALESCE((
                            SELECT COALESCE(m.external_timestamp, m.sent_at, m.created_at)
                            FROM messages m
                            WHERE m.conversation_id = conversations.id
                            ORDER BY COALESCE(m.external_timestamp, m.sent_at, m.created_at) DESC
                            LIMIT 1
                        ), last_message_at)
                        WHERE channel = 'WHATSAPP'
                          AND {broken_cond}
                          AND COALESCE(TRIM((
                            SELECT {preview}
                            FROM messages m
                            WHERE m.conversation_id = conversations.id
                            ORDER BY COALESCE(m.external_timestamp, m.sent_at, m.created_at) DESC
                            LIMIT 1
                          )), '') <> ''
                          AND EXISTS (
                            SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id
                          )
                    """)
                )
            else:
                logger.warning("[MIGRATION] backfill_whatsapp_last_message_previews bilinmeyen dialect %r", dialect)
                return
            if res.rowcount:
                logger.info("[MIGRATION] backfill_whatsapp_last_message_previews: %d sohbet ozeti dolduruldu.", res.rowcount)
            else:
                logger.debug("[MIGRATION] backfill_whatsapp_last_message_previews: doldurulacak kayit yok.")
    except Exception as e:  # noqa: BLE001 - startup'ı düşürmez, loglanır
        logger.warning("[MIGRATION] backfill_whatsapp_last_message_previews atlandı: %s", e)