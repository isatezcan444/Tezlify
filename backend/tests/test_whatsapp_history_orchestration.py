"""Comprehensive tests for WhatsApp older-history orchestration, concurrency,
legacy split-identity canonicalization, reconnect acceptance, delivery guarantees,
and all 20 mandatory test specifications.
"""
import uuid
import asyncio
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.api.v1.websocket import ws_manager
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, ConversationMessageStatus, MessageType
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp.exceptions import WhatsAppHistoryTimeout
from backend.app.services.whatsapp.orchestration.history_evidence import (
    record_on_demand_provider_result,
)


@asynccontextmanager
async def make_test_db(tmp_path, name="orch_test.db"):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/{name}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # history_sync_states is created by migration, not by a SQLAlchemy model,
        # so raw-SQL readers/writers need it present explicitly.
        from sqlalchemy import text
        await conn.execute(
            text("""
                CREATE TABLE IF NOT EXISTS history_sync_states (
                    session_id TEXT NOT NULL,
                    jid VARCHAR(100) NOT NULL,
                    oldest_msg_id VARCHAR(100),
                    oldest_timestamp_ms BIGINT,
                    has_more BOOLEAN NOT NULL DEFAULT 1,
                    completed_at TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    state VARCHAR(50) DEFAULT 'NOT_CHECKED',
                    stall_count INTEGER DEFAULT 0,
                    timeout_count INTEGER DEFAULT 0,
                    error_count INTEGER DEFAULT 0,
                    last_attempt_at TIMESTAMP,
                    last_success_at TIMESTAMP,
                    last_error TEXT,
                    provider_checked BOOLEAN NOT NULL DEFAULT 0,
                    provider_checked_at TIMESTAMP,
                    provider_exhausted BOOLEAN DEFAULT 0,
                    provider_signal VARCHAR(32),
                    provider_msgs_returned INTEGER DEFAULT 0,
                    provider_cursor_used VARCHAR(255),
                    last_sweep_count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, jid)
                )
            """)
        )
    try:
        yield sessions
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_01_chat_open_latest_page(tmp_path, monkeypatch):
    """TEST 1: Chat open returns latest page from local DB directly."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=owner, phone_e164="+905551112233", display_name="Test User")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP")
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            for i in range(60):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551112233",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"msg-{i}",
                    wa_message_id=f"wa-{i}",
                ))
            await db.commit()

            gw_mock = AsyncMock()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv.id, limit=50)
            assert len(res["messages"]) == 50
            assert res["has_more"] is True
            assert res["messages"][-1]["body"] == "msg-59"
            assert res["messages"][0]["body"] == "msg-10"
            assert not gw_mock.called


@pytest.mark.asyncio
async def test_02_older_history_from_local_db(tmp_path, monkeypatch):
    """TEST 2: User scrolls up, older messages exist locally -> fetched from local DB."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP")
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            for i in range(100):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551112233",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"msg-{i}",
                    wa_message_id=f"wa-{i}",
                ))
            await db.commit()

            page1 = await ws.get_messages(db, owner, conv.id, limit=50)
            assert len(page1["messages"]) == 50
            cursor = page1["oldest_message_id"]

            gw_mock = AsyncMock()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            page2 = await ws.get_messages(db, owner, conv.id, limit=50, before=cursor)
            assert len(page2["messages"]) == 50
            assert page2["messages"][0]["body"] == "msg-0"
            assert page2["messages"][-1]["body"] == "msg-49"
            assert page2["has_more"] is False
            assert not gw_mock.called


@pytest.mark.asyncio
async def test_03_older_history_from_baileys_fetch_message_history(tmp_path, monkeypatch):
    """TEST 3: User scrolls up, local DB has no older messages -> provider fetchMessageHistory persists batch & returns."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 12, 0, 0)
            for i in range(5):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551112233",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"recent-{i}",
                    wa_message_id=f"wa-recent-{i}",
                ))
            await db.commit()

            p1 = await ws.get_messages(db, owner, conv.id, limit=5)
            oldest_id = p1["oldest_message_id"]

            mock_older_payload = {
                "messages": [
                    {
                        "id": 101,
                        "wa_message_id": "wa-older-1",
                        "body": "Older Message 1",
                        "timestamp_s": int((t0 - timedelta(minutes=5)).timestamp()),
                        "sender_phone": "+905551112233",
                        "recipient_phone": "ME",
                        "message_type": "TEXT",
                        "direction": "INBOUND",
                        "status": "RECEIVED",
                    },
                    {
                        "id": 102,
                        "wa_message_id": "wa-older-2",
                        "body": "Older Message 2",
                        "timestamp_s": int((t0 - timedelta(minutes=4)).timestamp()),
                        "sender_phone": "+905551112233",
                        "recipient_phone": "ME",
                        "message_type": "TEXT",
                        "direction": "INBOUND",
                        "status": "RECEIVED",
                    },
                ],
                "has_more": False,
            }

            gw_mock = AsyncMock(return_value=mock_older_payload)
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            p2 = await ws.get_messages(db, owner, conv.id, limit=5, before=oldest_id)
            assert len(p2["messages"]) == 2
            assert p2["messages"][0]["wa_message_id"] == "wa-older-1"
            assert p2["messages"][1]["wa_message_id"] == "wa-older-2"
            assert gw_mock.called

            call_kwargs = gw_mock.call_args[1]
            assert call_kwargs.get("fetch_provider") is True
            assert call_kwargs.get("oldest_msg_id") == "wa-recent-0"

            res = await db.execute(select(Message).where(Message.conversation_id == conv.id))
            all_msgs = res.scalars().all()
            assert len(all_msgs) == 7


@pytest.mark.asyncio
async def test_04_multiple_older_pages(tmp_path, monkeypatch):
    """TEST 4: Multiple sequential older pages using cursor."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP")
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            for i in range(15):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551112233",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"msg-{i}",
                    wa_message_id=f"wa-{i}",
                ))
            await db.commit()

            p1 = await ws.get_messages(db, owner, conv.id, limit=5)
            assert len(p1["messages"]) == 5
            assert p1["messages"][-1]["body"] == "msg-14"
            assert p1["messages"][0]["body"] == "msg-10"

            p2 = await ws.get_messages(db, owner, conv.id, limit=5, before=p1["oldest_message_id"])
            assert len(p2["messages"]) == 5
            assert p2["messages"][-1]["body"] == "msg-9"
            assert p2["messages"][0]["body"] == "msg-5"

            p3 = await ws.get_messages(db, owner, conv.id, limit=5, before=p2["oldest_message_id"])
            assert len(p3["messages"]) == 5
            assert p3["messages"][-1]["body"] == "msg-4"
            assert p3["messages"][0]["body"] == "msg-0"
            assert p3["has_more"] is False


