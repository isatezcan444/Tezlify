import uuid
import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport, Response

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.conversation import Conversation
from backend.app.models.lead import Lead
from backend.app.services.whatsapp_gateway_client import WhatsAppGatewayClient


@pytest.mark.asyncio
async def test_gateway_client_get_session_chats_and_trigger_sync():
    client = WhatsAppGatewayClient(gateway_url="http://mock-gateway:3001")

    mock_chats = [
        {
            "id": "905551112233@s.whatsapp.net",
            "phone": "+905551112233",
            "name": "Ahmet Yılmaz",
            "unread_count": 2,
            "conversation_timestamp": 1715000000,
            "last_message_preview": "Merhaba nasılsınız?"
        }
    ]

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = Response(200, json=mock_chats)
        chats = await client.get_session_chats("test_session")
        assert len(chats) == 1
        assert chats[0]["phone"] == "+905551112233"
        assert chats[0]["name"] == "Ahmet Yılmaz"

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = Response(200, json={"success": True, "count": 1})
        res = await client.trigger_sync("test_session")
        assert res.get("success") is True


@pytest.mark.asyncio
async def test_start_conversation_endpoint_creates_lead_and_conversation():
    test_user_id = str(uuid.uuid4())
    test_phone = "+905329998877"

    headers = {
        "X-Test-User-Id": test_user_id,
        "X-Test-User-Email": "testuser@tezlify.com",
    }

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            "/api/v1/conversations/start",
            json={
                "phone": test_phone,
                "name": "Barber Shop Test",
                "message": "Merhaba Tezlify deneme mesajı"
            },
            headers=headers
        )

        assert res.status_code == 200
        data = res.json()
        assert data["lead_phone"] == test_phone
        assert data["lead_name"] == "Barber Shop Test"
        assert data["channel"] == "WHATSAPP"
        assert data["status"] == "ACTIVE"


@pytest.mark.asyncio
async def test_start_conversation_invalid_phone_fails():
    headers = {
        "X-Test-User-Id": str(uuid.uuid4()),
        "X-Test-User-Email": "testuser@tezlify.com",
    }

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            "/api/v1/conversations/start",
            json={"phone": "invalid-phone", "name": "Fail"},
            headers=headers
        )
        assert res.status_code == 400


@pytest.mark.asyncio
async def test_sync_whatsapp_conversations_populates_chats():
    test_user_id = str(uuid.uuid4())
    session_name = f"sess_sync_{uuid.uuid4().hex[:8]}"

    # 1. Create a CONNECTED session in DB
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user_id,
            session_name=session_name,
            phone_number="+905550001122",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.commit()

    headers = {
        "X-Test-User-Id": test_user_id,
        "X-Test-User-Email": "testuser@tezlify.com",
    }

    mock_chats = [
        {
            "id": "905333334455@s.whatsapp.net",
            "phone": "+905333334455",
            "name": "Kafeterya İşletmesi",
            "unread_count": 1,
            "conversation_timestamp": 1715001000,
            "last_message_preview": "Rezervasyon onaylandı."
        }
    ]

    transport = ASGITransport(app=app)
    with patch("backend.app.services.whatsapp_gateway_client.gateway_client.get_session_chats", new_callable=AsyncMock) as mock_get_chats:
        mock_get_chats.return_value = mock_chats

        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.post("/api/v1/conversations/sync-whatsapp", headers=headers)
            assert res.status_code == 200
            data = res.json()
            assert data["status"] == "success"
            assert data["synced_count"] >= 1

            # Verify conversation is present in conversation list
            list_res = await ac.get("/api/v1/conversations", headers=headers)
            assert list_res.status_code == 200
            convs = list_res.json()
            assert any(c["lead_phone"] == "+905333334455" for c in convs)


@pytest.mark.asyncio
async def test_sync_whatsapp_group_chat_and_avatar():
    """Verifies that WhatsApp group chats (@g.us) like 3hacker and avatars are correctly ingested and displayed."""
    test_user_id = str(uuid.uuid4())
    session_name = f"sess_grp_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user_id,
            session_name=session_name,
            phone_number="+905550001122",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.commit()

    headers = {
        "X-Test-User-Id": test_user_id,
        "X-Test-User-Email": "testuser@tezlify.com",
    }

    mock_chats = [
        {
            "id": "120363045678912345@g.us",
            "phone": "120363045678912345@g.us",
            "name": "3hacker",
            "is_group": True,
            "unread_count": 0,
            "conversation_timestamp": 1725700000,
            "last_message_preview": "Hey hackers!",
            "avatar_url": "https://pps.whatsapp.net/v/t61/mock_group_avatar.jpg",
        }
    ]

    transport = ASGITransport(app=app)
    with patch("backend.app.services.whatsapp_gateway_client.gateway_client.get_session_chats", new_callable=AsyncMock) as mock_get_chats:
        mock_get_chats.return_value = mock_chats

        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.post("/api/v1/conversations/sync-whatsapp", headers=headers)
            assert res.status_code == 200
            data = res.json()
            assert data["status"] == "success"
            assert data["synced_count"] >= 1

            # Verify group conversation is present in conversation list with avatar and is_group flag
            list_res = await ac.get("/api/v1/conversations", headers=headers)
            assert list_res.status_code == 200
            convs = list_res.json()
            group_conv = next((c for c in convs if c["lead_name"] == "3hacker"), None)
            assert group_conv is not None
            assert group_conv["is_group"] is True
            assert group_conv["lead_avatar_url"] == "https://pps.whatsapp.net/v/t61/mock_group_avatar.jpg"
            assert group_conv["last_message_preview"] == "Hey hackers!"
