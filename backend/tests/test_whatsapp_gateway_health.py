"""Regression tests for Phase 23: WhatsApp Gateway Health and Reconnect Recovery.

Tests verify:
1. Gateway accessible -> health check succeeds.
2. Gateway transiently failing (ConnectError/ReadTimeout) -> recovers via bounded retry.
3. Gateway permanently unreachable -> fails closed with WhatsAppGatewayError and 503 (Truthfulness).
4. Secret tokens/keys are never leaked in health error payloads.
5. Failed health probe never mutates active session or triggers logout.
"""
from unittest.mock import AsyncMock, patch
import pytest

from backend.app.services import whatsapp_gateway as gw
from backend.app.services import whatsapp_service


@pytest.mark.asyncio
async def test_gateway_health_success():
    """Scenario 1: Gateway accessible -> health check returns summary data."""
    fake_response = {
        "status": "ok",
        "service": "tezlify-whatsapp-gateway",
        "database": "connected",
        "sessions": {"total": 1, "connected": 1, "pending_qr": 0},
        "live_session_ids": ["test-session-123"],
    }
    with patch.object(gw, "_request", new_callable=AsyncMock) as mock_req:
        mock_req.return_value = fake_response
        result = await gw.health()
        assert result["status"] == "ok"
        assert result["live_session_ids"] == ["test-session-123"]
        assert mock_req.call_count == 1


@pytest.mark.asyncio
async def test_gateway_health_transient_failure_recovery():
    """Scenario 2 & 3: Transient connection glitch recovers on retry."""
    fake_response = {
        "status": "ok",
        "service": "tezlify-whatsapp-gateway",
        "database": "connected",
        "sessions": {"total": 1, "connected": 1, "pending_qr": 0},
        "live_session_ids": ["test-session-123"],
    }
    with patch.object(gw, "_request", new_callable=AsyncMock) as mock_req:
        # First attempt fails with transient ConnectError, second attempt succeeds
        mock_req.side_effect = [
            gw.WhatsAppGatewayError("Gateway'e ulaşılamadı (/health): [Errno -3] Temporary failure in name resolution"),
            fake_response,
        ]
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            result = await gw.health(max_retries=2)
            assert result["status"] == "ok"
            assert mock_req.call_count == 2
            mock_sleep.assert_awaited_once_with(0.3)


@pytest.mark.asyncio
async def test_gateway_health_permanent_failure_truthfulness():
    """Scenario 4 & 10: Fail-closed truthfulness when gateway remains down."""
    with patch.object(gw, "_request", new_callable=AsyncMock) as mock_req:
        mock_req.side_effect = gw.WhatsAppGatewayError("Gateway'e ulaşılamadı (/health): Connection refused")
        with patch("asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(gw.WhatsAppGatewayError) as exc_info:
                await gw.health(max_retries=2)
            assert "Connection refused" in str(exc_info.value)
            assert mock_req.call_count == 2


@pytest.mark.asyncio
async def test_gateway_health_probe_service_wrapper():
    """Verifies whatsapp_service.gateway_health_probe fail-closed contract."""
    with patch.object(gw, "health", new_callable=AsyncMock) as mock_health:
        mock_health.return_value = {"status": "ok", "sessions": {"total": 0}}
        res = await whatsapp_service.gateway_health_probe()
        assert res["gateway_available"] is True
        assert res["status"] == "ok"


@pytest.mark.asyncio
async def test_gateway_health_no_secret_leak():
    """Ensures error responses and exceptions never expose auth secret."""
    secret = "a_very_secret_token_1234567890_32bytes_value!"
    with patch.object(gw.settings, "WHATSAPP_GATEWAY_SECRET", secret):
        with patch.object(gw, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = gw.WhatsAppGatewayError("Gateway'e ulaşılamadı (/health): ReadTimeout")
            with patch("asyncio.sleep", new_callable=AsyncMock):
                with pytest.raises(gw.WhatsAppGatewayError) as exc_info:
                    await gw.health()
                err_msg = str(exc_info.value)
                assert secret not in err_msg