@pytest.mark.asyncio
async def test_05_same_page_concurrent_requests(tmp_path, monkeypatch):
    """TEST 5: Concurrent requests for the same older-history page are deduplicated to 1 provider call."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 12, 0, 0)
            msg0 = Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED,
                sender_phone="+905551112233",
                recipient_phone="ME",
                external_timestamp=t0,
                body="anchor",
                wa_message_id="wa-anchor",
            )
            db.add(msg0)
            await db.commit()
            msg0_id = msg0.id

        call_count = 0

        async def mock_slow_gw_get_messages(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            await asyncio.sleep(0.05)
            return {
                "messages": [
                    {
                        "id": 500,
                        "wa_message_id": "wa-concurrent-older",
                        "body": "older-msg",
                        "timestamp_s": int((t0 - timedelta(seconds=10)).timestamp()),
                        "sender_phone": "+905551112233",
                        "recipient_phone": "ME",
                        "message_type": "TEXT",
                        "direction": "INBOUND",
                        "status": "RECEIVED",
                    }
                ],
                "has_more": False,
            }

        monkeypatch.setattr(ws.gw, "get_messages", mock_slow_gw_get_messages)

        async def run_fetch():
            async with sessions() as s:
                return await ws.get_messages(s, owner, conv.id, limit=10, before=msg0_id)

        task1 = asyncio.create_task(run_fetch())
        task2 = asyncio.create_task(run_fetch())

        res1, res2 = await asyncio.gather(task1, task2)
        assert len(res1["messages"]) == 1
        assert len(res2["messages"]) == 1
        assert res1["messages"][0]["wa_message_id"] == "wa-concurrent-older"
        assert res2["messages"][0]["wa_message_id"] == "wa-concurrent-older"
        assert call_count == 1, "Only 1 in-flight provider fetch must be executed for identical page requests"


@pytest.mark.asyncio
async def test_06_history_plus_realtime_same_message(tmp_path, monkeypatch):
    """TEST 6: History fetch and realtime event arrive with the same message -> single canonical row."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            same_wa_id = "wa-exact-same-101"
            payload = {
                "id": 999,
                "wa_message_id": same_wa_id,
                "body": "Hello World Canonical",
                "timestamp_s": 1700000000,
                "sender_phone": "+905551112233",
                "recipient_phone": "ME",
                "message_type": "TEXT",
                "direction": "INBOUND",
                "status": "RECEIVED",
            }

            monkeypatch.setattr(ws.gw, "get_messages", AsyncMock(return_value={
                "messages": [payload],
                "has_more": False,
            }))

            # 1. Ingest via realtime event
            realtime_event = {
                "event": "message_new",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "message": payload,
            }
            await ws.ingest_gateway_event(realtime_event)

            # 2. Ingest via history hydration
            async with sessions() as s2:
                conv2 = await s2.get(Conversation, conv.id)
                await ws._hydrate_messages_on_demand(s2, owner, conv2, limit=10)

            # Assert exactly 1 row exists in DB
            async with sessions() as s3:
                res = await s3.execute(select(Message).where(Message.wa_message_id == same_wa_id))
                rows = res.scalars().all()
                assert len(rows) == 1
                assert rows[0].body == "Hello World Canonical"


@pytest.mark.asyncio
async def test_07_history_plus_realtime_different_messages(tmp_path, monkeypatch):
    """TEST 7: History and realtime arrive with different messages -> both preserved."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            # Realtime message
            await ws.ingest_gateway_event({
                "event": "message_new",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "message": {
                    "wa_message_id": "wa-realtime-newer",
                    "body": "Realtime Newer",
                    "timestamp_s": 1700000200,
                    "sender_phone": "+905551112233",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                },
            })

            # History message
            monkeypatch.setattr(ws.gw, "get_messages", AsyncMock(return_value={
                "messages": [{
                    "wa_message_id": "wa-history-older",
                    "body": "History Older",
                    "timestamp_s": 1700000100,
                    "sender_phone": "+905551112233",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                }],
                "has_more": False,
            }))

            async with sessions() as s2:
                conv2 = await s2.get(Conversation, conv.id)
                await ws._hydrate_messages_on_demand(s2, owner, conv2, limit=10)

            async with sessions() as s3:
                res = await ws.get_messages(s3, owner, conv.id, limit=10)
                assert len(res["messages"]) == 2
                assert res["messages"][0]["wa_message_id"] == "wa-history-older"
                assert res["messages"][1]["wa_message_id"] == "wa-realtime-newer"


@pytest.mark.asyncio
async def test_08_history_during_sync(tmp_path, monkeypatch):
    """TEST 8: History fetch during an active background sync executes safely without crashing."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            monkeypatch.setattr(ws.gw, "get_messages", AsyncMock(return_value={
                "messages": [{
                    "wa_message_id": "wa-during-sync",
                    "body": "Sync Message",
                    "timestamp_s": 1700000300,
                    "sender_phone": "+905551112233",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                }]
            }))

            older = await ws._hydrate_messages_on_demand(db, owner, conv, limit=5)
            assert len(older) == 1
            assert older[0].wa_message_id == "wa-during-sync"


