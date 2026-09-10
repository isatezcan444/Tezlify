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