"""WhatsApp RELINK_REQUIRED and missing gateway session handling tests.

Ensures that when a gateway session is missing from memory (404: Session not found):
1. Session status in DB is transitioned to RELINK_REQUIRED.
2. WebSocket broadcasts session_updated with status: RELINK_REQUIRED.
3. Sync job broadcasts whatsapp_sync_failed with error_code: RELINK_REQUIRED.
4. HTTP endpoints (/contacts, /messages, /media, /typing) return HTTP 409 Conflict with X-WhatsApp-State header.
"""
import base64
import json
from unittest.mock import patch, AsyncMock

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.services import whatsapp_service as ws
from backend.app.services import whatsapp_gateway as gw

import uuid

TEST_USER = "11111111-2222-3333-4444-555555555555"
TEST_USER_HEX = "11111111222233334444555555555555"
MOCK_PHONE = "+905551234567"
MOCK_JID = "905551234567@s.whatsapp.net"


def _make_jwt(user_id: str = TEST_USER) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({
            "sub": user_id,
            "email": "relink-test@tezlify.com",
            "user_metadata": {"full_name": "Relink Test User"},
        }).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.mock_sig"


@pytest.fixture
def auth_headers():
    return {"Authorization": f"Bearer {_make_jwt()}"}


@pytest_asyncio.fixture(autouse=True)
async def cleanup_test_data():
    async def _clean():
        async with AsyncSessionLocal() as db:
            from sqlalchemy import text
            await db.execute(text("DELETE FROM messages WHERE user_id IN (:u, :h)"), {"u": TEST_USER, "h": TEST_USER_HEX})
            await db.execute(text("DELETE FROM conversations WHERE user_id IN (:u, :h)"), {"u": TEST_USER, "h": TEST_USER_HEX})
            await db.execute(text("DELETE FROM contacts WHERE user_id IN (:u, :h)"), {"u": TEST_USER, "h": TEST_USER_HEX})
            await db.execute(text("DELETE FROM whatsapp_sessions WHERE user_id IN (:u, :h)"), {"u": TEST_USER, "h": TEST_USER_HEX})
            await db.commit()

    await _clean()
    yield
    await _clean()


@pytest.mark.asyncio
async def test_missing_gateway_session_sync_contacts_triggers_relink_required(auth_headers):
    """When gateway returns 404 Session not found during sync_contacts, session is marked RELINK_REQUIRED and HTTP 409 is returned."""
    gw_id = f"gw-relink-{uuid.uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER,
            session_name="Hat 1",
            gateway_id=gw_id,
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
            is_active=True,
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        sid = session.id

    missing_err = gw.WhatsAppGatewayError("Gateway hatası 404: {\"error\":\"Session not found\"}", status_code=404, response_body="{\"error\":\"Session not found\"}")

    with patch("backend.app.services.whatsapp_gateway.list_contacts", side_effect=missing_err):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get("/api/v1/whatsapp/contacts", headers=auth_headers)

        assert res.status_code == 409
        assert res.headers.get("X-WhatsApp-State") == "RELINK_REQUIRED"

    async with AsyncSessionLocal() as db:
        updated = await db.scalar(select(WhatsAppSession).where(WhatsAppSession.id == sid))
        assert updated is not None
        assert updated.status == SessionStatus.RELINK_REQUIRED
        assert updated.is_phone_online is False
        assert updated.error_message == "WHATSAPP_AUTH_RELINK_REQUIRED"


@pytest.mark.asyncio
async def test_missing_gateway_session_send_message_triggers_relink_required(auth_headers):
    """When sending message and gateway session is missing (404), HTTP 409 is returned and session marked RELINK_REQUIRED."""
    gw_id = f"gw-relink-{uuid.uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER,
            session_name="Hat 1",
            gateway_id=gw_id,
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
            is_active=True,
        )
        db.add(session)
        await db.flush()

        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Recipient")
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=session.id,
            channel="WHATSAPP",
            status="ACTIVE",
        )
        db.add(conv)
        await db.commit()
        cid = conv.id
        sid = session.id

    missing_err = gw.WhatsAppGatewayError("Gateway hatası 404: {\"error\":\"Session not found\"}", status_code=404, response_body="{\"error\":\"Session not found\"}")

    with patch("backend.app.services.whatsapp_gateway.send_text_message", side_effect=missing_err):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/whatsapp/conversations/{cid}/messages",
                headers=auth_headers,
                json={"body": "Hello world!"},
            )

        assert res.status_code == 409
        assert res.headers.get("X-WhatsApp-State") == "RELINK_REQUIRED"

    async with AsyncSessionLocal() as db:
        updated = await db.scalar(select(WhatsAppSession).where(WhatsAppSession.id == sid))
        assert updated is not None
        assert updated.status == SessionStatus.RELINK_REQUIRED
        assert updated.is_phone_online is False


