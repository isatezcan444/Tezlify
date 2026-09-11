"""WhatsApp live integration tests (Phase 4).

Tests cover backend ↔ gateway ↔ frontend API contract consistency:
- Session lifecycle (create, list, QR, refresh, logout, delete)
- Contact sync, conversation listing, message retrieval
- Outbound text/media dispatch with idempotent client_message_id
- Gateway event ingestion (ingest_gateway_event) with jid→numeric ID mapping
- Response field consistency (logout/delete return `status` field)
- Fail-closed behavior when gateway is unreachable
"""
import base64
import json
import uuid as _uuid
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text, select
from unittest.mock import AsyncMock, patch

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp_service import ingest_gateway_event

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
SYS_USER_HEX = "00000000000000000000000000000000"
MOCK_PHONE = "+905321002030"
MOCK_JID = "905321002030@s.whatsapp.net"
# Legacy test user_ids from prior runs (string, not hex UUID)
LEGACY_UIDS = ["testuserwa", "system"]


def _make_jwt(user_id: str = TEST_USER) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({
            "sub": user_id,
            "email": "wa-test@tezlify.com",
            "user_metadata": {"full_name": "WA Test User"},
        }).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.mock_sig"


def _auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def auth_token():
    return _make_jwt()


@pytest.fixture
def auth_headers(auth_token):
    return _auth_headers(auth_token)


