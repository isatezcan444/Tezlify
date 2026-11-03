"""AŞAMA 5.4.12 — Kampanya medyası sahiplik sertleştirmesi (F-1..F-4).

Kanıtlanan açıklar:
- F-1: sahiplik, URL'nin herhangi bir yerinde geçen dosya kimliğinden veya
  serbest metinden üretilebiliyordu.
- F-2: create/update isteğiyle gönderilen referans legacy sahiplik
  üretebiliyordu; iki adımlı yazma ile yabancı dosya "meşru" referansa
  dönüştürülebiliyordu.
- F-3: sahibin silme/güncellemesi legacy sahiplik yorumunu değiştirip başka
  tenant'a devredebiliyordu.
- F-4: yabancı bir referans eklemek gerçek sahibin GET/dispatch erişimini
  bozabiliyordu.

Bu dosya, düzeltmenin güvenlik sınırlarını bağımsız fixture'larla doğrular.
Hiçbir test önceki testlerin bıraktığı DB satırına veya sırasına bağlı
değildir; her test kendi verisini kurar ve `finally` içinde temizler.
"""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

from backend.app.core.database import AsyncSessionLocal
from backend.app.main import app
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.campaign_sequence_lead import CampaignSequenceLead
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.message_log import MessageLog
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.campaign_media_service import (
    CampaignMediaAccessDenied,
    CampaignMediaService,
    UPLOAD_DIR,
    extract_local_file_id,
    looks_like_local_media_reference,
)
from backend.app.services.outreach_manager import OutreachManager

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
PDF_BYTES = b"%PDF-1.4 5.4.12 ownership hardening test"
SEND_TARGET = "backend.app.services.whatsapp_service.start_conversation"


def _new_file_id() -> str:
    return f"camp_{uuid.uuid4().hex[:16]}"


def _media_url(file_id: str) -> str:
    return f"/api/v1/campaigns/media/{file_id}"


def _write_legacy_file(file_id: str) -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / f"{file_id}_legacy.pdf").write_bytes(PDF_BYTES)


def _cleanup_file(file_id: str) -> None:
    for path in UPLOAD_DIR.glob(f"{file_id}_*"):
        path.unlink(missing_ok=True)
    (UPLOAD_DIR / f"{file_id}.owner.json").unlink(missing_ok=True)


async def _upload(client: AsyncClient, user_id: str) -> dict:
    res = await client.post(
        "/api/v1/campaigns/upload-media",
        files={"file": ("katalog.pdf", PDF_BYTES, "application/pdf")},
        headers={"X-Test-User-Id": user_id},
    )
    assert res.status_code == 200, res.text
    return res.json()


async def _seed_campaign(
    owner: str | None,
    *,
    media_url: str | None = None,
    sequence_steps: list[dict] | None = None,
    status: CampaignStatus = CampaignStatus.DRAFT,
    name: str | None = None,
) -> int:
    async with AsyncSessionLocal() as db:
        campaign = Campaign(
            user_id=owner,
            name=name or f"tz5412-{uuid.uuid4().hex[:10]}",
            message_template="Merhaba {name}, kataloğumuz ekte.",
            status=status,
            media_url=media_url,
            media_type="DOCUMENT" if media_url else None,
            media_filename="katalog.pdf" if media_url else None,
            sequence_enabled=bool(sequence_steps),
            sequence_steps=sequence_steps,
            working_hours_enabled=False,
            min_delay_seconds=1,
            max_delay_seconds=2,
        )
        db.add(campaign)
        await db.commit()
        await db.refresh(campaign)
        return campaign.id


