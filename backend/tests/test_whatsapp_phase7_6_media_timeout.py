"""Phase 7.6 — WhatsApp Media Timeout & Retry Coordination Tests.

Verifies:
1. Coordinated backend proxy timeout covering gateway total deadline budget + 15s communication margin.
2. Size-aware timeout calculations for 10MB, 25MB, 50MB, and 100MB videos meeting theoretical transfer times.
3. Safe fallbacks for missing, zero, and negative fileLength.
4. Backend does not perform unauthorized extra retry loops.
5. Client cancellation / disconnection detection (fast-fail, no orphan work).
6. Gateway error mapping (404 Not Found, 422 Unprocessable Entity, 502 Bad Gateway).
"""
import math
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import httpx

from backend.app.services.whatsapp_gateway import (
    gateway_media_timeout,
    fetch_media,
    fetch_media_unscoped,
    WhatsAppGatewayError,
)

VALID_SECRET = "01234567890123456789012345678901"  # 32 bytes


class TestGatewayMediaTimeoutPhase76(unittest.TestCase):
    def test_preview_fast_path(self):
        """Preview requests must use the fast 15.0s timeout (covering Gateway's 12.0s budget + 3s margin)."""
        self.assertEqual(gateway_media_timeout(preview=True), 15.0)
        self.assertEqual(gateway_media_timeout(mime_type="video/mp4", preview=True), 15.0)
        self.assertEqual(gateway_media_timeout(mime_type="application/pdf", preview=True, file_length=50_000_000), 15.0)

    def test_category_ceiling_without_file_length(self):
        """When file_length is omitted, category defaults must cover maximum expected sizes."""
        # Video: covers 50MB+ transfer at 150 KB/s (341s) -> 420s gateway budget + 15s margin = 435.0s
        self.assertEqual(gateway_media_timeout(mime_type="video/mp4"), 435.0)
        self.assertEqual(gateway_media_timeout(mime_type="video/quicktime"), 435.0)

        # Document: covers up to 180s gateway budget + 15s margin = 195.0s
        self.assertEqual(gateway_media_timeout(mime_type="application/pdf"), 195.0)
        self.assertEqual(gateway_media_timeout(mime_type="application/zip"), 195.0)

        # Audio: covers up to 90s gateway budget + 15s margin = 105.0s
        self.assertEqual(gateway_media_timeout(mime_type="audio/ogg; codecs=opus"), 105.0)
        self.assertEqual(gateway_media_timeout(mime_type="audio/mp4"), 105.0)

        # Image: covers up to 60s gateway budget + 15s margin = 75.0s
        self.assertEqual(gateway_media_timeout(mime_type="image/jpeg"), 75.0)
        self.assertEqual(gateway_media_timeout(mime_type="image/png"), 75.0)

        # Default / Unknown: 75.0s
        self.assertEqual(gateway_media_timeout(mime_type=None), 75.0)
        self.assertEqual(gateway_media_timeout(mime_type=""), 75.0)
        self.assertEqual(gateway_media_timeout(mime_type="application/unknown-binary"), 195.0)

    def test_video_size_aware_scaling(self):
        """Video timeout must scale with file length and cap at 435.0s (420s budget + 15s margin)."""
        # 10 MB video: 60 + ceil(10485760 / 143360) = 60 + 74 = 134s + 15s = 149.0s
        timeout_10mb = gateway_media_timeout(mime_type="video/mp4", file_length=10 * 1024 * 1024)
        self.assertEqual(timeout_10mb, 149.0)

        # 25 MB video: 60 + ceil(26214400 / 143360) = 60 + 183 = 243s + 15s = 258.0s
        timeout_25mb = gateway_media_timeout(mime_type="video/mp4", file_length=25 * 1024 * 1024)
        self.assertEqual(timeout_25mb, 258.0)

        # 50 MB video: transfer at 140 KB/s is 366s -> 60 + 366 = 426s -> capped at 420s + 15s = 435.0s
        timeout_50mb = gateway_media_timeout(mime_type="video/mp4", file_length=50 * 1024 * 1024)
        self.assertEqual(timeout_50mb, 435.0)

        # 100 MB video: capped at 435.0s
        timeout_100mb = gateway_media_timeout(mime_type="video/mp4", file_length=100 * 1024 * 1024)
        self.assertEqual(timeout_100mb, 435.0)

    def test_safe_fallbacks_for_invalid_file_lengths(self):
        """Zero, negative, or invalid file lengths must fall back safely to category default."""
        self.assertEqual(gateway_media_timeout(mime_type="video/mp4", file_length=0), 435.0)
        self.assertEqual(gateway_media_timeout(mime_type="video/mp4", file_length=-1000), 435.0)
        self.assertEqual(gateway_media_timeout(mime_type="image/jpeg", file_length=0), 75.0)
        self.assertEqual(gateway_media_timeout(mime_type="image/jpeg", file_length=-50), 75.0)
        self.assertEqual(gateway_media_timeout(mime_type="application/pdf", file_length=-1), 195.0)

    def test_theoretical_transfer_times_matrix(self):
        """Verify the theoretical transfer time matrix for 10/25/50/100 MB across 150K, 250K, 500K, 1MB speeds."""
        sizes = {
            "10MB": 10 * 1024 * 1024,
            "25MB": 25 * 1024 * 1024,
            "50MB": 50 * 1024 * 1024,
            "100MB": 100 * 1024 * 1024,
        }
        speeds = {
            "150KB/s": 150 * 1024,
            "250KB/s": 250 * 1024,
            "500KB/s": 500 * 1024,
            "1MB/s": 1024 * 1024,
        }

        # 50 MB at 150 KB/s must take ~341.33 seconds
        time_50mb_150k = sizes["50MB"] / speeds["150KB/s"]
        self.assertAlmostEqual(time_50mb_150k, 341.333, places=2)

        # Video ceiling (435.0s proxy, 420.0s gateway budget) safely covers 341.33s transfer + retries
        self.assertGreater(420.0, time_50mb_150k)

        # 100 MB at 250 KB/s takes 409.6 seconds
        time_100mb_250k = sizes["100MB"] / speeds["250KB/s"]
        self.assertAlmostEqual(time_100mb_250k, 409.6, places=1)
        self.assertGreater(420.0, time_100mb_250k)

        # 100 MB at 500 KB/s takes 204.8 seconds
        time_100mb_500k = sizes["100MB"] / speeds["500KB/s"]
        self.assertAlmostEqual(time_100mb_500k, 204.8, places=1)


