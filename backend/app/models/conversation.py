import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Enum, ForeignKey, Index, Uuid, Text
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class ConversationStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    ARCHIVED = "ARCHIVED"
    CLOSED = "CLOSED"


class Conversation(Base):
    """
    Represents an ongoing conversational dialogue thread with a Lead across a channel (e.g. WhatsApp).
    One active conversation per lead per channel.
    """
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    lead_id = Column(Integer, ForeignKey("leads.id", ondelete="CASCADE"), nullable=False, index=True)
    channel = Column(String(30), default="WHATSAPP", nullable=False, index=True)
    status = Column(Enum(ConversationStatus), default=ConversationStatus.ACTIVE, nullable=False, index=True)
    
    last_message_at = Column(DateTime, nullable=True, index=True)
    last_message_preview = Column(Text, nullable=True)
    unread_count = Column(Integer, default=0, nullable=False)
    last_read_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    lead = relationship("Lead", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan", order_by="Message.created_at.asc()")

    __table_args__ = (
        Index("idx_conv_lead_channel_status", "lead_id", "channel", "status"),
    )
