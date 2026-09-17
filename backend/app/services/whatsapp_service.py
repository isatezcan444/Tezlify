"""WhatsApp gateway - veri katmani ve servis orkestrasyonu (Public Facade).

Mimari (Phase 11.11 Consolidated):
                       WhatsApp API
                            │
                            ▼
                  whatsapp_service.py
                    Public Facade
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
       sessions          messaging          events
          │                 │                 │
          └─────────────────┼─────────────────┘
                            ▼
                           sync
                            │
               ┌────────────┴────────────┐
               ▼                         ▼
         repositories              gateway boundary
                                         │
                                         ▼
                                whatsapp_gateway.py
                                         │
                                         ▼
                                    Node/Baileys

Bu modul, WhatsApp alt sisteminin ana dis cephesidir (public facade).
- Tum REST API endpointleri ve WebSocket ingestion hatti bu servis uzerinden cagirilir.
- Yazma ve durum yonetimi `orchestration/{sessions,messaging,events,sync}.py` modullerine delege edilir.
- Paylasimli concurrency kilitleri (`_conversation_locks`) ve sorgu optimizasyon kayitlari (`_in_flight_history_fetches`) bu modulde yonetilir.
- Okuma odakli kritik sorgu cepheleri (`list_conversations`, `get_messages`, `get_sync_status`) yuksek basarim icin burada barinir.
- Facade icinde dogrudan `db.commit()` veya `db.rollback()` yapilmaz; transaction ownership ilgili orchestrator katmanindadir.
"""
import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, FrozenSet, List, Optional, Set, Tuple

from sqlalchemy import select, func, or_, and_, text
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
    set_contact_name as _set_contact_name,
)
from backend.app.services.whatsapp.repositories.conversations import (
    apply_conversation_last_message as _apply_last_message,
    find_whatsapp_conversation as _find_whatsapp_conversation,
    get_conversation_by_id as _get_conversation_or_404,
    get_conversation_lock as _get_conversation_lock,
    get_conversation_scope_filters as _conversation_scope_filters,
    resolve_conversation_jid as _resolve_jid,
)
from backend.app.services.whatsapp.repositories.messages import (
    build_message_from_gateway as _message_row_from_gateway,
    hydration_cursor_ms as _hydration_cursor_ms,
    msg_time as _msg_time,
    msg_time_col as _msg_time_col,
)
from backend.app.services.whatsapp.repositories.sessions import (
    conversation_gateway_id as _conversation_gateway_id,
    conversation_session as _conversation_session,
    get_user_sessions as _user_sessions,
    require_user_session as _require_user_session,
    resolve_event_owner as _resolve_event_owner,
)
from backend.app.services.whatsapp.orchestration.sessions import (
    _gateway_op_or_mark_relink,
    _list_sessions_internal,
    cancel_pairing_session,
    create_session,
    delete_session as _orchestrated_delete_session,
    get_pairing_qr,
    get_session_qr,
    list_sessions,
    logout_session,
    purge_whatsapp_data,
    refresh_contact_avatar,
    refresh_session_qr,
    request_pairing_code,
    start_pairing_session,
)


_in_flight_history_fetches: Dict[Tuple[int, Optional[int]], asyncio.Future] = {}


# ---------------------------------------------------------------------------
# Yardimcilar
# ---------------------------------------------------------------------------

from backend.app.services.whatsapp.identity import (
    NAME_RANK as _NAME_RANK,
    is_broadcast_only_jid,
    is_degenerate_jid,
    is_raw_jid_name as _is_raw_jid_name,
    is_self_identity as _is_self_identity,
    strip_jid_prefix as _strip_jid_prefix,
    jid_to_phone,
    safe_display_name as _safe_display_name,
)

import sys

# Messaging Orchestration (Phase 11.9)
from backend.app.services.whatsapp.orchestration.messaging import (
    WhatsAppMessagingOrchestrator,
    _serialize_message,
)

_messaging_orchestrator = WhatsAppMessagingOrchestrator(service=sys.modules[__name__])

# Event Orchestration (Phase 11.10)
from backend.app.services.whatsapp.orchestration.events import (
    WhatsAppEventOrchestrator,
    _orphan_suppressed,
)

_event_orchestrator = WhatsAppEventOrchestrator(service=sys.modules[__name__])

# Sync Orchestration (Phase 11.10)
from backend.app.services.whatsapp.orchestration.sync import (
    _SYNC_PER_CHAT_LIMIT,
    SyncJob,
    WhatsAppSyncOrchestrator,
    _bulk_channel_cache,
    _initial_sync_inflight,
    _initial_sync_pending,
    _last_bootstrap_emit,
    _metadata_tasks,
    _sync_jobs,
)

