"""Durable audit trail for WhatsApp data-shape changes.

WHY THIS EXISTS
---------------
On 2026-10-27 the production conversation count read 124 and then 123, and the
contact count fell with it. Data loss was ruled out (zero orphaned messages, the
message count *rose*, no `conversation_deleted` event in the gateway outbox) —
but the cause could not be named, because every piece of evidence had been
destroyed:

* `docker logs` died with the container the deploy replaced,
* the gateway outbox payload is encrypted by design,
* `wa_merge_locks` holds leases, not history,
* the identity-sweep counters live in `_SWEEP_STATE`, a module global, so a
  restart resets `merged_total` to 0 and proves nothing.

So the next such change has to leave a row behind. This table is that row.

WHAT IS DELIBERATELY NOT STORED
-------------------------------
No message bodies, no phone numbers, no JIDs, no QR payloads, no credentials.
Internal surrogate ids (`conversations.id`, `contacts.id`) are kept because they
are what an operator needs to correlate an event with the rows that survived, and
they are meaningless outside this database.

`counts_before` / `counts_after` are the point of the whole exercise: they make a
`-1` attributable to a specific operation instead of an unexplained drift.
"""

import json
from datetime import datetime

from sqlalchemy import Column, DateTime, Index, Integer, JSON, String, Text, Uuid

from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class WhatsAppDataAudit(Base):
    """One committed change to the WhatsApp data shape (delete / merge / sweep)."""

    __tablename__ = "whatsapp_data_audit"

    id = Column(Integer, primary_key=True, autoincrement=True)
    created_at = Column(DateTime, default=utc_now_naive, nullable=False, index=True)

    # 'conversation_deleted' | 'identity_merge' | 'sweep_run' | 'ghost_purge'
    event = Column(String(48), nullable=False, index=True)
    # 'api' | 'ingest' | 'sweep' | 'migration'
    source = Column(String(24), nullable=False)

    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    session_id = Column(Integer, nullable=True)

    # Ties the several rows one logical operation can emit (a sweep that merged
    # two pairs and purged a ghost is three rows with one correlation id).
    correlation_id = Column(String(36), nullable=True, index=True)

    # 'committed' | 'rolled_back' | 'skipped' | 'partial'
    outcome = Column(String(16), nullable=False, default="committed")
    # Short, machine-readable, PII-free: 'remote_rejected', 'no_anchor', ...
    reason = Column(String(160), nullable=True)

    conversation_ids = Column(JSON, nullable=True)
    contact_ids = Column(JSON, nullable=True)
    counts_before = Column(JSON, nullable=True)
    counts_after = Column(JSON, nullable=True)

    # The gateway outbox event that caused this, when there was one.
    outbox_event_id = Column(String(64), nullable=True)

    # Small, sanitised extras. Never put a body, a phone or a JID in here.
    detail = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_wa_data_audit_created", "created_at"),
        Index("idx_wa_data_audit_event_created", "event", "created_at"),
        Index("idx_wa_data_audit_user_created", "user_id", "created_at"),
    )

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat() if isinstance(self.created_at, datetime) else self.created_at,
            "event": self.event,
            "source": self.source,
            "session_id": self.session_id,
            "correlation_id": self.correlation_id,
            "outcome": self.outcome,
            "reason": self.reason,
            "conversation_ids": self.conversation_ids,
            "contact_ids": self.contact_ids,
            "counts_before": self.counts_before,
            "counts_after": self.counts_after,
            "outbox_event_id": self.outbox_event_id,
            "detail": _decode_detail(self.detail),
        }


def _decode_detail(raw: str | None):
    """`detail` is stored as JSON text; the API should hand back an object.

    Falls back to the raw string rather than dropping it — a row written by an
    older build (or a truncated payload) must still be readable, not silently
    blanked.
    """
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return raw
