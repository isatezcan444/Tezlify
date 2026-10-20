import pytest
import uuid
from httpx import AsyncClient, ASGITransport
from fastapi import HTTPException

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.services.quota_guard import QuotaGuardService
from backend.app.schemas.billing import PlanTier


@pytest.fixture
def auth_headers():
    uid = str(uuid.uuid4())
    return {
        "X-Test-User-Id": uid,
        "X-Test-User-Email": f"billing_{uid[:8]}@tezlify.com",
    }


@pytest.mark.asyncio
async def test_quota_guard_lifecycle_and_defaults(auth_headers):
    user_id = auth_headers["X-Test-User-Id"]

    async with AsyncSessionLocal() as db:
        # 1. First retrieval creates STARTER subscription
        sub = await QuotaGuardService.get_or_create_subscription(db, user_id)
        assert sub is not None
        assert sub.plan_tier == PlanTier.STARTER.value
        assert sub.leads_scraped_current_period == 0
        assert sub.whatsapp_sent_today == 0

        # 2. Get usage summary
        summary = await QuotaGuardService.get_usage_summary(db, user_id)
        assert summary.plan_tier == PlanTier.STARTER.value
        assert summary.leads.limit == 1000
        assert summary.leads.remaining == 1000
        assert summary.leads.percentage == 0.0
        assert summary.whatsapp_daily.limit == 100
        assert summary.features["webhooks"] is True
        assert summary.features["api_access"] is True


@pytest.mark.asyncio
async def test_quota_guard_scrape_allowance_and_enforcement(auth_headers):
    user_id = auth_headers["X-Test-User-Id"]

    async with AsyncSessionLocal() as db:
        await QuotaGuardService.get_or_create_subscription(db, user_id)

        # Scrape 900 leads
        await QuotaGuardService.consume_scrape_quota(db, user_id, count=900)

        # Allowed for 50 leads (900 + 50 <= 1000)
        allowed, remaining, limit = await QuotaGuardService.check_scrape_allowance(db, user_id, count=50)
        assert allowed is True
        assert remaining == 100

        # Disallowed for 150 leads (900 + 150 > 1000) -> 402 Payment Required
        with pytest.raises(HTTPException) as exc_info:
            await QuotaGuardService.check_scrape_allowance(db, user_id, count=150)
        assert exc_info.value.status_code == 402
        assert "kotanız doldu" in exc_info.value.detail


@pytest.mark.asyncio
async def test_quota_guard_whatsapp_daily_allowance(auth_headers):
    user_id = auth_headers["X-Test-User-Id"]

    async with AsyncSessionLocal() as db:
        await QuotaGuardService.get_or_create_subscription(db, user_id)

        # Consume 99 WhatsApp messages
        for _ in range(99):
            await QuotaGuardService.consume_whatsapp_quota(db, user_id, count=1)

        # 100th message allowed
        allowed, remaining, limit = await QuotaGuardService.check_and_consume_whatsapp_quota(db, user_id, count=1)
        assert allowed is True
        assert remaining == 0

        # 101st message rejected -> 429 Too Many Requests
        with pytest.raises(HTTPException) as exc_info:
            await QuotaGuardService.check_and_consume_whatsapp_quota(db, user_id, count=1)
        assert exc_info.value.status_code == 429
        assert "limitinize ulaştınız" in exc_info.value.detail


@pytest.mark.asyncio
async def test_quota_guard_feature_access(auth_headers):
    user_id = auth_headers["X-Test-User-Id"]

    async with AsyncSessionLocal() as db:
        # Set plan to FREE
        await QuotaGuardService.change_user_plan(db, user_id, PlanTier.FREE.value)

        # FREE does not have webhooks or api_access
        with pytest.raises(HTTPException) as exc_info:
            await QuotaGuardService.check_feature_access(db, user_id, "webhooks")
        assert exc_info.value.status_code == 403

        # Upgrade to PRO
        await QuotaGuardService.change_user_plan(db, user_id, PlanTier.PRO.value)
        allowed = await QuotaGuardService.check_feature_access(db, user_id, "webhooks")
        assert allowed is True


@pytest.mark.asyncio
async def test_billing_api_endpoints(auth_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. GET /api/v1/billing/usage
        res = await ac.get("/api/v1/billing/usage", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "plan_tier" in data
        assert "leads" in data
        assert "whatsapp_daily" in data
        assert "features" in data

        # 2. GET /api/v1/billing/plans
        res = await ac.get("/api/v1/billing/plans", headers=auth_headers)
        assert res.status_code == 200
        plans_data = res.json()
        assert len(plans_data["plans"]) >= 3
        tiers = [p["id"] for p in plans_data["plans"]]
        assert "FREE" in tiers
        assert "STARTER" in tiers
        assert "PRO" in tiers

        # 3. POST /api/v1/billing/change-plan
        res = await ac.post("/api/v1/billing/change-plan", json={"plan_tier": "PRO"}, headers=auth_headers)
        assert res.status_code == 200
        updated = res.json()
        assert updated["plan_tier"] == "PRO"
        assert updated["leads"]["limit"] == 5000

        # 4. Invalid plan should 400
        res = await ac.post("/api/v1/billing/change-plan", json={"plan_tier": "INVALID_PLAN"}, headers=auth_headers)
        assert res.status_code == 400
