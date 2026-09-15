import logging
from typing import Optional
from uuid import UUID
from fastapi import Request, HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser, verify_and_decode_jwt, _is_dev_or_test_context
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
    """Unified FastAPI dependency supporting both Oracle Native Sessions and Supabase JWT fallback."""
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
                # Look up associated profile for subscription and plan quotas
                profile = None
                try:
                    stmt = select(Profile).where(Profile.id == str(user.id))
                    res = await db.execute(stmt)
                    profile = res.scalar_one_or_none()
                except Exception as pe:
                    logger.debug(f"Profile lookup skipped: {pe}")

                return AuthUser(
                    id=str(user.id),
                    email=user.email,
                    full_name=profile.full_name if profile and profile.full_name else user.display_name,
                    avatar_url=profile.avatar_url if profile and profile.avatar_url else user.avatar_url,
                    plan_tier=profile.plan_tier if profile else "DEVELOPER_PRO",
                    leads_monthly_limit=profile.leads_monthly_limit if profile else 999999,
                    leads_used_this_month=profile.leads_used_this_month if profile else 0,
                    messages_daily_limit=profile.messages_daily_limit if profile else 999999,
                )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"Native session resolution failed: {exc}")

    # 2. Fallback to Supabase JWT verification for zero-downtime transition
    try:
        payload = verify_and_decode_jwt(token)
        user_id = payload.get("sub")
        email = payload.get("email") or ""

        if user_id:
            stmt = select(Profile).where(Profile.id == user_id)
            res = await db.execute(stmt)
            profile = res.scalar_one_or_none()

            return AuthUser(
                id=str(user_id),
                email=email,
                full_name=profile.full_name if profile and profile.full_name else payload.get("name"),
                avatar_url=profile.avatar_url if profile and profile.avatar_url else payload.get("picture"),
                plan_tier=profile.plan_tier if profile else "DEVELOPER_PRO",
                leads_monthly_limit=profile.leads_monthly_limit if profile else 999999,
                leads_used_this_month=profile.leads_used_this_month if profile else 0,
                messages_daily_limit=profile.messages_daily_limit if profile else 999999,
            )
    except Exception:
        pass

    # Neither native session nor Supabase JWT was valid
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Geçersiz veya süresi dolmuş oturum (Invalid or expired session)",
        headers={"WWW-Authenticate": "Bearer"},
    )
