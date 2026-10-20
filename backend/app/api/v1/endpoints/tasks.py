import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.core.auth import AuthUser
from backend.app.auth.api.dependencies import get_current_user_unified
from backend.app.services.task_queue import TaskManager, TaskJobStatus
from backend.app.schemas.task_queue import (
    TaskJobResponse,
    TaskListResponse,
    EnqueueTaskRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("", response_model=TaskListResponse)
async def list_tasks(
    task_type: Optional[str] = Query(None, description="Görev türü filtresi"),
    status_filter: Optional[str] = Query(None, description="Durum filtresi (PENDING, RUNNING, COMPLETED, FAILED)"),
    limit: int = Query(50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
) -> TaskListResponse:
    """Kullanıcının arka plan görevlerini ve yürütme durumlarını listeler."""
    parsed_status = None
    if status_filter:
        try:
            parsed_status = TaskJobStatus(status_filter.upper())
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Geçersiz durum: {status_filter}",
            )

    jobs = await TaskManager.list_tasks(
        db=db,
        user_id=None if current_user.is_admin else current_user.id,
        task_type=task_type,
        status=parsed_status,
        limit=limit,
    )
    return TaskListResponse(
        items=[TaskJobResponse.model_validate(j) for j in jobs],
        total=len(jobs),
    )


@router.post("", response_model=TaskJobResponse, status_code=status.HTTP_201_CREATED)
async def enqueue_task(
    req: EnqueueTaskRequest,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
) -> TaskJobResponse:
    """Kuyruğa yeni bir görev ekler."""
    job = await TaskManager.enqueue_task(
        db=db,
        task_type=req.task_type,
        payload=req.payload,
        user_id=current_user.id,
        priority=req.priority,
    )
    return TaskJobResponse.model_validate(job)


@router.get("/{task_id}", response_model=TaskJobResponse)
async def get_task_details(
    task_id: int,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
) -> TaskJobResponse:
    """Belirli bir görevin anlık ilerleme ve durum detayını getirir."""
    job = await TaskManager.get_task(db, task_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Görev bulunamadı")

    if not current_user.is_admin and job.user_id:
        if str(job.user_id).replace("-", "").lower() != str(current_user.id).replace("-", "").lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bu göreve erişim yetkiniz yok")

    return TaskJobResponse.model_validate(job)


@router.post("/{task_id}/cancel", response_model=TaskJobResponse)
async def cancel_task(
    task_id: int,
    current_user: AuthUser = Depends(get_current_user_unified),
    db: AsyncSession = Depends(get_db),
) -> TaskJobResponse:
    """Bekleyen veya yeniden denenen bir görevi iptal eder."""
    success = await TaskManager.cancel_task(
        db=db,
        task_id=task_id,
        user_id=None if current_user.is_admin else current_user.id,
    )
    if not success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Görev iptal edilemedi veya zaten tamamlandı/iptal edildi",
        )

    job = await TaskManager.get_task(db, task_id)
    return TaskJobResponse.model_validate(job)
