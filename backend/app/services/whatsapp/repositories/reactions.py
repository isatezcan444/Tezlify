"""Mesaj reaksiyonlari icin okuma/yazma yardimcilari.

Neden ayri dosya: reaksiyonlar mesajin PARCASI degil, mesaj hakkinda ayri bir
ifadedir. Okuma yollari da bu yuzden ayri: bir sayfa mesaj cekildiginde
reaksiyonlar TOPLU olarak alinir (mesaj basina sorgu = N+1), ki 50 mesajlik bir
thread 50 ek sorgu uretmesin.
"""

import inspect
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
    clean_reactor = str(reactor_jid or "").strip()
    if not clean_reactor:
        if from_me:
            clean_reactor = SELF_REACTOR_JID
        else:
            return None
    reactor_jid = clean_reactor

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
    # Mesajlar on-demand ya da geri doldurma ile tersten yazilabildigi icin
    # salt MAX(Message.id) kullanilmaz; gercek kronolojik en yeni mesaj secilir.
    msg_rank = (
        select(
            Message.id.label("msg_id"),
            Message.conversation_id.label("conversation_id"),
            func.row_number()
            .over(
                partition_by=Message.conversation_id,
                order_by=[
                    func.coalesce(Message.external_timestamp, Message.created_at).desc(),
                    Message.id.desc(),
                ],
            )
            .label("rn"),
        )
        .where(Message.conversation_id.in_(ids))
        .subquery()
    )
    newest = (
        select(msg_rank.c.conversation_id, msg_rank.c.msg_id.label("last_id"))
        .where(msg_rank.c.rn == 1)
        .subquery()
    )
    rows = []
    try:
        exec_res = await db.execute(
            select(MessageReaction)
            .join(
                newest,
                (newest.c.conversation_id == MessageReaction.conversation_id)
                & (newest.c.last_id == MessageReaction.message_id),
            )
            .where(MessageReaction.emoji != "")
            .order_by(MessageReaction.updated_at.desc(), MessageReaction.id.desc())
        )
        if hasattr(exec_res, "scalars"):
            sc = exec_res.scalars
            if callable(sc):
                sc = sc()
            if inspect.iscoroutine(sc):
                sc = await sc
            if hasattr(sc, "all"):
                res_all = sc.all
                if callable(res_all):
                    res_all = res_all()
                if inspect.iscoroutine(res_all):
                    rows = await res_all
                elif isinstance(res_all, (list, tuple)):
                    rows = res_all
    except Exception as exc:
        logger.debug("latest_reaction_by_conversation sorgusu atlandi: %s", exc)
        return {}

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


async def batch_resolve_reactor_names(
    db: AsyncSession,
    user_id: Optional[str],
    reactor_jids: Iterable[str],
) -> Dict[str, str]:
    """Grup reaksiyonlarinda reaksiyonu birakan kisi adini WhatsApp Web paritesiyle cozer.
    
    1. LID olanlar (@lid) whatsapp_private.lid_mappings uzerinden telefon numarasina cevrilir.
    2. Elde edilen telefon numaralari contacts tablosunda aranir.
    3. Rehberdeki display_name (ornegin 'Filiz Ablam') veya push_name / formatli telefon doner.
    """
    clean_jids = list(dict.fromkeys(
        str(j).strip() for j in reactor_jids
        if j and str(j).strip() not in (SELF_REACTOR_JID, "None", "null")
    ))
    if not clean_jids or not user_id:
        return {}

    from backend.app.services.whatsapp.identity import (
        jid_to_phone,
        is_phone_like,
        is_raw_jid_name,
        format_phone_spaces,
    )
    from backend.app.services.whatsapp.repositories.lid_mappings import resolve_lid_phones
    from backend.app.models.contact import Contact
    from backend.app.core.auth import get_user_filter

    lids = [j for j in clean_jids if "@lid" in j]
    lid_to_pn: Dict[str, str] = {}
    if lids:
        try:
            lid_to_pn = await resolve_lid_phones(db, lids, user_id=user_id)
        except Exception as lid_err:
            logger.debug("Reaktor LID cozumleme atlandi: %s", lid_err)
            lid_to_pn = {}

    jid_to_target_phone: Dict[str, str] = {}
    search_phones: set[str] = set()

    for jid in clean_jids:
        pn_jid = lid_to_pn.get(jid) if "@lid" in jid else jid
        phone = jid_to_phone(pn_jid)
        if phone:
            jid_to_target_phone[jid] = phone
            search_phones.add(phone)
        elif "@" not in jid and jid.isdigit():
            norm_phone = f"+{jid}"
            jid_to_target_phone[jid] = norm_phone
            search_phones.add(norm_phone)

    contacts_by_phone: Dict[str, Contact] = {}
    if search_phones:
        try:
            c_res = await db.execute(
                select(Contact).where(
                    get_user_filter(Contact.user_id, user_id),
                    Contact.phone_e164.in_(list(search_phones)),
                )
            )
            for c in c_res.scalars().all():
                if c.phone_e164:
                    contacts_by_phone[c.phone_e164] = c
        except Exception as c_err:
            logger.debug("Reaktor contact sorgusu atlandi: %s", c_err)

    out: Dict[str, str] = {}
    for jid in clean_jids:
        phone = jid_to_target_phone.get(jid)
        c = contacts_by_phone.get(phone) if phone else None
        if c:
            disp = getattr(c, "display_name", None)
            if disp and not is_phone_like(disp) and not is_raw_jid_name(disp) and str(disp).strip():
                out[jid] = str(disp).strip()
                continue
            attrs = getattr(c, "custom_attributes", None) or {}
            push = attrs.get("push_name") if isinstance(attrs, dict) else None
            if push and not is_phone_like(push) and not is_raw_jid_name(push) and str(push).strip():
                out[jid] = str(push).strip()
                continue
            if phone:
                out[jid] = format_phone_spaces(phone)
                continue
        elif phone:
            out[jid] = format_phone_spaces(phone)
            continue
    return out


async def resolve_reactor_display_name(
    db: AsyncSession,
    user_id: Optional[str],
    reactor_jid: Optional[str],
) -> Optional[str]:
    """Tekil reaktor kimligini ada cevirir."""
    if not reactor_jid or not user_id:
        return None
    names = await batch_resolve_reactor_names(db, user_id, [reactor_jid])
    return names.get(str(reactor_jid).strip())