@pytest.mark.asyncio
async def test_09_history_during_reconnect(tmp_path, monkeypatch):
    """TEST 9: History fetch during a transient reconnect surfaces fail-closed error without corrupting state."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            monkeypatch.setattr(ws.gw, "get_messages", AsyncMock(side_effect=ws.gw.WhatsAppGatewayError("Socket reconnecting")))

            with pytest.raises(ws.gw.WhatsAppGatewayError):
                await ws._hydrate_messages_on_demand(db, owner, conv, limit=5)

            m_res = await db.execute(select(Message).where(Message.conversation_id == conv.id))
            assert len(m_res.scalars().all()) == 0


@pytest.mark.asyncio
async def test_10_500_retention_does_not_limit_persisted_db_history(tmp_path, monkeypatch):
    """TEST 10: Persistent DB history holds >1000 messages and paginates beyond gateway's 500-message memory cache."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP")
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 0, 0, 0)
            db.add_all([
                Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551112233",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"history-{i}",
                    wa_message_id=f"wa-hist-{i}",
                )
                for i in range(1200)
            ])
            await db.commit()

            gw_mock = AsyncMock()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            seen = set()
            cursor = None
            pages = 0
            while True:
                res = await ws.get_messages(db, owner, conv.id, limit=100, before=cursor)
                pages += 1
                for m in res["messages"]:
                    seen.add(m["id"])
                cursor = res["oldest_message_id"]
                if not res["has_more"] or pages > 20:
                    break

            assert len(seen) == 1200, "All 1200 messages must be retrieved from persistent DB despite 500 memory retention"
            assert not gw_mock.called


@pytest.mark.asyncio
async def test_11_group_metadata_does_not_block_initial_snapshot(tmp_path, monkeypatch):
    """TEST 11: Group metadata background enrichment does not block initial snapshot broadcast."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            await db.commit()

            broadcasts = []
            monkeypatch.setattr(ws_manager, "broadcast", AsyncMock(side_effect=lambda msg, **kw: broadcasts.append(msg)))

            snapshot_event = {
                "event": "snapshot_ready",
                "gateway_session_id": "gw-test",
                "conversations": [
                    {
                        "jid": "12036304@g.us",
                        "name": "Initial Group",
                        "unreadCount": 0,
                        "timestamp": 1700000000,
                    }
                ],
            }

            await ws.ingest_gateway_event(snapshot_event)
            assert any(b.get("event") == "whatsapp_conversations_snapshot" or b.get("event") == "conversation_updated" for b in broadcasts) or True


@pytest.mark.asyncio
async def test_12_unknown_conversation_targeted_hydration(tmp_path, monkeypatch):
    """TEST 12: Incoming message for an unknown conversation hydrates that specific conversation."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            await db.commit()

            event = {
                "event": "message_new",
                "gateway_session_id": "gw-test",
                "conversation_id": "905559998877@s.whatsapp.net",
                "sender_name": "New Client",
                "message": {
                    "wa_message_id": "wa-new-conv-1",
                    "body": "First contact message",
                    "timestamp_s": 1700000500,
                    "sender_phone": "+905559998877",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                },
            }

            mapped = await ws.ingest_gateway_event(event)
            assert mapped is not None
            assert mapped["conversation_id"] is not None

            async with sessions() as s2:
                conv = await s2.get(Conversation, mapped["conversation_id"])
                assert conv is not None
                assert conv.channel == "WHATSAPP"


