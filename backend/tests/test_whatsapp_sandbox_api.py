"""Tests for WhatsApp Sandbox API Endpoints (Phase 8.0.1).

Verifies /api/v1/whatsapp/sandbox/status, /ping, and /results HTTP contracts,
authentication, fail-closed isolation, production session protection, and tenant scoping.
"""

import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch

from backend.app.core.auth import AuthUser, get_current_user
from backend.app.core.database import get_db
from backend.app.main import app
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.sandbox import sandbox_service


@pytest.fixture
def mock_user():
    return AuthUser(id="00000000-0000-0000-0000-000000000001", email="test@tezlify.com", role="USER")


@pytest.fixture
def mock_db():
    db = AsyncMock()
    return db


@pytest.mark.asyncio
async def test_api_sandbox_status_endpoint(mock_user):
    """GET /api/v1/whatsapp/sandbox/status kimlik doğrulaması altında doğru PII-safe durumu döner."""
    app.dependency_overrides[get_current_user] = lambda: mock_user

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.get("/api/v1/whatsapp/sandbox/status")

        assert res.status_code == 200
        data = res.json()
        assert "enabled" in data
        assert "session_id" in data
        assert "allowed_targets_count" in data
        assert "allowed_targets_masked" in data
        assert "protected_sessions" in data
        assert 201 in data["protected_sessions"]
        assert "can_execute_live" in data
        assert "status_reason" in data
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_api_sandbox_ping_fails_when_disabled(mock_user, mock_db, monkeypatch):
    """Sandbox kapalıyken POST /api/v1/whatsapp/sandbox/ping 403 döner (fail-closed)."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", False)
    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[get_db] = lambda: mock_db

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.post("/api/v1/whatsapp/sandbox/ping", json={"target": "+905551234567"})

        assert res.status_code == 403
        assert "BLOCKED: SANDBOX DISABLED" in res.json()["detail"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_api_sandbox_ping_blocks_production_session_201(mock_user, mock_db, monkeypatch):
    """Üretim oturumu 201 ile ping çağrısı 403 ile engellenir."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 201)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[get_db] = lambda: mock_db

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.post("/api/v1/whatsapp/sandbox/ping", json={"target": "+905551234567"})

        assert res.status_code == 403
        assert "PRODUCTION SESSION" in res.json()["detail"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_api_sandbox_ping_fails_when_number_not_configured(mock_user, mock_db, monkeypatch):
    """Allowlist boş olduğunda 'BLOCKED: SANDBOX NUMBER NOT CONFIGURED' hatası döner."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS", [])

    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[get_db] = lambda: mock_db

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.post("/api/v1/whatsapp/sandbox/ping", json={"target": "+905551234567"})

        assert res.status_code == 403
        assert "BLOCKED: SANDBOX NUMBER NOT CONFIGURED" in res.json()["detail"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_api_sandbox_results_endpoint(mock_user):
    """GET /api/v1/whatsapp/sandbox/results son test sonuçlarını döner."""
    app.dependency_overrides[get_current_user] = lambda: mock_user

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.get("/api/v1/whatsapp/sandbox/results")

        assert res.status_code == 200
        assert isinstance(res.json(), list)
    finally:
        app.dependency_overrides.clear()
