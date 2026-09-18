"""API şemaları: WhatsApp gateway entegrasyonu (Aşama 2).

Kontratlar; whatsapp-gateway REST yanıtları ile frontend
`frontend/src/types/index.ts` WhatsApp tipleriyle uyumlu tutulur.
"""
from typing import Dict, List, Optional, Any
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


class WhatsAppPairingStartRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)


class WhatsAppPairingStartResponse(BaseModel):
    pair_token: str
    gateway_id: str
    session_name: str
    status: str
    qr_code: Optional[str] = None


class WhatsAppPairingQrResponse(BaseModel):
    status: str
    qr_code: Optional[str] = None
    phone: Optional[str] = None
    session_id: Optional[int] = None
    error_message: Optional[str] = None


class WhatsAppAvatarRefreshResponse(BaseModel):
    success: bool
    phone: str
    avatar_url: Optional[str] = None
    error: Optional[str] = None


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
    # A contact may have one conversation per connected WhatsApp line.
    session_id: Optional[int] = None
    contact_id: Optional[int] = None
    lead_id: Optional[int] = None
    name: Optional[str] = None
    phone: Optional[str] = None
    is_group: bool = False
    # Sorun 4: WhatsApp arsiv durumu (gateway Baileys metadata'sindan kalici).
    is_archived: bool = False
    avatar_url: Optional[str] = None
    last_message_preview: Optional[str] = None
    last_message_at: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    # Faz 10 (P2): UI "mesaj yok" bilgisini yalnizca message_count==0 ve
    # last_message_state=="NO_MESSAGES" iken gosterir.
    message_count: int = 0
    last_message_state: Optional[str] = None
    unread_count: int = 0
    status: str = "ACTIVE"
    identity_state: Optional[str] = None


class WhatsAppConversationListResponse(BaseModel):
    items: List[WhatsAppConversationItem] = Field(default_factory=list)
    total: int = 0
    has_more: bool = False
    next_offset: Optional[int] = None



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


class WhatsAppHistoryEvidence(BaseModel):
    state: str = "NOT_CHECKED"
    provider_checked: bool = False
    provider_exhausted: bool = False
    provider_msgs_returned: int = 0


class WhatsAppMessagesResponse(BaseModel):
    messages: List[WhatsAppMessageItem] = Field(default_factory=list)
    has_more: bool = False
    oldest_message_id: Optional[Any] = None
    newest_message_id: Optional[Any] = None
    history_evidence: Optional[WhatsAppHistoryEvidence] = None


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


class WhatsAppConversationStatusRequest(BaseModel):
    """Kullanicinin acik sohbet aksiyonu (ACTIVE / ARCHIVED / CLOSED).

    WhatsApp arsiv durumu (gateway metadata'sindan senkronlanan `is_archived`)
    ile karistirilmamalidir.
    """

    status: str = Field(..., description="ACTIVE | ARCHIVED | CLOSED")


class WhatsAppConversationStatusResult(BaseModel):
    id: int
    status: str


class WhatsAppSendResult(BaseModel):
    id: Optional[Any] = None
    wa_message_id: Optional[str] = None
    client_message_id: Optional[str] = None
    status: str = "SENT"
    body: Optional[str] = None


class WhatsAppReadResult(BaseModel):
    success: bool = True
    # Faz 13 (truthfulness): gateway'e ILETILEMEDIYSE neden'i tasinir. Alan
    # opsiyoneldir; `success=False` iken UI kullaniciya gercek nedeni
    # gosterebilir — sessiz yutma yok.
    error: Optional[str] = None


class WhatsAppStatusResult(BaseModel):
    success: bool = True
    message: Optional[str] = None
    status: Optional[str] = None
    error: Optional[str] = None


class WhatsAppSyncSessionStatus(BaseModel):
    id: int
    session_name: Optional[str] = None
    status: Optional[str] = None
    # Faz 7: gateway belleğindeki GERÇEK initial-sync durumu (sahte değil).
    sync: Dict[str, Any] = Field(default_factory=dict)


class WhatsAppSyncStatusResponse(BaseModel):
    """Oturum bazli gercek senkron durumu.

    Faz 13 (truthfulness): gateway'e ulasilamazsa `gateway_available=False`
    ve her oturumun `sync.phase`'i `unavailable` olur. Istemci bunu "senkron
    yok" (idle) ile karistirmamalidir — hata artik maskelenmiyor.
    """

    sessions: List[WhatsAppSyncSessionStatus] = Field(default_factory=list)
    gateway_available: bool = True
    gateway_error: Optional[str] = None


class WhatsAppSyncJobResponse(BaseModel):
    """Arka plan initial-sync job'ının GERÇEK durumu (§16/§28).

    state: IDLE | SYNCING | COMPLETED | FAILED — sahte tamamlanma üretilmez.
    sync_id: job bazlı kimlik; frontend eski sync_id'li olayları yok sayar.
    """

    sync_id: Optional[str] = None
    state: str = "IDLE"
    stage: str = "idle"
    error: Optional[str] = None
    chats_total: int = 0
    chats_synced: int = 0
    contacts_synced: int = 0
    messages_total: int = 0
    messages_synced: int = 0
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    # Faz 6 (P0.1): faz bazinda gecen sure (sn, gercek olcum — time.monotonic
    # delta). Benchmark/raporlama icin; UI icin zorunlu degil.
    stage_timings: Dict[str, float] = Field(default_factory=dict)
