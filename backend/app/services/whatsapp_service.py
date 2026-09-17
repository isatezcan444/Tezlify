"""WhatsApp gateway - veri katmani orkestrasyonu.

WhatsApp UI, gateway (transport) + FastAPI DB (tek dogruluk kaynagi)
arasinda koprulenir: ic mesajlar contacts/conversations/messages
tablolarina kalici yazilir; frontend her zaman sayisal DB kimlikleriyle
konusur. Gateway olaylari (/ws/gateway) bu servis araciligiyla persist
edilir ve broadcast icin sayisal kimliklere cevrilir.
"""
import asyncio
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, FrozenSet, List, Optional, Set, Tuple

from sqlalchemy import select, func, or_, and_, delete, text, insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, contains_eager

from backend.app.core.database import AsyncSessionLocal
from backend.app.core.auth import get_user_filter
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.lead import Lead
from backend.app.models.message import Message, MessageDirection, MessageType, ConversationMessageStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp_profiling import profiled

logger = logging.getLogger(__name__)


from backend.app.services.whatsapp.exceptions import (
    EventOwnerUnresolved,
    NoWhatsAppSession,
    WhatsAppRelinkRequired,
)
from backend.app.services.whatsapp.repositories.contacts import (
    get_contact_avatar as _get_contact_avatar,
    set_contact_avatar as _set_contact_avatar,
    set_contact_name as _set_contact_name,
)
from backend.app.services.whatsapp.repositories.conversations import (
    apply_conversation_last_message as _apply_last_message,
    find_whatsapp_conversation as _find_whatsapp_conversation,
    get_conversation_by_id as _get_conversation_or_404,
    get_conversation_scope_filters as _conversation_scope_filters,
    resolve_conversation_jid as _resolve_jid,
)
from backend.app.services.whatsapp.repositories.messages import (
    build_message_from_gateway as _message_row_from_gateway,
    get_sync_watermark_epoch as _sync_watermark_epoch,
    hydration_cursor_ms as _hydration_cursor_ms,
    message_exists_by_wa_id,
    msg_time as _msg_time,
    msg_time_col as _msg_time_col,
)
from backend.app.services.whatsapp.repositories.sessions import (
    conversation_gateway_id as _conversation_gateway_id,
    conversation_session as _conversation_session,
    get_session_by_id as _get_session_or_404,
    get_user_sessions as _user_sessions,
    require_user_session as _require_user_session,
    resolve_event_owner as _resolve_event_owner,
    resolve_event_owner_and_session as _resolve_event_owner_and_session,
    resolve_event_session_id as _resolve_event_session_id,
)
from backend.app.services.whatsapp.gateway import (
    classify_gateway_error,
    extract_live_session_fields,
    extract_pairing_code,
    extract_send_result,
    extract_session_id,
    is_gateway_session_missing,
)
from backend.app.services.whatsapp.orchestration.sessions import (
    _apply_gateway_live,
    _gateway_op_or_mark_relink,
    _list_sessions_internal,
    _session_dict,
    create_session,
    delete_session as _orchestrated_delete_session,
    get_session_qr,
    list_sessions,
    logout_session,
    purge_whatsapp_data,
    refresh_session_qr,
    request_pairing_code,
)

_is_gateway_session_missing = is_gateway_session_missing


_conversation_locks: Dict[Tuple[str, int], asyncio.Lock] = {}
_in_flight_history_fetches: Dict[Tuple[int, Optional[int]], asyncio.Future] = {}


def _get_conversation_lock(user_id: str, conversation_id: int) -> asyncio.Lock:
    key = (str(user_id), int(conversation_id))
    lock = _conversation_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _conversation_locks[key] = lock
    return lock


# ---------------------------------------------------------------------------
# Yardimcilar
# ---------------------------------------------------------------------------

from backend.app.services.whatsapp.identity import (
    NAME_RANK as _NAME_RANK,
    contact_phone_for_jid as _contact_phone_for_jid,
    is_broadcast_only_jid,
    is_degenerate_jid,
    is_phone_like as _is_phone_like,
    is_raw_jid_name as _is_raw_jid_name,
    jid_to_phone,
    phone_to_jid,
    safe_display_name as _safe_display_name,
)



# _set_contact_name is imported from backend.app.services.whatsapp.repositories.contacts


import sys

# Messaging Orchestration (Phase 11.9)
from backend.app.services.whatsapp.orchestration.messaging import (
    WhatsAppMessagingOrchestrator,
    _serialize_message,
    get_media_bytes as _messaging_get_media_bytes,
    mark_conversation_read as _messaging_mark_conversation_read,
    send_media_message as _messaging_send_media_message,
    send_text_message as _messaging_send_text_message,
    send_typing as _messaging_send_typing,
    serialize_message,
)

_messaging_orchestrator = WhatsAppMessagingOrchestrator(service=sys.modules[__name__])







from backend.app.services.whatsapp.status_policy import (
    advance_message_status as _advance_message_status,
    parse_session_status as _parse_status,
)


from backend.app.services.whatsapp.preview_normalization import (
    BRACKET_TYPE_RE as _BRACKET_TYPE_RE,
    TYPE_PREVIEW_LABELS as _TYPE_PREVIEW_LABELS,
    as_naive_utc as _as_naive_utc,
    build_last_message_summary,
    normalize_preview_text as _normalize_preview_text,
    parse_dt as _parse_dt,
    should_apply_last_message,
)


# _apply_last_message is imported from backend.app.services.whatsapp.repositories.conversations (as apply_conversation_last_message)



# Session orchestration functions (_apply_gateway_live, _gateway_op_or_mark_relink,
# _list_sessions_internal, list_sessions) are imported from
# backend.app.services.whatsapp.orchestration.sessions


async def get_sync_status(db: AsyncSession, user_id: str) -> Dict[str, Any]:
    """Oturumlarin GERCEK senkron durumunu dondurur (QR sonrasi initial sync).

    Kaynak: gateway bellegindeki sync durumu (session_sync_* olaylariyla ayni).
    Gateway'e ulasilamazsa `gateway_available=False` + phase `unavailable`
    doner — hata MASKELENMEZ ve "senkron yok" (idle) ile KARISTIRILAMAZ.
    (Onceki surum hatayi yutup her seyi 'idle' gosteriyordu; docstring
    'fail-closed' diyordu ama kod bunu yapmiyordu.)
    """
    sessions, gateway_error = await _list_sessions_internal(db, user_id)
    if gateway_error:
        return {
            "gateway_available": False,
            "gateway_error": gateway_error,
            "sessions": [
                {
                    "id": s["id"],
                    "session_name": s["session_name"],
                    "status": s["status"],
                    "sync": {"phase": "unavailable", "progress": 0},
                }
                for s in sessions
            ],
        }
    active = [s for s in sessions if s["status"] == "CONNECTED"] or sessions
    return {
        "gateway_available": True,
        "sessions": [
            {
                "id": s["id"],
                "session_name": s["session_name"],
                "status": s["status"],
                "sync": s.get("sync", {"phase": "idle", "progress": 0}),
            }
            for s in active
        ],
    }


# Session orchestration functions (create_session, get_session_qr, refresh_session_qr,
# request_pairing_code, logout_session, purge_whatsapp_data) are imported from
# backend.app.services.whatsapp.orchestration.sessions


async def delete_session(db: AsyncSession, user_id: str, session_id: int) -> Dict[str, Any]:
    return await _orchestrated_delete_session(
        db, user_id, session_id, on_cancel_sync=_cancel_stale_sync_jobs
    )
# ---------------------------------------------------------------------------
# Kisiler (contacts)
# ---------------------------------------------------------------------------

# _set_contact_avatar and _get_contact_avatar are imported from backend.app.services.whatsapp.repositories.contacts


async def sync_contacts(
    db: AsyncSession, user_id: str, session: Optional[WhatsAppSession] = None
) -> List[Dict[str, Any]]:
    # Faz 6 (N+1 kaldirma): kisi basina SELECT+flush yerine TEK SELECT + tek
    # flush — 197 kisilik rehberde ~394 sorgu -> 2 sorgu. Semantik korunur
    # (dejenere JID kapisi, oncelikli ad cozumu, avatar, commit).
    # Rehber, kullanicinin KENDI hattindan okunur (sahiplik kapisi).
    row = session or await _require_user_session(db, user_id)
    gw_contacts = await _gateway_op_or_mark_relink(db, row, lambda gid: gw.list_contacts(gid))
    if not isinstance(gw_contacts, list):
        gw_contacts = []
    items = [
        (
            item.get("id"),
            item.get("name") or item.get("notify") or None,
            item.get("name_source"),
            item.get("avatar_url"),
        )
        for item in gw_contacts
        if item.get("id")
    ]
    resolved = await _bulk_upsert_contacts(db, user_id, items)
    out = [
        {
            "id": jid_str,
            "phone": contact.phone_e164,
            "name": contact.display_name,
            "avatar_url": _get_contact_avatar(contact),
        }
        for jid_str, contact in resolved
    ]
    await db.commit()
    return out



async def _bulk_upsert_contacts(
    db: AsyncSession,
    user_id: str,
    items: List[Tuple[str, Optional[str], Optional[str], Optional[str]]],
) -> List[Tuple[str, Contact]]:
    """(jid, name, name_source, avatar) listesini TOPLU upsert eder (N+1 yok).

    Kisi basina SELECT+INSERT/UPDATE yerine 1 SELECT + tek flush: 197 kisilik
    rehberde 394 sorgu -> 2 sorgu (prod Postgres'te ~55s -> ~2s, Faz 6).
    Semantik `_upsert_contact` ile birebir aynidir: dejenere JID atlanir,
    `jid:` sentinel + legacy '+rakam' tasima, oncelik cozulumlu ad, avatar.
    Doner: (jid_str, Contact) — yeni kisi flush sonrasi id'lidir.
    """
    resolved: List[Tuple[str, str, Optional[str], Optional[str], Optional[str]]] = []
    for jid, name, source, avatar in items:
        jid_str = str(jid)
        if is_degenerate_jid(jid_str):  # §5/§24: '+0' kisi uretilmez
            continue
        # Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
        # kisileri uretilmez.
        if is_broadcast_only_jid(jid_str):
            continue
        resolved.append((jid_str, _contact_phone_for_jid(jid_str), name, source, avatar))
    if not resolved:
        return []
    phones: Set[str] = set()
    for jid_str, phone, _n, _s, _a in resolved:
        phones.add(phone)
        if phone.startswith("jid:"):
            legacy = jid_to_phone(jid_str)
            if legacy:
                phones.add(legacy)
    res = await db.execute(
        select(Contact).where(
            Contact.phone_e164.in_(sorted(phones)),
            get_user_filter(Contact.user_id, user_id),
        )
    )
    by_phone: Dict[str, Contact] = {}
    for c in res.scalars().all():
        by_phone.setdefault(str(c.phone_e164), c)
    out: List[Tuple[str, Contact]] = []
    pending_contacts: List[Contact] = []
    for jid_str, phone, name, source, avatar in resolved:
        contact = by_phone.get(phone)
        if contact is None and phone.startswith("jid:"):
            # Eski kayitlar: grup JID'i yanlislikla "+rakam" gibi saklanmis olabilir.
            legacy = jid_to_phone(jid_str)
            if legacy:
                contact = by_phone.get(legacy)
                if contact is not None:
                    contact.phone_e164 = phone
        if contact is None:
            contact = Contact(
                user_id=user_id,
                phone_e164=phone,
                # Faz 7: ham jid/lid asla display_name olmaz — isim yoksa None.
                display_name=(None if _is_raw_jid_name(name) else name) or jid_to_phone(jid_str),
            )
            if name and str(source or "") in _NAME_RANK:
                contact.custom_attributes = {"name_source": str(source)}
            by_phone[phone] = contact
            # Add only after the SAVEPOINT is opened below. SQLAlchemy flushes
            # pending objects when entering begin_nested(); adding here would
            # execute the INSERT outside the savepoint and poison the session
            # on a concurrent uq_contact_user_phone race.
            pending_contacts.append(contact)
        else:
            _set_contact_name(contact, name, source)
        _set_contact_avatar(contact, avatar)
        out.append((jid_str, contact))
    try:
        async with db.begin_nested():
            for contact in pending_contacts:
                db.add(contact)
            await db.flush()
    except IntegrityError:
        # Es zamanli diger transaction veya gateway olayi (orn: conversation_updated)
        # ayni kisiyi olusturdu. Guncel satirlari DB'den yeniden cekip birlestir.
        res = await db.execute(
            select(Contact).where(
                Contact.phone_e164.in_(sorted(phones)),
                get_user_filter(Contact.user_id, user_id),
            )
        )
        for c in res.scalars().all():
            by_phone[str(c.phone_e164)] = c
        out = []
        for jid_str, phone, name, source, avatar in resolved:
            contact = by_phone.get(phone)
            if contact is not None:
                _set_contact_name(contact, name, source)
                _set_contact_avatar(contact, avatar)
                out.append((jid_str, contact))
        await db.flush()
    return out


async def _ensure_conversations_bulk(
    db: AsyncSession, user_id: str, contacts: List[Tuple[str, Contact]],
    session_id: Optional[int] = None,
) -> List[Tuple[str, Contact, Conversation]]:
    """Kisi listesi icin WhatsApp conversation satirlarini TOPLU garanti eder.

    `_ensure_conversation` ile ayni semantik (yoksa ACTIVE + last_message_at
    tohumlanmaz — Faz 10 RC-1 korumasi), ama sohbet basina 2 sorgu yerine
    1 SELECT + tek flush (Faz 7).
    """
    contact_ids = [c.id for _jid, c in contacts if c.id is not None]
    by_contact: Dict[int, Conversation] = {}
    if contact_ids:
        filters = [
            Conversation.contact_id.in_(contact_ids),
            Conversation.channel == "WHATSAPP",
            get_user_filter(Conversation.user_id, user_id),
        ]
        # A contact can legitimately have one conversation per connected
        # WhatsApp line. Never reuse another line's conversation when the
        # event carries a concrete backend session id.
        if session_id is not None:
            filters.append(Conversation.session_id == session_id)
        res = await db.execute(
            select(Conversation).where(*filters).order_by(Conversation.id.asc())
        )
        for conv in res.scalars().all():
            by_contact.setdefault(int(conv.contact_id), conv)
        if session_id is not None:
            missing_ids = [cid for cid in contact_ids if cid not in by_contact]
            if missing_ids:
                legacy_res = await db.execute(
                    select(Conversation).where(
                        Conversation.contact_id.in_(missing_ids),
                        Conversation.channel == "WHATSAPP",
                        Conversation.session_id.is_(None),
                        get_user_filter(Conversation.user_id, user_id),
                    )
                )
                legacy_by_contact: Dict[int, List[Conversation]] = {}
                for conv in legacy_res.scalars().all():
                    legacy_by_contact.setdefault(int(conv.contact_id), []).append(conv)
                for cid, candidates in legacy_by_contact.items():
                    if len(candidates) == 1:
                        candidates[0].session_id = session_id
                        by_contact[cid] = candidates[0]
                    elif len(candidates) > 1:
                        logger.warning(
                            "Legacy line-less sohbetler belirsiz; yeni line sohbeti olusturulacak (user=%s,contact=%s,count=%s)",
                            user_id,
                            cid,
                            len(candidates),
                        )
    out: List[Tuple[str, Contact, Conversation]] = []
    pending_conversations: List[Conversation] = []
    for jid_str, contact in contacts:
        conv = by_contact.get(contact.id) if contact.id is not None else None
        if conv is None:
            conv = Conversation(
                user_id=user_id,
                contact_id=contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                # Sohbetin geldigi hat: gonderim yonlendirmesi + hat bazli temizlik.
                session_id=session_id,
                last_message_preview=None,
                # Sorun 4: grup bayragi JID'den kalici yazilir (@g.us).
                is_group="@g.us" in jid_str,
                is_archived=False,
                # Faz 10 (P2, RC-1): olustururken utcnow() ile GELECEK timestamp
                # tohumlanmaz — ozet yalnizca gercek mesaj verisiyle dolar.
                last_message_at=None,
            )
            if contact.id is not None:
                by_contact[contact.id] = conv
            # Keep the INSERT inside the savepoint; begin_nested() performs an
            # unconditional flush on entry and must not see this object before
            # the savepoint exists.
            pending_conversations.append(conv)
        elif session_id is not None and conv.session_id is None:
            # Eski (hat bagi olmayan) satiri ilk gorulen hatta bagla.
            conv.session_id = session_id
        out.append((jid_str, contact, conv))
    try:
        async with db.begin_nested():
            for conv in pending_conversations:
                db.add(conv)
            await db.flush()
    except IntegrityError:
        # Es zamanli diger islem sohbeti olusturdu. DB'den yeniden cek.
        filters = [
            Conversation.contact_id.in_(contact_ids),
            Conversation.channel == "WHATSAPP",
            get_user_filter(Conversation.user_id, user_id),
        ]
        if session_id is not None:
            filters.append(Conversation.session_id == session_id)
        res = await db.execute(
            select(Conversation).where(*filters).order_by(Conversation.id.asc())
        )
        for c_row in res.scalars().all():
            by_contact[int(c_row.contact_id)] = c_row
        out = []
        for jid_str, contact in contacts:
            conv = by_contact.get(contact.id)
            if conv is not None:
                if session_id is not None and conv.session_id is None:
                    conv.session_id = session_id
                out.append((jid_str, contact, conv))
        await db.flush()
    return out


