from datetime import datetime
from typing import Optional, List, Any, Dict
from pydantic import BaseModel, Field, HttpUrl, ConfigDict


SUPPORTED_WEBHOOK_EVENTS = [
    "lead.created",
    "lead.status_updated",
    "whatsapp.message_received",
    "campaign.completed",
]


class WebhookCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=100, description="Webhook adı (örn: Zapier CRM Aktarımı)")
    target_url: str = Field(..., description="Olayların gönderileceği HTTPS uç noktası")
    events: List[str] = Field(..., min_length=1, description="Abone olunan olaylar listesi")


class WebhookUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=100)
    target_url: Optional[str] = None
    events: Optional[List[str]] = None
    is_active: Optional[bool] = None


class WebhookResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    target_url: str
    events: List[str]
    is_active: bool
    secret: str
    created_at: datetime
    updated_at: datetime


class WebhookDeliveryLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    subscription_id: int
    event_type: str
    payload: Optional[Dict[str, Any]] = None
    status_code: Optional[int] = None
    response_body: Optional[str] = None
    duration_ms: Optional[int] = None
    is_success: bool
    error_message: Optional[str] = None
    created_at: datetime


class WebhookTestResponse(BaseModel):
    success: bool
    status_code: Optional[int] = None
    response_body: Optional[str] = None
    duration_ms: Optional[int] = None
    error: Optional[str] = None
