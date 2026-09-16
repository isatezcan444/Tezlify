import os
from typing import Optional
from fastapi import APIRouter, Depends, Query, Response, Request, HTTPException, status
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser
from backend.app.auth.domain.exceptions import AuthException
from backend.app.auth.infrastructure.google_provider import GoogleOAuthProvider
from backend.app.auth.application.session_service import SessionService
from backend.app.auth.application.user_service import UserService
from backend.app.auth.application.oauth_service import OAuthService
from backend.app.auth.api.dependencies import (
    get_current_user_unified,
    get_current_user_unified_with_profile,
    extract_session_token,
)

router = APIRouter()

# Environment settings
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "mock-google-client-id.apps.googleusercontent.com")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "mock-client-secret")
OAUTH_REDIRECT_URI = os.getenv(
    "GOOGLE_REDIRECT_URI",
    "https://api.130.162.247.20.sslip.io/api/v1/auth/google/callback",
)
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "https://api.130.162.247.20.sslip.io")

google_provider = GoogleOAuthProvider(
    client_id=GOOGLE_CLIENT_ID,
    client_secret=GOOGLE_CLIENT_SECRET,
    redirect_uri=OAUTH_REDIRECT_URI,
)
user_service = UserService()
session_service = SessionService()
oauth_service = OAuthService(
    google_provider=google_provider,
    user_service=user_service,
    session_service=session_service,
)


@router.get("/google")
async def initiate_google_login(
    redirect: Optional[bool] = Query(False, description="Redirect directly to Google if true"),
    db: AsyncSession = Depends(get_db),
):
    """Initiates Google OAuth flow by generating CSRF state and authorization URL."""
    auth_url, state = await oauth_service.initiate_google_flow(db)
    if redirect:
        return RedirectResponse(url=auth_url, status_code=status.HTTP_302_FOUND)
    return {
        "authorization_url": auth_url,
        "state": state,
    }


@router.get("/google/callback")
async def handle_google_callback(
    request: Request,
    response: Response,
    code: str = Query(..., description="Authorization code from Google"),
    state: str = Query(..., description="CSRF state parameter"),
    redirect: Optional[bool] = Query(True, description="Redirect to frontend on success"),
    db: AsyncSession = Depends(get_db),
):
    """Processes Google OAuth callback, verifies identity, establishes native session."""
    try:
        user, session, raw_token = await oauth_service.handle_callback(
            db=db,
            code=code,
            state=state,
        )
    except AuthException as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    if redirect:
        req_host = request.headers.get("host")
        req_proto = request.headers.get("x-forwarded-proto", "https")
        if req_host:
            target_origin = f"{req_proto}://{req_host}"
        else:
            target_origin = FRONTEND_ORIGIN

        redirect_url = f"{target_origin}/?session_token={raw_token}"
        redir = RedirectResponse(url=redirect_url, status_code=status.HTTP_302_FOUND)
        redir.set_cookie(
            key="tezlify_session",
            value=raw_token,
            max_age=7 * 24 * 3600,
            httponly=True,
            secure=True,
            samesite="lax",
            path="/",
        )
        return redir

    response.set_cookie(
        key="tezlify_session",
        value=raw_token,
        max_age=7 * 24 * 3600,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )
    return {
        "success": True,
        "session_token": raw_token,
        "user": user,
    }


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Revokes current session and clears session cookie."""
    token = extract_session_token(request)
    if token:
        await session_service.revoke_session(db, token)

    response.delete_cookie(
        key="tezlify_session",
        path="/",
    )
    return {"success": True, "message": "Oturum başarıyla kapatıldı"}


@router.get("/me", response_model=AuthUser)
async def get_me(
    current_user: AuthUser = Depends(get_current_user_unified_with_profile),
) -> AuthUser:
    """Returns currently authenticated user profile and subscription tier."""
    return current_user
