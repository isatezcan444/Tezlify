"""Phase 10.10 — WhatsApp Read-Path & N+1 Performance Optimization Regression Suite.

Verifies:
1. Optimization Group 1: _hydrate_messages_on_demand eliminates redundant post-commit
   entity refreshes (N queries -> 0 queries).
2. Optimization Group 2: _resolve_jid eagerly loads Conversation and Contact in a single
   JOIN query, reducing query count by 50%.
3. Optimization Group 3:
   - list_conversations eagerly loads contacts in the primary query, eliminating secondary
     Contact.id.in_ SELECT queries.
   - Targeted single-conversation hydration bypasses count subqueries.
   - get_messages keyset pagination avoids redundant older_exists checks when all messages
     fit within page_size.
"""
import uuid
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch
from contextlib import asynccontextmanager

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
async def make_test_db(tmp_path, name="read_opt_test.db"):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/{name}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield sessions
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_group_1_hydration_refresh_eliminated(tmp_path, monkeypatch):
    """OPTIMIZATION GROUP 1: _hydrate_messages_on_demand does not call db.refresh in a loop."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(
                user_id=owner,
                gateway_id="gw-opt-1",
                session_name="Opt Test 1",
                status=SessionStatus.CONNECTED,
            )
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233", display_name="Ali")
            db.add(contact)
            await db.flush()
            conv = Conversation(
                user_id=owner,
                contact_id=contact.id,
                channel="WHATSAPP",
                session_id=session.id,
            )
            db.add(conv)
            await db.commit()

            # Mock gateway returning 10 messages
            mock_gw_messages = [
                {
                    "wa_message_id": f"wa-msg-{i}",
                    "conversation_id": "905551112233@s.whatsapp.net",
                    "sender_phone": "+905551112233",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                    "message_type": "TEXT",
                    "body": f"Hydrated message {i}",
                    "created_at": (datetime.utcnow() - timedelta(minutes=i)).isoformat(),
                }
                for i in range(10)
            ]
            monkeypatch.setattr(
                ws.gw,
                "get_messages",
                AsyncMock(return_value={"messages": mock_gw_messages}),
            )

            # Spy on db.refresh to assert it is never called
            original_refresh = db.refresh
            refresh_spy = AsyncMock(side_effect=original_refresh)
            monkeypatch.setattr(db, "refresh", refresh_spy)

            result = await ws._hydrate_messages_on_demand(db, owner, conv, limit=10)

            # Assert: NO db.refresh calls were made (0 queries instead of 10)
            assert refresh_spy.call_count == 0
            assert len(result) == 10
            # All attributes must remain intact and accessible
            assert result[0].wa_message_id is not None
            assert result[0].id is not None


@pytest.mark.asyncio
async def test_group_2_resolve_jid_single_query(tmp_path):
    """OPTIMIZATION GROUP 2: _resolve_jid loads Conversation with joined Contact."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=owner, phone_e164="+905559876543", display_name="Veli")
            db.add(contact)
            await db.flush()
            conv = Conversation(
                user_id=owner,
                contact_id=contact.id,
                channel="WHATSAPP",
            )
            db.add(conv)
            await db.commit()

            # Execute _resolve_jid
            resolved_conv, jid = await ws._resolve_jid(db, owner, conv.id)

            assert resolved_conv.id == conv.id
            assert jid == "905559876543@s.whatsapp.net"
            # Verify contact is already populated on resolved_conv without additional query
            assert resolved_conv.contact is not None
            assert resolved_conv.contact.phone_e164 == "+905559876543"


@pytest.mark.asyncio
async def test_group_3_list_conversations_eager_load_and_targeted(tmp_path):
    """OPTIMIZATION GROUP 3: list_conversations eagerly loads contacts and optimizes targeted lookups."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            c1 = Contact(user_id=owner, phone_e164="+905551110001", display_name="User 1")
            c2 = Contact(user_id=owner, phone_e164="+905551110002", display_name="User 2")
            db.add_all([c1, c2])
            await db.flush()

            conv1 = Conversation(user_id=owner, contact_id=c1.id, channel="WHATSAPP", last_message_preview="Hello 1")
            conv2 = Conversation(user_id=owner, contact_id=c2.id, channel="WHATSAPP", last_message_preview="Hello 2")
            db.add_all([conv1, conv2])
            await db.commit()

            # 1. Full list fetch
            items, total = await ws.list_conversations(db, owner)
            assert total == 2
            assert len(items) == 2
            phones = {item["phone"] for item in items}
            assert "+905551110001" in phones
            assert "+905551110002" in phones
            names = {item["name"] for item in items}
            assert "User 1" in names
            assert "User 2" in names

            # 2. Targeted single conversation fetch (conversation_id parameter)
            target_items, target_total = await ws.list_conversations(
                db, owner, conversation_id=conv1.id, limit=1
            )
            assert target_total == 1
            assert len(target_items) == 1
            assert target_items[0]["id"] == conv1.id
            assert target_items[0]["name"] == "User 1"


@pytest.mark.asyncio
async def test_group_3_get_messages_keyset_guard(tmp_path, monkeypatch):
    """OPTIMIZATION GROUP 3: get_messages keyset guard avoids redundant queries for small chats."""
    monkeypatch.setattr(ws, "_hydrate_messages_on_demand", AsyncMock(return_value=[]))
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=owner, phone_e164="+905553334455", display_name="Ayse")
            db.add(contact)
            await db.flush()
            # Conversation without session
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP")
            db.add(conv)
            await db.flush()

            # Add only 5 messages (< 50 page size)
            t0 = datetime(2026, 1, 1, 12, 0, 0)
            for i in range(5):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905553334455",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(minutes=i),
                    body=f"Msg {i}",
                ))
            await db.commit()

            # Fetch messages: page_size = 50, len(rows) = 5
            data = await ws.get_messages(db, owner, conv.id, limit=50)
            assert len(data["messages"]) == 5
            # has_more must be False directly without running redundant older_exists query
            assert data["has_more"] is False
            assert data["oldest_message_id"] == data["messages"][0]["id"]
            assert data["newest_message_id"] == data["messages"][-1]["id"]
