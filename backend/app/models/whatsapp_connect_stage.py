"""Durable per-stage timing for one WhatsApp connection attempt.

WHY THIS EXISTS
---------------
Phase 2 found the QR/sync latency instrumentation correct but *silent* in
production: `whatsapp-gateway/src/observability.js` gated it behind
`WHATSAPP_LATENCY_PROFILING === 'true'`, and that variable is not set in
production (nor in `docker-compose.prod.yml`). So "measure the QR pairing" had no
number to read, and the only record of a pairing was a pino line that dies with
the container.

This table is the number. It is written by the BACKEND, not the gateway, for a
deliberate reason: a gateway recreate costs its in-memory store (§A6), so
enabling a metric must never require restarting it. Every stage below is
observable from the backend side of the bridge.

DESIGN RULES
------------
* **One row per observed stage, not one wide row per attempt.** A column that was
  never observed is absent, not NULL-but-implied. "We did not observe this" and
  "this took 0 ms" must never look the same.
* **Only stages we can actually see are recorded.** We cannot observe the moment
  the user scans the QR — WhatsApp does not tell us, and the gateway only learns
  that a pairing succeeded. There is deliberately no `scan_*` stage: inventing
  one would mean reporting a measurement we never took.
* **`elapsed_ms` is measured from the attempt's own start row**, so two
  overlapping attempts can never borrow each other's clock.
* `(correlation_id, stage)` is UNIQUE: a redelivered gateway event must not
  append a second `first_message_persisted` and halve the apparent duration.

WHAT IS NEVER STORED
--------------------
No QR payload, no message text, no phone number, no JID/LID, no session token,
no credentials. `gateway_ref` is a truncated SHA-256 of the gateway session UUID
— the same opaque convention the gateway's own `sessionRef()` uses, so the two
sides can be joined without either side holding the raw id.
"""

from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)

from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive

# Canonical stage names. A typo here would silently split a stage into two, so
# they are exported and asserted in the tests.
STAGE_PAIRING_REQUESTED = "pairing_requested"
STAGE_QR_RECEIVED = "qr_received"
STAGE_QR_SERVED = "qr_served"
STAGE_SOCKET_OPEN = "socket_open"
STAGE_FIRST_CONTACT = "first_contact"
STAGE_FIRST_CONVERSATION = "first_conversation"
STAGE_FIRST_MESSAGE = "first_message_persisted"
STAGE_SYNC_COMPLETED = "sync_completed"
STAGE_ATTEMPT_FAILED = "attempt_failed"

STAGE_ORDER = (
    STAGE_PAIRING_REQUESTED,
    STAGE_QR_RECEIVED,
    STAGE_QR_SERVED,
    STAGE_SOCKET_OPEN,
    STAGE_FIRST_CONTACT,
    STAGE_FIRST_CONVERSATION,
    STAGE_FIRST_MESSAGE,
    STAGE_SYNC_COMPLETED,
    STAGE_ATTEMPT_FAILED,
)


class WhatsAppConnectStage(Base):
    """One observed stage of one connection attempt."""

    __tablename__ = "whatsapp_connect_stages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    correlation_id = Column(String(36), nullable=False, index=True)
    stage = Column(String(40), nullable=False)
    occurred_at = Column(DateTime, nullable=False, default=utc_now_naive, index=True)

    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    session_id = Column(Integer, nullable=True)
    # Opaque 12-char hash of the gateway session UUID. Never the UUID itself.
    gateway_ref = Column(String(24), nullable=True)

    # 'observed' | 'failed' | 'cancelled'
    outcome = Column(String(16), nullable=False, default="observed")
    # Machine-readable, PII-free: 'no_anchor', 'provider_timeout', 'qr_timeout'.
    reason_code = Column(String(48), nullable=True)

    # Milliseconds since this attempt's `pairing_requested` row. NULL when the
    # start row is unknown (e.g. the attempt began before this build shipped) —
    # an unknown elapsed time is not a zero.
    elapsed_ms = Column(Integer, nullable=True)

    detail = Column(Text, nullable=True)

    __table_args__ = (
        UniqueConstraint("correlation_id", "stage", name="uq_wa_connect_stage"),
        Index("idx_wa_connect_stage_occ", "occurred_at"),
        Index("idx_wa_connect_stage_stage_occ", "stage", "occurred_at"),
    )

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "correlation_id": self.correlation_id,
            "stage": self.stage,
            "occurred_at": (
                self.occurred_at.isoformat()
                if isinstance(self.occurred_at, datetime)
                else self.occurred_at
            ),
            "session_id": self.session_id,
            "gateway_ref": self.gateway_ref,
            "outcome": self.outcome,
            "reason_code": self.reason_code,
            "elapsed_ms": self.elapsed_ms,
        }
