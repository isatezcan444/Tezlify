"""AŞAMA 5.4.9 — Kampanya medyası dispatch ve referans tenant güvenliği.

Kapsam:
- A-1: dispatch yolları (OutreachManager, CampaignRunner) medya baytlarını
  okumadan ÖNCE tenant sahipliğini doğrular; kanıt yoksa gönderimi durdurur.
- A-2: create/update yeni bir medya referansıyla sahiplik ÜRETEMEZ; legacy
  sahiplik yalnız önceden var olan tek-tenant ilişkiden çıkarılır.
- A-3: sekans adımı medyası aynı modeli kullanır ve ana medyadan ayrı
  doğrulanır.
"""

import base64
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.main import app
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.campaign_sequence_lead import (
    CampaignSequenceLead,
    SequenceLeadStatus,
)
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.message_log import MessageLog
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.campaign_media_service import (
    CampaignMediaAccessDenied,
    CampaignMediaService,
    UPLOAD_DIR,
)
from backend.app.services.campaign_runner import CampaignRunner
from backend.app.services.outreach_manager import OutreachManager

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
PDF_BYTES = b"%PDF-1.4 dispatch tenant authorization test"
SEND_TARGET = "backend.app.services.whatsapp_service.start_conversation"


def _cleanup_file(file_id: str) -> None:
    for path in UPLOAD_DIR.glob(f"{file_id}_*"):
        path.unlink(missing_ok=True)
    (UPLOAD_DIR / f"{file_id}.owner.json").unlink(missing_ok=True)


def _write_legacy_file(file_id: str, name: str = "legacy.pdf") -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / f"{file_id}_{name}").write_bytes(PDF_BYTES)


def _media_url(file_id: str) -> str:
    return f"/api/v1/campaigns/media/{file_id}"


async def _upload(client: AsyncClient, user_id: str) -> dict:
    res = await client.post(
        "/api/v1/campaigns/upload-media",
        files={"file": ("katalog.pdf", PDF_BYTES, "application/pdf")},
        headers={"X-Test-User-Id": user_id},
    )
    assert res.status_code == 200, res.text
    return res.json()


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


def _unique_phone() -> str:
    return f"+9055{uuid.uuid4().int % 100_000_000:08d}"


