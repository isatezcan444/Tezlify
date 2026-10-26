"""WhatsApp Messaging Orchestration Service (Phase 11.9).

Handles outbound text and media dispatch, conversation read receipts,
typing presence, media proxying, and message serialization.
Preserves strict transaction boundaries:
- Immediate commit of PENDING outbound message
- Gateway dispatch with relink fallback
- Automatic transition to FAILED on gateway exception
- Advance status to SENT/DELIVERED and update conversation last message summary
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import logging
import re
from typing import Any, Dict, List, Optional, Tuple
import uuid

from backend.app.api.v1.websocket import ws_manager
from backend.app.core.datetime_utils import utc_now_naive

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp_gateway import WhatsAppGatewayError
from backend.app.services.whatsapp.exceptions import WhatsAppRelinkRequired
from backend.app.services.whatsapp.gateway import extract_send_result
from backend.app.services.whatsapp.identity import jid_to_phone
from backend.app.services.whatsapp.orchestration.sessions import (
    gateway_op_or_mark_relink as _gateway_op_or_mark_relink,
)
from backend.app.services.whatsapp.preview_normalization import (
    build_last_message_summary,
)
from backend.app.services.whatsapp_profiling import profiled
from backend.app.services.whatsapp.repositories.conversations import (
    apply_conversation_last_message as _apply_last_message,
    resolve_conversation_jid as _resolve_jid,
)
from backend.app.services.whatsapp.repositories.reactions import (
    SELF_REACTOR_JID,
    conversation_reaction as _conversation_reaction,
    list_reactions_for_message as _list_reactions_for_message,
    serialize_reaction as _serialize_reaction,
    upsert_reaction as _upsert_reaction,
)
from backend.app.services.whatsapp.repositories.sessions import (
    conversation_gateway_id as _conversation_gateway_id,
    conversation_session as _conversation_session,
)
from backend.app.services.link_preview.service import (
    preview_for_text_message,
)
from backend.app.services.whatsapp.status_policy import (
    advance_message_status as _advance_message_status,
)

logger = logging.getLogger(__name__)

_TERMINAL_OUTBOUND_STATUSES = {
    ConversationMessageStatus.SENT,
    ConversationMessageStatus.DELIVERED,
    ConversationMessageStatus.READ,
}
_ACCEPTED_GATEWAY_STATUSES = {"PENDING", "SENT", "DELIVERED", "READ"}


class _RefCountedLock:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.ref_count = 0


_send_locks: Dict[Tuple[int, str], _RefCountedLock] = {}
_locks_meta_lock = asyncio.Lock()


@asynccontextmanager
async def _acquire_send_lock(conv_id: int, client_msg_id: str):
    """Acquires a granular lock per (conversation_id, client_message_id) tuple.

    Serializes concurrent dispatches of the identical logical message to prevent
    duplicate gateway submissions and race conditions at the database level.
    Deletes the lock when no coroutines remain waiting to prevent memory leaks.
    """
    key = (conv_id, client_msg_id)
    async with _locks_meta_lock:
        if key not in _send_locks:
            _send_locks[key] = _RefCountedLock()
        entry = _send_locks[key]
        entry.ref_count += 1

    async with entry.lock:
        try:
            yield
        finally:
            async with _locks_meta_lock:
                entry.ref_count -= 1
                if entry.ref_count <= 0 and key in _send_locks:
                    del _send_locks[key]


def _validated_send_result(raw: Any) -> Dict[str, Any]:
    parsed = extract_send_result(raw)
    wa_message_id = parsed.get("wa_message_id")
    status = str(parsed.get("status") or "").upper()
    if not wa_message_id or status not in _ACCEPTED_GATEWAY_STATUSES:
        raise WhatsAppGatewayError("Gateway geçersiz gönderim yanıtı döndürdü.")
    return {
        "wa_message_id": str(wa_message_id),
        "status": status,
        "media_id": parsed.get("media_id"),
        "media_mime_type": parsed.get("media_mime_type"),
    }


def serialize_message(
    row: Message,
    reactions: Optional[List[Dict[str, Any]]] = None,
    preview: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Serializes a Message ORM entity into an API dictionary response.

    `reactions` ayri bir parametredir cunku bu fonksiyon SENKRON ve DB'siz
    cagrilir (broadcast yolu dahil); reaksiyonlar tek toplu sorguyla cagiran
    tarafca cozulur (`reactions_by_message`, mesaj basina sorgu = N+1).
    Anahtar her zaman bulunur ki istemci "bos" ile "yok" ayrimini
    yapmak zorunda kalmasin.

    `preview` de AYNI gerekceyle ayri parametredir: link onizlemesi bir DIS
    ISTEK gerektirebilir ve o istek ASLA bu yolun icinde yapilmaz. Cagiran
    (bkz. `previews_by_message`) yalnizca ONBELLEKTEN okur ve bulamadigini
    arka planda cozer. `None` = "onizleme yok", "henuz cozulmedi" anlamina da
    gelir; ikisi arayuzde ayni sekilde (kart cizilmez) ele alinir.
    """
    # Gelen medya gateway'de durur; frontend kimlik dogrulamali proxy uzerinden ceker.
    raw_type = getattr(row, "message_type", None)
    type_str = str(getattr(raw_type, "value", raw_type) or "").upper()
    has_media_metadata = bool(getattr(row, "media_mime_type", None) or getattr(row, "media_filename", None))
    dir_val = getattr(getattr(row, "direction", None), "value", getattr(row, "direction", None))
    st_val = getattr(getattr(row, "status", None), "value", getattr(row, "status", None))
    is_failed_outbound = (str(dir_val).upper() == "OUTBOUND" and str(st_val).upper() == "FAILED" and not row.media_id)
    is_media_expired = (getattr(row, "error_message", None) == "MEDIA_EXPIRED")
    media_key = None if (is_failed_outbound or is_media_expired) else (row.media_id or (row.wa_message_id if type_str and type_str != "TEXT" and has_media_metadata else None))
    media_url = f"/api/v1/whatsapp/media/{media_key}" if media_key else None
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
        "media_url": media_url,
        "wa_message_id": row.wa_message_id,
        "client_message_id": row.client_message_id,
        "sender_phone": row.sender_phone,
        "sender_name": row.sender_name,
        "recipient_phone": row.recipient_phone,
        "error_message": row.error_message,
        "reactions": reactions or [],
        "link_preview": preview or None,
        "quoted_message": getattr(row, "quoted_message", None),
        "is_forwarded": bool(getattr(row, "is_forwarded", False)),
        "is_pinned": bool(getattr(row, "is_pinned", False)),
        "pinned_at": row.pinned_at.isoformat() if getattr(row, "pinned_at", None) else None,
        "pinned_until": row.pinned_until.isoformat() if getattr(row, "pinned_until", None) else None,
        "is_view_once": bool(
            getattr(row, "is_view_once", False)
            or (getattr(row, "body", None) in ("[VIEW_ONCE_PHOTO]", "[VIEW_ONCE_VIDEO]", "[VIEW_ONCE_AUDIO]"))
        ),
        "sent_at": row.sent_at.isoformat() if getattr(row, "sent_at", None) else None,
        "delivered_at": row.delivered_at.isoformat() if getattr(row, "delivered_at", None) else None,
        "read_at": row.read_at.isoformat() if getattr(row, "read_at", None) else None,
        "created_at": row.external_timestamp.isoformat()
        if row.external_timestamp
        else (row.created_at.isoformat() if row.created_at else None),
    }


