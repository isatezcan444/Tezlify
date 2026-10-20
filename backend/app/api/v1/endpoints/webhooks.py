import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import AuthUser
from backend.app.auth.api.dependencies import get_current_user_unified
from backend.app.core.database import get_db
from backend.app.models.webhook import WebhookSubscription, WebhookDeliveryLog
from backend.app.schemas.webhook import (
    WebhookCreate,
    WebhookUpdate,
    WebhookResponse,
    WebhookDeliveryLogResponse,
    WebhookTestResponse,
)
from backend.app.services.webhook_dispatcher import WebhookDispatcher

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("", response_model=List[WebhookResponse])
async def list_webhooks(
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """Kullanıcının tanımlı tüm Webhook aboneliklerini listeler."""
    stmt = (
        select(WebhookSubscription)
        .where(WebhookSubscription.user_id == current_user.id)
        .order_by(WebhookSubscription.created_at.desc())
    )
    res = await db.execute(stmt)
    return res.scalars().all()


from backend.app.services.quota_guard import QuotaGuardService


@router.post("", response_model=WebhookResponse, status_code=status.HTTP_201_CREATED)
async def create_webhook(
    payload: WebhookCreate,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """Yeni bir giden (outbound) Webhook aboneliği oluşturur."""
    await QuotaGuardService.check_feature_access(db, current_user.id, "webhooks")
    target_url = payload.target_url.strip()
    if not (target_url.startswith("http://") or target_url.startswith("https://")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Hedef URL 'http://' veya 'https://' ile başlamalıdır",
        )

    sub = WebhookSubscription(
        user_id=current_user.id,
        name=payload.name.strip(),
        target_url=target_url,
        secret=WebhookSubscription.generate_secret(),
        events=payload.events,
        is_active=True,
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    logger.info("[WEBHOOK] User %s created Webhook #%s ('%s')", current_user.id, sub.id, sub.name)
    return sub


@router.patch("/{webhook_id}", response_model=WebhookResponse)
async def update_webhook(
    webhook_id: int,
    payload: WebhookUpdate,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """Webhook aboneliğini günceller."""
    stmt = select(WebhookSubscription).where(
        WebhookSubscription.id == webhook_id,
        WebhookSubscription.user_id == current_user.id,
    )
    res = await db.execute(stmt)
    sub = res.scalar_one_or_none()

    if not sub:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook aboneliği bulunamadı",
        )

    if payload.name is not None:
        sub.name = payload.name.strip()
    if payload.target_url is not None:
        target_url = payload.target_url.strip()
        if not (target_url.startswith("http://") or target_url.startswith("https://")):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Hedef URL 'http://' veya 'https://' ile başlamalıdır",
            )
        sub.target_url = target_url
    if payload.events is not None:
        sub.events = payload.events
    if payload.is_active is not None:
        sub.is_active = payload.is_active

    await db.commit()
    await db.refresh(sub)
    return sub


@router.delete("/{webhook_id}", status_code=status.HTTP_200_OK)
async def delete_webhook(
    webhook_id: int,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """Webhook aboneliğini ve ilişkili teslimat loglarını siler."""
    stmt = select(WebhookSubscription).where(
        WebhookSubscription.id == webhook_id,
        WebhookSubscription.user_id == current_user.id,
    )
    res = await db.execute(stmt)
    sub = res.scalar_one_or_none()

    if not sub:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook aboneliği bulunamadı",
        )

    await db.delete(sub)
    await db.commit()
    return {"success": True, "message": "Webhook başarıyla silindi"}


@router.post("/{webhook_id}/test", response_model=WebhookTestResponse)
async def test_webhook(
    webhook_id: int,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """Tanımlı webhook URL'ine anlık bir test pingi gönderir ve yanıtı döner."""
    stmt = select(WebhookSubscription).where(
        WebhookSubscription.id == webhook_id,
        WebhookSubscription.user_id == current_user.id,
    )
    res = await db.execute(stmt)
    sub = res.scalar_one_or_none()

    if not sub:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook aboneliği bulunamadı",
        )

    success, code, body, duration_ms, err = await WebhookDispatcher.send_test_ping(sub)
    return WebhookTestResponse(
        success=success,
        status_code=code,
        response_body=body,
        duration_ms=duration_ms,
        error=err,
    )


@router.get("/{webhook_id}/logs", response_model=List[WebhookDeliveryLogResponse])
async def get_webhook_delivery_logs(
    webhook_id: int,
    limit: int = 50,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
):
    """Webhook'un son teslimat geçmişini ve HTTP yanıt kodlarını listeler."""
    stmt = (
        select(WebhookDeliveryLog)
        .where(
            WebhookDeliveryLog.subscription_id == webhook_id,
            WebhookDeliveryLog.user_id == current_user.id,
        )
        .order_by(WebhookDeliveryLog.created_at.desc())
        .limit(limit)
    )
    res = await db.execute(stmt)
    return res.scalars().all()
