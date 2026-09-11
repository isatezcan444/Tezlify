"""API şemaları: WhatsApp gateway entegrasyonu (Aşama 2).

Kontratlar; whatsapp-gateway REST yanıtları ile frontend
`frontend/src/types/index.ts` WhatsApp tipleriyle uyumlu tutulur.
"""
from typing import List, Optional, Any
from datetime import datetime

from pydantic import BaseModel, Field


class WhatsAppSessionCreate(BaseModel):
    name: str = Field(default="WhatsApp Hatti", max_length=150)


class WhatsAppSessionResponse(BaseModel):
    id: int
    session_name: str
    status: str
    phone_number: Optional[str] = None
    is_active: bool = True
    is_phone_online: bool = False
    battery_level: Optional[int] = None
    qr_code: Optional[str] = None
    error_message: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class WhatsAppSessionListResponse(BaseModel):
    sessions: List[WhatsAppSessionResponse] = Field(default_factory=list)


class WhatsAppQrResponse(BaseModel):
    status: str
    qr_code: Optional[str] = None
    phone: Optional[str] = None
    error_message: Optional[str] = None


class WhatsAppPairingCodeRequest(BaseModel):
    phone: str = Field(min_length=7, max_length=24, description="Ülke kodu dahil telefon (örn. +90 5XX XXX XX XX)")


class WhatsAppPairingCodeResponse(BaseModel):
    success: bool = True
    pairing_code: Optional[str] = None
    phone: Optional[str] = None
    error_message: Optional[str] = None


class WhatsAppContact(BaseModel):
    id: str
    phone: Optional[str] = None
    name: Optional[str] = None
    avatar_url: Optional[str] = None


class WhatsAppContactListResponse(BaseModel):
    contacts: List[WhatsAppContact] = Field(default_factory=list)


class WhatsAppConversationItem(BaseModel):
    id: int
    contact_id: Optional[int] = None
    lead_id: Optional[int] = None
    name: Optional[str] = None
    phone: Optional[str] = None
    is_group: bool = False
    avatar_url: Optional[str] = None
    last_message_preview: Optional[str] = None
    last_message_at: Optional[str] = None
    unread_count: int = 0
    status: str = "ACTIVE"


class WhatsAppConversationListResponse(BaseModel):
    items: List[WhatsAppConversationItem] = Field(default_factory=list)
    total: int = 0


class WhatsAppMessageItem(BaseModel):
    id: Optional[Any] = None
    conversation_id: Any = None
    direction: str = "INBOUND"
    message_type: str = "TEXT"
    status: str = "RECEIVED"
    body: Optional[str] = None
    media_id: Optional[str] = None
    media_mime_type: Optional[str] = None
    media_filename: Optional[str] = None
    media_caption: Optional[str] = None
    media_url: Optional[str] = None
    wa_message_id: Optional[str] = None
    client_message_id: Optional[str] = None
    sender_phone: Optional[str] = None
    sender_name: Optional[str] = None
    recipient_phone: Optional[str] = None
    error_message: Optional[str] = None
    created_at: Optional[str] = None


class WhatsAppMessagesResponse(BaseModel):
    messages: List[WhatsAppMessageItem] = Field(default_factory=list)
    has_more: bool = False
    oldest_message_id: Optional[Any] = None
    newest_message_id: Optional[Any] = None


class WhatsAppSendTextRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)
    client_message_id: Optional[str] = None


class WhatsAppSendMediaRequest(BaseModel):
    media_type: str = Field(..., description="image|document|audio|video")
    media_url: Optional[str] = Field(None, description="authFetch uyumlu, kimlik doğrulamalı medya URL'si veya gateway URL")
    media_base64: Optional[str] = Field(None, description="Dosya yuklemesi icin base64 icerik (media_url ile en az biri)")
    mime_type: Optional[str] = Field(None, description="base64 yuklemede MIME tipi")
    caption: Optional[str] = None
    filename: Optional[str] = None
    client_message_id: Optional[str] = None


class WhatsAppTypingRequest(BaseModel):
    typing: bool = Field(default=True, description="True='yazıyor', False='duraklat'")


class WhatsAppSendResult(BaseModel):
    id: Optional[Any] = None
    wa_message_id: Optional[str] = None
    client_message_id: Optional[str] = None
    status: str = "SENT"
    body: Optional[str] = None


class WhatsAppReadResult(BaseModel):
    success: bool = True


class WhatsAppStatusResult(BaseModel):
    success: bool = True
    message: Optional[str] = None
    status: Optional[str] = None