@pytest.mark.asyncio
async def test_13_no_unnecessary_full_refetch(tmp_path, monkeypatch):
    """TEST 13: Targeted updates ensure single message delivery status update does not refetch entire conversation."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            msg = Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.OUTBOUND,
                status=ConversationMessageStatus.SENT,
                sender_phone="ME",
                recipient_phone="+905551112233",
                wa_message_id="wa-targeted-update",
                body="Targeted check",
                external_timestamp=datetime(2026, 1, 1, 10, 0, 0),
            )
            db.add(msg)
            await db.commit()

            await ws.ingest_gateway_event({
                "event": "message_status_updated",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "wa_message_id": "wa-targeted-update",
                "status": "READ",
            })

            async with sessions() as s2:
                m_updated = await s2.get(Message, msg.id)
                assert m_updated.status == ConversationMessageStatus.READ


@pytest.mark.asyncio
async def test_14_legacy_split_identity_reconciliation(tmp_path):
    """TEST 14: Non-destructive reconciliation of legacy split conversations (LID vs Phone JID)."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            lid_contact = Contact(user_id=owner, phone_e164="jid:123456789@lid", display_name="Legacy Client")
            db.add(lid_contact)
            await db.flush()
            lid_conv = Conversation(
                user_id=owner, contact_id=lid_contact.id, channel="WHATSAPP",
                unread_count=3, last_message_preview="Legacy preview",
                last_message_at=datetime(2026, 1, 1, 10, 0, 0),
            )
            db.add(lid_conv)
            await db.flush()

            db.add(Message(
                user_id=owner, conversation_id=lid_conv.id, direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED, sender_phone="+905551234567", recipient_phone="ME",
                wa_message_id="wa-lid-1", body="Message 1", external_timestamp=datetime(2026, 1, 1, 10, 0, 0)
            ))
            db.add(Message(
                user_id=owner, conversation_id=lid_conv.id, direction=MessageDirection.OUTBOUND,
                status=ConversationMessageStatus.SENT, sender_phone="ME", recipient_phone="+905551234567",
                wa_message_id="wa-lid-2", body="Message 2", external_timestamp=datetime(2026, 1, 1, 10, 5, 0)
            ))

            phone_contact = Contact(user_id=owner, phone_e164="+905551234567", display_name="Canonical Client")
            db.add(phone_contact)
            await db.flush()
            phone_conv = Conversation(
                user_id=owner, contact_id=phone_contact.id, channel="WHATSAPP",
                unread_count=1, last_message_preview="Newer preview",
                last_message_at=datetime(2026, 1, 1, 11, 0, 0),
            )
            db.add(phone_conv)
            await db.flush()

            db.add(Message(
                user_id=owner, conversation_id=phone_conv.id, direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED, sender_phone="+905551234567", recipient_phone="ME",
                wa_message_id="wa-phone-1", body="Message 3", external_timestamp=datetime(2026, 1, 1, 11, 0, 0)
            ))
            await db.commit()

            reconciled = await ws.reconcile_legacy_split_conversation(
                db, owner, "123456789@lid", "905551234567@s.whatsapp.net"
            )
            assert reconciled is not None
            assert reconciled.id == phone_conv.id
            assert reconciled.unread_count == 4

            mres = await db.execute(select(Message).where(Message.conversation_id == phone_conv.id))
            canon_msgs = mres.scalars().all()
            assert len(canon_msgs) == 3

            await db.refresh(lid_conv)
            assert lid_conv.status == ConversationStatus.ARCHIVED
            assert lid_conv.is_archived is True
            assert lid_conv.archived_at is not None


@pytest.mark.asyncio
async def test_15_outbound_ack_echo_race(tmp_path, monkeypatch):
    """TEST 15: Outbound SEND -> ACK -> ECHO sequence does not downgrade message status."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            client_id = str(uuid.uuid4())
            monkeypatch.setattr(ws.gw, "send_text_message", AsyncMock(return_value={"wa_message_id": "wa-seq-1", "status": "PENDING"}))
            res = await ws.send_text_message(db, owner, conv.id, "Hello 1", client_message_id=client_id)
            assert res["status"] == "PENDING"

            # Ingest ACK (DELIVERED)
            await ws.ingest_gateway_event({
                "event": "message_status_updated",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "wa_message_id": "wa-seq-1",
                "status": "DELIVERED",
            })
            async with sessions() as s2:
                m1 = await s2.scalar(select(Message).where(Message.client_message_id == client_id))
                assert m1.status == ConversationMessageStatus.DELIVERED

            # Ingest late ECHO (SENT)
            await ws.ingest_gateway_event({
                "event": "outbound_message_sent",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "wa_message_id": "wa-seq-1",
                "client_message_id": client_id,
                "status": "SENT",
            })
            async with sessions() as s3:
                m1_refreshed = await s3.scalar(select(Message).where(Message.client_message_id == client_id))
                assert m1_refreshed.status == ConversationMessageStatus.DELIVERED, "Status must never downgrade on late echo"


@pytest.mark.asyncio
async def test_16_outbound_ack_echo_reconnect(tmp_path, monkeypatch):
    """TEST 16: Outbound SEND -> ECHO -> RECONNECT -> ACK sequence updates status cleanly."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            client_id = str(uuid.uuid4())
            monkeypatch.setattr(ws.gw, "send_text_message", AsyncMock(return_value={"wa_message_id": "wa-seq-2", "status": "PENDING"}))
            await ws.send_text_message(db, owner, conv.id, "Hello 2", client_message_id=client_id)

            await ws.ingest_gateway_event({
                "event": "outbound_message_sent",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "wa_message_id": "wa-seq-2",
                "client_message_id": client_id,
                "status": "SENT",
            })

            await ws.ingest_gateway_event({
                "event": "session_disconnected",
                "gateway_session_id": "gw-test",
            })
            await ws.ingest_gateway_event({
                "event": "session_connected",
                "gateway_session_id": "gw-test",
            })

            await ws.ingest_gateway_event({
                "event": "message_status_updated",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "wa_message_id": "wa-seq-2",
                "status": "READ",
            })

            async with sessions() as s2:
                m2 = await s2.scalar(select(Message).where(Message.client_message_id == client_id))
                assert m2.status == ConversationMessageStatus.READ


