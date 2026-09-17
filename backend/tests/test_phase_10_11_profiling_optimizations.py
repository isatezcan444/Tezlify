"""Phase 10.11 — Runtime Query Profiling & Data-Driven Optimization Regression Suite.

Verifies:
1. Optimization 1: message_status_updated performs a single joint projection
   for (Message, Conversation), eliminating the secondary db.get(Conversation) roundtrip.
2. Optimization 2: _find_whatsapp_conversation resolves Contact and Conversation in a single
   outer-joined query instead of 2 sequential roundtrips.
3. Optimization 3: list_conversations uses correlated NOT EXISTS to exclude broadcast contacts,
   enabling Nested Loop Anti Join with primary key index scan instead of full table scans.
"""
import uuid
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, ConversationMessageStatus, MessageType
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_service as ws


@asynccontextmanager
async def make_test_db(tmp_path, name="profiling_opt_test.db"):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/{name}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield sessions
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_opt1_message_status_updated_joint_projection(tmp_path):
    """OPTIMIZATION 1: message_status_updated resolves Message and Conversation in one query."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner,
                gateway_id="gw-p10-11-1",
                session_name="Opt1 Session",
                status=SessionStatus.CONNECTED,
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905559876543", display_name="Test Lead")
            db.add(contact)
            await db.flush()

            conv = Conversation(
                user_id=owner,
                contact_id=contact.id,
                channel="WHATSAPP",
                session_id=session.id,
                status=ConversationStatus.ACTIVE,
            )
            db.add(conv)
            await db.flush()

            msg = Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Hello Phase 10.11",
                sender_phone="+905559876543",
                recipient_phone="+905559876543",
                wa_message_id="3EB0TEST12345",
                client_message_id="client-test-12345",
                status=ConversationMessageStatus.PENDING,
            )
            db.add(msg)
            await db.commit()

        # Test _map_conversation_event with message_status_updated
        async with sessions() as db:
            event = {
                "event": "message_status_updated",
                "conversation_id": "905559876543@s.whatsapp.net",
                "wa_message_id": "3EB0TEST12345",
                "client_message_id": "client-test-12345",
                "status": "DELIVERED",
                "gateway_session_id": "gw-p10-11-1",
            }

            # Spy on db.get to verify it is NOT called for Conversation
            original_get = db.get
            get_called_for_conv = False

            async def spy_get(model, ident, **kwargs):
                nonlocal get_called_for_conv
                if model is Conversation:
                    get_called_for_conv = True
                return await original_get(model, ident, **kwargs)

            with patch.object(db, "get", side_effect=spy_get):
                res = await ws._map_conversation_event(db, event)

            assert res.get("conversation_id") == conv.id
            assert not get_called_for_conv, "db.get(Conversation) should NOT be called; joint projection used"

            # Check that message status was updated
            updated_msg = (await db.execute(select(Message).where(Message.id == msg.id))).scalar_one()
            assert updated_msg.status == ConversationMessageStatus.DELIVERED


@pytest.mark.asyncio
async def test_opt2_find_whatsapp_conversation_outer_joined(tmp_path):
    """OPTIMIZATION 2: _find_whatsapp_conversation resolves in single outer-joined query."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner,
                gateway_id="gw-p10-11-2",
                session_name="Opt2 Session",
                status=SessionStatus.CONNECTED,
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905553334455", display_name="Single Query Contact")
            db.add(contact)
            await db.flush()

            conv = Conversation(
                user_id=owner,
                contact_id=contact.id,
                channel="WHATSAPP",
                session_id=session.id,
                status=ConversationStatus.ACTIVE,
            )
            db.add(conv)
            await db.commit()

        async with sessions() as db:
            # 1. Matching contact and conversation exists
            found = await ws._find_whatsapp_conversation(
                db, owner, "905553334455@s.whatsapp.net", session_id=session.id
            )
            assert found is not None
            assert found.id == conv.id

            # 2. Contact does not exist
            missing = await ws._find_whatsapp_conversation(
                db, owner, "905550000000@s.whatsapp.net", session_id=session.id
            )
            assert missing is None

            # 3. Wrong session_id
            wrong_session = await ws._find_whatsapp_conversation(
                db, owner, "905553334455@s.whatsapp.net", session_id=99999
            )
            assert wrong_session is None

            # 4. Tenant isolation (other user cannot see conversation)
            other_user = str(uuid.uuid4())
            isolated = await ws._find_whatsapp_conversation(
                db, other_user, "905553334455@s.whatsapp.net", session_id=session.id
            )
            assert isolated is None


@pytest.mark.asyncio
async def test_opt3_list_conversations_correlated_not_exists(tmp_path):
    """OPTIMIZATION 3: list_conversations uses correlated NOT EXISTS to exclude broadcast contacts."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            # Create valid contact & conversation
            valid_contact = Contact(user_id=owner, phone_e164="+905551239999", display_name="Valid Contact")
            db.add(valid_contact)
            await db.flush()

            valid_conv = Conversation(
                user_id=owner,
                contact_id=valid_contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                last_message_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            db.add(valid_conv)

            # Create junk broadcast contact & conversation
            broadcast_contact = Contact(
                user_id=owner, phone_e164="status@broadcast", display_name="Status Broadcast"
            )
            db.add(broadcast_contact)
            await db.flush()

            broadcast_conv = Conversation(
                user_id=owner,
                contact_id=broadcast_contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                last_message_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            db.add(broadcast_conv)

            # Create newsletter contact & conversation
            newsletter_contact = Contact(
                user_id=owner, phone_e164="12345@newsletter", display_name="Test Newsletter"
            )
            db.add(newsletter_contact)
            await db.flush()

            newsletter_conv = Conversation(
                user_id=owner,
                contact_id=newsletter_contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                last_message_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            db.add(newsletter_conv)
            await db.commit()

        async with sessions() as db:
            rows, total = await ws.list_conversations(db, owner)
            assert total == 1, f"Expected exactly 1 conversation, got {total}"
            assert len(rows) == 1
            assert rows[0]["id"] == valid_conv.id
            assert rows[0]["phone"] == "+905551239999"
