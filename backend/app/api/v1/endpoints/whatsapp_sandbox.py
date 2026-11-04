"""WhatsApp Sandbox Operational Verification Endpoints (Phase 8.0.1).

Controlled, PII-safe, fail-closed endpoints for testing WhatsApp connectivity,
delivery receipts, and ping/pong correlation without risking production lines.
"""

from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import AuthUser, get_current_user
from backend.app.core.database import get_db
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.schemas.whatsapp_sandbox import (
    SandboxPingRequest,
    SandboxPingResponse,
    SandboxStatusResponse,
)
from backend.app.services.whatsapp.sandbox import (
    PROTECTED_PRODUCTION_SESSION_IDS,
    DuplicateCorrelationIdError,
    ProductionSessionBlockedError,
    SandboxDisabledError,
    SandboxRateLimitExceededError,
    SandboxTargetNotAllowedError,
    sandbox_service,
)

router = APIRouter()


@router.get("/status", response_model=SandboxStatusResponse)
async def get_sandbox_status(
    current_user: AuthUser = Depends(get_current_user),
) -> SandboxStatusResponse:
    """Sandbox konfigürasyon ve operasyonel sağlık durumunu döner (PII-safe)."""
    return SandboxStatusResponse(**sandbox_service.get_status())


@router.post("/ping", response_model=SandboxPingResponse)
async def execute_sandbox_ping(
    payload: SandboxPingRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
) -> SandboxPingResponse:
    """Kontrollü bir Sandbox Ping/Pong doğrulaması çalıştırır."""
    if not sandbox_service.is_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="BLOCKED: SANDBOX DISABLED: WhatsApp Sandbox is disabled in configuration (fail-closed).",
        )

    can_exec, code, reason = sandbox_service.can_execute_live()
    if not can_exec:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"{code}: {reason}",
        )

    session_id = sandbox_service.get_configured_session_id()
    if session_id in PROTECTED_PRODUCTION_SESSION_IDS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"BLOCKED: PRODUCTION SESSION PROTECTED: Session {session_id} cannot be used for sandbox.",
        )

    # Oturumun geçerliliğini ve kiracı izolasyonunu veritabanından doğrula
    sess_row = await db.get(WhatsAppSession, session_id)
    if not sess_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Configured sandbox session {session_id} not found in database.",
        )

    if sess_row.user_id and str(sess_row.user_id) != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant isolation error: Session belongs to another tenant.",
        )

    try:
        result = await sandbox_service.run_ping_pong_test(
            target_phone=payload.target,
            session_id=session_id,
            correlation_id=payload.correlation_id,
            timeout_ms=payload.timeout_ms,
            gateway_id=sess_row.gateway_id,
        )
    except SandboxTargetNotAllowedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    except (SandboxDisabledError, ProductionSessionBlockedError) as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    except DuplicateCorrelationIdError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except SandboxRateLimitExceededError as exc:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))

    return SandboxPingResponse(**result)


@router.get("/results", response_model=List[SandboxPingResponse])
async def get_sandbox_results(
    current_user: AuthUser = Depends(get_current_user),
) -> List[SandboxPingResponse]:
    """Son çalıştırılan sandbox testlerinin geçmişini döner."""
    return [SandboxPingResponse(**item) for item in sandbox_service.get_results_history()]
