"""Phase 6.8 — authoritative promotion of an ephemeral pairing to a durable session.

The defect this module fixes
----------------------------
`_map_session_event` (`orchestration/events.py`) could only *update* an existing
`public.whatsapp_sessions` row or *relink* an existing `RELINK_REQUIRED` row. It
had no branch that CREATES a row. For a first-time QR pairing the only
row-creating code path in the whole backend was `get_pairing_qr` ->
"Scenario A-new" — i.e. promotion silently depended on the browser continuing to
poll `GET /pairing/{token}/qr` until the gateway reported `CONNECTED`.

The real frontend stops polling at exactly that moment (the WS
`session_connected` handler flips the modal to `CONNECTED`, which disables the
poll) and then closes the modal, whose cleanup calls `cancelPairing`. Production
consequently ended with a phone that had genuinely connected, a gateway session
that had genuinely been promoted by `connection.open`, and **no durable row** —
so every later event was rejected as an unknown gateway session (2 904 dropped in
60 s).

What this module does
---------------------
`promote_ephemeral_pairing` is the single, idempotent entry point that can
complete a promotion **from the `session_connected` event alone**, using only
owner-safe metadata:

* the ephemeral registry (in-memory, passed in by the caller), or
* the durable pairing record (`pairing_registry`), so a lost token map or a
  backend restart cannot destroy a valid promotion,

and the event payload's `phone` / `self_jid`.

Tenant safety (G-3) is NOT weakened:
* the owner is never inferred from arbitrary gateway state — only from a pairing
  record that names this exact gateway session;
* no record -> return None (fail closed; the caller keeps its existing
  `EventOwnerUnresolved` behaviour);
* a row already bound to a DIFFERENT tenant -> fail closed, never reassigned;
* a session that is already CONNECTED under a different gateway id is never
  overwritten by a stale/late promotion.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp.orchestration import pairing_registry
from backend.app.services.whatsapp.orchestration.relink import (
    RelinkCandidateAmbiguous,
    RelinkCandidateNotFound,
    find_existing_session_for_phone,
    perform_atomic_relink,
)

logger = logging.getLogger(__name__)

_PHONE_JID_RE = re.compile(r"^(\d{7,15})@s\.whatsapp\.net$")


def phone_from_self_jid(self_jid: Optional[str]) -> Optional[str]:
    """Derive an E.164 phone from a phone-JID.

    Only `@s.whatsapp.net` with an all-digit local part is accepted. A `@lid`
    local part is an opaque LID and is NOT a phone number — returning it would
    create a session whose `phone_number` is a LID (AGENTS.md §1.3 forbids
    synthesising phone numbers). Anything unprovable yields None.
    """
    if not self_jid:
        return None
    m = _PHONE_JID_RE.match(str(self_jid).strip())
    if not m:
        return None
    return f"+{m.group(1)}"


def _same_owner(a: Any, b: Any) -> bool:
    """Compare two owner ids, tolerating the dashed/hex UUID forms.

    The auth layer legitimately yields both (`get_user_filter` accepts either),
    so a raw string comparison would reject a legitimate owner and fail the
    promotion closed for the wrong reason.
    """
    if a is None or b is None:
        return False
    return str(a).replace("-", "").lower() == str(b).replace("-", "").lower()


async def _finalize_promotion(
    db: AsyncSession, row: WhatsAppSession, gateway_session_id: str
) -> Optional[WhatsAppSession]:
    """Best-effort pairing bookkeeping, then hand back a LOADED row.

    This exists because of a real crash (Phase 6.8). `consume_pairing` is
    deliberately best-effort: if the durable pairing table is missing (a
    deployment that has not created it yet) it catches the error and calls
    `db.rollback()`. A rollback **expires every ORM instance in the session**,
    and the next bare attribute read (`row.id` in a log call) then triggers a
    synchronous lazy load — which on an `AsyncSession` raises
    `greenlet_spawn has not been called`. That exception escaped this module,
    `ingest_gateway_event` treated the event as failed and dropped it, and a
    promotion that had ALREADY been committed was reported as lost.

    So the order here is load-bearing:
      1. capture the primary key while the instance is still loaded,
      2. run the bookkeeping,
      3. re-load the row inside an `await` — the only place SQLAlchemy may
         perform IO on an async session,
      4. return the loaded instance (or None if it vanished).

    A failure in the bookkeeping can no longer destroy a completed promotion:
    "lost UI/token bookkeeping must not destroy an otherwise valid gateway
    promotion."
    """
    row_id = row.id
    try:
        await pairing_registry.consume_pairing(db, gateway_session_id)
    except Exception as exc:  # noqa: BLE001 - bookkeeping must never break promotion
        logger.warning(
            "[WhatsApp][6.8] Pairing bookkeeping raised for gateway %s (%s); the "
            "promotion is unaffected.",
            gateway_session_id,
            exc,
        )
    try:
        await db.refresh(row)
        return row
    except Exception as exc:  # noqa: BLE001 - never fail a committed promotion here
        logger.warning(
            "[WhatsApp][6.8] Reload after pairing bookkeeping failed for session=%s "
            "(%s); re-reading by primary key.",
            row_id,
            exc,
        )
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return await db.scalar(select(WhatsAppSession).where(WhatsAppSession.id == row_id))


async def _resolve_owner(
    db: AsyncSession,
    gateway_session_id: str,
    in_memory: Optional[Dict[str, Any]],
    user_id: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Resolve the pairing record for this gateway session, or None (fail closed).

    Order: explicit argument -> in-memory registry -> durable registry.
    """
    if user_id:
        name = None
        if in_memory:
            name = in_memory.get("session_name")
        return {"user_id": str(user_id), "session_name": name, "logical_session_id": None}

    if in_memory and in_memory.get("user_id"):
        return {
            "user_id": str(in_memory["user_id"]),
            "session_name": in_memory.get("session_name"),
            "logical_session_id": in_memory.get("logical_session_id"),
        }

    durable = await pairing_registry.resolve_open_pairing(db, gateway_session_id)
    if durable and durable.get("user_id"):
        return durable

    return None


