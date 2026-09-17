"""History arriving during hydration must schedule a bounded trailing pass."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.services import whatsapp_service as ws


@pytest.mark.asyncio
async def test_history_notifications_coalesce_while_connected_duplicates_do_not(monkeypatch) -> None:
    owner = "notification-test"
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_started = asyncio.Event()
    calls = 0

    async def request(db: object, user_id: str) -> ws.SyncJob:
        nonlocal calls
        calls += 1
        job = ws.SyncJob(str(calls), user_id)
        if calls == 1:
            first_started.set()
            await release_first.wait()
        else:
            second_started.set()
        job.state = "COMPLETED"
        job.done.set()
        return job

    monkeypatch.setattr(ws, "request_sync", request)
    monkeypatch.setattr(ws, "AsyncSessionLocal", MagicMock(return_value=AsyncMock()))
    from backend.app.api.v1.websocket import ws_manager
    monkeypatch.setattr(ws_manager, "broadcast", AsyncMock())
    ws._schedule_initial_sync(owner)
    await asyncio.wait_for(first_started.wait(), 1)
    try:
        for _ in range(20):
            ws._schedule_initial_sync(owner)
        for _ in range(20):
            ws._schedule_initial_sync(owner, reconcile=True)
    finally:
        release_first.set()
    await asyncio.wait_for(second_started.wait(), 1)
    for _ in range(100):
        if owner not in ws._initial_sync_inflight:
            break
        await asyncio.sleep(0)
    assert calls == 2
    assert owner not in ws._initial_sync_inflight


@pytest.mark.asyncio
async def test_message_only_history_chunk_does_not_request_reconciliation(monkeypatch) -> None:
    db = AsyncMock()
    db.bind = None
    context = AsyncMock()
    context.__aenter__.return_value = db
    monkeypatch.setattr(ws, "AsyncSessionLocal", MagicMock(return_value=context))
    monkeypatch.setattr(ws, "_passthrough_event", AsyncMock(return_value={
        "event": "history_sync_completed", "user_id": "notification-test",
    }))
    schedule = MagicMock()
    monkeypatch.setattr(ws, "_schedule_initial_sync", schedule)
    await ws.ingest_gateway_event({
        "event": "history_sync_completed", "chats_synced": 0, "messages_synced": 50,
    })
    db.commit.assert_awaited_once()
    schedule.assert_not_called()


def test_session_deletion_clears_queued_reconciliation() -> None:
    owner = "notification-cancel-test"
    ws._initial_sync_pending.add(owner)
    ws._cancel_stale_sync_jobs(owner)
    assert owner not in ws._initial_sync_pending