def _mock_session(gateway_id: str) -> dict:
    return {
        "id": gateway_id,
        "session_name": "Test Hat",
        "status": "SCAN_QR",
        "qr_code": "data:image/png;base64,TESTQR==",
        "phone_number": None,
        "is_phone_online": False,
        "battery_level": None,
        "is_active": True,
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture(autouse=True)
async def _cleanup_whatsapp_tables():
    """Wipe WhatsApp-related rows before and after each test for isolation.

    SQLite stores Uuid(as_uuid=False) as hex-without-dashes, so we match both
    formats plus legacy string user_ids from prior test runs.
    """
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(text("DELETE FROM whatsapp_sessions WHERE user_id IN (:h1, :h2, :l1, :l2)"),
                             {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX, "l1": "testuserwa", "l2": "system"})
            await db.execute(text("DELETE FROM messages WHERE user_id IN (:h1, :h2, :l1, :l2)"),
                             {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX, "l1": "testuserwa", "l2": "system"})
            await db.execute(
                text("DELETE FROM conversations WHERE (user_id IN (:h1, :h2, :l1, :l2)) AND channel = 'WHATSAPP'"),
                {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX, "l1": "testuserwa", "l2": "system"},
            )
            await db.execute(
                text("DELETE FROM contacts WHERE (user_id IN (:h1, :h2, :l1, :l2)) AND phone_e164 = :phone"),
                {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX, "l1": "testuserwa", "l2": "system", "phone": MOCK_PHONE},
            )
            await db.execute(
                text("DELETE FROM contacts WHERE (user_id IN (:h1, :h2)) AND phone_e164 LIKE 'jid:%@g.us'"),
                {"h1": TEST_USER_HEX, "h2": SYS_USER_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


@pytest.fixture
def mock_gateway():
    """Patch all gateway functions with AsyncMock returning realistic data."""
    patches = []
    gw_id = str(_uuid.uuid4())

    def _patch(name: str, return_value: Any):
        p = patch(f"backend.app.services.whatsapp_gateway.{name}", new_callable=AsyncMock, return_value=return_value)
        patches.append(p)
        return p.start()

    gateway = _patch("health", {"status": "ok", "service": "tezlify-whatsapp-gateway", "sessions": 0})
    gateway_list = _patch("list_sessions", [])
    create = _patch("create_session", _mock_session(gw_id))
    gw_status = _patch("get_session_status", {"status": "CONNECTED", "phone_number": MOCK_PHONE, "is_phone_online": True, "battery_level": 95})
    qr = _patch("get_session_qr", {"status": "SCAN_QR", "qr_code": "data:image/png;base64,TESTQR==", "phone": None})
    refresh = _patch("refresh_session_qr", {"status": "SCAN_QR", "qr_code": "data:image/png;base64,NEWQR=="})
    logout = _patch("logout_session", {"success": True})
    delete = _patch("delete_session", {"success": True})
    contacts = _patch("list_contacts", [{"id": MOCK_JID, "phone": MOCK_PHONE, "name": "Test Lead", "avatar_url": None}])
    convs = _patch("list_conversations", {"items": [], "total": 0})
    messages = _patch("get_messages", {"messages": [], "has_more": False})
    send_text = _patch("send_text_message", {
        "id": 1, "wa_message_id": "wamid123", "client_message_id": "cmsg_123",
        "status": "SENT", "body": "Merhaba",
    })
    send_media = _patch("send_media_message", {
        "id": 2, "wa_message_id": "wamid456", "client_message_id": "media_456",
        "status": "SENT", "body": "Test caption",
    })
    mark_read = _patch("mark_conversation_read", {"success": True})
    typing = _patch("send_typing", {"success": True})
    fetch_media = _patch("fetch_media", b"FAKE_MEDIA_BYTES")

    yield type("MockGW", (), {
        "health": gateway,
        "list_sessions": gateway_list,
        "create_session": create,
        "get_session_status": gw_status,
        "get_session_qr": qr,
        "refresh_session_qr": refresh,
        "logout_session": logout,
        "delete_session": delete,
        "list_contacts": contacts,
        "list_conversations": convs,
        "get_messages": messages,
        "send_text_message": send_text,
        "send_media_message": send_media,
        "mark_conversation_read": mark_read,
        "send_typing": typing,
        "fetch_media": fetch_media,
        "_gateway_id": gw_id,
    })()

    for p in patches:
        p.stop()


def _fixture(auth_headers):
    """Helper to get an authenticated ASGITransport client."""
    transport = ASGITransport(app=app)
    return transport, {"Authorization": auth_headers["Authorization"]}


# ---------------------------------------------------------------------------
# Session lifecycle tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_session_returns_gateway_mapping(auth_headers, mock_gateway):
    """POST /sessions creates a DB record with gateway_id mapped to integer ID."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Test Hat"}, headers=auth_headers)
        assert res.status_code == 201
        data = res.json()
        assert data["id"] > 0
        assert data["session_name"] == "Test Hat"
        assert data["status"] == "SCAN_QR"
        assert data["qr_code"] is not None
        assert data["is_active"] is True
    mock_gateway.create_session.assert_called_once()


@pytest.mark.asyncio
async def test_list_sessions_returns_db_rows(auth_headers, mock_gateway):
    """GET /sessions returns DB-persisted sessions (integer IDs)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post("/api/v1/whatsapp/sessions", json={"name": "List Test"}, headers=auth_headers)
        res = await client.get("/api/v1/whatsapp/sessions", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "sessions" in data
        assert len(data["sessions"]) >= 1
        assert data["sessions"][0]["id"] > 0


@pytest.mark.asyncio
async def test_list_sessions_returns_persisted_rows_when_gateway_is_unreachable(auth_headers, mock_gateway):
    """A gateway outage must not turn the session list into a 502 response."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Offline List Test"}, headers=auth_headers)
        session_id = create_res.json()["id"]
        with patch(
            "backend.app.services.whatsapp_gateway.list_sessions",
            new_callable=AsyncMock,
            side_effect=gw.WhatsAppGatewayError("Gateway unreachable"),
        ):
            res = await client.get("/api/v1/whatsapp/sessions", headers=auth_headers)

    assert res.status_code == 200
    assert any(session["id"] == session_id for session in res.json()["sessions"])


@pytest.mark.asyncio
async def test_get_session_qr_returns_status_and_phone(auth_headers, mock_gateway):
    """GET /sessions/{id}/qr returns {status, qr_code, phone}."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "QR Test"}, headers=auth_headers)
        session_id = create_res.json()["id"]

        res = await client.get(f"/api/v1/whatsapp/sessions/{session_id}/qr", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "status" in data
        assert "qr_code" in data
        assert "phone" in data


@pytest.mark.asyncio
async def test_refresh_session_qr_returns_status_and_qr(auth_headers, mock_gateway):
    """POST /sessions/{id}/qr/refresh returns {status, qr_code, phone}. WhatsAppQrResponse excludes success."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Refresh Test"}, headers=auth_headers)
        session_id = create_res.json()["id"]

        res = await client.post(f"/api/v1/whatsapp/sessions/{session_id}/qr/refresh", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "status" in data
        assert "qr_code" in data
        assert "success" not in data


@pytest.mark.asyncio
async def test_logout_session_returns_status_field(auth_headers, mock_gateway):
    """POST /sessions/{id}/logout must return `status` field (not just `message`)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Logout Test"}, headers=auth_headers)
        session_id = create_res.json()["id"]

        res = await client.post(f"/api/v1/whatsapp/sessions/{session_id}/logout", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert data["success"] is True
        assert data["status"] == "DISCONNECTED"


@pytest.mark.asyncio
async def test_delete_session_returns_status_field(auth_headers, mock_gateway):
    """DELETE /sessions/{id} must return `status` field."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Delete Test"}, headers=auth_headers)
        session_id = create_res.json()["id"]

        res = await client.delete(f"/api/v1/whatsapp/sessions/{session_id}", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert data["success"] is True
        assert data["status"] == "DISCONNECTED"


# ---------------------------------------------------------------------------
# Fail-closed tests — gateway unreachable → 502, no false positives
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_gateway_unreachable_returns_502(auth_headers):
    """When gateway is down, POST /sessions returns 502 — no false success."""
    patches = []
    for name in ["create_session", "list_sessions", "get_session_qr"]:
        p = patch(f"backend.app.services.whatsapp_gateway.{name}", new_callable=AsyncMock,
                  side_effect=gw.WhatsAppGatewayError("Gateway unreachable"))
        p.start()
        patches.append(p)
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Down Test"}, headers=auth_headers)
            assert res.status_code == 502
            assert "gateway" in res.json()["detail"].lower()
    finally:
        for p in patches:
            p.stop()


@pytest.mark.asyncio
async def test_session_not_found_returns_404(auth_headers):
    """GET /sessions/{nonexistent}/qr returns 404."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/whatsapp/sessions/99999/qr", headers=auth_headers)
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# Contacts & conversations tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_contacts_returns_contact_list(auth_headers, mock_gateway):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/whatsapp/contacts", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "contacts" in data
        assert len(data["contacts"]) >= 1
        assert data["contacts"][0]["phone"] == MOCK_PHONE


@pytest.mark.asyncio
async def test_get_conversations_empty(auth_headers, mock_gateway):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/whatsapp/conversations", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "items" in data
        assert "total" in data
        assert data["total"] == 0


# ---------------------------------------------------------------------------
# Message sending tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_text_message_returns_wa_message_id(auth_headers, mock_gateway):
    """POST /conversations/{id}/messages returns WhatsAppSendResult with wa_message_id."""
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=0,
        )
        db.add(conv)
        await db.flush()
        conv_id = conv.id
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/whatsapp/conversations/{conv_id}/messages",
            json={"body": "Merhaba", "client_message_id": "cmsg_test_1"},
            headers=auth_headers,
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "SENT"
        assert data["wa_message_id"] == "wamid123"
        assert data["client_message_id"] == "cmsg_test_1"


@pytest.mark.asyncio
async def test_send_text_empty_body_rejected_by_validation(auth_headers, mock_gateway):
    """POST /conversations/{id}/messages with empty body is rejected by Pydantic validation (422)."""
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=0,
        )
        db.add(conv)
        await db.flush()
        conv_id = conv.id
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/whatsapp/conversations/{conv_id}/messages",
            json={"body": "", "client_message_id": "cmsg_empty"},
            headers=auth_headers,
        )
        assert res.status_code == 422


# ---------------------------------------------------------------------------
# Gateway event ingestion tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ingest_message_new_maps_jid_to_conversation():
    """ingest_gateway_event('message_new') maps jid → numeric conversation_id."""
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=0,
        )
        db.add(conv)
        await db.flush()

        # CONNECTED session so _resolve_event_owner resolves to TEST_USER
        session = WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
            session_name="Connected", status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(session)
        await db.flush()
        conv_id = conv.id
        await db.commit()

    event = {
        "event": "message_new",
        "conversation_id": MOCK_JID,
        "message": {
            "body": "Hello from gateway",
            "direction": "INBOUND",
            "message_type": "TEXT",
            "wa_message_id": "wamid_new",
            "sender_name": "Test Lead",
            "created_at": "2025-01-15T10:00:00Z",
        },
    }

    result = await ingest_gateway_event(event)
    assert result["conversation_id"] == conv_id
    assert "message" in result

    # Verify message was persisted
    async with AsyncSessionLocal() as db:
        msg_res = await db.execute(select(Message).where(Message.wa_message_id == "wamid_new"))
        msg = msg_res.scalar_one_or_none()
        assert msg is not None
        assert msg.conversation_id == conv_id
        assert msg.direction == MessageDirection.INBOUND
        assert msg.status == ConversationMessageStatus.RECEIVED


@pytest.mark.asyncio
async def test_ingest_session_event_maps_gateway_id():
    """ingest_gateway_event('session_connected') maps gateway UUID → DB session ID."""
    gw_id = str(_uuid.uuid4())
    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=gw_id,
            session_name="Test Session",
            status=SessionStatus.SCAN_QR,
            is_active=True,
        )
        db.add(session)
        await db.commit()
        db_session_id = session.id

    event = {
        "event": "session_connected",
        "session_id": gw_id,
        "phone": MOCK_PHONE,
        "status": "CONNECTED",
    }

    result = await ingest_gateway_event(event)
    assert result["session_id"] == db_session_id
    assert result["session_name"] == "Test Session"


