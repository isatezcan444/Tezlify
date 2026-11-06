"""End-to-end and characterization tests for WhatsApp message actions (Phase Message Actions).

Covers:
1. Message serialization (revoked tombstone redaction, edit timestamps, starring, delete-for-me).
2. Outbound message editing with native Baileys protocolMessage.
3. Message deletion for everyone (REVOKE) with tombstone and preview update.
4. Message deletion for me with query exclusion from history keyset pagination.
5. Message starring and unstarring with native Baileys star action.
6. Inbound gateway event ingestion for message_deleted and message_starred.
7. Multi-tenant and authorization security guards.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration.messaging import (
    WhatsAppMessagingOrchestrator,
    serialize_message,
)
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.repositories.messages import (
    select_messages_keyset,
    has_older_messages,
)


class TestMessageActionsSerialization:
    """Tests message serialization rules for message actions."""

    def test_serialize_message_with_revoked_redaction(self):
        msg = Message(
            id=101,
            conversation_id=20,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            status=ConversationMessageStatus.SENT,
            body="Confidential text to be revoked",
            media_id="secret_id",
            media_caption="Secret caption",
            wa_message_id="WA_REV_101",
            is_revoked=True,
            revoked_at=datetime(2026, 11, 6, 12, 0, 0),
        )
        data = serialize_message(msg)
        assert data["is_revoked"] is True
        assert data["revoked_at"] == "2026-11-06T12:00:00"
        # Truthfulness / Privacy invariant: body and media must be completely redacted on serialization
        assert data["body"] == ""
        assert data["media_url"] is None
        assert data["media_id"] is None
        assert data["media_caption"] is None

    def test_serialize_message_with_edited_metadata(self):
        msg = Message(
            id=102,
            conversation_id=20,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            status=ConversationMessageStatus.SENT,
            body="Edited body text",
            wa_message_id="WA_EDIT_102",
            is_edited=True,
            edited_at=datetime(2026, 11, 6, 12, 5, 0),
        )
        data = serialize_message(msg)
        assert data["is_edited"] is True
        assert data["edited_at"] == "2026-11-06T12:05:00"
        assert data["body"] == "Edited body text"

    def test_serialize_message_with_starred_metadata(self):
        msg = Message(
            id=103,
            conversation_id=20,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            status=ConversationMessageStatus.RECEIVED,
            body="Important incoming note",
            wa_message_id="WA_STAR_103",
            is_starred=True,
            starred_at=datetime(2026, 11, 6, 12, 10, 0),
        )
        data = serialize_message(msg)
        assert data["is_starred"] is True
        assert data["starred_at"] == "2026-11-06T12:10:00"


class TestMessageActionsOrchestration:
    """Tests the messaging orchestrator methods for edit, delete, and star."""

    @pytest.mark.asyncio
    async def test_edit_message_success(self):
        orchestrator = WhatsAppMessagingOrchestrator()
        db = AsyncMock()

        conv = Conversation(id=1, user_id="user_1", is_group=False)
        target = Message(
            id=42,
            conversation_id=1,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Original text",
            wa_message_id="WA_MSG_42",
            is_revoked=False,
        )

        scalar_mock = MagicMock()
        scalar_mock.scalar_one_or_none.return_value = target
        db.execute.return_value = scalar_mock

        session = WhatsAppSession(
            id=1,
            user_id="user_1",
            gateway_id="gw_sess_1",
            status=SessionStatus.CONNECTED,
        )

        gw_mock = AsyncMock()
        gw_mock.edit_message.return_value = {"success": True, "message_id": "WA_MSG_42"}
        ws_mock = AsyncMock()

        with patch.object(orchestrator, "_get_helper") as mock_helper:
            mock_helper.side_effect = lambda name, default: {
                "_resolve_jid": AsyncMock(return_value=(conv, "905551234567@s.whatsapp.net")),
                "_conversation_session": AsyncMock(return_value=session),
                "_gateway_op_or_mark_relink": lambda db_sess, s, op: op(s.gateway_id),
                "gw": gw_mock,
                "ws_manager": ws_mock,
            }.get(name, default)

            result = await orchestrator.edit_message(
                db=db,
                user_id="user_1",
                conversation_id=1,
                message_id=42,
                body="Updated message text",
            )

        assert result["success"] is True
        assert result["body"] == "Updated message text"
        assert result["is_edited"] is True
        assert target.body == "Updated message text"
        assert target.is_edited is True
        assert target.edited_at is not None
        gw_mock.edit_message.assert_called_once_with(
            "gw_sess_1",
            "905551234567@s.whatsapp.net",
            target_wa_message_id="WA_MSG_42",
            text="Updated message text",
            target_from_me=True,
        )
        ws_mock.broadcast_to_user.assert_called_once()

    @pytest.mark.asyncio
    async def test_edit_message_inbound_forbidden(self):
        orchestrator = WhatsAppMessagingOrchestrator()
        db = AsyncMock()

        conv = Conversation(id=1, user_id="user_1", is_group=False)
        target = Message(
            id=43,
            conversation_id=1,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="Incoming text",
            wa_message_id="WA_MSG_43",
            is_revoked=False,
        )

        scalar_mock = MagicMock()
        scalar_mock.scalar_one_or_none.return_value = target
        db.execute.return_value = scalar_mock

        with patch.object(orchestrator, "_get_helper") as mock_helper:
            mock_helper.side_effect = lambda name, default: {
                "_resolve_jid": AsyncMock(return_value=(conv, "905551234567@s.whatsapp.net")),
            }.get(name, default)

            with pytest.raises(ValueError, match="Yalnızca kendi gönderdiğiniz mesajları düzenleyebilirsiniz"):
                await orchestrator.edit_message(
                    db=db,
                    user_id="user_1",
                    conversation_id=1,
                    message_id=43,
                    body="Hacked text",
                )

    @pytest.mark.asyncio
    async def test_edit_message_revoked_forbidden(self):
        orchestrator = WhatsAppMessagingOrchestrator()
        db = AsyncMock()

        conv = Conversation(id=1, user_id="user_1", is_group=False)
        target = Message(
            id=44,
            conversation_id=1,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="",
            wa_message_id="WA_MSG_44",
            is_revoked=True,
        )

        scalar_mock = MagicMock()
        scalar_mock.scalar_one_or_none.return_value = target
        db.execute.return_value = scalar_mock

        with patch.object(orchestrator, "_get_helper") as mock_helper:
            mock_helper.side_effect = lambda name, default: {
                "_resolve_jid": AsyncMock(return_value=(conv, "905551234567@s.whatsapp.net")),
            }.get(name, default)

            with pytest.raises(ValueError, match="Silinmiş bir mesaj düzenlenemez"):
                await orchestrator.edit_message(
                    db=db,
                    user_id="user_1",
                    conversation_id=1,
                    message_id=44,
                    body="Revived text",
                )

    @pytest.mark.asyncio
    async def test_delete_message_for_everyone_revoke(self):
        orchestrator = WhatsAppMessagingOrchestrator()
        db = AsyncMock()

        conv = Conversation(id=1, user_id="user_1", is_group=False, last_message_preview="Original preview")
        target = Message(
            id=45,
            conversation_id=1,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Message to revoke",
            media_id="pic_id",
            wa_message_id="WA_MSG_45",
            is_revoked=False,
        )

        scalar_mock = MagicMock()
        scalar_mock.scalar_one_or_none.return_value = target
        db.execute.return_value = scalar_mock

        session = WhatsAppSession(
            id=1,
            user_id="user_1",
            gateway_id="gw_sess_1",
            status=SessionStatus.CONNECTED,
        )

        gw_mock = AsyncMock()
        gw_mock.delete_message.return_value = {"success": True, "delete_type": "everyone"}
        ws_mock = AsyncMock()

        with patch.object(orchestrator, "_get_helper") as mock_helper:
            mock_helper.side_effect = lambda name, default: {
                "_resolve_jid": AsyncMock(return_value=(conv, "905551234567@s.whatsapp.net")),
                "_conversation_session": AsyncMock(return_value=session),
                "_gateway_op_or_mark_relink": lambda db_sess, s, op: op(s.gateway_id),
                "gw": gw_mock,
                "ws_manager": ws_mock,
            }.get(name, default)

            result = await orchestrator.delete_message(
                db=db,
                user_id="user_1",
                conversation_id=1,
                message_id=45,
                delete_type="everyone",
            )

        assert result["success"] is True
        assert result["is_revoked"] is True
        assert result["delete_type"] == "everyone"
        assert target.is_revoked is True
        assert target.revoked_at is not None
        assert target.body == ""
        assert target.media_id is None
        assert conv.last_message_preview == "Bu mesaj silindi"

        gw_mock.delete_message.assert_called_once_with(
            "gw_sess_1",
            "905551234567@s.whatsapp.net",
            target_wa_message_id="WA_MSG_45",
            target_from_me=True,
            delete_type="everyone",
            participant_jid=None,
        )
        ws_mock.broadcast_to_user.assert_called_once()

    @pytest.mark.asyncio
    async def test_delete_message_for_me(self):
        orchestrator = WhatsAppMessagingOrchestrator()
        db = AsyncMock()

        conv = Conversation(id=1, user_id="user_1", is_group=False)
        target = Message(
            id=46,
            conversation_id=1,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="Incoming message to hide locally",
            wa_message_id="WA_MSG_46",
            is_deleted_for_me=False,
        )

        scalar_mock = MagicMock()
        scalar_mock.scalar_one_or_none.return_value = target
        db.execute.return_value = scalar_mock

        session = WhatsAppSession(
            id=1,
            user_id="user_1",
            gateway_id="gw_sess_1",
            status=SessionStatus.CONNECTED,
        )

        gw_mock = AsyncMock()
        gw_mock.delete_message.return_value = {"success": True, "delete_type": "for_me"}
        ws_mock = AsyncMock()

        with patch.object(orchestrator, "_get_helper") as mock_helper:
            mock_helper.side_effect = lambda name, default: {
                "_resolve_jid": AsyncMock(return_value=(conv, "905551234567@s.whatsapp.net")),
                "_conversation_session": AsyncMock(return_value=session),
                "_gateway_op_or_mark_relink": lambda db_sess, s, op: op(s.gateway_id),
                "gw": gw_mock,
                "ws_manager": ws_mock,
            }.get(name, default)

            result = await orchestrator.delete_message(
                db=db,
                user_id="user_1",
                conversation_id=1,
                message_id=46,
                delete_type="for_me",
            )

        assert result["success"] is True
        assert result["is_revoked"] is False
        assert result["delete_type"] == "for_me"
        assert target.is_deleted_for_me is True
        assert target.deleted_for_me_at is not None

        gw_mock.delete_message.assert_called_once_with(
            "gw_sess_1",
            "905551234567@s.whatsapp.net",
            target_wa_message_id="WA_MSG_46",
            target_from_me=False,
            delete_type="for_me",
            participant_jid=None,
        )

    @pytest.mark.asyncio
    async def test_star_message_toggle(self):
        orchestrator = WhatsAppMessagingOrchestrator()
        db = AsyncMock()

        conv = Conversation(id=1, user_id="user_1", is_group=False)
        target = Message(
            id=47,
            conversation_id=1,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="Star me",
            wa_message_id="WA_MSG_47",
            is_starred=False,
        )

        scalar_mock = MagicMock()
        scalar_mock.scalar_one_or_none.return_value = target
        db.execute.return_value = scalar_mock

        session = WhatsAppSession(
            id=1,
            user_id="user_1",
            gateway_id="gw_sess_1",
            status=SessionStatus.CONNECTED,
        )

        gw_mock = AsyncMock()
        gw_mock.star_message.return_value = {"success": True, "star": True}
        ws_mock = AsyncMock()

        with patch.object(orchestrator, "_get_helper") as mock_helper:
            mock_helper.side_effect = lambda name, default: {
                "_resolve_jid": AsyncMock(return_value=(conv, "905551234567@s.whatsapp.net")),
                "_conversation_session": AsyncMock(return_value=session),
                "_gateway_op_or_mark_relink": lambda db_sess, s, op: op(s.gateway_id),
                "gw": gw_mock,
                "ws_manager": ws_mock,
            }.get(name, default)

            # Star
            result = await orchestrator.star_message(
                db=db,
                user_id="user_1",
                conversation_id=1,
                message_id=47,
                star=True,
            )
            assert result["success"] is True
            assert result["is_starred"] is True
            assert target.is_starred is True
            assert target.starred_at is not None

            # Unstar
            result_unstar = await orchestrator.star_message(
                db=db,
                user_id="user_1",
                conversation_id=1,
                message_id=47,
                star=False,
            )
            assert result_unstar["is_starred"] is False
            assert target.is_starred is False
            assert target.starred_at is None


class TestMessageActionsEventsIngestion:
    """Tests inbound gateway socket events for message_deleted and message_starred."""

    @pytest.mark.asyncio
    async def test_ingest_message_deleted_revoke_event(self):
        orchestrator = WhatsAppEventOrchestrator()
        db = AsyncMock()

        conv = Conversation(id=5, user_id="owner_1", last_message_preview="Active text")
        msg = Message(
            id=88,
            conversation_id=5,
            direction=MessageDirection.OUTBOUND,
            wa_message_id="REMOTE_REVOKE_88",
            body="Active text",
            is_revoked=False,
        )

        first_mock = MagicMock()
        first_mock.first.return_value = (msg, conv)
        db.execute.return_value = first_mock

        session = WhatsAppSession(id=1, user_id="owner_1")

        with patch.object(orchestrator, "_get_helper") as mock_helper:
            mock_helper.side_effect = lambda name, default: {
                "_resolve_event_owner_and_session": AsyncMock(return_value=("owner_1", session)),
            }.get(name, default)

            event = {
                "event": "message_deleted",
                "conversation_id": "905551112233@s.whatsapp.net",
                "wa_message_id": "REMOTE_REVOKE_88",
                "delete_type": "everyone",
                "is_revoked": True,
            }
            res = await orchestrator._ingest_message_deleted(db, event)

        assert res["event"] == "message_deleted"
        assert res["is_revoked"] is True
        assert res["delete_type"] == "everyone"
        assert msg.is_revoked is True
        assert msg.body == ""
        assert conv.last_message_preview == "Bu mesaj silindi"

    @pytest.mark.asyncio
    async def test_ingest_message_starred_event(self):
        orchestrator = WhatsAppEventOrchestrator()
        db = AsyncMock()

        conv = Conversation(id=6, user_id="owner_1")
        msg = Message(
            id=99,
            conversation_id=6,
            wa_message_id="REMOTE_STAR_99",
            is_starred=False,
        )

        first_mock = MagicMock()
        first_mock.first.return_value = (msg, conv)
        db.execute.return_value = first_mock

        session = WhatsAppSession(id=1, user_id="owner_1")

        with patch.object(orchestrator, "_get_helper") as mock_helper:
            mock_helper.side_effect = lambda name, default: {
                "_resolve_event_owner_and_session": AsyncMock(return_value=("owner_1", session)),
            }.get(name, default)

            event = {
                "event": "message_starred",
                "conversation_id": "905551112233@s.whatsapp.net",
                "wa_message_id": "REMOTE_STAR_99",
                "star": True,
            }
            res = await orchestrator._ingest_message_starred(db, event)

        assert res["event"] == "message_starred"
        assert res["is_starred"] is True
        assert msg.is_starred is True
        assert msg.starred_at is not None


class TestMessageActionsKeysetFiltering:
    """Verifies that is_deleted_for_me rows are excluded from keyset queries."""

    @pytest.mark.asyncio
    async def test_select_messages_keyset_filters_deleted_for_me(self):
        db = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        db.execute.return_value = mock_result

        await select_messages_keyset(db, user_id="user_test", conversation_id=1, limit=50)

        call_args = db.execute.call_args[0]
        stmt = call_args[0]
        sql_str = str(stmt)
        assert "is_deleted_for_me" in sql_str

    @pytest.mark.asyncio
    async def test_has_older_messages_filters_deleted_for_me(self):
        db = AsyncMock()
        db.scalar.return_value = None

        oldest = Message(
            id=10,
            conversation_id=1,
            created_at=datetime(2026, 11, 6, 10, 0, 0),
        )

        await has_older_messages(db, user_id="user_test", conversation_id=1, oldest_row=oldest)

        call_args = db.scalar.call_args[0]
        stmt = call_args[0]
        sql_str = str(stmt)
        assert "is_deleted_for_me" in sql_str
