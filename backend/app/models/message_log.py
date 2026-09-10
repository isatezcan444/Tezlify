import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Text, Enum, ForeignKey, Index, Uuid
from sqlalchemy.orm import relationship
from backend.app.core.database import Base

class MessageStatus(str, enum.Enum):
    PENDING = "PENDING"
    QUEUED = "QUEUED"
    SENDING = "SENDING"
    SENT = "SENT"
    DELIVERED = "DELIVERED"
    READ = "READ"
    REPLIED = "REPLIED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"

class MessageLog(Base):
    __tablename__ = "message_logs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    
    # Foreign Keys
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="CASCADE"), nullable=False, index=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id", ondelete="SET NULL"), nullable=True, index=True)
    
    # Relationships
    lead = relationship("Lead", backref="message_logs")
    campaign = relationship("Campaign", backref="message_logs")
    
    # Message Content (Actual evaluated spintax sent)
    target_phone = Column(String(50), nullable=False, index=True)
    rendered_message = Column(Text, nullable=False)
    
    # Status & Progress
    status = Column(Enum(MessageStatus), default=MessageStatus.PENDING, index=True)
    
    # Error & Scheduling
    scheduled_for = Column(DateTime, nullable=True, index=True)
    sent_at = Column(DateTime, nullable=True)
    error_reason = Column(Text, nullable=True)
    delay_applied_seconds = Column(Integer, nullable=True)
    
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("idx_msg_status_sched", "status", "scheduled_for"),
    )