@pytest.mark.asyncio
async def test_ingest_message_dedup_by_wa_message_id():
    """Duplicate wa_message_id should not create a second message."""
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=0,
        )
        db.add(conv)
        await db.flush()

        # Create a CONNECTED session so _resolve_event_owner resolves to TEST_USER
        session = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=str(_uuid.uuid4()),
            session_name="Connected Test",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add(session)
        await db.flush()

        existing = Message(
            user_id=TEST_USER,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            wa_message_id="wamid_dedup",
            status=ConversationMessageStatus.RECEIVED,
            body="Existing",
            sender_phone=MOCK_PHONE,
            recipient_phone=MOCK_PHONE,
        )
        db.add(existing)
        await db.commit()
        conv_id = conv.id

    event = {
        "event": "message_new",
        "conversation_id": MOCK_JID,
        "message": {
            "body": "Duplicate",
            "direction": "INBOUND",
            "message_type": "TEXT",
            "wa_message_id": "wamid_dedup",
        },
    }

    result = await ingest_gateway_event(event)
    assert result["conversation_id"] == conv_id

    async with AsyncSessionLocal() as db:
        msg_res = await db.execute(select(Message).where(Message.wa_message_id == "wamid_dedup"))
        msgs = msg_res.scalars().all()
        assert len(msgs) == 1
        assert msgs[0].body == "Existing"


