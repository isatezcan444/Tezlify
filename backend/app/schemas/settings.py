from pydantic import BaseModel, Field, ConfigDict
from typing import Optional
from datetime import datetime


class AntiBanSettingsSchema(BaseModel):
    preset: str = Field(default="standard_balanced", description="ultra_safe | standard_balanced | fast_warmed | custom")
    min_delay_seconds: int = Field(default=45, ge=5, le=600)
    max_delay_seconds: int = Field(default=120, ge=10, le=900)
    typing_delay_seconds: int = Field(default=4, ge=1, le=30)
    daily_message_limit: int = Field(default=50, ge=5, le=500)
    working_hours_enabled: bool = True
    working_hours_start: str = "09:00"
    working_hours_end: str = "18:30"


class AntiBanSettingsResponse(AntiBanSettingsSchema):
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class SmtpConfigSchema(BaseModel):
    host: str = Field(..., description="SMTP server hostname e.g. smtp.gmail.com")
    port: int = Field(default=587, ge=1, le=65535)
    username: str = Field(default="")
    password: str = Field(default="")
    sender_email: str = Field(..., description="Outbound sender email address")
    sender_name: Optional[str] = Field(default="Tezlify")
    use_tls: bool = Field(default=True)
    use_ssl: bool = Field(default=False)


class SmtpConfigResponse(BaseModel):
    """Okuma modeli — PAROLA ASLA DONDURULMEZ.

    Parola yalnizca yazma yonunde (`SmtpConfigSchema`) tasinir ve DB'de kalir.
    Onceki halinde `password` alanı duz metin olarak donuyordu; uç nokta
    kimlik dogrulamasi olmadigi icin `GET /settings/smtp` internete acik bir
    parola sizintisiydi. `has_password` UI'nin "kayitli parola var" ipucunu
    verebilmesi icin vardir.
    """

    host: str = ""
    port: int = 587
    username: str = ""
    has_password: bool = False
    sender_email: str = ""
    sender_name: str = "Tezlify"
    use_tls: bool = True
    use_ssl: bool = False
    is_configured: bool = False


class SmtpTestRequest(BaseModel):
    target_email: str = Field(..., description="Destination email address for test message")


class SendLeadEmailRequest(BaseModel):
    subject: str = Field(..., min_length=1, max_length=255)
    body: str = Field(..., min_length=1)
    is_html: bool = Field(default=False)
