"""Durable, restart-surviving stage timing for WhatsApp connection attempts.

Companion to `backend/app/models/whatsapp_connect_stage.py` — read that docstring
first. It explains why the backend (not the gateway) owns this measurement and
why there is no `scan` stage.

Contract:
  * Nothing here raises into a caller. Instrumentation must never be able to fail
    a pairing or a message ingest.
  * A stage is recorded only when it was actually observed. There is no
    "inferred" stage, and `elapsed_ms` is NULL when the attempt's start is
    unknown rather than 0.
  * `(correlation_id, stage)` is unique, so a redelivered event is a no-op
    instead of a second sample.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.whatsapp_connect_stage import (
    STAGE_ATTEMPT_FAILED,
    STAGE_PAIRING_REQUESTED,
    STAGE_ORDER,
    WhatsAppConnectStage,
)

logger = logging.getLogger(__name__)

# One attempt is a handful of rows. 90 days of that is a few thousand rows even
# for a busy line, and it is long enough to compare "before/after a deploy".
CONNECT_METRICS_RETENTION_DAYS = 90

# Below this, a percentile is a curiosity, not a result. The API reports the
# sample size next to every percentile so this can never be quoted as a trend.
MIN_SAMPLES_FOR_PERCENTILE = 5


def new_attempt_id() -> str:
    """Correlation id for one connection attempt. Shared by all its stages."""
    return uuid.uuid4().hex[:32]


def attempt_id_for_gateway(gateway_id: Optional[str]) -> Optional[str]:
    """Derive the attempt id from the gateway session id.

    WHY NOT a generated UUID: the stages of one attempt are observed at very
    different times and by different code paths — the first three before a
    durable `whatsapp_sessions` row exists, the rest long after. A generated id
    would have to be carried in process memory between them, and that is exactly
    the "a restart destroyed the evidence" failure this table exists to fix.

    The gateway mints a **fresh session UUID for every pairing attempt**
    (`create_session(..., ephemeral=True)`), including a relink, so the gateway
    id is already one-attempt-per-value. Hashing it gives a stable key that
    every stage can recompute from data it already holds, with no schema change
    and no in-memory registry.

    Scope: a QR *refresh* inside one ephemeral session shares the id on purpose —
    it is the same socket and the same attempt, only a newer code.
    """
    if not gateway_id:
        return None
    return hashlib.sha256(f"attempt:{gateway_id}".encode("utf-8")).hexdigest()[:32]


def gateway_ref(gateway_id: Optional[str]) -> Optional[str]:
    """Opaque 12-char reference to a gateway session, matching the gateway's own
    `sessionRef()` convention. The raw UUID never reaches this table or a log."""
    if not gateway_id:
        return None
    return hashlib.sha256(str(gateway_id).encode("utf-8")).hexdigest()[:12]


def _json_safe(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return json.dumps(value, default=str, ensure_ascii=False)[:2000]
    except Exception:  # noqa: BLE001
        return None


def _conflict_free_insert(db: AsyncSession, values: Dict[str, Any]):
    """`INSERT ... ON CONFLICT DO NOTHING` for the dialect in use, or None.

    WHY NOT "insert and catch IntegrityError"
    -----------------------------------------
    That is what this module used to do, and it is functionally correct — the
    row was suppressed and `record_stage` returned False. But Postgres logs a
    failed unique insert as an **ERROR** line even when the client catches it,
    and `record_stage` is called from the QR *poll*: measured in production on
    2026-10-27, one pairing produced **6 `uq_wa_connect_stage` ERRORs** in
    `docker logs tezlify-db` against a single `qr_received` row.

    Two costs, one of them serious:
      * one failed INSERT + ROLLBACK per poll (the round-trip the `_once` helper
        exists to avoid), and
      * an ERROR in the database log that is indistinguishable from a real
        failure. It was reported to this engineer as evidence of a broken
        system, and reading it as "harmless" requires knowing this function's
        internals. An error line that has to be explained away is a defect.

    ON CONFLICT DO NOTHING writes nothing, raises nothing, logs nothing, and
    needs no rollback — so the caller's transaction is never disturbed.
    """
    bind = getattr(db, "bind", None)
    dialect = getattr(bind, "dialect", None)
    name = getattr(dialect, "name", "")
    if name == "postgresql":
        return pg_insert(WhatsAppConnectStage).values(**values).on_conflict_do_nothing()
    if name == "sqlite":
        return sqlite_insert(WhatsAppConnectStage).values(**values).on_conflict_do_nothing()
    return None


async def record_stage(
    db: AsyncSession,
    *,
    correlation_id: str,
    stage: str,
    user_id: Optional[str] = None,
    session_id: Optional[int] = None,
    gateway_id: Optional[str] = None,
    outcome: str = "observed",
    reason_code: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
    commit: bool = True,
) -> bool:
    """Record one observed stage. Returns True when a row was written.

    `elapsed_ms` is derived from THIS attempt's `pairing_requested` row, read
    inside the same session, so two overlapping attempts cannot borrow each
    other's clock. A missing start row yields None — never 0.
    """
    if not correlation_id or not stage:
        return False
    try:
        started_at = (
            await db.execute(
                select(WhatsAppConnectStage.occurred_at).where(
                    WhatsAppConnectStage.correlation_id == str(correlation_id),
                    WhatsAppConnectStage.stage == STAGE_PAIRING_REQUESTED,
                )
            )
        ).scalar()

        now = utc_now_naive()
        elapsed_ms: Optional[int] = None
        if started_at is not None:
            try:
                elapsed_ms = max(0, int((now - started_at).total_seconds() * 1000))
            except TypeError:
                elapsed_ms = None
        elif stage == STAGE_PAIRING_REQUESTED:
            # The baseline measures itself: 0 ms BY DEFINITION, not "unknown".
            # (It cannot read its own start row — that row is the one being
            # inserted.) Leaving it None would make the first stage of every
            # attempt look unmeasured.
            elapsed_ms = 0

        values: Dict[str, Any] = {
            "correlation_id": str(correlation_id)[:36],
            "stage": str(stage)[:40],
            "occurred_at": now,
            "user_id": str(user_id) if user_id is not None else None,
            "session_id": int(session_id) if session_id is not None else None,
            "gateway_ref": gateway_ref(gateway_id),
            "outcome": str(outcome)[:16],
            "reason_code": (str(reason_code)[:48] if reason_code else None),
            "elapsed_ms": elapsed_ms,
            "detail": _json_safe(detail),
        }

        conflict_free = _conflict_free_insert(db, values)
        if conflict_free is not None:
            result = await db.execute(conflict_free)
            inserted = (result.rowcount or 0) > 0
            if inserted:
                if commit:
                    await db.commit()
                else:
                    await db.flush()
            else:
                # Nothing was written, so nothing is committed and nothing is
                # rolled back: a redelivery must not disturb the caller's
                # transaction. (The old code rolled back here, which would also
                # discard any sibling write the caller had staged.)
                logger.debug(
                    "[CONNECT-METRICS] yinelenen asama atlandi (corr=%s stage=%s)",
                    correlation_id,
                    stage,
                )
            return inserted

        # Unknown dialect — no ON CONFLICT support. Fall back to insert+rollback.
        db.add(WhatsAppConnectStage(**values))
        if commit:
            await db.commit()
        else:
            await db.flush()
        return True
    except IntegrityError:
        # (correlation_id, stage) already recorded — a redelivery, not an error.
        logger.debug(
            "[CONNECT-METRICS] yinelenen asama atlandi (corr=%s stage=%s)",
            correlation_id,
            stage,
        )
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False
    except Exception as exc:  # noqa: BLE001 - instrumentation never breaks a pairing
        logger.debug("[CONNECT-METRICS] asama yazilamadi (stage=%s): %s", stage, exc)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False


async def attempt_timeline(
    db: AsyncSession, correlation_id: str
) -> List[Dict[str, Any]]:
    """Every observed stage of one attempt, in canonical order."""
    try:
        rows = (
            await db.execute(
                select(WhatsAppConnectStage)
                .where(WhatsAppConnectStage.correlation_id == str(correlation_id))
                .order_by(WhatsAppConnectStage.occurred_at.asc())
            )
        ).scalars().all()
    except Exception as exc:  # noqa: BLE001
        logger.debug("[CONNECT-METRICS] timeline okunamadi: %s", exc)
        return []
    order = {name: i for i, name in enumerate(STAGE_ORDER)}
    items = [r.as_dict() for r in rows]
    items.sort(key=lambda r: (order.get(r["stage"], 99), r["occurred_at"] or ""))
    return items


_ONCE_CACHE: set = set()


async def record_stage_once(
    db: AsyncSession,
    *,
    correlation_id: Optional[str],
    stage: str,
    user_id: Optional[str] = None,
    session_id: Optional[int] = None,
    gateway_id: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> bool:
    """Record a stage only the FIRST time it happens for this attempt.

    Used on the hot ingest path (`first_message_persisted` fires on every
    incoming message until it succeeds once). The unique index alone would make
    that correct, but it would also cost one failed INSERT + rollback per
    message — on a sync burst that is hundreds of pointless round-trips.

    So: a DB existence check is the source of truth, and `_ONCE_CACHE` is only a
    memo of "already answered". A cold cache (restart) costs one query per
    stage and then stops. The cache can never produce a wrong answer — it is
    only ever populated from the database's own verdict.
    """
    if not correlation_id:
        return False
    key = (str(correlation_id), str(stage))
    if key in _ONCE_CACHE:
        return False
    try:
        exists = (
            await db.execute(
                select(WhatsAppConnectStage.id).where(
                    WhatsAppConnectStage.correlation_id == key[0],
                    WhatsAppConnectStage.stage == key[1],
                ).limit(1)
            )
        ).first()
    except Exception as exc:  # noqa: BLE001 - a probe failure must not block ingest
        logger.debug("[CONNECT-METRICS] varlik kontrolu basarisiz: %s", exc)
        return False
    if exists is not None:
        _ONCE_CACHE.add(key)
        return False
    wrote = await record_stage(
        db,
        correlation_id=key[0],
        stage=key[1],
        user_id=user_id,
        session_id=session_id,
        gateway_id=gateway_id,
        detail=detail,
    )
    if wrote:
        _ONCE_CACHE.add(key)
    return wrote


def _percentile(values: List[int], pct: float) -> Optional[int]:
    """Nearest-rank percentile. Small-N honest: no interpolation pretending to
    know more than the sample does."""
    if not values:
        return None
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, int(round((pct / 100.0) * (len(ordered) - 1)))))
    return int(ordered[k])


async def stage_summary(
    db: AsyncSession, *, days: int = 7, user_id: Optional[str] = None
) -> Dict[str, Any]:
    """p50/p95 per stage over the window, with the sample size attached.

    Percentiles are only emitted when `n >= MIN_SAMPLES_FOR_PERCENTILE`; below
    that the raw values are returned instead, because "p95 of 1 sample" is that
    sample wearing a statistical costume.
    """
    window_days = max(1, min(int(days), 90))
    cutoff = utc_now_naive() - timedelta(days=window_days)
    stmt = select(WhatsAppConnectStage).where(WhatsAppConnectStage.occurred_at >= cutoff)
    if user_id is not None:
        stmt = stmt.where(WhatsAppConnectStage.user_id == str(user_id))
    try:
        rows = (await db.execute(stmt)).scalars().all()
    except Exception as exc:  # noqa: BLE001
        logger.debug("[CONNECT-METRICS] ozet okunamadi: %s", exc)
        return {"window_days": window_days, "stages": {}, "attempts": 0}

    per_stage: Dict[str, List[int]] = {}
    attempts = set()
    for r in rows:
        attempts.add(r.correlation_id)
        if r.elapsed_ms is None:
            continue
        per_stage.setdefault(r.stage, []).append(int(r.elapsed_ms))

    stages: Dict[str, Any] = {}
    for name, values in per_stage.items():
        entry: Dict[str, Any] = {
            "n": len(values),
            "min_ms": min(values),
            "max_ms": max(values),
        }
        if len(values) >= MIN_SAMPLES_FOR_PERCENTILE:
            entry["p50_ms"] = _percentile(values, 50)
            entry["p95_ms"] = _percentile(values, 95)
            entry["percentiles_reliable"] = True
        else:
            entry["values_ms"] = sorted(values)
            entry["percentiles_reliable"] = False
            entry["note"] = (
                f"n={len(values)} < {MIN_SAMPLES_FOR_PERCENTILE}; "
                "percentile hesaplanmadi, ham degerler verildi"
            )
        stages[name] = entry

    return {
        "window_days": window_days,
        "attempts": len(attempts),
        "stages": stages,
        "min_samples_for_percentile": MIN_SAMPLES_FOR_PERCENTILE,
    }


async def prune_old_stages(
    db: AsyncSession, *, days: int = CONNECT_METRICS_RETENTION_DAYS
) -> int:
    """Delete stage rows older than the retention window. Never raises."""
    cutoff = utc_now_naive() - timedelta(days=max(1, int(days)))
    try:
        res = await db.execute(
            sa_delete(WhatsAppConnectStage).where(WhatsAppConnectStage.occurred_at < cutoff)
        )
        await db.commit()
        return int(res.rowcount or 0)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[CONNECT-METRICS] budama basarisiz: %s", exc)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0


__all__ = [
    "CONNECT_METRICS_RETENTION_DAYS",
    "MIN_SAMPLES_FOR_PERCENTILE",
    "attempt_id_for_gateway",
    "attempt_timeline",
    "gateway_ref",
    "new_attempt_id",
    "prune_old_stages",
    "record_stage",
    "record_stage_once",
    "stage_summary",
    "STAGE_ATTEMPT_FAILED",
]