async def _seed_campaign_only(
    owner: str | None,
    *,
    media_url: str | None = None,
    sequence_steps: list[dict] | None = None,
    status: CampaignStatus = CampaignStatus.DRAFT,
):
    async with AsyncSessionLocal() as db:
        campaign = Campaign(
            user_id=owner,
            name=f"tz549-{uuid.uuid4().hex[:10]}",
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
    media_url: str | None = None,
    media_type: str | None = None,
    media_filename: str | None = None,
):
    """Tek lead + CONNECTED hat + DRAFT kampanya (dispatch testi için)."""
    async with AsyncSessionLocal() as db:
        phone = _unique_phone()
        campaign = Campaign(
            user_id=owner,
            name=f"tz549-dispatch-{uuid.uuid4().hex[:8]}",
            message_template="Merhaba {name}, güncel katalog.",
            status=CampaignStatus.DRAFT,
            media_url=media_url,
            media_type=media_type,
            media_filename=media_filename,
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
            session_name="tz549 hat",
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


async def _seed_sequence(owner: str | None, steps: list[dict]):
    async with AsyncSessionLocal() as db:
        phone = _unique_phone()
        campaign = Campaign(
            user_id=owner,
            name=f"tz549-seq-{uuid.uuid4().hex[:8]}",
            message_template="Merhaba {name}, takip mesajı.",
            status=CampaignStatus.ACTIVE,
            sequence_enabled=True,
            sequence_steps=steps,
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
            session_name="tz549 seq hat",
            phone_number=f"+9054{uuid.uuid4().int % 100_000_000:08d}",
            status=SessionStatus.CONNECTED,
            is_active=True,
        )
        db.add_all([campaign, lead, session])
        await db.commit()
        for obj in (campaign, lead, session):
            await db.refresh(obj)

        seq_lead = CampaignSequenceLead(
            user_id=owner,
            campaign_id=campaign.id,
            lead_id=lead.id,
            whatsapp_session_id=session.id,
            current_step=1,
            total_steps=len(steps),
            status=SequenceLeadStatus.ACTIVE,
            next_step_at=utc_now_naive() - timedelta(minutes=5),
        )
        db.add(seq_lead)
        await db.commit()
        await db.refresh(seq_lead)
        return {
            "campaign_id": campaign.id,
            "lead_id": lead.id,
            "session_id": session.id,
            "seq_lead_id": seq_lead.id,
            "phone": phone,
        }


# ============================================================
# A-1 — Dispatch: bayt okunmadan önce sahiplik
# ============================================================


@pytest.mark.asyncio
async def test_dispatch_owner_media_is_authorized_and_sent():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    seeded = await _seed_outreach(
        USER_A,
        media_url=media["media_url"],
        media_type="DOCUMENT",
        media_filename=media["filename"],
    )
    try:
        with patch(SEND_TARGET, new_callable=AsyncMock) as send:
            send.return_value = {"id": "wamid.TZ549_OWNER"}
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
        assert payload["filename"] == media["filename"]
        assert send.await_args.kwargs["message"] is None
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_dispatch_denies_foreign_media_before_reading_bytes(monkeypatch):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    # B, A'nın dosyasını kendi kampanyasına yazmış olsa bile erişemez.
    seeded = await _seed_outreach(
        USER_B,
        media_url=media["media_url"],
        media_type="DOCUMENT",
        media_filename=media["filename"],
    )
    opened = {"called": False}

    def _forbidden(file_id: str):
        opened["called"] = True
        raise AssertionError("yetkisiz dispatch medya dosyasını açmamalı")

    monkeypatch.setattr(
        CampaignMediaService, "get_media_file_info", staticmethod(_forbidden)
    )
    try:
        with patch(SEND_TARGET, new_callable=AsyncMock) as send:
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

        async with AsyncSessionLocal() as db:
            campaign = await db.get(Campaign, seeded["campaign_id"])
            assert campaign.failed_count in (0, None)
            logs = (
                await db.execute(
                    select(MessageLog).where(
                        MessageLog.campaign_id == seeded["campaign_id"]
                    )
                )
            ).scalars().all()
            assert logs == []
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_dispatch_without_campaign_owner_fails_closed():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    seeded = await _seed_outreach(
        None, media_url=media["media_url"], media_type="DOCUMENT"
    )
    try:
        with patch(SEND_TARGET, new_callable=AsyncMock) as send:
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
        assert "user_id" in reason
        send.assert_not_awaited()
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_dispatch_authorized_but_missing_file_falls_back_to_text():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    seeded = await _seed_outreach(
        USER_A, media_url=media["media_url"], media_type="DOCUMENT"
    )
    # Yetki geçerli (yan dosya duruyor) ama medya baytları yok: metne dönüş.
    for path in UPLOAD_DIR.glob(f"{file_id}_*"):
        path.unlink(missing_ok=True)
    try:
        with patch(SEND_TARGET, new_callable=AsyncMock) as send:
            send.return_value = {"id": "wamid.TZ549_TEXT_FALLBACK"}
            async with AsyncSessionLocal() as db:
                lead = await db.get(Lead, seeded["lead_id"])
                campaign = await db.get(Campaign, seeded["campaign_id"])
                ok, _, _ = await OutreachManager.process_single_outreach(
                    db,
                    lead.id,
                    campaign.id,
                    lead=lead,
                    campaign=campaign,
                    blacklisted_phones=set(),
                )
        assert ok is True
        send.assert_awaited_once()
        assert send.await_args.kwargs["media"] is None
        assert send.await_args.kwargs["message"]
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_dispatch_external_media_url_is_unchanged():
    seeded = await _seed_outreach(
        USER_A,
        media_url="https://example.com/katalog.pdf",
        media_type="DOCUMENT",
        media_filename="katalog.pdf",
    )
    try:
        with patch(SEND_TARGET, new_callable=AsyncMock) as send:
            send.return_value = {"id": "wamid.TZ549_EXTERNAL"}
            async with AsyncSessionLocal() as db:
                lead = await db.get(Lead, seeded["lead_id"])
                campaign = await db.get(Campaign, seeded["campaign_id"])
                ok, _, _ = await OutreachManager.process_single_outreach(
                    db,
                    lead.id,
                    campaign.id,
                    lead=lead,
                    campaign=campaign,
                    blacklisted_phones=set(),
                )
        assert ok is True
        payload = send.await_args.kwargs["media"]
        assert payload["media_url"] == "https://example.com/katalog.pdf"
        assert payload["media_base64"] is None
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )


@pytest.mark.asyncio
async def test_authorized_resolver_requires_tenant_context():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    try:
        async with AsyncSessionLocal() as db:
            for blank in (None, "", "   "):
                with pytest.raises(CampaignMediaAccessDenied):
                    await CampaignMediaService.get_authorized_campaign_media_base64(
                        db, media["media_url"], blank
                    )
            # Yerel olmayan URL tenant bağlamı gerektirmez.
            assert (
                await CampaignMediaService.get_authorized_campaign_media_base64(
                    db, "https://example.com/x.pdf", None
                )
                is None
            )
    finally:
        _cleanup_file(media["file_id"])


