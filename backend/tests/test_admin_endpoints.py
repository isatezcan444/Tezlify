"""Functional endpoint and degraded dependency tests for the Admin API.

Invariants:
- All endpoints conform strictly to their respective Pydantic response schemas.
- If an underlying dependency (e.g. database, gateway, proc files) fails or is degraded,
  the endpoints gracefully return degraded status (e.g. 'unreachable', 'unknown') rather than crashing with 500.
"""

import pytest
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.schemas.admin import (
    AdminOverviewResponse,
    AdminWhatsAppResponse,
    AdminMonitoringResponse,
    AdminBackupsResponse,
    AdminDeploymentResponse,
    AdminSecurityResponse,
)


@pytest.fixture
def admin_headers():
    return {
        "X-Test-User-Id": "admin-test-id",
        "X-Test-User-Email": "admin@tezlify.com",
    }


@pytest.fixture(autouse=True)
def setup_admin_emails(monkeypatch):
    monkeypatch.setattr(settings, "ADMIN_EMAILS", ["admin@tezlify.com"])


@pytest.mark.asyncio
async def test_admin_overview_endpoint(admin_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/admin/overview", headers=admin_headers)
        assert res.status_code == 200, res.text
        data = res.json()
        validated = AdminOverviewResponse.model_validate(data)
        assert validated.overall_status in ("OK", "WARN", "CRITICAL")
        assert len(validated.containers) == 4
        assert validated.system.cpu_cores >= 1


@pytest.mark.asyncio
async def test_admin_whatsapp_endpoint(admin_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/admin/whatsapp", headers=admin_headers)
        assert res.status_code == 200, res.text
        data = res.json()
        validated = AdminWhatsAppResponse.model_validate(data)
        assert validated.gateway_bridge is not None
        assert validated.socket_leases.active_count >= 0
        assert validated.outbox.total >= 0


@pytest.mark.asyncio
async def test_admin_monitoring_endpoint(admin_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/admin/monitoring", headers=admin_headers)
        assert res.status_code == 200, res.text
        data = res.json()
        validated = AdminMonitoringResponse.model_validate(data)
        assert validated.system_monitor.interval == "every 3m"
        assert validated.whatsapp_observer.interval == "every 5m"
        assert len(validated.invariants) == 13


@pytest.mark.asyncio
async def test_admin_backups_endpoint(admin_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/admin/backups", headers=admin_headers)
        assert res.status_code == 200, res.text
        data = res.json()
        validated = AdminBackupsResponse.model_validate(data)
        assert validated.certification_status == "BACKUP_RESTORE_VERIFIED"
        assert validated.off_host_status == "OFF_HOST_BACKUP_NOT_CONFIGURED"


@pytest.mark.asyncio
async def test_admin_deployment_endpoint(admin_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/admin/deployment", headers=admin_headers)
        assert res.status_code == 200, res.text
        data = res.json()
        validated = AdminDeploymentResponse.model_validate(data)
        assert validated.deployment_directory != ""
        assert validated.kernel != ""


@pytest.mark.asyncio
async def test_admin_security_endpoint(admin_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/admin/security", headers=admin_headers)
        assert res.status_code == 200, res.text
        data = res.json()
        validated = AdminSecurityResponse.model_validate(data)
        assert validated.ssh.status in ("HARDENED", "UNKNOWN")
        assert validated.firewall.status in ("ACTIVE", "UNKNOWN")
        assert validated.container.status in ("SECURE", "WARNING")
        assert validated.caddy.security_headers_state == "CONFIGURED"
        assert validated.fail2ban.status == "NOT_CONFIGURED"


@pytest.mark.asyncio
async def test_admin_overview_degraded_database(monkeypatch, admin_headers):
    """Verifies that if the database is unreachable, the overview endpoint returns status CRITICAL instead of 500."""
    from backend.app.services.admin import overview_service

    async def mock_failed_db(db):
        from backend.app.schemas.admin import AdminDatabaseInfo
        return AdminDatabaseInfo(health="unreachable", connections_total=0, connections_active=0, connections_idle=0, database_size_mb=0.0)

    monkeypatch.setattr(overview_service, "get_database_metrics", mock_failed_db)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/admin/overview", headers=admin_headers)
        assert res.status_code == 200
        data = res.json()
        assert data["overall_status"] == "CRITICAL"
        assert any("database" in r.lower() for r in data["overall_status_reasons"])
