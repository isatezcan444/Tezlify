"""
Unit tests for WhatsApp Chat & Contact Sync (/api/v1/conversations/sync-whatsapp).
Verifies zero-lag sync, contact name resolution, and invariant compliance.
"""
import uuid
import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport, Response
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.lead import Lead
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.services.whatsapp_gateway_client import WhatsAppGatewayClient


@pytest.mark.asyncio
async def test_gateway_client_get_session_chats():
    client = WhatsAppGatewayClient(gateway_url="http://mock-gateway:3001")
    mock_chats = [
        {
            "id": "905321112233@s.whatsapp.net",
            "name": "Ahmet Yılmaz",
            "phone": "905321112233",
            "unread_count": 2,
            "last_message": {"text": "Fiyat bilgisi alabilir miyim?", "from_me": False},
            "timestamp": 1717000000,
            "is_group": False,
        }
    ]

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = Response(200, json={"status": "success", "chats": mock_chats})
        result = await client.get_session_chats("session_test")
        assert len(result) == 1
        assert result[0]["name"] == "Ahmet Yılmaz"
        assert result[0]["unread_count"] == 2


@pytest.mark.asyncio
async def test_sync_whatsapp_conversations_endpoint():
    test_user = str(uuid.uuid4())
    test_sess_name = f"sess_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        # Create a mock connected session
        session = WhatsAppSession(
            user_id=test_user,
            session_name=test_sess_name,
            phone_number="+905551234567",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.commit()

    mock_chats_payload = [
        {
            "id": "905329998877@s.whatsapp.net",
            "name": "Mehmet Kaya (Rehber)",
            "phone": "905329998877",
            "unread_count": 3,
            "last_message": {"text": "Toplantı saat kaçta?", "from_me": False},
            "timestamp": 1717001000,
            "is_group": False,
        },
        {
            "id": "120363099999999999@g.us",
            "name": "Şirket Duyuru Grubu",
            "phone": None,
            "unread_count": 0,
            "last_message": {"text": "Yarın ofis kapalıdır.", "from_me": True},
            "timestamp": 1717002000,
            "is_group": True,
        },
    ]

    from backend.app.core.auth import get_current_user, AuthUser
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=test_user, email="test@test.com", full_name="Test User"
    )

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            with patch("backend.app.services.whatsapp_gateway_client.gateway_client.get_session_chats", new_callable=AsyncMock) as mock_fetch:
                mock_fetch.return_value = mock_chats_payload
                res = await ac.post("/api/v1/conversations/sync-whatsapp")
                assert res.status_code == 200, res.text
                data = res.json()
                assert data["status"] == "success"
                assert data["synced_count"] == 2
                assert data["session_name"] == test_sess_name

            # Check that conversations list now returns them
            conv_res = await ac.get("/api/v1/conversations")
            assert conv_res.status_code == 200
            convs = conv_res.json()
            assert any(c["lead_name"] == "Mehmet Kaya (Rehber)" for c in convs)
            assert any(c["lead_name"] == "Şirket Duyuru Grubu" for c in convs)

            # Invariant 1.3 verify: group is flagged as is_group and has no e164 phone
            group_conv = next(c for c in convs if c["lead_name"] == "Şirket Duyuru Grubu")
            assert group_conv["is_group"] is True
            assert group_conv["lead_phone"] == "120363099999999999@g.us"

            async with AsyncSessionLocal() as db:
                group_lead = (await db.execute(select(Lead).where(Lead.name == "Şirket Duyuru Grubu"))).scalars().first()
                assert group_lead is not None
                assert group_lead.phone_e164 is None  # Invariant 1.3: Never synthesize fake numbers
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_sync_whatsapp_conversations_with_gateway_string_messages():
    """Verifies that wa-gateway string lastMessage and camelCase unreadCount are handled without error."""
    test_user = str(uuid.uuid4())
    test_sess_name = f"sess_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user,
            session_name=test_sess_name,
            phone_number="+905559876543",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.commit()

    gateway_format_chats = [
        {
            "id": "905321110022@s.whatsapp.net",
            "jid": "905321110022@s.whatsapp.net",
            "phone": "+905321110022",
            "name": "Ayşe Hanım (Müşteri)",
            "pushName": "Ayşe",
            "isGroup": False,
            "unreadCount": 5,
            "lastMessage": "Teklifinizi kabul ediyoruz, teşekkürler.",
            "timestamp": 1717005000,
        }
    ]

    from backend.app.core.auth import get_current_user, AuthUser
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=test_user, email="test2@test.com", full_name="Test User 2"
    )

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            with patch("backend.app.services.whatsapp_gateway_client.gateway_client.get_session_chats", new_callable=AsyncMock) as mock_fetch:
                mock_fetch.return_value = gateway_format_chats
                res = await ac.post("/api/v1/conversations/sync-whatsapp")
                assert res.status_code == 200, res.text
                data = res.json()
                assert data["synced_count"] == 1

            conv_res = await ac.get("/api/v1/conversations")
            assert conv_res.status_code == 200
            convs = conv_res.json()
            ayse_conv = next(c for c in convs if c["lead_name"] == "Ayşe Hanım (Müşteri)")
            assert ayse_conv["unread_count"] == 5
            assert ayse_conv["last_message_preview"] == "Teklifinizi kabul ediyoruz, teşekkürler."
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_webhook_chats_synced():
    """Verifies that wa-gateway dispatches /webhook/chats-synced successfully."""
    from backend.app.core.config import settings
    secret = settings.WA_GATEWAY_WEBHOOK_SECRET or "dev-webhook-secret"

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        res = await ac.post(
            "/api/v1/whatsapp/webhook/chats-synced",
            headers={"X-Webhook-Secret": secret},
            json={
                "session_name": "test_session",
                "total_chats": 12,
                "total_contacts": 45,
            },
        )
        assert res.status_code == 200
        assert res.json()["status"] == "success"


@pytest.mark.asyncio
async def test_webhook_inbound_persists_conversation_and_message():
    """Verifies that inbound WhatsApp message creates lead, conversation, and message entity."""
    from backend.app.core.config import settings
    secret = settings.WA_GATEWAY_WEBHOOK_SECRET or "dev-webhook-secret"
    test_user = str(uuid.uuid4())
    test_sess = f"inbound_sess_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=test_user,
            session_name=test_sess,
            phone_number="+905550001122",
            status=SessionStatus.CONNECTED,
        )
        db.add(session)
        await db.commit()

    import random
    test_phone = f"+90533{random.randint(1000000, 9999999)}"
    inbound_text = "Merhaba, ürün hakkında bilgi alabilir miyim?"

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        res = await ac.post(
            "/api/v1/whatsapp/webhook/inbound",
            headers={"X-Webhook-Secret": secret},
            json={
                "session_name": test_sess,
                "phone": test_phone,
                "message": inbound_text,
                "push_name": "Kemal Sunal",
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "success"
        assert data["conversation_id"] is not None

        # Verify DB state
        async with AsyncSessionLocal() as db:
            lead = (await db.execute(select(Lead).where(Lead.phone_e164 == test_phone))).scalar_one_or_none()
            assert lead is not None
            assert lead.name == "Kemal Sunal"

            conv = (await db.execute(select(Conversation).where(Conversation.lead_id == lead.id))).scalar_one_or_none()
            assert conv is not None
            assert conv.last_message_preview == inbound_text
            assert conv.unread_count == 1
