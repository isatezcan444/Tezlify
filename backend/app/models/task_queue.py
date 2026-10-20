import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Enum, JSON
from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class TaskJobStatus(str, enum.Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    RETRYING = "RETRYING"


class TaskJob(Base):
    """Dayanıklı ve kalıcı arka plan iş kuyruğu (Task Queue) modeli."""
    __tablename__ = "task_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_type = Column(String(64), nullable=False, index=True)
    payload = Column(JSON, nullable=False, default=dict)

    status = Column(Enum(TaskJobStatus), default=TaskJobStatus.PENDING, nullable=False, index=True)
    priority = Column(Integer, default=0, nullable=False, index=True)  # Yüksek öncelik önce çalışır

    attempts = Column(Integer, default=0, nullable=False)
    max_attempts = Column(Integer, default=3, nullable=False)
    last_error = Column(Text, nullable=True)

    progress_percent = Column(Integer, default=0, nullable=False)
    progress_message = Column(String(255), nullable=True)
    result_summary = Column(JSON, nullable=True)

    user_id = Column(String(64), nullable=True, index=True)

    scheduled_at = Column(DateTime, default=utc_now_naive, nullable=False)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
    updated_at = Column(DateTime, default=utc_now_naive, onupdate=utc_now_naive, nullable=False)

    def __repr__(self) -> str:
        return f"<TaskJob #{self.id} type={self.task_type} status={self.status} attempts={self.attempts}/{self.max_attempts}>"
