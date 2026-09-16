from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser
from backend.app.auth.api.routes import router as native_auth_router
from backend.app.auth.api.dependencies import get_current_user_unified_with_profile

router = APIRouter()

# Include native Google OAuth & Session routes
router.include_router(native_auth_router)


@router.get("/me", response_model=AuthUser)
async def get_my_profile(
    current_user: AuthUser = Depends(get_current_user_unified_with_profile),
) -> AuthUser:
    """Returns the authenticated user profile, active subscription plan, and usage quotas."""
    return current_user
