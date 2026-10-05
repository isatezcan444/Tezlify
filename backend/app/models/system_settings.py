from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime
from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class SystemSetting(Base):
    """Global sistem ve Anti-Ban yapılandırma parametreleri tablosu."""

    __tablename__ = "system_settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(100), unique=True, nullable=False, index=True)
    
    # Anti-ban structured fields (for 'antiban_config' key)
    preset = Column(String(50), default="standard_balanced")
    min_delay_seconds = Column(Integer, default=45)
    max_delay_seconds = Column(Integer, default=120)
    typing_delay_seconds = Column(Integer, default=4)
    daily_message_limit = Column(Integer, default=50)
    working_hours_enabled = Column(Boolean, default=True)
    working_hours_start = Column(String(10), default="09:00")
    working_hours_end = Column(String(10), default="18:30")
    
    updated_at = Column(DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False)
