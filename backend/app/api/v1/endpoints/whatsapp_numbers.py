"""
REST API Endpoints for Meta WhatsApp Cloud API Number Management.

Provides:
- GET /api/v1/whatsapp/numbers (List numbers for tenant)
- POST /api/v1/whatsapp/numbers/validate (Pre-flight Meta validation)
- POST /api/v1/whatsapp/numbers (Connect & activate number)
- GET /api/v1/whatsapp/numbers/{id} (Get number details)
- PUT /api/v1/whatsapp/numbers/{id} (Update metadata & atomic token rotation)
- POST /api/v1/whatsapp/numbers/{id}/verify (Test live connection with Meta)
- POST /api/v1/whatsapp/numbers/{id}/disconnect (Safely disconnect number)
- DELETE /api/v1/whatsapp/numbers/{id} (Safely unlink / remove number)

Security & Data Integrity Guarantees:
- Strict tenant isolation enforced via current_user.id.
- Access tokens, secrets, and raw credentials are NEVER returned in any response.
- Meta errors are normalized and sanitized.
- Delete semantics (product rule): removing a number wipes the tenant's live
  WhatsApp dialogs and purges linked Baileys sessions. Disconnect preserves history.
"""
import logging
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser, get_current_user
from backend.app.schemas.whatsapp_number import (
    WhatsAppNumberRead,
    WhatsAppNumberConnectRequest,
    WhatsAppNumberValidateRequest,
    WhatsAppNumberValidateResponse,
    WhatsAppNumberUpdate,
    WhatsAppNumberVerifyResponse,
)
from backend.app.services.whatsapp_number_service import (
    WhatsAppNumberService,
    DuplicatePhoneNumberIdError,
    WhatsAppNumberNotFoundError,
    WhatsAppNumberGatewayError,
)
from backend.app.api.v1.websocket import ws_manager
from backend.app.services.meta_cloud_client import MetaApiError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/numbers", tags=["WhatsApp Numbers"])


@router.get("", response_model=List[WhatsAppNumberRead])
async def list_whatsapp_numbers(
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Lists all WhatsApp Business Cloud API numbers owned by the current tenant."""
    numbers = await WhatsAppNumberService.list_numbers(db, user_id=current_user.id)
    return numbers


@router.post("/validate", response_model=WhatsAppNumberValidateResponse)
async def validate_whatsapp_number(
    payload: WhatsAppNumberValidateRequest,
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Validates Meta Cloud API credentials without storing them.
    Checks phone_number_id existence, WABA ownership, and permissions.
    """
    try:
        res = await WhatsAppNumberService.validate_credentials(
            waba_id=payload.waba_id,
            phone_number_id=payload.phone_number_id,
            access_token=payload.access_token,
        )
        return WhatsAppNumberValidateResponse(
            is_valid=True,
            phone_number_id=res["phone_number_id"],
            display_phone_number=res.get("display_phone_number"),
            verified_name=res.get("verified_name"),
            quality_rating=res.get("quality_rating", "UNKNOWN"),
            waba_id=res.get("waba_id"),
        )
    except MetaApiError as e:
        return WhatsAppNumberValidateResponse(
            is_valid=False,
            phone_number_id=payload.phone_number_id,
            waba_id=payload.waba_id,
            error=e.message,
        )
    except Exception as e:
        logger.error(f"[WhatsAppNumbersAPI] Validation exception: {e}")
        return WhatsAppNumberValidateResponse(
            is_valid=False,
            phone_number_id=payload.phone_number_id,
            waba_id=payload.waba_id,
            error=f"Doğrulama sırasında hata oluştu: {str(e)}",
        )


@router.post("", response_model=WhatsAppNumberRead, status_code=status.HTTP_201_CREATED)
async def connect_whatsapp_number(
    payload: WhatsAppNumberConnectRequest,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Connects and activates a new WhatsApp Business Cloud API number.
    Verifies with Meta, encrypts the access token, and saves the number.
    """
    try:
        number = await WhatsAppNumberService.connect_number(
            db=db,
            user_id=current_user.id,
            name=payload.name,
            waba_id=payload.waba_id,
            phone_number_id=payload.phone_number_id,
            access_token=payload.access_token,
            business_account_id=payload.business_account_id,
        )
        await db.commit()
        await db.refresh(number)
        return number
    except DuplicatePhoneNumberIdError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )
    except MetaApiError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Meta doğrulama hatası: {e.message}",
        )
    except ValueError as e:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        await db.rollback()
        logger.error(f"[WhatsAppNumbersAPI] Connect failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="WhatsApp hattı bağlanırken beklenmeyen bir hata oluştu.",
        )


@router.get("/{number_id}", response_model=WhatsAppNumberRead)
async def get_whatsapp_number(
    number_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """Fetches details of a specific WhatsApp number. Enforces tenant isolation."""
    number = await WhatsAppNumberService.get_number(db, number_id, user_id=current_user.id)
    if not number:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"WhatsApp hattı (ID: {number_id}) bulunamadı veya erişim yetkiniz yok.",
        )
    return number


@router.put("/{number_id}", response_model=WhatsAppNumberRead)
async def update_whatsapp_number(
    number_id: int,
    payload: WhatsAppNumberUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Updates number metadata (name) or performs atomic token rotation.
    If a new access_token is provided, it is validated with Meta first;
    if validation fails, the existing working credential is kept intact.
    """
    try:
        updated = await WhatsAppNumberService.update_number(
            db=db,
            number_id=number_id,
            user_id=current_user.id,
            name=payload.name,
            access_token=payload.access_token,
        )
        await db.commit()
        await db.refresh(updated)
        return updated
    except WhatsAppNumberNotFoundError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"WhatsApp hattı (ID: {number_id}) bulunamadı veya erişim yetkiniz yok.",
        )
    except MetaApiError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Yeni token Meta tarafından doğrulanamadı. Eski çalışan token korundu: {e.message}",
        )
    except Exception as e:
        await db.rollback()
        logger.error(f"[WhatsAppNumbersAPI] Update failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Güncelleme sırasında hata oluştu: {str(e)}",
        )


