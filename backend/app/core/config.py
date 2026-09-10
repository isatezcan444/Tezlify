from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Uygulama genelinde tek yapılandırma kaynağı.

    Tüm varsayılanlar geliştirme (development) içindir; üretimde .env ile
    ezilmelidir (bkz. .env.example). Varsayılan değerlerin üretim için
    güvenli olduğu varsayılmaz.
    """

    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    PROJECT_NAME: str = "Tezlify"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"

    # Database
    DATABASE_URL: str = Field(
        default="sqlite+aiosqlite:///./tezlify.db",
        description="Async SQLite or PostgreSQL connection string",
    )

    @field_validator("DATABASE_URL", mode="before")
    @classmethod
    def assemble_db_connection(cls, v: Optional[str]) -> str:
        if not v:
            return "sqlite+aiosqlite:///./tezlify.db"
        if isinstance(v, str):
            if v.startswith("postgres://"):
                return v.replace("postgres://", "postgresql+asyncpg://", 1)
            if v.startswith("postgresql://") and "+asyncpg" not in v:
                return v.replace("postgresql://", "postgresql+asyncpg://", 1)
        return v

    # Demo verisi: boş veritabanına örnek kampanya/lead ekler. Üretimde kapatın.
    SEED_DEMO_DATA: bool = False

    # Security / CORS
    SECRET_KEY: str = Field(
        default="dev-only-insecure-secret-key",
        description="Üretimde mutlaka .env ile güçlü bir değerle ezilmelidir.",
    )
    BACKEND_CORS_ORIGINS: List[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: object) -> List[str]:
        if isinstance(v, str) and not v.startswith("["):
            return [i.strip() for i in v.split(",") if i.strip()]
        if isinstance(v, list):
            return [str(i) for i in v]
        return [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:8000",
            "http://127.0.0.1:8000",
        ]

    # Default Outreach Anti-Ban Thresholds
    # Tek doğruluk kaynağı burasıdır; Campaign model varsayılanları ve
    # AntibanPolicy bu değerlerden beslenir.
    DEFAULT_MIN_DELAY_SECONDS: int = 45
    DEFAULT_MAX_DELAY_SECONDS: int = 120
    DEFAULT_TYPING_DELAY_SECONDS: int = 4
    DEFAULT_DAILY_LIMIT_PER_SESSION: int = 50
    DEFAULT_WORKING_HOURS_START: str = "09:00"
    DEFAULT_WORKING_HOURS_END: str = "18:30"

    # Scraper Settings
    SCRAPER_USER_AGENT: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    )
    SCRAPER_MAX_CONCURRENT_TASKS: int = 3
    SCRAPER_REQUEST_TIMEOUT: int = 30
    # Page navigation timeout for Google Maps sessions (ms)
    # 60s for production (Render's network is slower than local)
    SCRAPER_PAGE_TIMEOUT_MS: int = 60000
    # "Sınırsız" modda ilçe başına hedef işletme sayısı
    SCRAPER_UNLIMITED_DISTRICT_TARGET: int = 200
    # "Sınırsız" modda ilçe başına maksimum scroll iterasyonu
    SCRAPER_MAX_SCROLL_ITERATIONS: int = 40
    # Scroll sonrası yeni kartların yüklenmesi için beklenen üst sınır (ms)
    SCROLLER_SETTLE_TIMEOUT_MS: int = 6000
    # Zaman bazlı stagnasyon eşiği: bu süre boyunca hiç yeni kart görülmezse
    # sonuç listesinin bittiği kabul edilir (saniye)
    SCRAPER_STAGNATION_TIMEOUT_SECONDS: float = 12.0
    # Website telefon zenginleştirme HTTP timeout'u (saniye - akışı yavaşlatmamak için 1.5s)
    SCRAPER_ENRICH_TIMEOUT_SECONDS: float = 1.5
    # Sektör etiketinden türetilecek maksimum arama varyantı sayısı
    SCRAPER_MAX_QUERY_VARIANTS: int = 3
    # Adaptif mahalle fazı: 1. faz adreslerinden türetilen alt-bölge sorguları
    # (ölçüldü: +%30 marjinal recall). Yalnızca limitsiz modda koşar.
    SCRAPER_MAHALLE_PHASE_ENABLED: bool = True
    SCRAPER_MAX_MAHALLE_QUERIES: int = 4
    SCRAPER_MAHALLE_MAX_PAGES: int = 4
    SCRAPER_MAHALLE_MIN_MENTIONS: int = 3
    # Coğrafi çit: adresi hedef ilçe dışını kanıtlayan işletmeleri ele
    SCRAPER_GEO_FILTER_ENABLED: bool = True
    # İlçe kanıtı taşımayan (CITY_ONLY/UNKNOWN) adresleri de ele (en katı mod)
    SCRAPER_REJECT_UNPROVEN_LOCATION: bool = False
    # Scraper Engine: "HTTP" (ultra-fast, zero RAM, no browser) or "PLAYWRIGHT"
    SCRAPER_ENGINE: str = "HTTP"
    SCRAPER_HTTP_PAGE_SIZE: int = 20
    SCRAPER_HTTP_MAX_PAGES_PER_QUERY: int = 10
    SCRAPER_HTTP_TIMEOUT_SECONDS: float = 12.0


settings = Settings()