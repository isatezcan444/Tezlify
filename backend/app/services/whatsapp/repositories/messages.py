"""Message persistence repository.

Read-only and persistence queries for WhatsApp messages.
DOES NOT own transaction lifecycle (no commit/rollback).
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.services.whatsapp.identity import jid_to_phone
from backend.app.services.whatsapp.identity import jid_to_phone
from backend.app.services.whatsapp.preview_normalization import as_naive_utc, parse_dt

logger = logging.getLogger(__name__)


def msg_time_col():
    """Mesajin ZAMAN EKSENI (COALESCE kurali)."""
    return func.coalesce(Message.external_timestamp, Message.sent_at, Message.created_at)


def msg_time(row: Optional[Message]) -> Optional[datetime]:
    """`msg_time_col()` kolonunun Python karsiligi (ayni oncelik)."""
    if row is None:
        return None
    return row.external_timestamp or row.sent_at or row.created_at


def hydration_cursor_ms(rows: List[Optional[Message]]) -> Optional[int]:
    """Verilen mesaj satirlarindaki EN ESKI gercek zaman damgasini ms epoch'a cevirir."""
    oldest: Optional[datetime] = None
    for r in rows:
        if r is None:
            continue
        ts = msg_time(r)
        if ts is not None and (oldest is None or ts < oldest):
            oldest = ts
    if oldest is None:
        return None
    return int(oldest.replace(tzinfo=timezone.utc).timestamp() * 1000)


async def get_sync_watermark_epoch(db: AsyncSession, owner: str) -> Optional[int]:
    """Kullanicinin DB'sindeki en son gelen mesaj zamani (epoch saniye, 5 dk overlap payiyla)."""
    res = await db.execute(
        select(func.max(Message.external_timestamp)).where(
            get_user_filter(Message.user_id, owner),
            Message.direction == MessageDirection.INBOUND,
        )
    )
    ts = res.scalar()
    if ts is None:
        return None
    return int(ts.replace(tzinfo=timezone.utc).timestamp()) - 300


async def get_message_by_id(
    db: AsyncSession, message_id: int, conversation_id: int
) -> Optional[Message]:
    """ID ve conversation_id ile tek bir mesaji doner."""
    res = await db.execute(
        select(Message).where(Message.id == message_id, Message.conversation_id == conversation_id)
    )
    return res.scalars().first()


async def select_messages_keyset(
    db: AsyncSession,
    user_id: str,
    conversation_id: int,
    limit: int = 50,
    before_row: Optional[Message] = None,
    before: Optional[int] = None,
) -> List[Message]:
    """Zaman damgali keyset sayfalamasi ile mesajlari getirir (en yeni -> en eski)."""
    page_size = min(max(int(limit), 1), 100)
    base = select(Message).where(
        Message.conversation_id == conversation_id,
        get_user_filter(Message.user_id, user_id),
    )
    if before_row is not None:
        cutoff = msg_time(before_row)
        if cutoff is not None:
            base = base.where(
                or_(
                    msg_time_col() < cutoff,
                    and_(msg_time_col() == cutoff, Message.id < before_row.id),
                )
            )
        else:
            base = base.where(Message.id < before_row.id)
    elif before is not None:
        base = base.where(Message.id < before)

    base = base.order_by(msg_time_col().desc(), Message.id.desc()).limit(page_size)
    res = await db.execute(base)
    return list(res.scalars().all())


async def has_older_messages(
    db: AsyncSession,
    user_id: str,
    conversation_id: int,
    oldest_row: Message,
) -> bool:
    """Verilen en eski mesajdan daha eski mesaj var mi kontrol eder."""
    oldest_ts = msg_time(oldest_row)
    if oldest_ts is None:
        return False
    older_exists = await db.scalar(
        select(Message.id).where(
            Message.conversation_id == conversation_id,
            get_user_filter(Message.user_id, user_id),
            or_(
                msg_time_col() < oldest_ts,
                and_(msg_time_col() == oldest_ts, Message.id < oldest_row.id),
            ),
        ).limit(1)
    )
    return older_exists is not None


def build_message_from_gateway(
    owner: str, conv: Conversation, msg: Dict[str, Any]
) -> Optional[Message]:
    """Gateway mesaj sozslugunden Message ORM satiri olusturur."""
    jid_str = str(msg.get("conversation_id") or "")
    mtype_str = (msg.get("message_type") or "TEXT").upper()
    try:
        mtype = MessageType[mtype_str] if mtype_str in MessageType.__members__ else MessageType.TEXT
    except (KeyError, TypeError) as exc:
        logger.warning("Gateway message_type gecersiz; TEXT fallback (value=%r): %s", mtype_str, exc)
        mtype = MessageType.TEXT
    direction = MessageDirection.INBOUND if str(msg.get("direction", "INBOUND")).upper() == "INBOUND" else MessageDirection.OUTBOUND
    body = msg.get("body") or ""
    ts = parse_dt(msg.get("created_at"))
    if ts is None and msg.get("timestamp_s") is not None:
        try:
            ts = datetime.fromtimestamp(float(msg["timestamp_s"]), tz=timezone.utc)
        except Exception:
            pass
    if ts is None and msg.get("timestamp") is not None:
        try:
            val = float(msg["timestamp"])
            if val > 1e11:
                val /= 1000.0
            ts = datetime.fromtimestamp(val, tz=timezone.utc)
        except Exception:
            pass
    status_str = str(msg.get("status") or ("RECEIVED" if direction == MessageDirection.INBOUND else "SENT")).upper()
    try:
        status = ConversationMessageStatus[status_str]
    except (KeyError, TypeError) as exc:
        logger.warning("Gateway message status gecersiz; direction fallback (value=%r): %s", status_str, exc)
        status = ConversationMessageStatus.RECEIVED if direction == MessageDirection.INBOUND else ConversationMessageStatus.SENT
    return Message(
        user_id=owner,
        conversation_id=conv.id,
        direction=direction,
        message_type=mtype,
        body=body[:4000] if body else None,
        media_id=msg.get("media_id"),
        media_mime_type=msg.get("media_mime_type"),
        media_filename=msg.get("media_filename"),
        media_caption=msg.get("media_caption"),
        wa_message_id=msg.get("wa_message_id"),
        client_message_id=msg.get("client_message_id"),
        # D3: no fake phone numbers (hard invariant). LID senders have no
        # resolvable phone, so persist NULL instead of the literal "unknown".
        sender_phone=msg.get("sender_phone") or jid_to_phone(jid_str) or None,
        sender_name=msg.get("participant_name") or msg.get("sender_name"),
        recipient_phone=msg.get("recipient_phone") or "ME",
        status=status,
        external_timestamp=as_naive_utc(ts),
    )


async def message_exists_by_wa_id(
    db: AsyncSession, conversation_id: int, wa_message_id: str
) -> bool:
    """Verilen wa_message_id ile bu sohbette mesaj var mi kontrol eder."""
    existing = await db.execute(
        select(Message.id).where(
            Message.wa_message_id == wa_message_id,
            Message.conversation_id == conversation_id,
        ).limit(1)
    )
    return existing.scalar_one_or_none() is not None

