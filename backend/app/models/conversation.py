import enum
from datetime import datetime
from sqlalchemy import Boolean, Column, Integer, String, DateTime, Enum, ForeignKey, Index, Uuid, Text
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class ConversationStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    ARCHIVED = "ARCHIVED"
    CLOSED = "CLOSED"


class Conversation(Base):
    """
    Represents an ongoing conversational dialogue thread across a channel.
    Optionally links to a CRM Lead (lead_id is nullable, allowing non-CRM chats).
    """
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    # Contact identity
    contact_id = Column(
        Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # CRM Lead association: OPTIONAL (Nullable!)
    lead_id = Column(
        Integer, ForeignKey("leads.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Sohbetin geldiği WhatsApp hattı (gateway oturumu). Güvenlik/yönlendirme
    # düzeltmesi: gateway artık oturum kapsamlı çalışıyor, dolayısıyla bir
    # sohbete mesaj gönderirken HANGİ hattın kullanılacağı tahmin edilemez —
    # sohbetin kendi hattı kullanılır. Ayrıca bir hattı silmek yalnızca O
    # hattın sohbetlerini temizler (önceden kullanıcının tüm WhatsApp verisi
    # siliniyordu). Eski satırlar için nullable.
    session_id = Column(
        Integer, ForeignKey("whatsapp_sessions.id", ondelete="SET NULL"), nullable=True, index=True
    )

    channel = Column(String(30), default="WHATSAPP", nullable=False, index=True)
    status = Column(
        Enum(ConversationStatus), default=ConversationStatus.ACTIVE, nullable=False, index=True
    )

    last_message_at = Column(DateTime, nullable=True, index=True)
    last_message_preview = Column(Text, nullable=True)
    unread_count = Column(Integer, default=0, nullable=False)
    last_read_at = Column(DateTime, nullable=True)
    archived_at = Column(DateTime, nullable=True)
    closed_at = Column(DateTime, nullable=True)

    # Sorun 4 (Grup/Arsiv ayrimi): kalici sütunlar — gateway'deki Baileys
    # sohbet metadata'sindan (JID @g.us / chat.archived) senkronla yazilir.
    # `is_group` eskiden her istekte JID'den turetiliyordu; `is_archived`
    # hic yoktu (CRM `status=ARCHIVED` kullanici aksiyonu, WhatsApp arsiv
    # durumundan farkli bir kavramdir).
    is_group = Column(Boolean, default=False, nullable=False, index=True)
    is_archived = Column(Boolean, default=False, nullable=False, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    lead = relationship("Lead", back_populates="conversations")
    contact = relationship("Contact", back_populates="conversations")
    messages = relationship(
        "Message",
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at.asc()",
    )

    __table_args__ = (
        Index("idx_conv_user_contact", "user_id", "contact_id"),
        Index("idx_conv_lead_channel_status", "lead_id", "channel", "status"),
        Index("idx_conv_last_msg_at", "last_message_at"),
        Index("idx_conv_user_group_archived", "user_id", "is_group", "is_archived"),
    )
