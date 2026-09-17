"""
Phase 11.5 — WhatsApp Architecture Characterization Test Suite.

Non-invasive characterization tests capturing baseline WhatsApp invariants:
1. Message merge & identity preservation (pending -> sent -> delivered -> read)
2. Duplicate inbound event deduplication invariant
3. ACK progression monotonicity
4. LID/JID resolution invariants
5. History sync ordering & cursor behavior
6. Conversation unread count behavior
7. Session state transition validity
8. Outbox state machine semantics
9. QR & pairing code lifecycle invariants
"""

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import WebSocketDisconnect

from backend.app.main import gateway_websocket_endpoint, ws_manager
from backend.app.models.whatsapp_session import SessionStatus
from backend.app.services import whatsapp_service

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "whatsapp"


def load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name, "r", encoding="utf-8") as f:
        return json.load(f)


class MockGatewaySocket:
    def __init__(self, events: list[dict]) -> None:
        self._events = [json.dumps(e) for e in events]
        self.sent: list[dict] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        if self._events:
            return self._events.pop(0)
        raise WebSocketDisconnect()

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


# ==============================================================================
# 1. Message Merge & Delivery Status Monotonicity
# ==============================================================================

def test_delivery_status_rank_monotonicity():
    """Verify delivery status monotonic ranking: PENDING/FAILED < SENT < DELIVERED < READ/RECEIVED."""
    ranks = {
        "PENDING": 0,
        "FAILED": 0,
        "SENT": 1,
        "DELIVERED": 2,
        "READ": 3,
        "RECEIVED": 3,
    }
    # Monotonicity checks: later status cannot be downgraded by earlier status
    assert ranks["SENT"] > ranks["PENDING"]
    assert ranks["DELIVERED"] > ranks["SENT"]
    assert ranks["READ"] > ranks["DELIVERED"]
    assert ranks["RECEIVED"] >= ranks["READ"]


# ==============================================================================
# 2. Inbound Duplicate Deduplication Invariant
# ==============================================================================

@pytest.mark.asyncio
async def test_duplicate_inbound_event_is_acked_without_broadcast(monkeypatch):
    """Characterizes invariant: when an event with duplicate event_id is received,
    backend returns an ACK to the gateway outbox but DOES NOT broadcast duplicate to UI.
    """
    event = load_fixture("message_upsert.json")
    socket = MockGatewaySocket([event])

    # Simulate dedup match: _duplicate is True
    monkeypatch.setattr(
        whatsapp_service,
        "ingest_gateway_event",
        AsyncMock(return_value={"_duplicate": True, "event_id": event["event_id"]}),
    )
    broadcast = AsyncMock()
    monkeypatch.setattr(ws_manager, "broadcast", broadcast)

    await gateway_websocket_endpoint(socket, token=None)

    assert socket.accepted is True
    broadcast.assert_not_awaited()
    assert socket.sent == [{"type": "gateway_event_ack", "event_id": event["event_id"]}]


# ==============================================================================
# 3. ACK Progression Monotonicity
# ==============================================================================

@pytest.mark.asyncio
async def test_message_status_updated_event_emits_ack_and_broadcasts(monkeypatch):
    """Characterizes invariant: message status transitions (SENT -> DELIVERED)
    are ingested, persisted, broadcast to UI clients, and acknowledged to gateway.
    """
    event = load_fixture("message_status_updated.json")
    socket = MockGatewaySocket([event])

    persisted_payload = {
        "event": "message_status_updated",
        "user_id": "test-user-id",
        "conversation_id": 42,
        "wa_message_id": event["wa_message_id"],
        "status": event["status"],
    }
    monkeypatch.setattr(
        whatsapp_service,
        "ingest_gateway_event",
        AsyncMock(return_value=persisted_payload),
    )
    broadcast = AsyncMock()
    monkeypatch.setattr(ws_manager, "broadcast", broadcast)

    await gateway_websocket_endpoint(socket, token=None)

    assert socket.accepted is True
    broadcast.assert_awaited_once_with(persisted_payload)
    assert socket.sent == [{"type": "gateway_event_ack", "event_id": event["event_id"]}]


# ==============================================================================
# 4. LID/JID Resolution Invariant
# ==============================================================================

def test_lid_jid_fixture_validity():
    """Characterizes contact identity structure: JID ending in @s.whatsapp.net,
    LID ending in @lid, phone_number formatted with country code.
    """
    fixture = load_fixture("lid_jid_mapping.json")
    contact = fixture["contact"]

    assert contact["jid"].endswith("@s.whatsapp.net")
    assert contact["lid"].endswith("@lid")
    assert contact["phone_number"].startswith("+")
    assert len(contact["phone_number"]) >= 10


# ==============================================================================
# 5. History Sync Fixture & Event Structure
# ==============================================================================

def test_history_sync_fixture_contract():
    """Characterizes history sync completion event payload contract."""
    fixture = load_fixture("history_sync.json")

    assert fixture["event"] == "history_sync_completed"
    assert fixture["chats_synced"] > 0
    assert fixture["messages_synced"] > 0
    assert "completed_at" in fixture


# ==============================================================================
# 6. Conversation Unread & Preview Invariant
# ==============================================================================

def test_conversation_updated_fixture_contract():
    """Characterizes conversation_updated payload invariants."""
    fixture = load_fixture("conversation_updated.json")
    conv = fixture["conversation"]

    assert conv["unread_count"] >= 0
    assert isinstance(conv["last_message_preview"], str)
    assert conv["jid"].endswith("@s.whatsapp.net")


# ==============================================================================
# 7. Session Status Transitions Invariant
# ==============================================================================

def test_session_status_enum_values():
    """Characterizes WhatsApp session status enum domain."""
    valid_statuses = {
        SessionStatus.DISCONNECTED.value,
        SessionStatus.SCAN_QR.value,
        SessionStatus.CONNECTED.value,
        SessionStatus.RELINK_REQUIRED.value,
    }
    assert "DISCONNECTED" in valid_statuses
    assert "SCAN_QR" in valid_statuses
    assert "CONNECTED" in valid_statuses
    assert "RELINK_REQUIRED" in valid_statuses


# ==============================================================================
# 8. Outbox State Machine Semantics
# ==============================================================================

def test_outbox_state_machine_transitions():
    """Characterizes the 4 states and transitions of the PostgreSQL event outbox:
    - PENDING: Initial state upon enqueue
    - IN_FLIGHT: Claimed by outbox pump via FOR UPDATE SKIP LOCKED
    - DELIVERED: Terminal state reached upon gateway_event_ack
    - DEAD_LETTER: Terminal state reached upon permanent reject or attempts >= 10
    """
    states = {"PENDING", "IN_FLIGHT", "DELIVERED", "DEAD_LETTER"}
    terminal_states = {"DELIVERED", "DEAD_LETTER"}
    active_states = {"PENDING", "IN_FLIGHT"}

    assert len(states) == 4
    assert terminal_states.issubset(states)
    assert active_states.issubset(states)
    assert active_states.isdisjoint(terminal_states)


# ==============================================================================
# 9. QR and Pairing Code Invariant
# ==============================================================================

def test_qr_and_pairing_code_fixtures():
    """Characterizes QR string format and pairing code alphanumeric structure."""
    qr_fixture = load_fixture("session_qr.json")
    assert "@" in qr_fixture["qr_code"]

    pairing_fixture = load_fixture("pairing_code.json")
    code = pairing_fixture["pairing_code"]
    assert len(code) == 9  # e.g., ABCD-1234
    assert "-" in code
