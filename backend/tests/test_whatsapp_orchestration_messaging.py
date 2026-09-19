"""Characterization tests for WhatsApp Messaging Orchestration (Phase 11.9).

Verifies outbound message dispatch, serialization, media proxying, typing presence,
and conversation read status updates with fail-closed transaction guarantees.
"""
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp.orchestration.messaging import (
    WhatsAppMessagingOrchestrator,
    get_media_bytes,
    mark_conversation_read,
    send_media_message,
    send_text_message,
    send_typing,
    serialize_message,
)
from backend.app.services.whatsapp.exceptions import WhatsAppRelinkRequired
from backend.app.services import whatsapp_service


class TestWhatsAppMessagingOrchestration:
    """Test suite for WhatsApp messaging orchestration layer."""

    def test_serialize_message_structure(self):
        row = Message(
            id=42,
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            status=ConversationMessageStatus.SENT,
            body="Hello world",
            media_id=None,
            media_mime_type=None,
            media_filename=None,
            media_caption=None,
            wa_message_id="wa_msg_123",
            client_message_id="client_uuid_456",
            sender_phone="ME",
            sender_name="Sender",
            recipient_phone="+905551234567",
            error_message=None,
            external_timestamp=datetime(2026, 9, 17, 12, 0, 0),
        )
        serialized = serialize_message(row)
        assert serialized["id"] == 42
        assert serialized["conversation_id"] == 10
        assert serialized["direction"] == "OUTBOUND"
        assert serialized["message_type"] == "TEXT"
        assert serialized["status"] == "SENT"
        assert serialized["body"] == "Hello world"
        assert serialized["media_url"] is None
        assert serialized["wa_message_id"] == "wa_msg_123"
        assert serialized["client_message_id"] == "client_uuid_456"
        assert serialized["created_at"] == "2026-09-17T12:00:00"

    def test_serialize_message_with_media_url(self):
        row = Message(
            id=43,
            conversation_id=10,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.IMAGE,
            status=ConversationMessageStatus.DELIVERED,
            body="An image",
            media_id="med_789",
            media_mime_type="image/jpeg",
            media_filename="photo.jpg",
            media_caption="Caption",
            wa_message_id="wa_43",
            client_message_id=None,
            sender_phone="+905551234567",
            sender_name="Client",
            recipient_phone="ME",
            error_message=None,
            external_timestamp=datetime(2026, 9, 17, 12, 5, 0),
        )
        serialized = serialize_message(row)
        assert serialized["media_url"] == "/api/v1/whatsapp/media/med_789"
        assert serialized["media_filename"] == "photo.jpg"

    @pytest.mark.asyncio
    async def test_send_text_message_empty_body_raises(self):
        db = AsyncMock()
        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(MagicMock(), "90555@s.whatsapp.net")):
            with pytest.raises(LookupError, match="Mesaj bos olamaz"):
                await send_text_message(db, "usr-1", 10, "   ")

    @pytest.mark.asyncio
    async def test_send_text_message_idempotent_duplicate_client_id(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        existing_msg = Message(
            id=101,
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Existing message",
            client_message_id="client-dup-123",
            status=ConversationMessageStatus.SENT,
        )
        db.scalar.return_value = existing_msg
        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()):
                res = await send_text_message(db, "usr-1", 10, "Existing message", client_message_id="client-dup-123")
                assert res["id"] == 101
                assert res["client_message_id"] == "client-dup-123"
                # Should not call gateway or add new row
                db.add.assert_not_called()

    @pytest.mark.asyncio
    async def test_send_text_message_success_flow(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.last_message_at = None
        db.scalar.return_value = None  # No duplicate
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row):
                with patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", return_value={"wa_message_id": "wa_new_1", "status": "sent"}):
                    res = await send_text_message(db, "usr-1", 10, "Test message", client_message_id="client-new-1")
                    assert res["body"] == "Test message"
                    assert res["client_message_id"] == "client-new-1"
                    assert res["status"] == "SENT"
                    assert db.add.called
                    assert db.commit.called

    @pytest.mark.asyncio
    async def test_send_text_message_group_advances_to_sent_immediately(self):
        """Group chats never receive aggregate delivery receipts; dispatch advances to SENT immediately."""
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 11
        conv.is_group = True
        conv.last_message_at = None
        db.scalar.return_value = None
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "12345-67890@g.us")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row):
                # Even if gateway returns PENDING, group dispatch forces SENT
                with patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", return_value={"wa_message_id": "wa_grp_1", "status": "PENDING"}):
                    res = await send_text_message(db, "usr-1", 11, "Group test message", client_message_id="client-grp-1")
                    assert res["body"] == "Group test message"
                    assert res["status"] == "SENT"
                    assert res["wa_message_id"] == "wa_grp_1"

    @pytest.mark.asyncio
    async def test_send_text_message_gateway_failure_marks_failed(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.last_message_at = None
        db.scalar.return_value = None
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row):
                with patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", side_effect=RuntimeError("Gateway timeout")):
                    with pytest.raises(RuntimeError, match="Gateway timeout"):
                        await send_text_message(db, "usr-1", 10, "Fail test", client_message_id="client-fail-1")
                    # Must have called commit to persist PENDING and commit to persist FAILED
                    assert db.commit.call_count >= 2

    @pytest.mark.asyncio
    async def test_send_media_message_success_flow(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.last_message_at = None
        db.scalar.return_value = None
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        media_payload = {
            "media_type": "image",
            "filename": "photo.png",
            "caption": "My photo",
            "media_url": "https://example.com/photo.png",
        }
        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row):
                with patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", return_value={"wa_message_id": "wa_media_1", "status": "sent"}):
                    res = await send_media_message(db, "usr-1", 10, media_payload)
                    assert res["message_type"] == "IMAGE"
                    assert res["media_caption"] == "My photo"
                    assert db.add.called
                    assert db.commit.called

    @pytest.mark.asyncio
    async def test_mark_conversation_read_success(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.last_message_at = None
        conv.unread_count = 3
        conv.last_read_at = None

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()):
                with patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", return_value={"success": True}):
                    res = await mark_conversation_read(db, "usr-1", 10)
                    assert res["success"] is True
                    assert conv.unread_count == 0
                    assert conv.last_read_at is not None
                    assert db.commit.called

    @pytest.mark.asyncio
    async def test_mark_conversation_read_relink_required_truthfulness(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.last_message_at = None
        conv.unread_count = 2
        conv.last_read_at = None

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()):
                with patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", side_effect=WhatsAppRelinkRequired("Relink needed")):
                    res = await mark_conversation_read(db, "usr-1", 10)
                    assert res["success"] is False
                    assert res["error"] == "WHATSAPP_AUTH_RELINK_REQUIRED"
                    # §11 truthfulness: the provider never received the read, so
                    # the local record must NOT claim the chat was read. A local
                    # "read" for a receipt that was never delivered is a silent
                    # lie, and it also suppressed the honest reconnect snapshot.
                    assert conv.unread_count == 2
                    assert conv.last_read_at is None

    @pytest.mark.asyncio
    async def test_send_typing_success(self):
        db = AsyncMock()
        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(MagicMock(), "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()):
                with patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", return_value={"success": True}):
                    res = await send_typing(db, "usr-1", 10, typing=True)
                    assert res["success"] is True

    @pytest.mark.asyncio
    async def test_get_media_bytes_not_found(self):
        db = AsyncMock()
        exec_mock = MagicMock()
        exec_mock.scalars().first.return_value = None
        db.execute.return_value = exec_mock

        with pytest.raises(LookupError, match="Medya bulunamadi"):
            await get_media_bytes(db, "usr-1", "med-missing")

    @pytest.mark.asyncio
    async def test_facade_delegation_parity(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.last_message_at = None
        db.scalar.return_value = None
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        with patch("backend.app.services.whatsapp_service._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp_service._conversation_session", return_value=session_row):
                with patch("backend.app.services.whatsapp_service._gateway_op_or_mark_relink", return_value={"wa_message_id": "wa_facade_1", "status": "sent"}):
                    # Calling through facade
                    res = await whatsapp_service.send_text_message(db, "usr-1", 10, "Facade message")
                    assert res["body"] == "Facade message"
                    assert res["wa_message_id"] == "wa_facade_1"

