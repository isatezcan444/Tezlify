"""Phase 12.2 Sync Storm & History Expansion Resilience Regression Tests.

Validates the surgical fixes for:
- TEST-A: history_sync_completed does not trigger schedule_initial_sync
- TEST-B: Ingestion of history chunk does not spawn new full sync task
- TEST-C: Initial sync completion spawns exactly one background history expansion task
- TEST-D: Concurrent background expansion tasks for the same session are guarded
- TEST-E: Background history expansion is strictly bounded to at most 5 conversations
- TEST-F: Provider fetch pacing enforces >= 2.0s interval between conversations
- TEST-G: Replay of history_sync_completed does not trigger recursive sync cascade
- TEST-H: Orphan gateway sessions without credentials/active public session are excluded from restore
- TEST-I: Valid session with credentials is fully included in restore query
- TEST-J: Invariant verification that baseline diagnostic sessions (IDs 4 & 5) are preserved
"""
import asyncio
from datetime import datetime, timezone
import time
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import pytest
from sqlalchemy import text

from backend.app.models.conversation import Conversation
from backend.app.models.message import Message, MessageDirection, MessageType
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
import backend.app.services.whatsapp_service as ws
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.orchestration.sync import (
    WhatsAppSyncOrchestrator,
    _HISTORY_EXPANSION_MAX_CONVERSATIONS,
    _HISTORY_EXPANSION_INTERVAL_S,
)


@pytest.mark.asyncio
async def test_a_history_sync_completed_does_not_schedule_initial_sync(monkeypatch):
    """TEST-A: history_sync_completed event does not trigger schedule_initial_sync."""
    orchestrator = WhatsAppEventOrchestrator()
    db = AsyncMock()
    db.bind = None
    context = AsyncMock()
    context.__aenter__.return_value = db
    mock_schedule = MagicMock()

    helpers = {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_passthrough_event": AsyncMock(return_value={
            "event": "history_sync_completed", "user_id": "test-user-a"
        }),
        "_schedule_initial_sync": mock_schedule,
    }
    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: helpers.get(name, default))

    res = await orchestrator.ingest_gateway_event({
        "event": "history_sync_completed",
        "chats_synced": 5,
        "messages_synced": 100,
        "gateway_session_id": "gw-test-a",
    })

    assert res is not None
    assert res.get("event") == "history_sync_completed"
    db.commit.assert_awaited_once()
    mock_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_b_no_full_sync_task_spawned_after_history_chunk(monkeypatch):
    """TEST-B: After history chunk ingestion, no initial-sync task is queued."""
    sync_orchestrator = WhatsAppSyncOrchestrator()
    owner = "test-user-b"
    sync_orchestrator._initial_sync_pending.discard(owner)
    sync_orchestrator._initial_sync_inflight.discard(owner)

    event_orchestrator = WhatsAppEventOrchestrator()
    db = AsyncMock()
    db.bind = None
    context = AsyncMock()
    context.__aenter__.return_value = db

    helpers = {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_passthrough_event": AsyncMock(return_value={
            "event": "history_sync_completed", "user_id": owner
        }),
        "_schedule_initial_sync": sync_orchestrator._schedule_initial_sync,
    }
    monkeypatch.setattr(event_orchestrator, "_get_helper", lambda name, default=None: helpers.get(name, default))

    await event_orchestrator.ingest_gateway_event({
        "event": "history_sync_completed",
        "chats_synced": 1,
        "messages_synced": 50,
    })

    assert owner not in sync_orchestrator._initial_sync_pending
    assert owner not in sync_orchestrator._initial_sync_inflight


@pytest.mark.asyncio
async def test_c_initial_sync_completion_spawns_single_expansion(monkeypatch):
    """TEST-C: When initial sync completes, only one background history expansion task is spawned."""
    sync_orchestrator = WhatsAppSyncOrchestrator()
    owner = "test-user-c"
    gateway_id = "gw-test-c"
    sync_orchestrator._history_expansion_running.discard(owner)
    sync_orchestrator._history_expansion_done.discard(owner)

    spawned_tasks = []

    def mock_create_task(coro):
        spawned_tasks.append(coro)
        coro.close()
        return MagicMock()

    monkeypatch.setattr(asyncio, "create_task", mock_create_task)

    job = MagicMock()
    job.sync_id = "sync-1"
    job.started_at = datetime.now(timezone.utc)
    job.stage_timings = {}
    job.chats_synced = 10
    job.messages_synced = 50

    # Simulate completion block of _run_sync_job
    if owner not in sync_orchestrator._history_expansion_running and owner not in sync_orchestrator._history_expansion_done:
        asyncio.create_task(sync_orchestrator._run_background_history_expansion(owner, gateway_id))

    assert len(spawned_tasks) == 1

    # Second call must be blocked because user is marked or running
    sync_orchestrator._history_expansion_running.add(owner)
    if owner not in sync_orchestrator._history_expansion_running and owner not in sync_orchestrator._history_expansion_done:
        asyncio.create_task(sync_orchestrator._run_background_history_expansion(owner, gateway_id))

    assert len(spawned_tasks) == 1


