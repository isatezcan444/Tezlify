import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Text, Enum, ForeignKey, Index, Uuid
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class OutboxMessageStatus(str, enum.Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    RETRYABLE = "RETRYABLE"
    AMBIGUOUS_PROVIDER_RESULT = "AMBIGUOUS_PROVIDER_RESULT"


class OutboxMessage(Base):
    """
    Durable transactional outbox table for outbound WhatsApp messages.
    Guarantees at-least-once durable dispatch with lease-based locking,
    exponential backoff retries, and strict token non-disclosure.
    """
    __tablename__ = "outbox_messages"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    message_id = Column(
        Integer,
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    whatsapp_number_id = Column(
        Integer,
        ForeignKey("whatsapp_numbers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    event_type = Column(String(50), default="SEND_MESSAGE", nullable=False)
    payload_json = Column(Text, nullable=True)  # Non-sensitive message params (e.g. template parameters). NEVER SECRETS.

    status = Column(
        Enum(OutboxMessageStatus),
        default=OutboxMessageStatus.PENDING,
        nullable=False,
        index=True,
    )

    attempt_count = Column(Integer, default=0, nullable=False)
    max_attempts = Column(Integer, default=3, nullable=False)

    available_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    locked_at = Column(DateTime, nullable=True, index=True)
    locked_by = Column(String(100), nullable=True)  # Worker instance identifier

    last_error = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    processed_at = Column(DateTime, nullable=True)

    # Relationships
    message = relationship("Message")
    whatsapp_number = relationship("WhatsAppNumber")

    __table_args__ = (
        Index("idx_outbox_status_available", "status", "available_at"),
        Index("idx_outbox_user_status", "user_id", "status"),
        Index("idx_outbox_locked", "locked_at", "locked_by"),
    )
