import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Enum, Boolean, Text, Index, Uuid
from backend.app.core.database import Base


class SessionStatus(str, enum.Enum):
    SCAN_QR = "SCAN_QR"
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    DISCONNECTED = "DISCONNECTED"
    BANNED = "BANNED"


class WhatsAppSession(Base):
    """Baileys WhatsApp gateway oturumunun backend kaydı.

    `gateway_id` gateway servisindeki (whatsapp-gateway) oturum UUID'sidir.
    Bu tablo, önceki temizlikte purged edilen eski whatsapp_sessions
    şemasından tamamen farklı (yeniden tanımlı) bir şemadır.
    """

    __tablename__ = "whatsapp_sessions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    # Gateway'deki oturumun UUID'si (WhatsAppGateway servis çağrılarında kullanılır)
    gateway_id = Column(String(50), unique=True, index=True, nullable=False)

    session_name = Column(String(150), nullable=False)
    status = Column(Enum(SessionStatus), default=SessionStatus.SCAN_QR, nullable=False, index=True)
    phone_number = Column(String(50), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    is_phone_online = Column(Boolean, default=False, nullable=False)
    battery_level = Column(Integer, nullable=True)
    qr_code = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("ix_ws_session_user_status", "user_id", "status"),
    )