async def _seed_outreach(
    owner: str | None,
    *,
    media_url: str | None,
):
    async with AsyncSessionLocal() as db:
        phone = f"+9055{uuid.uuid4().int % 100_000_000:08d}"
        campaign = Campaign(
            user_id=owner,
            name=f"tz5412-dispatch-{uuid.uuid4().hex[:8]}",
            message_template="Merhaba {name}, güncel katalog.",
            status=CampaignStatus.DRAFT,
            media_url=media_url,
            media_type="DOCUMENT" if media_url else None,
            media_filename="katalog.pdf" if media_url else None,
            working_hours_enabled=False,
            min_delay_seconds=1,
            max_delay_seconds=2,
        )
        lead = Lead(
            user_id=owner,
            name=f"Firma {uuid.uuid4().hex[:6]}",
            phone=phone,
            phone_e164=phone,
            status=LeadStatus.NEW,
            is_whatsapp_eligible=True,
        )
        session = WhatsAppSession(
            user_id=owner,
            gateway_id=f"gw-{uuid.uuid4().hex[:12]}",
            session_name="tz5412 hat",
            phone_number=f"+9054{uuid.uuid4().int % 100_000_000:08d}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add_all([campaign, lead, session])
        await db.commit()
        for obj in (campaign, lead, session):
            await db.refresh(obj)
        return {
            "campaign_id": campaign.id,
            "lead_id": lead.id,
            "session_id": session.id,
            "phone": phone,
        }


async def _cleanup_db(
    *,
    campaign_ids: tuple[int, ...] = (),
    lead_ids: tuple[int, ...] = (),
    session_ids: tuple[int, ...] = (),
) -> None:
    async with AsyncSessionLocal() as db:
        if campaign_ids:
            await db.execute(
                delete(MessageLog).where(MessageLog.campaign_id.in_(campaign_ids))
            )
            await db.execute(
                delete(CampaignSequenceLead).where(
                    CampaignSequenceLead.campaign_id.in_(campaign_ids)
                )
            )
            await db.execute(delete(Campaign).where(Campaign.id.in_(campaign_ids)))
        if lead_ids:
            await db.execute(delete(Lead).where(Lead.id.in_(lead_ids)))
        if session_ids:
            await db.execute(
                delete(WhatsAppSession).where(WhatsAppSession.id.in_(session_ids))
            )
        await db.commit()


async def _campaign_by_name(name: str) -> Campaign | None:
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(select(Campaign).where(Campaign.name == name))
        ).scalars().first()


# ============================================================
# L2 — Merkezî parser ve yerel-medya sezici (birim)
# ============================================================


def test_canonical_parser_accepts_only_full_canonical_form():
    file_id = "camp_0123456789abcdef"
    assert extract_local_file_id(f"/api/v1/campaigns/media/{file_id}") == file_id
    for noncanonical in (
        f"https://evil.example/api/v1/campaigns/media/{file_id}",
        f"/api/v1/campaigns/media/../{file_id}",
        f"/api/v1/campaigns/media/%2e%2e/{file_id}",
        f"/api/v1/campaigns/media/{file_id}?x=1",
        f"/api/v1/campaigns/media/{file_id}#frag",
        f"  /api/v1/campaigns/media/{file_id}  ",
        f"/campaigns/media/{file_id}",
        f"evil.example/{file_id}",
        file_id,
        "camp_0123456789ABCDEF",
        "",
        None,
    ):
        assert extract_local_file_id(noncanonical) is None


def test_local_media_detector_flags_disguised_forms():
    file_id = "camp_0123456789abcdef"
    for disguised in (
        f"https://evil.example/api/v1/campaigns/media/{file_id}",
        f"/api/v1/campaigns/media/../{file_id}",
        f"/api%2Fv1%2Fcampaigns%2Fmedia%2F{file_id}",
        f"javascript:alert('/campaigns/media/{file_id}')",
        f"https://evil.example/{file_id}",
        f"campaigns/media/{file_id}",
        file_id,
    ):
        assert looks_like_local_media_reference(disguised) is True

    # Bu depoyu hedeflemeyen sıradan harici URL'ler serbesttir.
    assert looks_like_local_media_reference("https://example.com/katalog.pdf") is False
    assert looks_like_local_media_reference("") is False
    assert looks_like_local_media_reference(None) is False


# ============================================================
# 1 — Sidecar sahibi başka tenant'ı reddeder
# ============================================================