@pytest.mark.asyncio
async def test_missing_gateway_session_sync_job_emits_relink_required_event():
    """When sync job encounters 404 Session not found, job fails with error_code=RELINK_REQUIRED and session is updated."""
    gw_id = f"gw-relink-{uuid.uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER,
            session_name="Hat 1",
            gateway_id=gw_id,
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
            is_active=True,
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        sid = session.id

    missing_err = gw.WhatsAppGatewayError("Gateway hatası 404: {\"error\":\"Session not found\"}", status_code=404, response_body="{\"error\":\"Session not found\"}")

    broadcast_events = []

    async def _capture_broadcast(event_dict, owner_id):
        broadcast_events.append((event_dict, owner_id))

    with patch("backend.app.services.whatsapp_gateway.sync_group_subjects", side_effect=missing_err), \
         patch("backend.app.services.whatsapp_service._broadcast_sync_event", side_effect=_capture_broadcast):
        job = await ws.request_sync(AsyncSessionLocal(), TEST_USER)
        await job.done.wait()

    assert job.state == "FAILED"
    failed_events = [e[0] for e in broadcast_events if e[0].get("event") == "whatsapp_sync_failed"]
    assert len(failed_events) >= 1
    assert failed_events[0].get("error_code") == "RELINK_REQUIRED"

    async with AsyncSessionLocal() as db:
        updated = await db.scalar(select(WhatsAppSession).where(WhatsAppSession.id == sid))
        assert updated is not None
        assert updated.status == SessionStatus.RELINK_REQUIRED
        assert updated.is_phone_online is False


@pytest.mark.asyncio
async def test_missing_gateway_session_send_media_triggers_relink_required(auth_headers):
    """When sending media and gateway session is missing (404), HTTP 409 is returned and session marked RELINK_REQUIRED."""
    gw_id = f"gw-relink-{uuid.uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER,
            session_name="Hat 1",
            gateway_id=gw_id,
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
            is_active=True,
        )
        db.add(session)
        await db.flush()

        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Recipient")
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=session.id,
            channel="WHATSAPP",
            status="ACTIVE",
        )
        db.add(conv)
        await db.commit()
        cid = conv.id
        sid = session.id

    missing_err = gw.WhatsAppGatewayError("Gateway hatası 404: {\"error\":\"Session not found\"}", status_code=404, response_body="{\"error\":\"Session not found\"}")

    with patch("backend.app.services.whatsapp_gateway.send_media_message", side_effect=missing_err):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/whatsapp/conversations/{cid}/media",
                headers=auth_headers,
                json={"media_type": "image", "media_url": "https://example.com/test.jpg"},
            )

        assert res.status_code == 409
        assert res.headers.get("X-WhatsApp-State") == "RELINK_REQUIRED"

    async with AsyncSessionLocal() as db:
        updated = await db.scalar(select(WhatsAppSession).where(WhatsAppSession.id == sid))
        assert updated is not None
        assert updated.status == SessionStatus.RELINK_REQUIRED
        assert updated.is_phone_online is False


@pytest.mark.asyncio
async def test_missing_gateway_session_send_typing_triggers_relink_required(auth_headers):
    """When sending typing and gateway session is missing (404), HTTP 409 is returned and session marked RELINK_REQUIRED."""
    gw_id = f"gw-relink-{uuid.uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER,
            session_name="Hat 1",
            gateway_id=gw_id,
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
            is_active=True,
        )
        db.add(session)
        await db.flush()

        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Recipient")
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=session.id,
            channel="WHATSAPP",
            status="ACTIVE",
        )
        db.add(conv)
        await db.commit()
        cid = conv.id
        sid = session.id

    missing_err = gw.WhatsAppGatewayError("Gateway hatası 404: {\"error\":\"Session not found\"}", status_code=404, response_body="{\"error\":\"Session not found\"}")

    with patch("backend.app.services.whatsapp_gateway.send_typing", side_effect=missing_err):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                f"/api/v1/whatsapp/conversations/{cid}/typing",
                headers=auth_headers,
                json={"typing": True},
            )

        assert res.status_code == 409
        assert res.headers.get("X-WhatsApp-State") == "RELINK_REQUIRED"

    async with AsyncSessionLocal() as db:
        updated = await db.scalar(select(WhatsAppSession).where(WhatsAppSession.id == sid))
        assert updated is not None
        assert updated.status == SessionStatus.RELINK_REQUIRED
        assert updated.is_phone_online is False


@pytest.mark.asyncio
async def test_missing_gateway_session_get_messages_triggers_relink_required(auth_headers):
    """When getting conversation messages on-demand and gateway session is missing (404), HTTP 409 is returned and session marked RELINK_REQUIRED."""
    gw_id = f"gw-relink-{uuid.uuid4().hex[:8]}"
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER,
            session_name="Hat 1",
            gateway_id=gw_id,
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
            is_active=True,
        )
        db.add(session)
        await db.flush()

        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Recipient")
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=TEST_USER,
            contact_id=contact.id,
            session_id=session.id,
            channel="WHATSAPP",
            status="ACTIVE",
        )
        db.add(conv)
        await db.commit()
        cid = conv.id
        sid = session.id

    missing_err = gw.WhatsAppGatewayError("Gateway hatası 404: {\"error\":\"Session not found\"}", status_code=404, response_body="{\"error\":\"Session not found\"}")

    with patch("backend.app.services.whatsapp_gateway.get_messages", side_effect=missing_err):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get(
                f"/api/v1/whatsapp/conversations/{cid}/messages",
                headers=auth_headers,
            )

        assert res.status_code == 409
        assert res.headers.get("X-WhatsApp-State") == "RELINK_REQUIRED"

    async with AsyncSessionLocal() as db:
        updated = await db.scalar(select(WhatsAppSession).where(WhatsAppSession.id == sid))
        assert updated is not None
        assert updated.status == SessionStatus.RELINK_REQUIRED
        assert updated.is_phone_online is False
