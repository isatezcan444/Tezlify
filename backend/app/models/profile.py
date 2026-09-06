from datetime import datetime
from sqlalchemy import Column, String, Integer, DateTime
from backend.app.core.database import Base


class Profile(Base):
    __tablename__ = "profiles"

    id = Column(String(36), primary_key=True, index=True)
    email = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=True)
    avatar_url = Column(String(500), nullable=True)
    plan_tier = Column(String(50), default="STARTER")
    leads_monthly_limit = Column(Integer, default=50)
    leads_used_this_month = Column(Integer, default=0)
    messages_daily_limit = Column(Integer, default=20)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
