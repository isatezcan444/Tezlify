"""AŞAMA 5.4.7 — Campaign medya uç noktası yetkilendirmesi (A-1).

Kapsam:
- Kimlik doğrulaması olmayan / geçersiz token'lı istekler reddedilir.
- Boş kullanıcı kimliği fail-closed davranır.
- Sahip kendi medyasına erişir; başka tenant erişemez.
- Sahiplik kaydı olmayan (legacy) dosya yalnız TEK tenant referans veriyorsa
  ve çağıran o tenant ise sunulur; belirsizlik fail-closed'dır.
- Yetkisiz istekte medya dosyası hiç açılmaz.
"""
import json

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete

from backend.app.core.auth import AuthUser, get_current_user
from backend.app.core.database import AsyncSessionLocal
from backend.app.main import app
from backend.app.models.campaign import Campaign
from backend.app.services.campaign_media_service import CampaignMediaService, UPLOAD_DIR

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

PDF_BYTES = b"%PDF-1.4 campaign media auth test"


def _cleanup(file_id: str) -> None:
    for path in UPLOAD_DIR.glob(f"{file_id}_*"):
        path.unlink(missing_ok=True)
    (UPLOAD_DIR / f"{file_id}.owner.json").unlink(missing_ok=True)


async def _remove_campaigns(prefix: str) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(delete(Campaign).where(Campaign.name.like(f"{prefix}%")))
        await db.commit()


async def _upload(client: AsyncClient, user_id: str) -> dict:
    res = await client.post(
        "/api/v1/campaigns/upload-media",
        files={"file": ("katalog.pdf", PDF_BYTES, "application/pdf")},
        headers={"X-Test-User-Id": user_id},
    )
    assert res.status_code == 200, res.text
    return res.json()


async def _add_legacy_campaign(user_id: str, file_id: str, name: str) -> None:
    async with AsyncSessionLocal() as db:
        db.add(
            Campaign(
                user_id=user_id,
                name=name,
                message_template="legacy media",
                media_url=f"/api/v1/campaigns/media/{file_id}",
            )
        )
        await db.commit()


@pytest.mark.asyncio
async def test_missing_auth_header_is_rejected(monkeypatch):
    monkeypatch.setattr("backend.app.core.auth._is_dev_or_test_context", lambda: False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/campaigns/media/camp_0123456789abcdef")
        assert res.status_code == 401
        upload = await client.post(
            "/api/v1/campaigns/upload-media",
            files={"file": ("katalog.pdf", PDF_BYTES, "application/pdf")},
        )
        assert upload.status_code == 401


@pytest.mark.asyncio
async def test_invalid_token_is_rejected(monkeypatch):
    monkeypatch.setattr("backend.app.core.auth._is_dev_or_test_context", lambda: False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get(
            "/api/v1/campaigns/media/camp_0123456789abcdef",
            headers={"Authorization": "Bearer not-a-valid-session-token"},
        )
        assert res.status_code == 401


@pytest.mark.asyncio
async def test_blank_user_id_fails_closed():
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id="", email="blank@tezlify.test"
    )
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get("/api/v1/campaigns/media/camp_0123456789abcdef")
            assert res.status_code == 404
            upload = await client.post(
                "/api/v1/campaigns/upload-media",
                files={"file": ("katalog.pdf", PDF_BYTES, "application/pdf")},
            )
            assert upload.status_code == 401
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_owner_can_read_own_media():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        data = await _upload(client, USER_A)
        file_id = data["file_id"]
        try:
            res = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 200
            assert res.content == PDF_BYTES
            assert res.headers["content-type"].startswith("application/pdf")
            assert "attachment" in res.headers.get("content-disposition", "")
        finally:
            _cleanup(file_id)


@pytest.mark.asyncio
async def test_other_tenant_cannot_read_uploaded_media(monkeypatch):
    opened = {"called": False}

    def _forbidden_open(file_id: str):
        opened["called"] = True
        raise AssertionError("yetkisiz istekte medya dosyası açılmamalı")

    monkeypatch.setattr(
        CampaignMediaService, "get_media_file_info", staticmethod(_forbidden_open)
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        data = await _upload(client, USER_A)
        file_id = data["file_id"]
        prefix = f"tz547-other-{file_id}"
        try:
            # B, A'nın dosyasını kendi kampanyasına bağlasa bile erişemez.
            await _add_legacy_campaign(USER_B, file_id, prefix)
            res = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_B},
            )
            assert res.status_code == 404
            assert opened["called"] is False
        finally:
            await _remove_campaigns(prefix)
            _cleanup(file_id)


@pytest.mark.asyncio
async def test_unknown_media_is_not_opened(monkeypatch):
    opened = {"called": False}

    def _forbidden_open(file_id: str):
        opened["called"] = True
        raise AssertionError("olmayan medya için dosya açılmamalı")

    monkeypatch.setattr(
        CampaignMediaService, "get_media_file_info", staticmethod(_forbidden_open)
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get(
            "/api/v1/campaigns/media/camp_ffffffffffffffff",
            headers={"X-Test-User-Id": USER_A},
        )
        assert res.status_code == 404
        assert opened["called"] is False


@pytest.mark.asyncio
async def test_legacy_media_with_single_tenant_reference_is_served():
    """Sahiplik kaydı olmayan eski dosya, kampanya referansıyla sahibine sunulur."""
    file_id = "camp_00000000000000a7"
    path = UPLOAD_DIR / f"{file_id}_legacy.pdf"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PDF_BYTES)
    prefix = f"tz547-legacy-{file_id}"
    try:
        await _add_legacy_campaign(USER_A, file_id, prefix)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            owner = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_A},
            )
            assert owner.status_code == 200
            assert owner.content == PDF_BYTES

            stranger = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_B},
            )
            assert stranger.status_code == 404
    finally:
        await _remove_campaigns(prefix)
        path.unlink(missing_ok=True)
        (UPLOAD_DIR / f"{file_id}.owner.json").unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_legacy_media_with_ambiguous_tenant_references_is_denied():
    """İki tenant aynı legacy dosyayı referanslarsa sahiplik kanıtlanamaz."""
    file_id = "camp_00000000000000b8"
    path = UPLOAD_DIR / f"{file_id}_ambiguous.pdf"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PDF_BYTES)
    prefix = f"tz547-ambiguous-{file_id}"
    try:
        await _add_legacy_campaign(USER_A, file_id, f"{prefix}-a")
        await _add_legacy_campaign(USER_B, file_id, f"{prefix}-b")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            for user in (USER_A, USER_B):
                res = await client.get(
                    f"/api/v1/campaigns/media/{file_id}",
                    headers={"X-Test-User-Id": user},
                )
                assert res.status_code == 404
    finally:
        await _remove_campaigns(prefix)
        path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_corrupt_owner_metadata_fails_closed():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        data = await _upload(client, USER_A)
        file_id = data["file_id"]
        try:
            (UPLOAD_DIR / f"{file_id}.owner.json").write_text("{not-json", encoding="utf-8")
            res = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 404
        finally:
            _cleanup(file_id)


@pytest.mark.asyncio
async def test_owner_metadata_records_uploader():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        data = await _upload(client, USER_A)
        file_id = data["file_id"]
        try:
            payload = json.loads(
                (UPLOAD_DIR / f"{file_id}.owner.json").read_text(encoding="utf-8")
            )
            assert payload["user_id"] == USER_A
        finally:
            _cleanup(file_id)
