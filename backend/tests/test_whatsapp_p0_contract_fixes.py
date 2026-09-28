"""P0 contract fixes: single-message endpoint + start-conversation (WhatsApp Web parity).

Covers the two gaps found in the end-to-end audit:
  1. `get_message` — the frontend retry flow (`WhatsAppApi.getMessage`) calls
     `GET /conversations/{id}/messages/{message_id}`; the endpoint did not
     exist, so every FAILED-message retry 404'd.
  2. `start_conversation` — "Yeni Sohbet" (NewChatModal) used to throw
     unconditionally in the repository; the backend now really creates the
     contact + conversation and optionally dispatches the first message.
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.services.whatsapp.exceptions import NoWhatsAppSession
from backend.app.services.whatsapp.orchestration.messaging import get_message
from backend.app.services import whatsapp_service


@pytest.mark.asyncio
async def test_get_message_returns_serialized_row():
    db = AsyncMock()
    conv = MagicMock(id=10)
    row = Message(
        id=101,
        conversation_id=10,
        direction=MessageDirection.OUTBOUND,
        message_type=MessageType.TEXT,
        body="Retry me",
        client_message_id="c-1",
        status=ConversationMessageStatus.FAILED,
    )
    db.scalar.return_value = row
    with patch(
        "backend.app.services.whatsapp.orchestration.messaging._resolve_jid",
        return_value=(conv, "90555@s.whatsapp.net"),
    ):
        res = await get_message(db, "usr-1", 10, 101)
    assert res["id"] == 101
    assert res["body"] == "Retry me"
    assert res["status"] == "FAILED"


@pytest.mark.asyncio
async def test_get_message_missing_row_raises_lookup_error():
    db = AsyncMock()
    conv = MagicMock(id=10)
    db.scalar.return_value = None
    with patch(
        "backend.app.services.whatsapp.orchestration.messaging._resolve_jid",
        return_value=(conv, "90555@s.whatsapp.net"),
    ):
        with pytest.raises(LookupError):
            await get_message(db, "usr-1", 10, 9999)


@pytest.mark.asyncio
async def test_start_conversation_invalid_phone_raises_value_error():
    db = AsyncMock()
    with pytest.raises(ValueError):
        await whatsapp_service.start_conversation(db, "usr-1", "not-a-phone")


@pytest.mark.asyncio
async def test_start_conversation_requires_connected_session():
    db = AsyncMock()
    with patch(
        "backend.app.services.whatsapp_service._require_user_session",
        side_effect=NoWhatsAppSession("no line"),
    ):
        with pytest.raises(NoWhatsAppSession):
            await whatsapp_service.start_conversation(db, "usr-1", "+905551234567")


@pytest.mark.asyncio
async def test_start_conversation_creates_conversation_and_returns_rest_payload():
    db = AsyncMock()
    session = MagicMock(id=7)
    conv = MagicMock(id=55)
    rest_payload = {"id": 55, "name": None, "phone": "+905551234567", "status": "ACTIVE", "unread_count": 0}
    with patch(
        "backend.app.services.whatsapp_service._require_user_session", return_value=session
    ), patch(
        "backend.app.services.whatsapp_service._ensure_conversation", return_value=conv
    ) as ensure, patch(
        "backend.app.services.whatsapp_service.list_conversations", return_value=([rest_payload], 1)
    ), patch(
        "backend.app.services.whatsapp_service.send_text_message", new=AsyncMock()
    ) as send_mock:
        res = await whatsapp_service.start_conversation(
            db, "usr-1", "+905551234567", name="Ahmet", message="Merhaba"
        )
    assert res["id"] == 55
    ensure.assert_awaited_once()
    # The first message must be REALLY dispatched through the send path.
    send_mock.assert_awaited_once()
    args = send_mock.await_args.args
    assert args[2] == 55 and args[3] == "Merhaba"


@pytest.mark.asyncio
async def test_start_conversation_without_message_skips_send():
    db = AsyncMock()
    session = MagicMock(id=7)
    conv = MagicMock(id=56)
    rest_payload = {"id": 56}
    with patch(
        "backend.app.services.whatsapp_service._require_user_session", return_value=session
    ), patch(
        "backend.app.services.whatsapp_service._ensure_conversation", return_value=conv
    ), patch(
        "backend.app.services.whatsapp_service.list_conversations", return_value=([rest_payload], 1)
    ), patch(
        "backend.app.services.whatsapp_service.send_text_message", new=AsyncMock()
    ) as send_mock:
        res = await whatsapp_service.start_conversation(db, "usr-1", "+905551234567")
    assert res["id"] == 56
    send_mock.assert_not_awaited()


# ---------------------------------------------------------------------------
# Avatar backfill (WhatsApp Web paritesi: tüm profil fotoğrafları iner)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_refresh_all_avatars_reports_missing_count():
    db = AsyncMock()
    session = MagicMock(gateway_id="gw-uuid-1")
    with patch(
        "backend.app.services.whatsapp_service._require_user_session", return_value=session
    ), patch(
        "backend.app.services.whatsapp_service.gw.request_avatar_backfill",
        new=AsyncMock(return_value={"success": True, "missing": 4}),
    ) as backfill_mock:
        res = await whatsapp_service.refresh_all_avatars(db, "usr-1")
    assert res == {"success": True, "missing": 4}
    backfill_mock.assert_awaited_once_with("gw-uuid-1")


@pytest.mark.asyncio
async def test_refresh_all_avatars_requires_connected_session():
    db = AsyncMock()
    with patch(
        "backend.app.services.whatsapp_service._require_user_session",
        side_effect=NoWhatsAppSession("no line"),
    ):
        with pytest.raises(NoWhatsAppSession):
            await whatsapp_service.refresh_all_avatars(db, "usr-1")


@pytest.mark.asyncio
async def test_refresh_all_avatars_invalid_gateway_response_fails_closed():
    db = AsyncMock()
    session = MagicMock(gateway_id="gw-uuid-2")
    from backend.app.services.whatsapp_gateway import WhatsAppGatewayError

    with patch(
        "backend.app.services.whatsapp_service._require_user_session", return_value=session
    ), patch(
        "backend.app.services.whatsapp_service.gw.request_avatar_backfill",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(WhatsAppGatewayError):
            await whatsapp_service.refresh_all_avatars(db, "usr-1")
