import uuid
import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport, Response
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.conversation import Conversation
from backend.app.models.lead import Lead


@pytest.mark.asyncio
async def test_start_conversation_endpoint_creates_lead_and_conversation():
    test_user_id = str(uuid.uuid4())
    test_phone = f"+90532{uuid.uuid4().int % 10000000:07d}"

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
            headers=headers,
        )
        assert res.status_code == 200
        data = res.json()
        assert data["lead_phone"] == test_phone
        assert data["lead_name"] == "Barber Shop Test"

        # Verify Lead in database
        async with AsyncSessionLocal() as db:
            lead = (await db.execute(
                select(Lead).where(Lead.phone_e164 == test_phone)
            )).scalar_one_or_none()
            assert lead is not None
            assert lead.name == "Barber Shop Test"
            assert lead.user_id is not None


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
            json={"phone": "invalid-phone", "name": "Fail Test"},
            headers=headers,
        )
        assert res.status_code == 400


@pytest.mark.asyncio
async def test_send_message_without_active_session_fails_cleanly():
    """Verifies that attempting to send a live message without a connected WhatsApp session returns a clean 400 error."""
    test_user_id = str(uuid.uuid4())

    unique_phone = f"+90555{uuid.uuid4().int % 10000000:07d}"
    async with AsyncSessionLocal() as db:
        lead = Lead(
            user_id=test_user_id,
            name="Test Contact",
            phone=unique_phone,
            phone_e164=unique_phone,
            category="WhatsApp Sohbeti",
        )
        db.add(lead)
        await db.flush()

        conv = Conversation(
            user_id=test_user_id,
            lead_id=lead.id,
            channel="WHATSAPP",
        )
        db.add(conv)
        await db.commit()
        conv_id = conv.id

    headers = {
        "X-Test-User-Id": test_user_id,
        "X-Test-User-Email": "testuser@tezlify.com",
    }

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Selam, hat bagli olmadan gonderim testi."},
            headers=headers,
        )
        assert res.status_code == 400
        assert "Bağlı bir WhatsApp hattı bulunamadı" in res.json()["detail"]


@pytest.mark.asyncio
async def test_session_auth_backup_and_restore_webhook():
    from backend.app.core.config import settings
    from backend.app.core.database import engine, Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    secret = settings.WA_GATEWAY_WEBHOOK_SECRET or "dev-webhook-secret"
    headers = {"X-Webhook-Secret": secret}
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        backup_payload = {
            "session_name": "TestSessionAuth123",
            "auth_bundle": {
                "creds.json": '{"registered":true,"me":{"id":"905551234567@s.whatsapp.net"}}',
                "pre-key-1.json": '{"keyId":1}',
            }
        }
        res = await ac.post(
            "/api/v1/whatsapp/webhook/session-backup",
            json=backup_payload,
            headers=headers,
        )
        assert res.status_code == 200
        assert res.json()["status"] == "success"

        res_get = await ac.get(
            "/api/v1/whatsapp/webhook/session-restore/TestSessionAuth123",
            headers=headers,
        )
        assert res_get.status_code == 200
        data = res_get.json()
        assert data["session_name"] == "TestSessionAuth123"
        assert "creds.json" in data["auth_bundle"]
        assert "pre-key-1.json" in data["auth_bundle"]

        res_all = await ac.get(
            "/api/v1/whatsapp/webhook/session-restore-all",
            headers=headers,
        )
        assert res_all.status_code == 200
        all_sessions = res_all.json()
        found = any(s["session_name"] == "TestSessionAuth123" for s in all_sessions)
        assert found is True
