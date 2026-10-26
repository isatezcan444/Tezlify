import base64

import pytest
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.auth import get_current_user, AuthUser
from backend.app.services.campaign_media_service import (
    CampaignMediaService,
    UPLOAD_DIR,
    sniff_media,
)


@pytest.fixture
def mock_user():
    return AuthUser(
        id="11111111-1111-1111-1111-111111111111",
        email="test@tezlify.com",
        full_name="Test User",
        is_admin=False,
    )


def _cleanup(file_id: str) -> None:
    for path in UPLOAD_DIR.glob(f"{file_id}_*"):
        path.unlink(missing_ok=True)


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

        try:
            # 2. Retrieve via GET endpoint
            get_res = await client.get(f"/api/v1/campaigns/media/{file_id}")
            assert get_res.status_code == 200
            assert get_res.content == fake_pdf
            # PDF is NOT inline: a PDF can carry script for whatever viewer
            # renders it, so it must download instead of rendering here.
            assert "attachment" in get_res.headers.get("content-disposition", "")
            assert get_res.headers["x-content-type-options"] == "nosniff"
            assert "sandbox" in get_res.headers.get("content-security-policy", "")
            assert get_res.headers["cache-control"].startswith("private")

            # 3. Test Base64 helper
            b64 = CampaignMediaService.get_campaign_media_base64(data["media_url"])
            assert b64 is not None
            assert base64.b64decode(b64) == fake_pdf
        finally:
            _cleanup(file_id)

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
        file_id = data["file_id"]

        try:
            get_res = await client.get(f"/api/v1/campaigns/media/{file_id}")
            assert get_res.status_code == 200
            # Images stay inline — a browser cannot turn them into script.
            assert "inline" in get_res.headers.get("content-disposition", "")
            assert get_res.headers["content-type"].startswith("image/png")
            assert get_res.headers["x-content-type-options"] == "nosniff"
        finally:
            _cleanup(file_id)

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


# ============================================================
# Depolanmış XSS: istemci beyanı ve dosya adı KANIT DEĞİLDİR
# ============================================================

HTML_PAYLOAD = b"<html><script>alert(document.domain)</script></html>"
SVG_PAYLOAD = b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "filename,content_type,payload",
    [
        # The original hole: text/plain was allowed, and the served type was
        # re-guessed from the extension → text/html.
        ("evil.html", "text/plain", HTML_PAYLOAD),
        ("evil.htm", "text/plain", HTML_PAYLOAD),
        ("evil.svg", "text/plain", SVG_PAYLOAD),
        # Claiming a benign type does not make the bytes benign.
        ("evil.pdf", "application/pdf", HTML_PAYLOAD),
        ("evil.png", "image/png", HTML_PAYLOAD),
        # A zip is not a docx.
        ("evil.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", b"PK\x03\x04not-a-docx"),
    ],
)
async def test_unrecognised_content_is_rejected_regardless_of_name(
    mock_user, filename, content_type, payload
):
    app.dependency_overrides[get_current_user] = lambda: mock_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/campaigns/upload-media",
            files={"file": (filename, payload, content_type)},
        )
        assert res.status_code == 400, res.text
        assert "tanınmayan" in res.json()["detail"]
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_lying_extension_is_rewritten_to_the_real_type(mock_user):
    """A real PDF named `.html` is stored as `.pdf` — the name stops lying."""
    app.dependency_overrides[get_current_user] = lambda: mock_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        fake_pdf = b"%PDF-1.4 Gercek katalog"
        res = await client.post(
            "/api/v1/campaigns/upload-media",
            files={"file": ("katalog.html", fake_pdf, "text/html")},
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["filename"] == "katalog.pdf"
        assert data["mime_type"] == "application/pdf"

        try:
            get_res = await client.get(f"/api/v1/campaigns/media/{data['file_id']}")
            assert get_res.status_code == 200
            assert get_res.headers["content-type"].startswith("application/pdf")
            assert "attachment" in get_res.headers.get("content-disposition", "")
        finally:
            _cleanup(data["file_id"])
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_previously_stored_html_file_can_no_longer_be_served(mock_user):
    """The rule is retroactive: files stored before the fix are re-sniffed.

    This is the one that matters for an already-deployed instance — the old
    code may have written `camp_x_evil.html` holding HTML. Serving must not
    trust the stored name.
    """
    app.dependency_overrides[get_current_user] = lambda: mock_user
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    legacy_id = "camp_00000000deadbeef"
    legacy_path = UPLOAD_DIR / f"{legacy_id}_evil.html"
    legacy_path.write_bytes(HTML_PAYLOAD)

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get(f"/api/v1/campaigns/media/{legacy_id}")
            assert res.status_code == 404
    finally:
        legacy_path.unlink(missing_ok=True)
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_previously_stored_image_with_wrong_extension_serves_as_image(mock_user):
    """A PNG stored as `.html` still serves — as `image/png`, never `text/html`."""
    app.dependency_overrides[get_current_user] = lambda: mock_user
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    legacy_id = "camp_00000000feedface"
    legacy_path = UPLOAD_DIR / f"{legacy_id}_banner.html"
    png = b"\x89PNG\r\n\x1a\nlegacy bytes"
    legacy_path.write_bytes(png)

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get(f"/api/v1/campaigns/media/{legacy_id}")
            assert res.status_code == 200
            assert res.headers["content-type"].startswith("image/png")
            assert res.headers["x-content-type-options"] == "nosniff"
    finally:
        legacy_path.unlink(missing_ok=True)
    app.dependency_overrides.clear()


def test_sniff_media_recognises_supported_formats():
    assert sniff_media(b"%PDF-1.7 x").mime == "application/pdf"
    assert sniff_media(b"\xff\xd8\xff\xe0 jpeg").mime == "image/jpeg"
    assert sniff_media(b"\x89PNG\r\n\x1a\n x").mime == "image/png"
    assert sniff_media(b"RIFF\x00\x00\x00\x00WEBPVP8 ").mime == "image/webp"
    assert sniff_media(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 doc").mime == "application/msword"
    # HTML, SVG, plain text and an empty body are all unrecognised.
    assert sniff_media(HTML_PAYLOAD) is None
    assert sniff_media(SVG_PAYLOAD) is None
    assert sniff_media(b"just some text") is None
    assert sniff_media(b"") is None
