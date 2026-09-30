"""Phase 11.7 — WhatsApp Repositories Persistence Boundary Test Suite.

Verifies:
1. Conversation persistence repository (lookups, resolution, legacy scoping)
2. Session persistence repository (user lookup, gateway resolving, fail-closed behavior)
3. Message persistence repository (watermark, keyset pagination, time column sorting)
"""

import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import ConversationMessageStatus, Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.exceptions import EventOwnerUnresolved, NoWhatsAppSession
from backend.app.services.whatsapp.repositories.conversations import (
    find_whatsapp_conversation,
    get_conversation_by_id,
    get_conversation_scope_filters,
    resolve_conversation_jid,
)
from backend.app.services.whatsapp.repositories.messages import (
    get_message_by_id,
    get_sync_watermark_epoch,
    has_older_messages,
    hydration_cursor_ms,
    msg_time,
    msg_time_col,
    select_messages_keyset,
)
from backend.app.services.whatsapp.repositories.sessions import (
    conversation_gateway_id,
    conversation_session,
    get_session_by_id,
    get_user_sessions,
    require_user_session,
    resolve_event_owner,
    resolve_event_owner_and_session,
    resolve_event_session_id,
)


@asynccontextmanager
async def make_test_db(tmp_path, name="whatsapp_repo_test.db"):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/{name}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield sessions
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_conversation_repo_get_by_id(tmp_path):
    user_id = str(uuid.uuid4())
    other_user = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905551112233", display_name="Test Contact")
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

            # Success
            loaded = await get_conversation_by_id(db, user_id, conv.id)
            assert loaded.id == conv.id
            assert loaded.contact_id == contact.id

            # Tenant isolation
            with pytest.raises(LookupError, match="Konusma bulunamadi."):
                await get_conversation_by_id(db, other_user, conv.id)

            # Missing ID
            with pytest.raises(LookupError, match="Konusma bulunamadi."):
                await get_conversation_by_id(db, user_id, 999999)


@pytest.mark.asyncio
async def test_conversation_repo_resolve_jid(tmp_path):
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905551112233", display_name="JID Contact")
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

            c, jid = await resolve_conversation_jid(db, user_id, conv.id)
            assert c.id == conv.id
            assert jid == "905551112233@s.whatsapp.net"


@pytest.mark.asyncio
async def test_conversation_repo_find_whatsapp_conversation(tmp_path):
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905553334455", display_name="Search Contact")
            db.add(contact)
            await db.flush()

            conv = Conversation(
                user_id=user_id,
                contact_id=contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                session_id=1,
            )
            db.add(conv)
            await db.commit()

            # Found by JID
            found = await find_whatsapp_conversation(db, user_id, "905553334455@s.whatsapp.net", session_id=1)
            assert found is not None
            assert found.id == conv.id

            # Missing JID
            missing = await find_whatsapp_conversation(db, user_id, "905559999999@s.whatsapp.net", session_id=1)
            assert missing is None


@pytest.mark.asyncio
async def test_session_repo_user_sessions_and_require(tmp_path):
    user_id = str(uuid.uuid4())
    other_user = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            s1 = WhatsAppSession(
                user_id=user_id,
                gateway_id="gw-101",
                session_name="Line 1",
                status=SessionStatus.CONNECTED,
            )
            s2 = WhatsAppSession(
                user_id=user_id,
                gateway_id="gw-102",
                session_name="Line 2 (Disconnected)",
                status=SessionStatus.DISCONNECTED,
            )
            db.add_all([s1, s2])
            await db.commit()

            # Connected only
            connected = await get_user_sessions(db, user_id, connected_only=True)
            assert len(connected) == 1
            assert connected[0].gateway_id == "gw-101"

            # All
            all_sess = await get_user_sessions(db, user_id, connected_only=False)
            assert len(all_sess) == 2

            # get_session_by_id
            loaded = await get_session_by_id(db, user_id, s1.id)
            assert loaded.id == s1.id
            with pytest.raises(LookupError):
                await get_session_by_id(db, other_user, s1.id)

            # require_user_session
            req1 = await require_user_session(db, user_id, s1.id)
            assert req1.id == s1.id
            # Fallback to connected
            req_auto = await require_user_session(db, user_id, None)
            assert req_auto.id == s1.id

            # Fail closed for other user
            with pytest.raises(NoWhatsAppSession):
                await require_user_session(db, other_user, None)


@pytest.mark.asyncio
async def test_session_repo_resolve_event_owner_and_session(tmp_path):
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            s = WhatsAppSession(
                user_id=user_id,
                gateway_id="gw-uuid-42",
                session_name="Event Line",
                status=SessionStatus.CONNECTED,
            )
            db.add(s)
            await db.commit()

            owner, sess_id = await resolve_event_owner_and_session(db, "test-jid", "gw-uuid-42")
            assert owner == user_id
            assert sess_id == s.id

            sid = await resolve_event_session_id(db, "gw-uuid-42")
            assert sid == s.id

            with pytest.raises(EventOwnerUnresolved):
                await resolve_event_owner_and_session(db, "test-jid", "nonexistent-gw")


