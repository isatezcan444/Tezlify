import pytest
import pytest_asyncio
from datetime import datetime, timezone
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
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.orchestration.messaging import serialize_message

TEST_USER = "33333333-0000-0000-0000-000000000003"
TEST_USER_HEX = "33333333000000000000000000000003"
TEST_JID = "905413749073-1589570212@g.us"
TEST_GW_SID = "00815dc9-c0cb-40b1-8d41-a2cf64674ec4"
REVOKE_WA_ID = "3A3722FDB1BAA33AB219"


async def _cleanup():
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("DELETE FROM messages WHERE user_id IN (:u, :uh)"),
            {"u": TEST_USER, "uh": TEST_USER_HEX},
        )
        await db.execute(
            text("DELETE FROM conversations WHERE user_id IN (:u, :uh)"),
            {"u": TEST_USER, "uh": TEST_USER_HEX},
        )
        await db.execute(
            text("DELETE FROM contacts WHERE user_id IN (:u, :uh)"),
            {"u": TEST_USER, "uh": TEST_USER_HEX},
        )
        await db.execute(
            text("DELETE FROM whatsapp_sessions WHERE user_id IN (:u, :uh)"),
            {"u": TEST_USER, "uh": TEST_USER_HEX},
        )
        await db.commit()


@pytest_asyncio.fixture(autouse=True)
async def setup_test_data():
    await _cleanup()
    async with AsyncSessionLocal() as db:
        sess = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=TEST_GW_SID,
            session_name="Hat Test",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(sess)
        await db.flush()

        contact = Contact(
            user_id=TEST_USER,
            phone_e164=f"jid:{TEST_JID}",
            display_name="3Hacker",
        )
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=sess.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.commit()
    yield
    await _cleanup()


@pytest.mark.asyncio
async def test_revoke_without_existing_message_creates_tombstone():
    """When a revoke arrives for a message not in DB, it must persist a tombstone and broadcast."""
    orchestrator = WhatsAppEventOrchestrator()

    event = {
        "event": "message_deleted",
        "conversation_id": TEST_JID,
        "gateway_session_id": TEST_GW_SID,
        "wa_message_id": REVOKE_WA_ID,
        "delete_type": "everyone",
        "is_revoked": True,
        "from_me": True,
    }

    async with AsyncSessionLocal() as db:
        result = await orchestrator._ingest_message_deleted(db, event)

    assert result is not None, "Revoke event must not be dropped"
    assert result.get("_skip") is None, "Revoke event must not be skipped"
    assert result["event"] == "message_deleted"
    assert result["user_id"] == TEST_USER
    assert result["wa_message_id"] == REVOKE_WA_ID
    assert result["is_revoked"] is True
    assert result["message_id"] is not None

    # Verify persistent tombstone in DB
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(Message).where(
                    Message.wa_message_id == REVOKE_WA_ID,
                    get_user_filter(Message.user_id, TEST_USER),
                )
            )
        ).scalars().first()
        assert row is not None, "Tombstone message must exist in DB"
        assert row.is_revoked is True
        assert row.body == ""
        assert row.revoked_at is not None

        # Verify conversation preview was updated
        conv = (
            await db.execute(
                select(Conversation).where(
                    Conversation.id == result["conversation_id"],
                    get_user_filter(Conversation.user_id, TEST_USER),
                )
            )
        ).scalars().first()
        assert conv.last_message_preview == "Bu mesaj silindi"


@pytest.mark.asyncio
async def test_repeated_revoke_is_idempotent():
    """Repeated revoke for the same message must not create duplicate tombstone rows."""
    orchestrator = WhatsAppEventOrchestrator()

    event = {
        "event": "message_deleted",
        "conversation_id": TEST_JID,
        "gateway_session_id": TEST_GW_SID,
        "wa_message_id": REVOKE_WA_ID,
        "delete_type": "everyone",
        "is_revoked": True,
    }

    async with AsyncSessionLocal() as db:
        res1 = await orchestrator._ingest_message_deleted(db, event)
        assert res1 is not None

    async with AsyncSessionLocal() as db:
        res2 = await orchestrator._ingest_message_deleted(db, event)
        assert res2 is not None
        assert res2["message_id"] == res1["message_id"]

    # Verify only 1 row exists
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Message).where(
                    Message.wa_message_id == REVOKE_WA_ID,
                    get_user_filter(Message.user_id, TEST_USER),
                )
            )
        ).scalars().all()
        assert len(rows) == 1, "Exactly one tombstone record must exist"


@pytest.mark.asyncio
async def test_late_arriving_message_stays_revoked():
    """If original message arrives after tombstone was created, it must stay revoked."""
    orchestrator = WhatsAppEventOrchestrator()

    # 1. Revoke arrives first
    event_revoke = {
        "event": "message_deleted",
        "conversation_id": TEST_JID,
        "gateway_session_id": TEST_GW_SID,
        "wa_message_id": REVOKE_WA_ID,
        "delete_type": "everyone",
        "is_revoked": True,
    }
    async with AsyncSessionLocal() as db:
        await orchestrator._ingest_message_deleted(db, event_revoke)

    # 2. Later, message_new arrives with same wa_message_id
    event_msg = {
        "event": "message_new",
        "conversation_id": TEST_JID,
        "gateway_session_id": TEST_GW_SID,
        "message": {
            "wa_message_id": REVOKE_WA_ID,
            "conversation_id": TEST_JID,
            "body": "Late secret photo content",
            "message_type": "IMAGE",
            "media_id": "late_media_id_leak",
            "is_view_once": True,
            "direction": "INBOUND",
            "created_at": "2026-11-08T00:00:00Z",
        },
    }
    async with AsyncSessionLocal() as db:
        res_msg = await orchestrator._ingest_message(db, event_msg)

    # Verify message in DB stayed revoked and didn't leak body or media
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(Message).where(
                    Message.wa_message_id == REVOKE_WA_ID,
                    get_user_filter(Message.user_id, TEST_USER),
                )
            )
        ).scalars().first()
        assert row is not None
        assert row.is_revoked is True
        assert row.body == "", "Revoked body must remain empty"
        assert row.media_id is None, "Revoked media_id must remain None"


@pytest.mark.asyncio
async def test_serialize_message_unknown_view_once():
    """Generic unknown View Once message must serialize is_view_once=True and media_url=None."""
    msg = Message(
        id=555,
        conversation_id=1,
        user_id=TEST_USER,
        direction=MessageDirection.INBOUND,
        message_type=MessageType.UNKNOWN,
        status=ConversationMessageStatus.RECEIVED,
        body="[VIEW_ONCE_MEDIA]",
        is_view_once=True,
        created_at=datetime.now(timezone.utc),
    )
    serialized = serialize_message(msg)
    assert serialized["is_view_once"] is True
    assert serialized["message_type"] == "UNKNOWN"
    assert serialized["media_url"] is None, "Unknown View Once media_url must be None"
    assert serialized["media_id"] is None
