"""WhatsApp gateway - veri katmani orkestrasyonu.

WhatsApp UI, gateway (transport) + FastAPI DB (tek dogruluk kaynagi)
arasinda koprulenir: ic mesajlar contacts/conversations/messages
tablolarina kalici yazilir; frontend her zaman sayisal DB kimlikleriyle
konusur. Gateway olaylari (/ws/gateway) bu servis araciligiyla persist
edilir ve broadcast icin sayisal kimliklere cevrilir.
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.auth import get_user_filter
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_gateway as gw

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Yardimcilar
# ---------------------------------------------------------------------------

def jid_to_phone(jid: str) -> Optional[str]:
    """`905321002030@s.whatsapp.net` -> `+905321002030`."""
    if not jid:
        return None
    digits = "".join(ch for ch in jid.split("@")[0] if ch.isdigit())
    return f"+{digits}" if digits else None


def phone_to_jid(phone_e164: str) -> str:
    """`+905321002030` -> `905321002030@s.whatsapp.net`."""
    digits = "".join(ch for ch in phone_e164 if ch.isdigit())
    return f"{digits}@s.whatsapp.net"


def _serialize_message(row: Message) -> Dict[str, Any]:
    return {
        "id": row.id,
        "conversation_id": row.conversation_id,
        "direction": row.direction.value if hasattr(row.direction, "value") else str(row.direction),
        "message_type": row.message_type.value if hasattr(row.message_type, "value") else str(row.message_type),
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "body": row.body,
        "media_id": row.media_id,
        "media_mime_type": row.media_mime_type,
        "media_filename": row.media_filename,
        "media_caption": row.media_caption,
        "media_url": None,
        "wa_message_id": row.wa_message_id,
        "client_message_id": row.client_message_id,
        "sender_phone": row.sender_phone,
        "sender_name": row.sender_name,
        "recipient_phone": row.recipient_phone,
        "error_message": row.error_message,
        "created_at": row.external_timestamp.isoformat()
        if row.external_timestamp
        else (row.created_at.isoformat() if row.created_at else None),
    }


def _session_dict(row: WhatsAppSession) -> Dict[str, Any]:
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


def _parse_status(value: Optional[str]) -> SessionStatus:
    try:
        return SessionStatus(value or "SCAN_QR")
    except Exception:
        return SessionStatus.SCAN_QR


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def _apply_gateway_live(row: WhatsAppSession, data: Dict[str, Any]) -> None:
    status = data.get("status")
    if status:
        row.status = _parse_status(status)
    if data.get("phone"):
        row.phone_number = data["phone"]
    gw_error = data.get("error_message")
    if gw_error is not None:
        row.error_message = str(gw_error)[:1000] or None
    if status in ("CONNECTED", "SCAN_QR"):
        row.error_message = None
    row.updated_at = datetime.utcnow()
# ---------------------------------------------------------------------------
# Session yonetimi
# ---------------------------------------------------------------------------

async def list_sessions(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    stmt = select(WhatsAppSession).where(get_user_filter(WhatsAppSession.user_id, user_id))
    res = await db.execute(stmt)
    rows = res.scalars().all()
    try:
        gw_sessions = {s["id"]: s for s in await gw.list_sessions()}
        for row in rows:
            live = gw_sessions.get(row.gateway_id)
            if live and live.get("status") != row.status.value:
                row.status = _parse_status(live.get("status"))
                row.is_phone_online = bool(live.get("is_phone_online", row.is_phone_online))
                row.battery_level = live.get("battery_level", row.battery_level)
                row.phone_number = live.get("phone_number", row.phone_number)
        await db.commit()
    except Exception as exc:
        logger.warning("Gateway canli durum tazelenemedi: %s", exc)
    return [_session_dict(r) for r in rows]


async def create_session(db: AsyncSession, user_id: str, name: str) -> Dict[str, Any]:
    gw_session = await gw.create_session(name)
    gateway_id = gw_session.get("id")
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


async def _get_session_or_404(db: AsyncSession, user_id: str, session_id: int) -> WhatsAppSession:
    stmt = select(WhatsAppSession).where(
        WhatsAppSession.id == session_id,
        get_user_filter(WhatsAppSession.user_id, user_id),
    )
    res = await db.execute(stmt)
    row = res.scalar_one_or_none()
    if not row:
        raise LookupError("WhatsApp oturumu bulunamadi.")
    return row


async def get_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    row = await _get_session_or_404(db, user_id, session_id)
    data = await gw.get_session_qr(row.gateway_id)
    _apply_gateway_live(row, data)
    await db.commit()
    return {
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "qr_code": data.get("qr_code") or row.qr_code,
        "phone": data.get("phone") or row.phone_number,
        "error_message": data.get("error_message") or row.error_message,
    }


async def refresh_session_qr(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    row = await _get_session_or_404(db, user_id, session_id)
    data = await gw.refresh_session_qr(row.gateway_id)
    _apply_gateway_live(row, data)
    await db.commit()
    return {
        "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        "qr_code": data.get("qr_code") or row.qr_code,
        "error_message": data.get("error_message") or row.error_message,
    }


async def logout_session(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    row = await _get_session_or_404(db, user_id, session_id)
    await gw.logout_session(row.gateway_id)
    row.status = SessionStatus.DISCONNECTED
    row.is_active = False
    row.is_phone_online = False
    row.updated_at = datetime.utcnow()
    await db.commit()
    return {"success": True, "status": "DISCONNECTED"}


async def delete_session(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    row = await _get_session_or_404(db, user_id, session_id)
    try:
        await gw.delete_session(row.gateway_id)
    except Exception as exc:
        logger.warning("Gateway oturum silinemedi (devam): %s", exc)
    await db.delete(row)
    await db.commit()
# ---------------------------------------------------------------------------
# Kisiler (contacts)
# ---------------------------------------------------------------------------

async def sync_contacts(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    gw_contacts = await gw.list_contacts()
    for item in gw_contacts:
        jid = item.get("id")
        if not jid:
            continue
        name = item.get("name") or item.get("notify") or None
        contact = await _upsert_contact(db, user_id, jid, name)
        out.append({"id": jid, "phone": contact.phone_e164, "name": contact.display_name, "avatar_url": None})
    await db.commit()
    return out


async def _upsert_contact(db: AsyncSession, user_id: str, jid: str, display_name: Optional[str]) -> Contact:
    phone_e164 = jid_to_phone(jid)
    if not phone_e164:
        phone_e164 = f"jid:{jid}"
    stmt = select(Contact).where(
        Contact.phone_e164 == phone_e164,
        get_user_filter(Contact.user_id, user_id),
    )
    res = await db.execute(stmt)
    contact = res.scalar_one_or_none()
    if not contact:
        contact = Contact(
            user_id=user_id,
            phone_e164=phone_e164,
            display_name=display_name or jid_to_phone(jid) or jid,
        )
        db.add(contact)
        await db.flush()
    elif display_name and not contact.display_name:
        contact.display_name = display_name
        await db.flush()
    return contact


# ---------------------------------------------------------------------------
# Sohbetler (conversations)
# ---------------------------------------------------------------------------

async def _ensure_conversation(
    db: AsyncSession, user_id: str, jid: str, preview: Optional[str] = None
) -> Conversation:
    contact = await _upsert_contact(db, user_id, jid, None)
    stmt = select(Conversation).where(
        Conversation.contact_id == contact.id,
        Conversation.channel == "WHATSAPP",
        get_user_filter(Conversation.user_id, user_id),
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()
    if not conv:
        conv = Conversation(
            user_id=user_id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            last_message_preview=preview,
            last_message_at=datetime.utcnow(),
        )
        db.add(conv)
        await db.flush()
    return conv


async def sync_conversations(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    data = await gw.list_conversations(limit=200)
    items = data.get("items", []) if isinstance(data, dict) else []
    for item in items:
        jid = item.get("jid") or item.get("id")
        if not jid or "@" not in str(jid):
            continue
        jid_str = str(jid)
        preview = item.get("last_message_preview") or ""
        conv = await _ensure_conversation(db, user_id, jid_str, preview)
        last_at = item.get("last_message_at")
        if last_at:
            parsed = _parse_dt(str(last_at))
            if parsed:
                conv.last_message_at = parsed
        if preview:
            conv.last_message_preview = preview[:500]
        unread = int(item.get("unread_count") or 0)
        conv.unread_count = max(conv.unread_count or 0, unread)
        await db.flush()
    await db.commit()
    result, _total = await list_conversations(db, user_id)
    return result


async def list_conversations(
    db: AsyncSession,
    user_id: str,
    search: Optional[str] = None,
    status: Optional[str] = None,
    unread_only: bool = False,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    conv_filter = get_user_filter(Conversation.user_id, user_id)
    base = select(Conversation).where(conv_filter, Conversation.channel == "WHATSAPP")
    if status:
        try:
            base = base.where(Conversation.status == ConversationStatus(status))
        except Exception:
            pass
    if unread_only:
        base = base.where(Conversation.unread_count > 0)
    if search:
        like = f"%{search.strip().lower()}%"
        base = base.join(Contact, Conversation.contact_id == Contact.id).where(
            or_(
                func.lower(Contact.display_name).like(like),
                func.lower(Contact.phone_e164).like(like),
            )
        )

    count_res = await db.execute(select(func.count()).select_from(base.subquery()))
    total = count_res.scalar_one()

    base = base.order_by(Conversation.last_message_at.desc().nullslast()).order_by(Conversation.id.desc())
    if offset:
        base = base.offset(offset)
    if limit:
        base = base.limit(limit)

    res = await db.execute(base)
    rows = res.scalars().all()

    contact_ids = [r.contact_id for r in rows if r.contact_id]
    contacts_map: Dict[int, Contact] = {}
    if contact_ids:
        cres = await db.execute(select(Contact).where(Contact.id.in_(contact_ids)))
        contacts_map = {c.id: c for c in cres.scalars().all()}

    out: List[Dict[str, Any]] = []
    for r in rows:
        contact = contacts_map.get(r.contact_id)
        out.append(
            {
                "id": r.id,
                "contact_id": r.contact_id,
                "lead_id": r.lead_id,
                "name": contact.display_name if contact else None,
                "phone": contact.phone_e164 if contact else None,
                "last_message_preview": r.last_message_preview,
                "last_message_at": r.last_message_at.isoformat() if r.last_message_at else None,
                "unread_count": r.unread_count,
                "status": r.status.value if hasattr(r.status, "value") else str(r.status),
            }
        )
    return out, total
# ---------------------------------------------------------------------------
# Mesajlar & gonderme
# ---------------------------------------------------------------------------

async def _get_conversation_or_404(db: AsyncSession, user_id: str, conversation_id: int) -> Conversation:
    stmt = select(Conversation).where(
        Conversation.id == conversation_id,
        get_user_filter(Conversation.user_id, user_id),
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()
    if not conv:
        raise LookupError("Konusma bulunamadi.")
    return conv


async def _resolve_jid(db: AsyncSession, user_id: str, conversation_id: int) -> Tuple[Conversation, str]:
    conv = await _get_conversation_or_404(db, user_id, conversation_id)
    if not conv.contact_id:
        raise LookupError("Konusma bir kisiyle iliskili degil.")
    cres = await db.execute(select(Contact).where(Contact.id == conv.contact_id))
    contact = cres.scalar_one()
    phone = contact.phone_e164
    jid = phone[4:] if phone.startswith("jid:") else phone_to_jid(phone)
    return conv, jid


async def get_messages(
    db: AsyncSession, user_id: str, conversation_id: int, limit: int = 50, before: Optional[int] = None
) -> Dict[str, Any]:
    conv = await _get_conversation_or_404(db, user_id, conversation_id)
    base = select(Message).where(
        Message.conversation_id == conv.id,
        get_user_filter(Message.user_id, user_id),
    )
    if before:
        base = base.where(Message.id < before)
    base = base.order_by(Message.id.desc()).limit(min(limit, 100))
    res = await db.execute(base)
    rows = list(res.scalars().all())
    rows.reverse()
    has_more = len(rows) == min(limit, 100)
    messages = [_serialize_message(r) for r in rows]
    return {
        "messages": messages,
        "has_more": has_more,
        "oldest_message_id": messages[0]["id"] if messages else None,
        "newest_message_id": messages[-1]["id"] if messages else None,
    }


async def send_text_message(
    db: AsyncSession, user_id: str, conversation_id: int, body: str, client_message_id: Optional[str] = None
) -> Dict[str, Any]:
    conv, jid = await _resolve_jid(db, user_id, conversation_id)
    clean = body.strip()
    if not clean:
        raise LookupError("Mesaj bos olamaz.")
    gateway_result = await gw.send_text_message(jid, clean, client_message_id)
    wa_id = gateway_result.get("wa_message_id")
    row = Message(
        user_id=user_id,
        conversation_id=conv.id,
        direction=MessageDirection.OUTBOUND,
        message_type=MessageType.TEXT,
        body=clean,
        wa_message_id=wa_id,
        client_message_id=client_message_id,
        sender_phone="ME",
        recipient_phone=jid_to_phone(jid) or jid,
        status=ConversationMessageStatus.SENT,
        sent_at=datetime.utcnow(),
    )
    db.add(row)
    conv.last_message_at = datetime.utcnow()
    conv.last_message_preview = clean[:500]
    await db.commit()
    await db.refresh(row)
    return _serialize_message(row)


async def send_media_message(
    db: AsyncSession, user_id: str, conversation_id: int, media: Dict[str, Any]
) -> Dict[str, Any]:
    conv, jid = await _resolve_jid(db, user_id, conversation_id)
    gateway_result = await gw.send_media_message(jid, media)
    wa_id = gateway_result.get("wa_message_id")
    mtype_str = (media.get("media_type") or "document").upper()
    try:
        msg_type = MessageType[mtype_str] if mtype_str in MessageType.__members__ else MessageType.DOCUMENT
    except Exception:
        msg_type = MessageType.DOCUMENT
    caption = media.get("caption")
    filename = media.get("filename")
    row = Message(
        user_id=user_id,
        conversation_id=conv.id,
        direction=MessageDirection.OUTBOUND,
        message_type=msg_type,
        body=(caption or filename or media.get("media_url") or "")[:4000],
        media_id=None,
        media_filename=filename,
        media_caption=caption,
        wa_message_id=wa_id,
        client_message_id=media.get("client_message_id"),
        sender_phone="ME",
        recipient_phone=jid_to_phone(jid) or jid,
        status=ConversationMessageStatus.SENT,
        sent_at=datetime.utcnow(),
    )
    db.add(row)
    conv.last_message_at = datetime.utcnow()
    conv.last_message_preview = (caption or filename or "[Medya]")[:500]
    await db.commit()
    await db.refresh(row)
    return _serialize_message(row)


async def mark_conversation_read(db: AsyncSession, user_id: str, conversation_id: int) -> Dict[str, Any]:
    conv, jid = await _resolve_jid(db, user_id, conversation_id)
    try:
        await gw.mark_conversation_read(jid)
    except Exception as exc:
        logger.warning("Gateway okundu isareti iletilemedi: %s", exc)
    conv.unread_count = 0
    conv.last_read_at = datetime.utcnow()
    await db.commit()
    return {"success": True}
# ---------------------------------------------------------------------------
# Gateway olaylarini veritabanina isleme (inbound)
# ---------------------------------------------------------------------------

async def ingest_gateway_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """Gateway olayini persist eder ve UI broadcast'i icin kimlikleri cevirir.

    - `message_new`: inbound/outbound mesaji contact/conversation/messages'a
      yazar; `conversation_id` jid'den backend sayisal id'sine cevrilir.
    - `session_*`: `session_id` (gateway UUID) backend oturum id'sine cevrilir.
    - `conversation_*`: conversation kimligi sayisallastirilir.
    """
    async with AsyncSessionLocal() as db:
        evt = event.get("event") or event.get("event_type") or ""
        try:
            if evt == "message_new":
                result = await _ingest_message(db, event)
            elif evt in ("conversation_updated", "conversation_read", "message_status_updated"):
                result = await _map_conversation_event(db, event)
            elif evt == "connection_error" or str(evt).startswith("session_"):
                result = await _map_session_event(db, event)
            else:
                result = event
            await db.commit()
            return result
        except Exception as exc:
            await db.rollback()
            logger.warning("Gateway olayi islenemedi (%s): %s", evt, exc)
            return event


async def _ingest_message(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    msg = event.get("message") or {}
    jid = msg.get("conversation_id") or event.get("conversation_id")
    if not jid or "@" not in str(jid):
        return event
    jid_str = str(jid)
    # MVP: gateway tenant'i bilmiyor; kayitli oturumun sahibine, yoksa system'e baglan.
    owner = await _resolve_event_owner(db, jid_str)
    conv = await _ensure_conversation(db, owner, jid_str)
    contact = await _upsert_contact(db, owner, jid_str, msg.get("sender_name"))

    wa_id = msg.get("wa_message_id")
    if wa_id:
        existing = await db.execute(
            select(Message).where(Message.wa_message_id == wa_id, Message.conversation_id == conv.id)
        )
        if existing.scalar_one_or_none() is not None:
            event["conversation_id"] = conv.id
            return event  # dedup

    mtype_str = (msg.get("message_type") or "TEXT").upper()
    try:
        mtype = MessageType[mtype_str] if mtype_str in MessageType.__members__ else MessageType.TEXT
    except Exception:
        mtype = MessageType.TEXT
    direction = MessageDirection.INBOUND if msg.get("direction", "INBOUND") == "INBOUND" else MessageDirection.OUTBOUND

    body = msg.get("body") or ""
    row = Message(
        user_id=owner,
        conversation_id=conv.id,
        direction=direction,
        message_type=mtype,
        body=body[:4000] if body else None,
        media_id=msg.get("media_id"),
        media_mime_type=msg.get("media_mime_type"),
        media_filename=msg.get("media_filename"),
        media_caption=msg.get("media_caption"),
        wa_message_id=wa_id,
        client_message_id=msg.get("client_message_id"),
        sender_phone=msg.get("sender_phone") or jid_to_phone(jid_str) or "unknown",
        sender_name=contact.display_name,
        recipient_phone=msg.get("recipient_phone") or "ME" if direction == MessageDirection.INBOUND else contact.phone_e164,
        status=ConversationMessageStatus.RECEIVED if direction == MessageDirection.INBOUND else ConversationMessageStatus.SENT,
        external_timestamp=_parse_dt(msg.get("created_at")),
    )
    db.add(row)
    conv.last_message_at = datetime.utcnow()
    conv.last_message_preview = (body or f"[{mtype_str}]")[:500]
    if direction == MessageDirection.INBOUND:
        conv.unread_count = (conv.unread_count or 0) + 1
    await db.flush()
    await db.refresh(row)

    event["conversation_id"] = conv.id
    event["message"] = _serialize_message(row)
    return event


# Sentinel user_id for events that arrive before any session is connected.
# Must be a valid UUID string since user_id columns are Uuid(as_uuid=False).
SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"


async def _resolve_event_owner(db: AsyncSession, jid: str) -> str:
    """Gateway olayinin kime ait oldugunu (oturum sahibi) cozmeye calisir."""
    stmt = select(WhatsAppSession).where(WhatsAppSession.status == SessionStatus.CONNECTED)
    try:
        res = await db.execute(stmt)
        row = res.scalar_one_or_none()
        if row and row.user_id:
            return str(row.user_id)
    except Exception:
        pass
    return SYSTEM_USER_ID


async def _map_conversation_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    jid = event.get("conversation_id")
    if not jid or "@" not in str(jid):
        return event
    owner = await _resolve_event_owner(db, str(jid))
    conv = await _ensure_conversation(db, owner, str(jid))
    event["conversation_id"] = conv.id
    if event.get("event") == "conversation_read":
        conv.unread_count = 0
        await db.commit()
    return event


async def _map_session_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    gw_session_id = event.get("session_id")
    if not gw_session_id:
        return event
    evt = event.get("event") or event.get("event_type") or ""
    res = await db.execute(select(WhatsAppSession).where(WhatsAppSession.gateway_id == str(gw_session_id)))
    row = res.scalar_one_or_none()
    if row:
        event["session_id"] = row.id
        event["session_name"] = event.get("session_name") or row.session_name
        event["user_id"] = str(row.user_id) if row.user_id else None
        # Kalici hata yuzeyi: gateway'in gercek baglanti hatasini DB'ye yaz.
        err = event.get("error") or event.get("error_message")
        if evt == "connection_error" and err:
            row.error_message = str(err)[:1000]
            row.status = SessionStatus.DISCONNECTED
            row.is_phone_online = False
            row.updated_at = datetime.utcnow()
        elif evt in ("session_connected", "session_qr_updated"):
            row.error_message = None
    return event