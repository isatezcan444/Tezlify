"""Durable lookup for in-flight ephemeral (No-Create) QR pairings.

The in-memory `_ephemeral_pairings` dict is a CACHE, not the source of truth.
This module is the durable side of the same information, so that losing process
memory (restart, cancel, a popped token) can never destroy an otherwise valid
gateway promotion.

Design rules (Phase 6.8)
------------------------
1. **Owner resolution stays fail-closed.** `resolve_open_pairing` returns a
   record ONLY for the exact `gateway_session_id` (or `pair_token`) asked about.
   It never searches "the only session that looks close", never falls back to a
   global default, and returns `None` for anything it cannot prove.
2. **A missing record is not an error.** `record_pairing` is best-effort: if the
   table is absent (a deployment that has not run `create_all`/migrations yet)
   the pairing still works on the in-memory path. The durable layer is a
   durability upgrade, never a new hard dependency.
3. **Consumed records are retained.** `consumed_at` marks a pairing as finished
   (promoted or cancelled). Consumed records are kept for audit and are excluded
   from owner resolution, so a late duplicate event cannot re-promote.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.ephemeral_pairing import EphemeralPairing

logger = logging.getLogger(__name__)


def _to_dict(row: Any) -> Optional[Dict[str, Any]]:
    """Coerce a row to the public dict, or None when it cannot be proven.

    The `isinstance` guard is deliberate and is part of this module's contract:
    "returns None for anything it cannot prove". A truthy non-row — a stand-in
    object in a unit test, a partially-initialised proxy — must read as *no
    evidence*, never as an owner. Owner resolution is fail-closed, and this is
    where that is enforced.
    """
    if not isinstance(row, EphemeralPairing):
        return None
    return {
        "pair_token": row.pair_token,
        "user_id": str(row.user_id),
        "gateway_id": str(row.gateway_session_id),
        "session_name": row.session_name,
        "logical_session_id": row.logical_session_id,
        "consumed": row.consumed_at is not None,
    }


async def record_pairing(
    db: AsyncSession,
    *,
    pair_token: str,
    gateway_session_id: str,
    user_id: str,
    session_name: str,
    logical_session_id: Optional[int] = None,
) -> bool:
    """Persist a pairing attempt. Best-effort: returns False if it could not be stored."""
    try:
        existing = await db.scalar(
            select(EphemeralPairing).where(EphemeralPairing.pair_token == str(pair_token))
        )
        if existing is not None:
            # Re-recording the same token (e.g. a retried start) refreshes the row
            # but must never resurrect a consumed pairing.
            existing.gateway_session_id = str(gateway_session_id)
            existing.user_id = str(user_id)
            existing.session_name = session_name
            existing.logical_session_id = logical_session_id
            existing.updated_at = datetime.utcnow()
        else:
            db.add(
                EphemeralPairing(
                    pair_token=str(pair_token),
                    gateway_session_id=str(gateway_session_id),
                    user_id=str(user_id),
                    session_name=session_name,
                    logical_session_id=logical_session_id,
                    consumed_at=None,
                    created_at=datetime.utcnow(),
                    updated_at=datetime.utcnow(),
                )
            )
        await db.commit()
        return True
    except Exception as exc:  # noqa: BLE001 - durability is an upgrade, not a dependency
        await db.rollback()
        logger.warning(
            "[WhatsApp][6.8] Ephemeral pairing could not be persisted (pairing still "
            "works in memory): %s",
            exc,
        )
        return False


async def resolve_open_pairing(
    db: AsyncSession, gateway_session_id: str
) -> Optional[Dict[str, Any]]:
    """Owner lookup by gateway session UUID. Unconsumed records only.

    Returns None when the gateway session is unknown or its pairing already
    finished — callers MUST treat None as "cannot prove the owner" and fail
    closed rather than guessing.
    """
    if not gateway_session_id:
        return None
    try:
        row = await db.scalar(
            select(EphemeralPairing).where(
                EphemeralPairing.gateway_session_id == str(gateway_session_id),
                EphemeralPairing.consumed_at.is_(None),
            )
        )
        return _to_dict(row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[WhatsApp][6.8] Durable pairing lookup failed: %s", exc)
        return None


async def resolve_open_pairing_by_token(
    db: AsyncSession, pair_token: str
) -> Optional[Dict[str, Any]]:
    """Owner lookup by pair_token. Unconsumed records only."""
    if not pair_token:
        return None
    try:
        row = await db.scalar(
            select(EphemeralPairing).where(
                EphemeralPairing.pair_token == str(pair_token),
                EphemeralPairing.consumed_at.is_(None),
            )
        )
        return _to_dict(row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[WhatsApp][6.8] Durable pairing lookup by token failed: %s", exc)
        return None


async def resolve_pairing_by_token(
    db: AsyncSession, pair_token: str
) -> Optional[Dict[str, Any]]:
    """Owner lookup by pair_token, INCLUDING already-consumed records.

    `resolve_open_pairing_by_token` deliberately excludes consumed records so a
    late duplicate event cannot re-promote. This variant answers the opposite
    question — "was this token ever recorded, even if it is finished?" — and is
    currently used by the Phase 6.8 test harness to recover the gateway id of a
    token whose pairing has already been consumed.

    It is NOT called from production code. An earlier attempt to make
    `GET /pairing/{token}/qr` answer from a consumed record instead of a 404 was
    reverted: it broke an existing exactly-once promotion test, and the modal's
    poll already swallows errors so it needed no change.

    Keep it narrow. Do NOT reach for this in an owner-resolution path — only the
    unconsumed `resolve_open_pairing*` variants may be used there, or a finished
    pairing could be re-promoted.

    The caller must still verify ownership before acting on the result.
    """
    if not pair_token:
        return None
    try:
        row = await db.scalar(
            select(EphemeralPairing).where(EphemeralPairing.pair_token == str(pair_token))
        )
        return _to_dict(row)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[WhatsApp][6.8] Durable pairing lookup (any state) failed: %s", exc)
        return None


async def consume_pairing(db: AsyncSession, gateway_session_id: str) -> bool:
    """Mark a pairing as finished. Idempotent."""
    if not gateway_session_id:
        return False
    try:
        row = await db.scalar(
            select(EphemeralPairing).where(
                EphemeralPairing.gateway_session_id == str(gateway_session_id),
                EphemeralPairing.consumed_at.is_(None),
            )
        )
        if row is None:
            return False
        row.consumed_at = datetime.utcnow()
        row.updated_at = datetime.utcnow()
        await db.commit()
        return True
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        logger.warning("[WhatsApp][6.8] Durable pairing consume failed: %s", exc)
        return False


async def consume_pairing_by_token(db: AsyncSession, pair_token: str) -> bool:
    """Mark a pairing as finished by token. Idempotent."""
    if not pair_token:
        return False
    try:
        row = await db.scalar(
            select(EphemeralPairing).where(
                EphemeralPairing.pair_token == str(pair_token),
                EphemeralPairing.consumed_at.is_(None),
            )
        )
        if row is None:
            return False
        row.consumed_at = datetime.utcnow()
        row.updated_at = datetime.utcnow()
        await db.commit()
        return True
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        logger.warning("[WhatsApp][6.8] Durable pairing consume-by-token failed: %s", exc)
        return False
