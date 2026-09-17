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

from sqlalchemy import delete, func, or_, select
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


async def get_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    """Fetches QR code for session from gateway."""
    row = await _get_session_or_404(db, user_id, session_id)
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