@pytest.mark.asyncio
async def test_message_repo_watermark_and_keyset(tmp_path):
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905556667788", display_name="Msg Contact")
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

            t1 = datetime(2026, 9, 17, 10, 0, 0, tzinfo=timezone.utc)
            t2 = datetime(2026, 9, 17, 10, 5, 0, tzinfo=timezone.utc)
            t3 = datetime(2026, 9, 17, 10, 10, 0, tzinfo=timezone.utc)

            m1 = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="First",
                sender_phone="+905556667788",
                recipient_phone="+905550001122",
                external_timestamp=t1,
                status=ConversationMessageStatus.DELIVERED,
            )
            m2 = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                body="Second",
                sender_phone="+905556667788",
                recipient_phone="+905550001122",
                sent_at=t2,
                status=ConversationMessageStatus.SENT,
            )
            m3 = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body="Third",
                sender_phone="+905556667788",
                recipient_phone="+905550001122",
                external_timestamp=t3,
                status=ConversationMessageStatus.READ,
            )
            db.add_all([m1, m2, m3])
            await db.commit()

            # Watermark (latest inbound is t3 - 300s)
            watermark = await get_sync_watermark_epoch(db, user_id)
            expected_watermark = int(t3.timestamp()) - 300
            assert watermark == expected_watermark

            # Keyset pagination (descending: m3, m2, m1)
            page1 = await select_messages_keyset(db, user_id, conv.id, limit=2)
            assert len(page1) == 2
            assert page1[0].id == m3.id
            assert page1[1].id == m2.id

            # Page 2 using before_row
            page2 = await select_messages_keyset(db, user_id, conv.id, limit=2, before_row=page1[-1])
            assert len(page2) == 1
            assert page2[0].id == m1.id

            # has_older_messages
            assert await has_older_messages(db, user_id, conv.id, m3) is True
            assert await has_older_messages(db, user_id, conv.id, m1) is False

            # hydration_cursor_ms
            cursor_ms = hydration_cursor_ms([m1, m2, m3])
            assert cursor_ms == int(t1.timestamp() * 1000)


@pytest.mark.asyncio
async def test_keyset_pagination_does_not_skip_or_repeat_equal_timestamps(tmp_path):
    """Messages sharing a timestamp must page through exactly once.

    A batch sent in the same second, or hydrated from a provider chunk,
    routinely shares a timestamp. If the cursor were only `time < cutoff`, every
    remaining message of that batch would be skipped or repeated depending on
    which side of the boundary the cursor fell. The query breaks the tie on id,
    and this is the case that proves it.

    Production has zero colliding timestamps in the sampled window, so this is a
    latent failure rather than an active one — which is exactly why it needs a
    test rather than an observation.
    """
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905550001122", display_name="Equal TS")
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

            # Five messages, ALL sharing one timestamp: the exact shape a
            # provider chunk or a fast burst produces.
            shared = datetime(2026, 3, 1, 12, 0, 0, tzinfo=timezone.utc)
            rows = [
                Message(
                    user_id=user_id,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body=f"same-ts-{i}",
                    sender_phone=contact.phone_e164,
                    recipient_phone="ME",
                    external_timestamp=shared,
                )
                for i in range(5)
            ]
            db.add_all(rows)
            await db.commit()
            for r in rows:
                await db.refresh(r)

            first = await select_messages_keyset(db, user_id, conv.id, limit=2)
            assert len(first) == 2
            second = await select_messages_keyset(db, user_id, conv.id, limit=2, before_row=first[-1])
            assert len(second) == 2
            third = await select_messages_keyset(db, user_id, conv.id, limit=2, before_row=second[-1])
            assert len(third) == 1

            seen = [m.id for m in first + second + third]
            assert len(seen) == len(set(seen)), "equal-timestamp rows must not repeat"
            assert set(seen) == {r.id for r in rows}, "every row must be reached exactly once"

            # The tie-break cursor must agree with the existence probe, otherwise
            # the "load older" affordance can disagree with what a page returns.
            assert await has_older_messages(db, user_id, conv.id, first[-1]) is True
            assert await has_older_messages(db, user_id, conv.id, third[-1]) is False


