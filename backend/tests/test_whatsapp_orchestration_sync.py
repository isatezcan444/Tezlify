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
from backend.app.services.whatsapp.orchestration import sync as sync_module
from backend.app.services.whatsapp.orchestration.sync import (
    SyncJob,
    WhatsAppSyncOrchestrator,
    _BOOTSTRAP_EMIT_INTERVAL_S,
    _gateway_sync_phase,
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
    # The cache is keyed by GATEWAY ID now, so seed a stale entry for THIS gateway
    # instead of relying on a global default.
    orchestrator._bulk_channel_cache["gw-sess-1"] = {"ok": False, "checked_at": 0.0}

    try:
        ok1 = await orchestrator._bulk_channel_available("gw-sess-1")
        assert ok1 is True
        assert mock_gw.list_all_messages.call_count == 1

        # Second call within TTL does not query gateway again
        ok2 = await orchestrator._bulk_channel_available("gw-sess-1")
        assert ok2 is True
        assert mock_gw.list_all_messages.call_count == 1
    finally:
        # Module-global: never leave an entry behind for another test.
        orchestrator._bulk_channel_cache.pop("gw-sess-1", None)


@pytest.mark.asyncio
async def test_bulk_channel_probe_is_cached_PER_GATEWAY():
    """Bir hattin probe sonucu YALNIZCA o hatti baglar.

    Regresyon: `_bulk_channel_cache` eskiden anahtarsiz TEK bir duz sozluktu, yani
    ilk probe'un sonucu 300 sn boyunca HER hat icin gecerli sayiliyordu. Bir hattin
    gecici gateway hatasi bu yuzden butun hatlari sessizce legacy per-chat sync'e
    dusuruyordu. Kaynak eski haline dondurulurse bu test KIRMIZI olur.
    """
    async def _probe(gateway_id, limit=1, offset=0):
        if gateway_id == "gw-broken":
            raise RuntimeError("gateway down")
        return {"messages": [], "total": 0}

    mock_service = MagicMock()
    mock_service.gw = MagicMock()
    mock_service.gw.list_all_messages = AsyncMock(side_effect=_probe)

    orchestrator = WhatsAppSyncOrchestrator(service=mock_service)
    orchestrator._bulk_channel_cache.pop("gw-broken", None)
    orchestrator._bulk_channel_cache.pop("gw-healthy", None)

    try:
        # The broken line caches its own negative result...
        assert await orchestrator._bulk_channel_available("gw-broken") is False
        # ...and the healthy line must NOT inherit it.
        assert await orchestrator._bulk_channel_available("gw-healthy") is True

        # The negative result stays scoped to its own gateway, and the healthy
        # one is served from its own cache entry (no third gateway call).
        assert await orchestrator._bulk_channel_available("gw-broken") is False
        assert await orchestrator._bulk_channel_available("gw-healthy") is True
        assert mock_service.gw.list_all_messages.call_count == 2
    finally:
        orchestrator._bulk_channel_cache.pop("gw-broken", None)
        orchestrator._bulk_channel_cache.pop("gw-healthy", None)


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


# ---------------------------------------------------------------------------
# Gateway history-sync readiness wait (production report 2026-10-02)
#
# The gateway emits `session_connected` BEFORE it starts its own history sync,
# and this job is scheduled on exactly that event. Without a wait the job
# snapshots a nearly-empty gateway and stamps `initial_sync_completed_at` while
# chats are still arriving, so the loading gate opens and the list keeps growing.
# ---------------------------------------------------------------------------


def test_gateway_sync_phase_reads_only_its_own_session():
    """Only the matching session's phase is read; everything else is `unknown`.

    `unknown` must NOT be treated as "still working" — that is what keeps a
    session the gateway cannot describe from pinning a job forever.
    """
    payload = [
        {"id": "gw-other", "sync": {"phase": "syncing"}},
        {"id": "gw-mine", "sync": {"phase": "ready"}},
    ]
    assert _gateway_sync_phase(payload, "gw-mine") == "ready"
    assert _gateway_sync_phase(payload, "gw-absent") == "unknown"
    # A payload that is not a list, a non-dict entry, or a missing `sync` field
    # are all "we cannot tell", never a blocking state.
    assert _gateway_sync_phase(None, "gw-mine") == "unknown"
    assert _gateway_sync_phase([{"id": "gw-mine"}], "gw-mine") == "unknown"
    assert _gateway_sync_phase([{"id": "gw-mine", "sync": {}}], "gw-mine") == "unknown"


@pytest.mark.asyncio
async def test_await_gateway_history_ready_does_not_block_when_not_syncing():
    """`ready` returns on the first probe — a re-sync must stay fast."""
    mock_service = MagicMock()
    mock_service.gw = MagicMock()
    mock_service.gw.list_sessions = AsyncMock(
        return_value=[{"id": "gw-ready", "sync": {"phase": "ready"}}]
    )
    orchestrator = WhatsAppSyncOrchestrator(service=mock_service)

    assert await orchestrator._await_gateway_history_ready("gw-ready") == "ready"
    assert mock_service.gw.list_sessions.call_count == 1


@pytest.mark.asyncio
async def test_await_gateway_history_ready_polls_while_syncing(monkeypatch):
    """`syncing` must BLOCK until the gateway says otherwise — the point of the fix."""
    phases = ["syncing", "syncing", "ready"]

    async def _sessions():
        return [{"id": "gw-slow", "sync": {"phase": phases.pop(0)}}]

    mock_service = MagicMock()
    mock_service.gw = MagicMock()
    mock_service.gw.list_sessions = AsyncMock(side_effect=_sessions)
    orchestrator = WhatsAppSyncOrchestrator(service=mock_service)
    monkeypatch.setattr(sync_module, "_GATEWAY_HISTORY_READY_POLL_S", 0.01)

    assert await orchestrator._await_gateway_history_ready("gw-slow") == "ready"
    assert mock_service.gw.list_sessions.call_count == 3


@pytest.mark.asyncio
async def test_await_gateway_history_ready_is_fail_open():
    """A gateway that cannot answer must never pin the job — return, do not hang.

    The job stays honest about a dead gateway anyway: the very next
    `list_conversations` call fails it.
    """
    mock_service = MagicMock()
    mock_service.gw = MagicMock()
    mock_service.gw.list_sessions = AsyncMock(side_effect=RuntimeError("gateway down"))
    orchestrator = WhatsAppSyncOrchestrator(service=mock_service)

    started = time.monotonic()
    assert await orchestrator._await_gateway_history_ready("gw-dead") == "unknown"
    assert time.monotonic() - started < 1.0, "an unreadable gateway must not be waited on"


@pytest.mark.asyncio
async def test_await_gateway_history_ready_gives_up_at_the_bound(monkeypatch):
    """A gateway stuck in `syncing` is abandoned after the bound, not forever."""
    mock_service = MagicMock()
    mock_service.gw = MagicMock()
    mock_service.gw.list_sessions = AsyncMock(
        return_value=[{"id": "gw-stuck", "sync": {"phase": "syncing"}}]
    )
    orchestrator = WhatsAppSyncOrchestrator(service=mock_service)
    monkeypatch.setattr(sync_module, "_GATEWAY_HISTORY_READY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(sync_module, "_GATEWAY_HISTORY_READY_POLL_S", 0.01)

    assert await orchestrator._await_gateway_history_ready("gw-stuck") == "syncing"
    assert mock_service.gw.list_sessions.call_count >= 2


@pytest.mark.asyncio
async def test_run_sync_job_waits_for_the_gateway_only_on_a_first_sync():
    """The readiness wait runs for a FIRST sync and is skipped once stamped.

    `session_connected` — the event this job is scheduled on — fires BEFORE the
    gateway starts its history sync, so a first sync must wait. A line that
    already carries the durable stamp must not wait, so a manual re-sync keeps
    behaving exactly as it did before.

    The job is expected to fail right after the wait (the gateway calls are not
    mocked here); only the WAIT DECISION is under test.
    """
    waited: List[str] = []

    class _FakeSession:
        def __init__(self, gateway_id: str, completed: Any) -> None:
            self.gateway_id = gateway_id
            self.initial_sync_completed_at = completed
            self.id = 7

    def _orchestrator_for(session: Any) -> WhatsAppSyncOrchestrator:
        mock_service = MagicMock()
        mock_service._broadcast_sync_event = AsyncMock()
        mock_service._user_sessions = AsyncMock(return_value=[session])
        ctx = MagicMock()
        ctx.__aenter__ = AsyncMock(return_value=MagicMock(spec=AsyncSession))
        ctx.__aexit__ = AsyncMock(return_value=None)
        mock_service.AsyncSessionLocal = MagicMock(return_value=ctx)

        async def _capture(gateway_id: str) -> str:
            waited.append(gateway_id)
            return "ready"

        mock_service._await_gateway_history_ready = _capture
        orchestrator = WhatsAppSyncOrchestrator(service=mock_service)
        mock_service._sync_event = orchestrator._sync_event
        return orchestrator

    # FIRST sync: the durable stamp is NULL -> the job must wait.
    await _orchestrator_for(_FakeSession("gw-first", None))._run_sync_job(
        SyncJob(sync_id="j-first", user_id="u-first")
    )
    assert waited == ["gw-first"], "a first sync must wait for the gateway's history sync"

    # Already synced: the stamp is present -> no wait at all.
    waited.clear()
    await _orchestrator_for(_FakeSession("gw-done", datetime(2026, 1, 1)))._run_sync_job(
        SyncJob(sync_id="j-done", user_id="u-done")
    )
    assert waited == [], "an already-synced line must not wait"


@pytest.mark.asyncio
async def test_run_sync_job_waits_for_in_flight_ephemeral_pairing_promotion(monkeypatch):
    """When an ephemeral pairing is active, _run_sync_job waits for promotion commit instead of failing."""
    from backend.app.services.whatsapp.orchestration import sessions as sessions_mod

    user_id = "test-promoting-user"
    token = "test-pair-token"
    sessions_mod._ephemeral_pairings[token] = {
        "user_id": user_id,
        "gateway_id": "gw-promoting",
    }

    try:
        class _FakeSession:
            def __init__(self) -> None:
                self.gateway_id = "gw-promoting"
                self.initial_sync_completed_at = datetime(2026, 1, 1)
                self.id = 99

        call_count = 0

        async def _user_sessions(db, owner, connected_only=True):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return []
            return [_FakeSession()]

        mock_service = MagicMock()
        mock_service._broadcast_sync_event = AsyncMock()
        mock_service._user_sessions = _user_sessions
        mock_service._bulk_channel_available = AsyncMock(return_value=False)
        mock_service._sync_conversations_impl = AsyncMock()
        mock_service._persist_chat_snapshot = AsyncMock(return_value=([], {}))
        mock_service.sync_contacts = AsyncMock(return_value=[])
        mock_service._reapply_chat_names = AsyncMock()
        mock_service._gateway_op_or_mark_relink = AsyncMock(return_value={"items": []})
        mock_service._schedule_metadata_enrichment = MagicMock()
        mock_service._run_background_history_expansion = AsyncMock()
        mock_service._repair_last_message_previews = AsyncMock()
        mock_service._repair_phone_sender_names = AsyncMock()
        mock_service.list_conversations = AsyncMock(return_value=([], 0))
        mock_service.gw = MagicMock()
        mock_service.gw.list_conversations = AsyncMock(return_value={"items": []})
        mock_service.gw.trigger_avatar_backfill = AsyncMock()

        mock_ctx = MagicMock()
        mock_db = MagicMock(spec=AsyncSession)
        mock_db.rollback = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_service.AsyncSessionLocal = MagicMock(return_value=mock_ctx)

        orchestrator = WhatsAppSyncOrchestrator(service=mock_service)
        mock_service._sync_event = orchestrator._sync_event

        job = SyncJob(sync_id="j-promote", user_id=user_id)
        await orchestrator._run_sync_job(job)

        assert job.state == "COMPLETED"
        assert job.error is None
        assert call_count >= 2
    finally:
        sessions_mod._ephemeral_pairings.pop(token, None)

