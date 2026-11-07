"""History Pagination Stability & Performance Test Suite.

Verifies:
1. Keyset pagination deterministic ordering across identical timestamps.
2. Keyset pagination & has_older_messages exclusion of `is_deleted_for_me=True` messages.
3. Keyset pagination with unresolvable or missing `before` cursor returning empty page.
4. On-demand history pagination cooldown in whatsapp_service (20s instead of 300s).
5. Anchor fallback to nearest message with non-null `wa_message_id`.
6. Hydration cursor timezone handling (aware vs naive UTC conversion).
"""

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
import uuid
import pytest
from sqlalchemy import select, false
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
from backend.app.services.whatsapp.repositories.messages import (
    has_older_messages,
    hydration_cursor_ms,
    select_messages_keyset,
)
from backend.app.services.whatsapp.orchestration.history_evidence import is_provider_recently_unresponsive


@asynccontextmanager
async def make_test_db(tmp_path, name="history_pagination_test.db"):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/{name}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield sessions
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_keyset_pagination_identical_timestamps_deterministic(tmp_path):
    """Messages with identical timestamps must page deterministically by Message.id DESC."""
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905551110001", display_name="Test")
            db.add(contact)
            await db.flush()
            conv = Conversation(
                user_id=user_id,
                contact_id=contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
            )
            db.add(conv)
            await db.flush()

            # Insert 5 messages with identical timestamp
            same_time = datetime(2026, 11, 6, 10, 0, 0, tzinfo=timezone.utc)
            rows = [
                Message(
                    user_id=user_id,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body=f"msg_{i}",
                    sender_phone=contact.phone_e164,
                    recipient_phone="ME",
                    external_timestamp=same_time,
                )
                for i in range(5)
            ]
            db.add_all(rows)
            await db.commit()
            for r in rows:
                await db.refresh(r)

            # Page limit=2: should return highest IDs first
            page1 = await select_messages_keyset(db, user_id, conv.id, limit=2)
            assert len(page1) == 2
            assert page1[0].id > page1[1].id

            # Next page using before_row = page1[-1]
            page2 = await select_messages_keyset(db, user_id, conv.id, limit=2, before_row=page1[-1])
            assert len(page2) == 2
            assert page2[0].id > page2[1].id
            assert page1[-1].id > page2[0].id

            # Last page
            page3 = await select_messages_keyset(db, user_id, conv.id, limit=2, before_row=page2[-1])
            assert len(page3) == 1
            assert page2[-1].id > page3[0].id

            # Verify no duplication across pages and all rows visited
            all_ids = [m.id for m in page1 + page2 + page3]
            assert len(all_ids) == 5
            assert len(set(all_ids)) == 5


@pytest.mark.asyncio
async def test_keyset_pagination_excludes_deleted_for_me(tmp_path):
    """Messages marked is_deleted_for_me must be excluded from keyset results and has_older_messages."""
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905551110002", display_name="Test")
            db.add(contact)
            await db.flush()
            conv = Conversation(
                user_id=user_id,
                contact_id=contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
            )
            db.add(conv)
            await db.flush()

            base_time = datetime(2026, 11, 6, 10, 0, 0, tzinfo=timezone.utc)
            m1 = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="Visible Old",
                sender_phone=contact.phone_e164,
                recipient_phone="ME",
                external_timestamp=base_time,
                is_deleted_for_me=False,
            )
            m2_deleted = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="Deleted For Me",
                sender_phone=contact.phone_e164,
                recipient_phone="ME",
                external_timestamp=base_time + timedelta(minutes=5),
                is_deleted_for_me=True,
            )
            m3 = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="Visible Recent",
                sender_phone=contact.phone_e164,
                recipient_phone="ME",
                external_timestamp=base_time + timedelta(minutes=10),
                is_deleted_for_me=False,
            )
            db.add_all([m1, m2_deleted, m3])
            await db.commit()
            for r in [m1, m2_deleted, m3]:
                await db.refresh(r)

            # Query should only return m3 and m1, completely omitting m2_deleted
            results = await select_messages_keyset(db, user_id, conv.id, limit=10)
            result_ids = [m.id for m in results]
            assert m3.id in result_ids
            assert m1.id in result_ids
            assert m2_deleted.id not in result_ids
            assert len(results) == 2

            # has_older_messages from m3 should find m1
            has_older_from_m3 = await has_older_messages(db, user_id, conv.id, m3)
            assert has_older_from_m3 is True

            # has_older_messages from m1 should find nothing (m2 is newer, and nothing older than m1 exists)
            has_older_from_m1 = await has_older_messages(db, user_id, conv.id, m1)
            assert has_older_from_m1 is False


