import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Enum, ForeignKey, Uuid, Index
from sqlalchemy.orm import relationship

from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class SequenceLeadStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"                       # In progress, waiting for next step
    COMPLETED = "COMPLETED"                 # All steps sent successfully
    STOPPED_ON_REPLY = "STOPPED_ON_REPLY"   # Inbound message received; automatically stopped
    STOPPED_MANUAL = "STOPPED_MANUAL"       # Stopped manually by user
    OPT_OUT = "OPT_OUT"                     # Blacklisted or unsubscribed
    FAILED = "FAILED"                       # Message delivery failed


class CampaignSequenceLead(Base):
    """
    Tracks the execution state of each lead participating in a multi-step sequence campaign.
    Supports step advancement, scheduled dispatch times, and automatic fail-closed stop on reply.
    """
    __tablename__ = "campaign_sequence_leads"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False, index=True)
    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="CASCADE"), nullable=False, index=True)
    whatsapp_session_id = Column(Integer, ForeignKey("whatsapp_sessions.id", ondelete="SET NULL"), nullable=True, index=True)

    current_step = Column(Integer, default=1, nullable=False)
    total_steps = Column(Integer, default=1, nullable=False)

    status = Column(Enum(SequenceLeadStatus), default=SequenceLeadStatus.ACTIVE, nullable=False, index=True)

    next_step_at = Column(DateTime, nullable=True, index=True)
    last_step_sent_at = Column(DateTime, nullable=True)

    stopped_at = Column(DateTime, nullable=True)
    stop_reason = Column(String(100), nullable=True)  # 'REPLIED', 'OPT_OUT', 'COMPLETED', 'MANUAL', 'FAILED'

    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
    updated_at = Column(DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False)

    # Relationships
    campaign = relationship("Campaign", backref="sequence_leads")
    lead = relationship("Lead", backref="sequence_campaigns")
    whatsapp_session = relationship("WhatsAppSession")

    __table_args__ = (
        Index("idx_csl_active_next", "status", "next_step_at"),
        Index("idx_csl_camp_lead", "campaign_id", "lead_id", unique=True),
    )
