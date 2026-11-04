"""Tests for WhatsApp Phase 7.4: Sync Loading Gate, Stale Sync Recovery and Offline Access.

Covers:
- resolve_gate_phase with disconnected/banned/error session statuses
- resolve_gate_phase with offline access when initial_sync_completed is True
- Stale sync timeout and dead task recovery in get_sync_job
- Auto-healing missing initial_sync_completed_at when conversations exist in DB
"""
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Dict
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from backend.app.services.whatsapp_service import resolve_gate_phase, get_loading_gate
from backend.app.services.whatsapp.orchestration.sync import SyncJob, WhatsAppSyncOrchestrator


def test_resolve_gate_phase_disconnected_unsynced():
    """An unsynced session that disconnects must NOT hang in syncing_history; it must fail-closed."""
    for status in ("DISCONNECTED", "BANNED", "ERROR", "RELINK_REQUIRED", "UNAVAILABLE"):
        phase, stage = resolve_gate_phase(
            job_state="IDLE",
            job_stage="idle",
            gw_phase="syncing",
            session_status=status,
            avatars_missing=0,
            initial_sync_completed=False,
        )
        assert phase == "error"
        assert stage == "disconnected"


def test_resolve_gate_phase_disconnected_already_synced():
    """An already-synced line that is disconnected must allow offline chat viewing ('ready')."""
    for status in ("DISCONNECTED", "BANNED", "ERROR", "RELINK_REQUIRED", "UNAVAILABLE"):
        phase, stage = resolve_gate_phase(
            job_state="IDLE",
            job_stage="idle",
            gw_phase="idle",
            session_status=status,
            avatars_missing=0,
            initial_sync_completed=True,
        )
        assert phase == "ready"
        assert stage == "complete"


def test_resolve_gate_phase_connecting():
    """Connecting/restoring states report connecting while socket comes up."""
    for status in ("CONNECTING", "RESTORING"):
        phase, stage = resolve_gate_phase(
            job_state="IDLE",
            job_stage="idle",
            gw_phase="idle",
            session_status=status,
            avatars_missing=0,
            initial_sync_completed=False,
        )
        assert phase == "connecting"
        assert stage == "connecting"


def test_resolve_gate_phase_failed_job():
    """A failed job must report error regardless of durable stamp."""
    phase, stage = resolve_gate_phase(
        job_state="FAILED",
        job_stage="messages",
        gw_phase="ready",
        session_status="CONNECTED",
        avatars_missing=0,
        initial_sync_completed=True,
    )
    assert phase == "error"
    assert stage == "messages"


def test_sync_orchestrator_dead_task_recovery():
    """Dead or cancelled background task must transition job to FAILED."""
    orch = WhatsAppSyncOrchestrator()
    job = SyncJob(sync_id="test1", user_id="user_123")
    orch._sync_jobs["user_123"] = job

    # Create a cancelled dummy task
    loop = asyncio.new_event_loop()
    try:
        async def dummy():
            pass
        task = loop.create_task(dummy())
        task.cancel()
        try:
            loop.run_until_complete(task)
        except asyncio.CancelledError:
            pass

        job.task = task
        snap = orch.get_sync_job("user_123")
        assert snap is not None
        assert snap["state"] == "FAILED"
        assert snap["stage"] == "cancelled"
    finally:
        loop.close()


def test_sync_orchestrator_timeout_recovery():
    """A job running for > 15 minutes without progress must time out."""
    orch = WhatsAppSyncOrchestrator()
    job = SyncJob(sync_id="test2", user_id="user_456")
    job.started_at = datetime.now(timezone.utc) - timedelta(minutes=16)
    orch._sync_jobs["user_456"] = job

    snap = orch.get_sync_job("user_456")
    assert snap is not None
    assert snap["state"] == "FAILED"
    assert snap["stage"] == "timeout"
    assert job.cancel_requested is True


@pytest.mark.asyncio
async def test_get_loading_gate_auto_stamps_when_chats_exist():
    """If DB already has chats for a connected session without initial_sync_completed_at, auto-stamp and open."""
    db = MagicMock()
    # Mock db.execute results:
    # 1. gid_row: scalar_one_or_none -> "gw-session-1"
    # 2. conv_cnt_query: scalar -> 5
    gid_result = MagicMock()
    gid_result.scalar_one_or_none.return_value = "gw-session-1"

    cnt_result = MagicMock()
    cnt_result.scalar.return_value = 5

    db.execute = AsyncMock(side_effect=[gid_result, cnt_result, MagicMock()])
    db.commit = AsyncMock()

    mock_sessions = [
        {
            "id": 10,
            "status": "CONNECTED",
            "initial_sync_completed": False,
            "sync": {"phase": "ready", "progress": 100},
        }
    ]

    with patch("backend.app.services.whatsapp_service._list_sessions_internal", AsyncMock(return_value=(mock_sessions, None))):
        with patch("backend.app.services.whatsapp_service._sync_orchestrator.get_sync_job", return_value=None):
            with patch("backend.app.services.whatsapp_service.gw.request_avatar_backfill", AsyncMock(return_value={"missing": 0})):
                gate = await get_loading_gate(db, "test_user")

    assert gate["phase"] == "ready"
    assert gate["stage"] == "complete"
    assert gate["progress"] == 100
    db.commit.assert_awaited_once()