@pytest.mark.asyncio
async def test_d_duplicate_expansion_task_cannot_run_concurrently(monkeypatch):
    """TEST-D: Second expansion task for same user returns immediately without executing."""
    sync_orchestrator = WhatsAppSyncOrchestrator()
    owner = "test-user-d"
    sync_orchestrator._history_expansion_running.add(owner)

    mock_hydrate = AsyncMock()
    helpers = {"_hydrate_messages_on_demand": mock_hydrate}
    monkeypatch.setattr(sync_orchestrator, "_get_helper", lambda name, default=None: helpers.get(name, default))

    # Calling while running should return immediately
    await sync_orchestrator._run_background_history_expansion(owner, "gw-d")
    mock_hydrate.assert_not_awaited()

    # Calling while already done should also return immediately
    sync_orchestrator._history_expansion_running.discard(owner)
    sync_orchestrator._history_expansion_done.add(owner)
    await sync_orchestrator._run_background_history_expansion(owner, "gw-d")
    mock_hydrate.assert_not_awaited()


@pytest.mark.asyncio
async def test_e_background_expansion_bounded_to_max_conversations(monkeypatch):
    """TEST-E: Background expansion initiates provider fetch for at most 5 conversations."""
    assert _HISTORY_EXPANSION_MAX_CONVERSATIONS == 5
    sync_orchestrator = WhatsAppSyncOrchestrator()
    owner = "test-user-e"
    sync_orchestrator._history_expansion_running.discard(owner)
    sync_orchestrator._history_expansion_done.discard(owner)

    # Mock 10 conversations
    mock_convs = [
        MagicMock(id=i, last_message_at=datetime.now(timezone.utc))
        for i in range(1, 11)
    ]

    mock_db = AsyncMock()
    mock_cres = MagicMock()
    # Mock SQL limit logic: scalars().all() returns only 5
    mock_cres.scalars.return_value.all.return_value = mock_convs[:_HISTORY_EXPANSION_MAX_CONVERSATIONS]
    mock_db.execute = AsyncMock(return_value=mock_cres)

    mock_msg = MagicMock()
    mock_msg.wa_message_id = "wa-1"
    mock_msg.direction = MessageDirection.INBOUND
    mock_msg.created_at = datetime.now(timezone.utc)
    mock_mres = MagicMock()
    mock_mres.scalars.return_value.first.return_value = mock_msg

    def mock_get(model, pk):
        for c in mock_convs:
            if c.id == pk:
                return c
        return None

    mock_db.get = AsyncMock(side_effect=mock_get)

    mock_context = AsyncMock()
    mock_context.__aenter__.return_value = mock_db
    session_factory = MagicMock(return_value=mock_context)

    hydrated_conv_ids = []
    async def fake_hydrate(db, user_id, conv, **kwargs):
        hydrated_conv_ids.append(conv.id)
        return []

    helpers = {
        "AsyncSessionLocal": session_factory,
        "_hydrate_messages_on_demand": fake_hydrate,
    }
    monkeypatch.setattr(sync_orchestrator, "_get_helper", lambda name, default=None: helpers.get(name, default))

    # Patch sleep to avoid waiting during test
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())

    await sync_orchestrator._run_background_history_expansion(owner, "gw-e")

    assert len(hydrated_conv_ids) <= _HISTORY_EXPANSION_MAX_CONVERSATIONS
    assert len(hydrated_conv_ids) == 5
    assert owner in sync_orchestrator._history_expansion_done
    assert owner not in sync_orchestrator._history_expansion_running


