import secrets
import hashlib
from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Index, Uuid
from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class ApiKey(Base):
    """
    Public REST API ve harici entegrasyonlar için güvenli API Anahtarı.
    Gerçek anahtar veri tabanında ASLA düz metin saklanmaz; SHA-256 hash'i saklanır.
    Kullanıcıya yalnızca oluşturma anında 'tzf_live_...' formatında gösterilir.
    """
    __tablename__ = "api_keys"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=False, index=True)

    name = Column(String(100), nullable=False)
    key_prefix = Column(String(16), nullable=False, index=True)  # örn: 'tzf_live_a1b2'
    key_hash = Column(String(64), nullable=False, unique=True, index=True)  # SHA-256

    is_active = Column(Boolean, default=True, nullable=False, index=True)
    last_used_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
    updated_at = Column(DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False)

    __table_args__ = (
        Index("idx_api_keys_user_id", "user_id"),
        Index("idx_api_keys_prefix", "key_prefix"),
        Index("idx_api_keys_hash_active", "key_hash", "is_active"),
    )

    @staticmethod
    def generate_raw_key() -> str:
        """Kullanıcıya gösterilecek 40 karakterlik güvenli rastgele anahtar üretir."""
        random_part = secrets.token_hex(20)
        return f"tzf_live_{random_part}"

    @staticmethod
    def hash_key(raw_key: str) -> str:
        """Anahtarın SHA-256 özetini alır."""
        return hashlib.sha256(raw_key.strip().encode("utf-8")).hexdigest()