@pytest.mark.asyncio
async def test_ingest_conversation_event_maps_jid():
    """ingest_gateway_event('conversation_read') maps jid → numeric conversation_id."""
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=5,
        )
        db.add(conv)
        # CONNECTED session so _resolve_event_owner resolves to TEST_USER
        session = WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
            session_name="Connected", status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(session)
        await db.commit()
        conv_id = conv.id

    event = {
        "event": "conversation_read",
        "conversation_id": MOCK_JID,
    }

    result = await ingest_gateway_event(event)
    assert result["conversation_id"] == conv_id

    async with AsyncSessionLocal() as db:
        conv_res = await db.execute(select(Conversation).where(Conversation.id == conv_id))
        c = conv_res.scalar_one()
        assert c.unread_count == 0


# ---------------------------------------------------------------------------
# Model / schema contract tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_whatsapp_session_model_fields():
    """WhatsAppSession model has the expected fields."""
    assert hasattr(WhatsAppSession, "gateway_id")
    assert hasattr(WhatsAppSession, "session_name")
    assert hasattr(WhatsAppSession, "status")
    assert hasattr(WhatsAppSession, "phone_number")
    assert hasattr(WhatsAppSession, "is_active")
    assert hasattr(WhatsAppSession, "is_phone_online")
    assert hasattr(WhatsAppSession, "battery_level")
    assert hasattr(WhatsAppSession, "qr_code")
    assert hasattr(WhatsAppSession, "error_message")


@pytest.mark.asyncio
async def test_whatsapp_status_result_has_status_field():
    """WhatsAppStatusResult schema includes `status` field for frontend consistency."""
    from backend.app.schemas.whatsapp import WhatsAppStatusResult
    result = WhatsAppStatusResult(success=True, message="Oturum silindi", status="DISCONNECTED")
    assert result.success is True
    assert result.status == "DISCONNECTED"
    json_data = result.model_dump()
    assert "status" in json_data


# ---------------------------------------------------------------------------
# Faz 2 — WhatsApp Web parity: typing, base64 media, media proxy, acks
# ---------------------------------------------------------------------------

async def _make_conv() -> int:
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=0,
        )
        db.add(conv)
        await db.flush()
        conv_id = conv.id
        await db.commit()
    return conv_id


@pytest.mark.asyncio
async def test_send_typing_endpoint(auth_headers, mock_gateway):
    """POST /conversations/{id}/typing delegates to gateway send_typing."""
    conv_id = await _make_conv()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/whatsapp/conversations/{conv_id}/typing",
            json={"typing": True},
            headers=auth_headers,
        )
        assert res.status_code == 200
        assert res.json()["success"] is True
    mock_gateway.send_typing.assert_awaited()


