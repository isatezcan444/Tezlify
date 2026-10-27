"""Durable, restart-surviving audit for WhatsApp data-shape changes.

Companion to `backend/app/models/whatsapp_data_audit.py` — read that docstring
first, it explains why this exists and what must never be stored here.

Contract:
  * `record_data_event` NEVER raises. A broken audit row must not roll back a
    legitimate delete or merge. It does, however, always LOG the failure — a
    silent except here would recreate exactly the blindness this table fixes.
  * Recording happens AFTER the caller's commit, so a row means "this was
    committed", not "we tried". The rollback path passes its own session.
  * `snapshot_counts` is tenant-scoped when a user_id is given. It is three
    indexed counts over small tables, and callers only pay for it when an
    operation actually changed something.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_data_audit import WhatsAppDataAudit

logger = logging.getLogger(__name__)

EVENT_CONVERSATION_DELETED = "conversation_deleted"
EVENT_IDENTITY_MERGE = "identity_merge"
EVENT_SWEEP_RUN = "sweep_run"
EVENT_GHOST_PURGE = "ghost_purge"


def new_correlation_id() -> str:
    """One id per logical operation, shared by every row it emits."""
    return uuid.uuid4().hex[:32]


def _json_safe(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return json.dumps(value, default=str, ensure_ascii=False)[:4000]
    except Exception:  # noqa: BLE001 - an unserialisable detail is not worth a failure
        return None


async def snapshot_counts(
    db: AsyncSession, user_id: Optional[str] = None
) -> Optional[Dict[str, int]]:
    """Current (conversations, messages, contacts) totals for one tenant.

    Returns None rather than guessing: a failed snapshot must not be recorded as
    a zero, which would read as "everything was deleted".
    """
    try:
        conv_q = select(func.count()).select_from(Conversation)
        msg_q = select(func.count()).select_from(Message)
        contact_q = select(func.count()).select_from(Contact)
        if user_id is not None:
            conv_q = conv_q.where(Conversation.user_id == str(user_id))
            msg_q = msg_q.where(Message.user_id == str(user_id))
            contact_q = contact_q.where(Contact.user_id == str(user_id))
        return {
            "conversations": int((await db.scalar(conv_q)) or 0),
            "messages": int((await db.scalar(msg_q)) or 0),
            "contacts": int((await db.scalar(contact_q)) or 0),
        }
    except Exception as exc:  # noqa: BLE001 - audit must not break the caller
        logger.warning("[DATA-AUDIT] sayim alinamadi (user=%s): %s", user_id, exc)
        return None


async def record_data_event(
    db: Optional[AsyncSession],
    *,
    event: str,
    source: str,
    user_id: Optional[str] = None,
    session_id: Optional[int] = None,
    correlation_id: Optional[str] = None,
    outcome: str = "committed",
    reason: Optional[str] = None,
    conversation_ids: Optional[Iterable[Any]] = None,
    contact_ids: Optional[Iterable[Any]] = None,
    counts_before: Optional[Dict[str, int]] = None,
    counts_after: Optional[Dict[str, int]] = None,
    outbox_event_id: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> bool:
    """Append one audit row. Returns True when it was persisted.

    `db` may be None, in which case a session is opened from `AsyncSessionLocal`.
    That is the rollback path: the caller's session is already poisoned.
    """
    owned_session = False
    try:
        # NOTE: session ACQUISITION is inside the try on purpose. Opening a
        # connection can fail (pool exhaustion, DB down) and this function is
        # called from the reconciliation sweep — an audit failure there would
        # stop the very repair loop the audit exists to explain.
        if db is None:
            from backend.app.core.database import AsyncSessionLocal

            db = AsyncSessionLocal()
            owned_session = True

        row = WhatsAppDataAudit(
            created_at=utc_now_naive(),
            event=str(event)[:48],
            source=str(source)[:24],
            user_id=str(user_id) if user_id is not None else None,
            session_id=int(session_id) if session_id is not None else None,
            correlation_id=(str(correlation_id)[:36] if correlation_id else new_correlation_id()),
            outcome=str(outcome)[:16],
            reason=(str(reason)[:160] if reason else None),
            conversation_ids=list(conversation_ids) if conversation_ids is not None else None,
            contact_ids=list(contact_ids) if contact_ids is not None else None,
            counts_before=counts_before,
            counts_after=counts_after,
            outbox_event_id=(str(outbox_event_id)[:64] if outbox_event_id else None),
            detail=_json_safe(detail),
        )
        db.add(row)
        await db.commit()
        return True
    except Exception as exc:  # noqa: BLE001 - never break the caller
        logger.warning(
            "[DATA-AUDIT] kayit yazilamadi (event=%s source=%s): %s", event, source, exc
        )
        if db is not None:
            try:
                await db.rollback()
            except Exception:  # noqa: BLE001
                pass
        return False
    finally:
        if owned_session and db is not None:
            try:
                await db.close()
            except Exception:  # noqa: BLE001
                pass


async def recent_events(
    db: AsyncSession,
    *,
    user_id: Optional[str] = None,
    limit: int = 50,
    event: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Newest first. Tenant-scoped when a user_id is given."""
    bounded = max(1, min(int(limit), 200))
    stmt = select(WhatsAppDataAudit).order_by(WhatsAppDataAudit.id.desc()).limit(bounded)
    if user_id is not None:
        stmt = stmt.where(WhatsAppDataAudit.user_id == str(user_id))
    if event:
        stmt = stmt.where(WhatsAppDataAudit.event == str(event)[:48])
    try:
        res = await db.execute(stmt)
        return [row.as_dict() for row in res.scalars().all()]
    except Exception as exc:  # noqa: BLE001 - a read failure is reported, not hidden
        logger.warning("[DATA-AUDIT] kayitlar okunamadi: %s", exc)
        return []