_sync_orchestrator = WhatsAppSyncOrchestrator(service=sys.modules[__name__])

from backend.app.services.whatsapp.status_policy import (
    advance_message_status as _advance_message_status,
)

from backend.app.services.whatsapp.preview_normalization import (
    build_last_message_summary,
    normalize_preview_text as _normalize_preview_text,
)


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
    return await _sync_orchestrator.sync_contacts(db, user_id, session=session)


async def _bulk_upsert_contacts(
    db: AsyncSession,
    user_id: str,
    items: List[Tuple[str, Optional[str], Optional[str], Optional[str]]],
) -> List[Tuple[str, Contact]]:
    """(jid, name, name_source, avatar) listesini TOPLU upsert eder (N+1 yok)."""
    return await _sync_orchestrator._bulk_upsert_contacts(db, user_id, items)


async def _ensure_conversations_bulk(
    db: AsyncSession, user_id: str, contacts: List[Tuple[str, Contact]],
    session_id: Optional[int] = None,
) -> List[Tuple[str, Contact, Conversation]]:
    """Kisi listesi icin WhatsApp conversation satirlarini TOPLU garanti eder."""
    return await _sync_orchestrator._ensure_conversations_bulk(db, user_id, contacts, session_id=session_id)


async def _upsert_contact(
    db: AsyncSession,
    user_id: str,
    jid: str,
    display_name: Optional[str],
    name_source: Optional[str] = None,
) -> Contact:
    return await _event_orchestrator._upsert_contact(db, user_id, jid, display_name, name_source)


async def _ensure_conversation(
    db: AsyncSession,
    user_id: str,
    jid: str,
    preview: Optional[str] = None,
    session_id: Optional[int] = None,
    contact_name: Optional[str] = None,
    contact_source: Optional[str] = None,
) -> Conversation:
    return await _event_orchestrator._ensure_conversation(
        db, user_id, jid, preview, session_id, contact_name, contact_source
    )


async def _ensure_conversation_race_safe(
    db: AsyncSession,
    owner: str,
    jid_str: str,
    event: Dict[str, Any],
    session_id: Optional[int] = None,
    contact_name: Optional[str] = None,
    contact_source: Optional[str] = None,
) -> Conversation:
    return await _event_orchestrator._ensure_conversation_race_safe(
        db, owner, jid_str, event, session_id, contact_name, contact_source
    )


async def _persist_gateway_message(db: AsyncSession, owner: str, msg: Dict[str, Any]) -> bool:
    return await _event_orchestrator._persist_gateway_message(db, owner, msg)



async def _repair_last_message_previews(db: AsyncSession, user_id: str) -> int:
    """Faz 10 (P2): eksik/bozuk son-mesaj ozetlerini messages tablosundan onarir."""
    return await _sync_orchestrator._repair_last_message_previews(db, user_id)


