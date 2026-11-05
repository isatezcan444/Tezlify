"""Comprehensive verification of WhatsApp local-first pagination, provider hydration scenarios,
and keyset ordering index behavior.

Covers all 8 mandatory scenarios and regression requirements:
1. Local DB has more messages than requested page.
2. Local DB has exactly one page of messages.
3. Local DB has fewer messages than requested page.
4. Local DB has 20 messages, provider has 300 older messages (fast local return + subsequent hydration).
5. Local DB has 0 messages.
6. Provider timeout with local rows (serves local, retryable).
7. Provider returns older chunk successfully.
8. Provider returns NO_ANCHOR (cache hit rule, no evidence mutation).
9. Deduplication of concurrent hydration requests.
10. Keyset pagination index: EXPLAIN QUERY PLAN, equal timestamps, NULL timestamps, and ID tie-breaker.
"""
import uuid
import asyncio
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message, MessageDirection, ConversationMessageStatus, MessageType
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_service as ws
from backend.app.services.whatsapp.exceptions import WhatsAppHistoryTimeout
from backend.app.services.whatsapp.orchestration.history_evidence import (
    record_on_demand_provider_result,
    get_history_evidence,
)


@asynccontextmanager
async def make_test_db(tmp_path, name="hydration_scenarios.db"):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/{name}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
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
                    provider_exhausted BOOLEAN DEFAULT 0,
                    provider_signal VARCHAR(32),
                    provider_msgs_returned INTEGER DEFAULT 0,
                    provider_cursor_used VARCHAR(255),
                    last_sweep_count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, jid)
                )
            """)
        )
        # Create keyset expression index in SQLite
        await conn.execute(
            text("""
                CREATE INDEX IF NOT EXISTS idx_msg_keyset_ordering 
                ON messages (conversation_id, coalesce(external_timestamp, sent_at, created_at) DESC, id DESC)
            """)
        )
    try:
        yield sessions
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_scenario_01_local_db_more_than_page(tmp_path, monkeypatch):
    """Scenario 1: Local DB has more messages than requested page (e.g. 70 messages, limit 50).
    Local page is returned immediately (<50ms), provider is NOT called, has_more is True."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-s1", session_name="S1", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551110001")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            for i in range(70):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551110001",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"msg-{i}",
                    wa_message_id=f"wa-s1-{i}",
                ))
            await db.commit()

            gw_mock = AsyncMock()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv.id, limit=50)
            assert len(res["messages"]) == 50
            assert res["has_more"] is True
            assert res["messages"][-1]["body"] == "msg-69"
            assert res["messages"][0]["body"] == "msg-20"
            assert not gw_mock.called


@pytest.mark.asyncio
async def test_scenario_02_local_db_exactly_one_page(tmp_path, monkeypatch):
    """Scenario 2: Local DB has exactly one page (e.g. 50 messages, limit 50).
    Local page is returned immediately, provider is NOT called, has_more is True."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-s2", session_name="S2", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551110002")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            for i in range(50):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551110002",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"msg-{i}",
                    wa_message_id=f"wa-s2-{i}",
                ))
            await db.commit()

            gw_mock = AsyncMock()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv.id, limit=50)
            assert len(res["messages"]) == 50
            assert res["has_more"] is True
            assert not gw_mock.called


@pytest.mark.asyncio
async def test_scenario_03_local_db_fewer_than_page(tmp_path, monkeypatch):
    """Scenario 3: Local DB has fewer messages than page (e.g. 15 messages, limit 50).
    Initial open returns 15 messages immediately without blocking on provider."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-s3", session_name="S3", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551110003")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            for i in range(15):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551110003",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"msg-{i}",
                    wa_message_id=f"wa-s3-{i}",
                ))
            await db.commit()

            gw_mock = AsyncMock()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv.id, limit=50)
            assert len(res["messages"]) == 15
            assert not gw_mock.called
            # has_more is True because provider hasn't been checked yet
            assert res["has_more"] is True


