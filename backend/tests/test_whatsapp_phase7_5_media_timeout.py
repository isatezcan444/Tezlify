"""Phase 7.5 — Backend WhatsApp Media Download Resilience & Dynamic Timeout Tests."""

import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from sqlalchemy import text

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp.orchestration.messaging import get_media_bytes
from backend.app.services.whatsapp_gateway import (
    gateway_media_timeout,
    fetch_media,
    fetch_media_unscoped,
)

VALID_SECRET = "01234567890123456789012345678901"  # 32 bytes


class TestGatewayMediaTimeout(unittest.TestCase):
    def test_preview_timeout_fast_path(self):
        """Preview requests must use the short 15.0s fast timeout regardless of mime type."""
        self.assertEqual(gateway_media_timeout(preview=True), 15.0)
        self.assertEqual(gateway_media_timeout(mime_type="video/mp4", preview=True), 15.0)
        self.assertEqual(gateway_media_timeout(mime_type="application/pdf", preview=True, file_length=50_000_000), 15.0)

    def test_media_type_category_timeouts(self):
        """Dynamic timeout must map properly to media categories."""
        # Video (covers 50MB+ video transfers at >=150 KB/s + retry overhead)
        self.assertEqual(gateway_media_timeout(mime_type="video/mp4"), 435.0)
        self.assertEqual(gateway_media_timeout(mime_type="video/3gpp"), 435.0)

        # Document / PDF / Text
        self.assertEqual(gateway_media_timeout(mime_type="application/pdf"), 195.0)
        self.assertEqual(gateway_media_timeout(mime_type="application/vnd.ms-excel"), 195.0)
        self.assertEqual(gateway_media_timeout(mime_type="text/plain"), 195.0)

        # Audio
        self.assertEqual(gateway_media_timeout(mime_type="audio/ogg; codecs=opus"), 105.0)
        self.assertEqual(gateway_media_timeout(mime_type="audio/mp4"), 105.0)

        # Image
        self.assertEqual(gateway_media_timeout(mime_type="image/jpeg"), 75.0)
        self.assertEqual(gateway_media_timeout(mime_type="image/png"), 75.0)

        # Default / Unknown
        self.assertEqual(gateway_media_timeout(mime_type=None), 75.0)
        self.assertEqual(gateway_media_timeout(mime_type="unknown/binary"), 75.0)

    def test_file_length_scaling_and_ceiling(self):
        """Large media with known file_length must scale up and cap at category max + 15s."""
        # 25 MB document: 45 + ceil(25MB / 150KB/s) = 45 + 171 = 216 -> capped at 180s budget + 15s = 195.0s
        self.assertEqual(gateway_media_timeout(mime_type="application/pdf", file_length=25 * 1024 * 1024), 195.0)

        # 5 MB image: 25 + ceil(5MB / 100KB/s) = 25 + 52 = 77 -> capped at 60s budget + 15s = 75.0s
        self.assertEqual(gateway_media_timeout(mime_type="image/jpeg", file_length=5 * 1024 * 1024), 75.0)


