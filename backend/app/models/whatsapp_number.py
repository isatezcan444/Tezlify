import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Enum, Index, Uuid, Text
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class WhatsAppNumberStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    DISCONNECTED = "DISCONNECTED"
    ERROR = "ERROR"


class WhatsAppNumberProvider(str, enum.Enum):
    META_CLOUD = "META_CLOUD"
    BAILEYS_QR = "BAILEYS_QR"


class WhatsAppNumber(Base):
    """
    Canonical entity representing any WhatsApp line (Meta Cloud API or Baileys QR).
    Supports multi-number and multi-tenant isolation.
    """
    __tablename__ = "whatsapp_numbers"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    provider = Column(
        Enum(WhatsAppNumberProvider),
        default=WhatsAppNumberProvider.META_CLOUD,
        server_default="META_CLOUD",
        nullable=False,
        index=True,
    )

    name = Column(String(100), nullable=False)  # Friendly label e.g. "Satış Hattı 1"
    display_phone_number = Column(String(50), nullable=True)  # e.g. "+90 850 123 45 67"
    phone_number_e164 = Column(String(50), nullable=True, index=True)  # Normalized e.g. "+908501234567"

    # Meta Graph API identifiers (Primary Integration Identity; NULL for BAILEYS_QR)
    phone_number_id = Column(String(100), unique=True, nullable=True, index=True)
    waba_id = Column(String(100), nullable=True, index=True)  # WhatsApp Business Account ID
    business_account_id = Column(String(100), nullable=True)

    # Secure credential reference (vault key, env var key, or encrypted ref - NEVER plaintext secret)
    credential_reference = Column(String(255), nullable=True)
    encrypted_access_token = Column(Text, nullable=True)

    # Status & Quality information from Meta / Gateway
    status = Column(
        Enum(WhatsAppNumberStatus),
        default=WhatsAppNumberStatus.ACTIVE,
        nullable=False,
        index=True,
    )
    quality_rating = Column(String(50), default="UNKNOWN", nullable=True)  # GREEN, YELLOW, RED, UNKNOWN
    verified_name = Column(String(150), nullable=True)  # Meta approved business certificate name
    last_verified_at = Column(DateTime, nullable=True)

    # Soft delete / disconnect audit
    deleted_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships - Explicitly NO cascade="all, delete-orphan" to conversations to preserve history!
    conversations = relationship("Conversation", back_populates="whatsapp_number")
    session = relationship("WhatsAppSession", back_populates="whatsapp_number", uselist=False, lazy="selectin")

    __table_args__ = (
        Index("idx_wanum_user_status", "user_id", "status"),
        Index("idx_wanum_user_phone_id", "user_id", "phone_number_id"),
        Index("idx_wanum_user_e164", "user_id", "phone_number_e164"),
        Index("idx_wanum_provider", "provider"),
    )

