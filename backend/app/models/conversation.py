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
    Represents an ongoing conversational dialogue thread across a channel (e.g. WhatsApp).
    Belongs to a specific WhatsAppNumber and Contact.
    Optionally links to a CRM Lead (lead_id is nullable, allowing non-CRM WhatsApp chats).
    """
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    # Multi-number routing: Which WhatsApp Business line owns this thread
    whatsapp_number_id = Column(
        Integer, ForeignKey("whatsapp_numbers.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Contact identity
    contact_id = Column(
        Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # CRM Lead association: OPTIONAL (Nullable!)
    lead_id = Column(
        Integer, ForeignKey("leads.id", ondelete="SET NULL"), nullable=True, index=True
    )

    channel = Column(String(30), default="WHATSAPP", nullable=False, index=True)
    status = Column(
        Enum(ConversationStatus), default=ConversationStatus.ACTIVE, nullable=False, index=True
    )

    last_message_at = Column(DateTime, nullable=True, index=True)
    last_customer_message_at = Column(DateTime, nullable=True, index=True)
    customer_service_window_expires_at = Column(DateTime, nullable=True, index=True)

    last_message_preview = Column(Text, nullable=True)
    unread_count = Column(Integer, default=0, nullable=False)
    last_read_at = Column(DateTime, nullable=True)
    archived_at = Column(DateTime, nullable=True)
    closed_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    lead = relationship("Lead", back_populates="conversations")
    whatsapp_number = relationship("WhatsAppNumber", back_populates="conversations")
    contact = relationship("Contact", back_populates="conversations")
    messages = relationship(
        "Message",
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at.asc()",
    )

    __table_args__ = (
        Index("idx_conv_user_number", "user_id", "whatsapp_number_id"),
        Index("idx_conv_user_contact", "user_id", "contact_id"),
        Index("idx_conv_number_contact", "whatsapp_number_id", "contact_id"),
        Index("idx_conv_lead_channel_status", "lead_id", "channel", "status"),
        Index("idx_conv_last_msg_at", "last_message_at"),
        Index("idx_conv_cust_window", "customer_service_window_expires_at"),
    )
