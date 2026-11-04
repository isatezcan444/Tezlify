from typing import List, Optional
from pydantic import BaseModel, Field


class SandboxStatusResponse(BaseModel):
    """WhatsApp sandbox altyapı durum yanıtı."""
    enabled: bool = Field(..., description="Sandbox modu etkin mi?")
    session_id: Optional[int] = Field(None, description="Konfigüre edilmiş sandbox session ID")
    allowed_targets_count: int = Field(0, description="İzin verilen hedef sayısı")
    allowed_targets_masked: List[str] = Field(default_factory=list, description="Maskelenmiş izinli numaralar")
    max_messages: int = Field(10, description="Pencere başına azami mesaj sayısı")
    timeout_ms: int = Field(15000, description="Test zaman aşımı (milisaniye)")
    protected_sessions: List[int] = Field(default_factory=list, description="Sandbox için yasaklı korumalı oturumlar (örn. 201)")
    can_execute_live: bool = Field(..., description="Canlı sandbox testi çalıştırılabilir mi?")
    status_reason: str = Field(..., description="Durum açıklaması / engel nedeni")


class SandboxPingRequest(BaseModel):
    """Sandbox ping testi başlatma isteği."""
    target: Optional[str] = Field(None, description="Hedef telefon numarası (allowlist'ten doğrulanır)")
    correlation_id: Optional[str] = Field(None, description="Özel correlation ID (boşsa TEZLIFY_SANDBOX:<uuid> üretilir)")
    timeout_ms: Optional[int] = Field(None, description="Özel timeout süresi (ms)")


class SandboxPingResponse(BaseModel):
    """Yapılandırılmış sandbox test sonucu (PII-safe)."""
    test_id: str = Field(..., description="Benzersiz test ID")
    correlation_id: str = Field(..., description="Korelasyon ID")
    session_id: Optional[int] = Field(None, description="Kullanılan session ID")
    target_masked: str = Field(..., description="Maskelenmiş hedef telefon numarası")
    user_id: Optional[str] = Field(None, description="Testi başlatan kullanıcı ID'si")
    started_at: str = Field(..., description="Test başlangıç zamanı (ISO8601)")
    completed_at: Optional[str] = Field(None, description="Test bitiş zamanı (ISO8601)")
    send_status: str = Field(..., description="Gönderim durumu (PENDING, SENT, FAILED, BLOCKED)")
    delivery_status: str = Field(..., description="Teslimat durumu (PENDING, DELIVERED, READ, TIMEOUT, NONE, SKIPPED)")
    pong_status: str = Field(..., description="PONG yanıt durumu (WAITING, MATCHED, TIMEOUT, NONE, SKIPPED)")
    duration_ms: Optional[float] = Field(None, description="Toplam işlem süresi (ms)")
    error_code: Optional[str] = Field(None, description="Hata kodu")
    error_detail: Optional[str] = Field(None, description="Maskelenmiş hata detayı")

