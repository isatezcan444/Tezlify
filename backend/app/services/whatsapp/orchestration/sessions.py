"""WhatsApp Session Orchestration Service (Phase 11.9).

Handles WhatsApp tenant session lifecycle:
- Session creation, listing, status synchronization with gateway
- QR code retrieval and refresh
- Pairing code requests
- Logout and session termination
- Durable relink detection and self-healing
- Cascading data purge on session deletion
"""
from datetime import datetime
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
import uuid

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.websocket import ws_manager
from backend.app.core.auth import get_user_filter
from backend.app.services.whatsapp.identity import SYSTEM_USER_ID
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp.exceptions import (
    NoWhatsAppSession,
    WhatsAppRelinkRequired,
)
from backend.app.services.whatsapp.gateway import (
    extract_live_session_fields,
    extract_pairing_code,
    extract_session_id,
    is_gateway_session_missing,
)
from backend.app.services.whatsapp.orchestration.relink import (
    RelinkCandidateAmbiguous,
    RelinkCandidateNotFound,
    perform_atomic_relink,
)
from backend.app.services.whatsapp.repositories.sessions import (
    get_session_by_id as _get_session_or_404,
)
from backend.app.services.whatsapp.status_policy import (
    parse_session_status as _parse_status,
)

logger = logging.getLogger(__name__)

_GATEWAY_SESSION_MISSING = "session not found"