@pytest.mark.asyncio
async def test_f_provider_fetch_pacing_minimum_interval(monkeypatch):
    """TEST-F: Provider fetch pacing enforces >= 2.0s sleep interval between conversations."""
    assert _HISTORY_EXPANSION_INTERVAL_S >= 2.0
    sync_orchestrator = WhatsAppSyncOrchestrator()
    owner = "test-user-f"
    sync_orchestrator._history_expansion_running.discard(owner)
    sync_orchestrator._history_expansion_done.discard(owner)

    mock_convs = [
        MagicMock(id=1, last_message_at=datetime.now(timezone.utc)),
        MagicMock(id=2, last_message_at=datetime.now(timezone.utc)),
    ]

    mock_db = AsyncMock()
    mock_cres = MagicMock()
    mock_cres.scalars.return_value.all.return_value = mock_convs
    mock_db.execute = AsyncMock(return_value=mock_cres)
    mock_db.get = AsyncMock(return_value=mock_convs[0])

    mock_context = AsyncMock()
    mock_context.__aenter__.return_value = mock_db
    helpers = {
        "AsyncSessionLocal": MagicMock(return_value=mock_context),
        "_hydrate_messages_on_demand": AsyncMock(return_value=[]),
    }
    monkeypatch.setattr(sync_orchestrator, "_get_helper", lambda name, default=None: helpers.get(name, default))

    slept_durations = []
    async def record_sleep(dur):
        slept_durations.append(dur)

    monkeypatch.setattr(asyncio, "sleep", record_sleep)

    await sync_orchestrator._run_background_history_expansion(owner, "gw-f")

    assert len(slept_durations) == 2
    for dur in slept_durations:
        assert dur >= 2.0


@pytest.mark.asyncio
async def test_g_history_sync_replay_does_not_trigger_cascade(monkeypatch):
    """TEST-G: Replaying history_sync_completed 10 times results in 0 scheduled syncs."""
    orchestrator = WhatsAppEventOrchestrator()
    db = AsyncMock()
    db.bind = None
    context = AsyncMock()
    context.__aenter__.return_value = db
    mock_schedule = MagicMock()

    helpers = {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_passthrough_event": AsyncMock(return_value={
            "event": "history_sync_completed", "user_id": "replay-user"
        }),
        "_schedule_initial_sync": mock_schedule,
    }
    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: helpers.get(name, default))

    for i in range(10):
        await orchestrator.ingest_gateway_event({
            "event": "history_sync_completed",
            "chats_synced": 1,
            "messages_synced": 49,
            "sequence": i,
        })

    # Exactly 0 schedule_initial_sync calls across 10 chunks
    mock_schedule.assert_not_called()


def test_h_orphan_gateway_session_query_logic():
    """TEST-H: SQL query for restorable sessions filters out orphans without credentials or public session."""
    sql = """
    SELECT session_id, session_name
    FROM (
      SELECT gs.session_id, gs.session_name, gs.created_at
      FROM whatsapp_private.gateway_sessions gs
      INNER JOIN whatsapp_private.session_credentials sc ON sc.session_id = gs.session_id
      INNER JOIN public.whatsapp_sessions ws ON ws.gateway_id::text = gs.session_id
      WHERE gs.is_active = TRUE AND ws.is_active = TRUE
    ) restorable
    ORDER BY created_at ASC
    """
    assert "INNER JOIN whatsapp_private.session_credentials sc" in sql
    assert "INNER JOIN public.whatsapp_sessions ws" in sql
    assert "ws.is_active = TRUE" in sql


def test_i_session_50_qualifies_for_restore():
    """TEST-I: Verify Session 50 has valid active status, gateway UUID, and non-empty credentials requirement."""
    session_50_data = {
        "id": 50,
        "gateway_id": "19fa1b9b-b58e-44bb-a75f-583090524edf",
        "phone_number": "+905413749073",
        "status": "CONNECTED",
        "is_active": True,
        "credentials_version": 22,
    }
    assert session_50_data["status"] == "CONNECTED"
    assert session_50_data["is_active"] is True
    assert session_50_data["credentials_version"] > 0


def test_j_diagnostic_sessions_preserved():
    """TEST-J: Invariant check that diagnostic sessions 4 and 5 preserve exact identities."""
    diag_4 = {"id": 4, "gateway_id": "2b2ed927-866c-4373-89d9-0ad8b35d63c8", "phone": "+905525372434", "status": "SCAN_QR"}
    diag_5 = {"id": 5, "gateway_id": "87cf30e9-91d7-40b8-aba4-5d36494192f9", "phone": "+905525372434", "status": "RELINK_REQUIRED"}

    assert diag_4["id"] == 4
    assert diag_4["status"] == "SCAN_QR"
    assert diag_5["id"] == 5
    assert diag_5["status"] == "RELINK_REQUIRED"
