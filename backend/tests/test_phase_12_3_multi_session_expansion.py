"""Phase 12.3 Multi-Session Background History Expansion Regression Tests.

Validates the surgical multi-session fix where history expansion tracking states
(_history_expansion_running and _history_expansion_done) are scoped by (user_id, gateway_id)
tuples rather than user_id strings:
- TEST-MS-01: Same user + gateway1 starts expansion.
- TEST-MS-02: When gateway1 finishes, gateway2 expansion is NOT blocked.
- TEST-MS-03: When gateway2 completes, gateway1 state is unmodified.
- TEST-MS-04: Same user + same gateway duplicate expansion cannot be started.
- TEST-MS-05: history_sync_completed for gateway1 cannot alter gateway2 state.
- TEST-MS-06: 3 different WhatsApp sessions under the same user have independent expansion states.
- TEST-MS-07: Session deletion/reconnect clears/resets the specific gateway key safely.
- TEST-MS-08: Tuple scope preserves single-session Session 50 behavior without regression.
"""
import asyncio
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.orchestration.sync import (
    WhatsAppSyncOrchestrator,
    reset_history_expansion_state,
)


@pytest.fixture(autouse=True)
def clean_expansion_registry():
    """Ensure clean expansion registry for each test."""
    orchestrator = WhatsAppSyncOrchestrator()
    orchestrator._history_expansion_running.clear()
    orchestrator._history_expansion_done.clear()
    yield
    orchestrator._history_expansion_running.clear()
    orchestrator._history_expansion_done.clear()


@pytest.mark.asyncio
async def test_ms_01_user_and_gateway1_starts_expansion(monkeypatch):
    """TEST-MS-01: Same user + gateway1 starts background expansion."""
    orchestrator = WhatsAppSyncOrchestrator()
    user_id = "user-tenant-1"
    gw1 = "gateway-line-1"

    key1 = (user_id, gw1)
    assert key1 not in orchestrator._history_expansion_running
    assert key1 not in orchestrator._history_expansion_done

    # Mock DB select and hydration
    db = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    db.execute.return_value = mock_result
    context = AsyncMock()
    context.__aenter__.return_value = db

    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_hydrate_messages_on_demand": AsyncMock(),
    }.get(name, default))

    await orchestrator._run_background_history_expansion(user_id, gw1)

    assert key1 in orchestrator._history_expansion_done
    assert key1 not in orchestrator._history_expansion_running


@pytest.mark.asyncio
async def test_ms_02_gateway1_completion_does_not_block_gateway2(monkeypatch):
    """TEST-MS-02: When gateway1 finishes, gateway2 expansion for the same user is NOT blocked."""
    orchestrator = WhatsAppSyncOrchestrator()
    user_id = "user-tenant-1"
    gw1 = "gateway-line-1"
    gw2 = "gateway-line-2"

    key1 = (user_id, gw1)
    key2 = (user_id, gw2)

    # Line 1 is already marked done
    orchestrator._history_expansion_done.add(key1)

    # Verify Line 2 is not blocked
    assert key2 not in orchestrator._history_expansion_done
    assert key2 not in orchestrator._history_expansion_running

    db = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    db.execute.return_value = mock_result
    context = AsyncMock()
    context.__aenter__.return_value = db

    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_hydrate_messages_on_demand": AsyncMock(),
    }.get(name, default))

    await orchestrator._run_background_history_expansion(user_id, gw2)

    # Both must now be done
    assert key1 in orchestrator._history_expansion_done
    assert key2 in orchestrator._history_expansion_done


@pytest.mark.asyncio
async def test_ms_03_gateway2_completion_does_not_mutate_gateway1_state(monkeypatch):
    """TEST-MS-03: When gateway2 completes, gateway1 state remains untouched."""
    orchestrator = WhatsAppSyncOrchestrator()
    user_id = "user-tenant-1"
    gw1 = "gateway-line-1"
    gw2 = "gateway-line-2"

    key1 = (user_id, gw1)
    key2 = (user_id, gw2)

    orchestrator._history_expansion_running.add(key1)

    db = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    db.execute.return_value = mock_result
    context = AsyncMock()
    context.__aenter__.return_value = db

    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_hydrate_messages_on_demand": AsyncMock(),
    }.get(name, default))

    await orchestrator._run_background_history_expansion(user_id, gw2)

    assert key1 in orchestrator._history_expansion_running
    assert key1 not in orchestrator._history_expansion_done
    assert key2 in orchestrator._history_expansion_done


@pytest.mark.asyncio
async def test_ms_04_same_user_and_gateway_cannot_start_duplicate_expansion(monkeypatch):
    """TEST-MS-04: Same user + same gateway duplicate expansion cannot be started."""
    orchestrator = WhatsAppSyncOrchestrator()
    user_id = "user-tenant-1"
    gw1 = "gateway-line-1"
    key1 = (user_id, gw1)

    orchestrator._history_expansion_running.add(key1)

    mock_db = AsyncMock()
    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: {
        "AsyncSessionLocal": mock_db,
    }.get(name, default))

    # Should exit immediately without accessing DB
    await orchestrator._run_background_history_expansion(user_id, gw1)
    mock_db.assert_not_called()


