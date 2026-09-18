"""WhatsApp Messaging Orchestration Service (Phase 11.9).

Handles outbound text and media dispatch, conversation read receipts,
typing presence, media proxying, and message serialization.
Preserves strict transaction boundaries:
- Immediate commit of PENDING outbound message
- Gateway dispatch with relink fallback
- Automatic transition to FAILED on gateway exception
- Advance status to SENT/DELIVERED and update conversation last message summary
"""
from datetime import datetime
import logging
from typing import Any, Dict, Optional, Tuple
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.services import whatsapp_gateway as gw
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
from backend.app.services.whatsapp.repositories.sessions import (
    conversation_gateway_id as _conversation_gateway_id,
    conversation_session as _conversation_session,
)
from backend.app.services.whatsapp.status_policy import (
    advance_message_status as _advance_message_status,
)

logger = logging.getLogger(__name__)


def serialize_message(row: Message) -> Dict[str, Any]:
    """Serializes a Message ORM entity into an API dictionary response."""
    # Gelen medya gateway'de durur; frontend kimlik dogrulamali proxy uzerinden ceker.
    media_url = f"/api/v1/whatsapp/media/{row.media_id}" if row.media_id else None
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

    def serialize_message(self, row: Message) -> Dict[str, Any]:
        serializer = self._get_helper("_serialize_message", serialize_message)
        return serializer(row)

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
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        clean = body.strip()
        if not clean:
            raise LookupError("Mesaj bos olamaz.")
        _now = datetime.utcnow()
        session_row = await conversation_session(db, user_id, conv)
        client_message_id = client_message_id or str(uuid.uuid4())
        existing = await db.scalar(
            select(Message).where(
                Message.client_message_id == client_message_id,
                Message.conversation_id == conv.id,
                get_user_filter(Message.user_id, user_id),
            )
        )
        if existing is not None:
            return self.serialize_message(existing)
        row = Message(
            user_id=user_id,
            conversation_id=conv.id,
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
        db.add(row)
        await db.commit()
        try:
            gateway_result = await gateway_op_or_mark_relink(
                db, session_row, lambda gid: gateway_client.send_text_message(gid, jid, clean, client_message_id)
            )
        except Exception as exc:
            await db.refresh(row)
            if row.status == ConversationMessageStatus.PENDING:
                row.status = ConversationMessageStatus.FAILED
                row.failed_at = datetime.utcnow()
                row.error_message = str(exc)[:300]
                await db.commit()
            raise
        await db.refresh(row)
        send_res = extract_send_result(gateway_result)
        row.wa_message_id = send_res["wa_message_id"] or row.wa_message_id
        target_status = send_res.get("status")
        is_group = bool(conv.is_group) or ("@g.us" in str(jid))
        if is_group and target_status in (None, "PENDING"):
            target_status = ConversationMessageStatus.SENT.value
        advance_message_status(row, target_status)
        # Faz 10 (P2): gonderim yolu da paylasilan kurali kullanir (tek kaynak).
        apply_last_message(
            conv,
            datetime.utcnow(),
            build_last_message_summary(
                message_type="TEXT", body=clean, direction=MessageDirection.OUTBOUND.value
            ),
        )
        await db.commit()
        return self.serialize_message(row)

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
        gateway_client = self._get_helper("gw", gw)

        conv, jid = await resolve_jid(db, user_id, conversation_id)
        session_row = await conversation_session(db, user_id, conv)
        media = {**media, "client_message_id": media.get("client_message_id") or str(uuid.uuid4())}
        existing = await db.scalar(
            select(Message).where(
                Message.client_message_id == media["client_message_id"],
                Message.conversation_id == conv.id,
                get_user_filter(Message.user_id, user_id),
            )
        )
        if existing is not None:
            return self.serialize_message(existing)
        mtype_str = (media.get("media_type") or "document").upper()
        try:
            msg_type = MessageType[mtype_str] if mtype_str in MessageType.__members__ else MessageType.DOCUMENT
        except (KeyError, TypeError) as exc:
            logger.warning("Media message_type gecersiz; DOCUMENT fallback (value=%r): %s", mtype_str, exc)
            msg_type = MessageType.DOCUMENT
        caption = media.get("caption")
        filename = media.get("filename")
        _now = datetime.utcnow()
        row = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=msg_type,
            body=(caption or filename or media.get("media_url") or "")[:4000],
            media_id=None,
            media_filename=filename,
            media_caption=caption,
            wa_message_id=None,
            client_message_id=media.get("client_message_id"),
            sender_phone="ME",
            recipient_phone=jid_to_phone(jid) or jid,
            status=ConversationMessageStatus.PENDING,
            external_timestamp=_now,
        )
        db.add(row)
        # Faz 10 (P2): "[Medya]" yerine paylasilan kuralin tip etiketi.
        await db.commit()
        try:
            gateway_result = await gateway_op_or_mark_relink(
                db, session_row, lambda gid: gateway_client.send_media_message(gid, jid, media)
            )
        except Exception as exc:
            await db.refresh(row)
            if row.status == ConversationMessageStatus.PENDING:
                row.status = ConversationMessageStatus.FAILED
                row.failed_at = datetime.utcnow()
                row.error_message = str(exc)[:300]
                await db.commit()
            raise
        await db.refresh(row)
        send_res = extract_send_result(gateway_result)
        row.wa_message_id = send_res["wa_message_id"] or row.wa_message_id
        target_status = send_res.get("status")
        is_group = bool(conv.is_group) or ("@g.us" in str(jid))
        if is_group and target_status in (None, "PENDING"):
            target_status = ConversationMessageStatus.SENT.value
        advance_message_status(row, target_status)
        apply_last_message(
            conv,
            datetime.utcnow(),
            build_last_message_summary(
                message_type=mtype_str,
                body=caption or filename,
                direction=MessageDirection.OUTBOUND.value,
            ),
        )
        await db.commit()
        return self.serialize_message(row)

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
            await gateway_op_or_mark_relink(
                db, session_row, lambda gid: gateway_client.mark_conversation_read(gid, jid)
            )
        except WhatsAppRelinkRequired:
            gateway_ok = False
            gateway_error = "WHATSAPP_AUTH_RELINK_REQUIRED"
        except Exception as exc:
            gateway_ok = False
            gateway_error = str(exc)[:300]
            logger.warning("Gateway okundu isareti iletilemedi (conv=%s): %s", conversation_id, exc)
        if conv.unread_count > 0 or conv.last_read_at is None:
            conv.unread_count = 0
            conv.last_read_at = datetime.utcnow()
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

    async def get_media_bytes(
        self,
        db: AsyncSession,
        user_id: str,
        media_id: str,
    ) -> Tuple[bytes, Optional[str], Optional[str]]:
        """Kullaniciya ait bir mesaja ait medyayi gateway'den proxy'ler."""
        conversation_gateway_id = self._get_helper("_conversation_gateway_id", _conversation_gateway_id)
        gateway_client = self._get_helper("gw", gw)

        res = await db.execute(
            select(Message).where(
                Message.media_id == media_id,
                get_user_filter(Message.user_id, user_id),
            )
        )
        row = res.scalars().first()
        if row is None:
            raise LookupError(f"Medya bulunamadi: {media_id}")
        conv = await db.get(Conversation, row.conversation_id)
        if conv is None:
            raise LookupError(f"Medya bulunamadi: {media_id}")
        gateway_id = await conversation_gateway_id(db, user_id, conv)
        data = await gateway_client.fetch_media(gateway_id, media_id)
        return data, row.media_mime_type, row.media_filename


# Default module-level orchestrator instance
_default_orchestrator = WhatsAppMessagingOrchestrator()

send_text_message = _default_orchestrator.send_text_message
send_media_message = _default_orchestrator.send_media_message
mark_conversation_read = _default_orchestrator.mark_conversation_read
send_typing = _default_orchestrator.send_typing
get_media_bytes = _default_orchestrator.get_media_bytes
