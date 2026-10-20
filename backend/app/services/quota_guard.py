import logging
from datetime import datetime, timedelta
from typing import Tuple, Dict, Any, Optional

from fastapi import HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.subscription import UserSubscription
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.schemas.billing import (
    PlanTier,
    PLAN_CONFIGS,
    QuotaMetric,
    QuotaUsageSummary,
    PlanInfo,
    PlanListResponse,
)

logger = logging.getLogger(__name__)


class QuotaGuardService:
    """SaaS abonelik kotaları, limit denetimleri ve paket yönetimi servisi."""

    @classmethod
    async def get_or_create_subscription(
        cls,
        db: AsyncSession,
        user_id: str,
        default_tier: str = PlanTier.STARTER.value,
    ) -> UserSubscription:
        """Kullanıcının abonelik kaydını getirir; yoksa default tier ile oluşturur."""
        clean_user_id = str(user_id).strip()
        if clean_user_id == "00000000-0000-0000-0000-000000000001":
            default_tier = PlanTier.DEVELOPER_PRO.value

        stmt = select(UserSubscription).where(UserSubscription.user_id == clean_user_id)
        res = await db.execute(stmt)
        sub = res.scalar_one_or_none()

        if sub and clean_user_id == "00000000-0000-0000-0000-000000000001" and sub.plan_tier != PlanTier.DEVELOPER_PRO.value:
            sub.plan_tier = PlanTier.DEVELOPER_PRO.value
            await db.commit()
            await db.refresh(sub)

        now = utc_now_naive()
        if not sub:
            sub = UserSubscription(
                user_id=clean_user_id,
                plan_tier=default_tier,
                billing_cycle="monthly",
                period_start=now,
                period_end=now + timedelta(days=30),
                leads_scraped_current_period=0,
                whatsapp_sent_today=0,
                ai_generations_today=0,
                last_daily_reset=now,
                is_active=True,
                created_at=now,
                updated_at=now,
            )
            db.add(sub)
            await db.commit()
            await db.refresh(sub)
            return sub

        # Rollover kontrolü
        changed = False
        # Günlük reset kontrolü (UTC gün değiştiyse)
        if sub.last_daily_reset.date() < now.date():
            sub.whatsapp_sent_today = 0
            sub.ai_generations_today = 0
            sub.last_daily_reset = now
            changed = True

        # Aylık periyot reset kontrolü
        if now >= sub.period_end:
            sub.period_start = now
            sub.period_end = now + timedelta(days=30)
            sub.leads_scraped_current_period = 0
            changed = True

        if changed:
            await db.commit()
            await db.refresh(sub)

        return sub

    @classmethod
    def get_plan_config(cls, plan_tier: str) -> Dict[str, Any]:
        """Belirtilen planın limit ve özellik konfigürasyonunu döner."""
        tier_upper = (plan_tier or PlanTier.STARTER.value).upper()
        return PLAN_CONFIGS.get(tier_upper, PLAN_CONFIGS[PlanTier.STARTER.value])

    @classmethod
    async def check_scrape_allowance(
        cls,
        db: AsyncSession,
        user_id: str,
        count: int = 1,
        raise_exception: bool = True,
    ) -> Tuple[bool, int, int]:
        """
        Lead kazıma / arama kotasını denetler.
        Döner: (izin_verildi_mi, kalan_kota, toplam_limit)
        """
        sub = await cls.get_or_create_subscription(db, user_id)
        plan = cls.get_plan_config(sub.plan_tier)
        limit = plan["monthly_lead_scrape_limit"]
        used = sub.leads_scraped_current_period
        remaining = max(0, limit - used)

        if used + count > limit:
            if raise_exception:
                raise HTTPException(
                    status_code=status.HTTP_402_PAYMENT_REQUIRED,
                    detail=(
                        f"Aylık lead arama ve kayıt kotanız doldu "
                        f"(Kullanılan: {used}/{limit}, İstenen: {count}). "
                        f"Lütfen üst pakete yükseltin."
                    ),
                )
            return False, remaining, limit

        return True, remaining, limit

    @classmethod
    async def consume_scrape_quota(
        cls,
        db: AsyncSession,
        user_id: str,
        count: int = 1,
    ) -> int:
        """Kullanıcının scrape kotasını belirtilen miktar kadar tüketir."""
        sub = await cls.get_or_create_subscription(db, user_id)
        sub.leads_scraped_current_period += count
        await db.commit()
        await db.refresh(sub)
        return sub.leads_scraped_current_period

    @classmethod
    async def consume_whatsapp_quota(
        cls,
        db: AsyncSession,
        user_id: str,
        count: int = 1,
    ) -> int:
        """Kullanıcının günlük WhatsApp kotasını belirtilen miktar kadar tüketir."""
        sub = await cls.get_or_create_subscription(db, user_id)
        sub.whatsapp_sent_today += count
        await db.commit()
        await db.refresh(sub)
        return sub.whatsapp_sent_today

    @classmethod
    async def check_and_consume_whatsapp_quota(
        cls,
        db: AsyncSession,
        user_id: str,
        count: int = 1,
        raise_exception: bool = True,
    ) -> Tuple[bool, int, int]:
        """
        Günlük WhatsApp mesaj gönderim kotasını denetler ve izin verilirse tüketir.
        Döner: (izin_verildi_mi, kalan_kota, toplam_limit)
        """
        sub = await cls.get_or_create_subscription(db, user_id)
        plan = cls.get_plan_config(sub.plan_tier)
        limit = plan["daily_whatsapp_outreach_limit"]
        used = sub.whatsapp_sent_today
        remaining = max(0, limit - used)

        if used + count > limit:
            if raise_exception:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=(
                        f"Günlük WhatsApp mesaj gönderim limitinize ulaştınız "
                        f"(Gönderilen: {used}/{limit}). Yarın sıfırlanacaktır veya paketinizi yükseltebilirsiniz."
                    ),
                )
            return False, remaining, limit

        sub.whatsapp_sent_today += count
        await db.commit()
        await db.refresh(sub)
        return True, max(0, limit - sub.whatsapp_sent_today), limit

    @classmethod
    async def check_campaign_allowance(
        cls,
        db: AsyncSession,
        user_id: str,
        raise_exception: bool = True,
    ) -> Tuple[bool, int, int]:
        """Aktif kampanya sayısının paket limitini aşıp aşmadığını denetler."""
        sub = await cls.get_or_create_subscription(db, user_id)
        if sub.plan_tier == PlanTier.DEVELOPER_PRO.value:
            return True, 0, 999999

        plan = cls.get_plan_config(sub.plan_tier)
        limit = plan["max_active_campaigns"]

        clean_user_id = str(user_id).strip()
        stmt = (
            select(func.count(Campaign.id))
            .where(
                Campaign.user_id == clean_user_id,
                Campaign.status == CampaignStatus.ACTIVE,
            )
        )
        res = await db.execute(stmt)
        active_count = res.scalar() or 0

        if active_count >= limit:
            if raise_exception:
                raise HTTPException(
                    status_code=status.HTTP_402_PAYMENT_REQUIRED,
                    detail=(
                        f"Paketinizde aynı anda en fazla {limit} aktif kampanya çalıştırabilirsiniz. "
                        f"Şu an {active_count} aktif kampanyanız var. Lütfen birini durdurun veya paketinizi yükseltin."
                    ),
                )
            return False, active_count, limit

        return True, active_count, limit

    @classmethod
    async def check_feature_access(
        cls,
        db: AsyncSession,
        user_id: str,
        feature_name: str,
        raise_exception: bool = True,
    ) -> bool:
        """
        Özellik bazlı yetki kontrolü ('webhooks', 'api_access', 'export_csv', 'ai_generation').
        """
        sub = await cls.get_or_create_subscription(db, user_id)
        plan = cls.get_plan_config(sub.plan_tier)

        key_map = {
            "webhooks": "webhooks_enabled",
            "api_keys": "api_access_enabled",
            "api_access": "api_access_enabled",
            "export_csv": "export_csv_enabled",
        }
        config_key = key_map.get(feature_name, feature_name)
        allowed = plan.get(config_key, True)

        if not allowed and raise_exception:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"'{feature_name}' özelliği mevcut {plan['name']} paketinizde desteklenmemektedir. "
                    f"Bu özellikten yararlanmak için lütfen paketinizi yükseltin."
                ),
            )
        return allowed

    @classmethod
    async def get_usage_summary(
        cls,
        db: AsyncSession,
        user_id: str,
    ) -> QuotaUsageSummary:
        """Kullanıcının tüm kota, metrik ve kalan limit özetini hesaplar."""
        sub = await cls.get_or_create_subscription(db, user_id)
        plan = cls.get_plan_config(sub.plan_tier)

        now = utc_now_naive()
        days_until_renewal = max(0, (sub.period_end - now).days)

        # Aktif kampanya sayısını hesapla
        clean_user_id = str(user_id).strip()
        stmt = (
            select(func.count(Campaign.id))
            .where(
                Campaign.user_id == clean_user_id,
                Campaign.status == CampaignStatus.ACTIVE,
            )
        )
        res = await db.execute(stmt)
        active_campaigns_count = res.scalar() or 0

        # Metrik hesaplamaları
        lead_limit = plan["monthly_lead_scrape_limit"]
        lead_used = sub.leads_scraped_current_period
        lead_pct = round((lead_used / lead_limit * 100), 1) if lead_limit > 0 else 0.0

        wa_limit = plan["daily_whatsapp_outreach_limit"]
        wa_used = sub.whatsapp_sent_today
        wa_pct = round((wa_used / wa_limit * 100), 1) if wa_limit > 0 else 0.0

        ai_limit = plan["ai_daily_limit"]
        ai_used = sub.ai_generations_today
        ai_pct = round((ai_used / ai_limit * 100), 1) if ai_limit > 0 else 0.0

        camp_limit = plan["max_active_campaigns"]
        camp_pct = round((active_campaigns_count / camp_limit * 100), 1) if camp_limit > 0 else 0.0

        return QuotaUsageSummary(
            user_id=sub.user_id,
            plan_tier=sub.plan_tier,
            plan_name=plan["name"],
            billing_cycle=sub.billing_cycle,
            period_start=sub.period_start,
            period_end=sub.period_end,
            days_until_renewal=days_until_renewal,
            leads=QuotaMetric(
                used=lead_used,
                limit=lead_limit,
                remaining=max(0, lead_limit - lead_used),
                percentage=min(100.0, lead_pct),
            ),
            whatsapp_daily=QuotaMetric(
                used=wa_used,
                limit=wa_limit,
                remaining=max(0, wa_limit - wa_used),
                percentage=min(100.0, wa_pct),
            ),
            ai_daily=QuotaMetric(
                used=ai_used,
                limit=ai_limit,
                remaining=max(0, ai_limit - ai_used),
                percentage=min(100.0, ai_pct),
            ),
            active_campaigns=QuotaMetric(
                used=active_campaigns_count,
                limit=camp_limit,
                remaining=max(0, camp_limit - active_campaigns_count),
                percentage=min(100.0, camp_pct),
            ),
            features={
                "webhooks": plan["webhooks_enabled"],
                "api_access": plan["api_access_enabled"],
                "export_csv": plan["export_csv_enabled"],
            },
        )

    @classmethod
    async def get_all_plans(cls, current_tier: str) -> PlanListResponse:
        """Tüm paket seçeneklerini ve kullanıcının mevcut durumunu döner."""
        current_upper = (current_tier or PlanTier.STARTER.value).upper()
        plans_list = []

        for tier_key, cfg in PLAN_CONFIGS.items():
            # DEVELOPER_PRO'yu sadece dev kullanıcılara göster
            if tier_key == PlanTier.DEVELOPER_PRO.value and current_upper != PlanTier.DEVELOPER_PRO.value:
                continue

            plans_list.append(
                PlanInfo(
                    id=tier_key,
                    name=cfg["name"],
                    price_try=cfg["price_try"],
                    monthly_lead_scrape_limit=cfg["monthly_lead_scrape_limit"],
                    daily_whatsapp_outreach_limit=cfg["daily_whatsapp_outreach_limit"],
                    max_active_campaigns=cfg["max_active_campaigns"],
                    ai_daily_limit=cfg["ai_daily_limit"],
                    webhooks_enabled=cfg["webhooks_enabled"],
                    api_access_enabled=cfg["api_access_enabled"],
                    export_csv_enabled=cfg["export_csv_enabled"],
                    badge_color=cfg["badge_color"],
                    description=cfg["description"],
                    features_list=cfg["features_list"],
                    is_current=(tier_key == current_upper),
                )
            )

        return PlanListResponse(
            current_plan_tier=current_upper,
            plans=plans_list,
        )

    @classmethod
    async def change_user_plan(
        cls,
        db: AsyncSession,
        user_id: str,
        new_tier: str,
    ) -> UserSubscription:
        """Kullanıcının plan tier'ını günceller."""
        tier_upper = new_tier.upper().strip()
        if tier_upper not in PLAN_CONFIGS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Geçersiz paket kodu: {new_tier}. Geçerli paketler: {list(PLAN_CONFIGS.keys())}",
            )

        sub = await cls.get_or_create_subscription(db, user_id)
        sub.plan_tier = tier_upper
        sub.updated_at = utc_now_naive()
        await db.commit()
        await db.refresh(sub)
        logger.info("[QUOTA] User %s switched plan to %s", user_id, tier_upper)
        return sub
