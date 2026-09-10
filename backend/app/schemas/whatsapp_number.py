from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field
from backend.app.models.whatsapp_number import WhatsAppNumberStatus, WhatsAppNumberProvider


class WhatsAppNumberBase(BaseModel):
    name: str = Field(..., max_length=100, description="Friendly name e.g. 'Sales Line 1'")
    provider: WhatsAppNumberProvider = Field(
        default=WhatsAppNumberProvider.META_CLOUD,
        description="Transport provider: META_CLOUD or BAILEYS_QR",
    )
    display_phone_number: Optional[str] = Field(None, max_length=50, description="Display phone number e.g. '+90 850 123 45 67'")
    phone_number_id: Optional[str] = Field(None, max_length=100, description="Meta Graph API Phone Number ID")
    waba_id: Optional[str] = Field(None, max_length=100, description="Meta WhatsApp Business Account ID")
    business_account_id: Optional[str] = Field(None, max_length=100)
    status: WhatsAppNumberStatus = WhatsAppNumberStatus.ACTIVE
    quality_rating: Optional[str] = Field("UNKNOWN", max_length=50)
    verified_name: Optional[str] = Field(None, max_length=150)


class WhatsAppNumberCreate(WhatsAppNumberBase):
    access_token: Optional[str] = Field(
        None,
        description="Meta Permanent System User Access Token. Encrypted and never stored plaintext.",
    )


class WhatsAppNumberConnectRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=100, description="Internal friendly name e.g. 'Satış Hattı'")
    waba_id: str = Field(..., min_length=5, max_length=100, description="WhatsApp Business Account ID")
    phone_number_id: str = Field(..., min_length=5, max_length=100, description="Meta Phone Number ID")
    access_token: str = Field(..., min_length=20, description="Permanent System User Meta Access Token")
    business_account_id: Optional[str] = None


class WhatsAppNumberValidateRequest(BaseModel):
    waba_id: str = Field(..., min_length=5, max_length=100, description="WhatsApp Business Account ID")
    phone_number_id: str = Field(..., min_length=5, max_length=100, description="Meta Phone Number ID")
    access_token: str = Field(..., min_length=20, description="Meta Access Token to pre-validate")
    name: Optional[str] = None


class WhatsAppNumberValidateResponse(BaseModel):
    is_valid: bool
    phone_number_id: str
    display_phone_number: Optional[str] = None
    verified_name: Optional[str] = None
    quality_rating: Optional[str] = "UNKNOWN"
    waba_id: Optional[str] = None
    error: Optional[str] = None


class WhatsAppNumberUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=100)
    # Token rotation: user can provide a new token; validated before replacing
    access_token: Optional[str] = None


class WhatsAppNumberVerifyResponse(BaseModel):
    id: int
    status: WhatsAppNumberStatus
    verified: bool
    verified_name: Optional[str] = None
    quality_rating: Optional[str] = "UNKNOWN"
    last_verified_at: Optional[datetime] = None
    error: Optional[str] = None


class WhatsAppNumberRead(WhatsAppNumberBase):
    id: int
    user_id: Optional[str] = None
    phone_number_e164: Optional[str] = None
    last_verified_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    # Note: access_token, encrypted_access_token, and credential_reference are STRICTLY EXCLUDED for security.

    model_config = ConfigDict(from_attributes=True)
