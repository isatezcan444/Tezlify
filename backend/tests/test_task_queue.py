import pytest
import uuid
from datetime import datetime, timedelta
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.task_queue import TaskJob, TaskJobStatus
from backend.app.services.task_queue import TaskManager, TaskWorker


@pytest.fixture
def auth_headers():
    uid = str(uuid.uuid4())
    return {
        "X-Test-User-Id": uid,
        "X-Test-User-Email": f"tasks_{uid[:8]}@tezlify.com",
    }


@pytest.mark.asyncio
async def test_task_manager_enqueue_and_progress(auth_headers):
    user_id = auth_headers["X-Test-User-Id"]

    async with AsyncSessionLocal() as db:
        job = await TaskManager.enqueue_task(
            db=db,
            task_type="TEST_ACTION",
            payload={"action": "clean_data"},
            user_id=user_id,
            priority=5,
        )
        assert job.id is not None
        assert job.status == TaskJobStatus.PENDING
        assert job.priority == 5
        assert job.payload == {"action": "clean_data"}

        # Update progress
        await TaskManager.update_progress(db, job.id, percent=45, message="Processing records...")
        updated = await TaskManager.get_task(db, job.id)
        assert updated.progress_percent == 45
        assert updated.progress_message == "Processing records..."


@pytest.mark.asyncio
async def test_task_manager_cancellation(auth_headers):
    user_id = auth_headers["X-Test-User-Id"]

    async with AsyncSessionLocal() as db:
        job = await TaskManager.enqueue_task(
            db=db,
            task_type="TEST_CANCEL",
            payload={},
            user_id=user_id,
        )

        # Cancel should succeed
        cancelled = await TaskManager.cancel_task(db, job.id, user_id=user_id)
        assert cancelled is True

        updated = await TaskManager.get_task(db, job.id)
        assert updated.status == TaskJobStatus.CANCELLED

        # Second cancel should return False
        cancelled_again = await TaskManager.cancel_task(db, job.id, user_id=user_id)
        assert cancelled_again is False


@pytest.mark.asyncio
async def test_task_worker_execution_success(auth_headers):
    user_id = auth_headers["X-Test-User-Id"]

    async def mock_handler(task: TaskJob, db):
        return {"processed_count": 42, "status": "ok"}

    TaskWorker.register_handler("TEST_SUCCESS_JOB", mock_handler)

    async with AsyncSessionLocal() as db:
        job = await TaskManager.enqueue_task(
            db=db,
            task_type="TEST_SUCCESS_JOB",
            payload={"key": "value"},
            user_id=user_id,
            priority=10,
        )

        # Worker processes the job
        processed = await TaskWorker.process_one_job(db)
        assert processed is True

        updated = await TaskManager.get_task(db, job.id)
        assert updated.status == TaskJobStatus.COMPLETED
        assert updated.progress_percent == 100
        assert updated.result_summary == {"processed_count": 42, "status": "ok"}


@pytest.mark.asyncio
async def test_task_worker_retry_on_failure(auth_headers):
    user_id = auth_headers["X-Test-User-Id"]

    async def mock_failing_handler(task: TaskJob, db):
        raise RuntimeError("Transient upstream connection failed")

    TaskWorker.register_handler("TEST_FAIL_RETRY", mock_failing_handler)

    async with AsyncSessionLocal() as db:
        job = await TaskManager.enqueue_task(
            db=db,
            task_type="TEST_FAIL_RETRY",
            payload={},
            user_id=user_id,
            max_attempts=2,
            priority=20,
        )

        # 1. First execution failure -> RETRYING
        await TaskWorker.process_one_job(db)
        updated = await TaskManager.get_task(db, job.id)
        assert updated.status == TaskJobStatus.RETRYING
        assert updated.attempts == 1
        assert "Transient upstream connection failed" in updated.last_error

        # Force scheduled_at to past so it can be retried immediately
        updated.scheduled_at = utc_now_naive() - timedelta(minutes=1)
        await db.commit()

        # 2. Second execution failure -> exceeds max_attempts (2) -> FAILED
        await TaskWorker.process_one_job(db)
        permanently_failed = await TaskManager.get_task(db, job.id)
        assert permanently_failed.status == TaskJobStatus.FAILED
        assert permanently_failed.attempts == 2


@pytest.mark.asyncio
async def test_task_worker_recover_stranded_tasks():
    async with AsyncSessionLocal() as db:
        now = utc_now_naive()
        stranded = TaskJob(
            task_type="STRANDED_JOB",
            payload={},
            status=TaskJobStatus.RUNNING,
            attempts=1,
            max_attempts=3,
            scheduled_at=now,
            created_at=now,
            updated_at=now,
        )
        db.add(stranded)
        await db.commit()
        await db.refresh(stranded)

        # Recover
        recovered_count = await TaskWorker.recover_stranded_tasks()
        assert recovered_count >= 1

        await db.refresh(stranded)
        assert stranded.status == TaskJobStatus.PENDING
        assert "Sunucu yeniden başlatıldı" in stranded.progress_message


@pytest.mark.asyncio
async def test_task_api_endpoints(auth_headers):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Enqueue task via API
        payload = {
            "task_type": "API_TEST_TASK",
            "payload": {"city": "Istanbul", "keyword": "Dental"},
            "priority": 3,
        }
        res = await ac.post("/api/v1/tasks", json=payload, headers=auth_headers)
        assert res.status_code == 201
        data = res.json()
        task_id = data["id"]
        assert data["task_type"] == "API_TEST_TASK"
        assert data["status"] == "PENDING"

        # 2. Get task details
        res = await ac.get(f"/api/v1/tasks/{task_id}", headers=auth_headers)
        assert res.status_code == 200
        details = res.json()
        assert details["id"] == task_id

        # 3. List tasks
        res = await ac.get("/api/v1/tasks", headers=auth_headers)
        assert res.status_code == 200
        items = res.json()["items"]
        assert any(t["id"] == task_id for t in items)

        # 4. Cancel task
        res = await ac.post(f"/api/v1/tasks/{task_id}/cancel", headers=auth_headers)
        assert res.status_code == 200
        assert res.json()["status"] == "CANCELLED"