async def _upsert_contact(
    db: AsyncSession,
    user_id: str,
    jid: str,
    display_name: Optional[str],
    name_source: Optional[str] = None,
) -> Contact:
    # Faz 9 (§5, RC-2): dejenere JID'lerden (`0@s.whatsapp.net`) contact
    # ÜRETİLMEZ — '+0' contact'in kaynağı buydu. Çağıran katmanlar
    # (sync/ingest) bu hatayı yakalayıp kaydı atlar.
    if is_degenerate_jid(jid):
        raise ValueError(f"Degenerate WhatsApp JID reddedildi: {jid}")
    # Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
    # JID'lerinden contact/conversation uretilmez — WhatsApp Web paritesi.
    if is_broadcast_only_jid(jid):
        raise ValueError(f"Broadcast-only WhatsApp JID reddedildi: {jid}")
    phone_e164 = _contact_phone_for_jid(jid)
    stmt = select(Contact).where(
        Contact.phone_e164 == phone_e164,
        get_user_filter(Contact.user_id, user_id),
    )
    res = await db.execute(stmt)
    # `.first()`: tekillik artik UNIQUE kisitla garanti, ancak kisit
    # olusturulmadan once yazilmis eski mukerrer satirlar `scalar_one_or_none()`
    # ile MultipleResultsFound firlatip ingest'i (ve gercek mesaji) dusuruyordu.
    contact = res.scalars().first()
    if contact is None and phone_e164.startswith("jid:"):
        # Eski kayitlar: grup JID'i yanlislikla "+rakam" telefon gibi saklanmis
        # olabilir (jid_to_phone rakamlari topluyordu). Bulursak sentinel'e tasi.
        legacy = jid_to_phone(jid)
        if legacy:
            lres = await db.execute(
                select(Contact).where(
                    Contact.phone_e164 == legacy,
                    get_user_filter(Contact.user_id, user_id),
                )
            )
            contact = lres.scalars().first()
            if contact is not None:
                contact.phone_e164 = phone_e164
                await db.flush()
    if not contact:
        contact = Contact(
            user_id=user_id,
            phone_e164=phone_e164,
            # Faz 7: ham jid/lid asla display_name olmaz — isim yoksa None
            # birakilir; UI normalize telefon/guvenli fallback gosterir.
            display_name=(None if _is_raw_jid_name(display_name) else display_name) or jid_to_phone(jid),
        )
        if display_name and str(name_source or "") in _NAME_RANK:
            contact.custom_attributes = {"name_source": str(name_source)}
        try:
            async with db.begin_nested():
                # `begin_nested()` flushes pending state on entry. Registering
                # the candidate inside the context guarantees a concurrent
                # unique-key violation is contained by the SAVEPOINT.
                db.add(contact)
                await db.flush()
        except IntegrityError:
            # Es zamanli ikinci yazici ayni kisiyi araya girip olusturdu
            # (UNIQUE kisit). Savepoint geri alindi; KAZANAN satiri al ve kullan.
            res = await db.execute(stmt)
            contact = res.scalars().first()
            if contact is None:
                raise
            if _set_contact_name(contact, display_name, name_source):
                await db.flush()
    else:
        if _set_contact_name(contact, display_name, name_source):
            await db.flush()
    return contact


# ---------------------------------------------------------------------------
# Sohbetler (conversations)
# ---------------------------------------------------------------------------

# _conversation_scope_filters is imported from backend.app.services.whatsapp.repositories.conversations

async def _ensure_conversation(
    db: AsyncSession, user_id: str, jid: str, preview: Optional[str] = None,
    session_id: Optional[int] = None,
    contact_name: Optional[str] = None,
    contact_source: Optional[str] = None,
) -> Conversation:
    contact = await _upsert_contact(db, user_id, jid, contact_name, contact_source)
    filters = _conversation_scope_filters(user_id, contact.id, session_id)
    stmt = select(Conversation).where(*filters).order_by(Conversation.id.asc())
    res = await db.execute(stmt)
    matching = list(res.scalars().all())
    conv = matching[0] if matching else None
    if len(matching) > 1:
        logger.warning(
            "Birden fazla ayni hat sohbeti bulundu; deterministik ilk kayit kullaniliyor (user=%s,contact=%s,session=%s,count=%s)",
            user_id,
            contact.id,
            session_id,
            len(matching),
        )
    if conv is None and session_id is not None:
        legacy_res = await db.execute(
            select(Conversation).where(
                Conversation.contact_id == contact.id,
                Conversation.channel == "WHATSAPP",
                Conversation.session_id.is_(None),
                get_user_filter(Conversation.user_id, user_id),
            ).order_by(Conversation.id.asc())
        )
        legacy_rows = list(legacy_res.scalars().all())
        if len(legacy_rows) == 1:
            conv = legacy_rows[0]
            conv.session_id = session_id
            await db.flush()
        elif len(legacy_rows) > 1:
            raise EventOwnerUnresolved(
                f"Birden fazla legacy line-siz sohbet eslenemedi (contact={contact.id})"
            )
    if not conv:
        conv = Conversation(
            user_id=user_id,
            contact_id=contact.id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
            # Sohbetin geldigi hat (gateway oturumu).
            session_id=session_id,
            last_message_preview=preview,
            # Sorun 4: grup bayragi JID'den kalici yazilir (@g.us).
            is_group="@g.us" in jid,
            is_archived=False,
            # Faz 10 (P2, RC-1): olustururken utcnow() ile GELECEK timestamp
            # tohumlanmaz — gecmis mesajlarin hicbiri "daha yeni" olamaz ve
            # preview hicbir zaman yazilamazdi (prod'da 18 sohbetin 100
            # mesajli olmasina ragmen preview'i NULL kalmisti). Ozet artık
            # yalnizca gercek mesaj verisiyle _apply_last_message üzerinden
            # doldurulur; sohbetler last_message_at NULL olanlari liste
            # sonunda konumlandirir (nullslast).
            last_message_at=None,
        )
        db.add(conv)
        await db.flush()
    elif session_id is not None and conv.session_id is None:
        conv.session_id = session_id
    conv._contact = contact
    return conv


async def _ensure_conversation_race_safe(
    db: AsyncSession, owner: str, jid_str: str, event: Dict[str, Any],
    session_id: Optional[int] = None,
    contact_name: Optional[str] = None,
    contact_source: Optional[str] = None,
) -> Conversation:
    """`_ensure_conversation` + es-zamanli silme yarisi korumasi.

    Prod (production log, 19:08:52): `DELETE /sessions/28` purge'u (98 mesaj /
    116 sohbet / 116 kisi silindi) ile `conversation_updated` ingest'i
    yaristi — purge, contact SELECT'i ile conversation INSERT'i arasina
    girip contact satirini sildi ve `conversations_contact_id_fkey`
    ihlaliyle ingest EXCEPTION + dev traceback ile dustu.

    Tekrar denemeden once tx rollback edilir ve sahip YENIDEN cozulur:
    oturum da silinmisse `EventOwnerUnresolved` yukselir ve olay duser —
    silinen veri diriltilmez (WhatsApp Web'de hat silinince diyaloglar
    geri gelmez). Oturum duruyorsa (es-zamanli cift-ingest unique
    yarisi) ikinci deneme basarir — gercek mesaj kaybolmaz.
    """
    extra_kw: Dict[str, Any] = {}
    if contact_name is not None:
        extra_kw["contact_name"] = contact_name
    if contact_source is not None:
        extra_kw["contact_source"] = contact_source
    try:
        return await _ensure_conversation(
            db, owner, jid_str, session_id=session_id, **extra_kw,
        )
    except IntegrityError:
        await db.rollback()
        fresh_owner = await _resolve_event_owner(db, jid_str, event.get("gateway_session_id"))
        event["user_id"] = fresh_owner
        return await _ensure_conversation(
            db, fresh_owner, jid_str, session_id=session_id, **extra_kw,
        )


# _message_row_from_gateway is imported from backend.app.services.whatsapp.repositories.messages (as build_message_from_gateway)


async def _persist_gateway_message(db: AsyncSession, owner: str, msg: Dict[str, Any]) -> bool:
    """Gateway mesaj kaydini (history sync veya sync sirasinda cekilen) DB'ye yazar.

    wa_message_id ile dedup eder; yeni satir yazildiysa True doner.
    """
    jid = msg.get("conversation_id")
    if not jid or "@" not in str(jid):
        return False
    jid_str = str(jid)
    # Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
    # mesajlari kalici yazilmaz.
    if is_broadcast_only_jid(jid_str):
        return False
    wa_id = msg.get("wa_message_id")
    conv = await _ensure_conversation_race_safe(db, owner, jid_str, msg)
    if wa_id and await message_exists_by_wa_id(db, conv.id, wa_id):
        return False  # dedup
    row = _message_row_from_gateway(owner, conv, msg)
    if row is None:
        return False
    ts = _as_naive_utc(_parse_dt(msg.get("created_at")))
    db.add(row)
    # Faz 10 (P2): paylasilan son-mesaj kurali — tip etiketi, grup gonderen
    # on eki ve ZAMAN DAMGASI siralamasi tek kaynaktan.
    summary = build_last_message_summary(
        message_type=row.message_type.value,
        body=row.body,
        sender_name=row.sender_name,
        is_group="@g.us" in jid_str,
        direction=row.direction.value,
    )
    _apply_last_message(conv, ts, summary)
    await db.flush()
    return True


async def _repair_last_message_previews(db: AsyncSession, user_id: str) -> int:
    """Faz 10 (P2): eksik/bozuk son-mesaj ozetlerini messages tablosundan onarir.

    Senkron bittikten sonra calisir; henuz ozeti bos olan ya da eski
    placeholder tarzi ('[IMAGE]' vb.) yazilmis sohbetler icin en yeni mesaji
    (ZAMAN DAMGASI sirasiyla — ekleme sirasi degil) bulur ve paylasilan
    kurala gore ozeti yazar. Iki toplu sorgu kullanilir — sohbet basina
    sorgu (N+1) YOKTUR. Doner: duzeltilen sohbet sayisi.
    """
    cand_res = await db.execute(
        select(Conversation, Contact.phone_e164)
        .join(Contact, Contact.id == Conversation.contact_id, isouter=True)
        .where(
            get_user_filter(Conversation.user_id, user_id),
            Conversation.channel == "WHATSAPP",
            or_(
                Conversation.last_message_preview.is_(None),
                func.trim(Conversation.last_message_preview) == "",
                Conversation.last_message_preview.like("[%"),
            ),
        )
    )
    candidates = cand_res.fetchall()
    if not candidates:
        return 0
    conv_ids = [row[0].id for row in candidates]
    # Bu sohbetlerin TÜM mesajlarını tek sorguda çek, Python'da zaman damgasına
    # göre en yeniyi seç (postgres + sqlite testleri için dialect-bağımsız).
    msg_res = await db.execute(
        select(Message).where(Message.conversation_id.in_(conv_ids))
    )
    by_conv: Dict[int, List[Message]] = {}
    for m in msg_res.scalars().all():
        by_conv.setdefault(m.conversation_id, []).append(m)
    fixed = 0
    for conv, phone in candidates:
        msgs = by_conv.get(conv.id) or []
        if not msgs:
            continue  # gercekten mesajsiz — onarilacak bir sey yok
        newest = max(
            msgs,
            key=lambda m: _as_naive_utc(_msg_time(m)) or datetime.min,
        )
        mtype = newest.message_type.value if hasattr(newest.message_type, "value") else str(newest.message_type or "TEXT")
        summary = build_last_message_summary(
            message_type=mtype,
            body=newest.body,
            sender_name=newest.sender_name,
            is_group=bool(phone and "@g.us" in phone),
            direction=newest.direction.value if hasattr(newest.direction, "value") else str(newest.direction),
        )
        if not summary:
            continue
        # Zehirli (utcnow tohumlu) last_message_at'i de gercek mesaja cevir.
        conv.last_message_preview = summary[:500]
        ts = _as_naive_utc(newest.external_timestamp or newest.sent_at or newest.created_at)
        if ts is not None:
            conv.last_message_at = ts
        fixed += 1
    if fixed:
        await db.flush()
        logger.info("Faz 10 preview onarimi: %d sohbet guncellendi (owner=%s)", fixed, user_id)
    return fixed


# Faz 8 (§16/§20): owner bazında tek paylaşılmış senkron hattı — initial-sync
# background task'ı, manuel "Eşitle" butonu ve endpoint çağrıları AYNI
# sync_conversations kodunu kullanır; aynı owner için ikinci bir çağrı
# gateway'e ikinci bir istek fırtınası yaratmaz (in-flight dedupe), mevcut
# DB anlık görüntüsünü döner.
_sync_conversations_inflight: Set[str] = set()


