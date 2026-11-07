import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from backend.app.models.message import Message, MessageType, MessageDirection, ConversationMessageStatus
from backend.app.models.conversation import Conversation
from backend.app.models.contact import Contact
from backend.app.services.whatsapp.orchestration.messaging import (
    WhatsAppMessagingOrchestrator,
    serialize_message,
)


@pytest.mark.asyncio
async def test_serialize_message_view_once_fail_closed():
    """View Once media must never leak media_url in serialize_message."""
    msg = Message(
        id=101,
        conversation_id=1,
        user_id="user-a",
        direction=MessageDirection.INBOUND,
        message_type=MessageType.IMAGE,
        status=ConversationMessageStatus.RECEIVED,
        body="[VIEW_ONCE_PHOTO]",
        media_id="secret_media_123",
        is_view_once=True,
        created_at=datetime.now(timezone.utc),
    )
    serialized = serialize_message(msg)
    assert serialized["is_view_once"] is True
    assert serialized["media_url"] is None, "View Once media_url MUST be None"


@pytest.mark.asyncio
async def test_serialize_message_quoted_view_once_thumbnail_stripped():
    """When a message quotes a View Once message, thumbnail must be stripped."""
    msg = Message(
        id=102,
        conversation_id=1,
        user_id="user-a",
        direction=MessageDirection.OUTBOUND,
        message_type=MessageType.TEXT,
        status=ConversationMessageStatus.SENT,
        body="Nice photo!",
        quoted_message={
            "stanza_id": "VO_STANZA_1",
            "is_view_once": True,
            "thumbnail": "data:image/jpeg;base64,SHOULD_BE_STRIPPED",
            "body": "[VIEW_ONCE_PHOTO]",
            "message_type": "IMAGE",
        },
        created_at=datetime.now(timezone.utc),
    )
    serialized = serialize_message(msg)
    assert serialized["quoted_message"] is not None
    assert serialized["quoted_message"]["thumbnail"] is None, "Quoted View Once thumbnail MUST be stripped"


@pytest.mark.asyncio
async def test_serialize_message_quoted_revoked_body_stripped():
    """When a message quotes a Revoked message, body and thumbnail must be stripped."""
    msg = Message(
        id=103,
        conversation_id=1,
        user_id="user-a",
        direction=MessageDirection.OUTBOUND,
        message_type=MessageType.TEXT,
        status=ConversationMessageStatus.SENT,
        body="What was that?",
        quoted_message={
            "stanza_id": "REV_STANZA_1",
            "is_revoked": True,
            "thumbnail": "data:image/jpeg;base64,LEAK",
            "body": "Deleted secret message",
            "message_type": "TEXT",
        },
        created_at=datetime.now(timezone.utc),
    )
    serialized = serialize_message(msg)
    assert serialized["quoted_message"] is not None
    assert serialized["quoted_message"]["body"] == "", "Quoted revoked body must be empty string"
    assert serialized["quoted_message"]["thumbnail"] is None


