from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, ConfigDict, Field
from backend.app.models.blacklist import ScraperJobStatus


class ScraperRunRequest(BaseModel):
    """Structured search request with explicit city/districts — no opaque string parsing.

    max_results semantics: 0 = UNLIMITED (config-driven per-district targets).
    The UI 'Sınırsız' option sends 0 and must never be coerced to another number.
    """
    keyword: str
    city: str
    districts: List[str] = []
    max_results: int = Field(default=0, ge=0, le=10000)
    source: str = "GOOGLE_MAPS"
    auto_save_to_crm: Optional[bool] = False


class ScraperJobResponse(BaseModel):
    id: int
    keyword: str
    location: str  # display string for backward compat
    city: Optional[str] = None
    districts_json: Optional[List[str]] = None
    source: str
    status: ScraperJobStatus
    total_found: int
    total_valid_phones: int
    total_new_leads: int
    duration_seconds: int
    error_message: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BlacklistCreate(BaseModel):
    phone_e164: str
    reason: Optional[str] = "USER_REQUEST"
    notes: Optional[str] = None


class BlacklistResponse(BaseModel):
    id: int
    phone_e164: str
    reason: str
    notes: Optional[str] = None
    created_at: datetime
    lead_name: Optional[str] = None
    lead_category: Optional[str] = None
    lead_city: Optional[str] = None
    lead_district: Optional[str] = None
    lead_address: Optional[str] = None
    lead_rating: Optional[float] = None
    lead_reviews_count: Optional[int] = None
    lead_website: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class BlacklistPaginationResponse(BaseModel):
    items: List[BlacklistResponse]
    total: int
    page: int
    size: int
    pages: int

    model_config = ConfigDict(from_attributes=True)


class ScraperSaveRequest(BaseModel):
    """Explicit on-demand persist of discovery results.

    Discovery (POST /scraper/start) never writes to CRM by itself; the client
    sends back the reviewed selection (or the full set) through this endpoint.
    """
    leads: List[Dict[str, Any]] = Field(min_length=1, max_length=1000)


class ScraperSaveResponse(BaseModel):
    job_id: int
    saved: List[Dict[str, Any]]
    new_count: int
    updated_count: int