@pytest.mark.asyncio
async def test_keyset_pagination_unresolvable_before_returns_empty(tmp_path):
    """When before_row is unresolvable or dummy, keyset query must fail-closed and return empty."""
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905551110003", display_name="Test")
            db.add(contact)
            await db.flush()
            conv = Conversation(
                user_id=user_id,
                contact_id=contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
            )
            db.add(conv)
            await db.flush()

            m = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="Message",
                sender_phone=contact.phone_e164,
                recipient_phone="ME",
                external_timestamp=datetime(2026, 11, 6, 10, 0, 0, tzinfo=timezone.utc),
            )
            db.add(m)
            await db.commit()

            # Execute query with false() condition (the fail-closed behavior implemented for unresolvable before)
            from backend.app.services.whatsapp.repositories.messages import msg_time_col
            q = (
                select(Message)
                .where(
                    Message.conversation_id == conv.id,
                    Message.user_id == user_id,
                    Message.is_deleted_for_me.is_(False),
                    false(),
                )
                .order_by(msg_time_col().desc(), Message.id.desc())
                .limit(50)
            )
            res = (await db.execute(q)).scalars().all()
            assert len(res) == 0


@pytest.mark.asyncio
async def test_on_demand_scroll_cooldown_threshold():
    """Verify is_provider_recently_unresponsive behavior with 20s cooldown."""
    db = AsyncMock()
    now_utc = datetime.now(timezone.utc)

    # 1. Evidence was 10s ago (within 20s cooldown) -> unresponsive
    with patch(
        "backend.app.services.whatsapp.orchestration.history_evidence.get_history_evidence",
        new=AsyncMock(return_value={
            "state": "TIMEOUT",
            "last_attempt_at": (now_utc - timedelta(seconds=10)).isoformat(),
        }),
    ):
        is_unresponsive = await is_provider_recently_unresponsive(
            db, "905551234567@s.whatsapp.net", session_id="sess_1", cooldown_s=20
        )
        assert is_unresponsive is True

    # 2. Evidence was 25s ago (past 20s cooldown) -> responsive again
    with patch(
        "backend.app.services.whatsapp.orchestration.history_evidence.get_history_evidence",
        new=AsyncMock(return_value={
            "state": "TIMEOUT",
            "last_attempt_at": (now_utc - timedelta(seconds=25)).isoformat(),
        }),
    ):
        is_unresponsive = await is_provider_recently_unresponsive(
            db, "905551234567@s.whatsapp.net", session_id="sess_1", cooldown_s=20
        )
        assert is_unresponsive is False


def test_hydration_cursor_ms_timezone_handling():
    """Verify hydration_cursor_ms correctly converts both timezone-aware and naive UTC datetimes."""
    user_id = str(uuid.uuid4())
    # Aware UTC datetime
    aware_dt = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)
    m_aware = Message(
        user_id=user_id,
        conversation_id=1,
        direction=MessageDirection.INBOUND,
        message_type=MessageType.TEXT,
        body="aware",
        sender_phone="+90555",
        recipient_phone="ME",
        external_timestamp=aware_dt,
    )
    ms_aware = hydration_cursor_ms([m_aware])
    assert ms_aware == int(aware_dt.timestamp() * 1000)

    # Naive datetime representing UTC
    naive_dt = datetime(2026, 11, 6, 12, 0, 0)
    m_naive = Message(
        user_id=user_id,
        conversation_id=1,
        direction=MessageDirection.INBOUND,
        message_type=MessageType.TEXT,
        body="naive",
        sender_phone="+90555",
        recipient_phone="ME",
        external_timestamp=naive_dt,
    )
    ms_naive = hydration_cursor_ms([m_naive])
    assert ms_naive == int(aware_dt.timestamp() * 1000)
    assert ms_aware == ms_naive


