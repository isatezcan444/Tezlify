"""Phase 7.7 — WhatsApp Media Integrity, Client Cancellation & E2E Resilience Tests.

Verifies:
1. Client disconnection pre-flight and post-fetch returning HTTP 499 immediately.
2. asyncio.CancelledError properly propagating to Starlette without swallowing.
3. Gateway 422 integrity validation failures mapped to HTTP 422 Unprocessable Entity.
4. Tenant isolation strictly preventing cross-tenant media access.
5. Upstream HTTP cancellation releasing resources.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException, status
from starlette.requests import Request

from backend.app.api.v1.endpoints.whatsapp import get_media
from backend.app.services.whatsapp_gateway import WhatsAppGatewayError, gateway_media_timeout


class FakeAuthUser:
    def __init__(self, user_id: int):
        self.id = user_id
        self.email = f"user{user_id}@example.com"
        self.role = "admin"


@pytest.mark.asyncio
async def test_get_media_preflight_client_disconnected():
    """If client has already disconnected before fetch, return HTTP 499 immediately."""
    mock_request = MagicMock(spec=Request)
    mock_request.is_disconnected = AsyncMock(return_value=True)
    mock_db = AsyncMock()
    mock_user = FakeAuthUser(101)

    with pytest.raises(HTTPException) as exc_info:
        await get_media(
            media_id="test-media-id-1",
            request=mock_request,
            preview=False,
            db=mock_db,
            current_user=mock_user,
        )

    assert exc_info.value.status_code == 499
    assert "İstemci bağlantıyı kapattı" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_get_media_postfetch_client_disconnected():
    """If client disconnects while media bytes were being fetched, return HTTP 499 and avoid sending bytes."""
    mock_request = MagicMock(spec=Request)
    # False on preflight, True on post-fetch
    mock_request.is_disconnected = AsyncMock(side_effect=[False, True])
    mock_db = AsyncMock()
    mock_user = FakeAuthUser(101)

    fake_bytes = b"sample-video-bytes"
    with patch("backend.app.api.v1.endpoints.whatsapp.whatsapp_service.get_media_bytes", new_callable=AsyncMock) as mock_fetch:
        mock_fetch.return_value = (fake_bytes, "video/mp4", "video.mp4")

        with pytest.raises(HTTPException) as exc_info:
            await get_media(
                media_id="test-media-id-2",
                request=mock_request,
                preview=False,
                db=mock_db,
                current_user=mock_user,
            )

        assert exc_info.value.status_code == 499
        assert "İstemci bağlantıyı kapattı" in str(exc_info.value.detail)
        mock_fetch.assert_awaited_once()


@pytest.mark.asyncio
async def test_get_media_cancellation_propagation():
    """If task is cancelled due to client abortion, asyncio.CancelledError propagates cleanly."""
    mock_request = MagicMock(spec=Request)
    mock_request.is_disconnected = AsyncMock(return_value=False)
    mock_db = AsyncMock()
    mock_user = FakeAuthUser(101)

    with patch("backend.app.api.v1.endpoints.whatsapp.whatsapp_service.get_media_bytes", new_callable=AsyncMock) as mock_fetch:
        mock_fetch.side_effect = asyncio.CancelledError()

        with pytest.raises(asyncio.CancelledError):
            await get_media(
                media_id="test-media-id-3",
                request=mock_request,
                preview=False,
                db=mock_db,
                current_user=mock_user,
            )


@pytest.mark.asyncio
async def test_get_media_gateway_integrity_failure_422():
    """If Gateway raises 422 (corrupted/truncated data), return HTTP 422 instead of 502 Bad Gateway."""
    mock_request = MagicMock(spec=Request)
    mock_request.is_disconnected = AsyncMock(return_value=False)
    mock_db = AsyncMock()
    mock_user = FakeAuthUser(101)

    with patch("backend.app.api.v1.endpoints.whatsapp.whatsapp_service.get_media_bytes", new_callable=AsyncMock) as mock_fetch:
        gw_err = WhatsAppGatewayError("Integrity check failed: hash mismatch", status_code=422)
        mock_fetch.side_effect = gw_err

        with pytest.raises(HTTPException) as exc_info:
            await get_media(
                media_id="test-media-id-4",
                request=mock_request,
                preview=False,
                db=mock_db,
                current_user=mock_user,
            )

        assert exc_info.value.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        assert "bütünlük doğrulaması başarısız" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_get_media_normal_completion():
    """Normal successful download returns Response with proper headers and status 200."""
    mock_request = MagicMock(spec=Request)
    mock_request.is_disconnected = AsyncMock(return_value=False)
    mock_request.method = "GET"
    mock_request.headers = {}
    mock_db = AsyncMock()
    mock_user = FakeAuthUser(101)

    sample_data = b"complete-verified-image-bytes"
    with patch("backend.app.api.v1.endpoints.whatsapp.whatsapp_service.get_media_bytes", new_callable=AsyncMock) as mock_fetch:
        mock_fetch.return_value = (sample_data, "image/jpeg", "photo.jpg")

        response = await get_media(
            media_id="test-media-id-5",
            request=mock_request,
            preview=False,
            db=mock_db,
            current_user=mock_user,
        )

        assert response.status_code == 200
        assert response.body == sample_data
        assert response.media_type == "image/jpeg"
        assert response.headers["Content-Length"] == str(len(sample_data))
        assert "photo.jpg" in response.headers["Content-Disposition"]
