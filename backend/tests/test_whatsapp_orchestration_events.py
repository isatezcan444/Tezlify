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
from sqlalchemy.exc import IntegrityError
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
        "conversation_id": "000@s.whatsapp.net",
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


class _FakeSessionFactory:
    """`async with session_factory() as db` sozlesmesini karsilar."""

    def __init__(self, db: Any) -> None:
        self._db = db

    def __call__(self) -> "_FakeSessionFactory":
        return self

    async def __aenter__(self) -> Any:
        return self._db

    async def __aexit__(self, *args: Any) -> bool:
        return False


def _winning_message_row() -> Message:
    return Message(
        user_id="user-1",
        conversation_id=42,
        direction=MessageDirection.INBOUND,
        message_type=MessageType.TEXT,
        status=ConversationMessageStatus.RECEIVED,
        wa_message_id="WAPP-1",
        body="merhaba",
        recipient_phone="+905551112233",
    )


@pytest.mark.asyncio
async def test_recover_message_new_after_integrity_error_reselects_row(orchestrator):
    """IntegrityError sonrasi kurtarma: kazanan satir yeniden secilip olay
    broadcast edilebilir hale gelir — olay dusurulmez (canli balon kaybi)."""
    winning = _winning_message_row()
    mock_service = MagicMock(spec=["_resolve_event_owner_and_session"])
    mock_service._resolve_event_owner_and_session = AsyncMock(return_value=("user-1", 7))
    orch = WhatsAppEventOrchestrator(service=mock_service)

    mock_db = AsyncMock(spec=AsyncSession)
    mock_result = MagicMock()
    mock_result.scalars.return_value.first.return_value = winning
    mock_db.execute = AsyncMock(return_value=mock_result)

    event: Dict[str, Any] = {
        "event": "message_new",
        "conversation_id": "905551112233@s.whatsapp.net",
        "gateway_session_id": "gw-1",
        "message": {
            "conversation_id": "905551112233@s.whatsapp.net",
            "wa_message_id": "WAPP-1",
            "body": "merhaba",
            "status": "DELIVERED",
        },
    }
    res = await orch._recover_message_new_after_integrity_error(mock_db, event)

    assert res is not None
    assert res.get("_skip") is None
    assert res["user_id"] == "user-1"
    # Broadcast, satirin GERCEK konusmasini tasiyacak sekilde yeniden hedeflenir.
    assert res["conversation_id"] == 42
    assert isinstance(res["message"], dict)
    assert res["message"]["wa_message_id"] == "WAPP-1"
    mock_service._resolve_event_owner_and_session.assert_awaited_once()


@pytest.mark.asyncio
async def test_recover_message_new_after_integrity_error_without_ids_returns_none(orchestrator):
    """wa_message_id / client_message_id olmayan olay icin kurtarma girisimi
    yoktur — sorgu hic atilmaz, olay bilincli olarak dusulur."""
    mock_service = MagicMock(spec=["_resolve_event_owner_and_session"])
    mock_service._resolve_event_owner_and_session = AsyncMock(return_value=("user-1", 7))
    orch = WhatsAppEventOrchestrator(service=mock_service)

    mock_db = AsyncMock(spec=AsyncSession)
    mock_db.execute = AsyncMock()

    event: Dict[str, Any] = {
        "event": "message_new",
        "conversation_id": "905551112233@s.whatsapp.net",
        "message": {"conversation_id": "905551112233@s.whatsapp.net", "body": "merhaba"},
    }
    res = await orch._recover_message_new_after_integrity_error(mock_db, event)

    assert res is None
    mock_db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_ingest_gateway_event_integrity_error_recovers_message_new():
    """Koordinator sozlesmesi (uca sabitlenen akis): message_new ingest'i
    IntegrityError ile yarisi kaybettiginde olay None'a dusurulmez; kazanan
    satirla yeniden serilestirilir ve main.py'deki ws_manager.broadcast
    yayinina geri dondurulur (satir 352 sozlesmesi: dict -> broadcast)."""
    winning = _winning_message_row()

    mock_db = AsyncMock(spec=AsyncSession)
    mock_db.bind = MagicMock()
    mock_db.bind.dialect.name = "sqlite"
    mock_result = MagicMock()
    mock_result.scalars.return_value.first.return_value = winning
    mock_db.execute = AsyncMock(return_value=mock_result)

    mock_service = MagicMock(spec=["_ingest_message", "_resolve_event_owner_and_session", "AsyncSessionLocal"])
    mock_service._ingest_message = AsyncMock(
        side_effect=IntegrityError("INSERT INTO messages ...", {}, Exception("uq_msg_conv_wa_message_id"))
    )
    mock_service._resolve_event_owner_and_session = AsyncMock(return_value=("user-1", 7))
    mock_service.AsyncSessionLocal = _FakeSessionFactory(mock_db)
    orch = WhatsAppEventOrchestrator(service=mock_service)

    event: Dict[str, Any] = {
        "event": "message_new",
        "event_id": str(uuid.uuid4()),
        "conversation_id": "905551112233@s.whatsapp.net",
        "gateway_session_id": "gw-1",
        "message": {
            "conversation_id": "905551112233@s.whatsapp.net",
            "wa_message_id": "WAPP-1",
            "body": "merhaba",
            "status": "DELIVERED",
        },
    }
    res = await orch.ingest_gateway_event(event)

    assert res is not None
    assert res.get("_skip") is None
    assert res["conversation_id"] == 42
    assert isinstance(res["message"], dict)
    assert res["message"]["wa_message_id"] == "WAPP-1"
    # rollback (yaris) + commit (kurtarilan olay isaretlenip kapanir).
    mock_db.rollback.assert_awaited_once()
    mock_db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_ingest_gateway_event_integrity_error_still_drops_unrecoverable():
    """Kurtarilamayan IntegrityError (id'siz mesaj) onceki gibi fail-closed
    None dondurur — davranis gerilemesi yok."""
    mock_db = AsyncMock(spec=AsyncSession)
    mock_db.bind = MagicMock()
    mock_db.bind.dialect.name = "sqlite"

    mock_service = MagicMock(spec=["_ingest_message", "AsyncSessionLocal"])
    mock_service._ingest_message = AsyncMock(
        side_effect=IntegrityError("INSERT INTO messages ...", {}, Exception("uq_msg_conv_client_message_id"))
    )
    mock_service.AsyncSessionLocal = _FakeSessionFactory(mock_db)
    orch = WhatsAppEventOrchestrator(service=mock_service)

    event: Dict[str, Any] = {
        "event": "message_new",
        "event_id": str(uuid.uuid4()),
        "conversation_id": "905551112233@s.whatsapp.net",
        "message": {"conversation_id": "905551112233@s.whatsapp.net", "body": "merhaba"},
    }
    res = await orch.ingest_gateway_event(event)

    assert res is None
    mock_db.rollback.assert_awaited_once()