@pytest.mark.asyncio
async def test_sidecar_owner_denies_other_tenant():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    cid_b = await _seed_campaign(USER_B, media_url=media["media_url"])
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            owner = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_A},
            )
            stranger = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_B},
            )
        assert owner.status_code == 200
        assert owner.content == PDF_BYTES
        assert stranger.status_code == 404

        async with AsyncSessionLocal() as db:
            assert await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_A
            )
            assert not await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_B
            )
    finally:
        await _cleanup_db(campaign_ids=(cid_b,))
        _cleanup_file(file_id)


# ============================================================
# 2/3/4 — Kanonik olmayan referanslar legacy sahiplik kanıtlamaz
# ============================================================


@pytest.mark.asyncio
async def test_external_url_cannot_prove_legacy_ownership():
    file_id = _new_file_id()
    _write_legacy_file(file_id)
    cid_a = await _seed_campaign(USER_A, media_url=_media_url(file_id))
    cid_b = await _seed_campaign(
        USER_B, media_url=f"https://evil.example/{file_id}"
    )
    opened = {"called": False}

    def _forbidden(_file_id: str):
        opened["called"] = True
        raise AssertionError("yetkisiz legacy erişiminde bayt okunmamalı")

    try:
        async with AsyncSessionLocal() as db:
            assert await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_A
            )
            assert not await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_B
            )

        with patch.object(
            CampaignMediaService, "get_media_file_info", staticmethod(_forbidden)
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                res = await client.get(
                    f"/api/v1/campaigns/media/{file_id}",
                    headers={"X-Test-User-Id": USER_B},
                )
        assert res.status_code == 404
        assert opened["called"] is False
    finally:
        await _cleanup_db(campaign_ids=(cid_a, cid_b))
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_schemeless_url_cannot_prove_legacy_ownership():
    file_id = _new_file_id()
    _write_legacy_file(file_id)
    cid_a = await _seed_campaign(USER_A, media_url=_media_url(file_id))
    cid_b = await _seed_campaign(
        USER_B, media_url=f"evil.example/{file_id}"
    )
    try:
        async with AsyncSessionLocal() as db:
            assert await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_A
            )
            assert not await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_B
            )
    finally:
        await _cleanup_db(campaign_ids=(cid_a, cid_b))
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_embedded_id_substring_cannot_prove_legacy_ownership():
    file_id = _new_file_id()
    _write_legacy_file(file_id)
    cid_a = await _seed_campaign(USER_A, media_url=_media_url(file_id))
    cid_b = await _seed_campaign(
        USER_B,
        media_url=f"https://cdn.example/files/{file_id}.pdf",
        sequence_steps=[
            {
                "step_number": 1,
                "delay_days": 0,
                "delay_hours": 0,
                "message_template": f"Kimlik: {file_id}",
            }
        ],
    )
    try:
        async with AsyncSessionLocal() as db:
            assert await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_A
            )
            assert not await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_B
            )
    finally:
        await _cleanup_db(campaign_ids=(cid_a, cid_b))
        _cleanup_file(file_id)


# ============================================================
# 5 — Kanonik olmayan yerel biçimler yazmada reddedilir
# ============================================================


@pytest.mark.parametrize(
    "variant",
    [
        "/api/v1/campaigns/media/../{id}",
        "/api/v1/campaigns/media/%2e%2e/{id}",
        "/api%2Fv1%2Fcampaigns%2Fmedia%2F{id}",
        "/api/v1/campaigns/media/{id}?x=1",
        "/api/v1/campaigns/media/{id}#frag",
        "  /api/v1/campaigns/media/{id}  ",
        "https://evil.example/api/v1/campaigns/media/{id}",
        "https://evil.example/{id}",
        "{id}",
    ],
)
@pytest.mark.asyncio
async def test_noncanonical_local_media_forms_are_rejected_on_create(variant):
    file_id = _new_file_id()
    _write_legacy_file(file_id)
    cid = await _seed_campaign(USER_A, media_url=_media_url(file_id))
    name = f"tz5412-variant-{uuid.uuid4().hex[:8]}"
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": name,
                    "message_template": "Merhaba {name}",
                    "media_url": variant.format(id=file_id),
                },
                headers={"X-Test-User-Id": USER_A},
            )
        assert res.status_code == 400, (variant, res.text)
        assert "doğrulanamadı" in res.json()["detail"]
        assert await _campaign_by_name(name) is None
    finally:
        await _cleanup_db(campaign_ids=(cid,))
        _cleanup_file(file_id)


