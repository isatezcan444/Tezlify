import pytest
import uuid
import random
import secrets
from datetime import datetime, timedelta, timezone
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal, Base
from backend.app.models.lead import Lead
from backend.app.models.profile import Profile
from backend.app.core.auth import verify_lead_quota, AuthUser
from backend.app.auth.infrastructure.sql_models import AuthUserDB, AuthSessionDB, OAuthAccountDB
from backend.app.auth.application.user_service import UserService
from backend.app.auth.application.session_service import SessionService
from fastapi import HTTPException


def test_verify_lead_quota_unlimited_in_dev():
    user = AuthUser(
        id="test-user",
        email="quota@tezlify.com",
        plan_tier="DEVELOPER_PRO",
        leads_monthly_limit=999999,
        leads_used_this_month=50,
        messages_daily_limit=999999
    )
    # Never raises in dev mode (unlimited)
    verify_lead_quota(user, requested_count=100)


@pytest.mark.asyncio
async def test_auth_me_endpoint_with_header():
    uid = str(uuid.uuid4())
    transport = ASGITransport(app=app)
    headers = {"X-Test-User-Id": uid, "X-Test-User-Email": f"me_{uid[:6]}@tezlify.com"}
    
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/auth/me", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data["id"] == uid
        assert data["plan_tier"] == "PRO"
        assert data["leads_monthly_limit"] == 100000


@pytest.mark.asyncio
async def test_oracle_native_session_valid():
    """Verifies that an authentic Oracle Native session token authenticates /api/v1/auth/me."""
    u_svc = UserService()
    s_svc = SessionService()

    async with AsyncSessionLocal() as db:
        unique = uuid.uuid4().hex[:8]
        user = await u_svc.get_or_create_from_oauth(
            db,
            provider="google",
            provider_subject=f"sub-{unique}",
            email=f"native_{unique}@tezlify.com",
            display_name=f"Native User {unique}",
        )
        _, raw_token = await s_svc.create_session(db, user_id=user.id)
        await db.commit()

    transport = ASGITransport(app=app)
    headers = {"Authorization": f"Bearer {raw_token}"}

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/auth/me", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data["id"] == str(user.id)
        assert data["email"] == f"native_{unique}@tezlify.com"


@pytest.mark.asyncio
async def test_oracle_native_session_invalid_token():
    """Verifies that an unknown / forged token is rejected fail-closed with 401."""
    transport = ASGITransport(app=app)
    headers = {"Authorization": "Bearer forged-session-token-random-value-12345"}

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/auth/me", headers=headers)
        assert res.status_code == 401
        assert "Geçersiz veya süresi dolmuş oturum" in res.json()["detail"]


@pytest.mark.asyncio
async def test_oracle_native_session_expired():
    """Verifies that an expired Oracle Native session is rejected with 401."""
    u_svc = UserService()
    s_svc = SessionService()

    async with AsyncSessionLocal() as db:
        unique = uuid.uuid4().hex[:8]
        user = await u_svc.get_or_create_from_oauth(
            db,
            provider="google",
            provider_subject=f"sub-exp-{unique}",
            email=f"exp_{unique}@tezlify.com",
        )
        # Create expired session
        raw_token = secrets.token_urlsafe(32)
        token_hash = s_svc.hash_token(raw_token)
        now = datetime.now(timezone.utc)
        expired_db_sess = AuthSessionDB(
            user_id=user.id,
            session_token_hash=token_hash,
            expires_at=now - timedelta(hours=1),
            created_at=now - timedelta(days=1),
            last_seen_at=now - timedelta(days=1),
            revoked_at=None,
        )
        db.add(expired_db_sess)
        await db.commit()

    transport = ASGITransport(app=app)
    headers = {"Authorization": f"Bearer {raw_token}"}

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/auth/me", headers=headers)
        assert res.status_code == 401
        assert "Geçersiz veya süresi dolmuş oturum" in res.json()["detail"]


@pytest.mark.asyncio
async def test_oracle_native_session_revoked():
    """Verifies that a revoked Oracle Native session (post-logout) is rejected with 401."""
    u_svc = UserService()
    s_svc = SessionService()

    async with AsyncSessionLocal() as db:
        unique = uuid.uuid4().hex[:8]
        user = await u_svc.get_or_create_from_oauth(
            db,
            provider="google",
            provider_subject=f"sub-rev-{unique}",
            email=f"rev_{unique}@tezlify.com",
        )
        session, raw_token = await s_svc.create_session(db, user_id=user.id)
        await db.commit()
        # Revoke the session
        await s_svc.revoke_session(db, raw_token)
        await db.commit()

    transport = ASGITransport(app=app)
    headers = {"Authorization": f"Bearer {raw_token}"}

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/auth/me", headers=headers)
        assert res.status_code == 401
        assert "Geçersiz veya süresi dolmuş oturum" in res.json()["detail"]


