from datetime import datetime
from enum import Enum
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field


class PlanTier(str, Enum):
    FREE = "FREE"
    STARTER = "STARTER"
    PRO = "PRO"
    AGENCY = "AGENCY"
    DEVELOPER_PRO = "DEVELOPER_PRO"


PLAN_CONFIGS: Dict[str, Dict[str, Any]] = {
    PlanTier.FREE.value: {
        "name": "Deneme (Free)",
        "price_try": 0,
        "monthly_lead_scrape_limit": 100,
        "daily_whatsapp_outreach_limit": 15,
        "max_active_campaigns": 1,
        "ai_daily_limit": 10,
        "webhooks_enabled": False,
        "api_access_enabled": False,
        "export_csv_enabled": True,
        "badge_color": "secondary",
        "description": "Sistemi test etmek ve temel özellikleri keşfetmek için ideal başlangıç.",
        "features_list": [
            "Aylık 100 İşletme / Lead Arama",
            "Günlük 15 WhatsApp Mesaj Gönderimi",
            "1 Aktif Kampanya",
            "Temel CRM ve Etiketleme",
            "CSV Dışa Aktarma",
        ],
    },
    PlanTier.STARTER.value: {
        "name": "Başlangıç (Starter)",
        "price_try": 499,
        "monthly_lead_scrape_limit": 1000,
        "daily_whatsapp_outreach_limit": 100,
        "max_active_campaigns": 3,
        "ai_daily_limit": 100,
        "webhooks_enabled": True,
        "api_access_enabled": True,
        "export_csv_enabled": True,
        "badge_color": "primary",
        "description": "Büyüyen işletmeler ve butik ajanslar için dengeli ve güçlü paket.",
        "features_list": [
            "Aylık 1,000 İşletme / Lead Arama",
            "Günlük 100 WhatsApp Mesaj Gönderimi",
            "3 Eşzamanlı Aktif Kampanya",
            "Günlük 100 Yapay Zeka Mesaj Üretimi",
            "Public REST API & Webhook Entegrasyonları",
            "Anti-Ban Koruması ve Akıllı Mesai",
        ],
    },
    PlanTier.PRO.value: {
        "name": "Profesyonel (Pro)",
        "price_try": 1299,
        "monthly_lead_scrape_limit": 5000,
        "daily_whatsapp_outreach_limit": 500,
        "max_active_campaigns": 10,
        "ai_daily_limit": 500,
        "webhooks_enabled": True,
        "api_access_enabled": True,
        "export_csv_enabled": True,
        "badge_color": "success",
        "description": "Yüksek hacimli müşteri adayı toplayan ve yoğun mesajlaşan ekipler için.",
        "features_list": [
            "Aylık 5,000 İşletme / Lead Arama",
            "Günlük 500 WhatsApp Mesaj Gönderimi",
            "10 Eşzamanlı Aktif Kampanya",
            "Günlük 500 Yapay Zeka Mesaj Üretimi",
            "Öncelikli Scraper & Çoklu İlçe Taraması",
            "Tam REST API, Webhooks ve Form Hook'ları",
            "Canlı Destek & Öncelikli Kuyruk",
        ],
    },
    PlanTier.AGENCY.value: {
        "name": "Ajans (Agency)",
        "price_try": 2999,
        "monthly_lead_scrape_limit": 25000,
        "daily_whatsapp_outreach_limit": 2500,
        "max_active_campaigns": 50,
        "ai_daily_limit": 2500,
        "webhooks_enabled": True,
        "api_access_enabled": True,
        "export_csv_enabled": True,
        "badge_color": "warning",
        "description": "Büyük ekipler, pazarlama ajansları ve kurumsal çağrı merkezleri için sınırları zorlayan çözüm.",
        "features_list": [
            "Aylık 25,000 İşletme / Lead Arama",
            "Günlük 2,500 WhatsApp Mesaj Gönderimi",
            "50 Eşzamanlı Aktif Kampanya",
            "Sınırsız Entegrasyon ve Webhook Kanalları",
            "Özel Proxy ve Dedike WhatsApp Gateway Desteği",
            "7/24 VIP Müşteri Yöneticisi",
        ],
    },
    PlanTier.DEVELOPER_PRO.value: {
        "name": "Geliştirici Pro (Unmetered)",
        "price_try": 0,
        "monthly_lead_scrape_limit": 999999,
        "daily_whatsapp_outreach_limit": 999999,
        "max_active_campaigns": 999999,
        "ai_daily_limit": 999999,
        "webhooks_enabled": True,
        "api_access_enabled": True,
        "export_csv_enabled": True,
        "badge_color": "info",
        "description": "Geliştirme, entegrasyon ve yerel test ortamı sınırsız paketi.",
        "features_list": [
            "Sınırsız Lead Arama & Kayıt",
            "Sınırsız WhatsApp İletimi",
            "Sınırsız Kampanyalar & Webhooklar",
            "Geliştirici API Yetkileri",
        ],
    },
}


class QuotaMetric(BaseModel):
    used: int
    limit: int
    remaining: int
    percentage: float


class QuotaUsageSummary(BaseModel):
    user_id: str
    plan_tier: str
    plan_name: str
    billing_cycle: str
    period_start: datetime
    period_end: datetime
    days_until_renewal: int
    leads: QuotaMetric
    whatsapp_daily: QuotaMetric
    ai_daily: QuotaMetric
    active_campaigns: QuotaMetric
    features: Dict[str, bool]


class PlanInfo(BaseModel):
    id: str
    name: str
    price_try: int
    monthly_lead_scrape_limit: int
    daily_whatsapp_outreach_limit: int
    max_active_campaigns: int
    ai_daily_limit: int
    webhooks_enabled: bool
    api_access_enabled: bool
    export_csv_enabled: bool
    badge_color: str
    description: str
    features_list: List[str]
    is_current: bool = False


class PlanListResponse(BaseModel):
    current_plan_tier: str
    plans: List[PlanInfo]


class ChangePlanRequest(BaseModel):
    plan_tier: str = Field(..., description="Geçilmek istenen paket kodu: FREE, STARTER, PRO, AGENCY")
