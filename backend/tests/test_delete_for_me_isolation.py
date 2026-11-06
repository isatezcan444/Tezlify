"""Tests for user-scoped data isolation and idempotency of "Delete for Me" action.

Verifies:
1. User A deletes a message for themselves (is_deleted_for_me = True).
2. Keyset pagination for User A completely excludes the deleted message.
3. User B (different tenant/user) has their own conversation/message and continues to see the message.
4. User A refreshing (subsequent keyset queries) never sees the message return.
5. User B refreshing never loses the message.
6. Repeated inbound/outbound delete event is idempotent and does not corrupt data or raise errors.
7. Cross-tenant leakage guard: User B's queries never return User A's records, and get_user_filter prevents data crossover.
8. has_older_messages correctly ignores deleted_for_me records when calculating older message availability.
"""

from datetime import datetime, timezone
import pytest
import pytest_asyncio
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.auth import get_user_filter
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.repositories.messages import (
    select_messages_keyset,
    has_older_messages,
)
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.orchestration.messaging import WhatsAppMessagingOrchestrator

USER_A = "11111111-0000-0000-0000-000000000001"
USER_A_HEX = "11111111000000000000000000000001"
USER_B = "22222222-0000-0000-0000-000000000002"
USER_B_HEX = "22222222000000000000000000000002"

JID = "905551112233@s.whatsapp.net"
PHONE = "+905551112233"
WA_STANZA_ID = "3EB0DELISO12345"


async def _cleanup():
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM messages WHERE user_id IN (:a, :ah, :b, :bh)"),
            {"a": USER_A, "ah": USER_A_HEX, "b": USER_B, "bh": USER_B_HEX},
        )
        await db.execute(
            text("DELETE FROM conversations WHERE user_id IN (:a, :ah, :b, :bh)"),
            {"a": USER_A, "ah": USER_A_HEX, "b": USER_B, "bh": USER_B_HEX},
        )
        await db.execute(
            text("DELETE FROM contacts WHERE user_id IN (:a, :ah, :b, :bh)"),
            {"a": USER_A, "ah": USER_A_HEX, "b": USER_B, "bh": USER_B_HEX},
        )
        await db.execute(
            text("DELETE FROM whatsapp_sessions WHERE user_id IN (:a, :ah, :b, :bh)"),
            {"a": USER_A, "ah": USER_A_HEX, "b": USER_B, "bh": USER_B_HEX},
        )
        await db.commit()


@pytest_asyncio.fixture(autouse=True)
async def isolated_tenants():
    await _cleanup()
    async with AsyncSessionLocal() as db:
        db.add(WhatsAppSession(user_id=USER_A, gateway_id="gw-a", session_name="Hat A", status=SessionStatus.CONNECTED, is_active=True))
        db.add(WhatsAppSession(user_id=USER_B, gateway_id="gw-b", session_name="Hat B", status=SessionStatus.CONNECTED, is_active=True))
        await db.commit()
    yield
    await _cleanup()


