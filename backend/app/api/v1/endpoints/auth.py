from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser, get_current_user

router = APIRouter()


@router.get("/me", response_model=AuthUser)
async def get_my_profile(
    current_user: AuthUser = Depends(get_current_user),
) -> AuthUser:
    """Returns the authenticated user profile, active subscription plan, and usage quotas."""
    return current_user