@pytest.mark.asyncio
async def test_resolve_quoted_message_snapshot_isolation():
    """Verify tenant isolation and cross-conversation boundary enforcement."""
    orchestrator = WhatsAppMessagingOrchestrator()

    mock_db = AsyncMock()

    # Case 1: Target belongs to different conversation -> scalar returns None
    mock_db.scalar.return_value = None
    snap = await orchestrator._resolve_quoted_message_snapshot(
        mock_db,
        user_id="tenant-1",
        conversation_id=10,
        quoted_id=999,
    )
    assert snap is None, "Cross-conversation or not found target must return None"

    # Case 2: Target found normally
    target_msg = Message(
        id=50,
        conversation_id=10,
        user_id="tenant-1",
        direction=MessageDirection.INBOUND,
        message_type=MessageType.TEXT,
        body="Hello from customer",
        sender_phone="+905551112233",
        sender_name="Customer Ali",
        wa_message_id="WA_STANZA_50",
    )
    mock_db.scalar.return_value = target_msg
    snap = await orchestrator._resolve_quoted_message_snapshot(
        mock_db,
        user_id="tenant-1",
        conversation_id=10,
        quoted_id=50,
    )
    assert snap is not None
    assert snap["stanza_id"] == "WA_STANZA_50"
    assert snap["participant"] == "905551112233@s.whatsapp.net"
    assert snap["sender_name"] == "Customer Ali"
    assert snap["body"] == "Hello from customer"
    assert snap["is_view_once"] is False
    assert snap["is_revoked"] is False

    # Case 3: Target is revoked
    target_revoked = Message(
        id=51,
        conversation_id=10,
        user_id="tenant-1",
        direction=MessageDirection.INBOUND,
        message_type=MessageType.TEXT,
        body="Old text",
        is_revoked=True,
        wa_message_id="WA_STANZA_51",
    )
    mock_db.scalar.return_value = target_revoked
    snap_rev = await orchestrator._resolve_quoted_message_snapshot(
        mock_db,
        user_id="tenant-1",
        conversation_id=10,
        quoted_id=51,
    )
    assert snap_rev["is_revoked"] is True
    assert snap_rev["body"] == ""
    assert snap_rev["thumbnail"] is None

    # Case 4: Target is View Once
    target_vo = Message(
        id=52,
        conversation_id=10,
        user_id="tenant-1",
        direction=MessageDirection.INBOUND,
        message_type=MessageType.IMAGE,
        body="[VIEW_ONCE_PHOTO]",
        is_view_once=True,
        wa_message_id="WA_STANZA_52",
    )
    mock_db.scalar.side_effect = None
    mock_db.scalar.return_value = target_vo
    snap_vo = await orchestrator._resolve_quoted_message_snapshot(
        mock_db,
        user_id="tenant-1",
        conversation_id=10,
        quoted_id=52,
    )
    assert snap_vo["is_view_once"] is True
    assert snap_vo["body"] == "[VIEW_ONCE_PHOTO]"
    assert snap_vo["thumbnail"] is None

    # Case 5: Cross-conversation quote attack via quoted_wa_id belonging to conversation 99
    # First query in conversation 10 returns None, second query looks up other_conv and finds 99
    mock_db.scalar.side_effect = [None, 99]
    snap_cross = await orchestrator._resolve_quoted_message_snapshot(
        mock_db,
        user_id="tenant-1",
        conversation_id=10,
        quoted_wa_id="WA_CROSS_CONV_ATTACK",
    )
    assert snap_cross is None, "Cross-conversation quote MUST be rejected with None"


@pytest.mark.asyncio
async def test_build_message_from_gateway_view_once_read_status():
    """build_message_from_gateway properly flags view once and sets read_at if status is READ."""
    from backend.app.services.whatsapp.repositories.messages import build_message_from_gateway
    conv = Conversation(id=10, user_id="tenant-1")
    msg_data = {
        "wa_message_id": "VO_TEST_1",
        "conversation_id": "905551234567@s.whatsapp.net",
        "direction": "INBOUND",
        "message_type": "IMAGE",
        "body": "[VIEW_ONCE_PHOTO]",
        "is_view_once": True,
        "status": "READ",
        "played_timestamp": "2026-11-07T21:00:00Z",
    }
    row = build_message_from_gateway(
        "tenant-1",
        conv,
        msg_data,
    )
    assert row.is_view_once is True
    assert row.status == ConversationMessageStatus.READ
    assert row.read_at is not None
    assert row.read_at.year == 2026


@pytest.mark.asyncio
async def test_ingest_message_receipt_updated_played_timestamp():
    """_ingest_message_receipt_updated with played_timestamp advances message to READ."""
    from unittest.mock import MagicMock
    from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
    orchestrator = WhatsAppEventOrchestrator()
    mock_db = AsyncMock()

    msg_row = Message(
        id=77,
        conversation_id=10,
        user_id="tenant-1",
        direction=MessageDirection.INBOUND,
        message_type=MessageType.IMAGE,
        status=ConversationMessageStatus.RECEIVED,
        is_view_once=True,
        body="[VIEW_ONCE_PHOTO]",
        wa_message_id="VO_RECEIPT_TEST",
    )
    conv_row = Conversation(id=10, user_id="tenant-1")

    mock_result = MagicMock()
    mock_result.first.return_value = (msg_row, conv_row)
    mock_db.execute.return_value = mock_result

    with patch.object(orchestrator, "_get_helper") as mock_helper:
        async def fake_resolve(*args, **kwargs):
            return "tenant-1", "session-1"
        mock_helper.return_value = fake_resolve

        event_payload = {
            "event": "message_receipt_updated",
            "conversation_id": "905551234567@s.whatsapp.net",
            "wa_message_id": "VO_RECEIPT_TEST",
            "played_timestamp": "2026-11-07T21:15:00Z",
        }
        res = await orchestrator._ingest_message_receipt_updated(mock_db, event_payload)

    assert res["status"] == "READ"
    assert res["read_timestamp"] == "2026-11-07T21:15:00Z"
    assert msg_row.status == ConversationMessageStatus.READ
    assert msg_row.read_at is not None


