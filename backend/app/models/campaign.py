import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, Enum, ForeignKey, Uuid
from sqlalchemy.orm import relationship

from backend.app.core.config import settings
from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive

class CampaignStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"
    ARCHIVED = "ARCHIVED"

class Campaign(Base):
    __tablename__ = "campaigns"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    
    # Message Template with Spintax
    # e.g.: "{Merhaba|Selamlar} {name} Yetkilisi, {city} lokasyonundaki {category} hizmetinizi gördüm..."
    message_template = Column(Text, nullable=False)
    
    # Campaign Controls & Anti-Ban Config
    status = Column(Enum(CampaignStatus), default=CampaignStatus.DRAFT, index=True)
    min_delay_seconds = Column(Integer, default=settings.DEFAULT_MIN_DELAY_SECONDS)  # Random delay lower bound
    max_delay_seconds = Column(Integer, default=settings.DEFAULT_MAX_DELAY_SECONDS)  # Random delay upper bound
    typing_delay_seconds = Column(Integer, default=settings.DEFAULT_TYPING_DELAY_SECONDS)  # Typing simulation

    # Working Hours & Anti-Ban Gate
    working_hours_enabled = Column(Boolean, default=True)
    working_hours_start = Column(String(10), default=settings.DEFAULT_WORKING_HOURS_START)  # HH:MM
    working_hours_end = Column(String(10), default=settings.DEFAULT_WORKING_HOURS_END)  # HH:MM
    daily_message_limit = Column(Integer, default=settings.DEFAULT_DAILY_LIMIT_PER_SESSION)
    
    # WhatsApp Session Binding (Optional explicit multi-session line)
    whatsapp_session_id = Column(Integer, ForeignKey("whatsapp_sessions.id", ondelete="SET NULL"), nullable=True, index=True)
    whatsapp_session = relationship("WhatsAppSession", foreign_keys=[whatsapp_session_id])

    # Campaign Group Association (Optional)
    group_id = Column(Integer, ForeignKey("campaign_groups.id", ondelete="SET NULL"), nullable=True)
    group = relationship("CampaignGroup", backref="campaigns")
    
    # Counters
    total_leads_target = Column(Integer, default=0)
    sent_count = Column(Integer, default=0)
    delivered_count = Column(Integer, default=0)
    replied_count = Column(Integer, default=0)
    failed_count = Column(Integer, default=0)
    
    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
    updated_at = Column(DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False)