@pytest.mark.asyncio
async def test_send_media_requires_url_or_base64(auth_headers, mock_gateway):
    """POST /conversations/{id}/media without media_url and media_base64 → 400."""
    conv_id = await _make_conv()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/whatsapp/conversations/{conv_id}/media",
            json={"media_type": "image"},
            headers=auth_headers,
        )
        assert res.status_code == 400


@pytest.mark.asyncio
async def test_send_media_base64_forwards_to_gateway(auth_headers, mock_gateway):
    """POST /conversations/{id}/media with media_base64 forwards payload to gateway."""
    conv_id = await _make_conv()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/whatsapp/conversations/{conv_id}/media",
            json={
                "media_type": "image",
                "media_base64": "aW1hZ2U=",
                "mime_type": "image/png",
                "filename": "test.png",
                "caption": "merhaba",
            },
            headers=auth_headers,
        )
        assert res.status_code == 200
        assert res.json()["status"] == "SENT"
    mock_gateway.send_media_message.assert_awaited()
    kwargs = mock_gateway.send_media_message.await_args.args[1]
    assert kwargs["media_base64"] == "aW1hZ2U="
    assert kwargs["mime_type"] == "image/png"


@pytest.mark.asyncio
async def test_media_proxy_endpoint(auth_headers, mock_gateway):
    """GET /media/{media_id} proxies gateway bytes for the owner's message."""
    conv_id = await _make_conv()
    async with AsyncSessionLocal() as db:
        msg = Message(
            user_id=TEST_USER, conversation_id=conv_id,
            direction=MessageDirection.INBOUND, message_type=MessageType.IMAGE,
            status=ConversationMessageStatus.RECEIVED,
            media_id="media-abc-123", media_mime_type="image/png",
            media_filename="photo.png", sender_phone=MOCK_PHONE, recipient_phone="ME",
        )
        db.add(msg)
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/whatsapp/media/media-abc-123", headers=auth_headers)
        assert res.status_code == 200
        assert res.content == b"FAKE_MEDIA_BYTES"
        assert res.headers["content-type"] == "image/png"
        # Unknown media id → 404 (fail closed, no fake data)
        res404 = await client.get("/api/v1/whatsapp/media/does-not-exist", headers=auth_headers)
        assert res404.status_code == 404


@pytest.mark.asyncio
async def test_serialize_message_exposes_media_proxy_url():
    """Incoming media messages serialize with a /api/v1/whatsapp/media/{id} URL."""
    conv_id = await _make_conv()
    async with AsyncSessionLocal() as db:
        msg = Message(
            user_id=TEST_USER, conversation_id=conv_id,
            direction=MessageDirection.INBOUND, message_type=MessageType.IMAGE,
            status=ConversationMessageStatus.RECEIVED,
            media_id="media-url-1", media_mime_type="image/jpeg",
            sender_phone=MOCK_PHONE, recipient_phone="ME",
        )
        db.add(msg)
        await db.commit()
        from backend.app.services.whatsapp_service import _serialize_message
        serialized = _serialize_message(msg)
    assert serialized["media_url"] == "/api/v1/whatsapp/media/media-url-1"


@pytest.mark.asyncio
async def test_ingest_message_status_updated_persists_acks():
    """message_status_updated events move outbound status forward: SENT→DELIVERED→READ."""
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=0,
        )
        db.add(conv)
        await db.flush()
        session = WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid.uuid4()),
            session_name="Connected", status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(session)
        msg = Message(
            user_id=TEST_USER, conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND, message_type=MessageType.TEXT,
            status=ConversationMessageStatus.SENT, wa_message_id="wamid_ack_1",
            body="hi", sender_phone="ME", recipient_phone=MOCK_PHONE,
        )
        db.add(msg)
        await db.commit()
        conv_id = conv.id

    async def _ingest(status: str):
        return await ingest_gateway_event({
            "event": "message_status_updated",
            "conversation_id": MOCK_JID,
            "wa_message_id": "wamid_ack_1",
            "status": status,
        })

    result = await _ingest("DELIVERED")
    assert result["conversation_id"] == conv_id
    async with AsyncSessionLocal() as db:
        row = (await db.execute(select(Message).where(Message.wa_message_id == "wamid_ack_1"))).scalar_one()
        assert row.status == ConversationMessageStatus.DELIVERED
        assert row.delivered_at is not None

    await _ingest("READ")
    async with AsyncSessionLocal() as db:
        row = (await db.execute(select(Message).where(Message.wa_message_id == "wamid_ack_1"))).scalar_one()
        assert row.status == ConversationMessageStatus.READ
        assert row.read_at is not None

    # Acks never move backwards (READ must not downgrade to SENT)
    await _ingest("SENT")
    async with AsyncSessionLocal() as db:
        row = (await db.execute(select(Message).where(Message.wa_message_id == "wamid_ack_1"))).scalar_one()
        assert row.status == ConversationMessageStatus.READ


