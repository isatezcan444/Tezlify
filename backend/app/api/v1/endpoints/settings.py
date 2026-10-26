import logging
from datetime import datetime
from backend.app.core.datetime_utils import utc_now_naive
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.core.database import get_db
from backend.app.core.auth import get_current_user
from backend.app.core.config import settings as app_settings
from backend.app.models.system_settings import SystemSetting
from backend.app.schemas.settings import (
    AntiBanSettingsSchema,
    AntiBanSettingsResponse,
    SmtpConfigSchema,
    SmtpConfigResponse,
    SmtpTestRequest,
)
from backend.app.services.email_service import EmailService
from backend.app.schemas.proxy import (
    ProxyConfigSchema,
    ProxyPoolStatusResponse,
    ProxyTestRequest,
    ProxyTestResponse,
)
from backend.app.services.proxy_manager import ProxyManager
from typing import List, Optional

logger = logging.getLogger(__name__)
# Kimlik dogrulama ROUTER duzeyinde zorunludur. Bu dosyadaki her uc nokta
# GLOBAL (tum kiracilar icin ortak) yapilandirmayi okur/yazar: SMTP kimlik
# bilgileri, scraper proxy havuzu ve anti-ban tavani. Tek bir unutulan
# `Depends(get_current_user)` tum bu yuzeyi internete acik birakiyordu
# (canli dogrulama 2026-10-27: `GET /api/v1/settings/smtp` oturumsuz 200
# donuyordu). Uc nokta bazinda tekrarlamak yerine router'a baglamak, yeni
# eklenen bir route'un varsayilan olarak KAPALI olmasini saglar.
router = APIRouter(dependencies=[Depends(get_current_user)])

ANTIBAN_CONFIG_KEY = "antiban_config"


async def get_or_create_antiban_settings(db: AsyncSession) -> SystemSetting:
    stmt = select(SystemSetting).where(SystemSetting.key == ANTIBAN_CONFIG_KEY)
    res = await db.execute(stmt)
    setting = res.scalar_one_or_none()
    if not setting:
        setting = SystemSetting(
            key=ANTIBAN_CONFIG_KEY,
            preset="standard_balanced",
            min_delay_seconds=app_settings.DEFAULT_MIN_DELAY_SECONDS,
            max_delay_seconds=app_settings.DEFAULT_MAX_DELAY_SECONDS,
            typing_delay_seconds=app_settings.DEFAULT_TYPING_DELAY_SECONDS,
            daily_message_limit=app_settings.DEFAULT_DAILY_LIMIT_PER_SESSION,
            working_hours_enabled=True,
            working_hours_start=app_settings.DEFAULT_WORKING_HOURS_START,
            working_hours_end=app_settings.DEFAULT_WORKING_HOURS_END,
        )
        db.add(setting)
        await db.commit()
        await db.refresh(setting)
    return setting


@router.get("/antiban", response_model=AntiBanSettingsResponse)
async def get_antiban_settings(db: AsyncSession = Depends(get_db)):
    """Mevcut global Anti-Ban yapılandırmasını döndürür."""
    setting = await get_or_create_antiban_settings(db)
    return setting


@router.patch("/antiban", response_model=AntiBanSettingsResponse)
async def update_antiban_settings(
    payload: AntiBanSettingsSchema,
    db: AsyncSession = Depends(get_db)
):
    """Global Anti-Ban parametrelerini günceller ve veritabanında kalıcı kılar."""
    setting = await get_or_create_antiban_settings(db)
    
    setting.preset = payload.preset
    setting.min_delay_seconds = payload.min_delay_seconds
    setting.max_delay_seconds = payload.max_delay_seconds
    setting.typing_delay_seconds = payload.typing_delay_seconds
    setting.daily_message_limit = payload.daily_message_limit
    setting.working_hours_enabled = payload.working_hours_enabled
    setting.working_hours_start = payload.working_hours_start
    setting.working_hours_end = payload.working_hours_end
    setting.updated_at = utc_now_naive()
    
    await db.commit()
    await db.refresh(setting)
    logger.info(f"[Settings] Global Anti-Ban yapılandırması güncellendi: preset={setting.preset}, limit={setting.daily_message_limit}")
    return setting


# ---------------------------------------------------------------------------
# Scraper Proxy Pool & Rotation Endpoints (Faz 3)
# ---------------------------------------------------------------------------
@router.get("/proxy", response_model=ProxyPoolStatusResponse)
async def get_proxy_settings(db: AsyncSession = Depends(get_db)):
    """Scraper proxy havuzunun mevcut durumunu ve yapılandırmasını döndürür."""
    return await ProxyManager.get_status(db)


@router.patch("/proxy", response_model=ProxyPoolStatusResponse)
async def update_proxy_settings(
    payload: ProxyConfigSchema,
    db: AsyncSession = Depends(get_db)
):
    """Scraper proxy havuzu yapılandırmasını günceller."""
    await ProxyManager.save_config(db, payload)
    return await ProxyManager.get_status(db)


@router.post("/proxy/test", response_model=List[ProxyTestResponse])
async def test_proxies(
    payload: Optional[ProxyTestRequest] = None,
    db: AsyncSession = Depends(get_db)
):
    """Tek bir proxy adresini veya havuzdaki tüm proxy'leri canlı test eder."""
    if payload and payload.proxy_url:
        result = await ProxyManager.test_proxy(payload.proxy_url)
        return [result]
    return await ProxyManager.test_all_proxies(db)


# ---------------------------------------------------------------------------
# SMTP Email Outreach Configuration Endpoints (Item 3)
# ---------------------------------------------------------------------------
@router.get("/smtp", response_model=SmtpConfigResponse)
async def get_smtp_settings(db: AsyncSession = Depends(get_db)):
    """Mevcut kurumsal SMTP e-posta yapılandırmasını döndürür."""
    return await EmailService.get_smtp_config(db)


@router.patch("/smtp", response_model=SmtpConfigResponse)
async def update_smtp_settings(
    payload: SmtpConfigSchema,
    db: AsyncSession = Depends(get_db)
):
    """Kurumsal SMTP e-posta yapılandırmasını günceller."""
    return await EmailService.save_smtp_config(db, payload.model_dump())


@router.post("/smtp/test")
async def test_smtp(
    payload: SmtpTestRequest,
    db: AsyncSession = Depends(get_db)
):
    """Yapılandırılmış SMTP üzerinden hedef adrese canlı test e-postası gönderir."""
    config = await EmailService.get_smtp_config(db)
    if not config.get("is_configured"):
        return {"success": False, "error": "SMTP ayarları henüz yapılandırılmamış."}
    return await EmailService.test_smtp_connection(config, payload.target_email)