@pytest.mark.asyncio
async def test_multitenancy_lead_isolation_native_sessions():
    """Verifies multi-tenant isolation using authentic Oracle Native Sessions."""
    u_svc = UserService()
    s_svc = SessionService()
    unique_suffix = uuid.uuid4().hex[:6]

    async with AsyncSessionLocal() as db:
        user_a = await u_svc.get_or_create_from_oauth(
            db,
            provider="google",
            provider_subject=f"tenant-a-{unique_suffix}",
            email=f"user_a_{unique_suffix}@tezlify.com",
            display_name=f"User A {unique_suffix}",
        )
        user_b = await u_svc.get_or_create_from_oauth(
            db,
            provider="google",
            provider_subject=f"tenant-b-{unique_suffix}",
            email=f"user_b_{unique_suffix}@tezlify.com",
            display_name=f"User B {unique_suffix}",
        )
        _, token_a = await s_svc.create_session(db, user_id=user_a.id)
        _, token_b = await s_svc.create_session(db, user_id=user_b.id)
        await db.commit()

    unique_phone = f"+90555{random.randint(1000000, 9999999)}"
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # User A creates a lead
        res_create = await ac.post(
            "/api/v1/leads",
            json={
                "name": f"Secret Corp {unique_suffix}",
                "phone": unique_phone,
                "category": "Gizli Proje",
            },
            headers={"Authorization": f"Bearer {token_a}"}
        )
        assert res_create.status_code == 201
        lead_a_id = res_create.json()["id"]

        # User A can get their lead
        res_get_a = await ac.get(f"/api/v1/leads/{lead_a_id}", headers={"Authorization": f"Bearer {token_a}"})
        assert res_get_a.status_code == 200
        assert res_get_a.json()["name"] == f"Secret Corp {unique_suffix}"

        # User B CANNOT get User A's lead (404 / isolated)
        res_get_b = await ac.get(f"/api/v1/leads/{lead_a_id}", headers={"Authorization": f"Bearer {token_b}"})
        assert res_get_b.status_code == 404


@pytest.mark.asyncio
async def test_multitenancy_campaign_groups_isolation():
    """Verifies campaign group isolation between tenants:
    1. Tenant B cannot access Tenant A's group.
    2. Tenant B cannot attach Tenant A's leads to their own group.
    3. Tenant B cannot bulk delete Tenant A's groups.
    """
    u_svc = UserService()
    s_svc = SessionService()
    unique_suffix = uuid.uuid4().hex[:6]

    async with AsyncSessionLocal() as db:
        user_a = await u_svc.get_or_create_from_oauth(
            db,
            provider="google",
            provider_subject=f"tenant-grp-a-{unique_suffix}",
            email=f"grp_a_{unique_suffix}@tezlify.com",
            display_name=f"User Grp A {unique_suffix}",
        )
        user_b = await u_svc.get_or_create_from_oauth(
            db,
            provider="google",
            provider_subject=f"tenant-grp-b-{unique_suffix}",
            email=f"grp_b_{unique_suffix}@tezlify.com",
            display_name=f"User Grp B {unique_suffix}",
        )
        _, token_a = await s_svc.create_session(db, user_id=user_a.id)
        _, token_b = await s_svc.create_session(db, user_id=user_b.id)
        await db.commit()

    unique_phone = f"+90555{random.randint(1000000, 9999999)}"
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # User A creates a lead
        res_lead = await ac.post(
            "/api/v1/leads",
            json={"name": f"Lead A {unique_suffix}", "phone": unique_phone, "category": "Klinik"},
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert res_lead.status_code == 201
        lead_a_id = res_lead.json()["id"]

        # User A creates a group containing their lead
        res_grp_a = await ac.post(
            "/api/v1/campaign-groups",
            json={"name": f"Group A {unique_suffix}", "lead_ids": [lead_a_id]},
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert res_grp_a.status_code == 201
        grp_a_id = res_grp_a.json()["id"]
        assert res_grp_a.json()["total_leads_count"] == 1

        # 1. User B tries to get User A's group -> 404
        res_get_grp = await ac.get(f"/api/v1/campaign-groups/{grp_a_id}", headers={"Authorization": f"Bearer {token_b}"})
        assert res_get_grp.status_code == 404

        # 2. User B tries to create a group poaching User A's lead_id -> lead is rejected by tenant check
        res_grp_b = await ac.post(
            "/api/v1/campaign-groups",
            json={"name": f"Group B {unique_suffix}", "lead_ids": [lead_a_id]},
            headers={"Authorization": f"Bearer {token_b}"},
        )
        assert res_grp_b.status_code == 201
        grp_b_id = res_grp_b.json()["id"]
        # Total leads count MUST be 0 since lead_a does not belong to User B!
        assert res_grp_b.json()["total_leads_count"] == 0

        # 3. User B tries to bulk delete User A's group -> deleted_count must be 0
        res_del = await ac.post(
            "/api/v1/campaign-groups/bulk-delete",
            json={"group_ids": [grp_a_id]},
            headers={"Authorization": f"Bearer {token_b}"},
        )
        assert res_del.status_code == 200
        assert res_del.json()["deleted_count"] == 0

        # Verify User A's group is still alive
        res_verify_a = await ac.get(f"/api/v1/campaign-groups/{grp_a_id}", headers={"Authorization": f"Bearer {token_a}"})
        assert res_verify_a.status_code == 200
        assert res_verify_a.json()["id"] == grp_a_id
