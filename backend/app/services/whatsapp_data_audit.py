"""Durable, restart-surviving audit for WhatsApp data-shape changes.

Companion to `backend/app/models/whatsapp_data_audit.py` — read that docstring
first, it explains why this exists and what must never be stored here.

Contract:
  * Nothing here EVER raises into the caller. A broken audit row must not roll
    back a legitimate delete or merge. It does, however, always LOG the failure
    and always move `stats()` — a silent except here would recreate exactly the
    blindness this table fixes.
  * `stage_data_event` writes INSIDE the caller's transaction, so a rollback
    leaves no row and a commit cannot lose one. Use it whenever the caller still
    has a session open.
  * `record_data_event` commits on its own. It exists for callers whose
    transaction is already finished or poisoned (the reconciliation sweep's
    rollback path). It is the weaker guarantee — prefer staging.
  * `snapshot_counts` is tenant-scoped when a user_id is given, and returns None
    rather than a fake zero.
  * `idempotency_key` makes a retry a no-op instead of a second row.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import timedelta
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_data_audit import WhatsAppDataAudit

logger = logging.getLogger(__name__)

EVENT_CONVERSATION_DELETED = "conversation_deleted"
EVENT_CONVERSATION_CREATED = "conversation_created"
EVENT_IDENTITY_MERGE = "identity_merge"
EVENT_SELF_IDENTITY_MERGE = "self_identity_merge"
EVENT_SWEEP_RUN = "sweep_run"
EVENT_GHOST_PURGE = "ghost_purge"
EVENT_COUNT_SNAPSHOT = "count_snapshot"
EVENT_SESSION_PURGED = "session_purged"

# How long an audit row is kept. The table is append-only and small (one row per
# delete/merge/snapshot), so this is a housekeeping bound, not a growth control:
# 400 days keeps a full year of comparisons across a year boundary.
AUDIT_RETENTION_DAYS = 400

# Process-local counters. Deliberately NOT the source of truth for history —
# they reset on restart, which is exactly why the table exists. Their job is to
# make a *currently broken* recorder visible in /health instead of silent.
_STATS: Dict[str, Any] = {
    "written": 0,
    "staged": 0,
    "duplicate_skipped": 0,
    "failed": 0,
    "last_error": None,
    "last_error_at": None,
}


def stats() -> Dict[str, Any]:
    """Safe snapshot for /health. No PII, no payloads."""
    return dict(_STATS)


def _bump(key: str, exc: Optional[BaseException] = None) -> None:
    _STATS[key] = int(_STATS.get(key) or 0) + 1
    if exc is not None:
        # Truncated: an exception string can carry a SQL fragment with a bound
        # parameter. Keep the type and a short message only.
        _STATS["last_error"] = f"{type(exc).__name__}: {str(exc)[:160]}"
        _STATS["last_error_at"] = utc_now_naive().isoformat()


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

    Called inside the caller's transaction on purpose — that is what makes
    `counts_after` describe the same transaction boundary as the change.
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
        _bump("failed", exc)
        return None


def _build_row(
    *,
    event: str,
    source: str,
    user_id: Optional[str],
    session_id: Optional[int],
    correlation_id: Optional[str],
    outcome: str,
    reason: Optional[str],
    conversation_ids: Optional[Iterable[Any]],
    contact_ids: Optional[Iterable[Any]],
    counts_before: Optional[Dict[str, int]],
    counts_after: Optional[Dict[str, int]],
    outbox_event_id: Optional[str],
    idempotency_key: Optional[str],
    detail: Optional[Dict[str, Any]],
) -> WhatsAppDataAudit:
    return WhatsAppDataAudit(
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
        idempotency_key=(str(idempotency_key)[:96] if idempotency_key else None),
        detail=_json_safe(detail),
    )


async def stage_data_event(
    db: AsyncSession,
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
    idempotency_key: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> bool:
    """Add the audit row to the CALLER's transaction. Does not commit.

    This is the strong guarantee: the change and its record commit together, so
    neither a rollback can leave a false "committed" row nor a crash can lose the
    record of a committed change.

    The row is only in the session's pending state — it is visible to a COUNT
    inside the same transaction, which is how `counts_after` stays consistent
    with the boundary the change happened in.

    A failure here (unserialisable detail, missing column) is logged and
    counted, never raised: the caller's real work must still commit.
    """
    try:
        # Pre-check the key BEFORE adding the row.
        #
        # This is not an optimisation, it is a correctness requirement: the row
        # is staged into the CALLER's transaction, so a UNIQUE violation would
        # surface at the caller's `commit()` — turning "this delete was already
        # recorded" into a failed delete. The constraint stays as a backstop for
        # a genuine concurrent duplicate, but the common retry path must never
        # reach it.
        if idempotency_key:
            existing = (
                await db.execute(
                    select(WhatsAppDataAudit.id)
                    .where(WhatsAppDataAudit.idempotency_key == str(idempotency_key)[:96])
                    .limit(1)
                )
            ).first()
            if existing is not None:
                _bump("duplicate_skipped", None)
                return False
        db.add(
            _build_row(
                event=event,
                source=source,
                user_id=user_id,
                session_id=session_id,
                correlation_id=correlation_id,
                outcome=outcome,
                reason=reason,
                conversation_ids=conversation_ids,
                contact_ids=contact_ids,
                counts_before=counts_before,
                counts_after=counts_after,
                outbox_event_id=outbox_event_id,
                idempotency_key=idempotency_key,
                detail=detail,
            )
        )
        _bump("staged")
        return True
    except Exception as exc:  # noqa: BLE001 - never break the caller
        logger.warning(
            "[DATA-AUDIT] staged kayit eklenemedi (event=%s source=%s): %s",
            event,
            source,
            exc,
        )
        _bump("failed", exc)
        return False


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
    idempotency_key: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> bool:
    """Append one audit row in its own commit. Returns True when persisted.

    `db` may be None, in which case a session is opened from `AsyncSessionLocal`.
    That is the rollback path: the caller's session is already poisoned.

    A duplicate `idempotency_key` is a SUCCESS, not a failure: it means the same
    logical operation was already recorded, and appending again would make one
    delete look like two.
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

        db.add(
            _build_row(
                event=event,
                source=source,
                user_id=user_id,
                session_id=session_id,
                correlation_id=correlation_id,
                outcome=outcome,
                reason=reason,
                conversation_ids=conversation_ids,
                contact_ids=contact_ids,
                counts_before=counts_before,
                counts_after=counts_after,
                outbox_event_id=outbox_event_id,
                idempotency_key=idempotency_key,
                detail=detail,
            )
        )
        await db.commit()
        _bump("written")
        return True
    except IntegrityError as exc:
        # The unique index did its job: this operation is already recorded.
        logger.info(
            "[DATA-AUDIT] yinelenen kayit atlandi (event=%s key=%s)",
            event,
            idempotency_key,
        )
        _bump("duplicate_skipped", None)
        if db is not None:
            try:
                await db.rollback()
            except Exception:  # noqa: BLE001
                pass
        return False
    except Exception as exc:  # noqa: BLE001 - never break the caller
        logger.warning(
            "[DATA-AUDIT] kayit yazilamadi (event=%s source=%s): %s", event, source, exc
        )
        _bump("failed", exc)
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


