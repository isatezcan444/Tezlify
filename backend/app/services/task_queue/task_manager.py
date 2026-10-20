import logging
from datetime import datetime
from typing import Optional, List, Dict, Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.task_queue import TaskJob, TaskJobStatus

logger = logging.getLogger(__name__)


class TaskManager:
    """Kalıcı arka plan işlerini oluşturan, durumunu güncelleyen ve listeleyen yönetici."""

    @classmethod
    async def enqueue_task(
        cls,
        db: AsyncSession,
        task_type: str,
        payload: Dict[str, Any],
        user_id: Optional[str] = None,
        priority: int = 0,
        max_attempts: int = 3,
        scheduled_at: Optional[datetime] = None,
    ) -> TaskJob:
        """Kuyruğa yeni bir görev ekler ve veritabanına yazar."""
        now = utc_now_naive()
        job = TaskJob(
            task_type=task_type,
            payload=payload or {},
            status=TaskJobStatus.PENDING,
            priority=priority,
            attempts=0,
            max_attempts=max_attempts,
            user_id=str(user_id) if user_id else None,
            scheduled_at=scheduled_at or now,
            created_at=now,
            updated_at=now,
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        logger.info("[TASK_QUEUE] Enqueued task #%d type=%s user=%s priority=%d", job.id, task_type, user_id, priority)
        return job

    @classmethod
    async def get_task(cls, db: AsyncSession, task_id: int) -> Optional[TaskJob]:
        """Görev detayını ID ile getirir."""
        return await db.get(TaskJob, task_id)

    @classmethod
    async def list_tasks(
        cls,
        db: AsyncSession,
        user_id: Optional[str] = None,
        task_type: Optional[str] = None,
        status: Optional[TaskJobStatus] = None,
        limit: int = 50,
    ) -> List[TaskJob]:
        """Filtrelere göre görev listesini getirir."""
        stmt = select(TaskJob)
        if user_id:
            from backend.app.core.auth import get_user_filter
            stmt = stmt.where(get_user_filter(TaskJob.user_id, user_id))
        if task_type:
            stmt = stmt.where(TaskJob.task_type == task_type)
        if status:
            stmt = stmt.where(TaskJob.status == status)

        stmt = stmt.order_by(TaskJob.priority.desc(), TaskJob.created_at.desc()).limit(limit)
        res = await db.execute(stmt)
        return list(res.scalars().all())

    @classmethod
    async def cancel_task(
        cls,
        db: AsyncSession,
        task_id: int,
        user_id: Optional[str] = None,
    ) -> bool:
        """
        Görevi iptal eder. Yalnızca PENDING veya RETRYING durumundaki görevler iptal edilebilir.
        """
        job = await db.get(TaskJob, task_id)
        if not job:
            return False

        if user_id and job.user_id:
            from backend.app.core.auth import check_entity_ownership
            # Basit user id eşitlik kontrolü
            if str(job.user_id).replace("-", "").lower() != str(user_id).replace("-", "").lower():
                return False

        if job.status in (TaskJobStatus.COMPLETED, TaskJobStatus.CANCELLED):
            return False

        job.status = TaskJobStatus.CANCELLED
        job.completed_at = utc_now_naive()
        job.updated_at = utc_now_naive()
        await db.commit()
        await db.refresh(job)
        logger.info("[TASK_QUEUE] Cancelled task #%d", task_id)
        return True

    @classmethod
    async def update_progress(
        cls,
        db: AsyncSession,
        task_id: int,
        percent: int,
        message: Optional[str] = None,
    ) -> None:
        """Görevin ilerleme yüzdesini ve mesajını günceller."""
        now = utc_now_naive()
        stmt = (
            update(TaskJob)
            .where(TaskJob.id == task_id)
            .values(
                progress_percent=min(100, max(0, percent)),
                progress_message=message,
                updated_at=now,
            )
        )
        await db.execute(stmt)
        await db.commit()
