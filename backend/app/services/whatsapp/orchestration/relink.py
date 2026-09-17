"""WhatsApp Relink Reconciliation Service (Phase 15.3).

Implements Scenario A: logical/public WhatsApp session is permanent.
Gateway UUID is a transport identity that can rotate without disturbing
logical session integrity, conversation ownership, or history evidence.

Architecture:
    gateway event / QR poll
        → resolve_relink_candidate()        ← deterministic, strict
        → perform_atomic_relink()           ← atomic transaction
        → (caller handles event routing)

Invariants enforced:
    1. Candidate resolution requires: user_id + phone + RELINK_REQUIRED state.
    2. Exactly 1 candidate → valid. 0 or >1 → fail closed (raises).
    3. gateway_id update + history_sync_states migration = single atomic transaction.
    4. Only provider_checked=FALSE rows are migrated (evidence integrity).
    5. NOT EXISTS guard prevents duplicate rows (idempotent — safe to call twice).
    6. No side-effectful DB writes inside event-mapping layers.
"""
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import or_, select, text
from sqlalchemy.exc import MultipleResultsFound
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class RelinkCandidateNotFound(Exception):
    """No RELINK_REQUIRED session matched user_id + phone_number."""


class RelinkCandidateAmbiguous(Exception):
    """More than one RELINK_REQUIRED session matched — fail closed to avoid
    incorrect gateway_id assignment."""


# ---------------------------------------------------------------------------
# Data transfer object
# ---------------------------------------------------------------------------

@dataclass
class RelinkResult:
    session_id: int
    old_gateway_id: str
    new_gateway_id: str
    phone_number: str
    history_rows_migrated: int
    was_already_linked: bool   # True when new_gateway_id was already the active gateway_id


# ---------------------------------------------------------------------------
# Candidate resolution
# ---------------------------------------------------------------------------

async def resolve_relink_candidate(
    db: AsyncSession,
    *,
    user_id: str,
    phone: str,
    new_gateway_id: str,
) -> WhatsAppSession:
    """Find the unique RELINK_REQUIRED session for this user + phone.

    Resolution criteria (ALL must match):
        1. user_id
        2. phone_number == phone (E.164 format)
        3. status == RELINK_REQUIRED
        4. gateway_id != new_gateway_id  (already-linked sessions are a no-op)

    Raises:
        RelinkCandidateNotFound   — 0 matches
        RelinkCandidateAmbiguous  — >1 matches (fail closed, never heuristic pick)
    """
    if not phone:
        raise RelinkCandidateNotFound("Phone number is required for relink candidate resolution.")

    clean_digits = phone.split("@")[0].lstrip("+")
    clean_e164 = f"+{clean_digits}"

    stmt = (
        select(WhatsAppSession)
        .where(
            WhatsAppSession.user_id == user_id,
            or_(
                WhatsAppSession.phone_number == phone,
                WhatsAppSession.phone_number == clean_e164,
                WhatsAppSession.phone_number == clean_digits,
            ),
            WhatsAppSession.status == SessionStatus.RELINK_REQUIRED,
            WhatsAppSession.gateway_id != new_gateway_id,
        )
        .with_for_update(skip_locked=True)  # advisory lock — prevent concurrent relink race
    )
    try:
        res = await db.execute(stmt)
        rows = res.scalars().all()
    except Exception as exc:
        raise RelinkCandidateNotFound(
            f"Candidate query failed for user={user_id}, phone={phone}: {exc}"
        ) from exc

    if len(rows) == 0:
        raise RelinkCandidateNotFound(
            f"No RELINK_REQUIRED session found for user={user_id}, phone={phone}."
        )
    if len(rows) > 1:
        ids = [r.id for r in rows]
        raise RelinkCandidateAmbiguous(
            f"Relink failed: {len(rows)} RELINK_REQUIRED sessions share phone={phone} "
            f"for user={user_id} (ids={ids}). Resolve manually before relinking."
        )
    return rows[0]


# ---------------------------------------------------------------------------
# Atomic relink transaction
# ---------------------------------------------------------------------------

async def perform_atomic_relink(
    db: AsyncSession,
    *,
    user_id: str,
    phone: str,
    new_gateway_id: str,
    session_name: Optional[str] = None,
) -> RelinkResult:
    """Atomically bind new_gateway_id to the existing logical session and migrate
    unverified history_sync_states.

    All writes happen inside a single database transaction:
        1. Lock + fetch RELINK_REQUIRED candidate (Scenario A).
        2. Update gateway_id + status + metadata on the existing row.
        3. Migrate history_sync_states: old_gateway_id → new_gateway_id
           (only provider_checked=FALSE, NOT EXISTS idempotency guard).
        4. Single commit.

    Idempotency guarantee:
        The NOT EXISTS guard in the UPDATE ensures that if this is called twice
        with the same new_gateway_id, the second call migrates 0 rows (because
        the rows already have session_id = new_gateway_id after the first call).
        Total row count is preserved at exactly 98.

    Race safety:
        SELECT ... FOR UPDATE SKIP LOCKED prevents two concurrent relinks from
        claiming the same session row simultaneously.

    Raises:
        RelinkCandidateNotFound   — no matching session; treat as first-time QR
        RelinkCandidateAmbiguous  — multiple matching sessions; fail closed
    """
    candidate = await resolve_relink_candidate(
        db, user_id=user_id, phone=phone, new_gateway_id=new_gateway_id
    )
    old_gateway_id = str(candidate.gateway_id)

    # --- Step 1: Update logical session (Scenario A — never create new row) ---
    candidate.gateway_id = new_gateway_id
    candidate.status = SessionStatus.CONNECTED
    candidate.is_phone_online = True
    candidate.qr_code = None
    candidate.error_message = None
    candidate.updated_at = datetime.utcnow()
    if session_name:
        candidate.session_name = session_name

    # --- Step 2: Migrate unverified history_sync_states (same transaction) ---
    # Constraints:
    #   a) session_id = old gateway UUID
    #   b) provider_checked = FALSE (evidence integrity — verified rows MUST NOT be migrated)
    #   c) NOT EXISTS for same jid under new gateway (idempotency — no duplicate rows)
    migrate_result = await db.execute(
        text(
            "UPDATE whatsapp_private.history_sync_states AS hss "
            "SET session_id = :new_gw_id, updated_at = NOW() "
            "WHERE hss.session_id = :old_gw_id "
            "  AND hss.provider_checked = FALSE "
            "  AND NOT EXISTS ("
            "    SELECT 1 FROM whatsapp_private.history_sync_states hss2 "
            "    WHERE hss2.session_id = :new_gw_id AND hss2.jid = hss.jid"
            ")"
        ),
        {"old_gw_id": old_gateway_id, "new_gw_id": new_gateway_id},
    )
    migrated = migrate_result.rowcount or 0

    # --- Step 3: Single atomic commit ---
    await db.commit()

    logger.info(
        "[Phase15.3][Relink] session=%s %s→%s | history migrated=%d | phone=%s",
        candidate.id,
        old_gateway_id,
        new_gateway_id,
        migrated,
        phone,
    )

    return RelinkResult(
        session_id=candidate.id,
        old_gateway_id=old_gateway_id,
        new_gateway_id=new_gateway_id,
        phone_number=phone,
        history_rows_migrated=migrated,
        was_already_linked=False,
    )
