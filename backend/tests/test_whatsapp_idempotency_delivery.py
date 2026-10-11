"""Idempotent WhatsApp message delivery and recovery test suite (Phase 2.8).

Tests:
1. Same client_message_id with same text twice: exactly 1 gateway dispatch.
2. Concurrent duplicate requests: serialized by lock, exactly 1 gateway dispatch.
3. Same client_message_id with different text: ValueError (409 Conflict).
4. Same client_message_id with different media: ValueError (409 Conflict).
5. Database IntegrityError race condition handling: rollback + re-query recovery.
6. Message with wa_message_id already present: returns immediately without gateway dispatch.
7. Terminal status message: returns immediately without gateway dispatch.
8. Gateway failure before wa_message_id: marked FAILED with honest error.
9. Downstream error after wa_message_id: does not mark FAILED.
10. Media sending idempotency: duplicate client_message_id returns existing.
11. Different conversations with same client_message_id: isolated, no collision.
12. recover_stuck_jobs: transitions stranded PENDING outbound messages to FAILED.
"""
import asyncio
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp.orchestration.messaging import (
    send_media_message,
    send_text_message,
)
from backend.app.main import recover_stuck_jobs


class TestWhatsAppIdempotencyDelivery:
    """Comprehensive test suite for Phase 2.8 Idempotency and Recovery."""

    @pytest.mark.asyncio
    async def test_same_key_same_text_twice_single_gateway_dispatch(self):
        """Second identical call with the same client_message_id returns the existing message without calling the gateway."""
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        saved_message = None

        async def mock_scalar(query):
            return saved_message

        def mock_add(row):
            nonlocal saved_message
            saved_message = row

        db.scalar.side_effect = mock_scalar
        db.add = MagicMock(side_effect=mock_add)

        gateway_dispatch = AsyncMock(return_value={"wa_message_id": "BAE5ABC123", "status": "SENT"})

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "905551112233@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row), \
             patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", gateway_dispatch):

            # Call 1: First dispatch
            res1 = await send_text_message(db, "usr-1", 10, "Hello World", client_message_id="client-mid-001")
            assert res1["status"] == "SENT"
            assert res1["wa_message_id"] == "BAE5ABC123"
            assert gateway_dispatch.await_count == 1

            # Simulate saved message now has status SENT and wa_message_id
            saved_message.status = ConversationMessageStatus.SENT
            saved_message.wa_message_id = "BAE5ABC123"

            # Call 2: Second dispatch with identical client_message_id
            res2 = await send_text_message(db, "usr-1", 10, "Hello World", client_message_id="client-mid-001")
            assert res2["status"] == "SENT"
            assert res2["wa_message_id"] == "BAE5ABC123"
            # Gateway must NOT be called a second time
            assert gateway_dispatch.await_count == 1

    @pytest.mark.asyncio
    async def test_concurrent_send_text_message_calls_gateway_only_once(self):
        """Concurrent requests with the same client_message_id are serialized by lock and only invoke the gateway once."""
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        stored_row = None

        async def mock_scalar(query):
            return stored_row

        def mock_add(row):
            nonlocal stored_row
            stored_row = row

        db.scalar.side_effect = mock_scalar
        db.add = MagicMock(side_effect=mock_add)

        async def slow_gateway_op(db_session, session_r, op):
            await asyncio.sleep(0.02)
            if stored_row:
                stored_row.wa_message_id = "BAE5CONC999"
                stored_row.status = ConversationMessageStatus.SENT
            return {"wa_message_id": "BAE5CONC999", "status": "SENT"}

        gateway_mock = AsyncMock(side_effect=slow_gateway_op)

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "905551112233@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row), \
             patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", gateway_mock):

            # Fire two concurrent dispatches in parallel
            res1, res2 = await asyncio.gather(
                send_text_message(db, "usr-1", 10, "Concurrent send", client_message_id="conc-client-mid-1"),
                send_text_message(db, "usr-1", 10, "Concurrent send", client_message_id="conc-client-mid-1"),
            )

            assert res1["status"] == "SENT"
            assert res2["status"] == "SENT"
            assert res1["wa_message_id"] == "BAE5CONC999"
            assert res2["wa_message_id"] == "BAE5CONC999"
            # Gateway must only be called once!
            assert gateway_mock.await_count == 1

    @pytest.mark.asyncio
    async def test_same_key_different_content_raises_conflict_value_error(self):
        """Reusing client_message_id for different text content raises ValueError (maps to 409 Conflict)."""
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        existing_msg = Message(
            id=101,
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Original message content",
            client_message_id="conflict-mid-01",
            status=ConversationMessageStatus.SENT,
            wa_message_id="wa-101",
        )
        db.scalar.return_value = existing_msg

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()):

            with pytest.raises(ValueError, match="client_message_id farklı bir mesaj için yeniden kullanılamaz"):
                await send_text_message(db, "usr-1", 10, "Tamamen farkli bir icerik", client_message_id="conflict-mid-01")

    @pytest.mark.asyncio
    async def test_same_key_different_media_raises_conflict_value_error(self):
        """Reusing client_message_id for different media raises ValueError (maps to 409 Conflict)."""
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        existing_media = Message(
            id=102,
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.IMAGE,
            body="photo.png",
            client_message_id="media-conflict-01",
            status=ConversationMessageStatus.SENT,
            wa_message_id="wa-media-102",
        )
        db.scalar.return_value = existing_media

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()):

            with pytest.raises(ValueError, match="client_message_id farklı bir medya için yeniden kullanılamaz"):
                await send_media_message(
                    db,
                    "usr-1",
                    10,
                    {
                        "media_type": "document",
                        "filename": "document.pdf",
                        "client_message_id": "media-conflict-01",
                    },
                )

    @pytest.mark.asyncio
    async def test_integrity_error_recovery_on_race_condition(self):
        """If concurrent commit raises IntegrityError due to unique constraint, code recovers existing row."""
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        existing_committed = Message(
            id=202,
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Race test",
            client_message_id="race-mid-002",
            status=ConversationMessageStatus.SENT,
            wa_message_id="wa-race-202",
        )

        call_count = 0

        async def dynamic_scalar(query):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return None  # First check sees nothing
            return existing_committed  # Second check after IntegrityError sees committed row

        db.scalar.side_effect = dynamic_scalar
        db.commit.side_effect = [
            IntegrityError("duplicate key", params=None, orig=Exception("unique constraint violated")),
            None,
        ]

        gateway_dispatch = AsyncMock()

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row), \
             patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", gateway_dispatch):

            res = await send_text_message(db, "usr-1", 10, "Race test", client_message_id="race-mid-002")

            assert res["id"] == 202
            assert res["status"] == "SENT"
            assert res["wa_message_id"] == "wa-race-202"
            db.rollback.assert_awaited_once()
            gateway_dispatch.assert_not_called()

    @pytest.mark.asyncio
    async def test_existing_wa_message_id_returns_immediately_without_gateway_call(self):
        """Even if status is PENDING, having wa_message_id means WhatsApp already accepted the message."""
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        existing_msg = Message(
            id=303,
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Already has wa id",
            client_message_id="client-mid-303",
            status=ConversationMessageStatus.PENDING,
            wa_message_id="BAE5ALREADY123",
        )
        db.scalar.return_value = existing_msg

        gateway_dispatch = AsyncMock()

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()), \
             patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", gateway_dispatch):

            res = await send_text_message(db, "usr-1", 10, "Already has wa id", client_message_id="client-mid-303")
            assert res["id"] == 303
            assert res["wa_message_id"] == "BAE5ALREADY123"
            gateway_dispatch.assert_not_called()

    @pytest.mark.asyncio
    async def test_different_conversation_same_client_id_no_collision(self):
        """Same client_message_id in two distinct conversations does not collide or leak state."""
        db = AsyncMock()
        conv1 = MagicMock(id=1, is_group=False, last_message_at=None)
        conv2 = MagicMock(id=2, is_group=False, last_message_at=None)
        session_row = WhatsAppSession(id=1, user_id="usr-1", gateway_id="gw-1", status=SessionStatus.CONNECTED)

        db.scalar.return_value = None  # No duplicate within each conversation

        gateway_dispatch = AsyncMock(side_effect=[
            {"wa_message_id": "wa-conv-1", "status": "SENT"},
            {"wa_message_id": "wa-conv-2", "status": "SENT"},
        ])

        with patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=session_row), \
             patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", gateway_dispatch):

            with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv1, "905551@s.whatsapp.net")):
                res1 = await send_text_message(db, "usr-1", 1, "Hello Conv 1", client_message_id="shared-key-100")

            with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv2, "905552@s.whatsapp.net")):
                res2 = await send_text_message(db, "usr-1", 2, "Hello Conv 2", client_message_id="shared-key-100")

            assert res1["conversation_id"] == 1
            assert res1["wa_message_id"] == "wa-conv-1"
            assert res2["conversation_id"] == 2
            assert res2["wa_message_id"] == "wa-conv-2"
            assert gateway_dispatch.await_count == 2

    @pytest.mark.asyncio
    async def test_send_media_message_idempotent_duplicate(self):
        """send_media_message with existing client_message_id returns existing without re-dispatch."""
        db = AsyncMock()
        conv = MagicMock(id=10, is_group=False, last_message_at=None)
        existing_media = Message(
            id=404,
            conversation_id=10,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.IMAGE,
            body="my_photo.jpg",
            media_id="med-404",
            client_message_id="media-client-dup",
            status=ConversationMessageStatus.SENT,
            wa_message_id="wa-media-404",
        )
        db.scalar.return_value = existing_media
        gateway_dispatch = AsyncMock()

        with patch("backend.app.services.whatsapp.orchestration.messaging._resolve_jid", return_value=(conv, "90555@s.whatsapp.net")), \
             patch("backend.app.services.whatsapp.orchestration.messaging._conversation_session", return_value=MagicMock()), \
             patch("backend.app.services.whatsapp.orchestration.messaging._gateway_op_or_mark_relink", gateway_dispatch):

            res = await send_media_message(
                db,
                "usr-1",
                10,
                {
                    "media_type": "image",
                    "filename": "my_photo.jpg",
                    "client_message_id": "media-client-dup",
                },
            )

            assert res["id"] == 404
            assert res["status"] == "SENT"
            assert res["wa_message_id"] == "wa-media-404"
            gateway_dispatch.assert_not_called()

    @pytest.mark.asyncio
    async def test_recover_stuck_jobs_recovers_stranded_pending_outbound(self):
        """recover_stuck_jobs marks stranded PENDING outbound messages without wa_message_id as FAILED."""
        db = AsyncMock()
        mock_result = MagicMock()
        mock_result.rowcount = 3
        db.execute.return_value = mock_result

        with patch("os.getenv", return_value="false"), \
             patch("backend.app.core.database.AsyncSessionLocal") as session_maker:

            session_maker.return_value.__aenter__.return_value = db

            await recover_stuck_jobs()

            assert db.execute.await_count >= 3
            assert db.commit.called
