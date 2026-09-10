import pytest
from httpx import AsyncClient
from sqlalchemy import text
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal


@pytest.mark.asyncio
async def test_application_boot_and_database_ping(client: AsyncClient):
    """Proves FastAPI application boots and SQLAlchemy async engine connects."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(text("SELECT 1"))
        assert result.scalar() == 1


@pytest.mark.asyncio
async def test_openapi_schema_generation(client: AsyncClient):
    """Proves OpenAPI schema generates with valid paths and no schema corruption."""
    res = await client.get("/openapi.json")
    assert res.status_code == 200
    data = res.json()
    assert "openapi" in data
    assert "paths" in data
    assert "/api/v1/leads" in data["paths"]
    assert "/api/v1/campaigns" in data["paths"]
    assert "/api/v1/campaign-groups" in data["paths"]
    assert "/api/v1/blacklist" in data["paths"]


@pytest.mark.asyncio
async def test_core_settings_invariants():
    """Proves critical application configurations adhere to security & system invariants."""
    assert settings.PROJECT_NAME == "Tezlify"
    assert settings.API_V1_STR == "/api/v1"
    assert settings.DATABASE_URL is not None
    assert settings.SCRAPER_MAX_CONCURRENT_TASKS >= 1


@pytest.mark.asyncio
async def test_critical_endpoint_smoke_matrix(client: AsyncClient):
    """Proves all critical API endpoints are alive, respond within contract, and do not raise 500s."""
    # WhatsApp backend endpoints (/conversations, /whatsapp/*) were removed
    # together with the WhatsApp backend; the smoke matrix covers the remaining
    # generic API surface.
    endpoints = [
        ("/api/v1/leads", 200),
        ("/api/v1/campaigns", 200),
        ("/api/v1/campaign-groups", 200),
        ("/api/v1/blacklist", 200),
        ("/api/v1/analytics/dashboard", 200),
        ("/api/v1/settings/antiban", 200),
        ("/api/v1/leads/categories", 200),
    ]
    for path, expected_status in endpoints:
        res = await client.get(path)
        assert res.status_code == expected_status, f"Endpoint {path} failed smoke test with status {res.status_code}: {res.text}"