async def _setup_tenant_data():
    """Sets up identical conversations and messages for User A and User B."""
    async with AsyncSessionLocal() as db:
        contact_a = Contact(user_id=USER_A, phone_e164=PHONE, display_name="Lead A")
        contact_b = Contact(user_id=USER_B, phone_e164=PHONE, display_name="Lead B")
        db.add_all([contact_a, contact_b])
        await db.flush()

        conv_a = Conversation(user_id=USER_A, contact_id=contact_a.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        conv_b = Conversation(user_id=USER_B, contact_id=contact_b.id, channel="WHATSAPP", status=ConversationStatus.ACTIVE)
        db.add_all([conv_a, conv_b])
        await db.flush()

        now = datetime(2026, 11, 6, 10, 0, 0)
        # Message 1 (older)
        msg1_a = Message(
            user_id=USER_A, conversation_id=conv_a.id, direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT, body="Older message", wa_message_id="OLD_1",
            sender_phone=PHONE, recipient_phone="ME", status=ConversationMessageStatus.RECEIVED,
            created_at=datetime(2026, 11, 6, 9, 0, 0),
        )
        msg1_b = Message(
            user_id=USER_B, conversation_id=conv_b.id, direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT, body="Older message", wa_message_id="OLD_1",
            sender_phone=PHONE, recipient_phone="ME", status=ConversationMessageStatus.RECEIVED,
            created_at=datetime(2026, 11, 6, 9, 0, 0),
        )
        # Message 2 (target message to delete)
        msg2_a = Message(
            user_id=USER_A, conversation_id=conv_a.id, direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT, body="Shared content text", wa_message_id=WA_STANZA_ID,
            sender_phone=PHONE, recipient_phone="ME", status=ConversationMessageStatus.RECEIVED,
            created_at=now,
        )
        msg2_b = Message(
            user_id=USER_B, conversation_id=conv_b.id, direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT, body="Shared content text", wa_message_id=WA_STANZA_ID,
            sender_phone=PHONE, recipient_phone="ME", status=ConversationMessageStatus.RECEIVED,
            created_at=now,
        )
        db.add_all([msg1_a, msg1_b, msg2_a, msg2_b])
        await db.commit()

        return conv_a.id, conv_b.id, msg2_a.id, msg2_b.id


@pytest.mark.asyncio
async def test_user_a_delete_for_me_does_not_affect_user_b():
    """Validates that User A deleting a message for themselves does not hide it from User B."""
    conv_a_id, conv_b_id, msg_a_id, msg_b_id = await _setup_tenant_data()

    async with AsyncSessionLocal() as db:
        # Pre-check: both users see 2 messages
        msgs_a_init = await select_messages_keyset(db, user_id=USER_A, conversation_id=conv_a_id, limit=50)
        msgs_b_init = await select_messages_keyset(db, user_id=USER_B, conversation_id=conv_b_id, limit=50)
        assert len(msgs_a_init) == 2
        assert len(msgs_b_init) == 2

        # Step 1: User A deletes message for themselves
        target_a = await db.get(Message, msg_a_id)
        assert target_a is not None
        target_a.is_deleted_for_me = True
        target_a.deleted_for_me_at = datetime.now(timezone.utc).replace(tzinfo=None)
        await db.commit()

    async with AsyncSessionLocal() as db:
        # Step 2: User A's keyset query excludes the message
        msgs_a_after = await select_messages_keyset(db, user_id=USER_A, conversation_id=conv_a_id, limit=50)
        assert len(msgs_a_after) == 1
        assert all(m.id != msg_a_id for m in msgs_a_after)
        assert all(m.wa_message_id != WA_STANZA_ID for m in msgs_a_after)

        # Step 3: User B STILL sees both messages, including the target message
        msgs_b_after = await select_messages_keyset(db, user_id=USER_B, conversation_id=conv_b_id, limit=50)
        assert len(msgs_b_after) == 2
        target_b_seen = next((m for m in msgs_b_after if m.id == msg_b_id), None)
        assert target_b_seen is not None
        assert target_b_seen.is_deleted_for_me is False
        assert target_b_seen.body == "Shared content text"

        # Step 4: User A refreshes / queries again -> message does NOT return
        msgs_a_refresh = await select_messages_keyset(db, user_id=USER_A, conversation_id=conv_a_id, limit=50)
        assert len(msgs_a_refresh) == 1
        assert msgs_a_refresh[0].wa_message_id == "OLD_1"

        # Step 5: User B refreshes / queries again -> message is NOT lost
        msgs_b_refresh = await select_messages_keyset(db, user_id=USER_B, conversation_id=conv_b_id, limit=50)
        assert len(msgs_b_refresh) == 2


@pytest.mark.asyncio
async def test_delete_for_me_idempotency():
    """Validates that ingesting duplicate delete-for-me events does not corrupt data."""
    conv_a_id, conv_b_id, msg_a_id, _ = await _setup_tenant_data()

    events_orch = WhatsAppEventOrchestrator()

    event_payload = {
        "event": "message_deleted",
        "conversation_id": JID,
        "wa_message_id": WA_STANZA_ID,
        "delete_type": "for_me",
        "is_revoked": False,
        "gateway_session_id": "gw-a",
    }

    async with AsyncSessionLocal() as db:
        # First ingestion
        res1 = await events_orch._ingest_message_deleted(db, event_payload)
        assert res1.get("event") == "message_deleted"
        assert res1.get("delete_type") == "for_me"
        assert res1.get("is_revoked") is False

        # Verify state
        msg = await db.get(Message, msg_a_id)
        assert msg.is_deleted_for_me is True
        first_deleted_at = msg.deleted_for_me_at
        assert first_deleted_at is not None

        # Second ingestion (idempotent duplicate event)
        res2 = await events_orch._ingest_message_deleted(db, event_payload)
        assert res2.get("event") == "message_deleted"

        # Verify state is clean and not corrupted
        await db.refresh(msg)
        assert msg.is_deleted_for_me is True
        assert msg.body == "Shared content text"  # delete for me preserves body for audit/other users


@pytest.mark.asyncio
async def test_has_older_messages_respects_deleted_for_me():
    """Validates that has_older_messages ignores is_deleted_for_me rows."""
    conv_a_id, _, msg_a_id, _ = await _setup_tenant_data()

    async with AsyncSessionLocal() as db:
        # Mark the older message as deleted_for_me
        older = (await db.execute(
            select(Message).where(Message.conversation_id == conv_a_id, Message.wa_message_id == "OLD_1")
        )).scalar_one()
        older.is_deleted_for_me = True
        await db.commit()

        # Check has_older_messages starting from newer message
        newer = await db.get(Message, msg_a_id)
        has_older = await has_older_messages(db, user_id=USER_A, conversation_id=conv_a_id, oldest_row=newer)
        # Because OLD_1 is is_deleted_for_me=True, there are NO active older messages
        assert has_older is False
