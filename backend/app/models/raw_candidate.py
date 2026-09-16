"""
Raw Candidate Database Model.
Stores raw, unadulterated provider findings before and during qualification.
Preserves full provenance, payload, and rejection audit trails.
"""
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, JSON, Index
from backend.app.core.database import Base


def get_utc_now() -> datetime:
    return datetime.now(timezone.utc)


class RawCandidate(Base):
    __tablename__ = "raw_candidates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    discovery_run_id = Column(Integer, nullable=True, index=True)

    # Provider & Strategy Provenance
    provider_name = Column(String(50), nullable=False, index=True)  # OVERPASS, DIRECTORY, WEB, NOMINATIM
    provider_record_id = Column(String(100), nullable=True, index=True)
    strategy_id = Column(String(100), nullable=True)
    query_id = Column(String(100), nullable=True, index=True)
    query_text = Column(String(500), nullable=True)
    source_url = Column(String(500), nullable=True)

    # Raw Attributes
    raw_name = Column(String(255), nullable=False, index=True)
    clean_name = Column(String(255), nullable=False, index=True)
    raw_phone = Column(String(100), nullable=True)
    phone_e164 = Column(String(30), nullable=True, index=True)
    raw_website = Column(String(255), nullable=True)
    raw_address = Column(Text, nullable=True)
    raw_lat = Column(Float, nullable=True)
    raw_lon = Column(Float, nullable=True)
    raw_category = Column(String(100), nullable=True)

    # Complete Raw Payload
    raw_payload = Column(JSON, nullable=True)

    # Qualification & Audit Trail
    is_qualified = Column(Boolean, default=False, index=True)
    rejection_stage = Column(String(50), nullable=True)  # CATEGORY_GATE, LOCATION_GATE, QUALITY_GATE, DUPLICATE
    rejection_reason = Column(Text, nullable=True)

    # Timestamps
    discovered_at = Column(DateTime, default=get_utc_now, nullable=False)

    __table_args__ = (
        Index("idx_raw_cand_run_prov", "discovery_run_id", "provider_name"),
        Index("idx_raw_cand_phone_name", "phone_e164", "clean_name"),
    )
