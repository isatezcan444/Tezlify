import enum
import json
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Enum, Index, JSON
from backend.app.core.database import Base


class Blacklist(Base):
    __tablename__ = "blacklist"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(String(36), nullable=True, index=True)
    phone_e164 = Column(String(50), nullable=False, index=True)
    reason = Column(String(255), default="USER_REQUEST")  # USER_REQUEST, SPAM_REPORT, INVALID, OPT_OUT
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ScraperJobStatus(str, enum.Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class ScraperJob(Base):
    __tablename__ = "scraper_jobs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(String(36), nullable=True, index=True)
    keyword = Column(String(200), nullable=False)
    location = Column(String(200), nullable=False)  # display string for backward compat

    # Structured location snapshot — immutable after job creation
    city = Column(String(100), nullable=True, index=True)
    districts_json = Column(JSON, nullable=True)  # e.g. ["Ataşehir", "Kadıköy"]

    source = Column(String(50), default="GOOGLE_MAPS")

    status = Column(Enum(ScraperJobStatus), default=ScraperJobStatus.PENDING, index=True)
    total_found = Column(Integer, default=0)
    total_valid_phones = Column(Integer, default=0)
    total_new_leads = Column(Integer, default=0)

    error_message = Column(Text, nullable=True)
    duration_seconds = Column(Integer, default=0)

    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