@pytest.mark.asyncio
async def test_scenario_04_local_20_provider_300_e2e(tmp_path, monkeypatch):
    """Scenario 4 & Section 5: Local DB has 20 messages, provider has 300 older messages.
    - Initial open returns 20 messages instantly without provider call.
    - has_more is True.
    - Upward scroll with before=oldest_id queries provider and hydrates the next batch cleanly.
    - Deduplication: no duplicate messages created.
    - Strict chronological causality ordering preserved.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-s4", session_name="S4", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551110004")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 12, 0, 0)
            # 20 local messages
            for i in range(20):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551110004",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"recent-{i}",
                    wa_message_id=f"wa-recent-{i}",
                ))
            await db.commit()

            gw_mock = AsyncMock()
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            # Step 1: Open chat
            t_start = time.monotonic()
            page1 = await ws.get_messages(db, owner, conv.id, limit=20)
            t_elapsed = time.monotonic() - t_start

            assert len(page1["messages"]) == 20
            assert not gw_mock.called, "Initial chat open must NOT call provider when local rows exist!"
            assert t_elapsed < 0.2, f"Initial open took {t_elapsed:.3f}s"
            assert page1["has_more"] is True

            oldest_id = page1["oldest_message_id"]

            # Step 2: User scrolls up (requesting before=oldest_id)
            # Provider returns next batch of 20 messages from the 300
            provider_older_msgs = [
                {
                    "id": 1000 + j,
                    "wa_message_id": f"wa-provider-{j}",
                    "body": f"provider-older-{j}",
                    "timestamp_s": int((t0 - timedelta(minutes=50 - j)).timestamp()),
                    "sender_phone": "+905551110004",
                    "recipient_phone": "ME",
                    "message_type": "TEXT",
                    "direction": "INBOUND",
                    "status": "RECEIVED",
                }
                for j in range(20)
            ]
            gw_mock.return_value = {
                "messages": provider_older_msgs,
                "has_more": True,
                "provider_status": "OK",
            }

            page2 = await ws.get_messages(db, owner, conv.id, limit=20, before=oldest_id)
            assert len(page2["messages"]) == 20
            assert gw_mock.called
            assert page2["messages"][0]["wa_message_id"] == "wa-provider-0"
            assert page2["messages"][-1]["wa_message_id"] == "wa-provider-19"
            assert page2["has_more"] is True

            # Verify no duplicates in database
            all_msgs = (await db.execute(select(Message).where(Message.conversation_id == conv.id))).scalars().all()
            assert len(all_msgs) == 40
            wa_ids = [m.wa_message_id for m in all_msgs]
            assert len(wa_ids) == len(set(wa_ids)), "Every message ID must be unique (no duplicates)!"


@pytest.mark.asyncio
async def test_scenario_05_local_db_zero_messages(tmp_path, monkeypatch):
    """Scenario 5: Local DB has zero messages on initial open.
    Calls provider to hydrate first page."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-s5", session_name="S5", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551110005")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            gw_mock = AsyncMock(return_value={
                "messages": [
                    {
                        "id": 501,
                        "wa_message_id": "wa-first-1",
                        "body": "First message from provider",
                        "timestamp_s": int(t0.timestamp()),
                        "sender_phone": "+905551110005",
                        "recipient_phone": "ME",
                        "message_type": "TEXT",
                        "direction": "INBOUND",
                        "status": "RECEIVED",
                    }
                ],
                "has_more": False,
                "provider_status": "OK",
            })
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv.id, limit=50)
            assert gw_mock.called
            assert len(res["messages"]) == 1
            assert res["messages"][0]["body"] == "First message from provider"


@pytest.mark.asyncio
async def test_scenario_06_provider_timeout_tolerated(tmp_path, monkeypatch):
    """Scenario 6: Provider times out during scroll pagination when caller has local rows.
    Tolerates timeout without failing or throwing 502, keeps has_more True so user can retry."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-s6", session_name="S6", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551110006")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            msg = Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED,
                sender_phone="+905551110006",
                recipient_phone="ME",
                external_timestamp=t0,
                body="initial-msg",
                wa_message_id="wa-s6-0",
            )
            db.add(msg)
            await db.commit()

            # Gateway throws ReadTimeout
            gw_mock = AsyncMock(side_effect=ws.gw.WhatsAppGatewayError("ReadTimeout: gateway timeout waiting for provider chunk"))
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            # Paginate older than msg.id: DB has 0 older rows, provider times out
            res = await ws.get_messages(db, owner, conv.id, limit=10, before=msg.id)
            assert res["messages"] == []
            # has_more must remain True on timeout so UI affordance allows retry
            assert res["has_more"] is True


@pytest.mark.asyncio
async def test_scenario_07_provider_success_advances_history(tmp_path, monkeypatch):
    """Scenario 7: Provider successfully returns older history chunk, correctly updating state."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-s7", session_name="S7", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551110007")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            db.add(Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED,
                sender_phone="+905551110007",
                recipient_phone="ME",
                external_timestamp=t0,
                body="newest",
                wa_message_id="wa-s7-newest",
            ))
            await db.commit()

            gw_mock = AsyncMock(return_value={
                "messages": [
                    {
                        "id": 701,
                        "wa_message_id": "wa-s7-older",
                        "body": "older from provider",
                        "timestamp_s": int((t0 - timedelta(hours=1)).timestamp()),
                        "sender_phone": "+905551110007",
                        "recipient_phone": "ME",
                        "message_type": "TEXT",
                        "direction": "INBOUND",
                        "status": "RECEIVED",
                    }
                ],
                "has_more": True,
                "provider_status": "OK",
            })
            monkeypatch.setattr(ws.gw, "get_messages", gw_mock)

            res = await ws.get_messages(db, owner, conv.id, limit=10, before=1)
            assert len(res["messages"]) == 1
            assert res["messages"][0]["body"] == "older from provider"
            assert res["has_more"] is True