def _session_dict(row: WhatsAppSession) -> Dict[str, Any]:
    """Serializes WhatsAppSession ORM entity to API dictionary."""
    return {
        "id": row.id,
        "session_name": row.session_name,
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "phone_number": row.phone_number,
        "is_active": row.is_active,
        "is_phone_online": row.is_phone_online,
        "battery_level": row.battery_level,
        "qr_code": row.qr_code,
        "error_message": row.error_message,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _apply_gateway_live(row: WhatsAppSession, data: Dict[str, Any]) -> None:
    """Applies live gateway status fields to session row entity in-memory."""
    fields = extract_live_session_fields(data)
    if fields["status"]:
        row.status = _parse_status(fields["status"])
    if fields["phone"]:
        row.phone_number = fields["phone"]
    if fields["error_message"] is not None:
        row.error_message = fields["error_message"]
    if fields["status"] in ("CONNECTED", "SCAN_QR"):
        row.error_message = None
    row.updated_at = datetime.utcnow()


async def _gateway_op_or_mark_relink(
    db: AsyncSession,
    row: WhatsAppSession,
    op: Callable[[str], Awaitable[Dict[str, Any]]],
) -> Dict[str, Any]:
    """Runs a gateway operation without replacing the logical session line id.
    
    If the gateway returns 'session not found' (404 / missing session memory),
    marks row as RELINK_REQUIRED, commits, broadcasts via WebSocket, and raises
    WhatsAppRelinkRequired so UI guides user to scan QR. All other gateway errors
    propagate fail-closed.
    """
    try:
        return await op(row.gateway_id)
    except gw.WhatsAppGatewayError as exc:
        if not is_gateway_session_missing(exc):
            raise
        row.status = SessionStatus.RELINK_REQUIRED
        row.is_phone_online = False
        row.qr_code = None
        row.error_message = "WHATSAPP_AUTH_RELINK_REQUIRED"
        row.updated_at = datetime.utcnow()
        await db.commit()
        logger.warning(
            "[WhatsApp] Durable session is not available in gateway (db_id=%s, gw_id=%s); relink required",
            row.id,
            row.gateway_id,
        )
        try:
            await ws_manager.broadcast(
                {
                    "event": "session_updated",
                    "session": {
                        "id": row.id,
                        "session_id": row.id,
                        "status": SessionStatus.RELINK_REQUIRED.value,
                        "phone_number": row.phone_number,
                        "is_active": row.is_active,
                        "is_phone_online": False,
                        "error_message": "WHATSAPP_AUTH_RELINK_REQUIRED",
                    },
                },
                tenant_id=str(row.user_id),
            )
        except Exception as ws_err:
            logger.debug("[WhatsApp] Relink broadcast ws error: %s", ws_err)
        raise WhatsAppRelinkRequired(
            "WhatsApp bağlantısı geri yüklenemedi. Aynı hattı yeniden eşleştirin."
        ) from exc


# Public alias for inter-orchestrator usage
gateway_op_or_mark_relink = _gateway_op_or_mark_relink


async def _list_sessions_internal(

    db: AsyncSession, user_id: str
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Oturum listesi + (varsa) gateway erisim hatasi."""
    stmt = select(WhatsAppSession).where(get_user_filter(WhatsAppSession.user_id, user_id))
    res = await db.execute(stmt)
    rows = res.scalars().all()
    gw_sync: Dict[str, Any] = {}
    gateway_error: Optional[str] = None
    try:
        gw_sessions = {s["id"]: s for s in await gw.list_sessions()}
        for row in rows:
            live = gw_sessions.get(row.gateway_id)
            if live:
                fields = extract_live_session_fields(live)
                gw_sync[row.id] = fields["sync"]
                if fields["status"] and fields["status"] != row.status.value:
                    row.status = _parse_status(fields["status"])
                    row.is_phone_online = bool(
                        fields["is_phone_online"]
                        if fields["is_phone_online"] is not None
                        else row.is_phone_online
                    )
                    row.battery_level = (
                        fields["battery_level"]
                        if fields["battery_level"] is not None
                        else row.battery_level
                    )
                    row.phone_number = (
                        fields["phone"] if fields["phone"] is not None else row.phone_number
                    )
                live_qr = fields["qr_code"]
                if live_qr:
                    row.qr_code = live_qr
                elif fields["status"] == "CONNECTED":
                    row.qr_code = None
                if fields["status"] in ("CONNECTED", "SCAN_QR"):
                    row.error_message = None
        await db.commit()
    except Exception as exc:
        gateway_error = str(exc)[:300]
        logger.warning("Gateway canli durum tazelenemedi: %s", exc)
    out: List[Dict[str, Any]] = []
    for r in rows:
        d = _session_dict(r)
        d["sync"] = gw_sync.get(r.id, {"phase": "idle", "progress": 0})
        out.append(d)
    return out, gateway_error


async def list_sessions(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """Returns list of sessions for user, refreshed with gateway live status."""
    sessions, _ = await _list_sessions_internal(db, user_id)
    return sessions


async def create_session(db: AsyncSession, user_id: str, name: str) -> Dict[str, Any]:
    """Creates a new WhatsApp session via gateway and persists row in database."""
    gw_session = await gw.create_session(name)
    gateway_id = extract_session_id(gw_session)
    if not gateway_id:
        raise gw.WhatsAppGatewayError("Gateway oturum kimligi dondurmedi.")
    row = WhatsAppSession(
        user_id=user_id,
        gateway_id=gateway_id,
        session_name=gw_session.get("session_name") or name,
        status=_parse_status(gw_session.get("status")),
        phone_number=gw_session.get("phone_number"),
        is_phone_online=bool(gw_session.get("is_phone_online", False)),
        battery_level=gw_session.get("battery_level"),
        qr_code=gw_session.get("qr_code"),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("[WhatsApp] Yeni gateway oturumu: %s (%s)", row.session_name, gateway_id)
    return _session_dict(row)


# ---------------------------------------------------------------------------
# Ephemeral Pairing (No-Create QR Lifecycle)
# ---------------------------------------------------------------------------
_ephemeral_pairings: Dict[str, Dict[str, Any]] = {}
_logical_to_ephemeral: Dict[int, str] = {}


def find_ephemeral_pairing_by_gateway_id(gateway_id: str) -> Optional[Dict[str, Any]]:
    """Lookup ephemeral pairing metadata by its gateway UUID."""
    for token, data in list(_ephemeral_pairings.items()):
        if data.get("gateway_id") == str(gateway_id):
            return data
    return None


def remove_ephemeral_pairing_by_gateway_id(gateway_id: str) -> None:
    """Clean up ephemeral pairing metadata by gateway UUID."""
    for token, data in list(_ephemeral_pairings.items()):
        if data.get("gateway_id") == str(gateway_id):
            log_id = data.get("logical_session_id")
            if log_id and _logical_to_ephemeral.get(log_id) == token:
                _logical_to_ephemeral.pop(log_id, None)
            _ephemeral_pairings.pop(token, None)


async def start_pairing_session(
    user_id: str,
    name: Optional[str] = None,
    logical_session_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Starts an ephemeral pairing session in gateway without persisting any row in public.whatsapp_sessions.
    Guarantees ZERO persistent database rows until the QR code is truly scanned and connected.
    """
    line_name = name or f"Hat {datetime.utcnow().strftime('%H:%M')}"
    gw_session = await gw.create_session(line_name, ephemeral=True)
    gateway_id = extract_session_id(gw_session)
    if not gateway_id:
        raise gw.WhatsAppGatewayError("Gateway oturum kimligi dondurmedi.")
    pair_token = str(uuid.uuid4())
    _ephemeral_pairings[pair_token] = {
        "user_id": str(user_id),
        "gateway_id": gateway_id,
        "session_name": gw_session.get("session_name") or line_name,
        "logical_session_id": logical_session_id,
        "created_at": datetime.utcnow(),
    }
    if logical_session_id:
        _logical_to_ephemeral[logical_session_id] = pair_token
    return {
        "pair_token": pair_token,
        "gateway_id": gateway_id,
        "session_name": gw_session.get("session_name") or line_name,
        "status": "SCAN_QR",
        "qr_code": gw_session.get("qr_code"),
    }


async def get_pairing_qr(db: AsyncSession, user_id: str, pair_token: str) -> Dict[str, Any]:
    """Fetches QR code for an active ephemeral pairing session.

    When the user scans the QR and a CONNECTED status is returned from gateway:

    Scenario A (RELINK): An existing RELINK_REQUIRED session with the same
        user_id + phone_number (or specified logical_session_id) is found. Its gateway_id
        is atomically updated and unverified history_sync_states are migrated.
        Logical session identity (public.whatsapp_sessions.id) is preserved. No new row is created.

    Scenario A-new (FIRST QR): No RELINK_REQUIRED candidate exists for this
        phone (first-time pairing). A new WhatsAppSession row is created.

    In both cases returns the stable logical session id.
    """
    pairing = _ephemeral_pairings.get(pair_token)
    if not pairing or pairing["user_id"] != str(user_id):
        raise LookupError("Eşleşme oturumu bulunamadı veya süresi doldu.")

    gateway_id = pairing["gateway_id"]
    try:
        data = await gw.get_session_qr(gateway_id)
    except gw.WhatsAppGatewayError as exc:
        if exc.status_code == 404:
            log_id = pairing.get("logical_session_id")
            if log_id and _logical_to_ephemeral.get(log_id) == pair_token:
                _logical_to_ephemeral.pop(log_id, None)
            _ephemeral_pairings.pop(pair_token, None)
            raise LookupError("Gateway oturumu bulunamadı.") from exc
        raise

    status_val = data.get("status")
    if status_val == "CONNECTED":
        phone = (data.get("phone") or data.get("phone_number") or "").strip()
        log_id = pairing.get("logical_session_id")
        if log_id and _logical_to_ephemeral.get(log_id) == pair_token:
            _logical_to_ephemeral.pop(log_id, None)
        _ephemeral_pairings.pop(pair_token, None)

        # --- Scenario A: try to bind to existing RELINK_REQUIRED logical session ---
        try:
            result = await perform_atomic_relink(
                db,
                user_id=str(user_id),
                phone=phone,
                new_gateway_id=str(gateway_id),
                session_name=pairing["session_name"],
            )
            logger.info(
                "[WhatsApp] Relink Scenario A: session=%s gateway %s→%s (%d history rows migrated)",
                result.session_id,
                result.old_gateway_id,
                result.new_gateway_id,
                result.history_rows_migrated,
            )
            return {
                "status": "CONNECTED",
                "session_id": result.session_id,
                "phone": result.phone_number,
                "qr_code": None,
                "error_message": None,
            }
        except RelinkCandidateAmbiguous as exc:
            # Fail closed — multiple matching sessions, cannot safely bind.
            logger.error("[WhatsApp] Relink failed — ambiguous candidate: %s", exc)
            raise ValueError(str(exc)) from exc
        except RelinkCandidateNotFound:
            if log_id:
                # If pairing was targeted at a specific logical session, fail closed
                logger.error(
                    "[WhatsApp] Targeted relink failed for logical_session_id=%s, phone=%s",
                    log_id,
                    phone,
                )
                raise ValueError("Eşleşme tamamlandı ancak hedef oturum doğrulanamadı.")

        # --- Scenario A-new: create new logical session (first QR for this phone) ---
        row = WhatsAppSession(
            user_id=user_id,
            gateway_id=gateway_id,
            session_name=pairing["session_name"],
            status=SessionStatus.CONNECTED,
            phone_number=phone or None,
            is_active=True,
            is_phone_online=True,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        logger.info(
            "[WhatsApp] First-time QR pairing — new session created: id=%s (%s)",
            row.id,
            gateway_id,
        )
        return {
            "status": "CONNECTED",
            "session_id": row.id,
            "phone": row.phone_number,
            "qr_code": None,
            "error_message": None,
        }

    return {
        "status": status_val or "SCAN_QR",
        "qr_code": data.get("qr_code"),
        "phone": data.get("phone"),
        "error_message": data.get("error_message"),
    }


async def cancel_pairing_session(user_id: str, pair_token: str) -> Dict[str, Any]:
    """Cancels an ephemeral pairing attempt, terminating gateway socket and freeing memory.
    Guarantees that ZERO rows were ever created in public.whatsapp_sessions and
    ZERO history states are mutated.
    """
    pairing = _ephemeral_pairings.pop(pair_token, None)
    if pairing:
        log_id = pairing.get("logical_session_id")
        if log_id and _logical_to_ephemeral.get(log_id) == pair_token:
            _logical_to_ephemeral.pop(log_id, None)
        if pairing["user_id"] == str(user_id):
            try:
                await gw.delete_session(pairing["gateway_id"])
            except Exception as exc:
                logger.warning("[WhatsApp] Ephemeral gateway oturumu silinirken hata: %s", exc)
    return {"success": True}


async def refresh_contact_avatar(db: AsyncSession, user_id: str, phone: str) -> Dict[str, Any]:
    """Refreshes contact avatar URL directly from WhatsApp via connected gateway session."""
    stmt = (
        select(WhatsAppSession)
        .where(
            get_user_filter(WhatsAppSession.user_id, user_id),
            WhatsAppSession.status == SessionStatus.CONNECTED,
            WhatsAppSession.is_active.is_(True),
        )
        .order_by(WhatsAppSession.id.desc())
    )
    sess = await db.scalar(stmt)
    if not sess:
        return {"success": False, "phone": phone, "error": "Aktif WhatsApp oturumu bulunamadı"}

    gateway_id = sess.gateway_id
    from backend.app.services.whatsapp.repositories.contacts import set_contact_avatar
    from backend.app.services.whatsapp.identity import strip_jid_prefix

    clean_phone = strip_jid_prefix(phone)
    jid = clean_phone if ("@" in clean_phone) else f"{clean_phone.lstrip('+')}@s.whatsapp.net"
    try:
        res = await gw.refresh_avatar(gateway_id, jid)
        new_url = res.get("avatar_url") if isinstance(res, dict) else None

        # Update contact in DB if exists
        contact = await db.scalar(
            select(Contact).where(
                get_user_filter(Contact.user_id, user_id),
                or_(
                    Contact.phone_e164 == phone,
                    Contact.phone_e164 == clean_phone,
                    Contact.phone_e164 == f"jid:{clean_phone}",
                ),
            )
        )
        if contact and new_url:
            set_contact_avatar(contact, new_url)
            await db.commit()

        return {"success": True, "phone": phone, "avatar_url": new_url}
    except Exception as exc:
        logger.warning("[WhatsApp] Avatar yenileme hatası (%s): %s", phone, exc)
        return {"success": False, "phone": phone, "error": str(exc)}


async def get_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    """Fetches QR code for session from gateway.

    If the logical session is in RELINK_REQUIRED state and its gateway session is
    missing/unavailable:
    - Does NOT terminate flow with WhatsAppRelinkRequired / 409.
    - Creates or reuses an ephemeral pairing session in the gateway.
    - Returns status='SCAN_QR' with the active ephemeral QR code.
    - When CONNECTED, perform_atomic_relink preserves logical session ID and migrates history states.
    """
    row = await _get_session_or_404(db, user_id, session_id)
    if row.status == SessionStatus.RELINK_REQUIRED:
        gw_missing = False
        data = None
        try:
            data = await gw.get_session_qr(row.gateway_id)
        except gw.WhatsAppGatewayError as exc:
            if is_gateway_session_missing(exc):
                gw_missing = True
            else:
                raise

        if gw_missing:
            pair_token = _logical_to_ephemeral.get(row.id)
            pairing = _ephemeral_pairings.get(pair_token) if pair_token else None
            eph_data = None
            if pairing:
                try:
                    eph_data = await gw.get_session_qr(pairing["gateway_id"])
                except gw.WhatsAppGatewayError as eph_exc:
                    if is_gateway_session_missing(eph_exc):
                        pairing = None
                    else:
                        raise

            if not pairing or not eph_data:
                line_name = row.session_name or f"Hat {datetime.utcnow().strftime('%H:%M')}"
                gw_session = await gw.create_session(line_name, ephemeral=True)
                ephemeral_gid = extract_session_id(gw_session)
                if not ephemeral_gid:
                    raise gw.WhatsAppGatewayError("Gateway oturum kimligi dondurmedi.")
                pair_token = str(uuid.uuid4())
                _ephemeral_pairings[pair_token] = {
                    "user_id": str(user_id),
                    "gateway_id": ephemeral_gid,
                    "session_name": line_name,
                    "logical_session_id": row.id,
                    "phone": row.phone_number,
                    "created_at": datetime.utcnow(),
                }
                _logical_to_ephemeral[row.id] = pair_token
                return {
                    "status": "SCAN_QR",
                    "qr_code": gw_session.get("qr_code"),
                    "phone": row.phone_number,
                    "error_message": None,
                }

            ephemeral_gid = pairing["gateway_id"]
            if eph_data.get("status") == "CONNECTED":
                phone = (
                    eph_data.get("phone")
                    or eph_data.get("phone_number")
                    or row.phone_number
                    or ""
                ).strip()
                _ephemeral_pairings.pop(pair_token, None)
                _logical_to_ephemeral.pop(row.id, None)
                relink_result = await perform_atomic_relink(
                    db,
                    user_id=str(user_id),
                    phone=phone,
                    new_gateway_id=ephemeral_gid,
                    session_name=row.session_name,
                )
                return {
                    "status": "CONNECTED",
                    "session_id": relink_result.session_id,
                    "phone": relink_result.phone_number,
                    "qr_code": None,
                    "error_message": None,
                }
            return {
                "status": eph_data.get("status") or "SCAN_QR",
                "qr_code": eph_data.get("qr_code"),
                "phone": row.phone_number,
                "error_message": eph_data.get("error_message"),
            }

        # If gateway session actually exists on gateway
        _apply_gateway_live(row, data)
        await db.commit()
        return {
            "status": row.status.value if hasattr(row.status, "value") else str(row.status),
            "qr_code": data.get("qr_code") or row.qr_code,
            "phone": data.get("phone") or row.phone_number,
            "error_message": data.get("error_message") or row.error_message,
        }

    data = await _gateway_op_or_mark_relink(db, row, gw.get_session_qr)
    _apply_gateway_live(row, data)
    await db.commit()
    return {
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "qr_code": data.get("qr_code") or row.qr_code,
        "phone": data.get("phone") or row.phone_number,
        "error_message": data.get("error_message") or row.error_message,
    }


async def refresh_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    """Refreshes QR code for session via gateway."""
    row = await _get_session_or_404(db, user_id, session_id)
    if row.status == SessionStatus.RELINK_REQUIRED:
        pair_token = _logical_to_ephemeral.get(row.id)
        pairing = _ephemeral_pairings.get(pair_token) if pair_token else None
        if pairing:
            try:
                ref_data = await gw.refresh_session_qr(pairing["gateway_id"])
                return {
                    "status": ref_data.get("status") or "SCAN_QR",
                    "qr_code": ref_data.get("qr_code"),
                    "error_message": ref_data.get("error_message"),
                }
            except Exception as exc:
                logger.warning("[WhatsApp] Ephemeral refresh failed: %s", exc)
        return await get_session_qr(db, user_id, session_id)

    data = await _gateway_op_or_mark_relink(db, row, gw.refresh_session_qr)
    _apply_gateway_live(row, data)
    await db.commit()
    return {
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "qr_code": data.get("qr_code") or row.qr_code,
        "error_message": data.get("error_message") or row.error_message,
    }


async def request_pairing_code(
    db: AsyncSession, user_id: str, session_id: int, phone: str
) -> Dict[str, Any]:
    """'Telefon numarası ile bağlan' — gateway'den 8 haneli pairing kodu ister."""
    row = await _get_session_or_404(db, user_id, session_id)
    data = await _gateway_op_or_mark_relink(
        db, row, lambda gid: gw.request_pairing_code(gid, phone)
    )
    pairing_code = extract_pairing_code(data)
    if not pairing_code:
        raise gw.WhatsAppGatewayError("Gateway pairing kodu döndürmedi.")
    if data.get("phone"):
        row.phone_number = data["phone"]
        await db.commit()
    return {
        "success": True,
        "pairing_code": str(pairing_code),
        "phone": data.get("phone") or row.phone_number,
    }


async def logout_session(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    """Disconnects session in gateway and marks DISCONNECTED in DB."""
    row = await _get_session_or_404(db, user_id, session_id)
    try:
        await gw.logout_session(row.gateway_id)
    except gw.WhatsAppGatewayError as exc:
        if not is_gateway_session_missing(exc):
            raise
        logger.warning(
            "[WhatsApp] Gateway oturumu zaten yok (DB id=%s gateway_id=%s): %s",
            row.id,
            row.gateway_id,
            exc,
        )
    row.status = SessionStatus.DISCONNECTED
    row.is_active = False
    row.is_phone_online = False
    row.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "status": "DISCONNECTED"}


async def purge_whatsapp_data(
    db: AsyncSession, user_id: str, session_id: Optional[int] = None
) -> Dict[str, int]:
    """Purges WhatsApp messages, conversations, and orphaned contacts for session."""
    purged = {"messages": 0, "conversations": 0, "contacts": 0}

    other_sessions = await db.execute(
        select(func.count())
        .select_from(WhatsAppSession)
        .where(
            get_user_filter(WhatsAppSession.user_id, user_id),
            WhatsAppSession.id != session_id if session_id is not None else True,
        )
    )
    has_other_session = (other_sessions.scalar_one() or 0) > 0

    conv_ids: List[int] = []
    for owner in (str(user_id), SYSTEM_USER_ID):
        stmt = select(Conversation.id).where(
            get_user_filter(Conversation.user_id, owner),
            Conversation.channel == "WHATSAPP",
        )
        if session_id is not None:
            if has_other_session:
                stmt = stmt.where(Conversation.session_id == session_id)
            else:
                stmt = stmt.where(
                    or_(
                        Conversation.session_id == session_id,
                        Conversation.session_id.is_(None),
                    )
                )
        res = await db.execute(stmt)
        conv_ids.extend(int(r[0]) for r in res.all())

    if not conv_ids:
        return purged

    msg_res = await db.execute(delete(Message).where(Message.conversation_id.in_(conv_ids)))
    purged["messages"] = msg_res.rowcount or 0

    con_res = await db.execute(
        select(Conversation.contact_id).where(Conversation.id.in_(conv_ids))
    )
    contact_ids = [int(r[0]) for r in con_res.all() if r[0] is not None]

    conv_res = await db.execute(delete(Conversation).where(Conversation.id.in_(conv_ids)))
    purged["conversations"] = conv_res.rowcount or 0

    if contact_ids:
        remaining = select(Conversation.contact_id).where(Conversation.contact_id.isnot(None))
        ct_res = await db.execute(
            delete(Contact).where(
                Contact.id.in_(contact_ids),
                Contact.id.notin_(remaining),
            )
        )
        purged["contacts"] = ct_res.rowcount or 0

    return purged


async def delete_session(
    db: AsyncSession,
    user_id: str,
    session_id: int,
    on_cancel_sync: Optional[Callable[[str], Any]] = None,
) -> Dict[str, Any]:
    """Deletes session in gateway, purges its local conversation data, and deletes DB row."""
    row = await _get_session_or_404(db, user_id, session_id)
    if on_cancel_sync:
        on_cancel_sync(user_id)
    gateway_ok = True
    gateway_error: Optional[str] = None
    try:
        await gw.delete_session(row.gateway_id)
    except Exception as exc:
        gateway_ok = False
        gateway_error = str(exc)[:300]
        logger.warning(
            "Gateway oturum silinemedi; yerel veri temizlenecek (user=%s session=%s gateway=%s): %s",
            user_id,
            session_id,
            row.gateway_id,
            exc,
        )
    purged = await purge_whatsapp_data(db, user_id, session_id=row.id)
    await db.delete(row)
    await db.commit()
    logger.info(
        "WhatsApp oturumu silindi (user=%s session=%s): %s eşitleme temizlendi",
        user_id,
        session_id,
        purged,
    )
    result: Dict[str, Any] = {"success": gateway_ok, "purged": purged}
    if gateway_error:
        result["error"] = gateway_error
    return result


class WhatsAppSessionOrchestrator:
    """Orchestrator class for WhatsApp session operations."""

    def __init__(self, service: Optional[Any] = None) -> None:
        self.service = service

    def session_dict(self, row: WhatsAppSession) -> Dict[str, Any]:
        return _session_dict(row)

    async def list_sessions(self, db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
        return await list_sessions(db, user_id)

    async def create_session(
        self, db: AsyncSession, user_id: str, session_name: str = "default", phone_number: Optional[str] = None
    ) -> Dict[str, Any]:
        return await create_session(db, user_id, session_name, phone_number)

    async def get_session_qr(self, db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
        return await get_session_qr(db, user_id, session_id)

    async def refresh_session_qr(self, db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
        return await refresh_session_qr(db, user_id, session_id)

    async def request_pairing_code(
        self, db: AsyncSession, user_id: str, session_id: int, phone_number: str
    ) -> Dict[str, Any]:
        return await request_pairing_code(db, user_id, session_id, phone_number)

    async def logout_session(self, db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
        return await logout_session(db, user_id, session_id)

    async def purge_whatsapp_data(
        self, db: AsyncSession, user_id: str, session_id: Optional[int] = None
    ) -> Dict[str, int]:
        return await purge_whatsapp_data(db, user_id, session_id)

    async def delete_session(
        self, db: AsyncSession, user_id: str, session_id: int, on_cancel_sync: Optional[Callable[[str], Any]] = None
    ) -> Dict[str, Any]:
        return await delete_session(db, user_id, session_id, on_cancel_sync)

