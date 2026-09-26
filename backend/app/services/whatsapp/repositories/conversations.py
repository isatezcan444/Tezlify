"""Conversation persistence repository.

Read-only and persistence queries for WhatsApp conversations.
DOES NOT own transaction lifecycle (no commit/rollback).
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

_conversation_locks: Dict[Tuple[str, int], asyncio.Lock] = {}


def get_conversation_lock(user_id: str, conversation_id: int) -> asyncio.Lock:
    """Tek bir sohbet basina async kilit (manual scroll + background hydration kesisimi)."""
    key = (str(user_id), int(conversation_id))
    lock = _conversation_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _conversation_locks[key] = lock
    return lock


from backend.app.core.auth import get_user_filter
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.services.whatsapp.identity import contact_phone_for_jid, phone_to_jid
from backend.app.services.whatsapp.preview_normalization import (
    as_naive_utc,
    should_apply_last_message,
    should_apply_unread_count,
)

logger = logging.getLogger(__name__)


def get_conversation_scope_filters(
    user_id: str, contact_id: Any, session_id: Optional[int] = None
) -> List[Any]:
    """Return the canonical tenant/line scope for a WhatsApp conversation."""
    filters: List[Any] = [
        Conversation.contact_id == contact_id,
        Conversation.channel == "WHATSAPP",
        get_user_filter(Conversation.user_id, user_id),
    ]
    if session_id is not None:
        filters.append(Conversation.session_id == session_id)
    return filters


async def get_conversation_by_id(
    db: AsyncSession, user_id: str, conversation_id: int
) -> Conversation:
    """Tek bir konusmayi ID ile getirir; yoksa LookupError."""
    stmt = select(Conversation).where(
        Conversation.id == conversation_id,
        get_user_filter(Conversation.user_id, user_id),
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()
    if not conv:
        raise LookupError("Konusma bulunamadi.")
    return conv


async def resolve_conversation_jid(
    db: AsyncSession, user_id: str, conversation_id: int
) -> Tuple[Conversation, str]:
    """Konusmanin canonical JID kimligini ve konusma nesnesini doner."""
    stmt = (
        select(Conversation)
        .options(joinedload(Conversation.contact))
        .where(
            Conversation.id == conversation_id,
            get_user_filter(Conversation.user_id, user_id),
        )
    )
    res = await db.execute(stmt)
    conv = res.scalar_one_or_none()
    if not conv:
        raise LookupError("Konusma bulunamadi.")
    if not conv.contact_id:
        raise LookupError("Konusma bir kisiyle iliskili degil.")
    contact = conv.contact
    if contact is None:
        cres = await db.execute(select(Contact).where(Contact.id == conv.contact_id))
        contact = cres.scalar_one_or_none()
        if contact is None:
            raise LookupError("Konusma bir kisiyle iliskili degil.")
    phone = contact.phone_e164
    jid = phone[4:] if phone.startswith("jid:") else phone_to_jid(phone)
    return conv, jid


async def find_whatsapp_conversation(
    db: AsyncSession, user_id: str, jid: str, session_id: Optional[int] = None
) -> Optional[Conversation]:
    """JID'e karsilik gelen MEVCUT WhatsApp sohbeti; yoksa None (yaratmaz).

    Durum olaylari (presence/read/ack) icin kullanilir: bu olaylar sohbet
    listesine yeni satir EKLEYEMEZ.
    """
    phone = contact_phone_for_jid(jid)
    contact_id = await db.scalar(
        select(Contact.id).where(
            Contact.phone_e164 == phone,
            get_user_filter(Contact.user_id, user_id),
        )
    )
    if contact_id is None:
        return None
    filters = get_conversation_scope_filters(user_id, contact_id, session_id)
    res = await db.execute(select(Conversation).where(*filters).order_by(Conversation.id.asc()))
    rows = list(res.scalars().all())
    if session_id is not None and not rows:
        # Backfill a legacy, line-less row only when it is unambiguous for
        # this tenant/contact. Never borrow a row already assigned to another
        # line.
        legacy_res = await db.execute(
            select(Conversation).where(
                Conversation.contact_id == contact_id,
                Conversation.channel == "WHATSAPP",
                Conversation.session_id.is_(None),
                get_user_filter(Conversation.user_id, user_id),
            ).order_by(Conversation.id.asc())
        )
        legacy_rows = list(legacy_res.scalars().all())
        if len(legacy_rows) == 1:
            legacy_rows[0].session_id = session_id
            await db.flush()
            return legacy_rows[0]
        if len(legacy_rows) > 1:
            logger.warning(
                "Legacy line-less sohbet belirsizligi (user=%s,jid=%s,count=%s)",
                user_id,
                jid,
                len(legacy_rows),
            )
            return None
    if session_id is None and len(rows) > 1:
        # Legacy gateway events without a session id cannot be attributed to
        # one of several lines without guessing. Fail closed.
        logger.warning(
            "Durum olayi belirsiz sohbet nedeniyle atlandi (user=%s,jid=%s,conversation_count=%s)",
            user_id,
            jid,
            len(rows),
        )
        return None
    return rows[0] if rows else None


def apply_conversation_last_message(
    conv: Conversation, ts: Optional[datetime], summary: str
) -> bool:
    """Sohbetin son mesaj alanlarini ZAMAN DAMGALI kurala gore gunceller.

    `last_message_at` ve `last_message_preview` IKI AYRI karardir ve tek bir
    boolean'a baglanmamalidir:

    - `last_message_at` = AKTIVITE damgasi. Her mesaj bir aktivitedir — metni
      olsun olmasin. Bir ifade, "bu mesaji sildiniz", grup ayari uyarisi,
      "X gruba eklendi" bildirimi, kullanici adi duyurusu veya arama kaydi
      metin tasimaz. Eski kod bos ozette damgayi da reddediyordu; bu yuzden
      tam olarak o sohbetler listede eski yerinde donuyordu (canli olcum
      2026-09-26: "Hat 1" 09:35:56'da kilitli kaldi, en yeni mesaji 09:44:25).
    - `last_message_preview` = METIN onizlemesi. Bos ozet mevcut onizlemeyi
      KORUR; karar noktasi `should_apply_last_message`.

    `ts is None` (realtime mesaj veya onizleme tamiri) damgayi ILERLETMEZ, boylece
    "gelecek zaman damgasi tohumlama" yasagi (Faz 10 RC-1) korunur.
    """
    previous_ts = conv.last_message_at
    ts_naive = as_naive_utc(ts)
    apply_preview = should_apply_last_message(previous_ts, ts, summary)

    changed = False
    if ts_naive is not None and (previous_ts is None or ts_naive > previous_ts):
        conv.last_message_at = ts_naive
        changed = True
    if apply_preview:
        conv.last_message_preview = summary[:500]
        changed = True
    return changed


def apply_conversation_unread_count(
    conv: Conversation,
    incoming: Optional[int],
    *,
    incoming_activity_ts: Optional[datetime] = None,
) -> bool:
    """Sohbetin okunmamis sayacini paylasilan kurala gore gunceller.

    Tek karar noktasi `preview_normalization.should_apply_unread_count`.
    Gateway okunmamis sayisinin SAHIBIDIR ve dususleri de bildirir (telefondan
    okunan sohbet 0'a iner). Bu yuzden yerel deger ASAGI inebilmelidir; salt
    `max()` kurali baska bir cihazda yapilan okumayi kalici olarak gorunmez
    kiliyordu. Yalnizca KANITLANABILIR sekilde eski olan snapshot'lar engellenir.
    """
    if not should_apply_unread_count(
        conv.unread_count,
        incoming,
        current_activity_ts=conv.last_message_at,
        incoming_activity_ts=incoming_activity_ts,
        last_read_at=conv.last_read_at,
    ):
        return False
    new_value = max(0, int(incoming))
    previous = conv.unread_count or 0

    # P6-2: an authoritative drop to zero IS read evidence — including a read
    # performed on another device, which never goes through our own
    # `mark_conversation_read` and therefore never stamped `last_read_at`.
    # Without this, a snapshot produced BEFORE that read but carrying the same
    # `last_message_at` is indistinguishable from the current state (an
    # external read changes neither timestamp) and resurrects the badge.
    #
    # The stamp is the newest activity we know about, not wall-clock now: that
    # keeps the read guard comparable with provider timestamps, so a message
    # that genuinely arrives later still raises the badge normally.
    if new_value == 0 and previous > 0:
        conv.last_read_at = conv.last_message_at or conv.last_read_at

    conv.unread_count = new_value
    return True


def create_conversation_entity(
    user_id: str,
    contact_id: int,
    session_id: Optional[int] = None,
    preview: Optional[str] = None,
    is_group: bool = False,
) -> Conversation:
    """Yaratilan Conversation ORM nesnesi (henuz DB'ye eklenmemis)."""
    return Conversation(
        user_id=user_id,
        contact_id=contact_id,
        channel="WHATSAPP",
        status=ConversationStatus.ACTIVE,
        session_id=session_id,
        last_message_preview=preview,
        is_group=is_group,
        is_archived=False,
        last_message_at=None,
    )

