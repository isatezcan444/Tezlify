"""
Unit and integration tests for WhatsApp Gateway Client and Webhooks.
Verifies SOLID principles, fail-closed security, and session lifecycle handling.
"""
import uuid
import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport, Response

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.services.whatsapp_gateway_client import WhatsAppGatewayClient, gateway_client
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.core.database import AsyncSessionLocal


@pytest.mark.asyncio
async def test_gateway_client_alive_check():
    client = WhatsAppGatewayClient(gateway_url="http://mock-gateway:3001")

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = Response(200, json={"status": "ok"})
        alive = await client.is_gateway_alive()
        assert alive is True

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = Exception("Connection refused")
        alive = await client.is_gateway_alive()
        assert alive is False


@pytest.mark.asyncio
async def test_gateway_client_create_session_success():
    client = WhatsAppGatewayClient(gateway_url="http://mock-gateway:3001")

    mock_resp_data = {
        "status": "success",
        "session": {
            "name": "tezlify_user_1",
            "status": "SCAN_QR",
            "qrImage": "data:image/png;base64,mockqrdata",
            "phone": None,
        }
    }

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = Response(200, json=mock_resp_data)
        result = await client.create_session("tezlify_user_1")
        assert result["success"] is True
        assert result["status"] == "SCAN_QR"
        assert result["qr_code"] == "data:image/png;base64,mockqrdata"


@pytest.mark.asyncio
async def test_gateway_client_create_session_failure_no_false_positive():
    client = WhatsAppGatewayClient(gateway_url="http://mock-gateway:3001")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = Response(500, text="Internal Gateway Error")
        result = await client.create_session("tezlify_user_1")
        assert result["success"] is False
        assert "Gateway error" in result["error"]


@pytest.mark.asyncio
async def test_gateway_client_connection_error_fail_closed():
    client = WhatsAppGatewayClient(gateway_url="http://mock-gateway:3001")

    # When simulation mode is disabled, connection error must report failure
    orig_sim = settings.SIMULATION_MODE
    try:
        settings.SIMULATION_MODE = False
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            mock_post.side_effect = Exception("Gateway unreachable")
            result = await client.create_session("tezlify_user_1")
            assert result["success"] is False
            assert "Gateway unreachable" in result["error"]
    finally:
        settings.SIMULATION_MODE = orig_sim


@pytest.mark.asyncio
async def test_gateway_client_status_and_qr():
    client = WhatsAppGatewayClient(gateway_url="http://mock-gateway:3001")

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = Response(200, json={"qrImage": "data:image/png;base64,latestqr"})
        qr = await client.get_session_qr("session_x")
        assert qr == "data:image/png;base64,latestqr"

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = Response(200, json={"status": "CONNECTED", "phone": "+905551234567"})
        status_info = await client.get_session_status("session_x")
        assert status_info["status"] == "CONNECTED"
        assert status_info["phone"] == "+905551234567"


@pytest.mark.asyncio
async def test_webhook_session_status_lifecycle():
    transport = ASGITransport(app=app)
    secret = settings.WA_GATEWAY_WEBHOOK_SECRET or "tezlify-gateway-secret-test"
    settings.WA_GATEWAY_WEBHOOK_SECRET = secret

    # 1. Create a test session in DB
    session_name = "test_webhook_session_lifecycle"
    async with AsyncSessionLocal() as db:
        test_session = WhatsAppSession(
            session_name=session_name,
            phone_number=None,
            status=SessionStatus.CONNECTING,
            is_phone_online=False,
        )
        db.add(test_session)
        await db.commit()
        await db.refresh(test_session)
        session_id = test_session.id

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 2. Test unauthorized without secret
        unauth_res = await client.post(
            "/api/v1/whatsapp/webhook/session-status",
            headers={"X-Webhook-Secret": "invalid-secret"},
            json={"session_name": session_name, "status": "CONNECTED", "phone": "+905559998877"}
        )
        assert unauth_res.status_code == 401

        # 3. Test QR update webhook
        qr_res = await client.post(
            "/api/v1/whatsapp/webhook/session-qr",
            headers={"X-Webhook-Secret": secret},
            json={"session_name": session_name, "qr_code": "data:image/png;base64,testqr"}
        )
        assert qr_res.status_code == 200
        assert qr_res.json()["status"] == "success"

        # Verify DB updated to SCAN_QR
        async with AsyncSessionLocal() as db:
            s = await db.get(WhatsAppSession, session_id)
            assert s.status == SessionStatus.SCAN_QR
            assert s.qr_code == "data:image/png;base64,testqr"

        # 4. Test CONNECTED webhook
        conn_res = await client.post(
            "/api/v1/whatsapp/webhook/session-status",
            headers={"X-Webhook-Secret": secret},
            json={"session_name": session_name, "status": "CONNECTED", "phone": "+905559998877"}
        )
        assert conn_res.status_code == 200
        assert conn_res.json()["session_status"] == "CONNECTED"

        # Verify DB updated to CONNECTED
        async with AsyncSessionLocal() as db:
            s = await db.get(WhatsAppSession, session_id)
            assert s.status == SessionStatus.CONNECTED
            assert s.phone_number == "+905559998877"
            assert s.qr_code is None
            assert s.is_phone_online is True

        # 5. Test DISCONNECTED webhook
        disc_res = await client.post(
            "/api/v1/whatsapp/webhook/session-status",
            headers={"X-Webhook-Secret": secret},
            json={"session_name": session_name, "status": "DISCONNECTED"}
        )
        assert disc_res.status_code == 200
        assert disc_res.json()["session_status"] == "DISCONNECTED"

        async with AsyncSessionLocal() as db:
            s = await db.get(WhatsAppSession, session_id)
            assert s.status == SessionStatus.DISCONNECTED
            assert s.is_phone_online is False

        # Cleanup test session
        async with AsyncSessionLocal() as db:
            s_clean = await db.get(WhatsAppSession, session_id)
            if s_clean:
                await db.delete(s_clean)
                await db.commit()


@pytest.mark.asyncio
async def test_session_pairing_code_endpoint():
    transport = ASGITransport(app=app)
    session_name = f"pairing_code_test_{uuid.uuid4().hex[:6]}"
    sess_id = None

    try:
        async with AsyncSessionLocal() as db:
            sess = WhatsAppSession(
                session_name=session_name,
                status=SessionStatus.SCAN_QR,
            )
            db.add(sess)
            await db.commit()
            await db.refresh(sess)
            sess_id = sess.id

        with patch.object(gateway_client, "request_pairing_code", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = "ABCD-1234"

            async with AsyncClient(transport=transport, base_url="http://test") as client:
                # 1. Validation error on missing phone
                res_bad = await client.post(f"/api/v1/whatsapp/sessions/{sess_id}/pairing-code", json={})
                assert res_bad.status_code == 400

                # 2. Success pairing code
                res = await client.post(
                    f"/api/v1/whatsapp/sessions/{sess_id}/pairing-code",
                    json={"phone": "+905321002030"}
                )
                assert res.status_code == 200
                data = res.json()
                assert data["success"] is True
                assert data["pairing_code"] == "ABCD-1234"

            mock_req.assert_called_once_with(session_name, "+905321002030")

    finally:
        if sess_id:
            async with AsyncSessionLocal() as db:
                s = await db.get(WhatsAppSession, sess_id)
                if s:
                    await db.delete(s)
                    await db.commit()
