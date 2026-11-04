"""Tests for Phase 7.3: Baileys Protocol Events, Entity Classification, and Session Conflict Recovery."""

import pytest
import pytest_asyncio
from sqlalchemy import select, text, delete
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.models.conversation import Conversation, ConversationEntityType
from backend.app.models.contact import Contact
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.core.migrations import ensure_conversations_columns
from backend.app.services.whatsapp.identity import (
    is_newsletter_jid,
    is_group_jid,
    is_broadcast_only_jid,
    is_status_broadcast_jid,
    jid_to_phone,
    is_degenerate_jid,
)
from backend.app.core.database import Base
from backend.app.services.whatsapp.orchestration.events import (
    WhatsAppEventOrchestrator,
    _map_session_event,
    _map_conversation_event,
    _ensure_conversation,
)
from backend.app.services.whatsapp_service import list_conversations


class TestWhatsAppIdentityClassification:
    def test_newsletter_classification(self):
        jid = "120363024823904812@newsletter"
        assert is_newsletter_jid(jid) is True
        assert is_group_jid(jid) is False
        assert is_status_broadcast_jid(jid) is False
        assert is_broadcast_only_jid(jid) is False  # Must not be skipped as broadcast-only
        assert is_degenerate_jid(jid) is False  # Valid channel JID
        # Truthfulness / Phone Integrity: newsletter must never get fake phone
        assert jid_to_phone(jid) is None

    def test_status_broadcast_remains_broadcast_only(self):
        jid = "status@broadcast"
        assert is_status_broadcast_jid(jid) is True
        assert is_broadcast_only_jid(jid) is True
        assert is_newsletter_jid(jid) is False

    def test_group_classification(self):
        jid = "120363045678912345@g.us"
        assert is_group_jid(jid) is True
        assert is_newsletter_jid(jid) is False
        assert is_broadcast_only_jid(jid) is False


class TestSessionConflictRecoveryMapping:
    @pytest.mark.asyncio
    async def test_connection_replaced_error_mapping(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        async_session = sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

        async with async_session() as db:
            session = WhatsAppSession(
                user_id="00000000-0000-0000-0000-000000000001",
                gateway_id="gw-session-101",
                session_name="Hat 1",
                status=SessionStatus.CONNECTED,
                is_phone_online=True,
            )
            db.add(session)
            await db.commit()
            await db.refresh(session)

            payload = {
                "event": "session_disconnected",
                "session_id": "gw-session-101",
                "status": "DISCONNECTED",
                "reason": "CONNECTION_REPLACED",
            }
            res = await _map_session_event(db, payload)
            assert res["reason"] == "CONNECTION_REPLACED"
            await db.commit()
            await db.refresh(session)
            assert session.status == SessionStatus.DISCONNECTED
            assert session.error_message == "WHATSAPP_CONNECTION_REPLACED"

        await engine.dispose()


class TestListConversationsEntityTypeSerialization:
    @pytest.mark.asyncio
    async def test_list_conversations_serializes_entity_type(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        async_session = sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        user_id = "00000000-0000-0000-0000-000000000001"

        async with async_session() as db:
            conv = Conversation(
                user_id=user_id,
                channel="WHATSAPP",
                status="ACTIVE",
                is_group=True,
                entity_type=ConversationEntityType.COMMUNITY.value,
                parent_jid=None,
            )
            db.add(conv)
            await db.commit()

            items, total = await list_conversations(db, user_id=user_id)
            assert total == 1
            item = items[0]
            assert item["entity_type"] == "COMMUNITY"
            assert item["parent_jid"] is None
            assert item["is_group"] is True

        await engine.dispose()


@pytest.mark.asyncio
async def test_ensure_conversations_columns_idempotency_sqlite():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Run migration first time with engine
    await ensure_conversations_columns(engine)

    # Check columns exist
    async with engine.connect() as conn:
        res = await conn.execute(text("PRAGMA table_info(conversations)"))
        cols = {row[1] for row in res.fetchall()}
        assert "entity_type" in cols
        assert "parent_jid" in cols

    # Run migration second time (idempotency)
    await ensure_conversations_columns(engine)

    await engine.dispose()


@pytest.mark.asyncio
async def test_real_postgres17_entity_type_migration_and_query():
    # PostgreSQL 17 test connection string
    pg_url = "postgresql+asyncpg://isatezcan:@127.0.0.1:5432/tezlify_test_isolated"
    test_user_uuid = "a0000000-0000-0000-0000-000000000001"
    try:
        engine = create_async_engine(pg_url, echo=False)
        async_session = sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with engine.connect() as conn:
            # Verify PG version
            version_res = await conn.execute(text("SHOW server_version;"))
            pg_version = version_res.scalar()
            assert "17." in str(pg_version), f"Expected PostgreSQL 17, got {pg_version}"

        # Run migration on real PG with engine
        await ensure_conversations_columns(engine)

        # Verify columns & indexes in PG catalog
        async with async_session() as db:
            col_res = await db.execute(text("""
                SELECT column_name, data_type, column_default
                FROM information_schema.columns
                WHERE table_name = 'conversations' AND column_name IN ('entity_type', 'parent_jid');
            """))
            cols = {row[0]: row[1] for row in col_res.fetchall()}
            assert "entity_type" in cols
            assert "parent_jid" in cols

            # Insert rows using Conversation ORM model with different entity types
            conv1 = Conversation(user_id=test_user_uuid, is_group=False, entity_type=ConversationEntityType.INDIVIDUAL.value)
            conv2 = Conversation(user_id=test_user_uuid, is_group=True, entity_type=ConversationEntityType.GROUP.value)
            conv3 = Conversation(user_id=test_user_uuid, is_group=True, entity_type=ConversationEntityType.COMMUNITY.value)
            conv4 = Conversation(user_id=test_user_uuid, is_group=True, entity_type=ConversationEntityType.ANNOUNCEMENT.value, parent_jid="120363012345678901@g.us")
            conv5 = Conversation(user_id=test_user_uuid, is_group=False, entity_type=ConversationEntityType.CHANNEL.value)
            db.add_all([conv1, conv2, conv3, conv4, conv5])
            await db.commit()

            # Query back
            select_res = await db.execute(
                select(Conversation.entity_type, Conversation.parent_jid, Conversation.is_group)
                .where(Conversation.user_id == test_user_uuid)
                .order_by(Conversation.id.desc())
                .limit(5)
            )
            rows = select_res.fetchall()
            assert len(rows) == 5
            types = [r[0] for r in rows]
            assert "CHANNEL" in types
            assert "ANNOUNCEMENT" in types
            assert "COMMUNITY" in types

            # Clean up test rows
            await db.execute(delete(Conversation).where(Conversation.user_id == test_user_uuid))
            await db.commit()

        await engine.dispose()
    except Exception as exc:
        pytest.fail(f"PostgreSQL 17 isolated test failed: {exc}")
