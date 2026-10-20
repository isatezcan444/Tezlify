import logging
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser
from backend.app.auth.api.dependencies import get_current_user_unified
from backend.app.services.quota_guard import QuotaGuardService
from backend.app.schemas.billing import (
    QuotaUsageSummary,
    PlanListResponse,
    ChangePlanRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/usage", response_model=QuotaUsageSummary)
async def get_usage_summary(
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
) -> QuotaUsageSummary:
    """Giriş yapmış kullanıcının anlık kota kullanımını, kalan haklarını ve periyot bilgilerini döner."""
    return await QuotaGuardService.get_usage_summary(db, current_user.id)


@router.get("/plans", response_model=PlanListResponse)
async def get_available_plans(
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
) -> PlanListResponse:
    """Sistemdeki tüm SaaS paketlerini ve özellik karşılaştırma matrisini döner."""
    sub = await QuotaGuardService.get_or_create_subscription(db, current_user.id)
    return await QuotaGuardService.get_all_plans(sub.plan_tier)


@router.post("/change-plan", response_model=QuotaUsageSummary)
async def change_plan(
    req: ChangePlanRequest,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
) -> QuotaUsageSummary:
    """Kullanıcının SaaS paketini günceller/yükseltir."""
    await QuotaGuardService.change_user_plan(db, current_user.id, req.plan_tier)
    return await QuotaGuardService.get_usage_summary(db, current_user.id)