# ============================================================
# A-2 — Referans oluşturma/güncelleme sahiplik üretmez
# ============================================================


@pytest.mark.asyncio
async def test_create_with_own_upload_is_accepted():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        cid = None
        try:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-own-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": media["media_url"],
                    "media_type": "DOCUMENT",
                    "media_filename": media["filename"],
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 201, res.text
            cid = res.json()["id"]
        finally:
            await _cleanup_db(campaign_ids=(cid,) if cid else ())
            _cleanup_file(media["file_id"])


@pytest.mark.asyncio
async def test_create_with_foreign_upload_is_rejected():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        try:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-foreign-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": media["media_url"],
                    "media_type": "DOCUMENT",
                },
                headers={"X-Test-User-Id": USER_B},
            )
            assert res.status_code == 400
            assert "doğrulanamadı" in res.json()["detail"]
        finally:
            _cleanup_file(media["file_id"])


@pytest.mark.asyncio
async def test_create_with_unknown_file_id_is_rejected():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        res = await client.post(
            "/api/v1/campaigns",
            json={
                "name": f"tz549-unknown-{uuid.uuid4().hex[:8]}",
                "message_template": "Merhaba {name}",
                "media_url": "/api/v1/campaigns/media/camp_ffffffffffffffff",
                "media_type": "DOCUMENT",
            },
            headers={"X-Test-User-Id": USER_A},
        )
        assert res.status_code == 400


@pytest.mark.asyncio
async def test_create_with_orphan_legacy_file_is_rejected():
    """Yan dosyası ve referansı olmayan legacy dosya sahiplenilemez."""
    file_id = "camp_0000000000000101"
    _write_legacy_file(file_id)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-orphan-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": _media_url(file_id),
                },
                headers={"X-Test-User-Id": USER_A},
            )
        assert res.status_code == 400
    finally:
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_legacy_reference_is_accepted_only_for_existing_single_tenant():
    file_id = "camp_0000000000000102"
    _write_legacy_file(file_id)
    legacy_cid = await _seed_campaign_only(USER_A, media_url=_media_url(file_id))
    created: list[int] = []
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            own = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-legacy-own-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": _media_url(file_id),
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert own.status_code == 201, own.text
            created.append(own.json()["id"])

            foreign = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-legacy-foreign-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": _media_url(file_id),
                },
                headers={"X-Test-User-Id": USER_B},
            )
            assert foreign.status_code == 400
    finally:
        await _cleanup_db(campaign_ids=(legacy_cid, *created))
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_ambiguous_legacy_references_are_rejected():
    file_id = "camp_0000000000000103"
    _write_legacy_file(file_id)
    cid_a = await _seed_campaign_only(USER_A, media_url=_media_url(file_id))
    cid_b = await _seed_campaign_only(USER_B, media_url=_media_url(file_id))
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            for user in (USER_A, USER_B):
                res = await client.post(
                    "/api/v1/campaigns",
                    json={
                        "name": f"tz549-ambiguous-{uuid.uuid4().hex[:8]}",
                        "message_template": "Merhaba {name}",
                        "media_url": _media_url(file_id),
                    },
                    headers={"X-Test-User-Id": user},
                )
                assert res.status_code == 400
    finally:
        await _cleanup_db(campaign_ids=(cid_a, cid_b))
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_corrupt_sidecar_blocks_reference_creation():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        file_id = media["file_id"]
        (UPLOAD_DIR / f"{file_id}.owner.json").write_text(
            "{not-json", encoding="utf-8"
        )
        try:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-corrupt-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": media["media_url"],
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 400
        finally:
            _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_update_attaching_foreign_media_is_rejected_and_unchanged():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        own_media = await _upload(client, USER_A)
        foreign_media = await _upload(client, USER_B)
        cid = None
        try:
            created = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-update-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert created.status_code == 201, created.text
            cid = created.json()["id"]

            res = await client.patch(
                f"/api/v1/campaigns/{cid}",
                json={"media_url": foreign_media["media_url"]},
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 400

            stored = await client.get(
                f"/api/v1/campaigns/{cid}", headers={"X-Test-User-Id": USER_A}
            )
            assert stored.json()["media_url"] is None
        finally:
            await _cleanup_db(campaign_ids=(cid,) if cid else ())
            _cleanup_file(own_media["file_id"])
            _cleanup_file(foreign_media["file_id"])


@pytest.mark.asyncio
async def test_update_attaching_own_media_is_accepted():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        cid = None
        try:
            created = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-update-own-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                },
                headers={"X-Test-User-Id": USER_A},
            )
            cid = created.json()["id"]
            res = await client.patch(
                f"/api/v1/campaigns/{cid}",
                json={"media_url": media["media_url"], "media_type": "DOCUMENT"},
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 200, res.text
            assert res.json()["media_url"] == media["media_url"]
        finally:
            await _cleanup_db(campaign_ids=(cid,) if cid else ())
            _cleanup_file(media["file_id"])


def _step(step_number: int, media_url: str | None = None) -> dict:
    data = {
        "step_number": step_number,
        "delay_days": 0,
        "delay_hours": 0,
        "message_template": f"Adım {step_number}: Merhaba {{name}}",
    }
    if media_url:
        data["media_url"] = media_url
        data["media_type"] = "DOCUMENT"
        data["media_filename"] = "katalog.pdf"
    return data


@pytest.mark.asyncio
async def test_create_sequence_with_foreign_media_is_rejected():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        try:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-seq-foreign-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "sequence_enabled": True,
                    "sequence_steps": [
                        _step(1),
                        _step(2, media["media_url"]),
                    ],
                },
                headers={"X-Test-User-Id": USER_B},
            )
            assert res.status_code == 400
        finally:
            _cleanup_file(media["file_id"])


