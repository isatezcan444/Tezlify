from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, ConfigDict
from backend.app.models.campaign import CampaignStatus
from backend.app.core.config import settings

class SequenceStep(BaseModel):
    step_number: int
    delay_days: int = 1
    delay_hours: int = 0
    message_template: str
    media_url: Optional[str] = None
    media_type: Optional[str] = None
    media_filename: Optional[str] = None

class CampaignBase(BaseModel):
    name: str
    description: Optional[str] = None
    message_template: str
    scheduled_at: Optional[datetime] = None
    min_delay_seconds: int = settings.DEFAULT_MIN_DELAY_SECONDS
    max_delay_seconds: int = settings.DEFAULT_MAX_DELAY_SECONDS
    typing_delay_seconds: int = settings.DEFAULT_TYPING_DELAY_SECONDS
    working_hours_enabled: bool = True
    working_hours_start: str = settings.DEFAULT_WORKING_HOURS_START
    working_hours_end: str = settings.DEFAULT_WORKING_HOURS_END
    daily_message_limit: int = settings.DEFAULT_DAILY_LIMIT_PER_SESSION
    group_id: Optional[int] = None
    whatsapp_session_id: Optional[int] = None
    whatsapp_session_ids: Optional[List[int]] = None
    media_url: Optional[str] = None
    media_type: Optional[str] = None
    media_filename: Optional[str] = None
    sequence_enabled: bool = False
    sequence_steps: Optional[List[Dict[str, Any]]] = None
    auto_stop_on_reply: bool = True

class CampaignCreate(CampaignBase):
    pass

class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    message_template: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    status: Optional[CampaignStatus] = None
    min_delay_seconds: Optional[int] = None
    max_delay_seconds: Optional[int] = None
    typing_delay_seconds: Optional[int] = None
    working_hours_enabled: Optional[bool] = None
    working_hours_start: Optional[str] = None
    working_hours_end: Optional[str] = None
    daily_message_limit: Optional[int] = None
    group_id: Optional[int] = None
    whatsapp_session_id: Optional[int] = None
    whatsapp_session_ids: Optional[List[int]] = None
    media_url: Optional[str] = None
    media_type: Optional[str] = None
    media_filename: Optional[str] = None
    sequence_enabled: Optional[bool] = None
    sequence_steps: Optional[List[Dict[str, Any]]] = None
    auto_stop_on_reply: Optional[bool] = None

class CampaignScheduleRequest(BaseModel):
    scheduled_at: datetime
    session_id: Optional[int] = None
    session_ids: Optional[List[int]] = None

class CampaignBulkDeleteRequest(BaseModel):
    campaign_ids: List[int]

class SequenceLeadResponse(BaseModel):
    id: int
    campaign_id: int
    lead_id: int
    lead_name: Optional[str] = None
    lead_phone: Optional[str] = None
    whatsapp_session_id: Optional[int] = None
    current_step: int
    total_steps: int
    status: str
    next_step_at: Optional[datetime] = None
    last_step_sent_at: Optional[datetime] = None
    stopped_at: Optional[datetime] = None
    stop_reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

class CampaignResponse(CampaignBase):
    id: int
    status: CampaignStatus
    total_leads_target: int
    sent_count: int
    delivered_count: int
    replied_count: int
    failed_count: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

class SpintaxPreviewRequest(BaseModel):
    template: str
    sample_lead: Optional[Dict[str, Any]] = None
    count: int = 5

class SpintaxPreviewResponse(BaseModel):
    template: str
    permutations_count: int
    samples: List[str]

class CampaignLaunchRequest(BaseModel):
    lead_ids: Optional[List[int]] = None
    filter_status: Optional[str] = "NEW"
    limit: Optional[int] = 50
    session_id: Optional[int] = None
    session_ids: Optional[List[int]] = None

class GenerateMessageRequest(BaseModel):
    communication_goal: str
    target_category: Optional[str] = None
    offer_title: Optional[str] = None
    key_benefit: Optional[str] = None
    extra_information: Optional[str] = None
    preferred_channel: Optional[str] = None
    lead_need: Optional[str] = None
    specific_question: Optional[str] = None
    pricing_info: Optional[str] = None
    meeting_purpose: Optional[str] = None
    previous_topic: Optional[str] = None
    language: str = "tr"
    variation_seed: Optional[int] = None

class GenerateMessageResponse(BaseModel):
    generated_message: str
    communication_goal: str
    language: str
    strategy_summary: Optional[str] = None

