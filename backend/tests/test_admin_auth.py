"""Tests for Admin Authorization and Role Guards.

Invariants:
- Anonymous -> 401 Unauthorized
- Authenticated non-admin -> 403 Forbidden
- Empty or missing ADMIN_EMAILS -> 403 Forbidden (fail-closed)
- Configured admin -> 200 OK
- Case-insensitivity and trim normalization
"""

import pytest
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.config import settings


ADMIN_ENDPOINTS = [
    "/api/v1/admin/overview",
    "/api/v1/admin/whatsapp",
    "/api/v1/admin/monitoring",
    "/api/v1/admin/backups",
    "/api/v1/admin/deployment",
    "/api/v1/admin/security",
]


@pytest.mark.asyncio
async def test_admin_anonymous_rejected_401():
    """Verifies that an unauthenticated (anonymous) request receives 401 across all admin endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        for ep in ADMIN_ENDPOINTS:
            res = await ac.get(ep)
            assert res.status_code == 401, f"Expected 401 for anonymous on {ep}, got {res.status_code}"


@pytest.mark.asyncio
async def test_admin_non_admin_authenticated_rejected_403(monkeypatch):
    """Verifies that an authenticated regular user receives 403 Forbidden across all admin endpoints."""
    monkeypatch.setattr(settings, "ADMIN_EMAILS", ["admin@tezlify.com"])

    transport = ASGITransport(app=app)
    headers = {
        "X-Test-User-Id": "regular-user-id",
        "X-Test-User-Email": "regular@user.com",
    }
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        for ep in ADMIN_ENDPOINTS:
            res = await ac.get(ep, headers=headers)
            assert res.status_code == 403, f"Expected 403 for non-admin on {ep}, got {res.status_code}"
            assert "yönetici yetkisi" in res.json().get("detail", "").lower()


@pytest.mark.asyncio
async def test_admin_empty_config_fail_closed_403(monkeypatch):
    """Verifies fail-closed behavior: when ADMIN_EMAILS is empty, even authenticated users get 403."""
    monkeypatch.setattr(settings, "ADMIN_EMAILS", [])

    transport = ASGITransport(app=app)
    headers = {
        "X-Test-User-Id": "any-user-id",
        "X-Test-User-Email": "admin@tezlify.com",
    }
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        for ep in ADMIN_ENDPOINTS:
            res = await ac.get(ep, headers=headers)
            assert res.status_code == 403, f"Expected 403 when ADMIN_EMAILS is empty on {ep}, got {res.status_code}"


@pytest.mark.asyncio
async def test_admin_authorized_access_200(monkeypatch):
    """Verifies that a configured admin user receives 200 OK across all admin endpoints."""
    monkeypatch.setattr(settings, "ADMIN_EMAILS", ["admin@tezlify.com", "isatezcan444@gmail.com"])

    transport = ASGITransport(app=app)
    # Test case-insensitivity and leading/trailing whitespace normalization
    headers = {
        "X-Test-User-Id": "admin-user-id",
        "X-Test-User-Email": "  ADMIN@tezlify.com  ",
    }
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        for ep in ADMIN_ENDPOINTS:
            res = await ac.get(ep, headers=headers)
            assert res.status_code == 200, f"Expected 200 for admin on {ep}, got {res.status_code}: {res.text}"


@pytest.mark.asyncio
async def test_auth_me_reflects_is_admin_flag(monkeypatch):
    """Verifies that /auth/me returns is_admin: True for configured admin and False for non-admin."""
    monkeypatch.setattr(settings, "ADMIN_EMAILS", ["admin@tezlify.com"])

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Non-admin
        res_user = await ac.get(
            "/api/v1/auth/me",
            headers={"X-Test-User-Id": "u1", "X-Test-User-Email": "user@tezlify.com"},
        )
        assert res_user.status_code == 200
        assert res_user.json().get("is_admin") is False

        # Admin
        res_admin = await ac.get(
            "/api/v1/auth/me",
            headers={"X-Test-User-Id": "a1", "X-Test-User-Email": "admin@tezlify.com"},
        )
        assert res_admin.status_code == 200
        assert res_admin.json().get("is_admin") is True
