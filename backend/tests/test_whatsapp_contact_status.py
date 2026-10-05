"""Unit tests for WhatsApp contact status/about endpoint."""
import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.auth import AuthUser
from backend.app.core.database import get_db
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus


@pytest.mark.asyncio
async def test_get_contact_status_success():
    transport = ASGITransport(app=app)
    mock_user = AuthUser(
        id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        email="test@tezlify.com",
        full_name="Test User",
    )

    fake_session = WhatsAppSession(
        id=1,
        user_id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        gateway_id="mock-gw-123",
        status=SessionStatus.CONNECTED,
    )

    with (
        patch("backend.app.api.v1.endpoints.whatsapp.get_current_user", return_value=mock_user),
        patch("backend.app.services.whatsapp_service._require_user_session", new_callable=AsyncMock) as mock_require,
        patch("backend.app.services.whatsapp_gateway.fetch_contact_status", new_callable=AsyncMock) as mock_fetch,
    ):
        mock_require.return_value = fake_session
        mock_fetch.return_value = {"status": "Hey there! Using WhatsApp", "setAt": "2026-10-04T12:00:00Z"}

        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.get("/api/v1/whatsapp/contacts/%2B905413749073/status")

        assert res.status_code == 200
        data = res.json()
        assert data.get("status") == "Hey there! Using WhatsApp"
        mock_fetch.assert_called_once_with("mock-gw-123", "905413749073@s.whatsapp.net")


@pytest.mark.asyncio
async def test_get_contact_status_fallback_on_error():
    transport = ASGITransport(app=app)
    mock_user = AuthUser(
        id="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        email="test@tezlify.com",
        full_name="Test User",
    )

    with (
        patch("backend.app.api.v1.endpoints.whatsapp.get_current_user", return_value=mock_user),
        patch("backend.app.services.whatsapp_service._require_user_session", side_effect=Exception("No session")),
    ):
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.get("/api/v1/whatsapp/contacts/%2B905413749073/status")

        assert res.status_code == 200
        data = res.json()
        assert data.get("status") is None
        assert "error" in data