@pytest.mark.asyncio
async def test_stored_history_stays_reachable_with_a_full_page(tmp_path):
    """A full page with older stored rows must remain paginatable.

    This pins the contract the has_more fix restored. The regression lived in the
    service layer: when the database probe found nothing older, has_more was
    overwritten from the gateway's history evidence, and FULLY_EXHAUSTED or
    CURSOR_STALLED forced `False`. A conversation holding 66 stored rows then
    served 50 and reported no more, so the "load older" affordance never rendered
    and the remaining 16 were unreachable through the UI.

    A provider cursor stalling says nothing about rows we already persisted, so
    the database decides — and it must keep deciding across pages.
    """
    from datetime import timedelta

    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905559900011", display_name="Has More")
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

            base = datetime(2026, 3, 1, 10, 0, 0, tzinfo=timezone.utc)
            rows = [
                Message(
                    user_id=user_id,
                    conversation_id=conv.id,
                    direction=MessageDirection.INBOUND,
                    message_type=MessageType.TEXT,
                    body=f"m{i}",
                    sender_phone=contact.phone_e164,
                    recipient_phone="ME",
                    external_timestamp=base + timedelta(minutes=i),
                )
                for i in range(60)
            ]
            db.add_all(rows)
            await db.commit()
            for r in rows:
                await db.refresh(r)

            # The repository pages newest-first (msg_time DESC, id DESC). The
            # service reverses the trimmed page into chronological order before
            # serialising, which is why it reads oldest_message_id from
            # messages[0]. Mirror that ordering here, or the test would assert
            # against an ordering the service never actually uses.
            newest_first = await select_messages_keyset(db, user_id, conv.id, limit=50)
            assert len(newest_first) == 50
            page1 = list(reversed(newest_first))
            oldest = page1[0]

            # Older rows exist in OUR table, so the affordance must report them.
            assert await has_older_messages(db, user_id, conv.id, oldest) is True

            # And the older page must still be fetchable through the cursor.
            page2 = await select_messages_keyset(db, user_id, conv.id, limit=50, before_row=oldest)
            assert len(page2) == 10, "the older page must remain reachable"
            assert {m.id for m in page2}.isdisjoint({m.id for m in page1}), \
                "pages must not overlap or repeat messages"
            assert len(page1) + len(page2) == 60, "paging must cover every row once"

            # Nothing older than the oldest row of the last page. The repository
            # returns newest-first, so the last page's oldest row is its LAST
            # element, not the first.
            oldest_of_page2 = list(reversed(page2))[0]
            assert await has_older_messages(db, user_id, conv.id, oldest_of_page2) is False


def test_resolve_has_more_ignores_provider_exhaustion():
    """Provider exhaustion must never hide history we already store.

    The production bug: a conversation with 66 stored rows served 50 and
    reported no more, so the "load older messages" affordance never rendered and
    the remaining 16 were unreachable through the UI. The gateway's history
    evidence said FULLY_EXHAUSTED and the service believed it over its own
    database.

    A provider cursor stalling says nothing about rows we persisted, so the
    database probe stays authoritative.
    """
    from backend.app.services.whatsapp_service import resolve_has_more

    exhausted = {
        "state": "FULLY_EXHAUSTED",
        "provider_checked": True,
        "provider_exhausted": True,
        "provider_msgs_returned": 0,
    }
    stalled = {
        "state": "CURSOR_STALLED",
        "provider_checked": True,
        "provider_exhausted": True,
        "provider_msgs_returned": 0,
    }

    # The database found older rows: that wins, whatever the gateway claims.
    for ev in (exhausted, stalled):
        assert resolve_has_more(
            db_has_more=True, page_size=50, rows_returned=50, evidence=ev
        ) is True, "stored history must stay reachable"

    # A full page with nothing older locally: the provider might still hold
    # something we never stored, so keep the affordance.
    assert resolve_has_more(
        db_has_more=False, page_size=50, rows_returned=50, evidence=exhausted
    ) is True

    # Nothing older locally and a partial page: genuinely the end of history.
    assert resolve_has_more(
        db_has_more=False, page_size=50, rows_returned=10, evidence=exhausted
    ) is False

    # A provider that FAILED has not proven anything about completeness. Treating
    # a timeout as exhaustion would hide the affordance and strand the user on a
    # partial thread that is merely unverified, which is the same lie as before
    # pointed the other way.
    for ev in (
        {"state": "TIMEOUT", "provider_checked": True, "provider_exhausted": False},
        {"state": "PROVIDER_ERROR", "provider_checked": True, "provider_exhausted": False},
        {"state": "NOT_CHECKED", "provider_checked": False, "provider_exhausted": False},
    ):
        assert resolve_has_more(
            db_has_more=False, page_size=50, rows_returned=10, evidence=ev
        ) is True, "an unanswered provider must not claim completeness"

    # The old implementation would have returned False for the first case, and
    # that single line is why 16 messages became unreachable in production.
    assert resolve_has_more(
        db_has_more=True, page_size=50, rows_returned=50, evidence=exhausted
    ) is not False