async def record_count_snapshot(
    db: AsyncSession, *, user_id: Optional[str], source: str = "sweep"
) -> Optional[Dict[str, int]]:
    """Write a count snapshot, but only when the DATA SHAPE changed.

    This is the structural half of attribution. Every delete/merge path is now
    instrumented, but "no event row" must still not mean "no explanation": if a
    count moves without a matching event, the next snapshot bounds the change to
    a window instead of leaving it floating between deploys.

    Only `conversations` and `contacts` trigger a row. `messages` is recorded for
    context but changes with normal traffic — comparing it would write a row on
    every sweep and turn the table into a heartbeat, burying the signal.
    """
    current = await snapshot_counts(db, user_id)
    if current is None:
        return None
    try:
        last = (
            await db.execute(
                select(WhatsAppDataAudit.counts_after)
                .where(
                    WhatsAppDataAudit.user_id == str(user_id),
                    WhatsAppDataAudit.event == EVENT_COUNT_SNAPSHOT,
                )
                .order_by(WhatsAppDataAudit.id.desc())
                .limit(1)
            )
        ).scalar()
    except Exception as exc:  # noqa: BLE001 - a read failure must not stop the sweep
        logger.debug("[DATA-AUDIT] onceki sayim okunamadi: %s", exc)
        last = None

    if isinstance(last, dict) and (
        last.get("conversations") == current.get("conversations")
        and last.get("contacts") == current.get("contacts")
    ):
        return None

    ok = await record_data_event(
        db,
        event=EVENT_COUNT_SNAPSHOT,
        source=source,
        user_id=user_id,
        outcome="observed",
        reason="data_shape_changed",
        counts_after=current,
        detail={"has_baseline": isinstance(last, dict), "previous": last},
    )
    return current if ok else None


async def prune_old_events(
    db: AsyncSession, *, days: int = AUDIT_RETENTION_DAYS
) -> int:
    """Delete rows older than the retention window. Returns the row count.

    Bounded retention is the only thing that keeps an append-only table honest.
    Never raises: a failed prune is a disk-space concern, not a correctness one.
    """
    cutoff = utc_now_naive() - timedelta(days=max(1, int(days)))
    try:
        res = await db.execute(
            sa_delete(WhatsAppDataAudit).where(WhatsAppDataAudit.created_at < cutoff)
        )
        await db.commit()
        return int(res.rowcount or 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[DATA-AUDIT] budama basarisiz: %s", exc)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0
