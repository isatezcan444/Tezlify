"""Regression tests for Phase 13 WhatsApp QR Modal cancel lifecycle (TEST-QR-01 through TEST-QR-08).

Verifies that:
- Canceling or closing the QR modal deletes the pending session immediately.
- Zero orphan rows remain in public.whatsapp_sessions.
- Gateway cleanup (socket, credentials, socket lease) is invoked.
- Connected sessions are preserved.
- Consecutive attempts do not leave duplicate sessions.
"""
import uuid
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text, select, func
from unittest.mock import AsyncMock, patch

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.tests.test_whatsapp_live import _make_jwt, _auth_headers, TEST_USER, TEST_USER_HEX

TEST_QR_UID = "23456789-2345-2345-2345-234567890123"
TEST_QR_UID_HEX = "23456789234523452345234567890123"


@pytest.fixture
def qr_auth_headers():
    token = _make_jwt(user_id=TEST_QR_UID)
    return _auth_headers(token)


@pytest_asyncio.fixture(autouse=True)
async def cleanup_test_sessions():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id IN (:u, :u_hex)"),
                {"u": TEST_QR_UID, "u_hex": TEST_QR_UID_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


def _mock_gw_session(gw_id: str, status: str = "SCAN_QR"):
    return {
        "id": gw_id,
        "session_name": "Test Device Line",
        "status": status,
        "qr_code": "data:image/png;base64,MOCK_QR_PHASE13",
        "phone_number": None if status != "CONNECTED" else "+905551234567",
        "is_phone_online": status == "CONNECTED",
        "battery_level": None,
        "is_active": True,
    }


class TestPhase13QrCancelLifecycle:

    @pytest.mark.asyncio
    async def test_qr_01_modal_open_and_immediate_cancel(self, qr_auth_headers):
        """TEST-QR-01: Cihaz Bağla -> modal aç -> hemen cancel => new public whatsapp_sessions = 0."""
        gw_id = f"gw-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_session(gw_id)), \
                 patch("backend.app.services.whatsapp_gateway.delete_session", new_callable=AsyncMock, return_value={"success": True}) as mock_gw_delete:

                # 1. User clicks "Cihaz Bağla", modal initializes session
                create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "New Line"}, headers=qr_auth_headers)
                assert create_res.status_code == 201
                session_id = create_res.json()["id"]

                # Verify session was temporarily registered
                async with AsyncSessionLocal() as db:
                    s_count = await db.scalar(
                        select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_QR_UID_HEX)
                    )
                    assert s_count == 1

                # 2. User presses Cancel / X
                del_res = await client.delete(f"/api/v1/whatsapp/sessions/{session_id}", headers=qr_auth_headers)
                assert del_res.status_code == 200
                assert del_res.json()["success"] is True

                # Gateway delete was executed
                mock_gw_delete.assert_awaited_once_with(gw_id)

                # Invariant: zero whatsapp_sessions remain for this user
                async with AsyncSessionLocal() as db:
                    s_count = await db.scalar(
                        select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_QR_UID_HEX)
                    )
                    assert s_count == 0

    @pytest.mark.asyncio
    async def test_qr_02_cancel_during_qr_generation(self, qr_auth_headers):
        """TEST-QR-02: Cihaz Bağla -> QR üretimi sırasında cancel => cleanup completes and sessions = 0."""
        gw_id = f"gw-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_session(gw_id)), \
                 patch("backend.app.services.whatsapp_gateway.delete_session", new_callable=AsyncMock, return_value={"success": True}):

                create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "InFlight Line"}, headers=qr_auth_headers)
                assert create_res.status_code == 201
                session_id = create_res.json()["id"]

                # Cancel triggered
                del_res = await client.delete(f"/api/v1/whatsapp/sessions/{session_id}", headers=qr_auth_headers)
                assert del_res.status_code == 200

                # Check DB
                async with AsyncSessionLocal() as db:
                    s_count = await db.scalar(
                        select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_QR_UID_HEX)
                    )
                    assert s_count == 0

    @pytest.mark.asyncio
    async def test_qr_03_cancel_then_reopen_no_duplicate(self, qr_auth_headers):
        """TEST-QR-03: Cihaz Bağla -> cancel -> tekrar Cihaz Bağla => exactly 1 session, no duplicate."""
        gw_id_1 = f"gw-{uuid.uuid4()}"
        gw_id_2 = f"gw-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock) as mock_create, \
                 patch("backend.app.services.whatsapp_gateway.delete_session", new_callable=AsyncMock, return_value={"success": True}):

                # First attempt
                mock_create.return_value = _mock_gw_session(gw_id_1)
                res1 = await client.post("/api/v1/whatsapp/sessions", json={"name": "Line 1"}, headers=qr_auth_headers)
                s1_id = res1.json()["id"]
                # Cancel first attempt
                await client.delete(f"/api/v1/whatsapp/sessions/{s1_id}", headers=qr_auth_headers)

                # Second attempt
                mock_create.return_value = _mock_gw_session(gw_id_2)
                res2 = await client.post("/api/v1/whatsapp/sessions", json={"name": "Line 2"}, headers=qr_auth_headers)
                assert res2.status_code == 201
                s2_id = res2.json()["id"]

                # Check DB has exactly 1 session (Line 2)
                async with AsyncSessionLocal() as db:
                    rows = (await db.scalars(
                        select(WhatsAppSession).where(WhatsAppSession.user_id == TEST_QR_UID_HEX)
                    )).all()
                    assert len(rows) == 1
                    assert rows[0].id == s2_id
                    assert rows[0].gateway_id == gw_id_2

    @pytest.mark.asyncio
    async def test_qr_04_to_06_cancel_invokes_gateway_socket_and_lease_cleanup(self, qr_auth_headers):
        """TEST-QR-04, 05, 06: QR görüntüleniyor -> cancel => gateway delete called for socket/creds/lease."""
        gw_id = f"gw-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_session(gw_id)), \
                 patch("backend.app.services.whatsapp_gateway.delete_session", new_callable=AsyncMock, return_value={"success": True}) as mock_gw_delete:

                create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Active QR Line"}, headers=qr_auth_headers)
                session_id = create_res.json()["id"]

                # Cancel
                del_res = await client.delete(f"/api/v1/whatsapp/sessions/{session_id}", headers=qr_auth_headers)
                assert del_res.status_code == 200

                # Verifies gateway.delete_session was invoked with proper gateway_id
                mock_gw_delete.assert_awaited_once_with(gw_id)

    @pytest.mark.asyncio
    async def test_qr_07_connected_session_persists(self, qr_auth_headers):
        """TEST-QR-07: QR taranıyor -> CONNECTED => session remains persistent."""
        gw_id = f"gw-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_session(gw_id)), \
                 patch("backend.app.services.whatsapp_gateway.list_sessions", new_callable=AsyncMock, return_value=[_mock_gw_session(gw_id, status="CONNECTED")]):

                create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Pairing Line"}, headers=qr_auth_headers)
                session_id = create_res.json()["id"]

                # Simulate connection event in DB
                async with AsyncSessionLocal() as db:
                    s = await db.get(WhatsAppSession, session_id)
                    s.status = SessionStatus.CONNECTED
                    s.phone_number = "+905551234567"
                    s.is_active = True
                    await db.commit()

                # List sessions - must return CONNECTED session
                list_res = await client.get("/api/v1/whatsapp/sessions", headers=qr_auth_headers)
                assert list_res.status_code == 200
                sessions = list_res.json()["sessions"]
                assert len(sessions) == 1
                assert sessions[0]["id"] == session_id
                assert sessions[0]["status"] == "CONNECTED"
                assert sessions[0]["phone_number"] == "+905551234567"

    @pytest.mark.asyncio
    async def test_qr_08_unscanned_modal_timeout_or_dismiss_prevents_orphan(self, qr_auth_headers):
        """TEST-QR-08: Cihaz Bağla -> QR taranmadan modal timeout/close => zero orphan sessions."""
        gw_id = f"gw-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_session(gw_id)), \
                 patch("backend.app.services.whatsapp_gateway.delete_session", new_callable=AsyncMock, return_value={"success": True}):

                create_res = await client.post("/api/v1/whatsapp/sessions", json={"name": "Timeout Line"}, headers=qr_auth_headers)
                session_id = create_res.json()["id"]

                # Timeout / modal dismiss triggers frontend handleCancel -> DELETE
                del_res = await client.delete(f"/api/v1/whatsapp/sessions/{session_id}", headers=qr_auth_headers)
                assert del_res.status_code == 200

                async with AsyncSessionLocal() as db:
                    s_count = await db.scalar(
                        select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_QR_UID_HEX)
                    )
                    assert s_count == 0
