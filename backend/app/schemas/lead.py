from datetime import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, ConfigDict
from backend.app.models.lead import LeadStatus


class LeadBase(BaseModel):
    name: str
    category: Optional[str] = None
    phone: str
    city: Optional[str] = None
    district: Optional[str] = None
    address: Optional[str] = None
    website: Optional[str] = None
    email: Optional[str] = None
    rating: Optional[float] = None
    reviews_count: Optional[int] = 0
    search_keyword: Optional[str] = None
    search_location: Optional[str] = None
    notes: Optional[str] = None


class LeadCreate(LeadBase):
    pass


class LeadUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    phone: Optional[str] = None
    status: Optional[LeadStatus] = None
    city: Optional[str] = None
    district: Optional[str] = None
    address: Optional[str] = None
    website: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None


class LeadResponse(LeadBase):
    id: int
    phone_e164: Optional[str] = None
    is_mobile: bool = False
    is_whatsapp_eligible: bool = False
    status: LeadStatus
    entity_type: Optional[str] = "BUSINESS"
    verification_status: Optional[str] = "UNVERIFIED"
    confidence_level: Optional[str] = "MEDIUM"
    confidence_score: Optional[int] = 50
    is_verified: Optional[bool] = False
    canonical_category: Optional[str] = None
    category_score: Optional[float] = 1.0
    category_classification: Optional[str] = "MATCH"
    discovered_from: Optional[str] = None
    verified_by: Optional[str] = None
    verification_trace: Optional[Dict[str, Any]] = None
    emails: Optional[List[str]] = None
    social_links: Optional[Dict[str, str]] = None
    meta_title: Optional[str] = None
    meta_description: Optional[str] = None
    enrichment_status: Optional[str] = "NOT_ENRICHED"
    enriched_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    last_contacted_at: Optional[datetime] = None
    custom_data: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(from_attributes=True)


class LeadListResponse(BaseModel):
    items: List[LeadResponse]
    total: int
    page: int
    size: int
    pages: int


class BulkDeleteRequest(BaseModel):
    lead_ids: Optional[List[int]] = None
    delete_all_matching: Optional[bool] = False
    search: Optional[str] = None
    city: Optional[str] = None
    districts: Optional[List[str]] = None
    categories: Optional[List[str]] = None
    status: Optional[LeadStatus] = None
    whatsapp_eligible_only: Optional[bool] = False


class BulkBlacklistRequest(BaseModel):
    lead_ids: Optional[List[int]] = None
    blacklist_all_matching: Optional[bool] = False
    reason: Optional[str] = "Toplu kara listeye eklendi"
    search: Optional[str] = None
    city: Optional[str] = None
    districts: Optional[List[str]] = None
    categories: Optional[List[str]] = None
    status: Optional[LeadStatus] = None
    whatsapp_eligible_only: Optional[bool] = False


class ExportLeadsRequest(BaseModel):
    search: Optional[str] = None
    city: Optional[str] = None
    districts: Optional[List[str]] = None
    categories: Optional[List[str]] = None
    status: Optional[LeadStatus] = None
    whatsapp_eligible_only: Optional[bool] = False


class LeadEnrichResponse(BaseModel):
    success: bool
    lead: LeadResponse
    found_emails: List[str] = []
    found_socials: Dict[str, str] = {}
    meta_title: Optional[str] = None
    meta_description: Optional[str] = None
    error: Optional[str] = None


class BulkEnrichRequest(BaseModel):
    lead_ids: Optional[List[int]] = None
    enrich_all_matching: Optional[bool] = False
    search: Optional[str] = None
    city: Optional[str] = None
    districts: Optional[List[str]] = None
    categories: Optional[List[str]] = None
    status: Optional[LeadStatus] = None
    whatsapp_eligible_only: Optional[bool] = False


class BulkEnrichResponse(BaseModel):
    total_requested: int
    enriched_count: int
    skipped_count: int
    failed_count: int
    items: List[LeadResponse]

