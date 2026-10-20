from datetime import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field, ConfigDict


class TaskJobResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    task_type: str
    status: str
    priority: int
    attempts: int
    max_attempts: int
    progress_percent: int
    progress_message: Optional[str] = None
    last_error: Optional[str] = None
    result_summary: Optional[Dict[str, Any]] = None
    scheduled_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime


class TaskListResponse(BaseModel):
    items: List[TaskJobResponse]
    total: int


class EnqueueTaskRequest(BaseModel):
    task_type: str = Field(..., description="Çalıştırılacak görev türü (örn: SCRAPER_RUN, CAMPAIGN_DISPATCH)")
    payload: Dict[str, Any] = Field(default_factory=dict, description="Görevin parametreleri")
    priority: int = Field(default=0, description="Öncelik (büyük sayılar önce çalışır)")