@router.post("/{number_id}/verify", response_model=WhatsAppNumberVerifyResponse)
async def verify_whatsapp_number(
    number_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Performs a real-time connection check against Meta Graph API using stored credentials.
    Updates verified name, quality rating, and last_verified_at.
    """
    try:
        res = await WhatsAppNumberService.verify_number(db, number_id, user_id=current_user.id)
        await db.commit()
        return WhatsAppNumberVerifyResponse(
            id=res["id"],
            status=res["status"],
            verified=res["verified"],
            verified_name=res.get("verified_name"),
            quality_rating=res.get("quality_rating", "UNKNOWN"),
            last_verified_at=res.get("last_verified_at"),
        )
    except WhatsAppNumberNotFoundError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"WhatsApp hattı (ID: {number_id}) bulunamadı veya erişim yetkiniz yok.",
        )
    except MetaApiError as e:
        await db.commit()  # Commits status=ERROR
        return WhatsAppNumberVerifyResponse(
            id=number_id,
            status=res.get("status") if 'res' in locals() else "ERROR",
            verified=False,
            error=e.message,
        )
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Bağlantı testi sırasında hata oluştu: {str(e)}",
        )


@router.post("/{number_id}/disconnect", response_model=WhatsAppNumberRead)
async def disconnect_whatsapp_number(
    number_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Safely disconnects the WhatsApp number.
    Sets status to DISCONNECTED and invalidates stored credentials.
    CRITICAL: Preserves 100% of CRM Leads, Contacts, Conversations, and Messages intact.
    """
    try:
        disconnected = await WhatsAppNumberService.disconnect_number(
            db=db,
            number_id=number_id,
            user_id=current_user.id,
        )
        await db.commit()
        await db.refresh(disconnected)
        return disconnected
    except WhatsAppNumberNotFoundError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"WhatsApp hattı (ID: {number_id}) bulunamadı veya erişim yetkiniz yok.",
        )
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.delete("/{number_id}")
async def remove_whatsapp_number(
    number_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: AuthUser = Depends(get_current_user),
):
    """
    Removes the WhatsApp line with full live-dialog cleanup (product rule):
    linked Baileys gateway sessions are purged, linked WhatsAppSession rows
    are deleted, and ALL live WhatsApp dialogs + auto-synced WhatsApp leads
    of the tenant are wiped — including unclaimed rows. The next "QR ile
    bağla" therefore always starts from a fresh QR code.
    """
    try:
        result = await WhatsAppNumberService.remove_number(
            db=db,
            number_id=number_id,
            user_id=current_user.id,
            hard_delete=True,
        )
        await db.commit()
        await ws_manager.broadcast({
            "event": "conversations_cleared",
            "user_id": str(current_user.id) if current_user.id else None,
            "purged_session_names": (result or {}).get("purged_session_names", []),
        })
        return {"success": True, "message": "WhatsApp hattı ve canlı diyaloglar silindi."}
    except WhatsAppNumberNotFoundError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"WhatsApp hattı (ID: {number_id}) bulunamadı veya erişim yetkiniz yok.",
        )
    except WhatsAppNumberGatewayError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(e),
        )
    except Exception as e:
        await db.rollback()
        logger.error(f"[WhatsAppNumbersAPI] Remove failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="WhatsApp hattı silinirken beklenmeyen bir hata oluştu.",
        )