async def promote_ephemeral_pairing(
    db: AsyncSession,
    *,
    gateway_session_id: str,
    user_id: Optional[str] = None,
    phone: Optional[str] = None,
    session_name: Optional[str] = None,
    self_jid: Optional[str] = None,
    self_lid: Optional[str] = None,
    in_memory_pairing: Optional[Dict[str, Any]] = None,
) -> Optional[WhatsAppSession]:
    """Ensure a durable CONNECTED `public.whatsapp_sessions` row exists.

    Idempotent. Returns the row on success, or None when the promotion cannot be
    performed safely (unknown gateway session, cross-tenant conflict, or a stale
    promotion that would overwrite a live session) — in which case the caller
    must keep failing closed.
    """
    gw_id = str(gateway_session_id or "").strip()
    if not gw_id:
        return None

    # ------------------------------------------------------------------
    # 1. Resolve the OWNER first and fail closed before touching any row.
    #    Tenant safety is the OUTERMOST gate: an unknown gateway session must
    #    never reach the mutation paths below, not even to read a row it might
    #    then be tempted to adopt. This is also what makes an unknown session
    #    cheap — one pairing lookup, no row scan, no write.
    # ------------------------------------------------------------------
    owner = await _resolve_owner(db, gw_id, in_memory_pairing, user_id)
    if owner is None:
        logger.warning(
            "[WhatsApp][6.8] No pairing record for gateway session %s — cannot prove "
            "the owner, promotion refused (fail closed).",
            gw_id,
        )
        return None

    owner_id = str(owner["user_id"])

    # ------------------------------------------------------------------
    # 2. Already bound? Update in place (idempotent for duplicate events).
    #    From `_map_session_event` this is unreachable (it only calls here once
    #    it knows no row exists for `gw_id`); it matters for the cancel path,
    #    where the promotion may already have completed.
    # ------------------------------------------------------------------
    existing = await db.scalar(
        select(WhatsAppSession).where(WhatsAppSession.gateway_id == gw_id)
    )
    if existing is not None:
        if existing.user_id and not _same_owner(existing.user_id, owner_id):
            logger.error(
                "[WhatsApp][6.8] Refusing promotion: gateway session %s is bound to a "
                "different tenant (row user_id=%s, pairing owner=%s) — fail closed.",
                gw_id,
                existing.user_id,
                owner_id,
            )
            return None
        resolved_phone = phone or phone_from_self_jid(self_jid)
        existing.status = SessionStatus.CONNECTED
        existing.is_active = True
        existing.is_phone_online = True
        existing.qr_code = None
        existing.error_message = None
        if resolved_phone:
            existing.phone_number = str(resolved_phone)
        if session_name:
            existing.session_name = session_name
        existing.updated_at = datetime.utcnow()
        await db.commit()
        existing = await _finalize_promotion(db, existing, gw_id)
        if existing is None:
            return None
        logger.info(
            "[WhatsApp][6.8] Promotion idempotent-update: session=%s gateway=%s",
            existing.id,
            gw_id,
        )
        return existing

    # ------------------------------------------------------------------
    # 3. Owner resolved and no row exists yet.
    # ------------------------------------------------------------------
    resolved_name = session_name or owner.get("session_name") or "Hat 1"
    resolved_phone = phone or phone_from_self_jid(self_jid)
    if not resolved_phone:
        # self_lid is deliberately NOT used: a LID is not a phone number.
        logger.info(
            "[WhatsApp][6.8] Promoting %s without a phone number (none derivable from "
            "the event payload); phone_number stays NULL per AGENTS.md §1.3.",
            gw_id,
        )

    # ------------------------------------------------------------------
    # 3a. Preferred: the existing RELINK path. It locks the row, rebinds the
    #     gateway id, migrates unverified history_sync_states and commits — all
    #     in one transaction. It only ever matches a RELINK_REQUIRED row
    #     (`relink.py:99`), so it can never steal a live CONNECTED session.
    # ------------------------------------------------------------------
    if resolved_phone:
        try:
            result = await perform_atomic_relink(
                db,
                user_id=owner_id,
                phone=resolved_phone,
                new_gateway_id=gw_id,
                session_name=resolved_name,
            )
            row = await db.scalar(
                select(WhatsAppSession).where(WhatsAppSession.id == result.session_id)
            )
            if row is not None:
                row = await _finalize_promotion(db, row, gw_id)
            else:
                await pairing_registry.consume_pairing(db, gw_id)
            if row is not None:
                logger.info(
                    "[WhatsApp][6.8] Promotion via relink: session=%s gateway=%s "
                    "(history migrated=%d)",
                    row.id,
                    gw_id,
                    result.history_rows_migrated,
                )
                return row
        except RelinkCandidateAmbiguous as exc:
            logger.error(
                "[WhatsApp][6.8] Promotion ambiguous for phone %s — fail closed: %s",
                resolved_phone,
                exc,
            )
            return None
        except RelinkCandidateNotFound:
            pass  # no RELINK_REQUIRED candidate -> first-time pairing (or a live one)

    # ------------------------------------------------------------------
    # 3b. No relink candidate. Reuse the row for this phone ONLY if it is not
    #     already live under a different gateway — a stale/late promotion must
    #     never overwrite a working session.
    # ------------------------------------------------------------------
    if resolved_phone:
        candidate = await find_existing_session_for_phone(
            db, user_id=owner_id, phone=resolved_phone, exclude_gateway_id=gw_id
        )
        if candidate is not None:
            if str(candidate.user_id) not in (owner_id, owner_id.replace("-", "")):
                # `find_existing_session_for_phone` is already tenant-scoped; this
                # is a belt-and-braces guard against a filter regression.
                logger.error(
                    "[WhatsApp][6.8] Refusing promotion: phone %s resolves to tenant %s, "
                    "not the pairing owner %s — fail closed.",
                    resolved_phone,
                    candidate.user_id,
                    owner_id,
                )
                return None
            if candidate.status == SessionStatus.CONNECTED and candidate.is_active:
                logger.warning(
                    "[WhatsApp][6.8] Refusing promotion of %s: phone %s is already "
                    "CONNECTED under gateway %s. A stale/late session must not "
                    "overwrite a live one — fail closed.",
                    gw_id,
                    resolved_phone,
                    candidate.gateway_id,
                )
                return None
            candidate.gateway_id = gw_id
            candidate.status = SessionStatus.CONNECTED
            candidate.is_active = True
            candidate.is_phone_online = True
            candidate.qr_code = None
            candidate.error_message = None
            candidate.session_name = resolved_name
            candidate.updated_at = datetime.utcnow()
            await db.commit()
            candidate = await _finalize_promotion(db, candidate, gw_id)
            if candidate is None:
                return None
            logger.info(
                "[WhatsApp][6.8] Promotion reused existing session id=%s for phone=%s "
                "(gateway %s)",
                candidate.id,
                resolved_phone,
                gw_id,
            )
            return candidate

    # ------------------------------------------------------------------
    # 4. First-time pairing: CREATE the durable row. This is the branch that
    #    did not exist before 6.8 and that production needed.
    # ------------------------------------------------------------------
    row = WhatsAppSession(
        user_id=owner_id,
        gateway_id=gw_id,
        session_name=resolved_name,
        status=SessionStatus.CONNECTED,
        phone_number=str(resolved_phone) if resolved_phone else None,
        is_active=True,
        is_phone_online=True,
    )
    db.add(row)
    try:
        await db.commit()
    except Exception as exc:  # noqa: BLE001 - a unique(gateway_id) race is not fatal
        await db.rollback()
        logger.warning(
            "[WhatsApp][6.8] Promotion INSERT raced for gateway %s (%s); re-reading.",
            gw_id,
            exc,
        )
        row = await db.scalar(
            select(WhatsAppSession).where(WhatsAppSession.gateway_id == gw_id)
        )
        if row is None:
            return None
    row = await _finalize_promotion(db, row, gw_id)
    if row is None:
        return None
    logger.info(
        "[WhatsApp][6.8] Promotion created durable session id=%s gateway=%s owner=%s "
        "phone=%s",
        row.id,
        gw_id,
        owner_id,
        resolved_phone,
    )
    return row