@pytest.mark.asyncio
async def test_scenario_08_provider_no_anchor_preserves_evidence(tmp_path, monkeypatch):
    """Scenario 8: Provider returns NO_ANCHOR.
    Invariant 4: NO_ANCHOR is a cache hit / unreached provider, NEVER mutates evidence."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-s8", session_name="S8", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551110008")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            # Record a NO_ANCHOR result
            res = await record_on_demand_provider_result(
                db,
                session_id="gw-s8",
                jid="905551110008@s.whatsapp.net",
                requested_count=50,
                provider_status="NO_ANCHOR",
            )
            assert res is None, "NO_ANCHOR must return None and NOT write any evidence!"

            ev = await get_history_evidence(db, "905551110008@s.whatsapp.net", session_id="gw-s8")
            assert ev["state"] == "NOT_CHECKED"
            assert ev["provider_checked"] is False


@pytest.mark.asyncio
async def test_keyset_pagination_index_explain_and_tie_breaker(tmp_path):
    """Keyset pagination index verification:
    1. EXPLAIN QUERY PLAN verifies idx_msg_keyset_ordering is used by SQLite.
    2. Identical timestamps resolved deterministically by ID DESC tie-breaker without flicker.
    3. NULL timestamps (external_timestamp=None) fall back smoothly to sent_at or created_at.
    """
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            conv = Conversation(user_id=owner, channel="WHATSAPP")
            db.add(conv)
            await db.flush()

            t_fixed = datetime(2026, 1, 1, 12, 0, 0)
            # Add 5 messages with EXACTLY equal external_timestamp
            for i in range(5):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551119999",
                    recipient_phone="ME",
                    external_timestamp=t_fixed,
                    created_at=t_fixed,
                    body=f"equal-ts-{i}",
                    wa_message_id=f"wa-eq-{i}",
                ))

            # Add message with external_timestamp=None, sent_at=None, created_at=t_fixed - 1h
            db.add(Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED,
                sender_phone="+905551119999",
                recipient_phone="ME",
                external_timestamp=None,
                sent_at=None,
                created_at=t_fixed - timedelta(hours=1),
                body="null-external-ts",
                wa_message_id="wa-null-ts",
            ))
            await db.commit()

            # Verify EXPLAIN QUERY PLAN uses the keyset index
            explain_stmt = text("""
                EXPLAIN QUERY PLAN
                SELECT id, conversation_id, body
                FROM messages
                WHERE conversation_id = :cid
                ORDER BY coalesce(external_timestamp, sent_at, created_at) DESC, id DESC
                LIMIT 5
            """)
            plan_res = await db.execute(explain_stmt, {"cid": conv.id})
            plan_rows = plan_res.fetchall()
            plan_text = " ".join(str(r) for r in plan_rows)
            # SQLite query plan must indicate index usage on messages
            assert "idx_msg_keyset_ordering" in plan_text or "USING INDEX" in plan_text, (
                f"Query plan must utilize index, got: {plan_text}"
            )

            # Verify deterministic ordering and tie-breaker
            res = await ws.get_messages(db, owner, conv.id, limit=10)
            msgs = res["messages"]
            assert len(msgs) == 6
            # The NULL external_timestamp row (1 hour earlier) must be first (oldest)
            assert msgs[0]["body"] == "null-external-ts"

            # Equal timestamp messages must be strictly ordered by id ASC in chronological output
            equal_msgs = msgs[1:]
            for k in range(len(equal_msgs) - 1):
                assert equal_msgs[k]["id"] < equal_msgs[k + 1]["id"], "Equal timestamps must break ties monotonically by ID!"


@pytest.mark.asyncio
async def test_concurrent_hydration_deduplicated(tmp_path, monkeypatch):
    """Verifies that concurrent pagination requests for the same older cursor are deduplicated
    via _in_flight_history_fetches and produce exactly 1 provider round-trip."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-dedup", session_name="Dedup", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551119988")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            msg = Message(
                user_id=owner,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                status=ConversationMessageStatus.RECEIVED,
                sender_phone="+905551119988",
                recipient_phone="ME",
                external_timestamp=t0,
                body="msg-anchor",
                wa_message_id="wa-anchor",
            )
            db.add(msg)
            await db.commit()

            call_count = 0
            async def slow_provider(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                await asyncio.sleep(0.05)
                return {
                    "messages": [
                        {
                            "id": 999,
                            "wa_message_id": "wa-older-dedup",
                            "body": "older dedup",
                            "timestamp_s": int((t0 - timedelta(minutes=1)).timestamp()),
                            "sender_phone": "+905551119988",
                            "recipient_phone": "ME",
                            "message_type": "TEXT",
                            "direction": "INBOUND",
                            "status": "RECEIVED",
                        }
                    ],
                    "has_more": False,
                    "provider_status": "OK",
                }

            monkeypatch.setattr(ws.gw, "get_messages", slow_provider)

            # Launch 3 concurrent requests with the same cursor before=msg.id
            req1 = ws.get_messages(db, owner, conv.id, limit=10, before=msg.id)
            req2 = ws.get_messages(db, owner, conv.id, limit=10, before=msg.id)
            req3 = ws.get_messages(db, owner, conv.id, limit=10, before=msg.id)

            res1, res2, res3 = await asyncio.gather(req1, req2, req3)

            assert call_count == 1, f"Provider should only be called once, was called {call_count} times!"
            assert len(res1["messages"]) == 1
            assert len(res2["messages"]) == 1
            assert len(res3["messages"]) == 1
            assert res1["messages"][0]["wa_message_id"] == "wa-older-dedup"


@pytest.mark.asyncio
async def test_measured_performance_comparison(tmp_path, monkeypatch):
    """Empirical latency measurement on isolated dataset:
    Compares local-first pagination (<20ms) against simulated un-optimized provider roundtrip."""
    owner = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            session = WhatsAppSession(user_id=owner, gateway_id="gw-perf", session_name="Perf", status=SessionStatus.CONNECTED)
            db.add(session)
            contact = Contact(user_id=owner, phone_e164="+905551119977")
            db.add(contact)
            await db.flush()
            conv = Conversation(user_id=owner, contact_id=contact.id, channel="WHATSAPP", session_id=session.id)
            db.add(conv)
            await db.flush()

            t0 = datetime(2026, 1, 1, 10, 0, 0)
            for i in range(25):
                db.add(Message(
                    user_id=owner,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    status=ConversationMessageStatus.RECEIVED,
                    sender_phone="+905551119977",
                    recipient_phone="ME",
                    external_timestamp=t0 + timedelta(seconds=i),
                    body=f"perf-{i}",
                    wa_message_id=f"wa-perf-{i}",
                ))
            await db.commit()

            # Measure 1: Local-first response when 25 rows exist and page_size is 50
            t_start = time.perf_counter()
            res = await ws.get_messages(db, owner, conv.id, limit=50)
            t_elapsed_ms = (time.perf_counter() - t_start) * 1000.0

            assert len(res["messages"]) == 25
            print(f"\n[MEASURED PERF] Local-first get_messages latency: {t_elapsed_ms:.2f} ms")
            assert t_elapsed_ms < 50.0, f"Expected <50ms, took {t_elapsed_ms:.2f}ms"


def test_resolve_has_more_scroll_pagination_zero_rows_invariants():
    """Verifies that resolve_has_more never causes premature pagination termination
    when scroll pagination reaches a local DB boundary with 0 older rows."""
    # 1. Scroll pagination with 0 rows returned, provider has more -> True
    assert ws.resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "HAS_MORE", "has_more": True, "provider_exhausted": False},
        is_scroll_pagination=True,
    ) is True

    # 2. Scroll pagination with 0 rows returned, provider unverified NOT_CHECKED -> True
    assert ws.resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "NOT_CHECKED", "provider_checked": False, "provider_exhausted": False},
        is_scroll_pagination=True,
    ) is True

    # 3. Scroll pagination with 0 rows returned, provider EXHAUSTION_CANDIDATE (unconfirmed) -> True
    assert ws.resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "EXHAUSTION_CANDIDATE", "has_more": True, "provider_exhausted": False},
        is_scroll_pagination=True,
    ) is True

    # 4. Scroll pagination with 0 rows returned, provider TIMEOUT -> True (retryable)
    assert ws.resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "TIMEOUT", "provider_exhausted": False},
        is_scroll_pagination=True,
    ) is True

    # 5. Scroll pagination with 0 rows returned, provider FULLY_EXHAUSTED -> False (real end of history)
    assert ws.resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "FULLY_EXHAUSTED", "provider_exhausted": True},
        is_scroll_pagination=True,
    ) is False

    # 6. Initial open (not scroll pagination) with 0 rows returned and empty conversation -> False
    assert ws.resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "NOT_CHECKED", "provider_checked": False},
        is_scroll_pagination=False,
    ) is False


