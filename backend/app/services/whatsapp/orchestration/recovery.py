"""WhatsApp Logical Session Recovery Service (Phase 15.4+).

Recovers permanent logical WhatsApp sessions from orphaned gateway session evidence:
- Identifies orphaned gateway sessions in whatsapp_private.gateway_sessions that hold
  history_sync_states without a corresponding public.whatsapp_sessions entry.
- Resolves definite user and phone ownership (fail-closed on cross-user ambiguity).
- Creates a new logical session in public.whatsapp_sessions with status=RELINK_REQUIRED
  using standard auto-increment IDs (NO sequence manipulation, NO hardcoded IDs).
- Enforces strict idempotency (repeated recovery returns the existing candidate).
- Preserves all 98 history_sync_states rows completely untouched (provider_checked=0).
- Sets the recovered gateway_id as the lineage anchor so the subsequent QR pairing
  can atomically rebind the session and migrate history states via perform_atomic_relink().
"""
from dataclasses import dataclass
from datetime import datetime
import logging
import re
from typing import List, Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class OrphanRecoveryError(Exception):
    """Base exception for orphan recovery errors."""


class NoOrphanLineageFound(OrphanRecoveryError):
    """No matching orphaned gateway lineage with history states found."""


class AmbiguousOrphanLineage(OrphanRecoveryError):
    """Multiple candidate orphaned lineages found without a unique identifier."""


class ConflictingSessionExists(OrphanRecoveryError):
    """An active or non-relink session already exists for this user and phone."""


class CrossUserPhoneConflict(OrphanRecoveryError):
    """The requested phone number is owned by a different user."""


class InvalidPhoneFormat(OrphanRecoveryError):
    """Phone number does not meet E.164 format requirements."""


# ---------------------------------------------------------------------------
# Data Transfer Objects
# ---------------------------------------------------------------------------

@dataclass
class OrphanGatewayEvidence:
    old_gateway_id: str
    session_name: str
    history_state_count: int
    checked_state_count: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class RecoveryResult:
    session_id: int
    user_id: str
    phone_number: str
    session_name: str
    old_gateway_id: str
    history_state_count: int
    status: str
    was_already_recovered: bool
    lineage_source: str


# ---------------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------------

def normalize_phone_e164(phone: str) -> str:
    """Validates and normalizes phone number to strict E.164 format (+<digits>)."""
    cleaned = re.sub(r"[^\d+]", "", phone.strip())
    if not cleaned.startswith("+"):
        cleaned = f"+{cleaned}"
    if not re.match(r"^\+[1-9]\d{7,14}$", cleaned):
        raise InvalidPhoneFormat(f"Invalid E.164 phone format: '{phone}'")
    return cleaned


# ---------------------------------------------------------------------------
# Orphan Detection & Recovery Engine
# ---------------------------------------------------------------------------

async def detect_orphaned_gateway_lineages(
    db: AsyncSession,
) -> List[OrphanGatewayEvidence]:
    """Scans the database for gateway sessions holding history_sync_states
    that have NO corresponding row in public.whatsapp_sessions.
    
    Returns list of OrphanGatewayEvidence ordered by most recent activity.
    """
    sql = text(
        """
        SELECT 
            gs.session_id,
            COALESCE(gs.session_name, 'Hat 1') AS session_name,
            COUNT(hss.jid)::integer AS history_state_count,
            COUNT(CASE WHEN hss.provider_checked = TRUE THEN 1 END)::integer AS checked_state_count,
            gs.created_at,
            gs.updated_at
        FROM whatsapp_private.gateway_sessions gs
        INNER JOIN whatsapp_private.history_sync_states hss 
            ON hss.session_id = gs.session_id
        WHERE NOT EXISTS (
            SELECT 1 
            FROM public.whatsapp_sessions ws 
            WHERE ws.gateway_id = gs.session_id
        )
        GROUP BY gs.session_id, gs.session_name, gs.created_at, gs.updated_at
        HAVING COUNT(hss.jid) > 0
        ORDER BY gs.updated_at DESC
        """
    )
    res = await db.execute(sql)
    rows = res.fetchall()

    orphans: List[OrphanGatewayEvidence] = []
    for r in rows:
        orphans.append(
            OrphanGatewayEvidence(
                old_gateway_id=r[0],
                session_name=r[1],
                history_state_count=r[2],
                checked_state_count=r[3],
                created_at=r[4],
                updated_at=r[5],
            )
        )
    return orphans