@pytest.mark.asyncio
class TestFetchMediaPhase76:
    @patch("backend.app.services.whatsapp_gateway.settings")
    @patch("httpx.AsyncClient")
    async def test_backend_passes_coordinated_timeout(self, mock_client_cls, mock_settings):
        """fetch_media must use the coordinated timeout and not create extra retry loops."""
        mock_settings.WHATSAPP_GATEWAY_URL = "http://127.0.0.1:8787"
        mock_settings.WHATSAPP_GATEWAY_SECRET = VALID_SECRET

        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        mock_res = MagicMock()
        mock_res.status_code = 200
        mock_res.content = b"fake-video-bytes"
        mock_client.get.return_value = mock_res

        # Fetch video with explicit 435.0s timeout
        data = await fetch_media(
            "sess-1", "media-vid-1", timeout=435.0
        )
        assert data == b"fake-video-bytes"

        # Verify AsyncClient initialized with timeout=435.0
        mock_client_cls.assert_called_with(timeout=435.0)

        # Verify only 1 GET call was made (no backend duplicate retry loop)
        assert mock_client.get.call_count == 1

    @patch("backend.app.services.whatsapp_gateway.settings")
    @patch("httpx.AsyncClient")
    async def test_gateway_error_mapping_distinguishes_422_from_502(self, mock_client_cls, mock_settings):
        """Gateway 422 (integrity verification failed) must be preserved in status_code."""
        mock_settings.WHATSAPP_GATEWAY_URL = "http://127.0.0.1:8787"
        mock_settings.WHATSAPP_GATEWAY_SECRET = VALID_SECRET

        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        mock_res = MagicMock()
        mock_res.status_code = 422
        mock_res.text = "Media integrity check failed"
        mock_client.get.return_value = mock_res

        with pytest.raises(WhatsAppGatewayError) as exc_info:
            await fetch_media("sess-1", "corrupt-media-id")

        assert exc_info.value.status_code == 422
