"""
Discovery Run Database Model.
Stores execution history, strategy progression, coverage metrics, and benchmark results for every discovery task.
"""
import enum
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, JSON, Enum, Index, Uuid
from backend.app.core.database import Base


def get_utc_now() -> datetime:
    return datetime.now(timezone.utc)


class DiscoveryRunStatus(str, enum.Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PARTIAL = "PARTIAL"
    SATURATED = "SATURATED"
    BENCHMARK_RECOVERED = "BENCHMARK_RECOVERED"
    BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class DiscoveryRun(Base):
    __tablename__ = "discovery_runs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)

    # Intent Snapshot
    user_keyword = Column(String(200), nullable=False)
    canonical_category = Column(String(100), nullable=False, index=True)
    city = Column(String(100), nullable=False, index=True)
    districts = Column(JSON, nullable=False)  # List[str]

    # Status & Completion
    status = Column(Enum(DiscoveryRunStatus), default=DiscoveryRunStatus.PENDING, index=True)
    completion_reason = Column(String(100), nullable=True)
    error_message = Column(Text, nullable=True)

    # Counts & Metrics
    total_raw_candidates = Column(Integer, default=0)
    unique_entities_count = Column(Integer, default=0)
    qualified_leads_count = Column(Integer, default=0)
    rejected_candidates_count = Column(Integer, default=0)

    # Known Entity Benchmark Tracking
    known_entities_total = Column(Integer, default=0)
    known_entities_recovered = Column(Integer, default=0)
    known_entity_recall = Column(Float, default=0.0)

    # Detailed Analytical Payloads
    provider_statistics = Column(JSON, nullable=True)  # Raw, unique, overlap matrix, unique contribution
    coverage_metrics = Column(JSON, nullable=True)     # Saturation curve, subdivision completion, yield rates
    benchmark_report = Column(JSON, nullable=True)     # Recovered / missed entity details with explainability

    # Timing
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, default=0)
    created_at = Column(DateTime, default=get_utc_now, nullable=False)

    __table_args__ = (
        Index("idx_disc_run_city_cat", "city", "canonical_category"),
    )
