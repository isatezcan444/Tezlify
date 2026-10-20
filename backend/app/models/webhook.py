import secrets
from datetime import datetime
from sqlalchemy import (
    Column,
    Integer,
    String,
    Boolean,
    DateTime,
    Text,
    JSON,
    ForeignKey,
    Index,
    Uuid,
)
from sqlalchemy.orm import relationship
from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class WebhookSubscription(Base):
    """
    Kullanıcının dış sistemlere (Zapier, Make, n8n, Slack vb.) olay aktarmak için tanımladığı Webhook aboneliği.
    Olaylar tetiklendiğinde HMAC-SHA256 ile imzalanarak hedef URL'e HTTP POST edilir.
    """
    __tablename__ = "webhook_subscriptions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=False, index=True)

    name = Column(String(100), nullable=False)
    target_url = Column(String(1024), nullable=False)
    secret = Column(String(64), nullable=False)  # HMAC imza anahtarı

    # Abone olunan olay tipleri (örn: ["lead.created", "lead.status_updated", "whatsapp.message_received", "campaign.completed"])
    events = Column(JSON, nullable=False, default=list)

    is_active = Column(Boolean, default=True, nullable=False, index=True)

    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
    updated_at = Column(DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False)

    delivery_logs = relationship(
        "WebhookDeliveryLog",
        back_populates="subscription",
        cascade="all, delete-orphan",
        order_by="WebhookDeliveryLog.created_at.desc()",
    )

    __table_args__ = (
        Index("idx_webhook_subs_user_id", "user_id"),
        Index("idx_webhook_subs_user_active", "user_id", "is_active"),
    )

    @staticmethod
    def generate_secret() -> str:
        return secrets.token_hex(32)


class WebhookDeliveryLog(Base):
    """
    Webhook gönderim teşebbüslerinin durum ve yanıt kayıtları.
    Hata tespiti ve entegrasyon hata ayıklama için UI'da sunulur.
    """
    __tablename__ = "webhook_delivery_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    subscription_id = Column(
        Integer, ForeignKey("webhook_subscriptions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id = Column(Uuid(as_uuid=False), nullable=False, index=True)

    event_type = Column(String(64), nullable=False, index=True)
    payload = Column(JSON, nullable=True)

    status_code = Column(Integer, nullable=True)
    response_body = Column(Text, nullable=True)
    duration_ms = Column(Integer, nullable=True)

    is_success = Column(Boolean, default=False, nullable=False, index=True)
    error_message = Column(Text, nullable=True)

    created_at = Column(DateTime, default=utc_now_naive, nullable=False, index=True)

    subscription = relationship("WebhookSubscription", back_populates="delivery_logs")

    __table_args__ = (
        Index("idx_webhook_logs_sub_created", "subscription_id", "created_at"),
        Index("idx_webhook_logs_user_created", "user_id", "created_at"),
    )