# Private alias for internal backward compatibility
_serialize_message = serialize_message


class WhatsAppMessagingOrchestrator:
    """Orchestrator coordinator for WhatsApp outbound messaging and media."""

    def __init__(self, service: Optional[Any] = None) -> None:
        self.service = service

    def _get_helper(self, name: str, default: Any) -> Any:
        if self.service is not None:
            return getattr(self.service, name, default)
        return default

    def serialize_message(
        self,
        row: Message,
        reactions: Optional[List[Dict[str, Any]]] = None,
        preview: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        serializer = self._get_helper("_serialize_message", serialize_message)
        return serializer(row, reactions, preview)

    @profiled("send_reaction")
    async def send_reaction(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
        message_id: int,
        emoji: str,
    ) -> Dict[str, Any]:
        """Bir mesaja tepki birakir, degistirir veya kaldirir.

        Reaksiyon bir MESAJ DEGILDIR, bu yuzden burada mesaj satiri OLUSMAZ:
        `last_message_preview` degismez, okunmamis sayaci artmaz ve korumali
        PENDING -> SENT FSM'i isletilmez (tepki gonderilemezse mesaj
        "FAILED" olmus gibi gorunmemeli). Kalici gercek `message_reactions`
        tablosudur; gateway yalnizca WhatsApp'a iletir.
        """
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conversation_session = self._get_helper("_conversation_session", _conversation_session)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", _gateway_op_or_mark_relink)
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        target = await db.scalar(
            select(Message).where(
                Message.id == message_id,
                Message.conversation_id == conv.id,
                get_user_filter(Message.user_id, user_id),
            )
        )
        if target is None:
            raise LookupError("Mesaj bulunamadi.")
        # `emoji == ""` tepkiyi GERI CEKER; bu durumda da hedef mesajin
        # saglayici kimligi gerekir (WhatsApp'a bos bir react gonderilir).
        emoji = (emoji or "").strip()
        if len(emoji) > 32:
            raise ValueError("Reaksiyon en fazla 32 karakter olabilir.")
        if not target.wa_message_id:
            # Saglayici kimligi olmayan bir mesaja WhatsApp tarafinda tepki
            # birakilamaz. Yerelde yazip gondermemek sessizce yalan olurdu.
            raise ValueError("Bu mesaja henuz tepki birakilamaz (saglayici kimligi yok).")

        participant_jid = None
        if conv.is_group and target.direction == MessageDirection.INBOUND:
            if target.sender_phone:
                sp = target.sender_phone.strip()
                if "@" in sp:
                    participant_jid = sp
                else:
                    digits = re.sub(r"[^\d]", "", sp)
                    if digits:
                        participant_jid = f"{digits}@s.whatsapp.net"

        session_row = await conversation_session(db, user_id, conv)
        await gateway_op_or_mark_relink(
            db,
            session_row,
            lambda gid: gateway_client.send_reaction(
                gid,
                jid,
                target_wa_message_id=target.wa_message_id,
                target_from_me=target.direction == MessageDirection.OUTBOUND,
                emoji=emoji,
                participant_jid=participant_jid,
            ),
        )
        row = await _upsert_reaction(
            db,
            user_id=user_id,
            message_id=target.id,
            conversation_id=conv.id,
            reactor_jid=SELF_REACTOR_JID,
            from_me=True,
            emoji=emoji,
        )
        await db.commit()
        return {
            "success": True,
            "conversation_id": conv.id,
            "message_id": target.id,
            "wa_message_id": target.wa_message_id,
            "emoji": emoji,
            "removed": not emoji,
            "reactor_jid": SELF_REACTOR_JID,
            "from_me": True,
            "reaction": _serialize_reaction(row) if row is not None else None,
            "conversation_reaction": await _conversation_reaction(db, conv.id),
        }

    @profiled("pin_message")
    async def pin_message(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
        message_id: int,
        action: str = "PIN",
        duration_seconds: int = 86400,
    ) -> Dict[str, Any]:
        """Pins or unpins a message inside a conversation with native Baileys protocol."""
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conversation_session = self._get_helper("_conversation_session", _conversation_session)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", _gateway_op_or_mark_relink)
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        stmt = (
            select(Message)
            .where(
                Message.id == message_id,
                Message.conversation_id == conversation_id,
            )
        )
        target = (await db.execute(stmt)).scalar_one_or_none()
        if not target:
            raise LookupError(f"Mesaj #{message_id} bulunamadı.")

        if not target.wa_message_id:
            raise ValueError("Bu mesaja henüz sabitleme uygulanamaz (sağlayıcı kimliği yok).")

        participant_jid = None
        if conv.is_group and target.direction == MessageDirection.INBOUND:
            if target.sender_phone:
                sp = target.sender_phone.strip()
                if "@" in sp:
                    participant_jid = sp
                else:
                    digits = re.sub(r"[^\d]", "", sp)
                    if digits:
                        participant_jid = f"{digits}@s.whatsapp.net"

        is_unpin = str(action or "").strip().upper() == "UNPIN"
        valid_durations = [86400, 604800, 2592000]
        duration = duration_seconds if duration_seconds in valid_durations else 86400

        session_row = await conversation_session(db, user_id, conv)
        await gateway_op_or_mark_relink(
            db,
            session_row,
            lambda gid: gateway_client.pin_message(
                gid,
                jid,
                target_wa_message_id=target.wa_message_id,
                target_from_me=target.direction == MessageDirection.OUTBOUND,
                action="UNPIN" if is_unpin else "PIN",
                duration_seconds=duration,
                participant_jid=participant_jid,
            ),
        )

        now = utc_now_naive()
        if is_unpin:
            target.is_pinned = False
            target.pinned_at = None
            target.pinned_until = None
        else:
            target.is_pinned = True
            target.pinned_at = now
            target.pinned_until = now + timedelta(seconds=duration)

        await db.commit()
        await db.refresh(target)

        # Broadcast via WebSocket manager so frontend pin bar updates in real time
        try:
            ws_mgr = self._get_helper("ws_manager", ws_manager)
            await ws_mgr.broadcast_to_user(
                user_id,
                {
                    "type": "message_pinned",
                    "conversation_id": conv.id,
                    "message_id": target.id,
                    "wa_message_id": target.wa_message_id,
                    "is_pinned": target.is_pinned,
                    "pinned_at": target.pinned_at.isoformat() if target.pinned_at else None,
                    "pinned_until": target.pinned_until.isoformat() if target.pinned_until else None,
                },
            )
        except Exception:
            pass

        return {
            "success": True,
            "conversation_id": conv.id,
            "message_id": target.id,
            "wa_message_id": target.wa_message_id,
            "action": "UNPIN" if is_unpin else "PIN",
            "is_pinned": target.is_pinned,
            "pinned_at": target.pinned_at.isoformat() if target.pinned_at else None,
            "pinned_until": target.pinned_until.isoformat() if target.pinned_until else None,
        }

    @profiled("send_text")
    async def send_text_message(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
        body: str,
        client_message_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Dispatches an outbound text message with strict PENDING -> gateway -> SENT/FAILED FSM."""
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conversation_session = self._get_helper("_conversation_session", _conversation_session)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", _gateway_op_or_mark_relink)
        advance_message_status = self._get_helper("_advance_message_status", _advance_message_status)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)
        acquire_send_lock = self._get_helper("_acquire_send_lock", _acquire_send_lock)
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        conv_id = conv.id
        clean = body.strip()
        if not clean:
            # ValueError, not LookupError: the conversation was found, the
            # INPUT is invalid. LookupError became a 404, so an empty composer
            # told the user the conversation does not exist.
            raise ValueError("Mesaj bos olamaz.")
        _now = utc_now_naive()
        session_row = await conversation_session(db, user_id, conv)
        client_message_id = client_message_id or str(uuid.uuid4())

        async with acquire_send_lock(conv_id, client_message_id):
            existing = await db.scalar(
                select(Message).where(
                    Message.client_message_id == client_message_id,
                    Message.conversation_id == conv_id,
                    get_user_filter(Message.user_id, user_id),
                )
            )
            if existing is not None:
                if existing.body != clean:
                    raise ValueError("client_message_id farklı bir mesaj için yeniden kullanılamaz.")
                if existing.message_type != MessageType.TEXT:
                    if existing.status == ConversationMessageStatus.FAILED:
                        existing.message_type = MessageType.TEXT
                    else:
                        raise ValueError("client_message_id farklı bir mesaj için yeniden kullanılamaz.")
                if existing.status in _TERMINAL_OUTBOUND_STATUSES or existing.wa_message_id:
                    preview_data = await preview_for_text_message(
                        db, clean, user_id=user_id, conversation_id=conv_id
                    )
                    return self.serialize_message(existing, preview=preview_data)

                # Mesaj PENDING durumundaysa eşzamanlı/aktif bir gönderim süreci devam ediyor olabilir:
                if existing.status == ConversationMessageStatus.PENDING:
                    for _ in range(25):
                        await asyncio.sleep(0.2)
                        refreshed = await db.scalar(
                            select(Message)
                            .where(
                                Message.id == existing.id,
                                get_user_filter(Message.user_id, user_id),
                            )
                            .execution_options(populate_existing=True)
                        )
                        if refreshed and (refreshed.status in _TERMINAL_OUTBOUND_STATUSES or refreshed.wa_message_id):
                            preview_data = await preview_for_text_message(
                                db, clean, user_id=user_id, conversation_id=conv_id
                            )
                            return self.serialize_message(refreshed, preview=preview_data)
                        if refreshed and refreshed.status == ConversationMessageStatus.FAILED:
                            existing = refreshed
                            break

                    if existing.status == ConversationMessageStatus.PENDING and not existing.wa_message_id:
                        # Bekleme süresi bittiğinde güvenli olmayan ikinci dispatch yapılmaz:
                        existing.status = ConversationMessageStatus.FAILED
                        existing.failed_at = utc_now_naive()
                        existing.error_message = "DELIVERY_UNCONFIRMED: Gönderim zaman aşımına uğradı; teslimat durumu doğrulanamadı."
                        await db.commit()
                        preview_data = await preview_for_text_message(
                            db, clean, user_id=user_id, conversation_id=conv_id
                        )
                        return self.serialize_message(existing, preview=preview_data)

                # Atomik DB Dispatch Claim: Eşzamanlı process'ler aynı FAILED kaydı retry
                # etmeye çalıştığında yalnızca biri satırı PENDING durumuna geçirebilir.
                claim_stmt = (
                    update(Message)
                    .where(
                        Message.id == existing.id,
                        Message.status == ConversationMessageStatus.FAILED,
                        get_user_filter(Message.user_id, user_id),
                    )
                    .values(
                        status=ConversationMessageStatus.PENDING,
                        failed_at=None,
                        error_message=None,
                        wa_message_id=None,
                        message_type=MessageType.TEXT,
                    )
                )
                claim_res = await db.execute(claim_stmt)
                await db.commit()
                if not claim_res.rowcount:
                    # Başka bir worker bizden önce claim etti veya satır terminal duruma geçti.
                    for _ in range(25):
                        await asyncio.sleep(0.2)
                        refreshed = await db.scalar(
                            select(Message)
                            .where(
                                Message.id == existing.id,
                                get_user_filter(Message.user_id, user_id),
                            )
                            .execution_options(populate_existing=True)
                        )
                        if refreshed and (refreshed.status in _TERMINAL_OUTBOUND_STATUSES or refreshed.wa_message_id):
                            preview_data = await preview_for_text_message(
                                db, clean, user_id=user_id, conversation_id=conv_id
                            )
                            return self.serialize_message(refreshed, preview=preview_data)
                    if refreshed and refreshed.status == ConversationMessageStatus.PENDING and not refreshed.wa_message_id:
                        refreshed.status = ConversationMessageStatus.FAILED
                        refreshed.failed_at = utc_now_naive()
                        refreshed.error_message = "DELIVERY_UNCONFIRMED: Eşzamanlı gönderim zaman aşımına uğradı; teslimat durumu doğrulanamadı."
                        await db.commit()
                    preview_data = await preview_for_text_message(
                        db, clean, user_id=user_id, conversation_id=conv_id
                    )
                    return self.serialize_message(refreshed or existing, preview=preview_data)

                await db.refresh(existing)
                row = existing
            else:
                row = Message(
                    user_id=user_id,
                    conversation_id=conv_id,
                    direction=MessageDirection.OUTBOUND,
                    message_type=MessageType.TEXT,
                    body=clean,
                    wa_message_id=None,
                    client_message_id=client_message_id,
                    sender_phone="ME",
                    recipient_phone=jid_to_phone(jid) or jid,
                    status=ConversationMessageStatus.PENDING,
                    # Gonderilen mesaj da ZAMAN EKSENINDE yer alir; aksi halde siralama
                    # ve keyset sayfalamasi disinda kalip sohbetten kayboluyordu.
                    external_timestamp=_now,
                )
                try:
                    db.add(row)
                    await db.commit()
                except IntegrityError:
                    await db.rollback()
                    existing = await db.scalar(
                        select(Message)
                        .where(
                            Message.client_message_id == client_message_id,
                            Message.conversation_id == conv_id,
                            get_user_filter(Message.user_id, user_id),
                        )
                        .execution_options(populate_existing=True)
                    )
                    if existing is None:
                        raise
                    if existing.body != clean:
                        raise ValueError("client_message_id farklı bir mesaj için yeniden kullanılamaz.")
                    if existing.message_type != MessageType.TEXT:
                        if existing.status == ConversationMessageStatus.FAILED:
                            existing.message_type = MessageType.TEXT
                        else:
                            raise ValueError("client_message_id farklı bir mesaj için yeniden kullanılamaz.")
                    if existing.status in _TERMINAL_OUTBOUND_STATUSES or existing.wa_message_id:
                        preview_data = await preview_for_text_message(
                            db, clean, user_id=user_id, conversation_id=conv_id
                        )
                        return self.serialize_message(existing, preview=preview_data)
                    for _ in range(25):
                        await asyncio.sleep(0.2)
                        refreshed = await db.scalar(
                            select(Message)
                            .where(
                                Message.id == existing.id,
                                get_user_filter(Message.user_id, user_id),
                            )
                            .execution_options(populate_existing=True)
                        )
                        if refreshed and (refreshed.status in _TERMINAL_OUTBOUND_STATUSES or refreshed.wa_message_id):
                            preview_data = await preview_for_text_message(
                                db, clean, user_id=user_id, conversation_id=conv_id
                            )
                            return self.serialize_message(refreshed, preview=preview_data)
                        if refreshed and refreshed.status == ConversationMessageStatus.FAILED:
                            existing = refreshed
                            break
                    if existing.status == ConversationMessageStatus.PENDING and not existing.wa_message_id:
                        # Invariant E: Güvenli olmayan fallback dispatch yok!
                        existing.status = ConversationMessageStatus.FAILED
                        existing.failed_at = utc_now_naive()
                        existing.error_message = "DELIVERY_UNCONFIRMED: Eşzamanlı gönderim zaman aşımına uğradı; teslimat durumu doğrulanamadı."
                        await db.commit()
                        preview_data = await preview_for_text_message(
                            db, clean, user_id=user_id, conversation_id=conv_id
                        )
                        return self.serialize_message(existing, preview=preview_data)
                    row = existing

            try:
                gateway_result = await gateway_op_or_mark_relink(
                    db, session_row, lambda gid: gateway_client.send_text_message(gid, jid, clean, client_message_id)
                )
                send_res = _validated_send_result(gateway_result)
            except Exception as exc:
                try:
                    await db.refresh(row)
                except Exception:
                    pass
                if row.status == ConversationMessageStatus.PENDING and not row.wa_message_id:
                    row.status = ConversationMessageStatus.FAILED
                    row.failed_at = utc_now_naive()
                    err_str = str(exc)
                    if any(k in err_str.lower() for k in ("timeout", "connect", "timed out", "502", "504", "network")):
                        row.error_message = f"DELIVERY_UNCONFIRMED: {err_str[:250]}"
                    else:
                        row.error_message = err_str[:300]
                    try:
                        await db.commit()
                    except Exception:
                        await db.rollback()
                raise
            try:
                await db.refresh(row)
            except Exception:
                pass
            row.wa_message_id = send_res["wa_message_id"]
            target_status = send_res.get("status")
            if target_status is None or (getattr(conv, "is_group", False) and str(target_status).upper() == "PENDING"):
                target_status = ConversationMessageStatus.SENT.value
            advance_message_status(row, target_status)
            # Faz 10 (P2): gonderim yolu da paylasilan kurali kullanir (tek kaynak).
            apply_last_message(
                conv,
                utc_now_naive(),
                build_last_message_summary(
                    message_type="TEXT", body=clean, direction=MessageDirection.OUTBOUND.value
                ),
            )
            await db.commit()
            preview_data = await preview_for_text_message(
                db, clean, user_id=user_id, conversation_id=conv_id
            )
            return self.serialize_message(row, preview=preview_data)

    async def send_media_message(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
        media: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Dispatches an outbound media message with strict PENDING -> gateway -> SENT/FAILED FSM."""
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conversation_session = self._get_helper("_conversation_session", _conversation_session)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", _gateway_op_or_mark_relink)
        advance_message_status = self._get_helper("_advance_message_status", _advance_message_status)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)
        acquire_send_lock = self._get_helper("_acquire_send_lock", _acquire_send_lock)
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        conv_id = conv.id
        session_row = await conversation_session(db, user_id, conv)
        client_message_id = media.get("client_message_id") or str(uuid.uuid4())
        media = {**media, "client_message_id": client_message_id}

        mtype_str = (media.get("media_type") or "").upper()
        mime_val = (media.get("mime_type") or "").lower()
        filename_val = (media.get("filename") or "").lower()
        if mtype_str in ("VOICE", "AUDIO", "PTT") or mime_val.startswith("audio/") or filename_val.startswith("voice_") or filename_val.endswith(".ogg") or filename_val.endswith(".opus"):
            msg_type = MessageType.AUDIO
        elif mtype_str in MessageType.__members__:
            msg_type = MessageType[mtype_str]
        elif mime_val.startswith("image/"):
            msg_type = MessageType.IMAGE
        elif mime_val.startswith("video/"):
            msg_type = MessageType.VIDEO
        else:
            msg_type = MessageType.DOCUMENT
        caption = media.get("caption")
        filename = media.get("filename")
        _now = utc_now_naive()
        expected_body = (caption or filename or media.get("media_url") or "")[:4000]

        async with acquire_send_lock(conv_id, client_message_id):
            existing = await db.scalar(
                select(Message).where(
                    Message.client_message_id == client_message_id,
                    Message.conversation_id == conv_id,
                    get_user_filter(Message.user_id, user_id),
                )
            )
            if existing is not None:
                if existing.body != expected_body or existing.message_type != msg_type:
                    raise ValueError("client_message_id farklı bir medya için yeniden kullanılamaz.")
                if existing.status in _TERMINAL_OUTBOUND_STATUSES or existing.wa_message_id:
                    return self.serialize_message(existing)

                # Medya PENDING durumundaysa eşzamanlı/aktif bir gönderim süreci devam ediyor olabilir:
                if existing.status == ConversationMessageStatus.PENDING:
                    for _ in range(25):
                        await asyncio.sleep(0.2)
                        refreshed = await db.scalar(
                            select(Message)
                            .where(
                                Message.id == existing.id,
                                get_user_filter(Message.user_id, user_id),
                            )
                            .execution_options(populate_existing=True)
                        )
                        if refreshed and (refreshed.status in _TERMINAL_OUTBOUND_STATUSES or refreshed.wa_message_id):
                            return self.serialize_message(refreshed)
                        if refreshed and refreshed.status == ConversationMessageStatus.FAILED:
                            existing = refreshed
                            break

                    if existing.status == ConversationMessageStatus.PENDING and not existing.wa_message_id:
                        # Bekleme süresi bittiğinde güvenli olmayan ikinci dispatch yapılmaz:
                        existing.status = ConversationMessageStatus.FAILED
                        existing.failed_at = utc_now_naive()
                        existing.error_message = "DELIVERY_UNCONFIRMED: Gönderim zaman aşımına uğradı; teslimat durumu doğrulanamadı."
                        await db.commit()
                        return self.serialize_message(existing)

                # Atomik DB Dispatch Claim: Eşzamanlı process'ler aynı FAILED kaydı retry
                # etmeye çalıştığında yalnızca biri satırı PENDING durumuna geçirebilir.
                claim_stmt = (
                    update(Message)
                    .where(
                        Message.id == existing.id,
                        Message.status == ConversationMessageStatus.FAILED,
                        get_user_filter(Message.user_id, user_id),
                    )
                    .values(
                        status=ConversationMessageStatus.PENDING,
                        failed_at=None,
                        error_message=None,
                        wa_message_id=None,
                    )
                )
                claim_res = await db.execute(claim_stmt)
                await db.commit()
                if not claim_res.rowcount:
                    # Başka bir worker bizden önce claim etti veya satır terminal duruma geçti.
                    for _ in range(25):
                        await asyncio.sleep(0.2)
                        refreshed = await db.scalar(
                            select(Message)
                            .where(
                                Message.id == existing.id,
                                get_user_filter(Message.user_id, user_id),
                            )
                            .execution_options(populate_existing=True)
                        )
                        if refreshed and (refreshed.status in _TERMINAL_OUTBOUND_STATUSES or refreshed.wa_message_id):
                            return self.serialize_message(refreshed)
                    if refreshed and refreshed.status == ConversationMessageStatus.PENDING and not refreshed.wa_message_id:
                        refreshed.status = ConversationMessageStatus.FAILED
                        refreshed.failed_at = utc_now_naive()
                        refreshed.error_message = "DELIVERY_UNCONFIRMED: Eşzamanlı gönderim zaman aşımına uğradı; teslimat durumu doğrulanamadı."
                        await db.commit()
                    return self.serialize_message(refreshed or existing)

                await db.refresh(existing)
                row = existing
            else:
                row = Message(
                    user_id=user_id,
                    conversation_id=conv_id,
                    direction=MessageDirection.OUTBOUND,
                    message_type=msg_type,
                    body=expected_body,
                    media_id=None,
                    media_filename=filename,
                    media_caption=caption,
                    wa_message_id=None,
                    client_message_id=client_message_id,
                    sender_phone="ME",
                    recipient_phone=jid_to_phone(jid) or jid,
                    status=ConversationMessageStatus.PENDING,
                    external_timestamp=_now,
                )
                try:
                    db.add(row)
                    await db.commit()
                except IntegrityError:
                    await db.rollback()
                    existing = await db.scalar(
                        select(Message)
                        .where(
                            Message.client_message_id == client_message_id,
                            Message.conversation_id == conv_id,
                            get_user_filter(Message.user_id, user_id),
                        )
                        .execution_options(populate_existing=True)
                    )
                    if existing is None:
                        raise
                    if existing.body != expected_body or existing.message_type != msg_type:
                        raise ValueError("client_message_id farklı bir medya için yeniden kullanılamaz.")
                    if existing.status in _TERMINAL_OUTBOUND_STATUSES or existing.wa_message_id:
                        return self.serialize_message(existing)
                    for _ in range(25):
                        await asyncio.sleep(0.2)
                        refreshed = await db.scalar(
                            select(Message)
                            .where(
                                Message.id == existing.id,
                                get_user_filter(Message.user_id, user_id),
                            )
                            .execution_options(populate_existing=True)
                        )
                        if refreshed and (refreshed.status in _TERMINAL_OUTBOUND_STATUSES or refreshed.wa_message_id):
                            return self.serialize_message(refreshed)
                        if refreshed and refreshed.status == ConversationMessageStatus.FAILED:
                            existing = refreshed
                            break
                    if existing.status == ConversationMessageStatus.PENDING and not existing.wa_message_id:
                        # Invariant E: Güvenli olmayan fallback dispatch yok!
                        existing.status = ConversationMessageStatus.FAILED
                        existing.failed_at = utc_now_naive()
                        existing.error_message = "DELIVERY_UNCONFIRMED: Eşzamanlı gönderim zaman aşımına uğradı; teslimat durumu doğrulanamadı."
                        await db.commit()
                        return self.serialize_message(existing)
                    row = existing

            try:
                gateway_result = await gateway_op_or_mark_relink(
                    db, session_row, lambda gid: gateway_client.send_media_message(gid, jid, media)
                )
                send_res = _validated_send_result(gateway_result)
            except Exception as exc:
                try:
                    await db.refresh(row)
                except Exception:
                    pass
                if row.status == ConversationMessageStatus.PENDING and not row.wa_message_id:
                    row.status = ConversationMessageStatus.FAILED
                    row.failed_at = utc_now_naive()
                    err_str = str(exc)
                    if any(k in err_str.lower() for k in ("timeout", "connect", "timed out", "502", "504", "network")):
                        row.error_message = f"DELIVERY_UNCONFIRMED: {err_str[:250]}"
                    else:
                        row.error_message = err_str[:300]
                    try:
                        await db.commit()
                    except Exception:
                        await db.rollback()
                raise
            try:
                await db.refresh(row)
            except Exception:
                pass
            row.wa_message_id = send_res["wa_message_id"]
            if send_res.get("media_id"):
                row.media_id = send_res["media_id"]
            if send_res.get("media_mime_type") and not row.media_mime_type:
                row.media_mime_type = send_res["media_mime_type"]
            target_status = send_res.get("status")
            if target_status is None or (getattr(conv, "is_group", False) and str(target_status).upper() == "PENDING"):
                target_status = ConversationMessageStatus.SENT.value
            advance_message_status(row, target_status)
            apply_last_message(
                conv,
                utc_now_naive(),
                build_last_message_summary(
                    message_type=mtype_str,
                    body=caption or filename,
                    direction=MessageDirection.OUTBOUND.value,
                ),
            )
            await db.commit()
            return self.serialize_message(row)

    async def forward_message(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
        message_id: int,
        target_conversation_ids: List[int],
    ) -> Dict[str, Any]:
        """Forwards an existing message to one or more target conversations."""
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conversation_session = self._get_helper("_conversation_session", _conversation_session)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", _gateway_op_or_mark_relink)
        advance_message_status = self._get_helper("_advance_message_status", _advance_message_status)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)
        gateway_client = self._get_helper("gw", gw)

        # 1. Fetch source message and ensure user access
        stmt = (
            select(Message, Conversation)
            .join(Conversation, Message.conversation_id == Conversation.id)
            .where(
                Message.id == message_id,
                Message.conversation_id == conversation_id,
                get_user_filter(Conversation.user_id, user_id),
            )
        )
        res = (await db.execute(stmt)).first()
        if not res:
            raise LookupError(f"Mesaj #{message_id} bulunamadı.")
        source_msg, source_conv = res

        try:
            _, source_jid = await resolve_jid(db, user_id, source_conv.id)
        except Exception:
            source_jid = None

        results = []
        unique_target_ids = list(dict.fromkeys(target_conversation_ids))[:10]

        for target_id in unique_target_ids:
            try:
                target_conv, target_jid = await resolve_jid(db, user_id, target_id)
            except Exception:
                continue

            session_row = await conversation_session(db, user_id, target_conv)
            client_msg_id = str(uuid.uuid4())
            _now = utc_now_naive()

            row = Message(
                user_id=user_id,
                conversation_id=target_conv.id,
                direction=MessageDirection.OUTBOUND,
                message_type=source_msg.message_type,
                body=source_msg.body,
                wa_message_id=None,
                client_message_id=client_msg_id,
                sender_phone="ME",
                recipient_phone=jid_to_phone(target_jid) or target_jid,
                status=ConversationMessageStatus.PENDING,
                media_id=source_msg.media_id,
                media_mime_type=source_msg.media_mime_type,
                media_filename=source_msg.media_filename,
                media_caption=source_msg.media_caption,
                is_forwarded=True,
                external_timestamp=_now,
            )
            db.add(row)
            await db.commit()

            forward_payload = {
                "source_jid": source_jid,
                "wa_message_id": source_msg.wa_message_id,
                "body": source_msg.body or source_msg.media_caption or "",
                "media_type": source_msg.message_type.value if hasattr(source_msg.message_type, "value") else str(source_msg.message_type),
                "media_id": source_msg.media_id,
                "media_mime_type": source_msg.media_mime_type,
                "media_filename": source_msg.media_filename,
                "media_caption": source_msg.media_caption,
                "client_message_id": client_msg_id,
            }

            send_res = None
            try:
                gw_res = await gateway_op_or_mark_relink(
                    db,
                    session_row,
                    lambda gid: gateway_client.forward_message(gid, target_jid, forward_payload),
                )
                send_res = _validated_send_result(gw_res)
            except Exception as exc:
                if "404" in str(exc):
                    try:
                        if row.media_id:
                            media_dict = {
                                "media_type": (row.message_type.value if hasattr(row.message_type, "value") else str(row.message_type)).lower(),
                                "media_url": f"/api/v1/whatsapp/media/{row.media_id}",
                                "mime_type": row.media_mime_type,
                                "caption": row.media_caption,
                                "filename": row.media_filename,
                                "client_message_id": client_msg_id,
                            }
                            gw_res = await gateway_op_or_mark_relink(
                                db, session_row, lambda gid: gateway_client.send_media_message(gid, target_jid, media_dict)
                            )
                        else:
                            gw_res = await gateway_op_or_mark_relink(
                                db, session_row, lambda gid: gateway_client.send_text_message(gid, target_jid, row.body or "", client_msg_id)
                            )
                        send_res = _validated_send_result(gw_res)
                    except Exception as fallback_exc:
                        row.status = ConversationMessageStatus.FAILED
                        row.failed_at = utc_now_naive()
                        row.error_message = str(fallback_exc)[:300]
                        await db.commit()
                        results.append(self.serialize_message(row))
                        continue
                else:
                    try:
                        await db.refresh(row)
                    except Exception:
                        pass
                    row.status = ConversationMessageStatus.FAILED
                    row.failed_at = utc_now_naive()
                    row.error_message = str(exc)[:300]
                    await db.commit()
                    results.append(self.serialize_message(row))
                    continue

            try:
                await db.refresh(row)
            except Exception:
                pass
            row.wa_message_id = send_res.get("wa_message_id")
            target_status = send_res.get("status")
            if target_status is None or (getattr(target_conv, "is_group", False) and str(target_status).upper() == "PENDING"):
                target_status = ConversationMessageStatus.SENT.value
            advance_message_status(row, target_status)
            apply_last_message(
                target_conv,
                utc_now_naive(),
                build_last_message_summary(
                    message_type=row.message_type.value if hasattr(row.message_type, "value") else str(row.message_type),
                    body=row.body or row.media_caption,
                    direction=MessageDirection.OUTBOUND.value,
                ),
            )
            await db.commit()
            await db.refresh(row)
            results.append(self.serialize_message(row))

        return {
            "success": True,
            "forwarded_count": len([r for r in results if r.get("status") != ConversationMessageStatus.FAILED.value]),
            "results": results,
        }

    async def mark_conversation_read(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
    ) -> Dict[str, Any]:
        """Sohbeti okundu isaretler."""
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conversation_session = self._get_helper("_conversation_session", _conversation_session)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", _gateway_op_or_mark_relink)
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        gateway_ok = True
        gateway_error: Optional[str] = None
        try:
            session_row = await conversation_session(db, user_id, conv)
            gateway_result = await gateway_op_or_mark_relink(
                db, session_row, lambda gid: gateway_client.mark_conversation_read(gid, jid)
            )
            # A transport-level 2xx is not proof that WhatsApp accepted the
            # receipt.  The gateway deliberately returns ``success: false``
            # when ``readMessages`` fails, so treating that payload as success
            # would incorrectly clear the durable unread state.
            if not isinstance(gateway_result, dict) or gateway_result.get("success") is not True:
                gateway_ok = False
                raw_error = gateway_result.get("error") if isinstance(gateway_result, dict) else None
                gateway_error = str(raw_error or "INVALID_GATEWAY_RESPONSE")[:300]
        except WhatsAppRelinkRequired:
            gateway_ok = False
            gateway_error = "WHATSAPP_AUTH_RELINK_REQUIRED"
        except Exception as exc:
            gateway_ok = False
            gateway_error = str(exc)[:300]
            logger.warning("Gateway okundu isareti iletilemedi (conv=%s): %s", conversation_id, exc)
        # §11 truthfulness: yerel "okundu" durumu YALNIZCA gercek basari yolunda
        # yazilir. Onceden gateway cagrisi patlasa bile `unread_count` sifirlanip
        # `last_read_at` damgalanıyordu: veritabani "okundu" diyordu, karsi taraf
        # ise mesaji okunmamis goruyordu. Bu sessiz bir yalandi ve `last_read_at`
        # damgasi, gec gelen dogru snapshot'in rozeti geri getirmesini de
        # engelliyordu (`should_apply_unread_count` okuma korumasi).
        if gateway_ok and (conv.unread_count > 0 or conv.last_read_at is None):
            conv.unread_count = 0
            conv.last_read_at = utc_now_naive()
            await db.commit()
        result: Dict[str, Any] = {"success": gateway_ok}
        if gateway_error:
            result["error"] = gateway_error
        return result

    async def send_typing(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
        typing: bool = True,
    ) -> Dict[str, Any]:
        """Karsi tarafa 'yaziyor...' gostermesi gonderir (WhatsApp Web paritesi)."""
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conversation_session = self._get_helper("_conversation_session", _conversation_session)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", _gateway_op_or_mark_relink)
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        session_row = await conversation_session(db, user_id, conv)
        result = await gateway_op_or_mark_relink(
            db, session_row, lambda gid: gateway_client.send_typing(gid, jid, typing=typing)
        )
        return {
            "success": bool(result.get("success")) if isinstance(result, dict) else False,
            "error": result.get("error") if isinstance(result, dict) else "Gateway returned an invalid typing response.",
        }

    async def subscribe_presence(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
    ) -> Dict[str, Any]:
        """Sohbet icin karsi taraftan 'yaziyor...' ve varlik olaylarini dinlemeyi baslatir."""
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conversation_session = self._get_helper("_conversation_session", _conversation_session)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", _gateway_op_or_mark_relink)
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        session_row = await conversation_session(db, user_id, conv)
        result = await gateway_op_or_mark_relink(
            db, session_row, lambda gid: gateway_client.subscribe_presence(gid, jid)
        )
        return {
            "success": bool(result.get("success")) if isinstance(result, dict) else False,
            "error": result.get("error") if isinstance(result, dict) else None,
        }

    async def get_message(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
        message_id: int,
    ) -> Dict[str, Any]:
        """Tek bir kalici mesaj satirini dondurur (FAILED retry akisinin kaynagi).

        Sohbet kiraci dogrulamali cozer (`_resolve_jid`); mesaj o sohbete ait
        olmak zorundadir — yoksa LookupError (404). Sahte/bos mesaj uydurulmaz.
        """
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)

        conv, _jid = await resolve_jid(db, user_id, conversation_id)
        row = await db.scalar(
            select(Message).where(
                Message.id == message_id,
                Message.conversation_id == conv.id,
                get_user_filter(Message.user_id, user_id),
            )
        )
        if row is None:
            raise LookupError(f"Mesaj bulunamadi (conversation={conversation_id}, message={message_id}).")
        # Tek satirda da reaksiyon rozetleri gelir; aksi halde retry akisinin
        # cektigi mesaj, thread'de gorunen ayni mesajdan farkli cikardi.
        # Rozet OKUMA hatasi mesajin kendisini dusurmemeli (liste ve sayfa
        # yollarindaki ayni kural); bu yuzden burada da sinirli bir tamir var.
        try:
            reactions = await _list_reactions_for_message(db, row.id)
        except Exception as reaction_exc:  # noqa: BLE001 - rozet, mesaji dusurmemeli
            logger.warning("Mesaj reaksiyonlari alinamadi (message_id=%s): %s", row.id, reaction_exc)
            reactions = []
        return self.serialize_message(row, reactions=reactions)

    async def get_message_info(
        self,
        db: AsyncSession,
        user_id: str,
        conversation_id: int,
        message_id: int,
    ) -> Dict[str, Any]:
        """Tek bir mesajin ayrintili okundu ve iletim bilgisini dondurur.

        Birebir sohbetlerde (direct chat):
        - sent_at, delivered_at, read_at zaman damgalari ve durum bilgisi.
        Grup sohbetlerinde:
        - Mesaja ifade birakanlar, sonraki mesaj gonderenler ve gateway'deki
          kullanici okundu bildirimleri birlestirilerek Okuyanlar (read_by)
          ve Teslim Edilenler (delivered_to) listesi uretilir.
        """
        resolve_jid = self._get_helper("_resolve_jid", _resolve_jid)
        conv, jid = await resolve_jid(db, user_id, conversation_id)
        row = await db.scalar(
            select(Message).where(
                Message.id == message_id,
                Message.conversation_id == conv.id,
                get_user_filter(Message.user_id, user_id),
            )
        )
        if row is None:
            raise LookupError(f"Mesaj bulunamadi (conversation={conversation_id}, message={message_id}).")

        reactions = []
        try:
            reactions = await _list_reactions_for_message(db, row.id)
        except Exception as reaction_exc:
            logger.warning("Mesaj reaksiyonlari alinamadi: %s", reaction_exc)

        serialized_msg = self.serialize_message(row, reactions=reactions)
        is_grp = bool(conv.is_group or jid.endswith("@g.us"))

        if not is_grp:
            return {
                "message": serialized_msg,
                "conversation_id": conv.id,
                "is_group": False,
                "sent_at": row.sent_at.isoformat() if row.sent_at else (row.created_at.isoformat() if row.created_at else None),
                "delivered_at": row.delivered_at.isoformat() if row.delivered_at else None,
                "read_at": row.read_at.isoformat() if row.read_at else None,
                "status": row.status.value if hasattr(row.status, "value") else str(row.status),
            }

        # Grup sohbeti icin katilimci ve okundu detaylari
        from backend.app.services.whatsapp.repositories.reactions import batch_resolve_reactor_names

        gateway_receipts = []
        try:
            gateway_id = await _conversation_gateway_id(db, user_id, conv.id)
            if gateway_id and row.wa_message_id:
                gateway_receipts = await gw.get_message_receipts(gateway_id, jid, row.wa_message_id)
        except Exception as gw_exc:
            logger.debug("Gateway user_receipts alinamadi: %s", gw_exc)

        # Collect all candidate JIDs/phones across reactions, receipts, and subsequent replies
        candidate_jids: list[str] = [r["reactor_jid"] for r in reactions if r.get("reactor_jid")]
        for r in gateway_receipts:
            if r.get("user_jid"):
                candidate_jids.append(r["user_jid"])

        subsequent_msgs = []
        if row.external_timestamp or row.created_at:
            ref_ts = row.external_timestamp or row.created_at
            subsequent_msgs = (
                await db.execute(
                    select(Message.sender_phone, Message.sender_name, Message.created_at)
                    .where(
                        Message.conversation_id == conv.id,
                        Message.direction == MessageDirection.INBOUND,
                        Message.created_at > ref_ts,
                    )
                    .order_by(Message.created_at.asc())
                    .limit(50)
                )
            ).all()
            for s_phone, _s_name, _s_ts in subsequent_msgs:
                if s_phone:
                    candidate_jids.append(s_phone)

        unique_jids = list(set(candidate_jids))
        reactor_names_map = await batch_resolve_reactor_names(db, user_id, unique_jids)

        from backend.app.services.whatsapp.repositories.lid_mappings import resolve_lid_phones
        lids_to_resolve = [j for j in unique_jids if "@lid" in j]
        lid_to_phone_map: Dict[str, str] = {}
        if lids_to_resolve:
            try:
                lid_to_phone_map = await resolve_lid_phones(db, lids_to_resolve, user_id=user_id)
            except Exception as lid_err:
                logger.debug("LID resolution in get_message_info skipped: %s", lid_err)

        def _resolve_person_details(raw_jid: Optional[str], fallback_name: Optional[str] = None):
            if not raw_jid:
                return None, fallback_name, None
            target_jid = lid_to_phone_map.get(raw_jid) if "@lid" in raw_jid else raw_jid
            norm_phone = jid_to_phone(target_jid) or jid_to_phone(raw_jid)
            if not norm_phone and raw_jid.isdigit() and len(raw_jid) >= 7:
                norm_phone = f"+{raw_jid}"

            name = reactor_names_map.get(raw_jid) or fallback_name or norm_phone or raw_jid
            return raw_jid, name, norm_phone

        read_by_map: Dict[str, Dict[str, Any]] = {}
        delivered_to_map: Dict[str, Dict[str, Any]] = {}

        def _put_read(raw_jid: str, name: Optional[str], phone: Optional[str], ts: Optional[str], via: str):
            dedup_key = phone or raw_jid
            if dedup_key in read_by_map:
                existing = read_by_map[dedup_key]
                if not existing.get("phone") and phone:
                    existing["phone"] = phone
                return
            read_by_map[dedup_key] = {
                "jid": raw_jid,
                "name": name,
                "phone": phone,
                "timestamp": ts,
                "via": via,
            }

        # 1. Reactions
        for rx in reactions:
            r_jid = rx.get("reactor_jid")
            if not r_jid or rx.get("from_me"):
                continue
            jid_val, name_val, phone_val = _resolve_person_details(r_jid, rx.get("reactor_name"))
            rx_ts = rx.get("updated_at")
            if isinstance(rx_ts, datetime):
                rx_ts_str = rx_ts.isoformat()
            else:
                rx_ts_str = str(rx_ts) if rx_ts else (row.delivered_at.isoformat() if row.delivered_at else (row.created_at.isoformat() if row.created_at else None))
            _put_read(jid_val, name_val, phone_val, rx_ts_str, "reaction")

        # 2. Gateway user receipts
        for rc in gateway_receipts:
            u_jid = rc.get("user_jid")
            if not u_jid:
                continue
            jid_val, name_val, phone_val = _resolve_person_details(u_jid)
            if rc.get("read_timestamp"):
                _put_read(jid_val, name_val, phone_val, rc["read_timestamp"], "receipt")
            elif rc.get("receipt_timestamp"):
                dedup_key = phone_val or jid_val
                if dedup_key not in read_by_map and dedup_key not in delivered_to_map:
                    delivered_to_map[dedup_key] = {
                        "jid": jid_val,
                        "name": name_val,
                        "phone": phone_val,
                        "timestamp": rc["receipt_timestamp"],
                    }

        # 3. Subsequent replies
        for s_phone, s_name, s_ts in subsequent_msgs:
            if s_phone:
                jid_val, name_val, phone_val = _resolve_person_details(s_phone, s_name)
                _put_read(jid_val, name_val, phone_val, s_ts.isoformat() if s_ts else None, "reply")

        return {
            "message": serialized_msg,
            "conversation_id": conv.id,
            "is_group": True,
            "read_by": list(read_by_map.values()),
            "delivered_to": list(delivered_to_map.values()),
        }

    async def get_media_bytes(
        self,
        db: AsyncSession,
        user_id: str,
        media_id: str,
        preview: bool = False,
        retry: bool = False,
    ) -> Tuple[bytes, Optional[str], Optional[str]]:
        """Kullaniciya ait bir mesaja ait medyayi gateway'den proxy'ler."""
        conversation_gateway_id = self._get_helper("_conversation_gateway_id", _conversation_gateway_id)
        gateway_client = self._get_helper("gw", gw)

        res = await db.execute(
            select(Message).where(
                or_(
                    Message.media_id == media_id,
                    Message.wa_message_id == media_id,
                ),
                get_user_filter(Message.user_id, user_id),
            )
        )
        row = res.scalars().first()
        if row is None:
            fetch_unscoped = getattr(gateway_client, "fetch_media_unscoped", None)
            if fetch_unscoped:
                try:
                    data = await fetch_unscoped(media_id, preview=preview, retry=retry)
                    mime = None
                    if data.startswith(b"\xff\xd8\xff"):
                        mime = "image/jpeg"
                    elif data.startswith(b"\x89PNG"):
                        mime = "image/png"
                    elif data.startswith(b"OggS"):
                        mime = "audio/ogg; codecs=opus"
                    elif len(data) >= 8 and (data[4:8] == b"ftyp" or data[:4] == b"\x00\x00\x00\x18"):
                        mime = "video/mp4"
                    elif data.startswith(b"%PDF"):
                        mime = "application/pdf"
                    return data, mime, None
                except Exception:
                    pass
            raise LookupError(f"Medya bulunamadi: {media_id}")
        conv = await db.get(Conversation, row.conversation_id)
        if conv is None:
            raise LookupError(f"Medya bulunamadi: {media_id}")
        gateway_id = await conversation_gateway_id(db, user_id, conv)
        target_id = row.media_id or media_id
        wa_msg_id = row.wa_message_id
        mime = row.media_mime_type
        filename = getattr(row, "media_filename", None)

        chat_jid = None
        if conv and conv.contact_id:
            c_res = await db.execute(select(Contact).where(Contact.id == conv.contact_id))
            contact = c_res.scalar_one_or_none()
            if contact:
                if contact.custom_attributes and isinstance(contact.custom_attributes, dict):
                    chat_jid = contact.custom_attributes.get("jid")
                if not chat_jid and contact.phone_e164:
                    clean_phone = re.sub(r"\D", "", contact.phone_e164)
                    if clean_phone:
                        chat_jid = f"{clean_phone}@s.whatsapp.net"
        is_from_me = (row.direction == MessageDirection.OUTBOUND)

        # Commit the read transaction so the DB connection is released to the pool
        # while waiting on the gateway media download.
        await db.commit()
        try:
            data = await gateway_client.fetch_media(
                gateway_id, target_id, preview=preview, retry=retry, jid=chat_jid, from_me=is_from_me
            )
        except LookupError:
            try:
                if target_id != media_id:
                    data = await gateway_client.fetch_media(
                        gateway_id, media_id, preview=preview, retry=retry, jid=chat_jid, from_me=is_from_me
                    )
                elif wa_msg_id and target_id != wa_msg_id:
                    data = await gateway_client.fetch_media(
                        gateway_id, wa_msg_id, preview=preview, retry=retry, jid=chat_jid, from_me=is_from_me
                    )
                else:
                    raise
            except LookupError:
                try:
                    row.error_message = "MEDIA_EXPIRED"
                    await db.commit()
                except Exception:
                    pass
                raise LookupError(f"Medya süresi doldu veya bulunamadı: {media_id}")

        if not mime and data:
            if data.startswith(b"\xff\xd8\xff"):
                mime = "image/jpeg"
            elif data.startswith(b"\x89PNG"):
                mime = "image/png"
            elif data.startswith(b"OggS"):
                mime = "audio/ogg; codecs=opus"
            elif len(data) >= 8 and (data[4:8] == b"ftyp" or data[:4] == b"\x00\x00\x00\x18"):
                mime = "video/mp4"
            elif data.startswith(b"%PDF"):
                mime = "application/pdf"
            elif row.message_type == MessageType.IMAGE:
                mime = "image/jpeg"
            elif row.message_type == MessageType.VIDEO:
                mime = "video/mp4"
            elif row.message_type == MessageType.AUDIO:
                mime = "audio/ogg"

        if data and row.media_id is None and target_id:
            try:
                row.media_id = target_id
                if mime and not row.media_mime_type:
                    row.media_mime_type = mime
                await db.commit()
            except Exception:
                pass

        return data, mime, row.media_filename


# Default module-level orchestrator instance
_default_orchestrator = WhatsAppMessagingOrchestrator()

send_text_message = _default_orchestrator.send_text_message
send_media_message = _default_orchestrator.send_media_message
forward_message = _default_orchestrator.forward_message
pin_message = _default_orchestrator.pin_message
mark_conversation_read = _default_orchestrator.mark_conversation_read
send_typing = _default_orchestrator.send_typing
subscribe_presence = _default_orchestrator.subscribe_presence
get_message = _default_orchestrator.get_message
get_media_bytes = _default_orchestrator.get_media_bytes
