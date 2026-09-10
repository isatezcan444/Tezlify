from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, ConfigDict
from backend.app.models.campaign import CampaignStatus
from backend.app.core.config import settings

class CampaignBase(BaseModel):
    name: str
    description: Optional[str] = None
    message_template: str
    min_delay_seconds: int = settings.DEFAULT_MIN_DELAY_SECONDS
    max_delay_seconds: int = settings.DEFAULT_MAX_DELAY_SECONDS
    typing_delay_seconds: int = settings.DEFAULT_TYPING_DELAY_SECONDS
    working_hours_enabled: bool = True
    working_hours_start: str = settings.DEFAULT_WORKING_HOURS_START
    working_hours_end: str = settings.DEFAULT_WORKING_HOURS_END
    group_id: Optional[int] = None

class CampaignCreate(CampaignBase):
    pass

class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    message_template: Optional[str] = None
    status: Optional[CampaignStatus] = None
    min_delay_seconds: Optional[int] = None
    max_delay_seconds: Optional[int] = None
    typing_delay_seconds: Optional[int] = None
    working_hours_enabled: Optional[bool] = None
    working_hours_start: Optional[str] = None
    working_hours_end: Optional[str] = None
    group_id: Optional[int] = None

class CampaignBulkDeleteRequest(BaseModel):
    campaign_ids: List[int]

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

