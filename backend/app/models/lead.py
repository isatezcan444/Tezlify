import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, Enum, JSON, Index, Uuid
from sqlalchemy.orm import relationship
from backend.app.core.database import Base


class LeadStatus(str, enum.Enum):
    NEW = "NEW"
    CONTACTED = "CONTACTED"
    REPLIED = "REPLIED"
    INTERESTED = "INTERESTED"
    UNSUBSCRIBED = "UNSUBSCRIBED"
    INVALID_NUMBER = "INVALID_NUMBER"


class EntityType(str, enum.Enum):
    BUSINESS = "BUSINESS"
    CLINIC = "CLINIC"
    COMPANY = "COMPANY"
    PROFESSIONAL = "PROFESSIONAL"
    PERSON = "PERSON"
    DIRECTORY_PROFILE = "DIRECTORY_PROFILE"
    UNKNOWN = "UNKNOWN"


class VerificationStatus(str, enum.Enum):
    VERIFIED = "VERIFIED"
    UNVERIFIED = "UNVERIFIED"
    REJECTED = "REJECTED"


class ConfidenceLevel(str, enum.Enum):
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class Lead(Base):
    __tablename__ = "leads"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    # Business Details
    name = Column(String(255), nullable=False, index=True)
    category = Column(String(100), nullable=True, index=True)

    # Entity Resolution & Verification
    entity_type = Column(String(50), default=EntityType.BUSINESS.value, index=True)
    verification_status = Column(String(50), default=VerificationStatus.UNVERIFIED.value, index=True)
    confidence_level = Column(String(20), default=ConfidenceLevel.MEDIUM.value)
    confidence_score = Column(Integer, default=50)
    is_verified = Column(Boolean, default=False, index=True)

    # Generic Search Intelligence & Audit
    canonical_category = Column(String(100), nullable=True, index=True)
    category_score = Column(Float, default=1.0)
    category_classification = Column(String(50), default="MATCH")

    # Trust & Source Attribution
    discovered_from = Column(String(100), nullable=True)
    verified_by = Column(String(200), nullable=True)
    verification_trace = Column(JSON, nullable=True)

    # Phone Numbers
    phone = Column(String(50), nullable=False)  # raw input
    # Standardized e.g. +905321234567. Telefonsuz kayıtlar (kartta telefon
    # bulunamayan işletmeler) NULL bırakılır — asla uydurma numara üretilmez.
    phone_e164 = Column(String(30), nullable=True, unique=True, index=True)
    is_mobile = Column(Boolean, default=False)
    is_whatsapp_eligible = Column(Boolean, default=False)

    # Location
    address = Column(Text, nullable=True)
    city = Column(String(100), nullable=True, index=True)
    district = Column(String(100), nullable=True, index=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)

    # Online Presence & Metrics
    website = Column(String(255), nullable=True)
    email = Column(String(255), nullable=True)
    rating = Column(Float, nullable=True)
    reviews_count = Column(Integer, nullable=True, default=0)
    place_id = Column(String(255), nullable=True, unique=True, index=True)

    # Search Tracking
    search_keyword = Column(String(200), nullable=True, index=True)
    search_location = Column(String(200), nullable=True)
    source = Column(String(50), default="GOOGLE_MAPS")

    # Outreach status
    status = Column(Enum(LeadStatus), default=LeadStatus.NEW, index=True)
    notes = Column(Text, nullable=True)
    custom_data = Column(JSON, nullable=True)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    last_contacted_at = Column(DateTime, nullable=True)

    # Relationships
    conversations = relationship("Conversation", back_populates="lead", passive_deletes=True)

    __table_args__ = (
        Index("idx_lead_city_category", "city", "category"),
        Index("idx_lead_status_created", "status", "created_at"),
        Index("idx_lead_verified_entity", "is_verified", "entity_type"),
    )
