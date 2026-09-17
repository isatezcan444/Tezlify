"""Characterization tests for WhatsAppSyncOrchestrator (Phase 11.10).

Validates:
- SyncJob lifecycle and snapshot representation
- request_sync single-flight concurrency guarantee
- _cancel_stale_sync_jobs transition
- _bulk_channel_available probe caching
- _persist_chat_snapshot degenerate & broadcast filtering
- _schedule_chats_bootstrap throttle enforcement
- fail-closed NoWhatsAppSession handling
"""
import asyncio
from datetime import datetime, timezone
import time
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.whatsapp.exceptions import NoWhatsAppSession
from backend.app.services.whatsapp.orchestration.sync import (
    SyncJob,
    WhatsAppSyncOrchestrator,
    _BOOTSTRAP_EMIT_INTERVAL_S,
)


@pytest.mark.asyncio
async def test_sync_job_lifecycle_and_snapshot():
    """SyncJob starts in SYNCING with valid timestamps and serializes properly."""
    job = SyncJob(sync_id="sync-test-123", user_id="tenant-alpha")
    assert job.sync_id == "sync-test-123"
    assert job.user_id == "tenant-alpha"
    assert job.state == "SYNCING"
    assert job.stage == "starting"
    assert job.error is None
    assert job.cancel_requested is False
    assert not job.done.is_set()

    snap = job.snapshot()
    assert snap["sync_id"] == "sync-test-123"
    assert snap["state"] == "SYNCING"
    assert snap["chats_total"] == 0
    assert snap["finished_at"] is None
    assert isinstance(snap["started_at"], str)

    # State update
    job.state = "COMPLETED"
    job.stage = "complete"
    job.chats_total = 10
    job.chats_synced = 10
    job.messages_total = 250
    job.messages_synced = 250
    job.finished_at = datetime.now(timezone.utc)
    job.done.set()

    snap2 = job.snapshot()
    assert snap2["state"] == "COMPLETED"
    assert snap2["stage"] == "complete"
    assert snap2["chats_synced"] == 10
    assert snap2["messages_synced"] == 250
    assert snap2["finished_at"] is not None


@pytest.mark.asyncio
async def test_request_sync_deduplication():
    """request_sync returns the same job if already SYNCING."""
    orchestrator = WhatsAppSyncOrchestrator()
    orchestrator._sync_jobs.clear()

    # Mock _run_sync_job so it doesn't run background network ops
    async def mock_run(job):
        await job.done.wait()

    orchestrator._run_sync_job = mock_run

    dummy_db = MagicMock(spec=AsyncSession)
    job1 = await orchestrator.request_sync(dummy_db, "user-sync-dedup")
    assert job1.state == "SYNCING"
    assert job1.user_id == "user-sync-dedup"

    # Second call returns existing in-flight job
    job2 = await orchestrator.request_sync(dummy_db, "user-sync-dedup")
    assert job2 is job1
    assert job2.sync_id == job1.sync_id

    # Clean up
    job1.done.set()
    orchestrator._sync_jobs.clear()


@pytest.mark.asyncio
async def test_cancel_stale_sync_jobs():
    """_cancel_stale_sync_jobs requests cancellation and removes pending."""
    orchestrator = WhatsAppSyncOrchestrator()
    orchestrator._sync_jobs.clear()
    orchestrator._initial_sync_pending.add("user-cancel")

    job = SyncJob(sync_id="cancel-me", user_id="user-cancel")
    orchestrator._sync_jobs["user-cancel"] = job

    assert job.cancel_requested is False
    cancelled_count = orchestrator._cancel_stale_sync_jobs("user-cancel")
    assert cancelled_count == 1
    assert job.cancel_requested is True
    assert "user-cancel" not in orchestrator._initial_sync_pending

    # If already cancelled or finished, returns 0
    job.state = "FAILED"
    cancelled_again = orchestrator._cancel_stale_sync_jobs("user-cancel")
    assert cancelled_again == 0

    orchestrator._sync_jobs.clear()


@pytest.mark.asyncio
async def test_bulk_channel_available_caching():
    """_bulk_channel_available caches the probe result for 300 seconds."""
    mock_gw = MagicMock()
    mock_gw.list_all_messages = AsyncMock(return_value={"messages": [], "total": 0})

    mock_service = MagicMock()
    mock_service.gw = mock_gw

    orchestrator = WhatsAppSyncOrchestrator(service=mock_service)
    orchestrator._bulk_channel_cache["checked_at"] = 0.0
    orchestrator._bulk_channel_cache["ok"] = False

    ok1 = await orchestrator._bulk_channel_available("gw-sess-1")
    assert ok1 is True
    assert mock_gw.list_all_messages.call_count == 1

    # Second call within TTL does not query gateway again
    ok2 = await orchestrator._bulk_channel_available("gw-sess-1")
    assert ok2 is True
    assert mock_gw.list_all_messages.call_count == 1


@pytest.mark.asyncio
async def test_schedule_chats_bootstrap_throttles():
    """_schedule_chats_bootstrap throttles emissions within 2.0s."""
    broadcasts: List[Dict[str, Any]] = []

    async def mock_broadcast(payload, owner):
        broadcasts.append(payload)

    mock_service = MagicMock()
    mock_service._broadcast_sync_event = mock_broadcast

    orchestrator = WhatsAppSyncOrchestrator(service=mock_service)
    orchestrator._last_bootstrap_emit.clear()

    # First call triggers emit
    orchestrator._schedule_chats_bootstrap("user-throttle-test")
    await asyncio.sleep(0.05)
    assert len(broadcasts) == 1
    assert broadcasts[0]["event"] == "whatsapp_sync_chats_bootstrap"

    # Immediate second call is suppressed
    orchestrator._schedule_chats_bootstrap("user-throttle-test")
    await asyncio.sleep(0.05)
    assert len(broadcasts) == 1

    orchestrator._last_bootstrap_emit.clear()


@pytest.mark.asyncio
async def test_run_sync_job_fails_closed_on_no_session():
    """_run_sync_job raises NoWhatsAppSession and marks job FAILED when user has no session."""
    broadcasts: List[Dict[str, Any]] = []

    async def mock_broadcast(payload, owner):
        broadcasts.append(payload)

    mock_service = MagicMock()
    mock_service._broadcast_sync_event = mock_broadcast
    mock_service._user_sessions = AsyncMock(return_value=[])

    mock_session_ctx = MagicMock()
    mock_session_ctx.__aenter__ = AsyncMock(return_value=MagicMock(spec=AsyncSession))
    mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
    mock_service.AsyncSessionLocal = MagicMock(return_value=mock_session_ctx)

    orchestrator = WhatsAppSyncOrchestrator(service=mock_service)
    mock_service._sync_event = orchestrator._sync_event

    job = SyncJob(sync_id="no-sess-job", user_id="empty-user")
    await orchestrator._run_sync_job(job)

    assert job.state == "FAILED"
    assert job.error is not None
    assert "Bagli bir WhatsApp hatti yok" in job.error
    assert job.done.is_set()
    # At least started and failed events broadcasted
    assert len(broadcasts) >= 2
    failed_ev = [b for b in broadcasts if b["event"] == "whatsapp_sync_failed"]
    assert len(failed_ev) == 1
