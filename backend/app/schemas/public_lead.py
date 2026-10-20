from typing import Optional, Dict, Any
from pydantic import BaseModel, Field


class PublicLeadIngestRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200, description="İşletme veya kişi adı")
    phone: Optional[str] = Field(None, description="Telefon numarası (örn: 05321234567 veya +905321234567)")
    email: Optional[str] = Field(None, description="E-posta adresi")
    category: Optional[str] = Field(None, description="Sektör / Kategori")
    city: Optional[str] = Field(None, description="Şehir")
    district: Optional[str] = Field(None, description="İlçe")
    address: Optional[str] = Field(None, description="Açık adres")
    website: Optional[str] = Field(None, description="Web sitesi")
    notes: Optional[str] = Field(None, description="Müşteri adayı notları veya form içeriği")
    group_id: Optional[int] = Field(None, description="Eklenecek kampanya grubu ID'si (opsiyonel)")
    send_whatsapp_welcome: bool = Field(False, description="Oluşturulduğunda aktif WhatsApp hattından otomatik karşılama mesajı gönderilsin mi?")
    welcome_message: Optional[str] = Field(None, description="Gönderilecek özel karşılama mesajı")
    custom_fields: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Ekstra form parametreleri")


class PublicLeadIngestResponse(BaseModel):
    success: bool
    lead_id: int
    name: str
    phone_e164: Optional[str] = None
    is_whatsapp_eligible: bool = False
    added_to_group_id: Optional[int] = None
    whatsapp_welcome_sent: bool = False
    message: str