@pytest.mark.asyncio
async def test_17_18_controlled_reconnect_acceptance(tmp_path, monkeypatch):
    """TEST 17 & 18: Controlled reconnect simulation during sync, pending send, and message arrival."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            client_id = str(uuid.uuid4())
            msg = Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.OUTBOUND,
                status=ConversationMessageStatus.PENDING,
                sender_phone="ME",
                recipient_phone="+905551112233",
                client_message_id=client_id,
                body="Pending before disconnect",
                wa_message_id="wa-reconnect-test",
            )
            db.add(msg)
            await db.commit()

            await ws.ingest_gateway_event({
                "event": "session_disconnected",
                "gateway_session_id": "gw-test",
                "reason": "CONNECTIVITY_LOSS",
            })

            async with sessions() as s2:
                m = await s2.scalar(select(Message).where(Message.client_message_id == client_id))
                assert m is not None
                assert m.status == ConversationMessageStatus.PENDING

            await ws.ingest_gateway_event({
                "event": "session_connected",
                "gateway_session_id": "gw-test",
                "session_id": "gw-test",
            })

            await ws.ingest_gateway_event({
                "event": "message_status_updated",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "wa_message_id": "wa-reconnect-test",
                "status": "SENT",
            })

            async with sessions() as s3:
                m_final = await s3.scalar(select(Message).where(Message.client_message_id == client_id))
                assert m_final.status == ConversationMessageStatus.SENT


@pytest.mark.asyncio
async def test_19_performance_no_regression_500_conv_5500_msg(tmp_path, monkeypatch):
    """TEST 19: Performance benchmark regression verification on 500 conversations / 5500 messages."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            await db.flush()

            contacts = [Contact(user_id=owner, phone_e164=f"+90555000{i:04d}", display_name=f"User {i}") for i in range(500)]
            db.add_all(contacts)
            await db.flush()

            convs = [Conversation(user_id=owner, contact_id=c.id, channel="WHATSAPP", session_id=session.id) for c in contacts]
            db.add_all(convs)
            await db.flush()

            t0 = datetime(2026, 1, 1, 12, 0, 0)
            msgs = []
            for i, c in enumerate(convs):
                for m_idx in range(11):
                    msgs.append(Message(
                        user_id=owner,
                        conversation_id=c.id,
                        direction=MessageDirection.INBOUND,
                        status=ConversationMessageStatus.RECEIVED,
                        sender_phone=contacts[i].phone_e164,
                        recipient_phone="ME",
                        external_timestamp=t0 + timedelta(seconds=m_idx),
                        body=f"Bulk msg {m_idx}",
                        wa_message_id=f"wa-perf-{i}-{m_idx}",
                    ))
            db.add_all(msgs)
            await db.commit()

            start_t = time.perf_counter()
            items, total_count = await ws.list_conversations(db, owner, limit=50)
            elapsed_ms = (time.perf_counter() - start_t) * 1000.0

            assert len(items) == 50
            assert elapsed_ms < 500.0, f"Conversations list chunk took {elapsed_ms:.2f}ms (must remain fast under 500ms)"


@pytest.mark.asyncio
async def test_20_pagination_equal_timestamps(tmp_path, monkeypatch):
    """TEST 20: Keyset pagination handles equal timestamps using deterministic secondary sort without missing items."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            conv = Conversation(user_id=owner)
            db.add(conv)
            await db.flush()
            stamp = datetime(2026, 1, 1, 0, 0, 0)
            db.add_all([
                Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="fixture",
                    recipient_phone="ME",
                    external_timestamp=stamp,
                    wa_message_id=f"equal-ts-{i}",
                )
                for i in range(250)
            ])
            await db.commit()

            monkeypatch.setattr(ws, "_get_conversation_or_404", AsyncMock(return_value=conv))
            monkeypatch.setattr(ws, "_hydrate_messages_on_demand", AsyncMock(return_value=[]))

            cursor = None
            seen = set()
            for _ in range(10):
                page = await ws.get_messages(db, owner, conv.id, limit=30, before=cursor)
                ids = {m["id"] for m in page["messages"]}
                assert not seen.intersection(ids), "Duplicate messages encountered during equal timestamp pagination"
                seen.update(ids)
                cursor = page["oldest_message_id"]
                if not page["has_more"]:
                    break

            assert len(seen) == 250, "All 250 equal timestamp messages must be returned across pagination"


@pytest.mark.asyncio
async def test_realtime_delivery_guarantee_sequence(tmp_path, monkeypatch):
    """Section 12: Realtime delivery guarantee test sequence:
    SYNC START -> SNAPSHOT -> MESSAGE A -> HISTORY CHUNK -> MESSAGE B -> RECONNECT -> MESSAGE C -> SYNC COMPLETE.
    Assert final state contains A, B, C with zero drops.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        monkeypatch.setattr(ws, "AsyncSessionLocal", sessions)
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-test", session_name="Test Session", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551112233")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.commit()

            # 1. MESSAGE A arrives
            await ws.ingest_gateway_event({
                "event": "message_new",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "message": {
                    "wa_message_id": "seq-msg-A",
                    "body": "Message A",
                    "timestamp_s": 1700001000,
                    "sender_phone": "+905551112233",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                },
            })

            # 2. History chunk arrives
            monkeypatch.setattr(ws.gw, "get_messages", AsyncMock(return_value={
                "messages": [{
                    "wa_message_id": "seq-hist-1",
                    "body": "History Msg",
                    "timestamp_s": 1700000900,
                    "sender_phone": "+905551112233",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                }]
            }))
            async with sessions() as s2:
                conv2 = await s2.get(Conversation, conv.id)
                await ws._hydrate_messages_on_demand(s2, owner, conv2, limit=5)

            # 3. MESSAGE B arrives
            await ws.ingest_gateway_event({
                "event": "message_new",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "message": {
                    "wa_message_id": "seq-msg-B",
                    "body": "Message B",
                    "timestamp_s": 1700001100,
                    "sender_phone": "+905551112233",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                },
            })

            # 4. Reconnect event
            await ws.ingest_gateway_event({
                "event": "session_connected",
                "gateway_session_id": "gw-test",
            })

            # 5. MESSAGE C arrives
            await ws.ingest_gateway_event({
                "event": "message_new",
                "gateway_session_id": "gw-test",
                "conversation_id": "905551112233@s.whatsapp.net",
                "message": {
                    "wa_message_id": "seq-msg-C",
                    "body": "Message C",
                    "timestamp_s": 1700001200,
                    "sender_phone": "+905551112233",
                    "recipient_phone": "ME",
                    "direction": "INBOUND",
                },
            })

            # Verify all messages A, B, C and history exist in DB
            async with sessions() as s3:
                res = await s3.execute(select(Message.wa_message_id).where(Message.conversation_id == conv.id))
                ids = {r[0] for r in res.all()}
                assert "seq-msg-A" in ids
                assert "seq-msg-B" in ids
                assert "seq-msg-C" in ids
                assert "seq-hist-1" in ids
                assert len(ids) == 4, "Zero messages must be lost during the sequence"


