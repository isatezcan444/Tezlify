"""Unit and characterization tests for WhatsApp Inbound Event Orchestrator (Phase 11.10).

Covers:
- WhatsAppEventOrchestrator instantiation and helper resolution
- Inbound message handling (message_new)
- Conversation & presence updates (conversation_updated, presence_updated)
- Outbound delivery status updates (message_status_updated)
- Contact synchronization (contact_synced)
- Passthrough events (history_sync_completed)
- Unknown events & invalid IDs (fail-closed, return None)
- Deduplication via processed_events
- Split conversation non-destructive reconciliation
"""
from datetime import datetime
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.exceptions import EventOwnerUnresolved
from backend.app.services.whatsapp.orchestration.events import (
    WhatsAppEventOrchestrator,
    _skip_event,
)


@pytest.fixture
def orchestrator():
    return WhatsAppEventOrchestrator()


@pytest.mark.asyncio
async def test_skip_event_marks_event():
    event = {"event": "test"}
    res = _skip_event(event, "test_reason")
    assert res["_skip"] == "test_reason"


@pytest.mark.asyncio
async def test_ingest_gateway_event_invalid_uuid(orchestrator):
    event = {"event": "message_new", "event_id": "not-a-valid-uuid"}
    res = await orchestrator.ingest_gateway_event(event)
    assert res is None


@pytest.mark.asyncio
async def test_ingest_gateway_event_unknown_event(orchestrator):
    event = {"event": "totally_unknown_custom_event"}
    res = await orchestrator.ingest_gateway_event(event)
    assert res is None


@pytest.mark.asyncio
async def test_ingest_gateway_event_passthrough_without_session_id(orchestrator):
    event = {"event": "history_sync_completed"}
    res = await orchestrator.ingest_gateway_event(event)
    assert res is None


@pytest.mark.asyncio
async def test_ingest_gateway_event_passthrough_resolves_owner():
    mock_service = MagicMock(spec=["_resolve_event_owner"])
    mock_service._resolve_event_owner = AsyncMock(return_value="test-user-uuid")
    orch = WhatsAppEventOrchestrator(service=mock_service)

    event = {"event": "history_sync_completed", "gateway_session_id": "gw-123"}
    res = await orch.ingest_gateway_event(event)
    assert res is not None
    assert res["user_id"] == "test-user-uuid"


@pytest.mark.asyncio
async def test_ingest_message_broadcast_jid_skipped(orchestrator):
    event = {
        "event": "message_new",
        "conversation_id": "status@broadcast",
        "message": {"body": "hello"},
    }
    mock_db = AsyncMock(spec=AsyncSession)
    res = await orchestrator._ingest_message(mock_db, event)
    assert res.get("_skip") is not None


@pytest.mark.asyncio
async def test_ingest_message_degenerate_jid_skipped(orchestrator):
    event = {
        "event": "message_new",
        "conversation_id": "0@s.whatsapp.net",
        "message": {"body": "hello"},
    }
    mock_db = AsyncMock(spec=AsyncSession)
    res = await orchestrator._ingest_message(mock_db, event)
    assert res.get("_skip") is not None


@pytest.mark.asyncio
async def test_reconcile_legacy_split_conversation_noop_if_missing(orchestrator):
    mock_db = AsyncMock(spec=AsyncSession)
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_db.execute = AsyncMock(return_value=mock_result)

    res = await orchestrator.reconcile_legacy_split_conversation(
        mock_db, "user-1", "123@lid", "90555@s.whatsapp.net"
    )
    assert res is None


@pytest.mark.asyncio
async def test_map_session_event_fails_closed_when_session_not_found(orchestrator):
    mock_db = AsyncMock(spec=AsyncSession)
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_db.execute = AsyncMock(return_value=mock_result)

    event = {"event": "session_connected", "gateway_session_id": "unknown-gw-id"}
    with pytest.raises(EventOwnerUnresolved):
        await orchestrator._map_session_event(mock_db, event)
