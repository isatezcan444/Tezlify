import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Enum, Text, Uuid
from backend.app.core.database import Base

class SessionStatus(str, enum.Enum):
    DISCONNECTED = "DISCONNECTED"
    SCAN_QR = "SCAN_QR"
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    BANNED = "BANNED"

class WhatsAppSession(Base):
    __tablename__ = "whatsapp_sessions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    session_name = Column(String(100), unique=True, nullable=False, index=True) # e.g. "Hat-1-Satis"
    phone_number = Column(String(50), nullable=True) # Connected WhatsApp Phone Number
    
    # Status & Auth
    status = Column(Enum(SessionStatus), default=SessionStatus.DISCONNECTED, index=True)
    qr_code = Column(Text, nullable=True) # Base64 or QR string to display in UI
    is_active = Column(Boolean, default=True)
    
    # Warm-up Protocol & Rate Limiting
    warm_up_day = Column(Integer, default=1) # Increases daily
    daily_sent_count = Column(Integer, default=0)
    max_daily_limit = Column(Integer, default=50) # Auto-adjusted based on warm-up
    last_sent_at = Column(DateTime, nullable=True)
    last_reset_date = Column(DateTime, default=datetime.utcnow) # For resetting daily count
    
    # Session metadata & health
    battery_level = Column(Integer, nullable=True)
    is_phone_online = Column(Boolean, default=True)
    error_message = Column(Text, nullable=True)
    
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