@pytest.mark.asyncio
async def test_ingest_presence_updated_maps_jid_and_types():
    """ingest_gateway_event('presence_updated') maps jid → numeric id and adds typing flag."""
    import uuid as _uuid2

    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=2,
        )
        db.add(conv)
        session = WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid2.uuid4()),
            session_name="Connected", status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(session)
        await db.commit()
        conv_id = conv.id

    result = await ingest_gateway_event({
        "event": "presence_updated",
        "conversation_id": MOCK_JID,
        "presence": "composing",
    })
    assert result["conversation_id"] == conv_id
    assert result["typing"] is True

    result_paused = await ingest_gateway_event({
        "event": "presence_updated",
        "conversation_id": MOCK_JID,
        "presence": "paused",
    })
    assert result_paused["conversation_id"] == conv_id
    assert result_paused["typing"] is False

    # Presence must not touch unread counts
    async with AsyncSessionLocal() as db:
        c = (await db.execute(select(Conversation).where(Conversation.id == conv_id))).scalar_one()
        assert c.unread_count == 2


# ---------------------------------------------------------------------------
# Faz 4 — history sync / conversation sync tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_conversations_pulls_messages_from_gateway(auth_headers, mock_gateway):
    """GET /conversations?sync=true must pull chat list AND per-chat history from the gateway."""
    mock_gateway.list_conversations.return_value = {
        "items": [
            {
                "jid": MOCK_JID,
                "name": "Ayse Yilmaz",
                "last_message_preview": "Merhaba",
                "last_message_at": "2025-01-15T10:00:00.000Z",
                "unread_count": 3,
            }
        ],
        "total": 1,
    }
    mock_gateway.get_messages.return_value = {
        "messages": [
            {
                "conversation_id": MOCK_JID,
                "direction": "INBOUND",
                "message_type": "TEXT",
                "status": "RECEIVED",
                "body": "Merhaba",
                "wa_message_id": "wamid_hist_1",
                "sender_phone": MOCK_PHONE,
                "recipient_phone": "ME",
                "created_at": "2025-01-15T09:59:00.000Z",
            },
            {
                "conversation_id": MOCK_JID,
                "direction": "OUTBOUND",
                "message_type": "TEXT",
                "status": "SENT",
                "body": "Aleykum selam",
                "wa_message_id": "wamid_hist_2",
                "sender_phone": "ME",
                "recipient_phone": MOCK_PHONE,
                "created_at": "2025-01-15T10:00:00.000Z",
            },
        ],
        "has_more": False,
    }

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/whatsapp/conversations?sync=true", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert data["total"] >= 1
        conv = data["items"][0]
        assert conv["name"] == "Ayse Yilmaz"
        assert conv["unread_count"] == 3
        conv_id = conv["id"]

        # Messages must now be visible through the numeric-id API
        res2 = await client.get(
            f"/api/v1/whatsapp/conversations/{conv_id}/messages", headers=auth_headers
        )
        assert res2.status_code == 200
        bodies = [m["body"] for m in res2.json()["messages"]]
        assert "Merhaba" in bodies
        assert "Aleykum selam" in bodies


@pytest.mark.asyncio
async def test_sync_conversations_dedups_history_messages(auth_headers, mock_gateway):
    """Re-running sync must not duplicate messages (wa_message_id dedup)."""
    mock_gateway.list_conversations.return_value = {
        "items": [{"jid": MOCK_JID, "name": "Dedup Test", "last_message_preview": "x",
                   "last_message_at": "2025-01-15T10:00:00.000Z", "unread_count": 0}],
        "total": 1,
    }
    mock_gateway.get_messages.return_value = {
        "messages": [
            {"conversation_id": MOCK_JID, "direction": "INBOUND", "message_type": "TEXT",
             "status": "RECEIVED", "body": "tek", "wa_message_id": "wamid_dedup_1",
             "sender_phone": MOCK_PHONE, "recipient_phone": "ME",
             "created_at": "2025-01-15T09:00:00.000Z"},
        ],
        "has_more": False,
    }

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r1 = await client.get("/api/v1/whatsapp/conversations?sync=true", headers=auth_headers)
        assert r1.status_code == 200
        conv_id = r1.json()["items"][0]["id"]
        # second sync — same gateway payload
        r2 = await client.get("/api/v1/whatsapp/conversations?sync=true", headers=auth_headers)
        assert r2.status_code == 200

        res = await client.get(f"/api/v1/whatsapp/conversations/{conv_id}/messages", headers=auth_headers)
        msgs = res.json()["messages"]
        assert len([m for m in msgs if m["wa_message_id"] == "wamid_dedup_1"]) == 1


