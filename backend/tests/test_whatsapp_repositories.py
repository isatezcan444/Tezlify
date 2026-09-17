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
async def test_build_message_from_gateway_and_exists(tmp_path):
    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905559990011", display_name="Factory Contact")
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

            gw_msg = {
                "conversation_id": "905559990011@s.whatsapp.net",
                "wa_message_id": "WAMID_TEST_999",
                "direction": "INBOUND",
                "message_type": "TEXT",
                "body": "Hello from gateway",
                "sender_phone": "+905559990011",
                "sender_name": "Ahmet",
                "created_at": "2026-09-17T12:00:00Z",
                "status": "DELIVERED",
            }
            from backend.app.services.whatsapp.repositories.messages import (
                build_message_from_gateway,
                message_exists_by_wa_id,
            )

            msg_row = build_message_from_gateway(user_id, conv, gw_msg)
            assert msg_row is not None
            assert msg_row.body == "Hello from gateway"
            assert msg_row.wa_message_id == "WAMID_TEST_999"
            assert msg_row.direction == MessageDirection.INBOUND
            assert msg_row.conversation_id == conv.id

            # Before inserting, exists should be False
            exists_before = await message_exists_by_wa_id(db, conv.id, "WAMID_TEST_999")
            assert exists_before is False

            db.add(msg_row)
            await db.commit()

            # After inserting, exists should be True
            exists_after = await message_exists_by_wa_id(db, conv.id, "WAMID_TEST_999")
            assert exists_after is True


@pytest.mark.asyncio
async def test_contact_and_conversation_entity_helpers(tmp_path):
    from backend.app.services.whatsapp.repositories.contacts import (
        get_contact_avatar,
        get_contact_by_phone,
        set_contact_avatar,
        set_contact_name,
    )
    from backend.app.services.whatsapp.repositories.conversations import (
        apply_conversation_last_message,
        create_conversation_entity,
    )

    user_id = str(uuid.uuid4())
    async with make_test_db(tmp_path) as sessions:
        async with sessions() as db:
            contact = Contact(user_id=user_id, phone_e164="+905558887766", display_name="+905558887766")
            db.add(contact)
            await db.flush()

            # set_contact_avatar & get_contact_avatar
            assert get_contact_avatar(contact) is None
            set_contact_avatar(contact, "https://example.com/avatar.jpg")
            assert get_contact_avatar(contact) == "https://example.com/avatar.jpg"

            # set_contact_name
            changed = set_contact_name(contact, "Mehmet Bey", "addressbook")
            assert changed is True
            assert contact.display_name == "Mehmet Bey"

            # Lower rank (pushName) cannot override addressbook
            changed_lower = set_contact_name(contact, "Mehmet Push", "push")
            assert changed_lower is False
            assert contact.display_name == "Mehmet Bey"

            await db.commit()

            # get_contact_by_phone
            found_contact = await get_contact_by_phone(db, user_id, "+905558887766")
            assert found_contact is not None
            assert found_contact.id == contact.id

            missing_contact = await get_contact_by_phone(db, user_id, "+905550000000")
            assert missing_contact is None

            # create_conversation_entity
            conv_entity = create_conversation_entity(
                user_id=user_id,
                contact_id=contact.id,
                session_id=1,
                preview="Welcome",
                is_group=False,
            )
            assert conv_entity.channel == "WHATSAPP"
            assert conv_entity.last_message_preview == "Welcome"
            assert conv_entity.is_group is False

            # apply_conversation_last_message
            t1 = datetime(2026, 9, 17, 10, 0, 0, tzinfo=timezone.utc)
            t0 = datetime(2026, 9, 17, 9, 0, 0, tzinfo=timezone.utc)
            applied = apply_conversation_last_message(conv_entity, t1, "Newer summary")
            assert applied is True
            assert conv_entity.last_message_preview == "Newer summary"

            # Older message cannot overwrite newer summary
            applied_older = apply_conversation_last_message(conv_entity, t0, "Older summary")
            assert applied_older is False
            assert conv_entity.last_message_preview == "Newer summary"


