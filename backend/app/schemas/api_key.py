from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field, ConfigDict


class ApiKeyCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=100, description="API anahtarı için açıklayıcı ad (örn: Zapier Lead Form)")
    expires_in_days: Optional[int] = Field(None, ge=1, le=365, description="Geçerlilik süresi (gün)")


class ApiKeyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    key_prefix: str
    is_active: bool
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    created_at: datetime


class ApiKeyCreatedResponse(ApiKeyResponse):
    """Sadece oluşturulduğunda bir kez dönen ve tam gizli anahtarı içeren yanıt."""
    raw_key: str = Field(..., description="Yalnızca bir kez gösterilecek tam API anahtarı (tzf_live_...)")


class ApiKeyListResponse(BaseModel):
    items: List[ApiKeyResponse]
    total: int
