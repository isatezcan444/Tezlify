"""Durable record of an in-flight ephemeral (No-Create) QR pairing.

Why this table exists (Phase 6.8)
---------------------------------
The ephemeral pairing registry used to live ONLY in process memory
(`orchestration/sessions.py::_ephemeral_pairings`). That made owner resolution
for the `session_connected` event depend on the backend process still holding
the same dict entry:

* a backend restart between the QR scan and `connection.open` lost it,
* a frontend `cancelPairing` popped it,
* `get_pairing_qr` popped it on `CONNECTED`.

Production evidence: a real phone reached `connection.open` (Baileys
`restartRequired(515)` -> `registerSession` wrote a `gateway_sessions` row), the
backend then answered `EventOwnerUnresolved` for that gateway UUID and dropped
2 904 events in 60 s, and no durable `public.whatsapp_sessions` row was ever
created.

This table is the durable, tenant-scoped source of truth for "who asked for this
gateway session". It is written at `pairing/start`, read for owner resolution in
the `session_connected` path, and marked `consumed_at` once the pairing is
promoted or cancelled.

It deliberately does NOT live in `public.whatsapp_sessions`: the No-Create QR
invariant (zero PUBLIC rows until a pairing actually connects) is preserved.

Tenant safety: this table is only ever read to resolve the owner of the specific
`gateway_session_id` named by the event. It is never used to guess a tenant for
an unknown gateway session — see `promote_ephemeral_pairing`, which fails closed.
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, Index, Integer, String
from backend.app.core.database import Base


class EphemeralPairing(Base):
    __tablename__ = "ephemeral_pairings"

    # The opaque token handed to the browser (`pair_token`).
    pair_token = Column(String(64), primary_key=True)

    # The gateway session UUID created for this pairing. UNIQUE because one
    # gateway session can belong to exactly one pairing attempt.
    gateway_session_id = Column(String(64), nullable=False, unique=True, index=True)

    # Owner. Stored as TEXT (not Uuid) because the auth layer legitimately
    # yields both the dashed UUID form and the 32-char hex form, and
    # `get_user_filter` accepts either.
    user_id = Column(String(64), nullable=False, index=True)

    session_name = Column(String(150), nullable=False)

    # Set when the pairing targets an EXISTING logical session (reconnect flow).
    logical_session_id = Column(Integer, nullable=True)

    # Set once the pairing is promoted to a durable session, or cancelled.
    # A consumed record is retained (audit trail) but never resolves an owner.
    consumed_at = Column(DateTime, nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("ix_ephemeral_pairings_owner_open", "user_id", "consumed_at"),
    )