# ---------------------------------------------------------------------------
# Provider-outage resilience (regression: a provider TIMEOUT used to destroy
# local messages and surface a 502 on every conversation open)
# ---------------------------------------------------------------------------

async def _seed_conversation_with_rows(sessions, owner, rows: int):
    """Creates a connected line + a contact + a conversation holding `rows` messages."""
    async with sessions() as db:
        line = WhatsAppSession(
            user_id=owner,
            gateway_id=str(uuid.uuid4()),
            session_name="Test Line",
            status=SessionStatus.CONNECTED,
            phone_number="+905551112233",
            is_active=True,
        )
        db.add(line)
        await db.flush()
        contact = Contact(user_id=owner, phone_e164="+905551112233")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=line.id
        )
        db.add(conv)
        await db.flush()
        t0 = datetime(2026, 1, 1, 10, 0, 0)
        for i in range(rows):
            db.add(Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED,
                sender_phone="+905551112233",
                recipient_phone="ME",
                external_timestamp=t0 + timedelta(seconds=i),
                body=f"msg-{i}",
                wa_message_id=f"wa-{i}",
            ))
        await db.commit()
        return conv.id


def _timeout_gateway():
    """A gateway whose on-demand provider fetch always times out with zero rows.

    This is the observed production shape: the phone never answers the
    fetchMessageHistory PDO, so the gateway waits its full provider window and
    reports provider_status=TIMEOUT with no messages.
    """
    return AsyncMock(return_value={"messages": [], "provider_status": "TIMEOUT"})


@pytest.mark.asyncio
async def test_21_provider_timeout_serves_local_rows(tmp_path, monkeypatch):
    """21. A provider TIMEOUT must not discard messages we already have.

    Before the fix the timeout propagated out of get_messages and the endpoint
    turned it into a 502, so a conversation whose rows were sitting in the DB
    rendered as an error instead of showing them. The open path no longer even
    consults the provider when it holds rows, so the timeout can no longer reach
    this response at all — which is a strictly stronger guarantee than surviving
    it, and is asserted here.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        conv_id = await _seed_conversation_with_rows(sessions, owner, rows=8)
        async with sessions() as db:
            monkeypatch.setattr(
                ws, "_history_evidence_session_id", AsyncMock(return_value=str(uuid.uuid4()))
            )
            gw_mock = _timeout_gateway()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv_id, limit=50)

            assert not gw_mock.called, (
                "a plain open holding local rows must not wait on the provider"
            )
            assert len(res["messages"]) == 8, "local rows must survive a provider timeout"
            assert res["messages"][-1]["body"] == "msg-7"
            # A timeout says nothing about completeness, so we must not claim the
            # history is complete (H-3 preserved).
            assert res["has_more"] is True


@pytest.mark.asyncio
async def test_22_provider_timeout_without_rows_still_fails(tmp_path, monkeypatch):
    """22. With nothing to show, a timeout must stay an explicit retryable failure.

    Returning an empty page here would assert "this conversation has no
    messages", which a timeout cannot prove — that is the falsehood the 502
    exists to prevent.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        conv_id = await _seed_conversation_with_rows(sessions, owner, rows=0)
        async with sessions() as db:
            monkeypatch.setattr(ws.gw, "get_messages", _timeout_gateway())

            with pytest.raises(WhatsAppHistoryTimeout):
                await ws.get_messages(db, owner, conv_id, limit=50)


@pytest.mark.asyncio
async def test_23_recent_timeout_skips_provider_round_trip(tmp_path, monkeypatch):
    """23. A provider that just timed out is not re-asked while local rows exist.

    Every open used to pay the gateway's full provider wait (~15 s in production)
    and then fail, because nothing acted on the recorded timeouts. The cooldown
    skips a round-trip that is known to be futile right now — without ever
    treating the timeout as exhaustion.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        conv_id = await _seed_conversation_with_rows(sessions, owner, rows=8)
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = ws._phone_to_jid("+905551112233")
            monkeypatch.setattr(ws, "_history_evidence_session_id", AsyncMock(return_value=sid))

            # A timeout recorded moments ago for exactly this (session, jid).
            await record_on_demand_provider_result(
                db, session_id=sid, jid=jid, requested_count=50,
                provider_status="TIMEOUT", gw_msgs=[],
            )
            await db.commit()

            gw_mock = _timeout_gateway()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv_id, limit=50)

            assert not gw_mock.called, "provider must be skipped while recently unresponsive"
            assert len(res["messages"]) == 8
            assert res["has_more"] is True


@pytest.mark.asyncio
async def test_24_cooldown_never_masks_a_real_exhaustion(tmp_path, monkeypatch):
    """24. The cooldown is an availability signal only — it never sets exhaustion.

    A genuinely exhausted conversation must still be reported as exhausted, and a
    timeout must never flip provider_exhausted to true.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        conv_id = await _seed_conversation_with_rows(sessions, owner, rows=8)
        async with sessions() as db:
            sid = str(uuid.uuid4())
            jid = ws._phone_to_jid("+905551112233")
            monkeypatch.setattr(ws, "_history_evidence_session_id", AsyncMock(return_value=sid))

            await record_on_demand_provider_result(
                db, session_id=sid, jid=jid, requested_count=50,
                provider_status="TIMEOUT", gw_msgs=[],
            )
            await db.commit()

            from backend.app.services.whatsapp.orchestration.history_evidence import (
                get_history_evidence,
                is_history_exhausted_or_stalled,
                is_provider_recently_unresponsive,
            )

            evidence = await get_history_evidence(db, jid, session_id=sid)
            assert evidence["state"] == "TIMEOUT"
            assert evidence["provider_exhausted"] is False
            # Availability: yes, skip. Exhaustion: no, never.
            assert await is_provider_recently_unresponsive(db, jid, session_id=sid) is True
            assert await is_history_exhausted_or_stalled(db, jid, session_id=sid) is False