@pytest.mark.asyncio
async def test_ingest_conversation_updated_persists_fields():
    """ingest_gateway_event('conversation_updated') persists name/preview/unread from history sync."""
    import uuid as _uuid3

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid3.uuid4()),
            session_name="Connected", status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(session)
        await db.commit()

    event = await ingest_gateway_event({
        "event": "conversation_updated",
        "conversation_id": MOCK_JID,
        "conversation": {
            "name": "Mehmet Demir",
            "last_message_preview": "Gorusek",
            "last_message_at": "2025-01-15T12:00:00.000Z",
            "unread_count": 5,
        },
    })
    assert isinstance(event["conversation_id"], int)

    async with AsyncSessionLocal() as db:
        conv = (await db.execute(
            select(Conversation).where(Conversation.id == event["conversation_id"])
        )).scalar_one()
        assert conv.last_message_preview == "Gorusek"
        assert conv.unread_count == 5
        assert conv.last_message_at is not None
        contact = (await db.execute(
            select(Contact).where(Contact.id == conv.contact_id)
        )).scalar_one()
        assert contact.display_name == "Mehmet Demir"


@pytest.mark.asyncio
async def test_sync_conversations_survives_history_pull_failure(auth_headers, mock_gateway):
    """If per-chat history pull fails, sync still returns the chat list (graceful degradation)."""
    mock_gateway.list_conversations.return_value = {
        "items": [{"jid": MOCK_JID, "name": "Kismen", "last_message_preview": "p",
                   "last_message_at": "2025-01-15T10:00:00.000Z", "unread_count": 1}],
        "total": 1,
    }
    mock_gateway.get_messages.side_effect = Exception("gateway boom")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/whatsapp/conversations?sync=true", headers=auth_headers)
        assert res.status_code == 200
        assert res.json()["total"] >= 1
        assert res.json()["items"][0]["name"] == "Kismen"


# ---------------------------------------------------------------------------
# Faz 5 — okundu çentikleri, grup sohbetleri ve avatar/parite
# ---------------------------------------------------------------------------

GROUP_JID = "120363000000000000@g.us"


@pytest.mark.asyncio
async def test_mark_conversation_read_endpoint(auth_headers, mock_gateway):
    """POST /conversations/{id}/read delegates to gateway and zeroes unread."""
    async with AsyncSessionLocal() as db:
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="Test Lead")
        db.add(contact)
        await db.flush()
        conv = Conversation(
            user_id=TEST_USER, contact_id=contact.id, channel="WHATSAPP",
            status=ConversationStatus.ACTIVE, unread_count=7,
        )
        db.add(conv)
        await db.flush()
        conv_id = conv.id
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/whatsapp/conversations/{conv_id}/read", headers=auth_headers
        )
        assert res.status_code == 200
        assert res.json()["success"] is True
    mock_gateway.mark_conversation_read.assert_awaited()
    # gateway'e jid gonderildi
    called_jid = mock_gateway.mark_conversation_read.await_args.args[0]
    assert called_jid == MOCK_JID

    async with AsyncSessionLocal() as db:
        conv = (await db.execute(
            select(Conversation).where(Conversation.id == conv_id)
        )).scalar_one()
        assert conv.unread_count == 0


@pytest.mark.asyncio
async def test_mark_conversation_read_survives_gateway_failure(auth_headers, mock_gateway):
    """If the gateway is unreachable, read still clears DB unread (fail-soft) and returns success."""
    conv_id = await _make_conv()
    mock_gateway.mark_conversation_read.side_effect = Exception("gateway down")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            f"/api/v1/whatsapp/conversations/{conv_id}/read", headers=auth_headers
        )
        assert res.status_code == 200
        assert res.json()["success"] is True


