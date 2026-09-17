"""
Unit tests for WhatsApp pure message delivery & session status policy (Phase 11.6 Batch 2).
"""

from datetime import datetime
import pytest

from backend.app.models.message import ConversationMessageStatus
from backend.app.models.whatsapp_session import SessionStatus
from backend.app.services.whatsapp.status_policy import (
    DELIVERY_STATUS_RANKS,
    advance_message_status,
    parse_session_status,
    resolve_next_delivery_status,
    should_advance_status,
)


class DummyMessageRow:
    def __init__(self, status: ConversationMessageStatus) -> None:
        self.status = status
        self.sent_at: datetime | None = None
        self.delivered_at: datetime | None = None
        self.read_at: datetime | None = None
        self.error_message: str | None = "initial error"
        self.failed_at: datetime | None = datetime(2026, 1, 1)


# ==============================================================================
# 1. Monotonic Delivery Ranking & Transitions
# ==============================================================================

def test_status_rank_order():
    assert DELIVERY_STATUS_RANKS["PENDING"] == 0
    assert DELIVERY_STATUS_RANKS["FAILED"] == 0
    assert DELIVERY_STATUS_RANKS["SENT"] == 1
    assert DELIVERY_STATUS_RANKS["DELIVERED"] == 2
    assert DELIVERY_STATUS_RANKS["READ"] == 3


def test_should_advance_status_forward():
    assert should_advance_status(ConversationMessageStatus.PENDING, "SENT") is True
    assert should_advance_status(ConversationMessageStatus.SENT, "DELIVERED") is True
    assert should_advance_status(ConversationMessageStatus.DELIVERED, "READ") is True
    assert should_advance_status(ConversationMessageStatus.PENDING, "READ") is True


def test_should_advance_status_backward_rejected():
    """Higher delivery status must NEVER be downgraded by earlier status echoes."""
    assert should_advance_status(ConversationMessageStatus.READ, "SENT") is False
    assert should_advance_status(ConversationMessageStatus.READ, "DELIVERED") is False
    assert should_advance_status(ConversationMessageStatus.DELIVERED, "SENT") is False
    assert should_advance_status(ConversationMessageStatus.SENT, "PENDING") is False
    assert should_advance_status(ConversationMessageStatus.SENT, "FAILED") is False


def test_should_advance_status_same_rejected():
    """Duplicate status event must not advance."""
    assert should_advance_status(ConversationMessageStatus.SENT, "SENT") is False
    assert should_advance_status(ConversationMessageStatus.DELIVERED, "DELIVERED") is False
    assert should_advance_status(ConversationMessageStatus.READ, "READ") is False


def test_should_advance_status_invalid_or_none():
    assert should_advance_status(ConversationMessageStatus.PENDING, None) is False
    assert should_advance_status(ConversationMessageStatus.PENDING, "") is False
    assert should_advance_status(ConversationMessageStatus.PENDING, "UNKNOWN_STATUS") is False


def test_resolve_next_delivery_status():
    assert resolve_next_delivery_status(ConversationMessageStatus.PENDING, "SENT") == "SENT"
    assert resolve_next_delivery_status(ConversationMessageStatus.SENT, "DELIVERED") == "DELIVERED"
    assert resolve_next_delivery_status(ConversationMessageStatus.DELIVERED, "SENT") is None


# ==============================================================================
# 2. advance_message_status Execution & Timestamps
# ==============================================================================

def test_advance_message_status_to_sent():
    msg = DummyMessageRow(ConversationMessageStatus.PENDING)
    frozen_now = datetime(2026, 9, 17, 12, 0, 0)
    advanced = advance_message_status(msg, "SENT", now_factory=lambda: frozen_now)

    assert advanced is True
    assert msg.status == ConversationMessageStatus.SENT
    assert msg.sent_at == frozen_now
    assert msg.delivered_at is None
    assert msg.read_at is None
    assert msg.error_message is None
    assert msg.failed_at is None


def test_advance_message_status_to_delivered():
    msg = DummyMessageRow(ConversationMessageStatus.SENT)
    frozen_now = datetime(2026, 9, 17, 12, 5, 0)
    advanced = advance_message_status(msg, "DELIVERED", now_factory=lambda: frozen_now)

    assert advanced is True
    assert msg.status == ConversationMessageStatus.DELIVERED
    assert msg.delivered_at == frozen_now
    assert msg.read_at is None


def test_advance_message_status_to_read():
    msg = DummyMessageRow(ConversationMessageStatus.DELIVERED)
    frozen_now = datetime(2026, 9, 17, 12, 10, 0)
    advanced = advance_message_status(msg, "READ", now_factory=lambda: frozen_now)

    assert advanced is True
    assert msg.status == ConversationMessageStatus.READ
    assert msg.read_at == frozen_now


def test_advance_message_status_downgrade_noop():
    msg = DummyMessageRow(ConversationMessageStatus.READ)
    advanced = advance_message_status(msg, "SENT")

    assert advanced is False
    assert msg.status == ConversationMessageStatus.READ


# ==============================================================================
# 3. parse_session_status
# ==============================================================================

def test_parse_session_status():
    assert parse_session_status(None) == SessionStatus.SCAN_QR
    assert parse_session_status("CONNECTED") == SessionStatus.CONNECTED
    assert parse_session_status("SCAN_QR") == SessionStatus.SCAN_QR
    assert parse_session_status("DISCONNECTED") == SessionStatus.DISCONNECTED
    assert parse_session_status("RELINK_REQUIRED") == SessionStatus.RELINK_REQUIRED
    assert parse_session_status("RANDOM_INVALID_STATUS") == SessionStatus.ERROR
