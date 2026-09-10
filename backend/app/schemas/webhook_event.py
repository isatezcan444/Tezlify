from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict
from backend.app.models.webhook_event import WebhookEventStatus


class WebhookEventRead(BaseModel):
    id: int
    user_id: Optional[str] = None
    provider: str
    event_type: str
    event_hash: str
    external_message_id: Optional[str] = None
    status: WebhookEventStatus
    failure_reason: Optional[str] = None
    received_at: datetime
    processed_at: Optional[datetime] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
