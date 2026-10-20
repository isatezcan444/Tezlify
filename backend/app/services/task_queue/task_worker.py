import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, Callable, Coroutine, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.task_queue import TaskJob, TaskJobStatus

logger = logging.getLogger(__name__)

TaskHandler = Callable[[TaskJob, AsyncSession], Coroutine[Any, Any, Any]]


class TaskWorker:
    """Arka plan iş kuyruğu yürütücüsü (Worker)."""

    _handlers: Dict[str, TaskHandler] = {}
    _running: bool = False
    _worker_task: Optional[asyncio.Task] = None

    @classmethod
    def register_handler(cls, task_type: str, handler: TaskHandler) -> None:
        """Belirtilen görev türü için bir async işleyici fonksiyonu kaydeder."""
        cls._handlers[task_type] = handler
        logger.info("[TASK_WORKER] Registered handler for task type: %s", task_type)

    @classmethod
    async def process_one_job(cls, db: AsyncSession) -> bool:
        """
        Kuyruktan sıradaki en öncelikli işi alır ve yürütür.
        İş varsa ve işlendiyse True, kuyruk boşsa False döner.
        """
        now = utc_now_naive()

        # 1. Sıradaki işi bul
        stmt = (
            select(TaskJob)
            .where(
                TaskJob.status.in_([TaskJobStatus.PENDING, TaskJobStatus.RETRYING]),
                TaskJob.scheduled_at <= now,
            )
            .order_by(TaskJob.priority.desc(), TaskJob.created_at.asc())
            .limit(1)
        )
        res = await db.execute(stmt)
        job = res.scalar_one_or_none()

        if not job:
            return False

        # 2. İşi RUNNING durumuna al ve kitle
        job.status = TaskJobStatus.RUNNING
        job.started_at = now
        job.attempts += 1
        job.updated_at = now
        await db.commit()
        await db.refresh(job)

        handler = cls._handlers.get(job.task_type)
        if not handler:
            job.status = TaskJobStatus.FAILED
            job.last_error = f"Bu görev türü için işleyici bulunamadı: {job.task_type}"
            job.completed_at = utc_now_naive()
            job.updated_at = utc_now_naive()
            await db.commit()
            logger.error("[TASK_WORKER] No handler for task #%d type=%s", job.id, job.task_type)
            return True

        # 3. İşi yürüt
        try:
            logger.info("[TASK_WORKER] Executing task #%d type=%s (attempt %d/%d)", job.id, job.task_type, job.attempts, job.max_attempts)
            result = await handler(job, db)
            
            job.status = TaskJobStatus.COMPLETED
            job.progress_percent = 100
            job.progress_message = "Tamamlandı"
            job.result_summary = result if isinstance(result, dict) else {"result": str(result)}
            job.completed_at = utc_now_naive()
            job.updated_at = utc_now_naive()
            await db.commit()
            logger.info("[TASK_WORKER] Task #%d completed successfully", job.id)
        except Exception as exc:
            logger.exception("[TASK_WORKER] Task #%d failed with error: %s", job.id, exc)
            now_err = utc_now_naive()
            job.last_error = str(exc)
            job.updated_at = now_err

            if job.attempts < job.max_attempts:
                job.status = TaskJobStatus.RETRYING
                # Exponential backoff: 5s, 10s, 20s...
                backoff_delay = min(300, (2 ** job.attempts) * 5)
                job.scheduled_at = now_err + timedelta(seconds=backoff_delay)
                job.progress_message = f"Hata alındı, {backoff_delay} sn sonra tekrar denenecek ({job.attempts}/{job.max_attempts})"
                logger.warning("[TASK_WORKER] Task #%d will retry in %d seconds", job.id, backoff_delay)
            else:
                job.status = TaskJobStatus.FAILED
                job.completed_at = now_err
                job.progress_message = f"Maksimum deneme ({job.max_attempts}) aşıldı ve başarısız oldu."
                logger.error("[TASK_WORKER] Task #%d permanently failed after %d attempts", job.id, job.attempts)

            await db.commit()

        return True

    @classmethod
    async def recover_stranded_tasks(cls) -> int:
        """
        Sunucu yeniden başlatıldığında açıkta kalan RUNNING durumundaki işleri kurtarır.
        """
        async with AsyncSessionLocal() as db:
            stmt = select(TaskJob).where(TaskJob.status == TaskJobStatus.RUNNING)
            res = await db.execute(stmt)
            stranded_jobs = res.scalars().all()

            recovered = 0
            for job in stranded_jobs:
                if job.attempts < job.max_attempts:
                    job.status = TaskJobStatus.PENDING
                    job.progress_message = "Sunucu yeniden başlatıldı; iş kuyrukta yeniden sıraya alındı."
                else:
                    job.status = TaskJobStatus.FAILED
                    job.completed_at = utc_now_naive()
                    job.last_error = "Sunucu yeniden başlatıldı ve görev yarım kaldı."
                job.updated_at = utc_now_naive()
                recovered += 1

            if recovered:
                await db.commit()
                logger.warning("[TASK_WORKER] Recovered %d stranded tasks from previous crash/restart", recovered)
            return recovered

    @classmethod
    async def run_worker_loop(cls, poll_interval: float = 2.0) -> None:
        """Arka plan döngüsü."""
        cls._running = True
        logger.info("[TASK_WORKER] Background task worker started.")
        while cls._running:
            try:
                async with AsyncSessionLocal() as db:
                    ran = await cls.process_one_job(db)
                if not ran:
                    await asyncio.sleep(poll_interval)
            except asyncio.CancelledError:
                logger.info("[TASK_WORKER] Worker loop cancelled.")
                break
            except Exception as exc:
                logger.error("[TASK_WORKER] Loop error: %s", exc)
                await asyncio.sleep(poll_interval)

    @classmethod
    def start(cls) -> None:
        """Worker döngüsünü arka planda başlatır."""
        if cls._worker_task is None or cls._worker_task.done():
            cls._worker_task = asyncio.create_task(cls.run_worker_loop())

    @classmethod
    def stop(cls) -> None:
        """Worker döngüsünü durdurur."""
        cls._running = False
        if cls._worker_task and not cls._worker_task.done():
            cls._worker_task.cancel()
