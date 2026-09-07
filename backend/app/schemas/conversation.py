from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, ConfigDict
from backend.app.models.conversation import ConversationStatus
from backend.app.models.message import MessageDirection, MessageType, ConversationMessageStatus


class MessageBase(BaseModel):
    direction: MessageDirection
    message_type: MessageType = MessageType.TEXT
    body: Optional[str] = None
    sender_phone: str
    recipient_phone: str
    sender_name: Optional[str] = None
    status: ConversationMessageStatus = ConversationMessageStatus.RECEIVED
    wa_message_id: Optional[str] = None
    media_id: Optional[str] = None
    media_mime_type: Optional[str] = None
    media_filename: Optional[str] = None
    media_caption: Optional[str] = None
    error_code: Optional[int] = None
    error_message: Optional[str] = None
    external_timestamp: Optional[datetime] = None


class MessageCreate(MessageBase):
    conversation_id: int


class MessageResponse(MessageBase):
    id: int
    conversation_id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ConversationBase(BaseModel):
    lead_id: int
    channel: str = "WHATSAPP"
    status: ConversationStatus = ConversationStatus.ACTIVE


class ConversationStatusUpdateRequest(BaseModel):
    status: ConversationStatus


class MessageSendRequest(BaseModel):
    body: str
    type: str = "text"


class TemplateSendRequest(BaseModel):
    template_key: str
    variables: dict[str, str] = {}


class TemplateDefinitionResponse(BaseModel):
    key: str
    name: str
    name_en: Optional[str] = None
    description: Optional[str] = None
    category: str = "UTILITY"
    body_pattern: str
    variables: List[dict] = []


class OutboundMediaSendRequest(BaseModel):
    media_type: str = "image"  # "image" or "document"
    media_url: str
    caption: Optional[str] = None
    filename: Optional[str] = None


class MediaInfoResponse(BaseModel):
    media_id: str
    conversation_id: int
    mime_type: Optional[str] = None
    filename: Optional[str] = None
    caption: Optional[str] = None
    download_ready: bool = False
    message: Optional[str] = "Media access endpoint ready."


class ConversationResponse(ConversationBase):
    id: int
    last_message_at: Optional[datetime] = None
    unread_count: int = 0
    last_read_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    
    # Enriched Lead attributes
    lead_name: Optional[str] = None
    lead_phone: Optional[str] = None
    lead_avatar_url: Optional[str] = None
    is_group: bool = False
    last_message_preview: Optional[str] = None

    # 24-hour Customer Care Window status
    is_window_open: bool = True
    last_inbound_at: Optional[datetime] = None
    seconds_remaining: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)


class ConversationDetailResponse(ConversationResponse):
    messages: List[MessageResponse] = []
    has_more: bool = False
    oldest_message_id: Optional[int] = None
    newest_message_id: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)


class ConversationMessagesResponse(BaseModel):
    messages: List[MessageResponse] = []
    has_more: bool = False
    oldest_message_id: Optional[int] = None
    newest_message_id: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)


class StartConversationRequest(BaseModel):
    phone: str
    name: Optional[str] = None
    message: Optional[str] = None
