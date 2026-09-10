import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Text, Enum, ForeignKey, Index, Uuid
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class MessageDirection(str, enum.Enum):
    INBOUND = "INBOUND"
    OUTBOUND = "OUTBOUND"


class MessageType(str, enum.Enum):
    TEXT = "TEXT"
    IMAGE = "IMAGE"
    DOCUMENT = "DOCUMENT"
    AUDIO = "AUDIO"
    VIDEO = "VIDEO"
    STICKER = "STICKER"
    LOCATION = "LOCATION"
    CONTACT = "CONTACT"
    TEMPLATE = "TEMPLATE"
    UNKNOWN = "UNKNOWN"
    OTHER = "OTHER"


class ConversationMessageStatus(str, enum.Enum):
    PENDING = "PENDING"
    SENT = "SENT"
    DELIVERED = "DELIVERED"
    READ = "READ"
    FAILED = "FAILED"
    RECEIVED = "RECEIVED"


class Message(Base):
    """
    Represents an individual message exchanged within a Conversation.
    Enforces idempotency via a unique client_message_id.
    """
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)

    direction = Column(Enum(MessageDirection), nullable=False, index=True)
    message_type = Column(Enum(MessageType), default=MessageType.TEXT, nullable=False)
    body = Column(Text, nullable=True)

    # Outbound Client Request Idempotency Key (UUID from Frontend)
    client_message_id = Column(String(100), unique=True, index=True, nullable=True)

    # Media metadata (for IMAGE, DOCUMENT, AUDIO, VIDEO, STICKER)
    media_id = Column(String(255), nullable=True, index=True)
    media_mime_type = Column(String(100), nullable=True)
    media_filename = Column(String(255), nullable=True)
    media_caption = Column(Text, nullable=True)

    sender_phone = Column(String(50), nullable=False, index=True)
    recipient_phone = Column(String(50), nullable=False, index=True)
    sender_name = Column(String(100), nullable=True)

    status = Column(
        Enum(ConversationMessageStatus),
        default=ConversationMessageStatus.RECEIVED,
        nullable=False,
        index=True,
    )
    error_code = Column(Integer, nullable=True)
    error_message = Column(Text, nullable=True)

    # Granular message delivery lifecycle timestamps
    sent_at = Column(DateTime, nullable=True)
    delivered_at = Column(DateTime, nullable=True)
    read_at = Column(DateTime, nullable=True)
    failed_at = Column(DateTime, nullable=True)

    external_timestamp = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    conversation = relationship("Conversation", back_populates="messages")

    __table_args__ = (
        Index("idx_msg_conv_created", "conversation_id", "created_at"),
        Index("idx_msg_conv_id", "conversation_id", "id"),
        Index("idx_msg_client_id", "client_message_id"),
    )
