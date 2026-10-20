import datetime
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import AuthUser
from backend.app.auth.api.dependencies import get_current_user_unified
from backend.app.core.database import get_db
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.api_key import ApiKey
from backend.app.schemas.api_key import (
    ApiKeyCreate,
    ApiKeyResponse,
    ApiKeyCreatedResponse,
    ApiKeyListResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("", response_model=ApiKeyListResponse)
async def list_api_keys(
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """Kullanıcının oluşturduğu tüm API anahtarlarını listeler."""
    stmt = (
        select(ApiKey)
        .where(ApiKey.user_id == current_user.id)
        .order_by(ApiKey.created_at.desc())
    )
    res = await db.execute(stmt)
    keys = res.scalars().all()
    return ApiKeyListResponse(items=keys, total=len(keys))


from backend.app.services.quota_guard import QuotaGuardService


@router.post("", response_model=ApiKeyCreatedResponse, status_code=status.HTTP_201_CREATED)
async def create_api_key(
    payload: ApiKeyCreate,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """
    Yeni bir API anahtarı üretir.
    Üretilen tam gizli anahtar (raw_key) YALNIZCA BU YANITTA dönülür.
    Veritabanında yalnızca SHA-256 hash'i ve ön ek saklanır.
    """
    await QuotaGuardService.check_feature_access(db, current_user.id, "api_keys")
    raw_key = ApiKey.generate_raw_key()
    key_prefix = raw_key[:14]  # örn: 'tzf_live_1234'
    key_hash = ApiKey.hash_key(raw_key)

    expires_at = None
    if payload.expires_in_days:
        expires_at = utc_now_naive() + datetime.timedelta(days=payload.expires_in_days)

    api_key = ApiKey(
        user_id=current_user.id,
        name=payload.name.strip(),
        key_prefix=key_prefix,
        key_hash=key_hash,
        is_active=True,
        expires_at=expires_at,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)

    logger.info("[API_KEY] User %s created API Key #%s ('%s')", current_user.id, api_key.id, api_key.name)

    return ApiKeyCreatedResponse(
        id=api_key.id,
        name=api_key.name,
        key_prefix=api_key.key_prefix,
        is_active=api_key.is_active,
        last_used_at=api_key.last_used_at,
        expires_at=api_key.expires_at,
        created_at=api_key.created_at,
        raw_key=raw_key,
    )


@router.delete("/{key_id}", status_code=status.HTTP_200_OK)
async def delete_api_key(
    key_id: int,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """API anahtarını kalıcı olarak siler ve erişimini anında iptal eder."""
    stmt = select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == current_user.id)
    res = await db.execute(stmt)
    key_row = res.scalar_one_or_none()

    if not key_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API Anahtarı bulunamadı",
        )

    await db.delete(key_row)
    await db.commit()
    logger.info("[API_KEY] User %s deleted API Key #%s", current_user.id, key_id)
    return {"success": True, "message": "API anahtarı başarıyla silindi"}


@router.patch("/{key_id}/toggle", response_model=ApiKeyResponse)
async def toggle_api_key_status(
    key_id: int,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """API anahtarını aktif/pasif yapar."""
    stmt = select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == current_user.id)
    res = await db.execute(stmt)
    key_row = res.scalar_one_or_none()

    if not key_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API Anahtarı bulunamadı",
        )

    key_row.is_active = not key_row.is_active
    await db.commit()
    await db.refresh(key_row)
    return key_row