@pytest.mark.asyncio
class TestFetchMediaTimeouts:
    @patch("backend.app.services.whatsapp_gateway.settings")
    @patch("httpx.AsyncClient")
    async def test_fetch_media_passes_dynamic_timeout(self, mock_client_cls, mock_settings):
        """fetch_media must use the specified dynamic timeout or fallback to media timeout."""
        mock_settings.WHATSAPP_GATEWAY_URL = "http://127.0.0.1:8787"
        mock_settings.WHATSAPP_GATEWAY_SECRET = VALID_SECRET
        mock_res = MagicMock()
        mock_res.status_code = 200
        mock_res.content = b"video-media-bytes"

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_res
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client_cls.return_value.__aexit__.return_value = None

        data = await fetch_media(
            gateway_id="gw1",
            media_id="med123",
            timeout=195.0,
        )
        assert data == b"video-media-bytes"
        assert mock_client_cls.call_args.kwargs.get("timeout") == 195.0

    @patch("backend.app.services.whatsapp_gateway.settings")
    @patch("httpx.AsyncClient")
    async def test_fetch_media_unscoped_defaults_to_preview_timeout(self, mock_client_cls, mock_settings):
        """fetch_media_unscoped with preview=True must default to 15.0s."""
        mock_settings.WHATSAPP_GATEWAY_URL = "http://127.0.0.1:8787"
        mock_settings.WHATSAPP_GATEWAY_SECRET = VALID_SECRET
        mock_res = MagicMock()
        mock_res.status_code = 200
        mock_res.content = b"thumb-bytes"

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_res
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client_cls.return_value.__aexit__.return_value = None

        data = await fetch_media_unscoped(
            media_id="med_thumb",
            preview=True,
        )
        assert data == b"thumb-bytes"
        assert mock_client_cls.call_args.kwargs.get("timeout") == 15.0


@pytest.mark.asyncio
class TestGetMediaBytesDynamicTimeout:
    async def test_get_media_bytes_passes_dynamic_timeout_for_video_and_preview(self, monkeypatch):
        """get_media_bytes must compute gateway_media_timeout and forward it to gw.fetch_media."""
        calls = []

        async def fake_fetch(gateway_id, target_id, **kwargs):
            calls.append({"gateway_id": gateway_id, "target_id": target_id, **kwargs})
            return b"fake-video-content"

        import backend.app.services.whatsapp.orchestration.messaging as messaging_mod
        monkeypatch.setattr(messaging_mod.gw, "fetch_media", fake_fetch)

        user_id = str(uuid.uuid4())
        gateway_id = f"gw-{uuid.uuid4().hex[:6]}"
        media_id = f"med-{uuid.uuid4().hex[:12]}"
        wa_id = f"wa-{uuid.uuid4().hex[:12]}"

        async with AsyncSessionLocal() as db:
            sess = WhatsAppSession(
                user_id=user_id,
                session_name="Test Line",
                gateway_id=gateway_id,
                status=SessionStatus.CONNECTED,
                is_active=True,
            )
            db.add(sess)
            await db.flush()

            contact = Contact(user_id=user_id, phone_e164="+905551234567")
            db.add(contact)
            await db.flush()

            conv = Conversation(
                user_id=user_id,
                contact_id=contact.id,
                session_id=sess.id,
                channel="WHATSAPP",
            )
            db.add(conv)
            await db.flush()

            msg = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.INBOUND,
                message_type=MessageType.VIDEO,
                body="Video message",
                wa_message_id=wa_id,
                media_id=media_id,
                media_mime_type="video/mp4",
                media_filename="clip.mp4",
                recipient_phone="+905551234567",
            )
            db.add(msg)
            await db.commit()

            try:
                # 1. Full video download (coordinated 435.0s timeout covering 50MB+ video transfer)
                data, mime, fname = await get_media_bytes(db, user_id, media_id, preview=False)
                assert data == b"fake-video-content"
                assert len(calls) == 1
                assert calls[0]["timeout"] == 435.0
                assert calls[0]["preview"] is False

                # 2. Preview download
                calls.clear()
                data, mime, fname = await get_media_bytes(db, user_id, media_id, preview=True)
                assert data == b"fake-video-content"
                assert len(calls) == 1
                assert calls[0]["timeout"] == 15.0
                assert calls[0]["preview"] is True
            finally:
                await db.execute(text("DELETE FROM messages WHERE id = :i"), {"i": msg.id})
                await db.execute(text("DELETE FROM conversations WHERE id = :i"), {"i": conv.id})
                await db.execute(text("DELETE FROM contacts WHERE id = :i"), {"i": contact.id})
                await db.execute(text("DELETE FROM whatsapp_sessions WHERE id = :i"), {"i": sess.id})
                await db.commit()