async def recover_orphan_logical_session(
    db: AsyncSession,
    *,
    user_id: str,
    phone: str,
    old_gateway_id: Optional[str] = None,
    session_name: Optional[str] = None,
    lineage_source: str = "ORPHAN_GATEWAY_HISTORY_EVIDENCE",
) -> RecoveryResult:
    """Recovers an orphaned gateway session into a permanent logical session in
    public.whatsapp_sessions.
    
    Guarantees:
    1. Phone is validated to strict E.164.
    2. Fail closed if the phone is claimed by a different user.
    3. Idempotent: If this session was already recovered, returns the existing
       session without creating duplicates (session count = 1).
    4. Fail closed if an active (CONNECTED, SCAN_QR) session already exists for this (user, phone).
    5. Produces a standard new auto-increment ID (NO sequence manipulation).
    6. All history_sync_states rows remain completely untouched (provider_checked=0 preserved).
    """
    if not user_id or not str(user_id).strip():
        raise OrphanRecoveryError("user_id is required for logical session recovery.")
    
    clean_phone = normalize_phone_e164(phone)

    # 1. Ownership conflict check: Does another user own this phone?
    cross_user_stmt = select(WhatsAppSession).where(
        WhatsAppSession.phone_number == clean_phone,
        WhatsAppSession.user_id != user_id,
        WhatsAppSession.is_active.is_(True),
    )
    cross_res = await db.execute(cross_user_stmt)
    cross_sessions = cross_res.scalars().all()
    if cross_sessions:
        other_user = str(cross_sessions[0].user_id)
        raise CrossUserPhoneConflict(
            f"Phone {clean_phone} is already associated with user {other_user}. Fail closed."
        )

    # 2. Idempotency check: Has this user already recovered this session?
    existing_stmt = select(WhatsAppSession).where(
        WhatsAppSession.user_id == user_id,
        WhatsAppSession.phone_number == clean_phone,
        WhatsAppSession.is_active.is_(True),
    )
    existing_res = await db.execute(existing_stmt)
    existing_sessions = existing_res.scalars().all()

    for s in existing_sessions:
        if s.status == SessionStatus.RELINK_REQUIRED:
            # If old_gateway_id is specified and matches, or matches existing gateway anchor
            if old_gateway_id is None or s.gateway_id == old_gateway_id:
                # Count history states currently associated
                cnt_res = await db.execute(
                    text(
                        "SELECT count(*) FROM whatsapp_private.history_sync_states WHERE session_id = :gid"
                    ),
                    {"gid": s.gateway_id},
                )
                h_count = cnt_res.scalar() or 0
                logger.info(
                    "[Recovery] Idempotent hit: session_id=%s already recovered for user=%s phone=%s (gateway=%s)",
                    s.id,
                    user_id,
                    clean_phone,
                    s.gateway_id,
                )
                return RecoveryResult(
                    session_id=s.id,
                    user_id=str(s.user_id),
                    phone_number=s.phone_number,
                    session_name=s.session_name,
                    old_gateway_id=s.gateway_id,
                    history_state_count=h_count,
                    status=s.status.value,
                    was_already_recovered=True,
                    lineage_source=lineage_source,
                )
        else:
            # An active session with status CONNECTED, SCAN_QR, etc. already exists
            raise ConflictingSessionExists(
                f"Active session id={s.id} with status={s.status.value} already exists for "
                f"user={user_id}, phone={clean_phone}. Cannot recover."
            )

    # 3. Detect orphaned gateway evidence
    orphans = await detect_orphaned_gateway_lineages(db)

    selected_evidence: Optional[OrphanGatewayEvidence] = None
    if old_gateway_id:
        matched = [o for o in orphans if o.old_gateway_id == old_gateway_id]
        if not matched:
            raise NoOrphanLineageFound(
                f"Gateway UUID '{old_gateway_id}' is not an unlinked orphan with history states."
            )
        selected_evidence = matched[0]
    else:
        if len(orphans) == 0:
            raise NoOrphanLineageFound(
                "No orphaned gateway sessions with history states found in the database."
            )
        if len(orphans) > 1:
            candidates = [f"{o.old_gateway_id} ({o.history_state_count} states)" for o in orphans]
            raise AmbiguousOrphanLineage(
                f"Multiple orphan candidates found ({', '.join(candidates)}). "
                "Specify old_gateway_id explicitly to resolve deterministic lineage."
            )
        selected_evidence = orphans[0]

    # 4. Create new permanent logical session in RELINK_REQUIRED state
    target_name = session_name or selected_evidence.session_name or "Hat 1"
    new_session = WhatsAppSession(
        user_id=user_id,
        gateway_id=selected_evidence.old_gateway_id,  # Anchor to orphan gateway for relink migration
        session_name=target_name,
        phone_number=clean_phone,
        status=SessionStatus.RELINK_REQUIRED,
        is_active=True,
        is_phone_online=False,
        error_message="WHATSAPP_AUTH_RELINK_REQUIRED",
    )
    db.add(new_session)
    await db.commit()
    await db.refresh(new_session)

    logger.info(
        "[Recovery] Successfully recovered logical session: id=%s user=%s phone=%s gateway=%s (history_states=%d)",
        new_session.id,
        user_id,
        clean_phone,
        selected_evidence.old_gateway_id,
        selected_evidence.history_state_count,
    )

    return RecoveryResult(
        session_id=new_session.id,
        user_id=str(new_session.user_id),
        phone_number=new_session.phone_number,
        session_name=new_session.session_name,
        old_gateway_id=selected_evidence.old_gateway_id,
        history_state_count=selected_evidence.history_state_count,
        status=new_session.status.value,
        was_already_recovered=False,
        lineage_source=lineage_source,
    )
