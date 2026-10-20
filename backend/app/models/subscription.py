from datetime import datetime, timezone, timedelta
from typing import Optional
from sqlalchemy import Column, Integer, String, Boolean, DateTime
from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class UserSubscription(Base):
    """Kullanıcı SaaS abonelik ve dinamik kullanım kotaları tablosu."""
    __tablename__ = "user_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String(64), unique=True, nullable=False, index=True)
    plan_tier = Column(String(32), default="STARTER", nullable=False)
    billing_cycle = Column(String(16), default="monthly", nullable=False)

    period_start = Column(DateTime, default=utc_now_naive, nullable=False)
    period_end = Column(DateTime, nullable=False)

    leads_scraped_current_period = Column(Integer, default=0, nullable=False)
    whatsapp_sent_today = Column(Integer, default=0, nullable=False)
    ai_generations_today = Column(Integer, default=0, nullable=False)

    last_daily_reset = Column(DateTime, default=utc_now_naive, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)

    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
    updated_at = Column(DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False)

    def __repr__(self) -> str:
        return f"<UserSubscription(user_id='{self.user_id}', tier='{self.plan_tier}', leads={self.leads_scraped_current_period})>"
