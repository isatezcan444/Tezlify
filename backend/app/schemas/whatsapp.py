from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, ConfigDict
from backend.app.models.whatsapp_session import SessionStatus
from backend.app.models.message_log import MessageStatus

class WhatsAppSessionBase(BaseModel):
    session_name: str
    phone_number: Optional[str] = None
    whatsapp_number_id: Optional[int] = None
    max_daily_limit: int = 50

class WhatsAppSessionCreate(WhatsAppSessionBase):
    pass

class WhatsAppSessionResponse(WhatsAppSessionBase):
    id: int
    status: SessionStatus
    qr_code: Optional[str] = None
    is_active: bool
    warm_up_day: int
    daily_sent_count: int
    is_phone_online: bool
    battery_level: Optional[int] = None
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

class TestMessageRequest(BaseModel):
    phone_e164: str
    message: str
    session_id: Optional[int] = None

class MessageLogResponse(BaseModel):
    id: int
    lead_id: int
    campaign_id: Optional[int] = None
    session_id: Optional[int] = None
    target_phone: str
    rendered_message: str
    status: MessageStatus
    wa_message_id: Optional[str] = None
    reply_received: bool
    reply_text: Optional[str] = None
    delay_applied_seconds: Optional[int] = None
    sent_at: Optional[datetime] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