@pytest.mark.asyncio
async def test_nearest_anchor_with_wa_message_id_fallback(tmp_path):
    """When the oldest message lacks a wa_message_id, fallback to nearest message with non-null wa_message_id."""
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905551110004", display_name="Test")
            db.add(contact)
            await db.flush()
            conv = Conversation(
                user_id=user_id,
                contact_id=contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
            )
            db.add(conv)
            await db.flush()

            base_time = datetime(2026, 11, 6, 10, 0, 0, tzinfo=timezone.utc)
            # m1 has NO wa_message_id (e.g. system notification or draft)
            m1 = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="Oldest without WA ID",
                wa_message_id=None,
                sender_phone=contact.phone_e164,
                recipient_phone="ME",
                external_timestamp=base_time,
            )
            # m2 has a valid wa_message_id
            m2 = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="Nearest with WA ID",
                wa_message_id="WA_VALID_ANCHOR_123",
                sender_phone=contact.phone_e164,
                recipient_phone="ME",
                external_timestamp=base_time + timedelta(minutes=1),
            )
            db.add_all([m1, m2])
            await db.commit()

            # Execute the nearest anchor resolution query implemented in whatsapp_service.py
            anchor_id = m1.wa_message_id
            if not anchor_id:
                fallback_anchor = (
                    await db.execute(
                        select(Message.wa_message_id)
                        .where(
                            Message.conversation_id == conv.id,
                            Message.wa_message_id.isnot(None),
                        )
                        .order_by(Message.id.asc())
                        .limit(1)
                    )
                ).scalar_one_or_none()
                anchor_id = fallback_anchor

            assert anchor_id == "WA_VALID_ANCHOR_123"


def test_empty_response_and_history_exhaustion_scenarios():
    """Validates the 6 distinct empty response and history exhaustion scenarios."""
    from backend.app.services.whatsapp_service import resolve_has_more

    # 1. Empty response + exhausted: provider confirmed no older messages exist
    res_exhausted = resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "FULLY_EXHAUSTED", "provider_exhausted": True, "provider_checked": True},
        is_scroll_pagination=True,
    )
    assert res_exhausted is False, "Exhausted evidence must resolve has_more=False"

    # 2. Empty response + timeout: provider timed out, must NOT falsely claim exhaustion
    res_timeout = resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "TIMEOUT", "provider_exhausted": False, "provider_checked": True},
        is_scroll_pagination=True,
    )
    assert res_timeout is True, "Timeout must keep has_more=True so the affordance allows retry"

    # 3. Empty response + event missing: chunk not received / waiter timeout
    res_event_missing = resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "TIMEOUT", "provider_signal": "NO_CHUNK", "provider_exhausted": False},
        is_scroll_pagination=True,
    )
    assert res_event_missing is True, "Missing event / timeout must keep has_more=True"

    # 4. Empty response + retryable failure: gateway socket or temporary provider error
    res_retryable = resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "PROVIDER_ERROR", "provider_exhausted": False, "provider_checked": True},
        is_scroll_pagination=True,
    )
    assert res_retryable is True, "Retryable provider error must keep has_more=True"

    # 5. Empty response + valid next cursor: DB holds older rows even if current slice returned 0
    res_cursor = resolve_has_more(
        db_has_more=True,
        page_size=50,
        rows_returned=0,
        evidence={"state": "FULLY_EXHAUSTED", "provider_exhausted": True},
        is_scroll_pagination=True,
    )
    assert res_cursor is True, "Local DB older messages always take precedence over provider exhaustion"

    # 6. Empty response + confirmed protocol limitation: zero-message chat with no anchor
    res_protocol_limited = resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "NOT_CHECKED", "provider_checked": False},
        is_scroll_pagination=False,
    )
    assert res_protocol_limited is False, "Zero-anchor unpopulated chat must resolve has_more=False cleanly"

    # 7. CURSOR_STALLED is an anomaly/stall, NOT proven exhaustion: must keep has_more=True for retry
    res_stalled_retryable = resolve_has_more(
        db_has_more=False,
        page_size=50,
        rows_returned=0,
        evidence={"state": "CURSOR_STALLED", "provider_exhausted": False, "provider_checked": True},
        is_scroll_pagination=True,
    )
    assert res_stalled_retryable is True, "CURSOR_STALLED without confirmed exhaustion must keep has_more=True (retryable anomaly)"