async def sync_conversations(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """LEGACY senkron hatti (chat basina gateway round-trip + tek commit).

    Yeni mimaride HTTP yolu bu fonksiyonu KULLANMAZ: `request_sync` WS tabanli
    chunked job'i tetikler (§15/§16). Bu hatti yalnizca gateway'de bulk kanali
    (`/messages/bulk`) yoksa job icinden fail-soft fallback olarak ve servis
    testleri icin korunur.
    """
    if user_id in _sync_conversations_inflight:
        result, _total = await list_conversations(db, user_id)
        return result
    _sync_conversations_inflight.add(user_id)
    try:
        return await _sync_conversations_impl(db, user_id)
    finally:
        _sync_conversations_inflight.discard(user_id)


async def _sync_conversations_impl(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    # Faz 7: "Eşitle" = tam yenileme — once telefon rehberini (W:Contact
    # app-state + history kisi kayitlari) DB'ye hydrate et; boylece hic
    # sohbeti olmayan kisilerin rehber adlari da kalici olur ve identity
    # cozumleme sohbet listesinde dogru ad uretir.
    session_row = await _require_user_session(db, user_id)
    gateway_id = str(session_row.gateway_id)
    try:
        await sync_contacts(db, user_id, session=session_row)
    except WhatsAppRelinkRequired:
        raise
    except Exception as exc:
        logger.warning("Rehber senkronu atlandi (sohbet senkronu suruyor): %s", exc)
    try:
        await _gateway_op_or_mark_relink(
            db, session_row, lambda gid: gw.sync_group_subjects(gid, force=True)
        )
    except WhatsAppRelinkRequired:
        raise
    except Exception as exc:
        logger.warning("Grup basliklari senkronu atlandi: %s", exc)
    data = await _gateway_op_or_mark_relink(
        db, session_row, lambda gid: gw.list_conversations(gid)
    )
    items = data.get("items", []) if isinstance(data, dict) else []
    owner = user_id
    for item in items:
        jid = item.get("jid") or item.get("id")
        if not jid or "@" not in str(jid):
            continue
        jid_str = str(jid)
        # Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
        # sohbetleri DB'ye yazilmaz — WhatsApp Web paritesi.
        if is_broadcast_only_jid(jid_str):
            continue
        # Faz 9 (§5): dejenere JID sohbetleri (`0@s.whatsapp.net`) DB'ye yazilmaz.
        if is_degenerate_jid(jid_str):
            continue
        preview_raw = item.get("last_message_preview") or ""
        # Sohbet adini (history sync'ten gelir) contact'a tasi — oncelik
        # cozulumu _set_contact_name icinde (rehber adi > push > telefon).
        chat_name = item.get("name")
        contact = await _upsert_contact(db, user_id, jid_str, chat_name, item.get("name_source"))
        # Faz 5: sohbet avatarunu (profil/grup resmi) contact'a tasi.
        _set_contact_avatar(contact, item.get("avatar_url"))
        stmt = select(Conversation).where(
            Conversation.contact_id == contact.id,
            Conversation.channel == "WHATSAPP",
            Conversation.session_id == session_row.id,
            get_user_filter(Conversation.user_id, user_id),
        ).order_by(Conversation.id.asc())
        res = await db.execute(stmt)
        matches = list(res.scalars().all())
        conv = matches[0] if matches else None
        if len(matches) > 1:
            logger.warning(
                "Sohbet senkronunda duplicate satir; ilk kayit kullaniliyor (user=%s,contact=%s,session=%s,count=%s)",
                user_id,
                contact.id,
                session_row.id,
                len(matches),
            )
        if conv is None:
            conv = await _ensure_conversation(db, user_id, jid_str, session_id=session_row.id)
        # Faz 4: sohbet gecmisini de cek (history sync gateway belleğinde tuttu).
        # Faz 10 (P2): gecmis ONCE çekilir ki paylasilan zaman-damgali kural
        # en yeni mesajı dogru secsin; gateway'in sohbet bazli preview'i
        # (medyada bos/eksik olabilir) yalnizca zaman damgasi daha yeni ise
        # ve normalize edilmis metin uretiyorsa uygulanir.
        try:
            # Sorun 1: legacy yolda sohbet basina tam gecmis yerine en yeni
            # _SYNC_PER_CHAT_LIMIT mesaj cekilir (bulk kanal yoksa bile
            # initial-sync maliyeti sinirli kalir; gecmis lazy hydration ile).
            msg_data = await gw.get_messages(gateway_id, jid_str, limit=_SYNC_PER_CHAT_LIMIT)
            gw_messages = msg_data.get("messages", []) if isinstance(msg_data, dict) else []
            for gm in gw_messages:
                gm = dict(gm)
                gm.setdefault("conversation_id", jid_str)
                await _persist_gateway_message(db, owner, gm)
        except Exception as exc:
            logger.warning("Sohbet gecmisi cekilemedi (%s): %s", jid_str, exc)
        gw_ts = _as_naive_utc(_parse_dt(str(item.get("last_message_at")))) if item.get("last_message_at") else None
        gw_summary = _normalize_preview_text(item.get("message_type") or "TEXT", preview_raw)
        if gw_summary:
            # Eski zehirli degerler (utcnow tohumlu last_message_at) düzeltilsin
            # diye gateway preview'i kendi zaman damgasiyla uygulariz;
            # conv.last_message_at gateway'den yeni ise kural zaten yazar.
            # Sorun 5: `gw_ts or utcnow()` UYDURMASI kaldirildi — gercek
            # zaman damgasi yoksa "simdi" yazmak sohbeti gelecege kilitler ve
            # sonraki gercek mesajlar (daha eski ts) ozeti bir daha asla
            # guncelleyemezdi. ts None ise _apply_last_message yalnizca ozeti
            # yazar (realtime semantigi), timestamp uydurulmaz.
            if conv.last_message_at is None or (gw_ts and gw_ts > conv.last_message_at):
                _apply_last_message(conv, gw_ts, gw_summary)
            elif not conv.last_message_preview:
                # Ozet hic yoksa (mesajsiz/eksik hydrate) gateway degeriyle doldur.
                _apply_last_message(conv, None, gw_summary)
        # Sorun 4: grup/arsiv metadata'sini kalici sutunlara yaz (gateway
        # arsiv alanini gondermiyorsa — eski gateway — mevcut deger korunur).
        conv.is_group = bool(item.get("is_group")) or "@g.us" in jid_str
        if "archived" in item:
            conv.is_archived = bool(item.get("archived"))
        unread = int(item.get("unread_count") or 0)
        conv.unread_count = max(conv.unread_count or 0, unread)
        await db.flush()
    # Faz 10 (P2): onarim gecisi — hâlâ ozeti bos/eksik olan sohbetleri,
    # mesaj tablosundan TEK agregat sorguyla (per-chat N+1 yok) hydrates et.
    await _repair_last_message_previews(db, user_id)
    await db.commit()
    result, _total = await list_conversations(db, user_id)
    return result


async def list_conversations(
    db: AsyncSession,
    user_id: str,
    search: Optional[str] = None,
    status: Optional[str] = None,
    unread_only: bool = False,
    group_only: bool = False,
    archived_only: bool = False,
    lead_id: Optional[int] = None,
    conversation_id: Optional[int] = None,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    conv_filter = get_user_filter(Conversation.user_id, user_id)
    base = select(Conversation).where(conv_filter, Conversation.channel == "WHATSAPP")
    # Sorun (prod geri bildirim): daha once `status@broadcast` / `@newsletter`
    # JID'leri contact+conversation olarak KALICI yazilmisti. Yeni ingest
    # filtreleri yenisini engeller ama eski kirli satirlar DB'de durur —
    # bunlar sohbet listesinden dislanir (WhatsApp Web paritesi: Durum ve
    # kanallar sohbet listesinde yer almaz). Join YOK — alt sorgu.
    # Faz 10.12 Rollback Audit: NOT EXISTS query form caused higher planning/exec
    # latency on representative production data (PLANNER_COST_IMPROVEMENT_WITHOUT_RUNTIME_IMPROVEMENT).
    # Reverted to subquery form.
    junk_contacts = select(Contact.id).where(
        or_(
            Contact.phone_e164 == "status",
            Contact.phone_e164 == "broadcast",
            Contact.phone_e164.like("%@broadcast%"),
            Contact.phone_e164.like("%@newsletter%"),
        )
    )
    base = base.where(~Conversation.contact_id.in_(junk_contacts))
    # `Contact` tablosuna katlanma GEREKEN filtreler icin join BIR KEZ yapilir
    # (ayni sorguda iki kez join etmek SQL hatasi uretir).
    joined_contact = False
    # Faz 12: lead -> sohbet cozumlemesi SUNUCU tarafinda. Onceden istemci
    # `limit=200` listesini indirip icinde ariyordu (LeadDetailDrawer'in sohbet
    # sekmesi) — hem agir hem de 200 sohbetten sonra sessizce basarisiz.
    #
    # DIKKAT: `Conversation.lead_id` kolonu var ama bugune kadar hicbir yerde
    # YAZILMIYOR (nullable CRM bagi). Yalnizca o kolonu filtrelemek sessizce HER
    # ZAMAN bos sonuc donerdi (AGENTS.md §1.1: sahte/bos basari yok). Gercek bag
    # TELEFON uzerindendir: `Lead.phone_e164` == `Contact.phone_e164`.
    # Bu yuzden iki yol BIRLIKTE denenir — kayitli CRM bagi VEYA telefon eslesmesi.
    if lead_id is not None:
        lead_phone = await db.scalar(
            select(Lead.phone_e164).where(
                Lead.id == lead_id,
                get_user_filter(Lead.user_id, user_id),
            )
        )
        base = base.join(Contact, Conversation.contact_id == Contact.id)
        joined_contact = True
        lead_match = [Contact.lead_id == lead_id]
        if lead_phone:
            lead_match.append(Contact.phone_e164 == lead_phone)
        base = base.where(or_(*lead_match))
    # Faz 12: tek sohbet cozumlemesi de hedefli sorguyla (200 satirlik liste
    # taramasi yerine) — ayni tenant filtresi.
    if conversation_id is not None:
        base = base.where(Conversation.id == conversation_id)
    if status:
        try:
            base = base.where(Conversation.status == ConversationStatus(status))
        except ValueError:
            logger.warning("Gecersiz WhatsApp conversation status filtresi yok sayildi: %r", status)
    if unread_only:
        base = base.where(Conversation.unread_count > 0)
    # Sorun 4 (Grup/Arsiv sekmeleri): kalici sütunlar üzerinden filtre —
    # `group_only` yalnizca @g.us sohbetleri, `archived_only` WhatsApp'i
    # arsivlenmis (is_archived) VEYA CRM status'u ARCHIVED olan sohbetleri
    # dondurur. Ikisi birden verilirse kesisim (WhatsApp paritesi: "Arsiv"
    # sekmesindeki gruplar hem grup hem arsiv olarak sayilir).
    if group_only:
        base = base.where(Conversation.is_group.is_(True))
    if archived_only:
        base = base.where(
            or_(
                Conversation.is_archived.is_(True),
                Conversation.status == ConversationStatus.ARCHIVED,
            )
        )
    if search:
        like = f"%{search.strip().lower()}%"
        if not joined_contact:
            base = base.join(Contact, Conversation.contact_id == Contact.id)
            joined_contact = True
        base = base.where(
            or_(
                func.lower(Contact.display_name).like(like),
                func.lower(Contact.phone_e164).like(like),
            )
        )

    if conversation_id is not None:
        total = None
    else:
        count_res = await db.execute(select(func.count()).select_from(base.subquery()))
        total = count_res.scalar_one()

    base = base.order_by(Conversation.last_message_at.desc().nullslast()).order_by(Conversation.id.desc())
    if offset:
        base = base.offset(offset)
    if limit:
        base = base.limit(limit)

    if joined_contact:
        base = base.options(contains_eager(Conversation.contact))
    else:
        base = base.options(joinedload(Conversation.contact))

    res = await db.execute(base)
    rows = list(res.scalars().unique().all())

    if total is None:
        total = len(rows)

    contact_ids = [r.contact_id for r in rows if r.contact_id and not r.contact]
    contacts_map: Dict[int, Contact] = {}
    if contact_ids:
        cres = await db.execute(select(Contact).where(Contact.id.in_(contact_ids)))
        contacts_map = {c.id: c for c in cres.scalars().all()}

    # Faz 10 (P2): mesaj sayilari TEK agregat sorguyla — sohbet basina N+1 yok.
    # UI "Henüz WhatsApp Mesajı Yok" metnini yalnizca count==0 ve senkron
    # bittiginde gosterir (last_message_state).
    conv_ids = [r.id for r in rows]
    counts_map: Dict[int, int] = {}
    if conv_ids:
        cnt_res = await db.execute(
            select(Message.conversation_id, func.count())
            .where(Message.conversation_id.in_(conv_ids))
            .group_by(Message.conversation_id)
        )
        counts_map = {cid: int(n) for cid, n in cnt_res.fetchall()}

    out: List[Dict[str, Any]] = []
    for r in rows:
        contact = r.contact or contacts_map.get(r.contact_id)
        phone = contact.phone_e164 if contact else None
        # Faz 10: eski kose-parantezli degerler okuma aninda da etikete
        # normalize edilir ('[IMAGE]' -> '📷 Fotoğraf'); normal metin aynen gecer.
        preview = _normalize_preview_text(None, r.last_message_preview) or None
        msg_count = counts_map.get(r.id, 0)
        if preview:
            lm_state = "RESOLVED"
        elif msg_count == 0:
            lm_state = "NO_MESSAGES"
        else:
            # Mesaj var ama ozet henuz hesaplanmadi (senkron/hydrate sürüyor).
            lm_state = "REPAIRING"
        out.append(
            {
                "id": r.id,
                "session_id": r.session_id,
                "contact_id": r.contact_id,
                "lead_id": r.lead_id,
                # Faz 7: ham jid/lid sizarca UI'a None gonderilir (fallback
                # normalize telefon) — presentation'a internal ID sizmaz.
                "name": _safe_display_name(contact),
                "phone": phone,
                # Sorun 4: kalici `is_group` sütunu esas; eski satirlar
                # (sync oncesinde olusmus) JID sentinel'iyle tamamlanir.
                "is_group": bool(r.is_group) or bool(phone and "@g.us" in phone),
                # WhatsApp arsiv durumu (CRM status'tan bagimsiz, gateway
                # metadata'sindan kalici yazilir).
                "is_archived": bool(r.is_archived),
                "avatar_url": _get_contact_avatar(contact),
                "last_message_preview": preview,
                "last_message_at": r.last_message_at.isoformat() if r.last_message_at else None,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                "message_count": msg_count,
                "last_message_state": lm_state,
                "unread_count": r.unread_count,
                "status": r.status.value if hasattr(r.status, "value") else str(r.status),
            }
        )
    return out, total
# ---------------------------------------------------------------------------
# Mesajlar & gonderme
# ---------------------------------------------------------------------------

# _get_conversation_or_404 and _resolve_jid are imported from backend.app.services.whatsapp.repositories.conversations


async def _hydrate_messages_on_demand(
    db: AsyncSession, owner: str, conv: Conversation, limit: int,
    before_ts_ms: Optional[int] = None,
    oldest_msg_id: Optional[str] = None,
    oldest_msg_from_me: Optional[bool] = None,
) -> List[Message]:
    """P0.11 (WhatsApp Web paritesi): kullanici sohbeti job hydrasyonundan once
    actiysa gateway belleğinden (history-sync'ten beri mevcut) bu sohbetin son
    mesajlarini cek + kalici yaz. Gercek veri, sentez yok. Gateway hatasi
    yukariya tasinir; bos listeye cevrilmez, aksi halde outage "mesaj yok"
    olarak gorunur ve gercek hata maskelenir.

    Sorun 1 (lazy hydration): `before_ts_ms` verildiginde gateway'den bu
    MILAT (ms epoch) tarihinden ESKI mesajlar istenir — initial sync yalnizca
    en yeni ~50 mesaji yazdigi icin, kullanici yukari kaydiridiginda kalan
    gecmis buradan tamamlanir. Kayit id'si history'de messageTimestamp*1000,
    canli akista Date.now() tabanlidir — ikisi de ms kronolojisi oldugu icin
    sucut ayni alanda calisir.
    """
    if not conv.contact_id:
        return []
    cres = await db.execute(select(Contact).where(Contact.id == conv.contact_id))
    contact = cres.scalar_one_or_none()
    if contact is None or not contact.phone_e164:
        return []
    phone = str(contact.phone_e164)
    jid = phone[4:] if phone.startswith("jid:") else phone_to_jid(phone)
    if not jid:
        return []
    try:
        session_row = await _conversation_session(db, owner, conv)
        data = await _gateway_op_or_mark_relink(
            db,
            session_row,
            lambda gid: gw.get_messages(
                gid,
                jid,
                # Preserve the caller's page size.  A hidden minimum of 50 made
                # a request for a small page hydrate far too much history.
                limit=min(max(int(limit), 1), 100),
                before=before_ts_ms,
                fetch_provider=True,
                oldest_msg_id=oldest_msg_id,
                oldest_msg_from_me=oldest_msg_from_me,
                oldest_msg_ts_ms=before_ts_ms,
            ),
        )
    except Exception as exc:  # noqa: BLE001 — operasyonel hata API'ye aktarilir
        logger.warning("On-demand hydrasyon basarisiz (conv=%s): %s", conv.id, exc)
        raise
    if not isinstance(data, dict):
        raise RuntimeError("Gateway returned an invalid messages response.")
    gw_msgs = data.get("messages", [])
    if not isinstance(gw_msgs, list):
        raise RuntimeError("Gateway returned an invalid messages payload.")
    if not gw_msgs:
        return []
    # dedup: mevcut wa_message_id'ler tek SELECT ile.
    res = await db.execute(
        select(Message.wa_message_id).where(
            Message.conversation_id == conv.id, Message.wa_message_id.isnot(None)
        )
    )
    have = {str(r[0]) for r in res.all()}
    rows: List[Message] = []
    for gm in gw_msgs:
        wa = gm.get("wa_message_id")
        if wa and str(wa) in have:
            continue
        row = _message_row_from_gateway(owner, conv, gm)
        if row is None:
            continue
        if wa:
            have.add(str(wa))
        rows.append(row)
    if not rows:
        return []
    # Kronolojik sirala: gateway sayfası asc doner ama dedup/INSERT sonrasi
    # liste sirasi bozulabilir; sucut sonrasi eski+yeni karişik gelebilir.
    rows.sort(key=lambda r: (r.external_timestamp or r.created_at, r.id or 0))
    db.add_all(rows)
    await db.flush()
    # Preview'i da hydrate edilen gercek mesajla guncelle (sohbet listesi tutarli).
    # Sorun 1: eski gecmis hydrasyonunda (before_ts_ms) listedeki EN YENI
    # mesaj esas alinir — _apply_last_message ts-guard'u zaten daha eski
    # degerin mevcut ozeti ezmesini engeller.
    summary_src = rows[-1]
    _apply_last_message(
        conv,
        summary_src.external_timestamp,
        build_last_message_summary(
            message_type=summary_src.message_type.value,
            body=summary_src.body,
            sender_name=summary_src.sender_name,
            is_group="@g.us" in jid,
            direction=summary_src.direction.value,
        ),
    )
    await db.commit()
    return list(reversed(rows))


# _msg_time_col, _msg_time, _hydration_cursor_ms are imported from backend.app.services.whatsapp.repositories.messages


@profiled("chat_open")
async def get_messages(
    db: AsyncSession, user_id: str, conversation_id: int, limit: int = 50, before: Optional[int] = None
) -> Dict[str, Any]:
    conv = await _get_conversation_or_404(db, user_id, conversation_id)
    page_size = min(max(int(limit), 1), 100)
    base = select(Message).where(
        Message.conversation_id == conv.id,
        get_user_filter(Message.user_id, user_id),
    )
    # Sorun 2 + Sorun 1 (zaman-damgali keyset sayfalamasi): `before` frontend
    # sozlesmesi geregi bir mesaj id'sidir, ama KESIM NOKTASI o satirin GERCEK
    # zaman damgasidir. Sebep: initial sync sohbet basina yalnizca en yeni ~50
    # mesaji yazar; kalan gecmis kaydirma sirasinda lazy hydration ile eklenir
    # ve bu eski mesajlar DB'de DAHA BUYUK auto-increment id alir. `id < before`
    # sayfalamasi bunlari gormezden gelir ve kronolojik sayfayi bozardi —
    # zaman-damgasi kesimi + siralamasi bunu duzeltir.
    before_row: Optional[Message] = None
    if before:
        bres = await db.execute(
            select(Message).where(Message.id == before, Message.conversation_id == conv.id)
        )
        before_row = bres.scalars().first()
        cutoff = _msg_time(before_row) if before_row else None
        if cutoff is not None:
            base = base.where(or_(
                _msg_time_col() < cutoff,
                and_(_msg_time_col() == cutoff, Message.id < before_row.id),
            ))
        else:
            # before satiri cozulemedi → bos sayfa (uydurma sucut yok).
            base = base.where(Message.id < before)
    base = base.order_by(_msg_time_col().desc(), Message.id.desc()).limit(page_size)
    res = await db.execute(base)
    rows = list(res.scalars().all())
    # If DB has fewer than page_size rows, check if an in-flight operation is already fetching this page.
    if len(rows) < page_size:
        flight_key = (conv.id, before)
        future = _in_flight_history_fetches.get(flight_key)
        if future is not None:
            await future
            res = await db.execute(base)
            rows = list(res.scalars().all())
        else:
            loop = asyncio.get_running_loop()
            new_future = loop.create_future()
            _in_flight_history_fetches[flight_key] = new_future
            try:
                async with _get_conversation_lock(user_id, conv.id):
                    # Double-check inside lock
                    res = await db.execute(base)
                    rows = list(res.scalars().all())
                    if len(rows) < page_size:
                        if not rows and before is None:
                            older = await _hydrate_messages_on_demand(db, user_id, conv, page_size)
                            if older:
                                res = await db.execute(base)
                                rows = list(res.scalars().all())
                        else:
                            cursor_src = list(rows) + ([before_row] if before_row else [])
                            cursor_ms = _hydration_cursor_ms(cursor_src)
                            anchor = None
                            for r in cursor_src:
                                if r is not None and getattr(r, "wa_message_id", None):
                                    if anchor is None or (_msg_time(r) or datetime.min) < (_msg_time(anchor) or datetime.min):
                                        anchor = r
                            anchor_id = anchor.wa_message_id if anchor else None
                            anchor_from_me = (anchor.direction == MessageDirection.OUTBOUND) if anchor else None
                            if cursor_ms is not None:
                                older = await _hydrate_messages_on_demand(
                                    db,
                                    user_id,
                                    conv,
                                    page_size - len(rows),
                                    before_ts_ms=cursor_ms,
                                    oldest_msg_id=anchor_id,
                                    oldest_msg_from_me=anchor_from_me,
                                )
                                if older:
                                    res = await db.execute(base)
                                    rows = list(res.scalars().all())
                if not new_future.done():
                    new_future.set_result(True)
            except Exception as exc:
                if not new_future.done():
                    new_future.set_exception(exc)
                raise
            finally:
                _in_flight_history_fetches.pop(flight_key, None)

    # Kronolojik cikis siralamasi (eski→yeni)
    rows.sort(key=lambda r: (_msg_time(r) or datetime.min, r.id or 0))

    has_more = False
    if rows:
        if conv.session_id and len(rows) >= page_size:
            has_more = True
        elif not conv.session_id and len(rows) >= page_size:
            oldest_row = rows[0]
            oldest_ts = _msg_time(oldest_row)
            if oldest_ts is not None:
                older_exists = await db.scalar(
                    select(Message.id).where(
                        Message.conversation_id == conv.id,
                        get_user_filter(Message.user_id, user_id),
                        or_(
                            _msg_time_col() < oldest_ts,
                            and_(_msg_time_col() == oldest_ts, Message.id < oldest_row.id),
                        ),
                    ).limit(1)
                )
                has_more = older_exists is not None

    if len(rows) > page_size:
        rows = rows[-page_size:]
    messages = [_serialize_message(r) for r in rows]
    return {
        "messages": messages,
        "has_more": has_more,
        "oldest_message_id": messages[0]["id"] if messages else None,
        "newest_message_id": messages[-1]["id"] if messages else None,
    }




@profiled("send_text")
async def send_text_message(
    db: AsyncSession, user_id: str, conversation_id: int, body: str, client_message_id: Optional[str] = None
) -> Dict[str, Any]:
    return await _messaging_orchestrator.send_text_message(db, user_id, conversation_id, body, client_message_id)


async def send_media_message(
    db: AsyncSession, user_id: str, conversation_id: int, media: Dict[str, Any]
) -> Dict[str, Any]:
    return await _messaging_orchestrator.send_media_message(db, user_id, conversation_id, media)


async def mark_conversation_read(db: AsyncSession, user_id: str, conversation_id: int) -> Dict[str, Any]:
    return await _messaging_orchestrator.mark_conversation_read(db, user_id, conversation_id)


async def send_typing(db: AsyncSession, user_id: str, conversation_id: int, typing: bool = True) -> Dict[str, Any]:
    return await _messaging_orchestrator.send_typing(db, user_id, conversation_id, typing=typing)


async def get_media_bytes(db: AsyncSession, user_id: str, media_id: str) -> Tuple[bytes, Optional[str], Optional[str]]:
    return await _messaging_orchestrator.get_media_bytes(db, user_id, media_id)



# ---------------------------------------------------------------------------
# Initial-sync job mimarisi (HTTP yerine WS tabanli arka plan hydrasyonu)
#
# Eski davranis: GET /conversations?sync=true, 113 chat icin per-chat gateway
# round-trip'ini + tek commit'i HTTP istegi ICINDE beklerdi; proxy
# timeout'u ve Baileys "Timed Out" hatalariyla 502 + retry storm'u uretiyordu
# (olculen kok neden). Yeni davranis: HTTP yalnizca job'i tetikler ve aninda
# DB snapshot'i doner; agir hydrasyon asyncio job'i olarak MEVCUT WebSocket
# uzerinden `whatsapp_sync_*` olaylarina akitor.
#
# Sozlesme (§25/§40): her olay snake_case `event`, job bazinda `sync_id`
# (frontend stale-sync filtresi) ve `user_id` (WS tenant routing) tasir.
# ---------------------------------------------------------------------------

_SYNC_BULK_PAGE_SIZE = 1000   # gateway'den tek istekte cekilen mesaj
_SYNC_PERSIST_BATCH = 200     # dedup-SELECT + INSERT grubu
_SYNC_EVENT_CHUNK = 100       # WS mesaj chunk olayinin ust siniri
_SYNC_CHAT_PAGE_SIZE = 40     # sohbet anlik goruntusu sayfa boyutu

# Sorun 1 (yavas initial sync): bulk kanali her sohbet icin yalnizca EN YENI
# N mesajı ceker (gateway `perChatLimit`). WhatsApp Web'in kendi davranisiyla
# ayni: acilmayan sohbetin tam gecmisi istenmez; daha eskileri kullanici
# yukari kaydiridiginda lazy hydration ile gelir (get_messages/before).
_SYNC_PER_CHAT_LIMIT = 50

# WhatsApp Web paritesi (Faz 17/28): sohbet listesi, Baileys history sync
# SIRASINDA (session_sync_completed'i beklemeden) canli `conversation_updated`
# olaylariyla akmaya baslar. Backend bu akisi owner'in WS'ine 2 sn'de bir
# 'whatsapp_sync_chats_bootstrap' olayiyla sinyaller; frontend bu olayi
# aldiginda DB snapshot'ini GET /conversations ile hemen yukler — UI, job'un
# ~137 sn'lik N+1 fazini beklemez. Sahte veri/atlama YOK: yalnizca GERCEK
# kalici yazilmis sohbetler gosterilir.
_BOOTSTRAP_EMIT_INTERVAL_S = 2.0

_bulk_channel_cache: Dict[str, Any] = {"ok": False, "checked_at": 0.0}

# owner -> son bootstrap yayin zamani (time.monotonic) — throttled akis.
_last_bootstrap_emit: Dict[str, float] = {}


def _schedule_chats_bootstrap(owner: str) -> None:
    """Canli sohbet olayindan sonra (throttled) bootstrap sinyali yayinla.

    Fire-and-forget: hata yayilmaz, zamanlayici varsa ikinci task yok."""
    now = time.monotonic()
    last = _last_bootstrap_emit.get(owner)
    if last is not None and now - last < _BOOTSTRAP_EMIT_INTERVAL_S:
        return
    _last_bootstrap_emit[owner] = now

    async def _emit() -> None:
        await _broadcast_sync_event({
            "event": "whatsapp_sync_chats_bootstrap",
            "sync_id": "live",
            "user_id": owner,
            "at": datetime.now(timezone.utc).isoformat(),
        }, owner)

    try:
        asyncio.get_running_loop().create_task(_emit())
    except RuntimeError:
        pass  # event loop yok (test disi senkron baglam) — sessiz atla


class SyncJob:
    """Tek bir initial-sync calismasi — durum makinesi SYNCING/COMPLETED/FAILED.

    `done` event'i job sonlandiginda set edilir; `sync_conversations` gibi
    HTTP kisa yollari yeni job tetiklemeden mevcut job'i bekleyebilir (§17).
    """

    __slots__ = ("sync_id", "user_id", "state", "stage", "error", "cancel_requested",
                 "chats_total", "chats_synced", "contacts_synced", "messages_total",
                 "messages_synced", "started_at", "finished_at", "done", "task",
                 "stage_timings")

    def __init__(self, sync_id: str, user_id: str) -> None:
        self.sync_id = sync_id
        self.user_id = user_id
        self.state = "SYNCING"
        self.stage = "starting"
        self.error: Optional[str] = None
        self.cancel_requested = False
        self.chats_total = 0
        self.chats_synced = 0
        self.contacts_synced = 0
        self.messages_total = 0
        self.messages_synced = 0
        self.started_at = datetime.now(timezone.utc)
        self.finished_at: Optional[datetime] = None
        self.done = asyncio.Event()
        self.task: Optional[asyncio.Task] = None
        # Faz 6 (P0.1 enstrumantasyon): asama bazinda gecen sure (sn) — benchmark
        # ve raporlama icin gercek olcum; tahmin DEGIL (time.monotonic delta).
        self.stage_timings: Dict[str, float] = {}

    def snapshot(self) -> Dict[str, Any]:
        """GET /sync/job + WS reconnect kurtarmasi icin gercek durum (§28)."""
        return {
            "sync_id": self.sync_id,
            "state": self.state,
            "stage": self.stage,
            "error": self.error,
            "chats_total": self.chats_total,
            "chats_synced": self.chats_synced,
            "contacts_synced": self.contacts_synced,
            "messages_total": self.messages_total,
            "messages_synced": self.messages_synced,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "stage_timings": dict(self.stage_timings),
        }


# owner -> aktif/son job (uvicorn tek is parca calisir — start.py; in-process
# registry yeterli; redeploy'da job duser, frontend GET /sync/job ile gorur).
_sync_jobs: Dict[str, SyncJob] = {}


async def _bulk_channel_available(gateway_id: str) -> bool:
    """Gateway'de `/messages/bulk` kanali var mi (yeni gateway surumu).

    Eski gateway dagitimi 404 donerur; job bu durumda legacy per-chat hattina
    fail-soft duser (hata yayilmaz). Sonuc 5 dk cache'lenir.
    """
    import time as _time

    now = _time.monotonic()
    if now - float(_bulk_channel_cache.get("checked_at") or 0.0) < 300:
        return bool(_bulk_channel_cache.get("ok"))
    try:
        probe = await gw.list_all_messages(gateway_id, limit=1, offset=0)
        ok = isinstance(probe, dict) and "messages" in probe
    except Exception as exc:  # noqa: BLE001 — gateway kapali/eski surum: legacy hat
        ok = False
        logger.warning(
            "WhatsApp bulk mesaj kanali kullanilamiyor; legacy sync fallback (gateway=%s): %s",
            gateway_id, exc,
        )
    _bulk_channel_cache["ok"] = ok
    _bulk_channel_cache["checked_at"] = now
    return ok


async def _broadcast_sync_event(payload: Dict[str, Any], owner: str) -> None:
    """whatsapp_sync_* olayini mevcut ws_manager uzerinden SAHIBINE yollar.

    `owner` ZORUNLU argümandir: hedef tenant cagri aninda acikca verilir,
    payload icindeki `user_id` alanina guvenilmez (Faz 13 tenant izolasyonu).
    Broadcast hatasi job'i dusurmaz — DB gercegi yazilmaya devam eder,
    frontend reconnect'te GET /sync/job ile toparlar (§28).
    """
    try:
        from backend.app.api.v1.websocket import ws_manager
        sent = await ws_manager.broadcast(payload, target_user_id=owner)
        if sent == 0:
            logger.debug(
                "Sync olayi teslim edilecek soket bulamadi (event=%s, owner=%s)",
                payload.get("event"), owner,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Sync olayi yayilamadi (%s): %s", payload.get("event"), exc)


def _sync_event(job: SyncJob, event: str, **fields: Any) -> Dict[str, Any]:
    """Ortak sozlesme: snake_case event + sync_id + user_id + alanlar."""
    return {"event": event, "sync_id": job.sync_id, "user_id": job.user_id, **fields}


async def request_sync(db: AsyncSession, user_id: str) -> SyncJob:
    """Sync job'i tetikle ya da suren job'i dondur (asla ikinci job yok, §17).

    Kisa omurlu: job kaydi olustur + arka plan task'i baslat + aninda don.
    COMPLETED/FAILED job beklenmez — yeni sync_id ile taze job baslar.
    """
    owner = str(user_id)
    job = _sync_jobs.get(owner)
    if job is not None and job.state == "SYNCING":
        return job
    job = SyncJob(sync_id=uuid.uuid4().hex, user_id=owner)
    _sync_jobs[owner] = job
    job.task = asyncio.create_task(_run_sync_job(job))
    return job


def get_sync_job(user_id: str) -> Optional[Dict[str, Any]]:
    """Owner'in mevcut/son job anlik goruntusu (WS reconnect kurtarma, §28)."""
    job = _sync_jobs.get(str(user_id))
    return job.snapshot() if job else None


def _cancel_stale_sync_jobs(user_id: str) -> int:
    """Oturum silinince owner'in suren job'ini iptal eder — eski gateway
    oturumuna karsi istek gondermeye devam etmez (§26/§27)."""
    _initial_sync_pending.discard(str(user_id))
    job = _sync_jobs.get(str(user_id))
    if job is None or job.state != "SYNCING":
        return 0
    job.cancel_requested = True
    return 1


async def _reapply_chat_names(
    db: AsyncSession, owner: str, items: List[Dict[str, Any]]
) -> None:
    """Faz 6 (P0.3 sonrasi): sohbet-listesi adlarini REHBER fazindan SONRA
    yeniden otoriter kilar.

    Eski sirada (contacts -> chats) sohbet adi son yazan oldugu icin tie-break'ta
    kazanirdi — WhatsApp Web paritesi: gateway sohbet adini contact-store ile
    merge ederek uretir, canli ortamda iki kaynak ayni ad/rutbeyi tasir. Yeni
    sirada (chats -> contacts) tie-break tersine donup rehber mock/eski adini
    sohbet adinin uzerine yazabiliyor; tek SELECT'lik bu onarim ad semantigini
    SIRADAN BAGIMSIZ hale getirir. Dusuk rutbeli ad yuksek rutbeliyi asla ezmez
    (_set_contact_name korumasi) — addressbook > chat-gorunen ad kirilmaz.
    """
    named = [
        (str(item.get("jid") or item.get("id")), item.get("name"), item.get("name_source"))
        for item in items
        if (item.get("jid") or item.get("id")) and item.get("name")
    ]
    if not named:
        return
    phones = {
        _contact_phone_for_jid(j) for j, _n, _s in named if not is_degenerate_jid(j)
    }
    if not phones:
        return
    res = await db.execute(
        select(Contact).where(
            Contact.phone_e164.in_(sorted(phones)),
            get_user_filter(Contact.user_id, owner),
        )
    )
    by_phone: Dict[str, Contact] = {}
    for c in res.scalars().all():
        by_phone.setdefault(str(c.phone_e164), c)
    changed = False
    for jid_str, name, source in named:
        if is_degenerate_jid(jid_str):
            continue
        contact = by_phone.get(_contact_phone_for_jid(jid_str))
        if contact is not None and _set_contact_name(contact, name, source):
            changed = True
    if changed:
        await db.commit()


_metadata_tasks: Dict[str, asyncio.Task[None]] = {}


def _schedule_metadata_enrichment(gateway_id: str) -> None:
    """Optional provider I/O owns no sync transaction and never delays messages."""
    if gateway_id in _metadata_tasks:
        return

    async def enrich() -> None:
        try:
            await gw.sync_group_subjects(gateway_id, force=True)
        except Exception as exc:
            logger.warning("Background group enrichment failed (session=%s): %s", gateway_id, exc)
        finally:
            _metadata_tasks.pop(gateway_id, None)

    _metadata_tasks[gateway_id] = asyncio.create_task(enrich())


@profiled("initial_sync")
async def _run_sync_job(job: SyncJob) -> None:
    """Chunked initial-sync hatti — WS olaylariyla ilerler, HTTP'yi bloklamaz.

    Faz 6 (P0.3) — SOHBETLER İLK: chats snapshot artik rehber/mesaj fazlarindan
    ONCE yayinlanir; kullanici sohbete job basladiktan saniyeler sonra baslar,
    rehber adlari + mesajlar arka planda tamamlanir (WhatsApp Web sirasi).
    Akis: started -> grup basliklari -> chats snapshot -> contacts -> mesajlar
    (tek bulk fetch, sayfali) -> onarim + complete/failed.
    Chat basina gateway cagrisi YOK (§21); her fazin gercek suresi
    stage_timings'e yazilir (P0.1).
    """
    owner = job.user_id
    try:
        async with AsyncSessionLocal() as db:
            await _broadcast_sync_event(_sync_event(job, "whatsapp_sync_started", started_at=job.started_at.isoformat()), owner)
            phase_t0 = time.monotonic()

            def _mark_phase(name: str) -> None:
                nonlocal phase_t0
                now = time.monotonic()
                job.stage_timings[name] = round(job.stage_timings.get(name, 0.0) + (now - phase_t0), 3)
                phase_t0 = now

            # Hangi hatlar senkronlanacak? YALNIZCA bu kullanicinin BAGLI
            # hatlari (sahiplik kapisi). Birden fazla hat varsa her biri kendi
            # kapsaminda sirayla senkronlanir — "bagli olan tek oturumu sec"
            # tahmini YOK.
            sessions_to_sync = await _user_sessions(db, owner, connected_only=True)
            if not sessions_to_sync:
                raise NoWhatsAppSession(
                    "Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin."
                )

            all_items: List[Dict[str, Any]] = []
            conv_out: List[Dict[str, Any]] = []
            jid_by_conv: Dict[int, str] = {}
            contacts: List[Dict[str, Any]] = []

            for ws_session in sessions_to_sync:
                gateway_id = str(ws_session.gateway_id)

                # 2) Sohbet anlik goruntusu — chat BASINA gateway istegi YOK (§21);
                #    chats listesi tek cagri, DB'ye bir geciste TOPLU yazilir (Faz 7).
                job.stage = "chats"
                data = await _gateway_op_or_mark_relink(
                    db, ws_session, lambda gid: gw.list_conversations(gid)
                )
                items = data.get("items", []) if isinstance(data, dict) else []
                all_items.extend(items)
                session_convs, session_jids = await _persist_chat_snapshot(
                    db, owner, items, session_id=ws_session.id
                )
                conv_out.extend(session_convs)
                jid_by_conv.update(session_jids)
                job.chats_total = len(conv_out)
                job.chats_synced = len(conv_out)
                if job.cancel_requested:
                    raise asyncio.CancelledError()
                for page_start in range(0, len(session_convs), _SYNC_CHAT_PAGE_SIZE):
                    await _broadcast_sync_event(_sync_event(
                        job, "whatsapp_sync_chats_snapshot",
                        total=job.chats_total,
                        conversations=session_convs[page_start:page_start + _SYNC_CHAT_PAGE_SIZE]), owner)
                _mark_phase("chats")

                # Optional names must not delay the first persisted, usable snapshot.
                # Gateway metadata events enrich the already published conversations.
                _schedule_metadata_enrichment(gateway_id)
                _mark_phase("group_subjects")

                # 3) Rehber (fail-soft — sohbetler artik gorunur, ad
                #    zenginlestirmesi arka planda tamamlanir).
                job.stage = "contacts"
                try:
                    session_contacts = await sync_contacts(db, owner, session=ws_session)
                    contacts.extend(session_contacts)
                    job.contacts_synced = len(contacts)
                except WhatsAppRelinkRequired:
                    raise
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Sync job rehber adimi atlandi (owner=%s hat=%s): %s", owner, ws_session.id, exc)
                if job.cancel_requested:
                    raise asyncio.CancelledError()
                await _broadcast_sync_event(_sync_event(
                    job, "whatsapp_sync_contacts_snapshot",
                    total=job.contacts_synced, contacts=contacts[:_SYNC_EVENT_CHUNK]), owner)
                _mark_phase("contacts")

                # 3b) Ad otoritesini geri ver (P0.3 tie-break onarimi, tek SELECT):
                #     sohbet-listesi adlari rehber fazindan bagimsiz olarak kazanir —
                #     WhatsApp Web'de kullaniciyin gordugu ad budur.
                try:
                    await _reapply_chat_names(db, owner, items)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Sync job ad onarimi atlandi (owner=%s): %s", owner, exc)

                # 4) Mesajlar — TEK bulk kanaldan, bellek-ici offset sayfalamasi
                #    (§21: per-chat HTTP yok; §23: mesaj basina sorgu yok; Faz 8:
                #    dedup kumesi sayfalar arasi onbelleklenir).
                job.stage = "messages"
                if await _bulk_channel_available(gateway_id):
                    await _run_bulk_message_sync(db, job, session_jids, gateway_id, ws_session=ws_session)
                else:
                    # Eski gateway dagitimi: legacy per-chat hatti (fail-soft).
                    logger.warning("Gateway bulk kanali yok — legacy per-chat sync (owner=%s)", owner)
                    await _sync_conversations_impl(db, owner)
                if job.cancel_requested:
                    raise asyncio.CancelledError()
                _mark_phase("messages")

            items = all_items

            # 5) Onarim + tamamlanma — preview'i eksik sohbetleri tek agregat
            #    sorguyla hydrate et, sonra cozulmus tam listeyi yayinla.
            job.stage = "finalizing"
            await _repair_last_message_previews(db, owner)
            await db.commit()
            result, _total = await list_conversations(db, owner)
            _mark_phase("finalizing")
            job.state = "COMPLETED"
            job.stage = "complete"
            job.finished_at = datetime.now(timezone.utc)
            await _broadcast_sync_event(_sync_event(
                job, "whatsapp_sync_complete",
                conversations=result,
                chats_synced=job.chats_synced,
                contacts_synced=job.contacts_synced,
                messages_synced=job.messages_synced,
                finished_at=job.finished_at.isoformat(),
                stage_timings=dict(job.stage_timings),
                duration_s=round((job.finished_at - job.started_at).total_seconds(), 3),
            ), owner)
            logger.info(
                "Sync job tamamlandi (owner=%s sync_id=%s chats=%s msgs=%s sure=%ss fazlar=%s)",
                owner, job.sync_id, job.chats_synced, job.messages_synced,
                round((job.finished_at - job.started_at).total_seconds(), 1),
                job.stage_timings,
            )
            # Trigger progressive background history expansion without blocking realtime or UI
            asyncio.create_task(_run_background_history_expansion(owner, gateway_id))
    except WhatsAppRelinkRequired as exc:
        job.state = "FAILED"
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        logger.warning(
            "Sync job oturum kayip - yeniden eslestirme gerekli (owner=%s sync_id=%s): %s",
            owner, job.sync_id, exc,
        )
        await _broadcast_sync_event(_sync_event(
            job, "whatsapp_sync_failed", error=job.error, error_code="RELINK_REQUIRED", stage=job.stage), owner)
    except asyncio.CancelledError:
        job.state = "FAILED"
        job.error = "sync iptal edildi"
        job.finished_at = datetime.now(timezone.utc)
        logger.info("Sync job iptal edildi (owner=%s sync_id=%s)", owner, job.sync_id)
        # Faz 13: iptal de UI'a BILDIRILIR. Onceden yalnizca state degisiyordu;
        # frontend `whatsapp_sync_failed` olayi gelmedigi icin banner'i
        # "senkron surüyor" durumunda takili kaliyordu (sessiz basarisizlik).
        await _broadcast_sync_event(_sync_event(
            job, "whatsapp_sync_failed", error=job.error, stage=job.stage), owner)
    except Exception as exc:  # noqa: BLE001 — fail-closed: hatayi UI'a bildir
        job.state = "FAILED"
        job.error = str(exc)[:500]
        job.finished_at = datetime.now(timezone.utc)
        logger.warning("Sync job basarisiz (owner=%s sync_id=%s): %s", owner, job.sync_id, exc)
        err_code = "RELINK_REQUIRED" if _is_gateway_session_missing(exc) else None
        sync_payload = _sync_event(job, "whatsapp_sync_failed", error=job.error, stage=job.stage)
        if err_code:
            sync_payload["error_code"] = err_code
        await _broadcast_sync_event(sync_payload, owner)
    finally:
        job.done.set()
        # NOT: `_initial_sync_inflight` buradan temizlenmez — o set
        # `_run_initial_sync`'e aittir. Bu job `request_sync` ile tetiklendi
        # ve erken temizlik ikinci bir initial-sync'in ayni anda baslamasina
        # (cift bulk sync + DB yarisina) yol aciyordu: senkron hata ile
        # kesilip job FAILED oluyordu (WhatsApp Web'de history sync tektir).


async def _persist_chat_snapshot(
    db: AsyncSession, owner: str, items: List[Dict[str, Any]],
    session_id: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], Dict[int, str]]:
    """Gateway chats listesini TOPLU geciste DB'ye yazar (Faz 7: N+1 yok).

    Eski yol sohbet basina `_upsert_contact` + `_ensure_conversation`
    (2 SELECT + flush) calistiriyordu — 113 sohbette prod Postgres'te ~81s.
    Yeni yol: tek `_bulk_upsert_contacts` + tek `_ensure_conversations_bulk`
    (2 SELECT + 2 flush) + tek commit. Semantik birebir korunur: dejenere JID
    kapisi, oncelikli ad cozumu, avatar, ts-guard'lu preview, unread max.

    Doner: (list_conversations formatinda sohbet serisi — ham WhatsApp
    nesnesi DEGIL, sayisal DB kimlikli, §30; conversation_id -> ham jid haritasi
    — jid yalnizca backend icinde kalir, frontend'e sizmaz).
    """
    candidates: List[Dict[str, Any]] = []
    for item in items:
        jid = item.get("jid") or item.get("id")
        if not jid or "@" not in str(jid):
            continue
        if is_degenerate_jid(str(jid)):  # §5/§24: '+0' sohbeti DB'ye yazilmaz
            continue
        # WhatsApp Web paritesi: Durum (`status@broadcast`) / kanal
        # (`@newsletter`) sohbet listesinde YER ALMAZ — snapshot'a girmez.
        # (Alt katman `_bulk_upsert_contacts` zaten filtreler; bu, adim
        # girisinde ikinci savunma hattidir.)
        if is_broadcast_only_jid(str(jid)):
            continue
        candidates.append(item)
    contacts = await _bulk_upsert_contacts(
        db, owner,
        [
            (str(item.get("jid") or item.get("id")), item.get("name"),
             item.get("name_source"), item.get("avatar_url"))
            for item in candidates
        ],
    )
    item_by_jid: Dict[str, Dict[str, Any]] = {
        str(item.get("jid") or item.get("id")): item for item in candidates
    }
    triples = await _ensure_conversations_bulk(db, owner, contacts, session_id=session_id)
    out: List[Dict[str, Any]] = []
    jid_by_conv: Dict[int, str] = {}
    for jid_str, contact, conv in triples:
        item = item_by_jid.get(jid_str)
        if item is None:
            continue
        gw_ts = _as_naive_utc(_parse_dt(str(item.get("last_message_at")))) if item.get("last_message_at") else None
        gw_summary = _normalize_preview_text(item.get("message_type") or "TEXT", item.get("last_message_preview") or "")
        if gw_summary:
            # Sorun 5: `gw_ts or utcnow()` uydurmasi kaldirildi (bkz.
            # sync_conversations ayisi) — gercek olmayan zaman damgasi
            # sohbeti gelecege kilitler, toplu senkrondaki bayat ozet daha
            # yeni gercek mesajlarin uzerine yazilmaz.
            if conv.last_message_at is None or (gw_ts and gw_ts > conv.last_message_at):
                _apply_last_message(conv, gw_ts, gw_summary)
            elif not conv.last_message_preview:
                _apply_last_message(conv, None, gw_summary)
        # Sorun 4: Baileys sohbet metadata'sini (grup/arsiv) kalici yaz.
        conv.is_group = bool(item.get("is_group")) or "@g.us" in jid_str
        if "archived" in item:
            conv.is_archived = bool(item.get("archived"))
        conv.unread_count = max(conv.unread_count or 0, int(item.get("unread_count") or 0))
        jid_by_conv[conv.id] = jid_str
        out.append(
            {
                "id": conv.id,
                "session_id": conv.session_id,
                "contact_id": contact.id,
                "lead_id": conv.lead_id,
                "name": _safe_display_name(contact),
                "phone": contact.phone_e164,
                "is_group": "@g.us" in jid_str,
                "is_archived": bool(conv.is_archived),
                "avatar_url": _get_contact_avatar(contact),
                "last_message_preview": gw_summary or None,
                "last_message_at": gw_ts.isoformat() if gw_ts else None,
                "created_at": conv.created_at.isoformat() if conv.created_at else None,
                "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
                "message_count": 0,
                "last_message_state": "RESOLVED" if gw_summary else "REPAIRING",
                "unread_count": conv.unread_count,
                "status": conv.status.value if hasattr(conv.status, "value") else str(conv.status),
            }
        )
    await db.commit()
    return out, jid_by_conv


# _sync_watermark_epoch is imported from backend.app.services.whatsapp.repositories.messages


async def _run_bulk_message_sync(
    db: AsyncSession,
    job: SyncJob,
    jid_by_conv: Dict[int, str],
    gateway_id: str,
    ws_session: Optional[WhatsAppSession] = None,
) -> None:
    """Bulk mesaj kanalindan sayfali hydrasyon.

    Bellek-ici (jid -> conv) haritasi + sohbet gruplu TEK dedup SELECT
    (wa_message_id) + gruplu INSERT + ~100'luk WS chunk olaylari. Kismi
    ilerleme commit'lenir — job yarida olse yazilanlar korunur (§20).
    """
    conv_by_jid: Dict[str, int] = {}
    for cid, jid_str in jid_by_conv.items():
        conv_by_jid[jid_str] = cid
    conv_by_id: Dict[int, Conversation] = {}
    # Faz 8 (N+1 kaldirma): dedup kumesi SAYFALAR ARASI onbelleklenir. Eski yol
    # her sayfada deginen sohbetlerin TAM wa_message_id listesini yeniden
    # SELECT'liyordu — 5 sayfa x 16k mesaj = ~42s. On bellekte, her sohbet yalnizca
    # ILK deginisinde bir kez yuklenir; bu job'in kendisinin ekledigi id'ler zaten
    # `have`'a eklendigi icin tutarlilik korunur.
    existing_ids: Dict[int, Set[str]] = {}
    dedup_loaded: Set[int] = set()

    # Faz 6 (P0.13 delta sync): GERCEK suuc — bu kullanicinin DB'sindeki en son
    # bilinen mesaj zamani (external_timestamp MAX). Varsa gateway'den yalnizca
    # (suuc - 5 dk overlap) sonrasi istenir; boylece reconnect sonrasi ayni
    # gecmis tekrar tekrar cekilmez. Overlap + wa_message_id dedup'u, sinirdaki
    # mesajlarin kaybolmasini onler. Ilk senkronda suuc yok → tam cekim.
    since_epoch = await _sync_watermark_epoch(db, job.user_id)

    offset = 0
    first_page = True
    while True:
        if ws_session is not None:
            page = await _gateway_op_or_mark_relink(
                db,
                ws_session,
                lambda gid: gw.list_all_messages(
                    gid,
                    limit=_SYNC_BULK_PAGE_SIZE,
                    offset=offset,
                    since=since_epoch,
                    per_chat_limit=_SYNC_PER_CHAT_LIMIT,
                ),
            )
        else:
            page = await gw.list_all_messages(
                gateway_id,
                limit=_SYNC_BULK_PAGE_SIZE,
                offset=offset,
                since=since_epoch,
                per_chat_limit=_SYNC_PER_CHAT_LIMIT,
            )
        msgs = page.get("messages", []) if isinstance(page, dict) else []
        total = int(page.get("total") or 0) if isinstance(page, dict) else 0
        if first_page:
            job.messages_total = total
            first_page = False
        if not msgs:
            break
        # jid -> conversation cozumu (yalnizca snapshot'taki sohbetler).
        pending: Dict[int, List[Dict[str, Any]]] = {}
        for gm in msgs:
            jid_str = str(gm.get("conversation_id") or "")
            cid = conv_by_jid.get(jid_str)
            if cid is None:
                continue
            pending.setdefault(cid, []).append(gm)
        # dedup: ilk temasda sohbet bazinda mevcut wa_message_id'leri toplu SELECT ile cek (§23).
        cid_list = [cid for cid in pending.keys() if cid not in dedup_loaded]
        for batch_start in range(0, len(cid_list), _SYNC_PERSIST_BATCH):
            sub = cid_list[batch_start:batch_start + _SYNC_PERSIST_BATCH]
            res = await db.execute(
                select(Message.conversation_id, Message.wa_message_id).where(
                    Message.conversation_id.in_(sub),
                    Message.wa_message_id.isnot(None),
                )
            )
            for cid, wa in res.all():
                existing_ids.setdefault(int(cid), set()).add(str(wa))
        dedup_loaded.update(pending.keys())
        missing_conversations = [cid for cid in pending if cid not in conv_by_id]
        for batch_start in range(0, len(missing_conversations), _SYNC_PERSIST_BATCH):
            batch = missing_conversations[batch_start:batch_start + _SYNC_PERSIST_BATCH]
            loaded = await db.execute(select(Conversation).where(
                Conversation.id.in_(batch),
                get_user_filter(Conversation.user_id, job.user_id),
            ))
            conv_by_id.update({conv.id: conv for conv in loaded.scalars().all()})
        rows: List[Tuple[Message, Dict[str, Any]]] = []  # (satır, jid_str) — serialization flush sonrası
        touched: Set[int] = set()
        for cid, gm_list in pending.items():
            conv = conv_by_id.get(cid)
            if conv is None:
                continue
            have = existing_ids.setdefault(cid, set())
            for gm in gm_list:
                wa = gm.get("wa_message_id")
                if wa and str(wa) in have:
                    continue
                row = _message_row_from_gateway(job.user_id, conv, gm)
                if row is None:
                    continue
                if wa:
                    have.add(str(wa))
                rows.append((row, str(gm.get("conversation_id") or "")))
                summary = build_last_message_summary(
                    message_type=row.message_type.value,
                    body=row.body,
                    sender_name=row.sender_name,
                    is_group="@g.us" in str(gm.get("conversation_id") or ""),
                    direction=row.direction.value,
                )
                _apply_last_message(conv, _parse_dt(gm.get("created_at")), summary)
            touched.add(cid)
        # persist: gruplu INSERT + commit (kismi ilerleme kalici).
        serialized: List[Dict[str, Any]] = []
        if rows:
            persisted_rows: List[Message] = []
            for batch_start in range(0, len(rows), _SYNC_PERSIST_BATCH):
                values = [
                    {column.name: getattr(row, column.name)
                     for column in Message.__table__.columns
                     if column.name != "id" and getattr(row, column.name) is not None}
                    for row, _ in rows[batch_start:batch_start + _SYNC_PERSIST_BATCH]
                ]
                inserted = await db.scalars(insert(Message).returning(Message), values)
                persisted_rows.extend(inserted.all())
            await db.flush()
            await db.commit()
            # flush sonrasi id'ler doludur — WS chunk'i sayisal DB kimlikli seridir.
            serialized = [_serialize_message(r) for r in persisted_rows]
            job.messages_synced += len(rows)
        for chunk_start in range(0, len(serialized), _SYNC_EVENT_CHUNK):
            await _broadcast_sync_event(_sync_event(
                job, "whatsapp_sync_messages_chunk",
                conversation_ids=sorted(touched),
                messages=serialized[chunk_start:chunk_start + _SYNC_EVENT_CHUNK],
                total=job.messages_total,
                synced=job.messages_synced,
            ), job.user_id)
        await _broadcast_sync_event(_sync_event(
            job, "whatsapp_sync_progress",
            stage=job.stage,
            chats_total=job.chats_total, chats_synced=job.chats_synced,
            contacts_synced=job.contacts_synced,
            messages_total=job.messages_total, messages_synced=job.messages_synced,
        ), job.user_id)
        offset += len(msgs)
        if offset >= total:
            break
        if job.cancel_requested:
            raise asyncio.CancelledError()


# ---------------------------------------------------------------------------
# Gateway olaylarini veritabanina isleme (inbound)
# ---------------------------------------------------------------------------

# Faz 8 (§16): initial-sync sonrasi DB hydrate eden paylasilmis pipeline —
# owner bazinda in-flight dedupe (ayni kullanici icin ikinci bir hydration
# tetiklenmez; "Eşitle" butonu da ayni sync_conversations'i kullanir).
_initial_sync_inflight: Set[str] = set()
_initial_sync_pending: Set[str] = set()


def _schedule_initial_sync(owner: str, *, reconcile: bool = False) -> None:
    """Coalesce data notifications; duplicate connection signals only join."""
    if owner in _initial_sync_inflight:
        if reconcile:
            _initial_sync_pending.add(owner)
        return
    _initial_sync_inflight.add(owner)
    asyncio.create_task(_run_initial_sync(owner))


async def _run_initial_sync(owner: str) -> None:
    # Faz 8 (§16) sozlesmesi korunur: initial-sync, "Eşitle" ile AYNI pipeline'i
    # kullanir — artik bu, WS tabanli chunked sync job'i (`request_sync`).
    # HTTP 502/timeout storm'u yerine agirlik arka planda `whatsapp_sync_*`
    # olaylariyla akitor; `conversations_updated` eski UI sozlesmesi olarak
    # tamamlanmada yayinlanmaya devam eder (§25 kirilmaz).
    try:
        async with AsyncSessionLocal() as db:
            job = await request_sync(db, owner)
            await asyncio.shield(job.done.wait())
        if job.state == "COMPLETED":
            logger.info("Initial-sync hydration tamamlandi (owner=%s)", owner)
            try:
                from backend.app.api.v1.websocket import ws_manager
                await ws_manager.broadcast({"event": "conversations_updated", "user_id": owner})
                await ws_manager.broadcast({"event": "session_updated", "user_id": owner})
            except Exception as exc:  # noqa: BLE001 — broadcast basarisiz olssa bile DB gercegi yazar
                logger.warning("Initial-sync broadcast basarisiz (owner=%s): %s", owner, exc)
        else:
            logger.warning("Initial-sync hydration basarisiz (owner=%s): %s", owner, job.error)
    except asyncio.CancelledError:
        _initial_sync_pending.discard(owner)
        raise
    except Exception as exc:  # noqa: BLE001 — fail-soft: sonraki olay/Eşitle dener
        logger.warning("Initial-sync hydration beklenemedi (owner=%s): %s", owner, exc)
    finally:
        _initial_sync_inflight.discard(owner)
        if owner in _initial_sync_pending:
            _initial_sync_pending.discard(owner)
            _schedule_initial_sync(owner)


_history_expansion_running: Set[str] = set()
_history_expansion_done: Set[str] = set()


async def _run_background_history_expansion(user_id: str, gateway_id: str) -> None:
    """Progressive background history expansion after initial sync.
    Runs cooperatively in small batches without blocking realtime events, outgoing sends, or holding global locks.
    """
    if user_id in _history_expansion_running or user_id in _history_expansion_done:
        return
    _history_expansion_running.add(user_id)
    logger.info("Starting background history expansion for user=%s, gateway=%s", user_id, gateway_id)
    try:
        async with AsyncSessionLocal() as db:
            cres = await db.execute(
                select(Conversation).where(
                    Conversation.channel == "WHATSAPP",
                    get_user_filter(Conversation.user_id, user_id),
                ).order_by(Conversation.last_message_at.desc().nullslast())
            )
            convs = cres.scalars().all()

        for conv in convs:
            await asyncio.sleep(0.05)
            try:
                async with AsyncSessionLocal() as db:
                    c = await db.get(Conversation, conv.id)
                    if not c:
                        continue
                    mres = await db.execute(
                        select(Message).where(Message.conversation_id == c.id)
                        .order_by(_msg_time_col().asc(), Message.id.asc())
                        .limit(1)
                    )
                    oldest = mres.scalars().first()
                    if oldest:
                        cursor_ms = _hydration_cursor_ms([oldest])
                        anchor_id = oldest.wa_message_id
                        anchor_from_me = (oldest.direction == MessageDirection.OUTBOUND)
                        if cursor_ms is not None:
                            await _hydrate_messages_on_demand(
                                db,
                                user_id,
                                c,
                                limit=50,
                                before_ts_ms=cursor_ms,
                                oldest_msg_id=anchor_id,
                                oldest_msg_from_me=anchor_from_me,
                            )
            except Exception as e:
                logger.debug("Background expansion skipped conversation %s: %s", conv.id, e)
                continue
        _history_expansion_done.add(user_id)
    except Exception as exc:
        logger.warning("Background history expansion failed: %s", exc)
    finally:
        _history_expansion_running.discard(user_id)


# Faz 13 (düzeltme — production log regresyonu): Gateway'in bilerek KALICI
# YAZILMAYAN ama UI'a ULAŞMASI GEREKEN olayları. Bunlar DB'ye yazılmaz
# (kalıcı yan etkisi yoktur) fakat sahibi KESİN çözülmeden YAYINLANMAZ —
# aksi halde `ws_manager.broadcast` hedefsiz kalır ve olay diğer tenant'lara
# sızabilir (AGENTS.md §1.1).
#
# `history_sync_completed` (whatsapp-gateway/src/session-manager.js:1876)
# buradadır: telefonun geçmiş senkronu bittiğinde sohbet listesini ve seçili
# sohbetin mesajlarını tazelemek için frontend'e
# (frontend/src/pages/WhatsAppHubPage.tsx:1181) ulaşması ZORUNLUDUR.
# Bu olay daha önce "bilinmeyen olay" dalına düşüyor, ERROR olarak loglanıyor
# ve yayınlanmıyordu — UI geçmiş senkronu bitince tazelenmiyordu.
#
# NOT: `gateway_connected` (whatsapp-gateway/src/events.js:88) burada YOKTUR:
# o olay yalnızca gateway'e doğrudan bağlanan istemci soketlerine gönderilir,
# backend köprüsünden (`/ws/gateway`) HİÇ geçmez.
_PASSTHROUGH_EVENTS: FrozenSet[str] = frozenset({"history_sync_completed"})


async def _passthrough_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    """Kalıcı yazılmayan, yalnızca UI'a yönlendirilen gateway olayı.

    `gateway_session_id` ZORUNLUDUR: sahip bu kimlikten KESİN çözülür. Eksikse
    olay `_skip_event` ile işaretlenir ve yayınlanmaz — "tek bağlı oturum"
    tahminine düşülmez, çünkü bu olayın DB'ye yazılacak bir yan etkisi
    olmadığından sahipsiz yayınlanması yalnızca gereksiz sızıntı riski taşır.
    """
    gw_session_id = event.get("gateway_session_id")
    if not gw_session_id:
        return _skip_event(event, "passthrough: gateway_session_id yok")
    owner = await _resolve_event_owner(db, "", str(gw_session_id))
    event["user_id"] = owner
    return event


def _skip_event(event: Dict[str, Any], reason: str) -> Dict[str, Any]:
    """Kalici yazilmayacak olayi NEDENIYLE isaretle (sessiz yutma yok).

    Dondurulen olay `_skip` tasir; `ingest_gateway_event` sinirinda bu olay
    UI'a YAYINLANMAZ ama debug seviyesinde loglanir. Boylece "bu olay neden
    yayinlanmadi" sorusu her zaman cevaplanabilir kalir — ne sessizce
    yutulur ne de sahte/eksik veri olarak disari cikar (AGENTS.md §1.1).
    """
    logger.debug("Gateway olayi kalici yazilmadi (%s)", reason)
    event["_skip"] = reason
    return event


# Prod (production log): silinen gateway oturumunun kuyruktaki/tekrar oynatilan
# olaylari saniyede ~1 ERROR satiri uretiyordu (3 dk'da 100+ satir). Ilk sinyal
# + 60 sn'de bir ozet loglanir; aradakiler debug'a duser (hata YUTULMAZ,
# sayac korunur — log seli degil, log hijyeni).
_orphan_suppressed: Dict[str, Dict[str, Any]] = {}


def _log_orphan_event(evt: str, exc: Exception, gw_session_id: Optional[str]) -> None:
    key = str(gw_session_id or "-")
    now = time.monotonic()
    slot = _orphan_suppressed.get(key)
    if len(_orphan_suppressed) > 200:
        _orphan_suppressed.clear()
    if slot is None:
        _orphan_suppressed[key] = {"count": 1, "logged_at": now}
        logger.warning("Gateway olayi sahibi cozulemedi, atlandi (event=%s): %s", evt, exc)
        return
    slot["count"] = int(slot.get("count") or 0) + 1
    if now - float(slot.get("logged_at") or 0.0) >= 60.0:
        logger.warning(
            "Gateway olayi sahibi cozulemedi, atlandi (event=%s, session=%s): %s "
            "(son 60 sn'de %d olay atlandi)",
            evt, key, exc, slot["count"],
        )
        slot["count"] = 0
        slot["logged_at"] = now
    else:
        logger.debug("Gateway olayi sahibi cozulemedi, atlandi (event=%s): %s", evt, exc)


@profiled("gateway_event")
async def ingest_gateway_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Gateway olayini persist eder ve UI broadcast'i icin kimlikleri cevirir.

    - `message_new`: inbound/outbound mesaji contact/conversation/messages'a
      yazar; `conversation_id` jid'den backend sayisal id'sine cevrilir.
    - `session_*`: `session_id` (gateway UUID) backend oturum id'sine cevrilir.
    - `conversation_*`: conversation kimligi sayisallastirilir.

    Dönüş sözleşmesi (Faz 13 — fail-closed): yayınlanabilir olay, tenant
    `user_id`'si KESİN olarak eklenmiş halde döner. `None` dönerse çağıran
    olayı **YAYINLAMAMALIDIR**. Böylece hiçbir koşulda persist edilmemiş ya da
    sahibi belirsiz bir olay UI'a çıkmaz (AGENTS.md §1.1 — sahte veri yok,
    sessiz hata yutma yok).
    """
    async with AsyncSessionLocal() as db:
        evt = event.get("event") or event.get("event_type") or ""
        event_id: Optional[str] = None
        if event.get("event_id"):
            try:
                event_id = str(uuid.UUID(str(event["event_id"])))
            except (TypeError, ValueError):
                logger.warning("Gateway olayi gecersiz event_id ile reddedildi (event=%s)", evt)
                return None
        try:
            if event_id and db.bind is not None and db.bind.dialect.name == "postgresql":
                duplicate = await db.execute(
                    text(
                        "SELECT 1 FROM whatsapp_private.processed_events "
                        "WHERE event_id = :event_id"
                    ),
                    {"event_id": event_id},
                )
                if duplicate.first() is not None:
                    return {"_duplicate": True, "event_id": event_id}
            if evt == "message_new":
                result = await _ingest_message(db, event)
            elif evt in ("conversation_updated", "conversation_read", "message_status_updated", "presence_updated"):
                result = await _map_conversation_event(db, event)
            elif evt == "contact_synced":
                result = await _ingest_contact_synced(db, event)
            elif evt == "connection_error" or str(evt).startswith("session_"):
                result = await _map_session_event(db, event)
            elif evt in _PASSTHROUGH_EVENTS:
                # Faz 13 (düzeltme): bilerek persist EDİLMEYEN ama UI'a
                # ulaşması gereken olaylar (bkz. _PASSTHROUGH_EVENTS).
                result = await _passthrough_event(db, event)
            else:
                # Gerçekten bilinmeyen olay: gateway ile backend sözleşmesi
                # kaymış demektir. Sessizce yutulmaz — fail-closed: yayınlanmaz.
                logger.error("Bilinmeyen gateway olayi yayinlanmadi (event=%s)", evt)
                return None

            # Sinir kontrolu: sahibi cozulemeyen olay DISARI CIKMAZ.
            if not isinstance(result, dict):
                logger.error("Gateway olayi sozluk degil, yayinlanmadi (event=%s)", evt)
                return None
            if result.get("_skip"):
                # Helper bilerek atladi (dejenere JID / eksik kimlik) — beklenen
                # durum, debug seviyesinde zaten loglandi. Sessiz yutma degil.
                return None
            if not result.get("user_id"):
                logger.error(
                    "Gateway olayi sahipsiz (event=%s, gateway_session_id=%s) — yayinlanmadi",
                    evt, event.get("gateway_session_id"),
                )
                return None

            if event_id and db.bind is not None and db.bind.dialect.name == "postgresql":
                await db.execute(
                    text(
                        "INSERT INTO whatsapp_private.processed_events (event_id) "
                        "VALUES (:event_id) ON CONFLICT (event_id) DO NOTHING"
                    ),
                    {"event_id": event_id},
                )
            await db.commit()
            # Faz 8 (§16, RC-5): initial sync TAMAMLANDIĞINDA backend DB'si de
            # ayni paylasilmis hattan (sync_conversations) hydrate edilir —
            # QR -> AUTHENTICATED -> INITIAL SYNC -> READY zinciri tek pipeline
            # ile calisir; "Eşitle" (manuel) ile initial sync AYNI kodu kullanir.
            if evt in ("session_sync_completed", "session_connected", "history_sync_completed"):
                owner = result.get("user_id")
                if owner and owner != SYSTEM_USER_ID:
                    if evt == "history_sync_completed":
                        chats_synced = event.get("chats_synced") or 0
                        messages_synced = event.get("messages_synced") or 0
                        if (chats_synced > 0 or messages_synced > 0) and owner not in _initial_sync_inflight:
                            _schedule_initial_sync(str(owner), reconcile=True)
                    else:
                        _schedule_initial_sync(
                            str(owner), reconcile=evt == "session_sync_completed"
                        )
            return result
        except EventOwnerUnresolved as exc:
            # Beklenen fail-closed durumu: olay yanlis tenant'a YAZILMAZ ve
            # UI'a YAYINLANMAZ (log seli _log_orphan_event ile kisilir).
            await db.rollback()
            _log_orphan_event(evt, exc, event.get("gateway_session_id"))
            return None
        except IntegrityError as exc:
            # Emniyet agi: `_ensure_conversation_race_safe` disindaki yazim
            # yollarinda (mesaj INSERT unique yarisi vb.) tx bozulur — rollback
            # + tek satirlik uyari, dev traceback seli yok. Olay yayinlanmaz
            # (persist edilmeyen veri UI'a cikmaz, AGENTS.md §1.1).
            await db.rollback()
            logger.warning("Gateway olayi atlandi (DB yarisi, event=%s): %s", evt, exc)
            return None
        except Exception as exc:
            await db.rollback()
            logger.exception("Gateway olayi islenemedi, yayinlanmadi (event=%s): %s", evt, exc)
            return None


async def _ingest_message(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    msg = event.get("message") or {}
    jid = msg.get("conversation_id") or event.get("conversation_id")
    if not jid or "@" not in str(jid):
        return _skip_event(event, "message_new: gecerli jid yok")
    jid_str = str(jid)
    # Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
    # mesajlari sohbet listesine sohbet olarak dusuyordu — kalici YAZILMAZ.
    if is_broadcast_only_jid(jid_str):
        return _skip_event(event, f"message_new: broadcast-only jid ({jid_str})")
    # Faz 9 (§5): dejenere JID mesajları (`0@s.whatsapp.net`) kalıcılaştırılmaz.
    if is_degenerate_jid(jid_str):
        return _skip_event(event, f"message_new: dejenere jid ({jid_str})")
    # MVP: gateway tenant'i bilmiyor; kayitli oturumun sahibine, yoksa system'e baglan.
    # Faz 13 (tenant izolasyonu): gateway artik her olayda `gateway_session_id`
    # (gateway UUID) tasiyor — sahip KESIN olarak cozulur, tahmin edilmez.
    # Cozulemezse `EventOwnerUnresolved` yukselir ve olay hic islenmez.
    owner, ws_session_id = await _resolve_event_owner_and_session(db, jid_str, event.get("gateway_session_id"))
    # Faz 13 (fail-closed sinir kontrolu): cozulen sahip olaya YAZILIR. Aksi
    # halde `ingest_gateway_event` sonundaki "sahipsiz olay yayinlanmaz"
    # kontrolu bu mesaji reddeder ve gercek mesajlar UI'a hic ulasmaz.
    event["user_id"] = owner
    # Faz 10 (P1, RC-4): GRUP sohbetlerinde mesajin gonderen adi (pushName —
    # ör. bir üyenin "Ahmet"ı) GRUP contact'ine ASLA yazilmaz; grup adi
    # yalnizca group_subject metadata'sindan guncellenir. (1:1'de mevcut
    # davranis korunur: kisi adini mesajla tasiyabiliriz.)
    # Faz 10 (P3): GIDEN mesajlarda sender_name 'ME'dir — kisi adi OLAMAZ
    # (telefondan gonderilen mesajlar artik messages.upsert ile de akıyor).
    is_group_jid = "@g.us" in jid_str
    msg_direction = (
        MessageDirection.INBOUND
        if str(msg.get("direction", "INBOUND")).upper() == "INBOUND"
        else MessageDirection.OUTBOUND
    )
    name_for_contact = None if (is_group_jid or msg_direction == MessageDirection.OUTBOUND) else msg.get("sender_name")
    source_for_contact = None if (is_group_jid or msg_direction == MessageDirection.OUTBOUND) else msg.get("sender_name_source")
    conv = await _ensure_conversation_race_safe(
        db, owner, jid_str, event, session_id=ws_session_id,
        contact_name=name_for_contact, contact_source=source_for_contact,
    )
    contact = getattr(conv, "_contact", None)
    if contact is None:
        contact = await _upsert_contact(db, owner, jid_str, name_for_contact, source_for_contact)

    wa_id = msg.get("wa_message_id")
    client_id = msg.get("client_message_id")
    if wa_id or client_id:
        existing = await db.execute(
            select(Message).where(
                or_(Message.wa_message_id == wa_id if wa_id else False,
                    Message.client_message_id == client_id if client_id else False),
                Message.conversation_id == conv.id,
                get_user_filter(Message.user_id, owner),
            )
        )
        canonical = existing.scalars().first()
        if canonical is not None:
            canonical.wa_message_id = wa_id or canonical.wa_message_id
            _advance_message_status(canonical, msg.get("status"))
            await db.commit()
            event["conversation_id"] = conv.id
            event["message"] = _serialize_message(canonical)
            return event  # dedup

    mtype_str = (msg.get("message_type") or "TEXT").upper()
    try:
        mtype = MessageType[mtype_str] if mtype_str in MessageType.__members__ else MessageType.TEXT
    except (KeyError, TypeError) as exc:
        logger.warning("Inbound message_type gecersiz; TEXT fallback (value=%r): %s", mtype_str, exc)
        mtype = MessageType.TEXT
    direction = msg_direction

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
        # Faz 6a: grup mesajlarinda balon ustunde gercek gonderen adi gorunur
        # (WhatsApp Web paritesi); 1:1 sohbetlerde sohbet/kisi adi kalir.
        # Faz 10 (P1): grup mesajinda fallback ASLA grup contact adidir —
        # katilimci cozulemiyorsa ad None kalir (preview one eki de atlanir).
        # Faz 10 (P3): GIDEN mesajlarda gonderen her zaman 'ME'dir (history
        # senkronundaki `_historyMessageToRecord` ile ayni sozlesme) — kisi
        # adi one cikmaz.
        sender_name=(
            "ME"
            if direction == MessageDirection.OUTBOUND
            else (msg.get("participant_name") or (None if is_group_jid else contact.display_name))
        ),
        recipient_phone=msg.get("recipient_phone") or "ME" if direction == MessageDirection.INBOUND else contact.phone_e164,
        status=ConversationMessageStatus.RECEIVED if direction == MessageDirection.INBOUND else ConversationMessageStatus.SENT,
        # Prod fix (production log): asyncpg aware datetime'i naive kolona yazmayi
        # reddediyor ("can't subtract offset-naive and offset-aware") — tıpkı
        # _persist_gateway_message gibi _as_naive_utc ile normalize edilir.
        external_timestamp=_as_naive_utc(_parse_dt(msg.get("created_at"))),
    )
    db.add(row)
    # Faz 10 (P2): paylasilan kural — gercek mesaj zaman damgasiyla, tip
    # etiketi ve grup gonderen on eki uretilir; utcnow() uzerinden yazilmaz.
    summary = build_last_message_summary(
        message_type=mtype_str,
        body=body,
        sender_name=row.sender_name,
        is_group=is_group_jid,
        direction=direction.value,
    )
    _apply_last_message(conv, _as_naive_utc(_parse_dt(msg.get("created_at"))) or datetime.utcnow(), summary)
    if direction == MessageDirection.INBOUND:
        conv.unread_count = (conv.unread_count or 0) + 1
    await db.flush()

    event["conversation_id"] = conv.id
    event["message"] = _serialize_message(row)
    return event


# Sentinel user_id for events that arrive before any session is connected.
# Must be a valid UUID string since user_id columns are Uuid(as_uuid=False).
SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"


# Event owner resolution functions (_resolve_event_owner_and_session,
# _resolve_event_session_id, _resolve_event_owner, EventOwnerUnresolved)
# are imported from backend.app.services.whatsapp.repositories.sessions and backend.app.services.whatsapp.exceptions


async def _ingest_contact_synced(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    """Gateway `contact_synced` olayi: kisi adi/avatar'ini DB'ye kalici yaz.

    Faz 8 (§15, RC-1): yüksek rütbeli GERÇEK ad (addressbook/verified/
    group_subject) taşıyan olay için satir YOKSA oluşturulur — böylece
    hiç sohbeti olmayan rehber kişileri de kalıcı olur ve "Eşitle" sonrası
    adlar kaybolmaz. Düşük rütbeli (push) pushName güncellemeleri eski
    davranışta olduğu gibi yalnızca mevcut satırı günceller (şişirme yok).
    """
    contact_payload = event.get("contact") or {}
    jid = contact_payload.get("id") or contact_payload.get("jid")
    if not jid or "@" not in str(jid):
        return _skip_event(event, "contact_synced: gecerli jid yok")
    # Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
    # kisileri rehbere/sohbet listesine yazilmaz.
    if is_broadcast_only_jid(str(jid)):
        return _skip_event(event, f"contact_synced: broadcast-only jid ({jid})")
    # Faz 9 (§5): dejenere JID kişileri (`0@s.whatsapp.net` → '+0') DB'ye yazılmaz.
    if is_degenerate_jid(str(jid)):
        return _skip_event(event, f"contact_synced: dejenere jid ({jid})")
    phone_e164 = jid_to_phone(str(jid)) or f"jid:{jid}"
    owner = await _resolve_event_owner(db, str(jid), event.get("gateway_session_id"))
    event["user_id"] = owner  # Faz 13: cozulen sahip olaya yazilir (yayin sinir kontrolu)
    res = await db.execute(
        select(Contact).where(
            Contact.phone_e164 == phone_e164,
            get_user_filter(Contact.user_id, owner),
        )
    )
    # Prod fix (production log): ayni telefonda mükerrer contact satiri varsa
    # scalar_one_or_none() "Multiple rows were found" ile ingest'i kırıyordu;
    # ilk satiri al — guncelleme idempotent.
    contact = res.scalars().first()
    name = contact_payload.get("name")
    source = str(contact_payload.get("name_source") or "")
    if contact is None:
        # Yalnızca gerçek rehber/metadata adıyla oluştur; ham jid/lid veya
        # telefonsuz düşük rütbeli olaylar satır şişirmez.
        high_rank = source in ("addressbook", "verified", "group_subject")
        if high_rank and name and not _is_raw_jid_name(name):
            contact = await _upsert_contact(db, owner, str(jid), name, source)
            _set_contact_avatar(contact, contact_payload.get("avatar_url"))
            await db.commit()
        return event
    _set_contact_name(contact, name, source)
    _set_contact_avatar(contact, contact_payload.get("avatar_url"))
    await db.commit()
    return event


async def reconcile_legacy_split_conversation(
    db: AsyncSession,
    user_id: str,
    lid_jid: str,
    phone_jid: str,
) -> Optional[Conversation]:
    """Non-destructively reconciles and unifies legacy split conversations
    caused by LID vs phone-based JID divergence.

    Invariants:
    - No messages are deleted (delivery statuses are preserved, higher status wins).
    - Unread counts are merged.
    - Last message preview & timestamp are updated to the newest real timestamp.
    - Legacy conversation is archived with custom_attributes={"merged_into_conversation_id": canonical.id}.
    - Historical legacy records are retained for auditing.
    """
    lid_phone = f"jid:{lid_jid}" if not str(lid_jid).startswith("jid:") else str(lid_jid)
    canonical_phone = _contact_phone_for_jid(phone_jid)

    cres = await db.execute(
        select(Contact).where(
            Contact.phone_e164.in_([lid_phone, canonical_phone]),
            get_user_filter(Contact.user_id, user_id),
        )
    )
    contacts = {c.phone_e164: c for c in cres.scalars().all()}
    lid_contact = contacts.get(lid_phone)
    canonical_contact = contacts.get(canonical_phone)

    if not lid_contact or not canonical_contact:
        return None

    conv_res = await db.execute(
        select(Conversation).where(
            Conversation.contact_id.in_([lid_contact.id, canonical_contact.id]),
            get_user_filter(Conversation.user_id, user_id),
        )
    )
    convs = {c.contact_id: c for c in conv_res.scalars().all()}
    legacy_conv = convs.get(lid_contact.id)
    canonical_conv = convs.get(canonical_contact.id)

    if not legacy_conv or not canonical_conv or legacy_conv.id == canonical_conv.id:
        return canonical_conv

    ranks = {"PENDING": 0, "FAILED": 0, "SENT": 1, "DELIVERED": 2, "READ": 3, "RECEIVED": 4}

    async with _get_conversation_lock(user_id, legacy_conv.id), _get_conversation_lock(user_id, canonical_conv.id):
        mres = await db.execute(
            select(Message).where(Message.conversation_id.in_([legacy_conv.id, canonical_conv.id]))
        )
        all_msgs = list(mres.scalars().all())
        canonical_wa_ids = {
            m.wa_message_id: m for m in all_msgs if m.conversation_id == canonical_conv.id and m.wa_message_id
        }

        for msg in all_msgs:
            if msg.conversation_id == legacy_conv.id:
                if msg.wa_message_id and msg.wa_message_id in canonical_wa_ids:
                    canon_msg = canonical_wa_ids[msg.wa_message_id]
                    if ranks.get(msg.status.value, 0) > ranks.get(canon_msg.status.value, 0):
                        canon_msg.status = msg.status
                        canon_msg.delivered_at = canon_msg.delivered_at or msg.delivered_at
                        canon_msg.read_at = canon_msg.read_at or msg.read_at
                else:
                    msg.conversation_id = canonical_conv.id

        canonical_conv.unread_count = (canonical_conv.unread_count or 0) + (legacy_conv.unread_count or 0)

        if legacy_conv.last_message_at and (
            canonical_conv.last_message_at is None or legacy_conv.last_message_at > canonical_conv.last_message_at
        ):
            canonical_conv.last_message_at = legacy_conv.last_message_at
            if legacy_conv.last_message_preview:
                canonical_conv.last_message_preview = legacy_conv.last_message_preview

        legacy_conv.status = ConversationStatus.ARCHIVED
        legacy_conv.is_archived = True
        legacy_conv.unread_count = 0
        legacy_conv.archived_at = datetime.utcnow()

        await db.commit()
        await db.refresh(canonical_conv)
        return canonical_conv


# _find_whatsapp_conversation is imported from backend.app.services.whatsapp.repositories.conversations


async def _map_conversation_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    jid = event.get("conversation_id")
    if not jid or "@" not in str(jid):
        # Gateway `conversation_updated` olayini ust seviye id olmadan
        # yayarlar (chats.update / history sync); jid'yi conversation nesnesinden
        # topla.
        conv_payload = event.get("conversation") or {}
        candidate = conv_payload.get("id") or conv_payload.get("jid")
        if candidate and "@" in str(candidate):
            jid = candidate
        else:
            return _skip_event(event, f"{event.get('event')}: sohbet jid'i cozulemedi")
    # Sorun (prod): Durum (`status@broadcast`) / kanal (`@newsletter`)
    # sohbetleri DB'ye yazilmaz.
    if is_broadcast_only_jid(str(jid)):
        return _skip_event(event, f"{event.get('event')}: broadcast-only jid ({jid})")
    # Faz 9 (§5): dejenere JID sohbetleri (`0@s.whatsapp.net`) DB'ye yazilmaz.
    if is_degenerate_jid(str(jid)):
        return _skip_event(event, f"{event.get('event')}: dejenere jid ({jid})")
    owner, ws_session_id = await _resolve_event_owner_and_session(db, str(jid), event.get("gateway_session_id"))
    event["user_id"] = owner  # Faz 13: cozulen sahip olaya yazilir (yayin sinir kontrolu)
    evt_name = event.get("event")
    # WhatsApp Web paritesi: sohbet listesine YALNIZCA `conversation_updated`
    # (gercek sohbet metadata'si) yeni satir ekleyebilir. `presence_updated`
    # ("yaziyor..."), `conversation_read` ve `message_status_updated` MEVCUT
    # bir sohbetin durumunu tasir — sohbet YARATMAZLAR.
    #
    # Eski davranis bu dort olayin HEPSI icin `_ensure_conversation` cagiriyordu:
    # listenizde olmayan birinin tek bir presence sinyali bile kalici bir kisi +
    # bos sohbet satiri uretiyordu (hayalet sohbetler). WhatsApp Web'de
    # "yaziyor..." bilgisi sohbet acmaz.
    if evt_name == "conversation_updated":
        conv = await _ensure_conversation_race_safe(db, owner, str(jid), event, session_id=ws_session_id)
    elif evt_name == "message_status_updated":
        conv = None
        matching_msg = None
        wa_id = event.get("wa_message_id")
        client_mid = event.get("client_message_id")
        if wa_id or client_mid:
            # Faz 10.11: Select both (Message, Conversation) in a single joined query,
            # eliminating the subsequent db.get(Conversation, ...) roundtrip.
            msg_res = await db.execute(
                select(Message, Conversation)
                .join(Conversation, Message.conversation_id == Conversation.id)
                .where(
                    or_(
                        Message.wa_message_id == wa_id if wa_id else False,
                        Message.client_message_id == client_mid if client_mid else False,
                    ),
                    get_user_filter(Conversation.user_id, owner),
                )
            )
            first_pair = msg_res.first()
            if first_pair:
                matching_msg, conv = first_pair
        if conv is None:
            conv = await _find_whatsapp_conversation(db, owner, str(jid), session_id=ws_session_id)
        if conv is None:
            return _skip_event(event, f"{evt_name}: sohbet yok, durum olayi sohbet yaratmaz ({jid})")
    else:
        conv = await _find_whatsapp_conversation(db, owner, str(jid), session_id=ws_session_id)
        if conv is None:
            return _skip_event(event, f"{evt_name}: sohbet yok, durum olayi sohbet yaratmaz ({jid})")
    event["conversation_id"] = conv.id
    if event.get("event") == "presence_updated":
        # Baileys presence: composing / paused / available / recording ...
        presence = str(event.get("presence") or "").lower()
        event["typing"] = presence in ("composing", "recording")
        return event
    if event.get("event") == "conversation_updated":
        # Faz 4: history sync / chats.update alanlarini DB'ye kalici yaz.
        payload = event.get("conversation") or {}
        # Sorun 4: grup bayragi her olayda JID'den garanti edilir; arsiv
        # durumu yalnizca gateway GERCEK alan gonderdiyse yazilir (eski
        # gateway payload'inda `archived` yok → mevcut deger korunur,
        # varsayimla sifirlanmaz).
        conv.is_group = bool(payload.get("is_group")) or "@g.us" in str(jid)
        if "archived" in payload:
            conv.is_archived = bool(payload.get("archived"))
        name = payload.get("name")
        if name or payload.get("avatar_url"):
            contact = await _upsert_contact(db, owner, str(jid), None)
            _set_contact_name(contact, name, payload.get("name_source"))
            # Faz 5: grup/profil sohbet avatarunu kalici yaz.
            _set_contact_avatar(contact, payload.get("avatar_url"))
            await db.flush()
        preview = payload.get("last_message_preview")
        # Faz 10 (P2): gecikmeli gateway metadata/ozet olayinda da paylasilan
        # kural — bos/eksik preview mevcut ozeti silmez, eski zaman damgali
        # deger daha yeni ozetin uzerine yazmaz, '[IMAGE]' etiketlere
        # normalize edilir.
        if preview:
            gw_ts = _as_naive_utc(_parse_dt(payload.get("last_message_at")))
            summary = _normalize_preview_text(payload.get("message_type"), str(preview))
            if summary:
                if conv.last_message_at is None or not conv.last_message_preview:
                    _apply_last_message(conv, None, summary)
                    if gw_ts and (conv.last_message_at is None or gw_ts > conv.last_message_at):
                        conv.last_message_at = gw_ts
                else:
                    _apply_last_message(conv, gw_ts, summary)
        last_at = _as_naive_utc(_parse_dt(payload.get("last_message_at")))
        if last_at and (conv.last_message_at is None or last_at > conv.last_message_at):
            conv.last_message_at = last_at
        try:
            if payload.get("unread_count") is not None:
                conv.unread_count = max(conv.unread_count or 0, int(payload["unread_count"]))
        except (TypeError, ValueError) as exc:
            logger.warning(
                "Gateway unread_count gecersiz; mevcut deger korundu (conv=%s value=%r): %s",
                conv.id, payload.get("unread_count"), exc,
            )
        await db.commit()
        # Faz 6 (P0.4 / PHASE-28): history sync sirasinda gelen her
        # conversation_updated DB'ye yazildiktan sonra frontend'e "sozlesme
        # listende yeni veri var, gel al" sinyali verilir (2 sn'de bir,
        # throttle'li). Frontend bu sinyalle GET /conversations'i tetikler —
        # UI, job'un chats_snapshot'unu (T+~44s) BEKLEMEZ, canli akistaki
        # sohbetleri saniyeler icinde gorur.
        if owner != SYSTEM_USER_ID:
            _schedule_chats_bootstrap(owner)
        return event
    if event.get("event") == "conversation_read":
        if (conv.unread_count or 0) > 0:
            conv.unread_count = 0
            await db.commit()
    elif event.get("event") == "message_status_updated":
        # Outbound ack (✓ / ✓✓ / mavi ✓✓) → persist on the matching message.
        wa_id = event.get("wa_message_id")
        new_status = (event.get("status") or "").upper()
        if wa_id and new_status in ConversationMessageStatus.__members__:
            # Reuse matching_msg if already resolved during conversation mapping; avoids redundant SELECT
            row = matching_msg
            if row is None:
                res = await db.execute(
                    select(Message).where(
                        or_(Message.wa_message_id == wa_id,
                            Message.client_message_id == event["client_message_id"]
                            if event.get("client_message_id") else False),
                        Message.conversation_id == conv.id,
                    )
                )
                row = res.scalars().first()
            if row is not None:
                orig_status = row.status
                orig_wa_id = row.wa_message_id
                row.wa_message_id = wa_id or row.wa_message_id
                if new_status == "FAILED" and row.status == ConversationMessageStatus.PENDING:
                    row.status = ConversationMessageStatus.FAILED
                    row.failed_at = datetime.utcnow()
                    row.error_message = event.get("error_message")
                else:
                    _advance_message_status(row, new_status)
                if row.status != orig_status or row.wa_message_id != orig_wa_id:
                    await db.commit()
                event["message_id"] = row.id
                event["client_message_id"] = row.client_message_id
                event["status"] = row.status.value
            else:
                raise LookupError("Provider ACK precedes its message record; retry required")
    return event


async def _map_session_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    gw_session_id = event.get("session_id") or event.get("gateway_session_id")
    if not gw_session_id:
        return _skip_event(event, "session_*: session_id yok")
    evt = event.get("event") or event.get("event_type") or ""
    res = await db.execute(select(WhatsAppSession).where(WhatsAppSession.gateway_id == str(gw_session_id)))
    row = res.scalar_one_or_none()
    if row is None:
        # Redeploy sonrasi yetim gateway oturumu: bu olayin sahibi DB'de
        # KESIN cozulemiyor. Sessizce user_id'siz dondurmek yerine acikca
        # hata yukselt — `ingest_gateway_event` error seviyesinde loglar ve
        # olayi yayinlamaz (fail-closed). Aksi halde `session_sync_completed`
        # hic islenmez, initial-sync HIC tetiklenmez ve senkron sessizce
        # takili kalir (WhatsApp Web'de karsiligi: "yeniden baglan" uyarisi).
        raise EventOwnerUnresolved(
            f"Bilinmeyen gateway oturumu (session_id={gw_session_id}, event={evt}) — "
            "gateway yeniden baslatilmis olabilir; QR ile yeniden eslestirin."
        )
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
    elif evt == "session_connecting":
        row.status = SessionStatus.CONNECTING
        row.is_phone_online = False
        row.updated_at = datetime.utcnow()
    elif evt == "session_connected":
        row.status = SessionStatus.CONNECTED
        row.is_phone_online = True
        row.qr_code = None
        row.error_message = None
        phone = event.get("phone") or event.get("phone_number")
        if phone:
            row.phone_number = str(phone)
        row.updated_at = datetime.utcnow()
    elif evt == "session_disconnected":
        row.status = SessionStatus.DISCONNECTED
        row.is_phone_online = False
        row.updated_at = datetime.utcnow()
    elif evt == "session_qr_updated":
        row.status = SessionStatus.SCAN_QR
        qr = event.get("qr_code")
        if qr:
            row.qr_code = str(qr)
        row.error_message = None
        row.updated_at = datetime.utcnow()
    return event
