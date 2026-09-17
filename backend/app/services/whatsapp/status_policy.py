"""
WhatsApp Message Delivery & Session Status Policy.

Phase 11.6: Extracted from whatsapp_service.py.
Pure, deterministic logic governing monotonic delivery rank and session status parsing.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

from backend.app.models.message import ConversationMessageStatus
from backend.app.models.whatsapp_session import SessionStatus

logger = logging.getLogger(__name__)

# Monotonic delivery status ranking: PENDING/FAILED (0) < SENT (1) < DELIVERED (2) < READ (3)
DELIVERY_STATUS_RANKS: Dict[str, int] = {
    "PENDING": 0,
    "FAILED": 0,
    "SENT": 1,
    "DELIVERED": 2,
    "READ": 3,
}


def should_advance_status(current_status: Any, incoming_status: Optional[str]) -> bool:
    """Checks whether the incoming status has a strictly higher rank than the current status."""
    if not incoming_status:
        return False
    current_key = current_status.value if hasattr(current_status, "value") else str(current_status or "").upper()
    incoming_key = str(incoming_status).upper()
    if incoming_key not in DELIVERY_STATUS_RANKS:
        return False
    return DELIVERY_STATUS_RANKS[incoming_key] > DELIVERY_STATUS_RANKS.get(current_key, 0)


def resolve_next_delivery_status(current_status: Any, incoming_status: Optional[str]) -> Optional[str]:
    """Returns the new delivery status string if valid and higher rank; otherwise returns None."""
    if should_advance_status(current_status, incoming_status):
        return str(incoming_status).upper()
    return None


def advance_message_status(
    row: Any,
    status: Optional[str],
    now_factory: Optional[Callable[[], datetime]] = None,
) -> bool:
    """Provider evidence advances delivery; a send promise alone does not.

    Advances row status monotonically and sets sent_at, delivered_at, read_at timestamps.
    Returns True if row was advanced, False otherwise.
    """
    target = str(status or "").upper()
    current_val = row.status.value if hasattr(row.status, "value") else str(row.status or "")
    if target not in DELIVERY_STATUS_RANKS or DELIVERY_STATUS_RANKS[target] <= DELIVERY_STATUS_RANKS.get(current_val, 0):
        return False

    row.status = ConversationMessageStatus[target]
    now = now_factory() if now_factory else datetime.now(timezone.utc).replace(tzinfo=None)
    row.sent_at = row.sent_at or now
    if DELIVERY_STATUS_RANKS[target] >= 2:
        row.delivered_at = row.delivered_at or now
    if target == "READ":
        row.read_at = row.read_at or now
    row.error_message = None
    row.failed_at = None
    return True


def parse_session_status(value: Optional[str]) -> SessionStatus:
    """Parses raw gateway status string into SessionStatus enum."""
    if value is None:
        return SessionStatus.SCAN_QR
    try:
        return SessionStatus(value)
    except Exception:
        logger.error("Unknown WhatsApp session status received from gateway: %r", value)
        return SessionStatus.ERROR
