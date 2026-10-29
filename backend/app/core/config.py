import logging
from typing import List, Optional, Union

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
    DATABASE_POOL_SIZE: int = Field(
        default=10,
        ge=1,
        le=50,
        description="Persistent connection pool size for PostgreSQL.",
    )
    DATABASE_MAX_OVERFLOW: int = Field(
        default=20,
        ge=0,
        le=50,
        description="Bounded temporary database connections.",
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

    # Admin / Operations Center
    ADMIN_EMAILS: Union[List[str], str] = Field(
        default_factory=list,
        description="Yönetici (admin) e-posta adresleri. Virgülle ayrılmış dize veya liste.",
    )

    @field_validator("ADMIN_EMAILS", mode="before")
    @classmethod
    def assemble_admin_emails(cls, v: object) -> List[str]:
        if not v:
            return []
        if isinstance(v, str):
            v_str = v.strip()
            if not v_str:
                return []
            if v_str.startswith("["):
                import json
                try:
                    parsed = json.loads(v_str)
                    if isinstance(parsed, list):
                        return [str(e).strip().lower() for e in parsed if str(e).strip()]
                except Exception:
                    pass
            return [e.strip().lower() for e in v_str.split(",") if e.strip()]
        if isinstance(v, (list, set, tuple)):
            return [str(e).strip().lower() for e in v if str(e).strip()]
        return []

    # Operations & Monitoring paths
    TEZLIFY_RUNTIME_DIR: str = "/opt/tezlify/runtime/whatsapp-reliability"
    TEZLIFY_MONITORING_DIR: str = "/opt/tezlify/monitoring"
    TEZLIFY_BACKUPS_DIR: str = "/opt/tezlify/backups"
    HOST_RUN_DIR: str = "/var/run"

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
    # 60s for production networks
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
    SCRAPER_CONCURRENT_DISTRICTS: int = 3
    SCRAPER_HTTP_PAGE_SIZE: int = 20
    SCRAPER_HTTP_MAX_PAGES_PER_QUERY: int = 10
    SCRAPER_HTTP_TIMEOUT_SECONDS: float = 12.0

    # WhatsApp Baileys Gateway (Aşama 2)
    # whatsapp-gateway servisinin REST + WS adresi. Varsayılan localhost'tur;
    # üretimde özel ağ / aynı host üzerinde çalıştırılmalıdır.
    WHATSAPP_GATEWAY_URL: str = "http://127.0.0.1:8787"
    WHATSAPP_GATEWAY_TIMEOUT: float = 30.0
    # /ws/gateway uç noktası için opsiyonel paylaşılan sır (boşsa açık kalır)
    WHATSAPP_GATEWAY_SECRET: str = ""
    # Arka plan otomatik tarihçe genişletme kill-switch (WhatsApp Web / Chrome sync storm önleme)
    WHATSAPP_BACKGROUND_HISTORY_EXPANSION_ENABLED: bool = False

    # Periyodik LID kimlik süpürmesi: boot'ta sınır yüzünden artan ya da canlı
    # yolun kilit nedeniyle ertelediği bölünmüş sohbetleri birleştirir. Durum
    # `/health` → `whatsapp_identity_sweep` altında görünür.
    WHATSAPP_IDENTITY_SWEEP_ENABLED: bool = True
    WHATSAPP_IDENTITY_SWEEP_INTERVAL_SECONDS: int = 900
    WHATSAPP_IDENTITY_SWEEP_INITIAL_DELAY_SECONDS: int = 60
    WHATSAPP_IDENTITY_SWEEP_LIMIT: int = 200

    # Gateway belleğini kalıcılaştıran süpürme (Faz 3.6).
    #
    # NEDEN VAR: ilk senkron sohbet başına yalnızca en yeni 50 mesajı DB'ye
    # yazar (`_SYNC_PER_CHAT_LIMIT`). Daha eski her mesaj YALNIZCA gateway
    # RAM'inde durur ve gateway yeniden oluşturulduğunda kaybolur. Canlı
    # ölçüm (2026-10-28, kimlik üzerinden): RAM'de 9122 mesaj, 7336'sı
    # DB'de YOK / 40 sohbet. (İlk ölçüm `perChatLimit=50` ile yapıldığı için
    # "7080 / 16 sohbet" diye EKSİK raporlanmıştı — ölçüm derinliği hatası.)
    #
    # Bu iş WhatsApp'a HİÇBİR ŞEY sormaz (PDO yok): yalnızca gateway'in zaten
    # elinde tuttuğu kayıtları mevcut ingest yolundan DB'ye yazar.
    #
    # DİKKAT — varsayılan KAPALI (Faz 3.8.1'de AÇIK'tan çevrildi).
    #
    # NEDEN ÇEVRİLDİ: varsayılan açıkken, flag'i hiç taşımayan bir ortamda
    # (aday container canlı container'ın env'ini devralır ve `.env.production`
    # bu anahtarı içermiyordu) backend açılıştan ~90 sn sonra süpürmeyi
    # KENDİLİĞİNDEN başlatıyordu. "Yokluk" bir güvenlik kararı değildir; bu
    # yüzden yokluk artık "kapalı" demektir. Açmak AÇIK bir `true` gerektirir.
    WHATSAPP_MEMORY_PERSIST_ENABLED: bool = False
    WHATSAPP_MEMORY_PERSIST_INTERVAL_SECONDS: int = 300
    WHATSAPP_MEMORY_PERSIST_INITIAL_DELAY_SECONDS: int = 90
    # Tek turda okunacak azami sayfa ve sayfa boyu → tur başına üst sınır
    # page_size * max_pages mesaj. Sınırsız bellek/transaction oluşmasın.
    WHATSAPP_MEMORY_PERSIST_PAGE_SIZE: int = 500
    WHATSAPP_MEMORY_PERSIST_MAX_PAGES: int = 20
    # Gateway'in sohbet başına döndüreceği azami mesaj. `_SYNC_PER_CHAT_LIMIT`
    # (50) bilerek AŞILIR: bu iş tam olarak o tavanın dışında kalanları yazar.
    WHATSAPP_MEMORY_PERSIST_PER_CHAT_LIMIT: int = 2000

    @field_validator("WHATSAPP_MEMORY_PERSIST_ENABLED", mode="before")
    @classmethod
    def _memory_persist_fail_closed(cls, value: object) -> bool:
        """Yalnızca AÇIKÇA tanınan bir "true" değeri süpürmeyi açar.

        Pydantic'in kendi bool çözümlemesi `truely` / `evet` / `2` gibi
        değerlerde `ValidationError` fırlatır ve bu, uygulamanın TAMAMININ
        açılmaması demektir. İstenen bu değil: istenen, *süpürmenin*
        başlamaması. Bu yüzden çözülemeyen her değer `False`a düşürülür ve
        tek satır uyarı bırakılır — servis ayakta kalır, yazma başlamaz.
        """
        if isinstance(value, bool):
            return value
        if value is None:
            return False
        text = str(value).strip().strip('"').strip("'").strip().lower()
        if text in {"1", "true", "yes", "on", "y", "t"}:
            return True
        if text in {"0", "false", "no", "off", "n", "f", ""}:
            return False

        logging.getLogger(__name__).warning(
            "WHATSAPP_MEMORY_PERSIST_ENABLED çözülemedi; güvenli tarafta "
            "KAPALI kabul edildi (fail-closed)."
        )
        return False


settings = Settings()
