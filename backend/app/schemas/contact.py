from datetime import datetime
from typing import Optional, Dict, Any
from pydantic import BaseModel, ConfigDict


class ContactBase(BaseModel):
    phone_e164: str
    display_name: Optional[str] = None
    whatsapp_profile_name: Optional[str] = None
    lead_id: Optional[int] = None
    custom_attributes: Optional[Dict[str, Any]] = None


class ContactCreate(ContactBase):
    pass


class ContactUpdate(BaseModel):
    display_name: Optional[str] = None
    whatsapp_profile_name: Optional[str] = None
    lead_id: Optional[int] = None
    custom_attributes: Optional[Dict[str, Any]] = None


class ContactRead(ContactBase):
    id: int
    user_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