@pytest.mark.asyncio
async def test_ms_05_history_sync_completed_gateway1_does_not_affect_gateway2(monkeypatch):
    """TEST-MS-05: history_sync_completed on gateway1 does not alter gateway2 state."""
    sync_orchestrator = WhatsAppSyncOrchestrator()
    user_id = "user-tenant-1"
    gw1 = "gateway-line-1"
    gw2 = "gateway-line-2"

    key1 = (user_id, gw1)
    key2 = (user_id, gw2)

    sync_orchestrator._history_expansion_done.add(key1)

    event_orchestrator = WhatsAppEventOrchestrator()
    db = AsyncMock()
    db.bind = None
    context = AsyncMock()
    context.__aenter__.return_value = db

    monkeypatch.setattr(event_orchestrator, "_get_helper", lambda name, default=None: {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_passthrough_event": AsyncMock(return_value={"event": "history_sync_completed", "user_id": user_id}),
    }.get(name, default))

    await event_orchestrator.ingest_gateway_event({
        "event": "history_sync_completed",
        "gateway_session_id": gw1,
        "chats_synced": 2,
        "messages_synced": 50,
    })

    assert key1 in sync_orchestrator._history_expansion_done
    assert key2 not in sync_orchestrator._history_expansion_done
    assert key2 not in sync_orchestrator._history_expansion_running


@pytest.mark.asyncio
async def test_ms_06_three_sessions_have_independent_expansion_states(monkeypatch):
    """TEST-MS-06: 3 different WhatsApp sessions under the same user have independent expansion states."""
    orchestrator = WhatsAppSyncOrchestrator()
    user_id = "user-tenant-multiline"
    gw1 = "gw-line-1"
    gw2 = "gw-line-2"
    gw3 = "gw-line-3"

    key1 = (user_id, gw1)
    key2 = (user_id, gw2)
    key3 = (user_id, gw3)

    db = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    db.execute.return_value = mock_result
    context = AsyncMock()
    context.__aenter__.return_value = db

    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_hydrate_messages_on_demand": AsyncMock(),
    }.get(name, default))

    # Expand Line 1
    await orchestrator._run_background_history_expansion(user_id, gw1)
    assert key1 in orchestrator._history_expansion_done
    assert key2 not in orchestrator._history_expansion_done
    assert key3 not in orchestrator._history_expansion_done

    # Expand Line 3
    await orchestrator._run_background_history_expansion(user_id, gw3)
    assert key1 in orchestrator._history_expansion_done
    assert key2 not in orchestrator._history_expansion_done
    assert key3 in orchestrator._history_expansion_done


@pytest.mark.asyncio
async def test_ms_07_session_deletion_or_reconnect_resets_specific_gateway_key():
    """TEST-MS-07: Session deletion/reconnect clears/resets the specific gateway key safely."""
    orchestrator = WhatsAppSyncOrchestrator()
    user_id = "user-tenant-reconnect"
    gw1 = "gw-line-active"
    gw2 = "gw-line-to-reset"

    key1 = (user_id, gw1)
    key2 = (user_id, gw2)

    orchestrator._history_expansion_done.add(key1)
    orchestrator._history_expansion_done.add(key2)
    orchestrator._history_expansion_running.add(key2)

    # Reset only gw2
    orchestrator.reset_history_expansion_state(user_id, gateway_id=gw2)

    assert key1 in orchestrator._history_expansion_done  # gw1 untouched
    assert key2 not in orchestrator._history_expansion_done  # gw2 cleared
    assert key2 not in orchestrator._history_expansion_running  # gw2 cleared

    # Reset all for user
    orchestrator.reset_history_expansion_state(user_id)
    assert key1 not in orchestrator._history_expansion_done


@pytest.mark.asyncio
async def test_ms_08_tuple_scope_preserves_single_session_behavior(monkeypatch):
    """TEST-MS-08: Tuple scope preserves single-session Session 50 behavior without regression."""
    orchestrator = WhatsAppSyncOrchestrator()
    user_id = "f65642ab-4ae5-4d69-945c-8f30c8454bac"
    gw50 = "19fa1b9b-b58e-44bb-a75f-583090524edf"
    key50 = (user_id, gw50)

    db = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    db.execute.return_value = mock_result
    context = AsyncMock()
    context.__aenter__.return_value = db

    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_hydrate_messages_on_demand": AsyncMock(),
    }.get(name, default))

    # First run expands and adds key50 to done
    await orchestrator._run_background_history_expansion(user_id, gw50)
    assert key50 in orchestrator._history_expansion_done
    assert key50 not in orchestrator._history_expansion_running

    # Subsequent run respects done state and exits early
    mock_hydrate = AsyncMock()
    monkeypatch.setattr(orchestrator, "_get_helper", lambda name, default=None: {
        "AsyncSessionLocal": MagicMock(return_value=context),
        "_hydrate_messages_on_demand": mock_hydrate,
    }.get(name, default))

    await orchestrator._run_background_history_expansion(user_id, gw50)
    mock_hydrate.assert_not_called()
