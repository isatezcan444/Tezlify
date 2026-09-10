import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Enum, Index, Uuid, Text
from backend.app.core.database import Base


class WebhookEventStatus(str, enum.Enum):
    RECEIVED = "RECEIVED"
    PROCESSING = "PROCESSING"
    PROCESSED = "PROCESSED"
    DUPLICATE = "DUPLICATE"
    FAILED = "FAILED"
    PENDING = "PENDING"


class WebhookEvent(Base):
    """
    Audit log and idempotency barrier for raw incoming Meta Cloud webhooks.
    Guarantees deterministic de-duplication before mutating domain state.
    """
    __tablename__ = "webhook_events"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    provider = Column(String(50), default="meta_cloud", nullable=False, index=True)
    event_type = Column(String(50), nullable=False, index=True)  # e.g. "messages", "statuses"

    # Deterministic SHA-256 hash of (phone_number_id + wamid + timestamp) or raw message event
    event_hash = Column(String(64), unique=True, nullable=False, index=True)
    external_message_id = Column(String(150), nullable=True, index=True)

    status = Column(
        Enum(WebhookEventStatus),
        default=WebhookEventStatus.RECEIVED,
        nullable=False,
        index=True,
    )
    failure_reason = Column(Text, nullable=True)
    payload_json = Column(Text, nullable=True)  # Sanitized raw payload (zero secrets)

    received_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    processed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("idx_webhook_event_hash", "event_hash"),
        Index("idx_webhook_ext_msg_id", "external_message_id"),
        Index("idx_webhook_status_received", "status", "received_at"),
    )