# ============================================================
# 6/7/8 — Create/update/sequence yabancı referansı reddeder
# ============================================================


@pytest.mark.asyncio
async def test_create_rejects_foreign_sidecar_media():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        name = f"tz5412-create-foreign-{uuid.uuid4().hex[:8]}"
        try:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": name,
                    "message_template": "Merhaba {name}",
                    "media_url": media["media_url"],
                },
                headers={"X-Test-User-Id": USER_B},
            )
            assert res.status_code == 400
            assert await _campaign_by_name(name) is None
        finally:
            _cleanup_file(media["file_id"])


@pytest.mark.asyncio
async def test_update_rejects_foreign_media_without_changing_row():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        cid = await _seed_campaign(USER_B)
        try:
            res = await client.patch(
                f"/api/v1/campaigns/{cid}",
                json={"media_url": media["media_url"]},
                headers={"X-Test-User-Id": USER_B},
            )
            assert res.status_code == 400
            stored = await client.get(
                f"/api/v1/campaigns/{cid}", headers={"X-Test-User-Id": USER_B}
            )
            assert stored.status_code == 200
            assert stored.json()["media_url"] is None
        finally:
            await _cleanup_db(campaign_ids=(cid,))
            _cleanup_file(media["file_id"])


@pytest.mark.asyncio
async def test_sequence_step_foreign_media_is_rejected():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        try:
            canonical = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz5412-seq-a-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "sequence_enabled": True,
                    "sequence_steps": [
                        {
                            "step_number": 1,
                            "delay_days": 0,
                            "delay_hours": 0,
                            "message_template": "Adım 1",
                            "media_url": media["media_url"],
                        }
                    ],
                },
                headers={"X-Test-User-Id": USER_B},
            )
            assert canonical.status_code == 400

            disguised = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz5412-seq-b-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "sequence_enabled": True,
                    "sequence_steps": [
                        {
                            "step_number": 1,
                            "delay_days": 0,
                            "delay_hours": 0,
                            "message_template": "Adım 1",
                            "media_url": (
                                "https://evil.example/api/v1/campaigns/media/"
                                f"{media['file_id']}"
                            ),
                        }
                    ],
                },
                headers={"X-Test-User-Id": USER_B},
            )
            assert disguised.status_code == 400
        finally:
            _cleanup_file(media["file_id"])


# ============================================================
# 9/10 — Sahibin silme/güncellemesi sahiplik devretmez
# ============================================================