async def sync_conversations(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """LEGACY senkron hatti (chat basina gateway round-trip + tek commit)."""
    return await _sync_orchestrator.sync_conversations(db, user_id)


async def _sync_conversations_impl(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    return await _sync_orchestrator._sync_conversations_impl(db, user_id)



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

    active_sess_stmt = (
        select(WhatsAppSession.phone_number)
        .where(
            get_user_filter(WhatsAppSession.user_id, user_id),
            WhatsAppSession.status == SessionStatus.CONNECTED,
            WhatsAppSession.is_active.is_(True),
        )
        .order_by(WhatsAppSession.id.desc())
    )
    active_sess_phone = (await db.execute(active_sess_stmt)).scalars().first()

    seen_self_conversation = False
    out: List[Dict[str, Any]] = []
    for r in rows:
        contact = r.contact or contacts_map.get(r.contact_id)
        phone = contact.phone_e164 if contact else None

        if phone and active_sess_phone and _is_self_identity(phone, active_sess_phone):
            if seen_self_conversation:
                continue
            seen_self_conversation = True

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
    return await _sync_orchestrator._hydrate_messages_on_demand(
        db, owner, conv, limit,
        before_ts_ms=before_ts_ms,
        oldest_msg_id=oldest_msg_id,
        oldest_msg_from_me=oldest_msg_from_me,
    )


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
            if older_exists is not None:
                has_more = True

        if not has_more and conv.session_id:
            try:
                cres = await db.execute(select(Contact.phone_e164).where(Contact.id == conv.contact_id))
                phone_val = cres.scalar_one_or_none()
                if phone_val:
                    jid_val = phone_val[4:] if phone_val.startswith("jid:") else phone_to_jid(phone_val)
                    if jid_val:
                        state_res = await db.execute(
                            text(
                                "SELECT has_more, completed_at FROM whatsapp_private.history_sync_states "
                                "WHERE jid = :jid AND completed_at IS NOT NULL"
                            ),
                            {"jid": jid_val},
                        )
                        state_row = state_res.fetchone()
                        if state_row is None:
                            has_more = True
            except Exception as e:
                logger.debug("history_sync_states check failed: %s", e)
                if len(rows) >= page_size:
                    has_more = True

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
# Initial-sync & History Orchestration (Delegated to WhatsAppSyncOrchestrator)
# ---------------------------------------------------------------------------


def _schedule_chats_bootstrap(owner: str) -> None:
    return _sync_orchestrator._schedule_chats_bootstrap(owner)


async def _bulk_channel_available(gateway_id: str) -> bool:
    return await _sync_orchestrator._bulk_channel_available(gateway_id)


async def _broadcast_sync_event(payload: Dict[str, Any], owner: str) -> None:
    return await _sync_orchestrator._broadcast_sync_event(payload, owner)


def _sync_event(job: SyncJob, event: str, **fields: Any) -> Dict[str, Any]:
    return _sync_orchestrator._sync_event(job, event, **fields)


async def request_sync(db: AsyncSession, user_id: str) -> SyncJob:
    return await _sync_orchestrator.request_sync(db, user_id)


def get_sync_job(user_id: str) -> Optional[Dict[str, Any]]:
    return _sync_orchestrator.get_sync_job(user_id)


def _cancel_stale_sync_jobs(user_id: str) -> int:
    return _sync_orchestrator._cancel_stale_sync_jobs(user_id)


async def _reapply_chat_names(
    db: AsyncSession, owner: str, items: List[Dict[str, Any]]
) -> None:
    return await _sync_orchestrator._reapply_chat_names(db, owner, items)


def _schedule_metadata_enrichment(gateway_id: str) -> None:
    return _sync_orchestrator._schedule_metadata_enrichment(gateway_id)


@profiled("initial_sync")
async def _run_sync_job(job: SyncJob) -> None:
    return await _sync_orchestrator._run_sync_job(job)


async def _persist_chat_snapshot(
    db: AsyncSession, owner: str, items: List[Dict[str, Any]],
    session_id: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], Dict[int, str]]:
    return await _sync_orchestrator._persist_chat_snapshot(db, owner, items, session_id=session_id)


async def _run_bulk_message_sync(
    db: AsyncSession,
    job: SyncJob,
    jid_by_conv: Dict[int, str],
    gateway_id: str,
    ws_session: Optional[WhatsAppSession] = None,
) -> None:
    return await _sync_orchestrator._run_bulk_message_sync(
        db, job, jid_by_conv, gateway_id, ws_session=ws_session
    )


def _schedule_initial_sync(owner: str, *, reconcile: bool = False) -> None:
    return _sync_orchestrator._schedule_initial_sync(owner, reconcile=reconcile)


async def _run_initial_sync(owner: str) -> None:
    return await _sync_orchestrator._run_initial_sync(owner)


async def _run_background_history_expansion(user_id: str, gateway_id: str) -> None:
    return await _sync_orchestrator._run_background_history_expansion(user_id, gateway_id)


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
    """Kalıcı yazılmayan, yalnızca UI'a yönlendirilen gateway olayı."""
    return await _event_orchestrator._passthrough_event(db, event)


@profiled("gateway_event")
async def ingest_gateway_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Gateway olayini persist eder ve UI broadcast'i icin kimlikleri cevirir."""
    return await _event_orchestrator.ingest_gateway_event(event)


async def _ingest_message(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    return await _event_orchestrator._ingest_message(db, event)


async def _ingest_contact_synced(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    return await _event_orchestrator._ingest_contact_synced(db, event)


async def reconcile_legacy_split_conversation(
    db: AsyncSession,
    user_id: str,
    lid_jid: str,
    phone_jid: str,
) -> Optional[Conversation]:
    """Non-destructively reconciles and unifies legacy split conversations."""
    return await _event_orchestrator.reconcile_legacy_split_conversation(db, user_id, lid_jid, phone_jid)


async def _map_conversation_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    return await _event_orchestrator._map_conversation_event(db, event)


async def _map_session_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    return await _event_orchestrator._map_session_event(db, event)

