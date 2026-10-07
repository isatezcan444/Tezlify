from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Index, Uuid, JSON, UniqueConstraint
from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class QuickReply(Base):
    """
    Kullanıcıya özel WhatsApp hazır cevaplar ve satış şablonları.
    Kısayollar kullanıcı bazında tekildir (örn: /fiyat, /katalog).
    """
    __tablename__ = "whatsapp_quick_replies"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    shortcut = Column(String(50), nullable=False)
    title = Column(String(100), nullable=False)
    content = Column(Text, nullable=False)
    category = Column(String(50), nullable=True, default="Genel")
    variables = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
    updated_at = Column(DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False)

    __table_args__ = (
        Index("idx_qr_user_id", "user_id"),
        Index("idx_qr_user_shortcut", "user_id", "shortcut"),
        Index("idx_qr_user_category", "user_id", "category"),
        UniqueConstraint("user_id", "shortcut", name="uq_quick_reply_user_shortcut"),
    )
