"""On-Demand History Evidence & Completeness Coordinator (Phase 17).

Durable persistence and tracking for on-demand WhatsApp history queries in
`whatsapp_private.history_sync_states`.

Strict Invariants:
1. HYDRATION != COMPLETENESS. Messages in DB do not prove completeness.
2. Zero background expansion / zero automated sweeps.
3. Provider evidence is recorded ONLY when `provider_status == 'OK'` (or error/timeout).
4. `provider_status == 'NOT_REQUESTED'` (cache hit) NEVER updates provider evidence.
5. FULLY_EXHAUSTED requires a strict TWO-STEP confirmation:
   Step 1: A successful provider request returns fewer messages than requested (EXHAUSTION_CANDIDATE).
   Step 2: A subsequent on-demand request with updated anchor returns exactly 0 messages with provider_status == 'OK'.
   Without this two-step confirmation, provider_exhausted is NEVER set to TRUE.
6. 3 consecutive stalled anchors transitions to CURSOR_STALLED, breaking pagination loops.

`provider_status` contract (Phase 2, H-4) — these three MUST stay distinguishable:

- `NOT_REQUESTED`  → the provider was genuinely never called. This is a cache hit.
                     INVARIANT 4: no evidence mutation whatsoever.
- `NO_ANCHOR`      → a fetch was requested but there was no cursor to fetch from.
                     Treated like NOT_REQUESTED: no evidence mutation (we learned nothing).
- `SOCKET_UNAVAILABLE` → a fetch WAS requested but the gateway socket was unusable.
                     This is a real provider failure, NOT a cache hit. It MUST be recorded
                     (state=PROVIDER_ERROR, error_count += 1) so a socket-less gateway can
                     never masquerade as a healthy "nothing to do".

Partial-timeout contract (Phase 2, H-3) — `provider_status == 'TIMEOUT'` with a NON-EMPTY
`gw_msgs` is a **partial** result, not a zero result:
  - `timeout_count` still increments (the round-trip did time out).
  - `provider_msgs_returned` records the messages we ACTUALLY received in this attempt, so the
    evidence never claims 0 while the client was handed real messages.
  - `provider_exhausted` is never set TRUE from a timeout, and an already-established
    exhaustion is never cleared by a timeout (a timeout is not evidence about completeness).
  - No exception is raised: the caller has usable data and pagination continues.

Both the background sweep and the on-demand path MUST funnel through this module. Two
independent exhaustion implementations is the bug this module exists to prevent.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


def _table_name(db: AsyncSession) -> str:
    """Returns the schema-qualified table name for PostgreSQL, or bare table for SQLite/test."""
    bind = getattr(db, "bind", None)
    if bind is not None and getattr(bind, "dialect", None) and bind.dialect.name != "postgresql":
        return "history_sync_states"
    return "whatsapp_private.history_sync_states"


async def get_history_evidence(
    db: AsyncSession, jid: str, session_id: Optional[str] = None
) -> Dict[str, Any]:
    """Retrieves current durable history evidence for a canonical JID and session.

    G-3 hardening: ``history_sync_states`` is keyed by ``(session_id, jid)`` where
    ``session_id`` is the GATEWAY session UUID. ``jid`` is a **natural key** -- the
    same counterparty phone number legitimately appears under more than one
    tenant's line -- so an unscoped ``WHERE jid = :jid`` returns *another
    tenant's* row (their exhaustion state, their provider message count).

    Contrast ``processed_events.event_id``: that is a synthetic
    ``crypto.randomUUID()``, globally unique by construction, so treating it as a
    global idempotency key is correct. The discriminator is synthetic-and-unique
    (safe to read globally) vs natural-and-repeating (never safe to read
    globally).

    A ``session_id`` is therefore REQUIRED. Without one this returns the
    fail-closed default rather than falling back to a cross-tenant read. All
    current callers already guard on a resolved session id; this makes that an
    enforced invariant instead of a convention repeated at three call sites.
    """
    default_resp = {
        "state": "NOT_CHECKED",
        "provider_checked": False,
        "provider_exhausted": False,
        "provider_msgs_returned": 0,
        "has_more": True,
        "stall_count": 0,
        "completed_at": None,
    }
    if not jid or not session_id:
        return default_resp

    try:
        tbl = _table_name(db)
        stmt = text(f"""
            SELECT state, provider_checked, provider_exhausted, provider_msgs_returned,
                   has_more, stall_count, completed_at
            FROM {tbl}
            WHERE session_id = :sid AND jid = :jid
        """)
        res = await db.execute(stmt, {"sid": str(session_id), "jid": str(jid)})

        row = res.fetchone()
        if not row:
            return default_resp

        st, p_checked, p_exhausted, p_msgs, h_more, stalls, comp_at = row
        normalized_st = "NOT_CHECKED" if (not st or st in ("NOT_CHECKED", "NEVER_CHECKED")) else st
        return {
            "state": normalized_st,
            "provider_checked": bool(p_checked),
            "provider_exhausted": bool(p_exhausted),
            "provider_msgs_returned": int(p_msgs or 0),
            "has_more": bool(h_more),
            "stall_count": int(stalls or 0),
            "completed_at": comp_at,
        }
    except Exception as exc:
        logger.debug("Failed to retrieve history evidence for %s: %s", jid, exc)
        return default_resp


async def is_history_exhausted_or_stalled(
    db: AsyncSession, jid: str, session_id: Optional[str] = None
) -> bool:
    """Returns True if the conversation is conclusively exhausted or stalled, preventing redundant fetches."""
    evidence = await get_history_evidence(db, jid, session_id=session_id)
    return bool(evidence["provider_exhausted"] or evidence["state"] in ("FULLY_EXHAUSTED", "CURSOR_STALLED"))


async def record_on_demand_provider_result(
    db: AsyncSession,
    session_id: str,
    jid: str,
    requested_count: int,
    provider_status: str,
    gw_msgs: Optional[List[Dict[str, Any]]] = None,
    oldest_msg_id: Optional[str] = None,
    before_ts_ms: Optional[int] = None,
    error_msg: Optional[str] = None,
    increment_sweep_count: bool = False,
) -> Optional[Dict[str, Any]]:
    """Records the outcome of a provider round-trip into history_sync_states.

    This is the SINGLE authority for the Phase 17 exhaustion policy. The on-demand
    scroll path and the (kill-switched) background sweep both call it, so they can
    never disagree about what "exhausted" means.

    Follows the strict Phase 17 state machine:
    - NOT_REQUESTED / NO_ANCHOR: Ignored (cache-hit rule, INVARIANT 4).
    - TIMEOUT: Increments timeout_count, leaves retryable. Partial results (gw_msgs
      non-empty) record their real count; they are never treated as zero/exhausted.
    - ERROR / SOCKET_UNAVAILABLE: Increments error_count, state=PROVIDER_ERROR.
    - OK + returned == requested: state=HAS_MORE.
    - OK + 0 < returned < requested: state=EXHAUSTION_CANDIDATE.
    - OK + returned == 0:
        if previous state == EXHAUSTION_CANDIDATE:
            state=FULLY_EXHAUSTED (second confirmation confirmed!)
        else:
            state=EXHAUSTION_CANDIDATE (requires second confirmation)
    - Stalled anchor: stall_count += 1. If stall_count >= 3: state=CURSOR_STALLED.

    `increment_sweep_count` is used only by the background sweep to keep its own
    `last_sweep_count` bookkeeping; it has no effect on the state machine.
    """
    if not session_id or not jid:
        return None

    # INVARIANT 4: Cache hit NEVER mutates provider evidence.
    # NO_ANCHOR means the gateway never reached the provider either, so it carries
    # no information about completeness — it must not touch evidence.
    if provider_status in ("NOT_REQUESTED", "NO_ANCHOR"):
        return None

    tbl = _table_name(db)
    sid_str = str(session_id)
    jid_str = str(jid)
    now_dt = datetime.now(timezone.utc)
    returned_count = len([m for m in (gw_msgs or []) if isinstance(m, dict)])
    sweep_delta = 1 if increment_sweep_count else 0

    # 1. Handle TIMEOUT (full OR partial — a partial timeout is still a timeout)
    if provider_status == "TIMEOUT":
        err_text = error_msg or "Gateway timeout waiting for provider chunk"
        await db.execute(
            text(f"""
                INSERT INTO {tbl} (
                    session_id, jid, has_more, state, timeout_count,
                    last_attempt_at, last_error, provider_checked,
                    provider_exhausted, provider_signal, provider_msgs_returned,
                    last_sweep_count, updated_at
                ) VALUES (
                    :sid, :jid, TRUE, 'TIMEOUT', 1,
                    :now, :err, :provider_checked,
                    FALSE, 'TIMEOUT', :msgs_returned,
                    :sweep_delta, :now
                )
                ON CONFLICT (session_id, jid) DO UPDATE SET
                    timeout_count = COALESCE({tbl}.timeout_count, 0) + 1,
                    last_attempt_at = :now,
                    last_error = :err,
                    state = 'TIMEOUT',
                    provider_signal = 'TIMEOUT',
                    provider_exhausted = COALESCE({tbl}.provider_exhausted, FALSE),
                    has_more = COALESCE({tbl}.has_more, TRUE),
                    provider_msgs_returned = :msgs_returned,
                    last_sweep_count = COALESCE({tbl}.last_sweep_count, 0) + :sweep_delta,
                    updated_at = :now
            """),
            {
                "sid": sid_str,
                "jid": jid_str,
                "err": err_text[:255],
                "now": now_dt,
                "provider_checked": False,
                "msgs_returned": returned_count,
                "sweep_delta": sweep_delta,
            },
        )
        return {
            "state": "TIMEOUT",
            "provider_checked": False,
            "provider_exhausted": False,
            "provider_msgs_returned": returned_count,
            "has_more": True,
        }

    # 2. Handle PROVIDER_ERROR / SOCKET_UNAVAILABLE
    if provider_status in ("ERROR", "SOCKET_UNAVAILABLE"):
        err_text = error_msg or f"Provider history error: {provider_status}"
        await db.execute(
            text(f"""
                INSERT INTO {tbl} (
                    session_id, jid, has_more, state, error_count,
                    last_attempt_at, last_error, provider_checked,
                    provider_exhausted, provider_signal, provider_msgs_returned,
                    last_sweep_count, updated_at
                ) VALUES (
                    :sid, :jid, TRUE, 'PROVIDER_ERROR', 1,
                    :now, :err, :provider_checked,
                    FALSE, 'ERROR', :msgs_returned,
                    :sweep_delta, :now
                )
                ON CONFLICT (session_id, jid) DO UPDATE SET
                    error_count = COALESCE({tbl}.error_count, 0) + 1,
                    last_attempt_at = :now,
                    last_error = :err,
                    state = 'PROVIDER_ERROR',
                    provider_signal = 'ERROR',
                    provider_exhausted = COALESCE({tbl}.provider_exhausted, FALSE),
                    has_more = COALESCE({tbl}.has_more, TRUE),
                    provider_msgs_returned = :msgs_returned,
                    last_sweep_count = COALESCE({tbl}.last_sweep_count, 0) + :sweep_delta,
                    updated_at = :now
            """),
            {
                "sid": sid_str,
                "jid": jid_str,
                "err": err_text[:255],
                "now": now_dt,
                "provider_checked": False,
                "msgs_returned": returned_count,
                "sweep_delta": sweep_delta,
            },
        )
        return {
            "state": "PROVIDER_ERROR",
            "provider_checked": False,
            "provider_exhausted": False,
            "provider_msgs_returned": returned_count,
            "has_more": True,
        }

    # 3. Handle provider_status == "OK"
    if provider_status != "OK":
        return None

    returned_msgs = gw_msgs or []
    returned_count = len(returned_msgs)
    cursor_used = f"{oldest_msg_id}:{before_ts_ms}" if oldest_msg_id else None

    # Inspect messages to find the lowest timestamp and message id
    new_oldest_ts_ms: Optional[int] = None
    new_oldest_id: Optional[str] = None
    if returned_msgs:
        valid_msgs = [m for m in returned_msgs if isinstance(m, dict)]
        if valid_msgs:
            min_msg = min(
                valid_msgs,
                key=lambda m: (
                    m.get("timestamp_s") or (int(m.get("id")) / 1000 if str(m.get("id", "")).isdigit() else float("inf")),
                    m.get("id") or float("inf"),
                ),
            )
            if min_msg.get("timestamp_s"):
                new_oldest_ts_ms = int(min_msg["timestamp_s"] * 1000)
            elif min_msg.get("id") and str(min_msg["id"]).isdigit():
                new_oldest_ts_ms = int(min_msg["id"])
            new_oldest_id = min_msg.get("wa_message_id")

    # Fetch prior history state to evaluate state machine transitions
    curr_state_res = await db.execute(
        text(f"""
            SELECT state, oldest_timestamp_ms, oldest_msg_id, stall_count, provider_checked, provider_exhausted
            FROM {tbl}
            WHERE session_id = :sid AND jid = :jid
        """),
        {"sid": sid_str, "jid": jid_str},
    )
    prev_row = curr_state_res.fetchone()
    raw_prev_state = prev_row[0] if (prev_row and prev_row[0]) else "NOT_CHECKED"
    prev_state = "NOT_CHECKED" if raw_prev_state in ("NOT_CHECKED", "NEVER_CHECKED") else raw_prev_state
    prev_oldest_ts_ms = prev_row[1] if prev_row else None
    prev_oldest_id = prev_row[2] if prev_row else None
    prev_stall_count = (prev_row[3] or 0) if prev_row else 0

    # Evaluate Stale Cursor
    is_stalled = False
    if returned_count > 0 and before_ts_ms is not None and new_oldest_ts_ms is not None:
        if new_oldest_ts_ms >= before_ts_ms and (oldest_msg_id and new_oldest_id == oldest_msg_id):
            is_stalled = True

    completed_at: Optional[datetime] = None

    if is_stalled:
        new_stall_count = prev_stall_count + 1
        if new_stall_count >= 3:
            new_state = "CURSOR_STALLED"
            new_signal = "CURSOR_STALLED"
            new_has_more = False
        else:
            new_state = prev_state if prev_state not in ("NOT_CHECKED", "CHECKING") else "HAS_MORE"
            new_signal = "STALLED"
            new_has_more = True
        new_exhausted = False
    elif returned_count == 0:
        new_stall_count = 0
        # INVARIANT 5: TWO-STEP EXHAUSTION CONFIRMATION
        if prev_state == "EXHAUSTION_CANDIDATE":
            new_state = "FULLY_EXHAUSTED"
            new_exhausted = True
            new_has_more = False
            completed_at = datetime.now(timezone.utc)
            new_signal = "OK"
        else:
            # First time receiving 0 messages: transition to EXHAUSTION_CANDIDATE
            new_state = "EXHAUSTION_CANDIDATE"
            new_exhausted = False
            new_has_more = True
            new_signal = "OK"
    elif 0 < returned_count < requested_count:
        new_stall_count = 0
        new_state = "EXHAUSTION_CANDIDATE"
        new_exhausted = False
        new_has_more = True
        new_signal = "OK"
    else:
        # returned_count >= requested_count
        new_stall_count = 0
        new_state = "HAS_MORE"
        new_exhausted = False
        new_has_more = True
        new_signal = "OK"

    effective_oldest_id = new_oldest_id or oldest_msg_id or prev_oldest_id
    effective_oldest_ts = new_oldest_ts_ms or before_ts_ms or prev_oldest_ts_ms

    await db.execute(
        text(f"""
            INSERT INTO {tbl} (
                session_id, jid, oldest_msg_id, oldest_timestamp_ms, has_more,
                completed_at, updated_at, state, stall_count, last_attempt_at,
                last_success_at, last_error, provider_checked, provider_checked_at,
                provider_exhausted, provider_signal, provider_msgs_returned, provider_cursor_used,
                last_sweep_count
            ) VALUES (
                :sid, :jid, :oldest_msg_id, :oldest_ts_ms, :has_more,
                :completed_at, :now, :state, :stall_count, :now,
                :now, NULL, :provider_checked, :now,
                :provider_exhausted, :provider_signal, :provider_msgs_returned, :provider_cursor_used,
                :sweep_delta
            )
            ON CONFLICT (session_id, jid) DO UPDATE SET
                oldest_msg_id = COALESCE(:oldest_msg_id, {tbl}.oldest_msg_id),
                oldest_timestamp_ms = CASE 
                    WHEN :oldest_ts_ms IS NOT NULL AND ({tbl}.oldest_timestamp_ms IS NULL OR :oldest_ts_ms < {tbl}.oldest_timestamp_ms)
                    THEN :oldest_ts_ms
                    ELSE {tbl}.oldest_timestamp_ms
                END,
                has_more = :has_more,
                completed_at = CASE WHEN :completed_at IS NOT NULL THEN :completed_at ELSE {tbl}.completed_at END,
                updated_at = :now,
                state = :state,
                stall_count = :stall_count,
                last_attempt_at = :now,
                last_success_at = :now,
                last_error = NULL,
                provider_checked = :provider_checked,
                provider_checked_at = :now,
                provider_exhausted = :provider_exhausted,
                provider_signal = :provider_signal,
                provider_msgs_returned = :provider_msgs_returned,
                provider_cursor_used = :provider_cursor_used,
                last_sweep_count = COALESCE({tbl}.last_sweep_count, 0) + :sweep_delta
        """),
        {
            "sid": sid_str,
            "jid": jid_str,
            "oldest_msg_id": effective_oldest_id,
            "oldest_ts_ms": effective_oldest_ts,
            "has_more": new_has_more,
            "completed_at": completed_at,
            "state": new_state,
            "stall_count": new_stall_count,
            "provider_checked": True,
            "provider_exhausted": new_exhausted,
            "provider_signal": new_signal,
            "provider_msgs_returned": returned_count,
            "provider_cursor_used": cursor_used,
            "sweep_delta": sweep_delta,
            "now": now_dt,
        },
    )

    logger.info(
        "[HISTORY_EVIDENCE] Recorded session=%s jid=%s state=%s msgs=%d exhausted=%s",
        sid_str,
        jid_str,
        new_state,
        returned_count,
        new_exhausted,
    )

    return {
        "state": new_state,
        "provider_checked": True,
        "provider_exhausted": new_exhausted,
        "provider_msgs_returned": returned_count,
        "has_more": new_has_more,
    }