@pytest.mark.asyncio
async def test_owner_delete_does_not_transfer_legacy_ownership():
    file_id = _new_file_id()
    _write_legacy_file(file_id)
    cid_a = await _seed_campaign(USER_A, media_url=_media_url(file_id))
    # Eski (fix öncesi) kontaminasyonu taklit et: B'nin satırı kimliği
    # kanonik olmayan bir URL içinde taşıyor. Bu referans sahiplik SAYILMAZ.
    cid_b = await _seed_campaign(
        USER_B, media_url=f"https://evil.example/{file_id}"
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            assert (
                await client.get(
                    f"/api/v1/campaigns/media/{file_id}",
                    headers={"X-Test-User-Id": USER_A},
                )
            ).status_code == 200
            assert (
                await client.get(
                    f"/api/v1/campaigns/media/{file_id}",
                    headers={"X-Test-User-Id": USER_B},
                )
            ).status_code == 404

            deleted = await client.delete(
                f"/api/v1/campaigns/{cid_a}",
                headers={"X-Test-User-Id": USER_A},
            )
            assert deleted.status_code == 204

            after_delete = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_B},
            )
            assert after_delete.status_code == 404

        async with AsyncSessionLocal() as db:
            assert not await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_B
            )
            assert not await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_A
            )
    finally:
        await _cleanup_db(campaign_ids=(cid_a, cid_b))
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_owner_update_away_does_not_transfer_legacy_ownership():
    file_id = _new_file_id()
    _write_legacy_file(file_id)
    cid_a = await _seed_campaign(USER_A, media_url=_media_url(file_id))
    cid_b = await _seed_campaign(
        USER_B, media_url=f"evil.example/{file_id}"
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            # A kendi referansını kaldırır.
            updated = await client.patch(
                f"/api/v1/campaigns/{cid_a}",
                json={"media_url": None},
                headers={"X-Test-User-Id": USER_A},
            )
            assert updated.status_code == 200, updated.text

            # B, artık sahipsiz kalan dosyayı kanonik referansla sahiplenemez.
            attach = await client.patch(
                f"/api/v1/campaigns/{cid_b}",
                json={"media_url": _media_url(file_id)},
                headers={"X-Test-User-Id": USER_B},
            )
            assert attach.status_code == 400

            denied = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_B},
            )
            assert denied.status_code == 404

        async with AsyncSessionLocal() as db:
            assert not await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_B
            )
    finally:
        await _cleanup_db(campaign_ids=(cid_a, cid_b))
        _cleanup_file(file_id)


# ============================================================
# 11/12 — Sidecar tek kanıttır; yetkisiz GET bayt okumaz
# ============================================================


@pytest.mark.asyncio
async def test_sidecar_is_not_overridden_by_conflicting_db_reference():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    cid_b = await _seed_campaign(USER_B, media_url=media["media_url"])
    try:
        async with AsyncSessionLocal() as db:
            assert await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_A
            )
            assert not await CampaignMediaService.authorize_media_reference(
                db, file_id, USER_B
            )
    finally:
        await _cleanup_db(campaign_ids=(cid_b,))
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_unauthorized_get_does_not_read_bytes():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    opened = {"called": False}

    def _forbidden(_file_id: str):
        opened["called"] = True
        raise AssertionError("yetkisiz GET medya dosyasını açmamalı")

    try:
        with patch.object(
            CampaignMediaService, "get_media_file_info", staticmethod(_forbidden)
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                res = await client.get(
                    f"/api/v1/campaigns/media/{file_id}",
                    headers={"X-Test-User-Id": USER_B},
                )
        assert res.status_code == 404
        assert opened["called"] is False
    finally:
        _cleanup_file(file_id)


# ============================================================
# 13/14 — Yetkisiz dispatch bayt okumaz ve yan etki üretmez
# ============================================================


@pytest.mark.asyncio
async def test_unauthorized_dispatch_does_not_read_bytes():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    seeded = await _seed_outreach(USER_B, media_url=media["media_url"])
    opened = {"called": False}

    def _forbidden(_file_id: str):
        opened["called"] = True
        raise AssertionError("yetkisiz dispatch medya dosyasını açmamalı")

    try:
        with patch.object(
            CampaignMediaService, "get_media_file_info", staticmethod(_forbidden)
        ), patch(SEND_TARGET, new_callable=AsyncMock) as send:
            async with AsyncSessionLocal() as db:
                lead = await db.get(Lead, seeded["lead_id"])
                campaign = await db.get(Campaign, seeded["campaign_id"])
                ok, reason, log_id = await OutreachManager.process_single_outreach(
                    db,
                    lead.id,
                    campaign.id,
                    lead=lead,
                    campaign=campaign,
                    blacklisted_phones=set(),
                )
        assert ok is False
        assert log_id is None
        assert "doğrulanamadı" in reason.lower()
        send.assert_not_awaited()
        assert opened["called"] is False
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_unauthorized_dispatch_has_no_send_log_or_counter_side_effects():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    seeded = await _seed_outreach(USER_B, media_url=media["media_url"])
    try:
        with patch(SEND_TARGET, new_callable=AsyncMock) as send:
            async with AsyncSessionLocal() as db:
                lead = await db.get(Lead, seeded["lead_id"])
                campaign = await db.get(Campaign, seeded["campaign_id"])
                ok, _, log_id = await OutreachManager.process_single_outreach(
                    db,
                    lead.id,
                    campaign.id,
                    lead=lead,
                    campaign=campaign,
                    blacklisted_phones=set(),
                )
        assert ok is False
        assert log_id is None
        send.assert_not_awaited()

        async with AsyncSessionLocal() as db:
            logs = (
                await db.execute(
                    select(MessageLog).where(
                        MessageLog.campaign_id == seeded["campaign_id"]
                    )
                )
            ).scalars().all()
            assert logs == []
            lead = await db.get(Lead, seeded["lead_id"])
            campaign = await db.get(Campaign, seeded["campaign_id"])
            assert lead.status == LeadStatus.NEW
            assert lead.last_contacted_at is None
            assert campaign.sent_count in (0, None)
            assert campaign.failed_count in (0, None)
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )
        _cleanup_file(file_id)


