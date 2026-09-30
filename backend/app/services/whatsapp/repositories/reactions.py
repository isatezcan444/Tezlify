"""Mesaj reaksiyonlari icin okuma/yazma yardimcilari.

Neden ayri dosya: reaksiyonlar mesajin PARCASI degil, mesaj hakkinda ayri bir
ifadedir. Okuma yollari da bu yuzden ayri: bir sayfa mesaj cekildiginde
reaksiyonlar TOPLU olarak alinir (mesaj basina sorgu = N+1), ki 50 mesajlik bir
thread 50 ek sorgu uretmesin.
"""

import logging
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.message_reaction import MessageReaction

logger = logging.getLogger(__name__)

# Yerel hattin reaksiyonlardaki kimligi. `Message.sender_phone == "ME"`
# gelenegiyle ayni: NULL tekillik kisitina giremez (SQL'de NULL'lar farklidir)
# ve "kim birakti" sorusunu cevapsiz birakir.
SELF_REACTOR_JID = "ME"


def reaction_identity(from_me: bool, reactor_jid: Optional[str]) -> Optional[str]:
    """Reaksiyonu birakan icin KARARLI bir kimlik uretir.

    Kimlik cozulemezse `None` doner ve cagiran taraf olayi atlar: ayni
    mesaja iki farkli bilinmeyen kisinin tepkisi ayni satiri ezerek birinin
    ifadesini sessizce yok edebilirdi.
    """
    if from_me:
        return SELF_REACTOR_JID
    clean = str(reactor_jid or "").strip()
    return clean or None


async def upsert_reaction(
    db: AsyncSession,
    *,
    user_id: Optional[str],
    message_id: int,
    conversation_id: int,
    reactor_jid: str,
    from_me: bool,
    emoji: str,
) -> Optional[MessageReaction]:
    """Bir reaksiyonu yazar, degistirir veya geri ceker (tek satir = tek kisilik).

    Iki yarisi da tekillik indeksi cozer:
    - Ayni kisi ayni mesaja tekrar tepki verirse satir GUNCELLENIR (UPDATE).
    - Iki teslim ayni anda gelirse kaybeden `IntegrityError` alir; savepoint
      sayesinde yalnizca bu INSERT geri alinir, ardindan kazanan satir secilip
      UPDATE'e cevrilir.

    `emoji == ""` geri cekmedir. Karsilik gelen satir YOKSA hic satir acilmaz:
    cekilecek bir ifade zaten olmadigi icin "bos reaksiyon" diye bir sey
    yaratmak cop satir olurdu (bu isin ta basindaki `[REACTION]` hatasinin
    aynisi). Var olan satir ise silinmez, `emoji=""` ile isaretlenir ki
    tekrar tepki verdiginde INSERT yarisi olmadan UPDATE olsun.
    """
    existing = await _select_reaction(db, message_id, reactor_jid)
    if existing is None and not emoji:
        return None
    if existing is None:
        row = MessageReaction(
            user_id=user_id,
            message_id=message_id,
            conversation_id=conversation_id,
            reactor_jid=reactor_jid,
            from_me=from_me,
            emoji=emoji,
        )
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError:
            # Ayni (mesaj, kisi) cifti icin yaris kaybedildi: kazanan satiri
            # secip UPDATE'e cevir, yoksa bu tepki kaybolurdu.
            logger.info(
                "Reaksiyon yarisi kaybedildi, kazanan satir guncelleniyor "
                "(message_id=%s)",
                message_id,
            )
            existing = await _select_reaction(db, message_id, reactor_jid)
            if existing is None:
                return None
            # `updated_at`'e DOKUNULMAZ: sutunun `onupdate`'i zaten yalnizca
            # UPDATE'te devreye girer; elle None yazmak NOT NULL'i ihlal ederdi.
            existing.emoji = emoji
            existing.from_me = from_me
            await db.flush()
            return existing
        return row
    existing.emoji = emoji
    existing.from_me = from_me
    await db.flush()
    return existing


async def _select_reaction(
    db: AsyncSession, message_id: int, reactor_jid: str
) -> Optional[MessageReaction]:
    return await db.scalar(
        select(MessageReaction).where(
            MessageReaction.message_id == message_id,
            MessageReaction.reactor_jid == reactor_jid,
        )
    )


