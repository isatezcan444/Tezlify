import pytest
import base64
import json
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead
from backend.app.models.profile import Profile
from backend.app.core.auth import decode_jwt_unverified, verify_lead_quota, AuthUser
from fastapi import HTTPException


def _make_mock_jwt(user_id: str, email: str) -> str:
    """Constructs an unverified mock JWT for testing."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id,
        "email": email,
        "user_metadata": {"full_name": f"User {user_id[:6]}"}
    }).encode()).decode().rstrip("=")
    signature = "mock_sig"
    return f"{header}.{payload}.{signature}"


def test_decode_jwt_unverified():
    token = _make_mock_jwt("11111111-1111-1111-1111-111111111111", "test@tezlify.com")
    payload = decode_jwt_unverified(token)
    assert payload["sub"] == "11111111-1111-1111-1111-111111111111"
    assert payload["email"] == "test@tezlify.com"


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
async def test_auth_me_endpoint():
    import uuid
    uid = str(uuid.uuid4())
    transport = ASGITransport(app=app)
    token = _make_mock_jwt(uid, f"me_{uid[:6]}@tezlify.com")
    headers = {"Authorization": f"Bearer {token}"}
    
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/auth/me", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data["id"] == uid
        assert data["plan_tier"] == "DEVELOPER_PRO"
        assert data["leads_monthly_limit"] == 999999


@pytest.mark.asyncio
async def test_multitenancy_lead_isolation():
    import uuid
    import random
    unique_suffix = uuid.uuid4().hex[:6]
    user_a = f"33333333-3333-3333-3333-{unique_suffix}000001"
    user_b = f"44444444-4444-4444-4444-{unique_suffix}000002"
    unique_phone = f"+90555{random.randint(1000000, 9999999)}"
    
    token_a = _make_mock_jwt(user_a, f"user_a_{unique_suffix}@tezlify.com")
    token_b = _make_mock_jwt(user_b, f"user_b_{unique_suffix}@tezlify.com")
    
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