# ============================================================
# 15 — Geçerli sidecar sahibi GET/dispatch'e devam eder
# ============================================================


@pytest.mark.asyncio
async def test_valid_sidecar_owner_get_and_dispatch_still_work():
    import base64

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            res = await client.get(
                f"/api/v1/campaigns/media/{file_id}",
                headers={"X-Test-User-Id": USER_A},
            )
        assert res.status_code == 200
        assert res.content == PDF_BYTES

        seeded = await _seed_outreach(USER_A, media_url=media["media_url"])
        try:
            with patch(SEND_TARGET, new_callable=AsyncMock) as send:
                send.return_value = {"id": "wamid.TZ5412_OWNER"}
                async with AsyncSessionLocal() as db:
                    lead = await db.get(Lead, seeded["lead_id"])
                    campaign = await db.get(Campaign, seeded["campaign_id"])
                    ok, _, log_id = await OutreachManager.process_single_outreach(
                        db,
                        lead.id,
                        campaign.id,
                        lead=lead,
                        campaign=campaign,
                        blacklisted_phones=set(),
                    )
            assert ok is True
            assert log_id
            send.assert_awaited_once()
            payload = send.await_args.kwargs["media"]
            assert base64.b64decode(payload["media_base64"]) == PDF_BYTES
        finally:
            await _cleanup_db(
                campaign_ids=(seeded["campaign_id"],),
                lead_ids=(seeded["lead_id"],),
                session_ids=(seeded["session_id"],),
            )
    finally:
        _cleanup_file(file_id)


# ============================================================
# 16 — Kanıtlanamayan legacy dosya herkese fail-closed
# ============================================================


@pytest.mark.asyncio
async def test_unprovable_legacy_file_fails_closed_for_everyone():
    file_id = _new_file_id()
    _write_legacy_file(file_id)
    opened = {"called": False}

    def _forbidden(_file_id: str):
        opened["called"] = True
        raise AssertionError("kanıtlanamayan legacy dosya açılmamalı")

    try:
        with patch.object(
            CampaignMediaService, "get_media_file_info", staticmethod(_forbidden)
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                for user in (USER_A, USER_B):
                    res = await client.get(
                        f"/api/v1/campaigns/media/{file_id}",
                        headers={"X-Test-User-Id": user},
                    )
                    assert res.status_code == 404

                created = await client.post(
                    "/api/v1/campaigns",
                    json={
                        "name": f"tz5412-orphan-{uuid.uuid4().hex[:8]}",
                        "message_template": "Merhaba {name}",
                        "media_url": _media_url(file_id),
                    },
                    headers={"X-Test-User-Id": USER_A},
                )
                assert created.status_code == 400

            async with AsyncSessionLocal() as db:
                with pytest.raises(CampaignMediaAccessDenied):
                    await CampaignMediaService.get_authorized_campaign_media_base64(
                        db, _media_url(file_id), USER_A
                    )
        assert opened["called"] is False
    finally:
        _cleanup_file(file_id)
