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
    forward_message,
    pin_message,
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
        assert serialized["is_forwarded"] is False

    def test_client_message_id_uniqueness_is_conversation_scoped(self):
        column = Message.__table__.c.client_message_id
        assert column.unique is not True
        indexes = {idx.name: idx for idx in Message.__table__.indexes}
        scoped = indexes["uq_msg_conv_client_message_id"]
        assert scoped.unique is True
        assert [col.name for col in scoped.columns] == ["conversation_id", "client_message_id"]

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

    def test_serialize_message_with_quoted_message(self):
        quoted_data = {
            "stanza_id": "orig_wa_123",
            "sender_name": "Tolga Cebeci",
            "message_type": "VIDEO",
            "body": "Video",
            "thumbnail": "data:image/jpeg;base64,abc12345",
        }
        row = Message(
            id=44,
            conversation_id=10,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            status=ConversationMessageStatus.RECEIVED,
            body="İsa bu tutar mı sence",
            quoted_message=quoted_data,
            wa_message_id="wa_44",
            sender_phone="905551234567@s.whatsapp.net",
            sender_name="Tolga Cebeci",
            recipient_phone="ME",
        )
        serialized = serialize_message(row)
        assert serialized["quoted_message"] == quoted_data
        assert serialized["quoted_message"]["message_type"] == "VIDEO"
        assert serialized["quoted_message"]["sender_name"] == "Tolga Cebeci"

    @pytest.mark.asyncio
    async def test_send_text_message_empty_body_raises(self):
        db = AsyncMock()
        # ValueError, not LookupError: the conversation WAS found, the input is
        # invalid. LookupError became a 404, so an empty composer reported the
        # conversation as missing and invited a pointless retry.
        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(MagicMock(), "90555@s.whatsapp.net")):
            with pytest.raises(ValueError, match="Mesaj bos olamaz"):
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
    async def test_pending_idempotent_retry_redispatches_same_client_id(self):
        """A message recovered to FAILED/DELIVERY_UNCONFIRMED after crash is redispatched without creating duplicate rows."""
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        recovered = Message(
            id=102,
            user_id="usr-1",
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Retry me",
            client_message_id="client-pending-1",
            status=ConversationMessageStatus.FAILED,
            error_message="DELIVERY_UNCONFIRMED: Sunucu yeniden başlatıldı",
            sender_phone="ME",
            recipient_phone="+90555",
        )
        db.scalar.return_value = recovered
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1")

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row), \
             patch(
                 "backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink",
                 return_value={"wa_message_id": "wa-retry-1", "status": "SENT"},
             ) as dispatch:
            result = await send_text_message(
                db, "usr-1", 10, "Retry me", client_message_id="client-pending-1"
            )

        dispatch.assert_awaited_once()
        assert result["status"] == "SENT"
        assert result["wa_message_id"] == "wa-retry-1"
        assert recovered.status == ConversationMessageStatus.SENT
        assert recovered.error_message is None
        db.add.assert_not_called()

    @pytest.mark.asyncio
    async def test_malformed_gateway_send_response_fails_closed(self):
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        db.scalar.return_value = None
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1")

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row), \
             patch(
                 "backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink",
                 return_value={"success": True},
             ):
            with pytest.raises(Exception, match="geçersiz gönderim yanıtı"):
                await send_text_message(
                    db, "usr-1", 10, "Do not fake success", client_message_id="client-malformed-1"
                )

        created = db.add.call_args.args[0]
        assert created.status == ConversationMessageStatus.FAILED

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
    async def test_mark_conversation_read_gateway_negative_ack_is_not_success(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.unread_count = 4
        conv.last_read_at = None

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()):
                with patch(
                    "backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink",
                    return_value={"success": False, "error": "provider read failed"},
                ):
                    res = await mark_conversation_read(db, "usr-1", 10)

        assert res == {"success": False, "error": "provider read failed"}
        assert conv.unread_count == 4
        assert conv.last_read_at is None
        db.commit.assert_not_awaited()

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

    @pytest.mark.asyncio
    async def test_forward_message_source_not_found(self):
        db = AsyncMock()
        mock_result = MagicMock()
        mock_result.first.return_value = None
        db.execute.return_value = mock_result

        with pytest.raises(LookupError, match="Mesaj #999 bulunamadı"):
            await forward_message(db, "usr-1", 10, 999, [20, 30])

    @pytest.mark.asyncio
    async def test_forward_message_orchestration_success(self):
        db = AsyncMock()
        source_conv = MagicMock()
        source_conv.id = 10
        source_msg = Message(
            id=100,
            conversation_id=10,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            status=ConversationMessageStatus.DELIVERED,
            body="Forwarded secret payload",
            wa_message_id="BAE5_SOURCE_MSG_1",
            recipient_phone="+905550001122",
        )
        target_conv = MagicMock()
        target_conv.id = 20
        target_conv.last_message_at = None

        mock_first = MagicMock()
        mock_first.first.return_value = (source_msg, source_conv)
        mock_first.scalar_one_or_none.return_value = target_conv
        db.execute.return_value = mock_first

        session_row = WhatsAppSession(
            id=1,
            user_id="usr-1",
            gateway_id="gw-1",
            status=SessionStatus.CONNECTED,
        )

        with patch("backend.app.services.whatsapp_service._resolve_jid", return_value=(target_conv, "905553334455@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp_service._conversation_session", return_value=session_row):
                with patch("backend.app.services.whatsapp_gateway.forward_message", new_callable=AsyncMock) as mock_gw_fwd:
                    mock_gw_fwd.return_value = {
                        "success": True,
                        "wa_message_id": "BAE5_FWD_TARGET_1",
                        "status": "SENT",
                    }
                    result = await forward_message(db, "usr-1", 10, 100, [20])
                    assert result["success"] is True
                    assert result["forwarded_count"] == 1
                    assert len(result["results"]) == 1
                    assert result["results"][0]["wa_message_id"] == "BAE5_FWD_TARGET_1"
                    assert result["results"][0]["is_forwarded"] is True
                    assert result["results"][0]["body"] == "Forwarded secret payload"

    @pytest.mark.asyncio
    async def test_pin_message_success(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.is_group = False

        msg = Message(
            id=55,
            conversation_id=10,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            status=ConversationMessageStatus.DELIVERED,
            body="Important pin target",
            wa_message_id="BAE5_PIN_TARGET_1",
            recipient_phone="+905550001122",
        )

        mock_exec = MagicMock()
        mock_exec.scalar_one_or_none.return_value = msg
        db.execute.return_value = mock_exec

        session_row = WhatsAppSession(
            id=1,
            user_id="usr-1",
            gateway_id="gw-1",
            status=SessionStatus.CONNECTED,
        )

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "905550001122@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row):
                with patch("backend.app.services.whatsapp_gateway.pin_message", new_callable=AsyncMock) as mock_gw_pin:
                    mock_gw_pin.return_value = {
                        "success": True,
                        "wa_message_id": "BAE5_PIN_TARGET_1",
                        "action": "PIN",
                        "duration_seconds": 86400,
                    }
                    result = await pin_message(db, "usr-1", 10, 55, action="PIN", duration_seconds=86400)
                    assert result["success"] is True
                    assert result["is_pinned"] is True
                    assert result["action"] == "PIN"
                    assert result["wa_message_id"] == "BAE5_PIN_TARGET_1"
                    assert result["pinned_at"] is not None
                    assert result["pinned_until"] is not None

    @pytest.mark.asyncio
    async def test_unpin_message_success(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        conv.is_group = False

        msg = Message(
            id=55,
            conversation_id=10,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            status=ConversationMessageStatus.DELIVERED,
            body="Important pin target",
            wa_message_id="BAE5_PIN_TARGET_1",
            recipient_phone="+905550001122",
            is_pinned=True,
            pinned_at=datetime(2026, 10, 18, 12, 0, 0),
        )

        mock_exec = MagicMock()
        mock_exec.scalar_one_or_none.return_value = msg
        db.execute.return_value = mock_exec

        session_row = WhatsAppSession(
            id=1,
            user_id="usr-1",
            gateway_id="gw-1",
            status=SessionStatus.CONNECTED,
        )

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "905550001122@s.whatsapp.net")):
            with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row):
                with patch("backend.app.services.whatsapp_gateway.pin_message", new_callable=AsyncMock) as mock_gw_pin:
                    mock_gw_pin.return_value = {
                        "success": True,
                        "wa_message_id": "BAE5_PIN_TARGET_1",
                        "action": "UNPIN",
                        "duration_seconds": 0,
                    }
                    result = await pin_message(db, "usr-1", 10, 55, action="UNPIN")
                    assert result["success"] is True
                    assert result["is_pinned"] is False
                    assert result["action"] == "UNPIN"
                    assert result["pinned_at"] is None
                    assert result["pinned_until"] is None

    @pytest.mark.asyncio
    async def test_pin_message_not_found(self):
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        mock_exec = MagicMock()
        mock_exec.scalar_one_or_none.return_value = None
        db.execute.return_value = mock_exec

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "905550001122@s.whatsapp.net")):
            with pytest.raises(LookupError, match="Mesaj #999 bulunamadı"):
                await pin_message(db, "usr-1", 10, 999, action="PIN")

    @pytest.mark.asyncio
    async def test_retry_failed_message_with_wa_id_and_different_initial_type(self):
        """A failed message (even with wa_message_id and IMAGE type) can be claimed and retried as text."""
        db = AsyncMock()
        conv = MagicMock()
        conv.id = 10
        session_row = MagicMock()
        session_row.id = 1

        failed_msg = Message(
            id=143903,
            user_id="usr-1",
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.IMAGE,
            status=ConversationMessageStatus.FAILED,
            body="Merhaba test",
            client_message_id="cmsg_failed_123",
            wa_message_id="FAIL_HASH_999",
        )

        db.scalar.return_value = failed_msg
        claim_mock = MagicMock()
        claim_mock.rowcount = 1
        db.execute.return_value = claim_mock

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "905550001122@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row), \
             patch("backend.app.services.whatsapp_gateway.send_text_message", new_callable=AsyncMock) as mock_send, \
             patch("backend.app.services.whatsapp.orchestration.messaging._apply_last_message"):
            mock_send.return_value = {
                "success": True,
                "wa_message_id": "WA_RETRY_SUCCESS_1",
                "status": "SENT",
            }
            res = await send_text_message(
                db=db,
                user_id="usr-1",
                conversation_id=10,
                body="Merhaba test",
                client_message_id="cmsg_failed_123",
            )
            assert res["status"] == "SENT"
            assert res["wa_message_id"] == "WA_RETRY_SUCCESS_1"
            assert failed_msg.message_type == MessageType.TEXT

    @pytest.mark.asyncio
    async def test_get_messages_auto_synthesizes_preview_when_empty(self, tmp_path):
        """When DB has 0 messages, but conversation has last_message_preview,
        get_messages auto-synthesizes the preview into a Message row rather than falsely claiming no messages."""
        import uuid
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from backend.app.core.database import Base
        from backend.app.models.conversation import ConversationStatus

        owner = str(uuid.uuid4())
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/synth_test.db")
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

        async with sessions() as db:
            conv = Conversation(
                id=999,
                user_id=owner,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                unread_count=0,
                last_message_preview="haftaya bu iş tamam abi :D",
                last_message_at=datetime(2026, 10, 25, 12, 0, 0),
            )
            db.add(conv)
            await db.commit()

            with patch("backend.app.services.whatsapp_service._conversation_session", return_value=None):
                res = await whatsapp_service.get_messages(db, owner, 999)
                assert len(res["messages"]) == 1
                msg = res["messages"][0]
                assert msg["body"] == "haftaya bu iş tamam abi :D"
                assert msg["direction"] == "INBOUND"
                assert msg["conversation_id"] == 999

        await engine.dispose()

    @pytest.mark.asyncio
    async def test_ensure_conversation_preview_messages_migration(self):
        """Test ensure_conversation_preview_messages on SQLite in-memory engine."""
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import create_async_engine
        from backend.app.core.database import Base
        from backend.app.core.migrations import ensure_conversation_preview_messages

        test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text("""
                INSERT INTO conversations (id, user_id, contact_id, channel, status, unread_count, is_group, is_archived, last_message_preview, last_message_at, created_at, updated_at)
                VALUES (777, '00000000-0000-0000-0000-000000000001', NULL, 'WHATSAPP', 'ACTIVE', 0, 0, 0, 'Siz: Merhaba nasılsınız?', datetime('now'), datetime('now'), datetime('now'))
            """))
            await conn.execute(text("""
                INSERT INTO conversations (id, user_id, contact_id, channel, status, unread_count, is_group, is_archived, last_message_preview, last_message_at, created_at, updated_at)
                VALUES (778, '00000000-0000-0000-0000-000000000001', NULL, 'WHATSAPP', 'ACTIVE', 0, 0, 0, 'Teşekkürler iyiyim', datetime('now'), datetime('now'), datetime('now'))
            """))

        await ensure_conversation_preview_messages(test_engine)

        async with test_engine.connect() as conn:
            rows = (await conn.execute(text("SELECT conversation_id, direction, body FROM messages ORDER BY conversation_id"))).fetchall()
            assert len(rows) == 2
            assert rows[0][0] == 777
            assert rows[0][1] == "OUTBOUND"
            assert rows[0][2] == "Merhaba nasılsınız?"
            assert rows[1][0] == 778
            assert rows[1][1] == "INBOUND"
            assert rows[1][2] == "Teşekkürler iyiyim"
        await test_engine.dispose()