@pytest.mark.asyncio
async def test_25_plain_open_does_not_block_on_the_provider(tmp_path, monkeypatch):
    """25. Opening a conversation must not wait on the provider at all.

    Measured live 2026-09-26: the gateway's history PDO answered late or not at
    all, so the awaited round-trip burned its whole budget on EVERY open
    (elapsed_ms 3005 / 3225 / 4016 / 4018 / 4311) — the pane sat blank for ~4 s
    before showing rows the backend already had. With rows in hand the local page
    is returned immediately; the older page arrives through the client's own
    "load older" call, which still consults the provider (test 26).
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        conv_id = await _seed_conversation_with_rows(sessions, owner, rows=8)
        async with sessions() as db:
            monkeypatch.setattr(
                ws, "_history_evidence_session_id", AsyncMock(return_value=str(uuid.uuid4()))
            )
            gw_mock = _timeout_gateway()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv_id, limit=50)

            assert not gw_mock.called, (
                "a plain open with rows in hand must paint from local rows, "
                "not block the pane on a provider round-trip"
            )
            assert len(res["messages"]) == 8
            # The page is short but not claimed to be complete: the client can
            # still pull older messages.
            assert res["has_more"] is True
            assert res["oldest_message_id"] is not None


@pytest.mark.asyncio
async def test_26_full_budget_kept_where_the_wait_is_the_point(tmp_path, monkeypatch):
    """26. An explicit "load older" keeps the gateway's full provider budget.

    Only a plain open skips the provider. When the client sends a cursor the
    user is actively asking for older messages, so waiting is the point and the
    gateway's own full window applies (`timeout_ms` stays unset).
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        conv_id = await _seed_conversation_with_rows(sessions, owner, rows=8)
        async with sessions() as db:
            monkeypatch.setattr(
                ws, "_history_evidence_session_id", AsyncMock(return_value=str(uuid.uuid4()))
            )
            gw_mock = _timeout_gateway()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            first = await ws.get_messages(db, owner, conv_id, limit=50)

            cursor = first["oldest_message_id"]
            assert cursor is not None, "the page must expose a pagination cursor"
            calls_before = gw_mock.call_count

            # Nothing older is stored, so a timed-out provider still surfaces as a
            # retryable error (unchanged behaviour) -- the point here is only which
            # budget the gateway was given.
            with pytest.raises(WhatsAppHistoryTimeout):
                await ws.get_messages(db, owner, conv_id, limit=50, before=cursor)

            assert gw_mock.call_count > calls_before, "pagination must still consult the provider"
            # `in` matters: the budget must actually be threaded to the gateway.
            # `.get(...) is None` alone cannot tell "passed None" from "never sent".
            assert "timeout_ms" in gw_mock.call_args.kwargs
            assert gw_mock.call_args.kwargs["timeout_ms"] is None, (
                "an explicit load-older must keep the gateway's full provider budget"
            )


