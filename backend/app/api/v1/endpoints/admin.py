"""Read-only Admin / Operations Center Endpoints.

All routes are protected by `require_admin` dependency and strictly read-only.
Zero mutation operations exist on this router.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import AuthUser
from backend.app.core.database import get_db
from backend.app.auth.api.dependencies import require_admin
from backend.app.schemas.admin import (
    AdminOverviewResponse,
    AdminWhatsAppResponse,
    AdminMonitoringResponse,
    AdminBackupsResponse,
    AdminDeploymentResponse,
    AdminSecurityResponse,
)
from backend.app.services.admin.overview_service import get_overview_metrics
from backend.app.services.admin.whatsapp_admin_service import get_whatsapp_operations_metrics
from backend.app.services.admin.monitoring_admin_service import get_monitoring_metrics
from backend.app.services.admin.backups_admin_service import get_backups_metadata
from backend.app.services.admin.deployment_admin_service import get_deployment_metadata
from backend.app.services.admin.security_admin_service import get_security_audit

router = APIRouter()


@router.get("/overview", response_model=AdminOverviewResponse)
async def get_overview(
    current_admin: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminOverviewResponse:
    """Read-only overview of host resources, core container states, and database metrics."""
    return await get_overview_metrics(db)


@router.get("/whatsapp", response_model=AdminWhatsAppResponse)
async def get_whatsapp(
    current_admin: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminWhatsAppResponse:
    """Read-only aggregation of gateway bridge, runtime sessions, socket leases, outbox, and retry store."""
    return await get_whatsapp_operations_metrics(db)


@router.get("/monitoring", response_model=AdminMonitoringResponse)
async def get_monitoring(
    current_admin: AuthUser = Depends(require_admin),
) -> AdminMonitoringResponse:
    """Read-only monitoring status: system timer, WhatsApp observer timer, R1-R13 invariant checks, and recent records."""
    return get_monitoring_metrics()


@router.get("/backups", response_model=AdminBackupsResponse)
async def get_backups(
    current_admin: AuthUser = Depends(require_admin),
) -> AdminBackupsResponse:
    """Read-only backups inspection: postgres, media, and config file metadata with total disk consumption."""
    return get_backups_metadata()


@router.get("/deployment", response_model=AdminDeploymentResponse)
async def get_deployment(
    current_admin: AuthUser = Depends(require_admin),
) -> AdminDeploymentResponse:
    """Read-only local host deployment and git environment metadata."""
    return get_deployment_metadata()


@router.get("/security", response_model=AdminSecurityResponse)
async def get_security(
    current_admin: AuthUser = Depends(require_admin),
) -> AdminSecurityResponse:
    """Read-only security posture audit: SSH configuration, firewall ports, container isolation, and Caddy headers."""
    return get_security_audit()
