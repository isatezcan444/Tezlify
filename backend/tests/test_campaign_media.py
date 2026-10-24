import io
import pytest
from httpx import AsyncClient, ASGITransport
from unittest.mock import AsyncMock, patch

from backend.app.main import app
from backend.app.core.auth import get_current_user, AuthUser
from backend.app.services.campaign_media_service import CampaignMediaService


@pytest.fixture
def mock_user():
    return AuthUser(
        id="11111111-1111-1111-1111-111111111111",
        email="test@tezlify.com",
        name="Test User",
        is_active=True,
    )


@pytest.mark.asyncio
async def test_campaign_media_upload_and_retrieve(mock_user):
    app.dependency_overrides[get_current_user] = lambda: mock_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Upload PDF
        fake_pdf = b"%PDF-1.4 Fake PDF Content for Campaign Catalog"
        files = {"file": ("katalog_2026.pdf", fake_pdf, "application/pdf")}
        res = await client.post("/api/v1/campaigns/upload-media", files=files)
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["filename"] == "katalog_2026.pdf"
        assert data["media_type"] == "DOCUMENT"
        assert data["size_bytes"] == len(fake_pdf)
        assert data["media_url"].startswith("/api/v1/campaigns/media/camp_")
        file_id = data["file_id"]

        # 2. Retrieve via GET endpoint
        get_res = await client.get(f"/api/v1/campaigns/media/{file_id}")
        assert get_res.status_code == 200
        assert get_res.content == fake_pdf
        assert "inline" in get_res.headers.get("content-disposition", "")

        # 3. Test Base64 helper
        b64 = CampaignMediaService.get_campaign_media_base64(data["media_url"])
        assert b64 is not None
        import base64
        assert base64.b64decode(b64) == fake_pdf

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_campaign_media_upload_image(mock_user):
    app.dependency_overrides[get_current_user] = lambda: mock_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        fake_png = b"\x89PNG\r\n\x1a\nFake PNG Bytes"
        files = {"file": ("banner.png", fake_png, "image/png")}
        res = await client.post("/api/v1/campaigns/upload-media", files=files)
        assert res.status_code == 200
        data = res.json()
        assert data["media_type"] == "IMAGE"
        assert data["filename"] == "banner.png"

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_campaign_create_with_media_attachment(mock_user):
    app.dependency_overrides[get_current_user] = lambda: mock_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        payload = {
            "name": "Medyalı Diş Kliniği Kampanyası",
            "message_template": "{Merhaba|Selamlar} {name}, katalog ekte yer almaktadır.",
            "media_url": "/api/v1/campaigns/media/camp_1234567890abcdef",
            "media_type": "DOCUMENT",
            "media_filename": "fiyat_listesi.pdf",
        }
        res = await client.post("/api/v1/campaigns", json=payload)
        assert res.status_code == 201, res.text
        data = res.json()
        assert data["name"] == payload["name"]
        assert data["media_url"] == payload["media_url"]
        assert data["media_type"] == "DOCUMENT"
        assert data["media_filename"] == "fiyat_listesi.pdf"

    app.dependency_overrides.clear()