async def conversation_reaction(
    db: AsyncSession, conversation_id: int
) -> Optional[Dict[str, Any]]:
    """Tek sohbet icin liste rozeti (en son mesajin en yeni reaksiyonu)."""
    return (await latest_reaction_by_conversation(db, [conversation_id])).get(conversation_id)


def serialize_reaction(row: MessageReaction) -> Dict[str, Any]:
    """Tek bir reaksiyonun istemciye giden sekli."""
    return {
        "message_id": row.message_id,
        "emoji": row.emoji,
        "from_me": bool(row.from_me),
        "reactor_jid": row.reactor_jid,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def list_reactions_for_message(db: AsyncSession, message_id: int) -> List[Dict[str, Any]]:
    """Tek mesajin reaksiyonlari (en eski once — rozet sirasi kararli kalsin)."""
    rows = (
        await db.execute(
            select(MessageReaction)
            .where(MessageReaction.message_id == message_id)
            .order_by(MessageReaction.created_at.asc(), MessageReaction.id.asc())
        )
    ).scalars().all()
    return [serialize_reaction(r) for r in rows if r.emoji]


async def reactions_by_message(
    db: AsyncSession, message_ids: Iterable[int]
) -> Dict[int, List[Dict[str, Any]]]:
    """Bir sayfa mesaj icin reaksiyonlari TEK sorguda toplar.

    Geri cekilmis reaksiyonlar (`emoji == ""`) satirda kalir — tekillik
    indeksinin yarisi kaybetmemesi icin — ama istemciye hic gonderilmez.
    """
    ids = [int(m) for m in message_ids]
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(MessageReaction)
            .where(MessageReaction.message_id.in_(ids))
            .order_by(MessageReaction.created_at.asc(), MessageReaction.id.asc())
        )
    ).scalars().all()
    out: Dict[int, List[Dict[str, Any]]] = {}
    for row in rows:
        if not row.emoji:
            continue
        out.setdefault(row.message_id, []).append(serialize_reaction(row))
    return out


async def latest_reaction_by_conversation(
    db: AsyncSession, conversation_ids: Iterable[int]
) -> Dict[int, Dict[str, Any]]:
    """Sohbet listesi icin her sohbetin en SON mesaj uzerindeki en yeni reaksiyonu.

    Sohbet listesinde WhatsApp son mesaja birakilan ifadeyi gosterir; daha eski
    bir mesaja birakilan ifade listede gorunmemelidir. Bu kapi sorgunun kendisinde
    kurulur (join'in alt sorgusu), yorumda degil — "son mesaj" bilgisi
    `conversations` tablosunda ayri bir sutun olarak TUTULMAZ, `MAX(messages.id)`
    ile hesaplanir; boylece mesaj silindiginde/birlesme oldugunda bayat bir
    kimlige gore yanlis rozet gostermeyiz.
    """
    from backend.app.models.message import Message

    ids = [int(c) for c in conversation_ids]
    if not ids:
        return {}
    newest = (
        select(Message.conversation_id.label("conversation_id"), func.max(Message.id).label("last_id"))
        .where(Message.conversation_id.in_(ids))
        .group_by(Message.conversation_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(MessageReaction)
            .join(
                newest,
                (newest.c.conversation_id == MessageReaction.conversation_id)
                & (newest.c.last_id == MessageReaction.message_id),
            )
            .where(MessageReaction.emoji != "")
            .order_by(MessageReaction.updated_at.desc(), MessageReaction.id.desc())
        )
    ).scalars().all()
    out: Dict[int, Dict[str, Any]] = {}
    for reaction in rows:
        # Ayni mesaja birden fazla kisi ifade biraktiysa listede EN YENISI gorunur
        # (WhatsApp davranisi); sira `updated_at DESC` ile zaten kuruldu.
        out.setdefault(reaction.conversation_id, serialize_reaction(reaction))
    return out


def reaction_summary(reaction: Optional[Dict[str, Any]]) -> Optional[str]:
    """Liste satirinda gosterilecek kisa etiket."""
    if not reaction or not reaction.get("emoji"):
        return None
    return reaction["emoji"]