@pytest.mark.asyncio
async def test_create_sequence_with_own_media_is_accepted():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
        cid = None
        try:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-seq-own-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "sequence_enabled": True,
                    "sequence_steps": [
                        _step(1),
                        _step(2, media["media_url"]),
                    ],
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 201, res.text
            cid = res.json()["id"]
            assert res.json()["sequence_steps"][1]["media_url"] == media["media_url"]
        finally:
            await _cleanup_db(campaign_ids=(cid,) if cid else ())
            _cleanup_file(media["file_id"])


@pytest.mark.asyncio
async def test_sequence_with_one_foreign_step_is_rejected():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        own_media = await _upload(client, USER_A)
        foreign_media = await _upload(client, USER_B)
        try:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-seq-mixed-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "sequence_enabled": True,
                    "sequence_steps": [
                        _step(1, own_media["media_url"]),
                        _step(2, foreign_media["media_url"]),
                    ],
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 400
        finally:
            _cleanup_file(own_media["file_id"])
            _cleanup_file(foreign_media["file_id"])


@pytest.mark.asyncio
async def test_main_and_sequence_media_are_validated_separately():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        own_media = await _upload(client, USER_A)
        foreign_media = await _upload(client, USER_B)
        try:
            # Ana medya geçerli, adım medyası yabancı.
            main_ok_step_foreign = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-main-ok-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": own_media["media_url"],
                    "sequence_enabled": True,
                    "sequence_steps": [
                        _step(1),
                        _step(2, foreign_media["media_url"]),
                    ],
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert main_ok_step_foreign.status_code == 400

            # Ana medya yabancı, adım medyası geçerli.
            main_foreign_step_ok = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-step-ok-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": foreign_media["media_url"],
                    "sequence_enabled": True,
                    "sequence_steps": [
                        _step(1),
                        _step(2, own_media["media_url"]),
                    ],
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert main_foreign_step_ok.status_code == 400
        finally:
            _cleanup_file(own_media["file_id"])
            _cleanup_file(foreign_media["file_id"])


@pytest.mark.asyncio
async def test_create_with_external_media_url_is_still_accepted():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        cid = None
        try:
            res = await client.post(
                "/api/v1/campaigns",
                json={
                    "name": f"tz549-external-{uuid.uuid4().hex[:8]}",
                    "message_template": "Merhaba {name}",
                    "media_url": "https://example.com/katalog.pdf",
                    "media_type": "DOCUMENT",
                },
                headers={"X-Test-User-Id": USER_A},
            )
            assert res.status_code == 201, res.text
            cid = res.json()["id"]
        finally:
            await _cleanup_db(campaign_ids=(cid,) if cid else ())


# ============================================================
# A-3 — Sekans dispatch ve legacy sekans referansı
# ============================================================