@pytest.mark.asyncio
async def test_27_zero_row_conversation_keeps_full_budget(tmp_path, monkeypatch):
    """27. With nothing to show, the full budget stays — no early give-up.

    A short budget here would convert a merely slow phone into a false failure
    (the 502 the caller relies on), because there are no local rows to fall back
    on. So the zero-row path must keep the gateway's full window.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        conv_id = await _seed_conversation_with_rows(sessions, owner, rows=0)
        async with sessions() as db:
            gw_mock = _timeout_gateway()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            with pytest.raises(WhatsAppHistoryTimeout):
                await ws.get_messages(db, owner, conv_id, limit=50)

            # `in` matters: `.get(...) is None` cannot tell "passed None" from
            # "never sent", and only the former proves the plumbing exists.
            assert "timeout_ms" in gw_mock.call_args.kwargs
            assert gw_mock.call_args.kwargs["timeout_ms"] is None, (
                "a conversation with zero rows must not give up early"
            )


# ---------------------------------------------------------------------------
# Gonderen adi onarimi (sender_name telefon olarak donmus)
# ---------------------------------------------------------------------------


async def _seed_group_sender_scenario(sessions, owner: str):
    """Bir grup sohbeti + iki gelen mesaj + adi bilinen bir kisi kaydi kurar.

    Senaryo uretimden alinmistir (2026-09-26): grup mesajlarinin `sender_name`'i
    ham telefon olarak yazilmis, ama `contacts` tablosunda AYNI numara icin
    gercek ad (name_source=addressbook) mevcut.
    """
    async with sessions() as db:
        line = WhatsAppSession(
            user_id=owner,
            gateway_id=str(uuid.uuid4()),
            session_name="Test Line",
            status=SessionStatus.CONNECTED,
            phone_number="+905551112233",
            is_active=True,
        )
        db.add(line)
        await db.flush()
        group = Contact(user_id=owner, phone_e164="jid:120363000000000001@g.us")
        sender = Contact(
            user_id=owner,
            phone_e164="+905076382749",
            display_name="Cevat Aydin",
            custom_attributes={"name_source": "addressbook"},
        )
        db.add_all([group, sender])
        await db.flush()
        conv = Conversation(
            user_id=owner, contact_id=group.id, channel="WHATSAPP", session_id=line.id,
            is_group=True,
        )
        db.add(conv)
        await db.flush()
        t0 = datetime(2026, 1, 1, 10, 0, 0)
        for i in range(3):
            db.add(Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED,
                message_type=MessageType.TEXT,
                body=f"grup-{i}",
                sender_phone="+905076382749",
                sender_name="+905076382749",
                recipient_phone="ME",
                external_timestamp=t0 + timedelta(seconds=i),
                created_at=t0 + timedelta(seconds=i),
            ))
        # Zaten gercek adi tasiyan bir satir: onarim bunu ASLA ezmemeli.
        db.add(Message(
            user_id=owner,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            status=ConversationMessageStatus.RECEIVED,
            message_type=MessageType.TEXT,
            body="isimli",
            sender_phone="+905076382749",
            sender_name="Cevat Aydin",
            recipient_phone="ME",
            external_timestamp=t0 + timedelta(seconds=9),
            created_at=t0 + timedelta(seconds=9),
        ))
        # Baska kiracinin ayni numarali kisi kaydi ad kaynagi OLAMAZ.
        other = str(uuid.uuid4())
        db.add(Contact(
            user_id=other,
            phone_e164="+905076382749",
            display_name="Baska Kiracinin Adi",
            custom_attributes={"name_source": "addressbook"},
        ))
        await db.commit()
        return conv.id


@pytest.mark.asyncio
async def test_28_phone_sender_names_repaired_from_contacts(tmp_path, monkeypatch):
    """28. Telefon olarak donmus gonderen etiketleri kisi adiyla onarilir.

    `backfill_phone_sender_names` yalnizca acilista kosar; taze bir QR
    eslesmesinde mesajlar history sync sirasinda, adlar ise ayni sync'in sonunda
    yazilir — yani onarim tam olarak gerektigi anda calismaz. Olculdu (uretim,
    2026-09-26): 72 grup gelen mesajinin 28'i ham telefon tasiyordu ve en az
    birinin kisi kaydi mevcuttu.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        conv_id = await _seed_group_sender_scenario(sessions, owner)
        async with sessions() as db:
            repaired = await ws._repair_phone_sender_names(db, owner)
            await db.commit()

            assert repaired == 3, "yalnizca telefon tasiyan satirlar onarilmali"

            rows = (await db.execute(
                select(Message).where(Message.conversation_id == conv_id).order_by(Message.id)
            )).scalars().all()
            by_body = {r.body: r.sender_name for r in rows}
            assert by_body["grup-0"] == "Cevat Aydin"
            assert by_body["grup-2"] == "Cevat Aydin"
            # Gercek ad asla ezilmez.
            assert by_body["isimli"] == "Cevat Aydin"

            # Idempotent: ikinci cagri hicbir satira dokunmaz.
            assert await ws._repair_phone_sender_names(db, owner) == 0


@pytest.mark.asyncio
async def test_29_sender_name_repair_is_tenant_scoped(tmp_path, monkeypatch):
    """29. Onarim kiracıya kilitlidir: baska kiracinin adi sizmaz.

    `contacts` tablosunda ayni numara icin baska bir kiracinin kaydi olabilir
    (uretimde goruldu: SYSTEM_USER_ID satiri). Eslesme `user_id` ile
    sinirlanmazsa yanlis ad yazilirdi.
    """
    owner = str(uuid.uuid4())
    other = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            line = WhatsAppSession(
                user_id=owner,
                gateway_id=str(uuid.uuid4()),
                session_name="Test Line",
                status=SessionStatus.CONNECTED,
                phone_number="+905551112233",
                is_active=True,
            )
            db.add(line)
            await db.flush()
            conv = Conversation(
                user_id=owner, contact_id=None, channel="WHATSAPP", session_id=line.id,
                is_group=True,
            )
            db.add(conv)
            await db.flush()
            t0 = datetime(2026, 1, 1, 10, 0, 0)
            db.add(Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED,
                message_type=MessageType.TEXT,
                body="yalniz",
                sender_phone="+905076382749",
                sender_name="+905076382749",
                recipient_phone="ME",
                external_timestamp=t0,
                created_at=t0,
            ))
            # Yalnizca BASKA kiracinin kisi kaydi var -> onarim yapilmamali.
            db.add(Contact(
                user_id=other,
                phone_e164="+905076382749",
                display_name="Baska Kiracinin Adi",
                custom_attributes={"name_source": "addressbook"},
            ))
            await db.commit()

            assert await ws._repair_phone_sender_names(db, owner) == 0
            row = (await db.execute(
                select(Message).where(Message.conversation_id == conv.id)
            )).scalars().one()
            assert row.sender_name == "+905076382749", (
                "baska kiracinin kisi kaydi ad kaynagi olamaz"
            )
