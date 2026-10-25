import logging
from datetime import datetime, date
from typing import Dict, Any, List, Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.models.message_log import MessageLog, MessageStatus

logger = logging.getLogger(__name__)


WARMUP_SCHEDULE: List[Dict[str, Any]] = [
    {"day": 1, "daily_limit": 10, "label": "1. Gün - Nazik Başlangıç (10 Mesaj)"},
    {"day": 2, "daily_limit": 20, "label": "2. Gün - Güven Oluşturma (20 Mesaj)"},
    {"day": 3, "daily_limit": 35, "label": "3. Gün - Hacim Artışı (35 Mesaj)"},
    {"day": 4, "daily_limit": 50, "label": "4. Gün - Standart Eşik (50 Mesaj)"},
    {"day": 5, "daily_limit": 75, "label": "5. Gün - Yüksek Hacim (75 Mesaj)"},
    {"day": 6, "daily_limit": 100, "label": "6. Gün - Tam Ölçek (100 Mesaj)"},
]


class WarmupService:
    """WhatsApp Hatları için Otomatik Numara Isıtma (Warm-Up Mode) Motoru.

    Yeni ve dinlenmiş hatların banlanmasını önlemek amacıyla gönderim hacmini
    gün bazında kademeli olarak artırır. Hedef kota aşıldığında hattı 'Mezun'
    olarak işaretler.
    """

    @classmethod
    def get_schedule(cls) -> List[Dict[str, Any]]:
        return WARMUP_SCHEDULE

    @classmethod
    def calculate_limit_for_day(cls, day: int, target_limit: int = 100) -> int:
        """Belirtilen gün numarası için güvenli günlük limiti hesaplar."""
        if day <= 0:
            day = 1
        day_to_limit = {1: 10, 2: 20, 3: 35, 4: 50, 5: 75}
        base_limit = day_to_limit.get(day, target_limit)
        return min(base_limit, target_limit)

    @classmethod
    def compute_day_and_limit(
        cls, started_at: datetime, target_limit: int = 100, now_dt: Optional[datetime] = None
    ) -> Tuple[int, int, bool]:
        """Başlangıç tarihine göre geçen gün sayısını ve limiti hesaplar.
        
        Returns: (current_day, daily_limit, is_graduated)
        """
        now = now_dt or utc_now_naive()
        start_date = started_at.date() if isinstance(started_at, datetime) else date.today()
        now_date = now.date() if isinstance(now, datetime) else date.today()
        
        days_elapsed = (now_date - start_date).days
        current_day = max(1, days_elapsed + 1)
        daily_limit = cls.calculate_limit_for_day(current_day, target_limit)
        is_graduated = current_day >= 6 or daily_limit >= target_limit
        return current_day, daily_limit, is_graduated

    @classmethod
    async def sync_session_warmup(
        cls, session: WhatsAppSession, db: AsyncSession
    ) -> WhatsAppSession:
        """Oturumun warm-up durumunu güncel tarihe göre senkronize eder ve veritabanına yazar."""
        if not session.is_warmup_enabled:
            return session

        now = utc_now_naive()
        if not session.warmup_started_at:
            session.warmup_started_at = now
            session.warmup_current_day = 1
            session.warmup_daily_limit = 10
            await db.commit()
            return session

        current_day, daily_limit, is_graduated = cls.compute_day_and_limit(
            started_at=session.warmup_started_at,
            target_limit=session.warmup_target_limit or 100,
            now_dt=now,
        )

        has_changed = False
        if session.warmup_current_day != current_day:
            session.warmup_current_day = current_day
            has_changed = True
        if session.warmup_daily_limit != daily_limit:
            session.warmup_daily_limit = daily_limit
            has_changed = True
        if is_graduated and not session.warmup_graduated_at:
            session.warmup_graduated_at = now
            has_changed = True

        if has_changed:
            await db.commit()
            await db.refresh(session)
            logger.info(
                f"[WarmupService] Session #{session.id} warm-up synced: "
                f"day={session.warmup_current_day}, limit={session.warmup_daily_limit}, graduated={bool(session.warmup_graduated_at)}"
            )

        return session

    @classmethod
    async def toggle_warmup(
        cls,
        session_id: int,
        enabled: bool,
        target_limit: Optional[int],
        db: AsyncSession,
    ) -> WhatsAppSession:
        """Bir hat için Isıtma Modunu açar veya kapatır."""
        stmt = select(WhatsAppSession).where(WhatsAppSession.id == session_id)
        session = (await db.execute(stmt)).scalar_one_or_none()
        if not session:
            raise LookupError(f"WhatsApp oturumu bulunamadı (id={session_id})")

        now = utc_now_naive()
        session.is_warmup_enabled = enabled
        if enabled:
            if not session.warmup_started_at:
                session.warmup_started_at = now
                session.warmup_current_day = 1
                session.warmup_daily_limit = 10
            if target_limit:
                session.warmup_target_limit = max(10, min(500, target_limit))
            # Senkronize et
            current_day, daily_limit, is_graduated = cls.compute_day_and_limit(
                started_at=session.warmup_started_at,
                target_limit=session.warmup_target_limit,
                now_dt=now,
            )
            session.warmup_current_day = current_day
            session.warmup_daily_limit = daily_limit
            if is_graduated and not session.warmup_graduated_at:
                session.warmup_graduated_at = now
        else:
            # Kapatıldığında da verileri koru ama pasif kıl
            pass

        session.updated_at = now
        await db.commit()
        await db.refresh(session)
        logger.info(f"[WarmupService] Session #{session_id} warm-up toggled: enabled={enabled}")
        return session

    @classmethod
    async def count_sent_today(cls, session: WhatsAppSession, db: AsyncSession) -> int:
        """Bu hat üzerinden bugün gönderilen mesaj sayısını hesaplar."""
        from backend.app.models.campaign import Campaign
        start_of_day = utc_now_naive().replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Eğer session'ın user_id'si varsa veya session'a bağlı kampanyalar varsa
        stmt = (
            select(func.count(MessageLog.id))
            .select_from(MessageLog)
            .outerjoin(Campaign, MessageLog.campaign_id == Campaign.id)
            .where(
                (Campaign.whatsapp_session_id == session.id) | (
                    (MessageLog.user_id == session.user_id) if session.user_id else (Campaign.whatsapp_session_id == session.id)
                ),
                MessageLog.status.in_([
                    MessageStatus.SENT,
                    MessageStatus.DELIVERED,
                    MessageStatus.READ,
                    MessageStatus.REPLIED,
                ]),
                MessageLog.sent_at >= start_of_day,
            )
        )
        sent_today = (await db.scalar(stmt)) or 0
        return sent_today

    @classmethod
    async def get_warmup_status(
        cls, session: WhatsAppSession, db: AsyncSession
    ) -> Dict[str, Any]:
        """Oturumun detaylı warm-up metriklerini döndürür."""
        await cls.sync_session_warmup(session, db)
        sent_today = await cls.count_sent_today(session, db)
        effective_limit = session.warmup_daily_limit if session.is_warmup_enabled else 50
        remaining_today = max(0, effective_limit - sent_today)

        is_graduated = bool(
            session.warmup_graduated_at
            or (session.warmup_current_day >= 6 and session.is_warmup_enabled)
        )

        return {
            "session_id": session.id,
            "session_name": session.session_name,
            "phone_number": session.phone_number,
            "is_warmup_enabled": session.is_warmup_enabled,
            "current_day": session.warmup_current_day,
            "daily_limit": session.warmup_daily_limit,
            "sent_today": sent_today,
            "remaining_today": remaining_today,
            "target_limit": session.warmup_target_limit,
            "is_graduated": is_graduated,
            "started_at": session.warmup_started_at,
            "graduated_at": session.warmup_graduated_at,
            "schedule": cls.get_schedule(),
        }
