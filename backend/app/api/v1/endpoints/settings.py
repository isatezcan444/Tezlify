import logging
from datetime import datetime
from backend.app.core.datetime_utils import utc_now_naive
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.core.database import get_db
from backend.app.core.config import settings as app_settings
from backend.app.models.system_settings import SystemSetting
from backend.app.schemas.settings import AntiBanSettingsSchema, AntiBanSettingsResponse

logger = logging.getLogger(__name__)
router = APIRouter()

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
