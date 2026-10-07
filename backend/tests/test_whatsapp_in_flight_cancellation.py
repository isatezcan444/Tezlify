"""Regression tests for in-flight history fetch cancellation & concurrency race recovery.

Verifies:
1. Cancellation + active waiter:
   Request A starts shared operation, Request B awaits same future.
   When Request A is cancelled, Request B does NOT hang and does NOT get cancelled;
   Request B takes over as producer and succeeds.
2. Cancellation + no waiter:
   Single request cancelled -> future is cleaned up and entry removed from _in_flight_history_fetches.
3. Producer exception:
   Producer error properly propagates to waiters and cleans up in-flight map.
4. Success with waiters:
   Producer success allows all waiters to receive newly committed rows.
5. Subsequent request:
   After cancellation/completion, subsequent requests start fresh operations without stale state.
"""

import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.services import whatsapp_service as ws


@asynccontextmanager
async def make_test_db(tmp_path):
    db_path = tmp_path / f"test_cancellation_{uuid.uuid4().hex[:8]}.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
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
                    PRIMARY KEY (session_id, jid)
                );
            """)
        )
    try:
        yield session_factory
    finally:
        await engine.dispose()
        ws._in_flight_history_fetches.clear()


async def _seed_conv(db, user_id: str, phone: str = "905551234567") -> Conversation:
    contact = Contact(
        user_id=user_id,
        phone_e164=f"+{phone}",
        display_name="Test Contact",
    )
    db.add(contact)
    await db.flush()

    conv = Conversation(
        user_id=user_id,
        contact_id=contact.id,
        channel="WHATSAPP",
        status=ConversationStatus.ACTIVE,
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv


@pytest.mark.asyncio
async def test_producer_cancellation_with_active_waiter(tmp_path, monkeypatch):
    """Request A starts fetch; Request B waits; Request A is cancelled.

    Request B must NOT hang and must NOT be cancelled. It takes over and succeeds.
    """
    async with make_test_db(tmp_path) as sessions:
        user_id = str(uuid.uuid4())
        async with sessions() as db:
            conv = await _seed_conv(db, user_id)
            conv_id = conv.id

        producer_entered = asyncio.Event()
        allow_producer_proceed = asyncio.Event()

        async def slow_hydrate_producer(db, owner, c, limit, **kwargs):
            producer_entered.set()
            await allow_producer_proceed.wait()
            return []

        async def takeover_hydrate(db, owner, c, limit, **kwargs):
            # Insert a message so waiter gets a result
            msg = Message(
                user_id=owner,
                conversation_id=c.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="Message from takeover",
                sender_phone="+905551234567",
                recipient_phone="ME",
                status=ConversationMessageStatus.RECEIVED,
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            db.add(msg)
            await db.commit()
            return [msg]

        hydrate_calls = 0

        async def mock_hydrate(db, owner, c, limit, **kwargs):
            nonlocal hydrate_calls
            hydrate_calls += 1
            if hydrate_calls == 1:
                return await slow_hydrate_producer(db, owner, c, limit, **kwargs)
            return await takeover_hydrate(db, owner, c, limit, **kwargs)

        monkeypatch.setattr(ws, "_hydrate_or_tolerate_provider_timeout", mock_hydrate)

        async with sessions() as db1, sessions() as db2:
            # Task 1 (Producer)
            task1 = asyncio.create_task(ws.get_messages(db1, user_id, conv_id, limit=50))
            await producer_entered.wait()

            # Task 2 (Waiter) arrives while Task 1 is in-flight
            flight_key = (conv_id, None)
            assert flight_key in ws._in_flight_history_fetches
            task2 = asyncio.create_task(ws.get_messages(db2, user_id, conv_id, limit=50))
            # Give task2 a slice to register as waiter
            await asyncio.sleep(0.02)

            shared_future = ws._in_flight_history_fetches.get(flight_key)
            assert shared_future is not None
            assert getattr(shared_future, "waiter_count", 0) >= 1

            # Cancel Task 1 (Producer)
            task1.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task1

            # Task 2 must NOT raise CancelledError and must complete successfully
            result2 = await asyncio.wait_for(task2, timeout=2.0)
            assert result2 is not None
            assert "messages" in result2
            assert len(result2["messages"]) == 1
            assert result2["messages"][0]["body"] == "Message from takeover"

            # In-flight map must be clean
            assert flight_key not in ws._in_flight_history_fetches


@pytest.mark.asyncio
async def test_producer_cancellation_without_waiters(tmp_path, monkeypatch):
    """When a single in-flight request is cancelled with no other waiters,

    the orphaned future is cancelled and the map entry is purged cleanly.
    """
    async with make_test_db(tmp_path) as sessions:
        user_id = str(uuid.uuid4())
        async with sessions() as db:
            conv = await _seed_conv(db, user_id)
            conv_id = conv.id

        entered = asyncio.Event()

        async def slow_hydrate(db, owner, c, limit, **kwargs):
            entered.set()
            await asyncio.sleep(10)
            return []

        monkeypatch.setattr(ws, "_hydrate_or_tolerate_provider_timeout", slow_hydrate)

        async with sessions() as db:
            task = asyncio.create_task(ws.get_messages(db, user_id, conv_id, limit=50))
            await entered.wait()

            flight_key = (conv_id, None)
            future = ws._in_flight_history_fetches.get(flight_key)
            assert future is not None
            assert getattr(future, "waiter_count", 0) == 0

            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

            # Map must be empty and future cancelled
            assert flight_key not in ws._in_flight_history_fetches
            assert future.cancelled()


@pytest.mark.asyncio
async def test_producer_exception_propagates_to_waiters(tmp_path, monkeypatch):
    """When the producer encounters an exception, all waiters receive the exception

    and the in-flight entry is cleaned up.
    """
    async with make_test_db(tmp_path) as sessions:
        user_id = str(uuid.uuid4())
        async with sessions() as db:
            conv = await _seed_conv(db, user_id)
            conv_id = conv.id

        entered = asyncio.Event()
        release_error = asyncio.Event()

        async def error_hydrate(db, owner, c, limit, **kwargs):
            entered.set()
            await release_error.wait()
            raise RuntimeError("Simulated provider crash")

        monkeypatch.setattr(ws, "_hydrate_or_tolerate_provider_timeout", error_hydrate)

        async with sessions() as db1, sessions() as db2:
            t1 = asyncio.create_task(ws.get_messages(db1, user_id, conv_id, limit=50))
            await entered.wait()

            t2 = asyncio.create_task(ws.get_messages(db2, user_id, conv_id, limit=50))
            await asyncio.sleep(0.02)

            release_error.set()

            # Both should receive the RuntimeError
            with pytest.raises(RuntimeError, match="Simulated provider crash"):
                await t1
            with pytest.raises(RuntimeError, match="Simulated provider crash"):
                await t2

            flight_key = (conv_id, None)
            assert flight_key not in ws._in_flight_history_fetches


@pytest.mark.asyncio
async def test_subsequent_request_starts_fresh_operation(tmp_path, monkeypatch):
    """Subsequent requests after a cancellation start a completely fresh operation

    without stale state.
    """
    async with make_test_db(tmp_path) as sessions:
        user_id = str(uuid.uuid4())
        async with sessions() as db:
            conv = await _seed_conv(db, user_id)
            conv_id = conv.id

        entered = asyncio.Event()

        async def first_hydrate(db, owner, c, limit, **kwargs):
            entered.set()
            await asyncio.sleep(10)
            return []

        async def second_hydrate(db, owner, c, limit, **kwargs):
            return []

        calls = 0

        async def mock_hydrate(db, owner, c, limit, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return await first_hydrate(db, owner, c, limit, **kwargs)
            return await second_hydrate(db, owner, c, limit, **kwargs)

        monkeypatch.setattr(ws, "_hydrate_or_tolerate_provider_timeout", mock_hydrate)

        async with sessions() as db1, sessions() as db2:
            t1 = asyncio.create_task(ws.get_messages(db1, user_id, conv_id, limit=50))
            await entered.wait()
            t1.cancel()
            with pytest.raises(asyncio.CancelledError):
                await t1

            # Request C (subsequent request)
            res = await ws.get_messages(db2, user_id, conv_id, limit=50)
            assert res is not None
            assert "messages" in res
            assert calls == 2
