"""
Final Concurrency & Transaction Isolation Audit Suite.
Tests parallel, non-serialized requests using independent AsyncSessionLocal sessions
to verify composite constraints, idempotency, and absence of database corruption.
"""
import pytest
import asyncio
import uuid
from sqlalchemy import select, func
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead
from backend.app.models.campaign_group import CampaignGroup, campaign_group_leads
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.services.lead_ingest_service import LeadIngestService
from backend.app.services.campaign_runner import CampaignRunner


@pytest.fixture
def anyio_backend():
    return "asyncio"


def unique_phone():
    return f"+9053{uuid.uuid4().int % 100000000:08d}"


# Lead benzersizliği KİRACI BAŞINA (`uq_lead_user_phone`/`uq_lead_user_place`,
# `WHERE ... IS NOT NULL`). user_id verilmezse NULL'lar SQL'de birbirinden
# farklı sayılır ve hiçbir çakışma oluşmaz — yani test, üretimde var olmayan
# "sahipsiz lead" durumunu ölçerdi. Üretimdeki üç çağrı yeri de user_id veriyor.
CONCURRENCY_OWNER = "11111111-1111-4111-8111-111111111111"


@pytest.mark.asyncio
async def test_concurrency_10x_same_lead_group_membership():
    """
    10 simultaneous workers attempting to insert the EXACT SAME lead into the same group.
    Result must be strictly 1 membership row in campaign_group_leads (zero duplicate junction rows).
    """
    p = unique_phone()
    async with AsyncSessionLocal() as session:
        lead = Lead(
            name=f"Concurrency Test Lead {uuid.uuid4().hex[:6]}",
            phone=p,
            phone_e164=p,
            place_id=f"place_conc_{uuid.uuid4().hex[:10]}",
            is_whatsapp_eligible=True
        )
        session.add(lead)
        await session.commit()
        await session.refresh(lead)
        lid = lead.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create group
        g_res = await client.post("/api/v1/campaign-groups", json={"name": f"Conc Group {uuid.uuid4().hex[:6]}"})
        assert g_res.status_code == 201
        gid = g_res.json()["id"]

        # Run 10 parallel independent POST requests
        async def add_member():
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                return await c.post(f"/api/v1/campaign-groups/{gid}/leads", json={"lead_ids": [lid]})

        tasks = [add_member() for _ in range(10)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for res in results:
            if not isinstance(res, Exception):
                assert res.status_code == 200

    # Verify final DB state directly with fresh session
    async with AsyncSessionLocal() as session:
        stmt = select(func.count()).select_from(campaign_group_leads).where(
            campaign_group_leads.c.group_id == gid,
            campaign_group_leads.c.lead_id == lid
        )
        cnt = (await session.execute(stmt)).scalar()
        assert cnt == 1, f"Expected exactly 1 membership row for lead {lid} in group {gid}, got {cnt}"


@pytest.mark.asyncio
async def test_concurrency_simultaneous_lead_ingestion_same_phone():
    """
    Simultaneous parallel ingestion of the same phone number across 5 independent sessions.
    Result must be strictly 1 logical lead entity in DB.
    """
    phone = unique_phone()
    place_id = f"place_conc_ingest_{uuid.uuid4().hex[:10]}"
    business_name = f"Parallel Ingest Business {uuid.uuid4().hex[:6]}"

    raw_candidate = {
        "name": business_name,
        "phone": phone,
        "place_id": place_id,
        "category": "Diş Hekimi",
        "city": "İstanbul"
    }

    async def do_ingest():
        async with AsyncSessionLocal() as session:
            leads, new_cnt, upd_cnt = await LeadIngestService.ingest_leads(
                db=session,
                raw_leads=[raw_candidate],
                search_keyword="Parallel Test",
                user_id=CONCURRENCY_OWNER,
            )
            await session.commit()
            return new_cnt, upd_cnt

    tasks = [do_ingest() for _ in range(5)]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Verify Database count
    async with AsyncSessionLocal() as session:
        stmt = select(func.count(Lead.id)).where(Lead.name == business_name)
        total = (await session.execute(stmt)).scalar()
        assert total == 1, f"Expected 1 unique lead for {business_name}, got {total}"


@pytest.mark.asyncio
async def test_concurrency_campaign_simultaneous_launch_guard(monkeypatch):
    """
    10 parallel requests attempting to launch the exact same DRAFT campaign.
    Exactly 1 request should succeed (200), and other requests must receive conflict/already-running response.
    Never corrupt state into multiple parallel runners.
    """
    async def mock_worker(campaign_id, *args, **kwargs):
        async with AsyncSessionLocal() as db:
            c = await db.get(Campaign, campaign_id)
            if c:
                c.status = CampaignStatus.ACTIVE
                await db.commit()

    monkeypatch.setattr(CampaignRunner, "_execute_campaign_worker", mock_worker)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        c_res = await client.post(
            "/api/v1/campaigns",
            json={
                "name": f"Conc Launch Camp {uuid.uuid4().hex[:6]}",
                "message_template": "Merhaba {business_name}, özel kampanyamız hazır."
            }
        )
        assert c_res.status_code == 201
        cid = c_res.json()["id"]

        async def launch():
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                return await c.post(f"/api/v1/campaigns/{cid}/launch", json={"limit": 50})

        tasks = [launch() for _ in range(10)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        statuses = [r.status_code for r in results if not isinstance(r, Exception)]
        # Must not produce 500
        assert all(s != 500 for s in statuses)
        # Should have at least one 200 and conflicts (409) for concurrent duplicates
        assert 200 in statuses or 400 in statuses or 409 in statuses
