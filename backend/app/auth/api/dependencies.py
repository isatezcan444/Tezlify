import logging
from typing import Optional
from uuid import UUID
from fastapi import Request, HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser, _is_dev_or_test_context
from backend.app.models.profile import Profile
from backend.app.auth.application.session_service import SessionService
from backend.app.auth.application.user_service import UserService

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)
session_service = SessionService()
user_service = UserService()


def extract_session_token(request: Request, credentials: Optional[HTTPAuthorizationCredentials] = None) -> Optional[str]:
    # 1. Bearer header
    if credentials and credentials.credentials:
        return credentials.credentials

    # 2. Authorization header raw fallback
    auth_hdr = request.headers.get("Authorization") or request.headers.get("authorization")
    if auth_hdr and auth_hdr.startswith("Bearer "):
        return auth_hdr[7:].strip()

    # 3. HttpOnly Cookie
    cookie_token = request.cookies.get("tezlify_session")
    if cookie_token:
        return cookie_token

    # 4. Query param (?token=)
    query_token = request.query_params.get("token")
    if query_token:
        return query_token

    return None


async def get_current_user_unified(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> AuthUser:
    """FastAPI dependency resolving the current authenticated user from the Oracle Native Session."""
    token = extract_session_token(request, credentials)

    if not token:
        if _is_dev_or_test_context():
            test_uid = request.headers.get("x-test-user-id") or request.headers.get("X-Test-User-Id")
            if test_uid:
                test_email = request.headers.get("x-test-user-email") or request.headers.get("X-Test-User-Email") or "dev@tezlify.com"
                return AuthUser(
                    id=test_uid,
                    email=test_email,
                    full_name="Tezlify Test User",
                    plan_tier="PRO",
                    leads_monthly_limit=100000,
                    leads_used_this_month=0,
                    messages_daily_limit=1000,
                )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Oturum açmanız gerekiyor (Authentication required)",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 1. Try Oracle Native Session lookup
    try:
        session = await session_service.get_session_by_token(db, token)
        if session:
            user = await user_service.get_user_by_id(db, session.user_id)
            if user:
                if not user.is_active:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Kullanıcı hesabı askıya alınmış (Account deactivated)",
                    )
                # Fast path: Profile is not loaded on non-profile endpoints (saved 1 DB roundtrip)
                return AuthUser(
                    id=str(user.id),
                    email=user.email,
                    full_name=user.display_name or "",
                    avatar_url=user.avatar_url or "",
                    plan_tier="DEVELOPER_PRO",
                    leads_monthly_limit=999999,
                    leads_used_this_month=0,
                    messages_daily_limit=999999,
                )
    except HTTPException:
        raise
    # Session not found or invalid
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Geçersiz veya süresi dolmuş oturum (Invalid or expired session)",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user_unified_with_profile(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> AuthUser:
    """FastAPI dependency resolving current user AND associated profile for profile-dependent endpoints (/me)."""
    current_user = await get_current_user_unified(request, credentials, db)
    try:
        stmt = select(Profile).where(Profile.id == current_user.id)
        res = await db.execute(stmt)
        profile = res.scalar_one_or_none()
        if profile:
            return AuthUser(
                id=current_user.id,
                email=current_user.email,
                full_name=profile.full_name or current_user.full_name,
                avatar_url=profile.avatar_url or current_user.avatar_url,
                plan_tier=profile.plan_tier or "DEVELOPER_PRO",
                leads_monthly_limit=profile.leads_monthly_limit or 999999,
                leads_used_this_month=profile.leads_used_this_month or 0,
                messages_daily_limit=profile.messages_daily_limit or 999999,
            )
    except Exception as pe:
        logger.debug(f"Profile lookup skipped: {pe}")
    return current_user


async def require_admin(
    current_user: AuthUser = Depends(get_current_user_unified),
) -> AuthUser:
    """FastAPI dependency enforcing that the authenticated user is a configured administrator.

    Fail-closed behavior:
    - Anonymous (no token or invalid session) -> 401 Unauthorized (via get_current_user_unified)
    - Authenticated non-admin -> 403 Forbidden
    - Empty or missing ADMIN_EMAILS configuration -> 403 Forbidden for all users
    - Configured admin -> request proceeds with current_user
    """
    from backend.app.core.config import settings

    admin_emails = {e.strip().lower() for e in settings.ADMIN_EMAILS if e and e.strip()}
    user_email = (current_user.email or "").strip().lower()

    if not admin_emails or not user_email or user_email not in admin_emails:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Bu işlem için yönetici yetkisi gerekiyor (Admin authorization required)",
        )
    return current_user