@pytest.mark.asyncio
async def test_group_conversation_sync_sets_is_group_and_name(auth_headers, mock_gateway):
    """A group chat syncs with is_group=True, its subject name, and a jid: sentinel phone."""
    mock_gateway.list_conversations.return_value = {
        "items": [{
            "jid": GROUP_JID, "id": GROUP_JID, "name": "Satici Ekip",
            "is_group": True, "avatar_url": "https://mmg.whatsapp.net/g1.jpg",
            "last_message_preview": "Toplanti 15:00", "last_message_at": "2025-01-15T10:00:00.000Z",
            "unread_count": 2,
        }],
        "total": 1,
    }
    mock_gateway.get_messages.return_value = {"messages": [], "has_more": False}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/whatsapp/conversations?sync=true", headers=auth_headers)
        assert res.status_code == 200
        items = res.json()["items"]
        grp = next((i for i in items if i.get("is_group")), None)
        assert grp is not None, "group conversation should be present with is_group=True"
        assert grp["name"] == "Satici Ekip"
        assert grp["avatar_url"] == "https://mmg.whatsapp.net/g1.jpg"
        assert "@g.us" in grp["phone"]

    # Contact phone_e164 should use the jid: sentinel (groups have no E.164 phone)
    async with AsyncSessionLocal() as db:
        contact = (await db.execute(
            select(Contact).where(
                Contact.user_id == TEST_USER, Contact.phone_e164 == f"jid:{GROUP_JID}"
            )
        )).scalar_one()
        assert contact.display_name == "Satici Ekip"
        assert contact.custom_attributes and contact.custom_attributes.get("avatar_url") == "https://mmg.whatsapp.net/g1.jpg"


@pytest.mark.asyncio
async def test_resolve_jid_for_group_returns_group_jid(auth_headers, mock_gateway):
    """Read on a group conversation resolves back to the @g.us JID (via jid: sentinel)."""
    mock_gateway.list_conversations.return_value = {
        "items": [{"jid": GROUP_JID, "id": GROUP_JID, "name": "G", "is_group": True,
                   "last_message_at": "2025-01-15T10:00:00.000Z", "unread_count": 1}],
        "total": 1,
    }
    mock_gateway.get_messages.return_value = {"messages": [], "has_more": False}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        sync = await client.get("/api/v1/whatsapp/conversations?sync=true", headers=auth_headers)
        grp = next(i for i in sync.json()["items"] if i.get("is_group"))
        res = await client.post(f"/api/v1/whatsapp/conversations/{grp['id']}/read", headers=auth_headers)
        assert res.status_code == 200
    called_jid = mock_gateway.mark_conversation_read.await_args.args[0]
    assert called_jid == GROUP_JID


@pytest.mark.asyncio
async def test_ingest_contact_synced_persists_avatar():
    """ingest_gateway_event('contact_synced') writes name + avatar onto an existing contact."""
    import uuid as _uuid4

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid4.uuid4()),
            session_name="Connected", status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(session)
        # Pre-existing contact (phone-like display name to be upgraded)
        contact = Contact(user_id=TEST_USER, phone_e164=MOCK_PHONE, display_name="+905321002030")
        db.add(contact)
        await db.commit()

    await ingest_gateway_event({
        "event": "contact_synced",
        "contact": {"id": MOCK_JID, "name": "Ayse Kaya", "avatar_url": "https://cdn/a.jpg"},
    })

    async with AsyncSessionLocal() as db:
        contact = (await db.execute(
            select(Contact).where(Contact.user_id == TEST_USER, Contact.phone_e164 == MOCK_PHONE)
        )).scalar_one()
        assert contact.display_name == "Ayse Kaya"
        assert contact.custom_attributes.get("avatar_url") == "https://cdn/a.jpg"


@pytest.mark.asyncio
async def test_ingest_conversation_updated_persists_avatar():
    """conversation_updated with avatar_url persists it to the contact for live UI updates."""
    import uuid as _uuid5

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=TEST_USER, gateway_id=str(_uuid5.uuid4()),
            session_name="Connected", status=SessionStatus.CONNECTED, is_active=True,
        )
        db.add(session)
        await db.commit()

    # jid lives only inside the conversation object (gateway omits top-level id)
    event = await ingest_gateway_event({
        "event": "conversation_updated",
        "conversation": {
            "id": MOCK_JID, "jid": MOCK_JID,
            "name": "Fatma Sel",
            "avatar_url": "https://cdn/f.jpg",
            "unread_count": 3,
        },
    })
    assert isinstance(event["conversation_id"], int)

    async with AsyncSessionLocal() as db:
        conv = (await db.execute(
            select(Conversation).where(Conversation.id == event["conversation_id"])
        )).scalar_one()
        contact = (await db.execute(
            select(Contact).where(Contact.id == conv.contact_id)
        )).scalar_one()
        assert contact.display_name == "Fatma Sel"
        assert contact.custom_attributes.get("avatar_url") == "https://cdn/f.jpg"
