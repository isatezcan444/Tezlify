"""Characterization and regression tests for Phase 13.1 QR No-Create Pairing Lifecycle.

Validates that:
- Starting a QR pairing attempt creates ZERO rows in public.whatsapp_sessions.
- Canceling a QR pairing attempt leaves ZERO rows in public.whatsapp_sessions.
- Gateway ephemeral deletion is executed without leaving orphan resources.
- Only upon true connection (CONNECTED) is a persistent session finalized and committed to DB.
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
from backend.app.models.contact import Contact
from backend.tests.test_whatsapp_live import _make_jwt, _auth_headers

TEST_NOCREATE_UID = "34567890-3456-3456-3456-345678901234"
TEST_NOCREATE_UID_HEX = "34567890345634563456345678901234"


@pytest.fixture
def auth_headers():
    token = _make_jwt(user_id=TEST_NOCREATE_UID)
    return _auth_headers(token)


@pytest_asyncio.fixture(autouse=True)
async def cleanup_test_sessions():
    async def _wipe():
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id IN (:u, :u_hex)"),
                {"u": TEST_NOCREATE_UID, "u_hex": TEST_NOCREATE_UID_HEX},
            )
            await db.execute(
                text("DELETE FROM contacts WHERE user_id IN (:u, :u_hex)"),
                {"u": TEST_NOCREATE_UID, "u_hex": TEST_NOCREATE_UID_HEX},
            )
            await db.commit()

    await _wipe()
    yield
    await _wipe()


def _mock_gw_ephemeral_session(gw_id: str, status: str = "SCAN_QR"):
    return {
        "id": gw_id,
        "session_name": "Test Ephemeral Device",
        "status": status,
        "qr_code": "data:image/png;base64,MOCK_PAIRING_QR_PHASE13_1",
        "phone_number": None if status != "CONNECTED" else "+905551234567",
        "is_phone_online": status == "CONNECTED",
        "battery_level": None,
        "is_active": True,
        "ephemeral": True,
    }


class TestPhase131QrNoCreate:

    @pytest.mark.asyncio
    async def test_qr_nocreate_01_cancel_leaves_zero_public_sessions(self, auth_headers):
        """TEST-QR-NOCREATE-01:
        Cihaz Bağla -> QR preparation -> CANCEL.
        Verifies that public.whatsapp_sessions row count is 0 before, during, and after cancel.
        """
        gw_id = f"gw-ephem-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_ephemeral_session(gw_id)) as mock_gw_create, \
                 patch("backend.app.services.whatsapp_gateway.get_session_qr", new_callable=AsyncMock, return_value=_mock_gw_ephemeral_session(gw_id)) as mock_gw_qr, \
                 patch("backend.app.services.whatsapp_gateway.delete_session", new_callable=AsyncMock, return_value={"success": True}) as mock_gw_delete:

                # 1. Before check: must be 0
                async with AsyncSessionLocal() as db:
                    count_before = await db.scalar(
                        select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_NOCREATE_UID_HEX)
                    )
                    assert count_before == 0

                # 2. User clicks "Cihaz Bağla" -> POST /api/v1/whatsapp/pairing/start
                start_res = await client.post(
                    "/api/v1/whatsapp/pairing/start",
                    json={"name": "Ephemeral Pairing Line"},
                    headers=auth_headers,
                )
                assert start_res.status_code == 201
                start_data = start_res.json()
                pair_token = start_data["pair_token"]
                assert start_data["status"] == "SCAN_QR"

                # Verify gateway was called with ephemeral=True
                mock_gw_create.assert_awaited_once_with("Ephemeral Pairing Line", ephemeral=True)

                # 3. Invariant check DURING QR display: NO ROW IN public.whatsapp_sessions!
                async with AsyncSessionLocal() as db:
                    count_during = await db.scalar(
                        select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_NOCREATE_UID_HEX)
                    )
                    assert count_during == 0, "CRITICAL: A session row was inserted into public.whatsapp_sessions during QR display!"

                # Poll QR
                qr_res = await client.get(f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=auth_headers)
                assert qr_res.status_code == 200
                assert qr_res.json()["status"] == "SCAN_QR"

                # 4. User clicks Cancel / X -> POST /api/v1/whatsapp/pairing/{pair_token}/cancel
                cancel_res = await client.post(f"/api/v1/whatsapp/pairing/{pair_token}/cancel", headers=auth_headers)
                assert cancel_res.status_code == 200
                assert cancel_res.json()["success"] is True

                # Verify gateway.delete_session was called to terminate the ephemeral socket
                mock_gw_delete.assert_awaited_once_with(gw_id)

                # 5. After check: public.whatsapp_sessions count must STILL BE 0!
                async with AsyncSessionLocal() as db:
                    count_after = await db.scalar(
                        select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_NOCREATE_UID_HEX)
                    )
                    assert count_after == 0

    @pytest.mark.asyncio
    async def test_qr_nocreate_02_scanned_qr_promotes_to_persistent_session(self, auth_headers):
        """Validates that scanning the QR (status -> CONNECTED) creates and commits the persistent row."""
        gw_id = f"gw-ephem-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_ephemeral_session(gw_id)), \
                 patch("backend.app.services.whatsapp_gateway.get_session_qr", new_callable=AsyncMock) as mock_gw_qr:

                # 1. Start pairing
                start_res = await client.post(
                    "/api/v1/whatsapp/pairing/start",
                    json={"name": "Connected Line"},
                    headers=auth_headers,
                )
                pair_token = start_res.json()["pair_token"]

                # 2. Simulate phone scanning QR -> CONNECTED
                mock_gw_qr.return_value = _mock_gw_ephemeral_session(gw_id, status="CONNECTED")
                qr_res = await client.get(f"/api/v1/whatsapp/pairing/{pair_token}/qr", headers=auth_headers)
                assert qr_res.status_code == 200
                qr_data = qr_res.json()
                assert qr_data["status"] == "CONNECTED"
                assert qr_data["session_id"] is not None

                # 3. Invariant check: Row NOW exists in public.whatsapp_sessions with CONNECTED status!
                async with AsyncSessionLocal() as db:
                    s_row = await db.get(WhatsAppSession, qr_data["session_id"])
                    assert s_row is not None
                    assert s_row.status == SessionStatus.CONNECTED
                    assert s_row.phone_number == "+905551234567"
                    assert s_row.is_active is True

    @pytest.mark.asyncio
    async def test_qr_nocreate_03_rapid_cancel_race_condition(self, auth_headers):
        """User cancels within 50ms of opening modal."""
        gw_id = f"gw-ephem-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            with patch("backend.app.services.whatsapp_gateway.create_session", new_callable=AsyncMock, return_value=_mock_gw_ephemeral_session(gw_id)), \
                 patch("backend.app.services.whatsapp_gateway.delete_session", new_callable=AsyncMock, return_value={"success": True}):

                # Start
                start_res = await client.post("/api/v1/whatsapp/pairing/start", json={"name": "Race Line"}, headers=auth_headers)
                pair_token = start_res.json()["pair_token"]

                # Immediate cancel
                cancel_res = await client.post(f"/api/v1/whatsapp/pairing/{pair_token}/cancel", headers=auth_headers)
                assert cancel_res.status_code == 200

                # Verify 0 rows
                async with AsyncSessionLocal() as db:
                    count = await db.scalar(
                        select(func.count(WhatsAppSession.id)).where(WhatsAppSession.user_id == TEST_NOCREATE_UID_HEX)
                    )
                    assert count == 0

    @pytest.mark.asyncio
    async def test_avatar_refresh_endpoint(self, auth_headers):
        """Verifies POST /api/v1/whatsapp/contacts/{phone}/avatar/refresh calls gateway and updates contact."""
        gw_id = f"gw-{uuid.uuid4()}"
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            # Seed active connected session for user
            async with AsyncSessionLocal() as db:
                sess = WhatsAppSession(
                    user_id=TEST_NOCREATE_UID_HEX,
                    gateway_id=gw_id,
                    session_name="Primary Line",
                    status=SessionStatus.CONNECTED,
                    phone_number="+905551234567",
                    is_active=True,
                    is_phone_online=True,
                )
                contact = Contact(
                    user_id=TEST_NOCREATE_UID_HEX,
                    phone_e164="+905559876543",
                    display_name="Alice",
                    custom_attributes={"avatar_url": "https://pps.whatsapp.net/old_expired.jpg"},
                )
                db.add(sess)
                db.add(contact)
                await db.commit()

            fresh_avatar = "https://pps.whatsapp.net/v/t61/fresh_avatar_token.jpg"
            with patch("backend.app.services.whatsapp_gateway.refresh_avatar", new_callable=AsyncMock, return_value={"success": True, "avatar_url": fresh_avatar}):
                res = await client.post("/api/v1/whatsapp/contacts/+905559876543/avatar/refresh", headers=auth_headers)
                assert res.status_code == 200
                data = res.json()
                assert data["success"] is True
                assert data["avatar_url"] == fresh_avatar

            # Check contact DB updated
            async with AsyncSessionLocal() as db:
                c = await db.scalar(select(Contact).where(Contact.user_id == TEST_NOCREATE_UID_HEX, Contact.phone_e164 == "+905559876543"))
                assert c.custom_attributes["avatar_url"] == fresh_avatar