@pytest.mark.asyncio
async def test_sequence_dispatch_authorized_step_media_is_sent():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    seeded = await _seed_sequence(
        USER_A,
        [
            _step(1),
            _step(2, media["media_url"]),
            _step(3),
        ],
    )
    try:
        with patch(SEND_TARGET, new_callable=AsyncMock) as send:
            send.return_value = {"id": "wamid.TZ549_SEQ_STEP2"}
            processed = await CampaignRunner.process_due_sequence_followups()
        assert processed >= 1
        calls = [
            call for call in send.await_args_list
            if call.kwargs.get("phone") == seeded["phone"]
        ]
        assert len(calls) == 1
        payload = calls[0].kwargs["media"]
        assert base64.b64decode(payload["media_base64"]) == PDF_BYTES
        assert payload["filename"] == media["filename"]

        async with AsyncSessionLocal() as db:
            seq_lead = await db.get(CampaignSequenceLead, seeded["seq_lead_id"])
            assert seq_lead.current_step == 2
            assert seq_lead.status == SequenceLeadStatus.ACTIVE
            assert seq_lead.next_step_at is not None
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )
        _cleanup_file(media["file_id"])


@pytest.mark.asyncio
async def test_sequence_dispatch_denies_foreign_step_media_before_reading_bytes(
    monkeypatch,
):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    # B'nin kampanyası A'nın dosyasını adım medyası olarak taşıyor.
    seeded = await _seed_sequence(
        USER_B,
        [
            _step(1),
            _step(2, media["media_url"]),
        ],
    )
    opened = {"called": False}

    def _forbidden(file_id: str):
        opened["called"] = True
        raise AssertionError("yetkisiz sekans dispatch medyayı açmamalı")

    monkeypatch.setattr(
        CampaignMediaService, "get_media_file_info", staticmethod(_forbidden)
    )
    try:
        with patch(SEND_TARGET, new_callable=AsyncMock) as send:
            await CampaignRunner.process_due_sequence_followups()
            calls = [
                call for call in send.await_args_list
                if call.kwargs.get("phone") == seeded["phone"]
            ]
        assert calls == []
        assert opened["called"] is False

        async with AsyncSessionLocal() as db:
            seq_lead = await db.get(CampaignSequenceLead, seeded["seq_lead_id"])
            assert seq_lead.status == SequenceLeadStatus.FAILED
            assert seq_lead.stop_reason == "MEDIA_UNAUTHORIZED"
            assert seq_lead.next_step_at is None
            assert seq_lead.stopped_at is not None
            logs = (
                await db.execute(
                    select(MessageLog).where(
                        MessageLog.campaign_id == seeded["campaign_id"]
                    )
                )
            ).scalars().all()
            assert logs == []
    finally:
        await _cleanup_db(
            campaign_ids=(seeded["campaign_id"],),
            lead_ids=(seeded["lead_id"],),
            session_ids=(seeded["session_id"],),
        )
        _cleanup_file(media["file_id"])


@pytest.mark.asyncio
async def test_legacy_sequence_reference_authorizes_only_owner():
    file_id = "camp_0000000000000201"
    _write_legacy_file(file_id)
    cid = await _seed_campaign_only(
        USER_A, sequence_steps=[_step(1), _step(2, _media_url(file_id))]
    )
    try:
        async with AsyncSessionLocal() as db:
            assert (
                await CampaignMediaService.authorize_media_reference(
                    db, file_id, USER_A
                )
                is True
            )
            assert (
                await CampaignMediaService.authorize_media_reference(
                    db, file_id, USER_B
                )
                is False
            )
    finally:
        await _cleanup_db(campaign_ids=(cid,))
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_owner_sidecar_overrides_conflicting_db_reference():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    cid_b = await _seed_campaign_only(USER_B, media_url=media["media_url"])
    try:
        async with AsyncSessionLocal() as db:
            # Yan dosya tek kanıttır: A erişir, DB'ye yazılmış B referansı
            # sahipliği değiştiremez.
            assert (
                await CampaignMediaService.authorize_media_reference(
                    db, file_id, USER_A
                )
                is True
            )
            assert (
                await CampaignMediaService.authorize_media_reference(
                    db, file_id, USER_B
                )
                is False
            )
    finally:
        await _cleanup_db(campaign_ids=(cid_b,))
        _cleanup_file(file_id)


@pytest.mark.asyncio
async def test_corrupt_sidecar_does_not_fall_back_to_legacy():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        media = await _upload(client, USER_A)
    file_id = media["file_id"]
    (UPLOAD_DIR / f"{file_id}.owner.json").write_text("[]", encoding="utf-8")
    cid = await _seed_campaign_only(USER_A, media_url=media["media_url"])
    try:
        async with AsyncSessionLocal() as db:
            assert (
                await CampaignMediaService.authorize_media_reference(
                    db, file_id, USER_A
                )
                is False
            )
    finally:
        await _cleanup_db(campaign_ids=(cid,))
        _cleanup_file(file_id)
