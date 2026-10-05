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
import re
from datetime import datetime
from typing import Any, Dict, FrozenSet, List, Optional, Set, Tuple

from backend.app.core.datetime_utils import utc_now_naive

from sqlalchemy import select, func, or_, and_
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
    WhatsAppHistoryTimeout,
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
from backend.app.services.whatsapp.repositories.reactions import (
    latest_reaction_by_conversation as _latest_reaction_by_conversation,
    reactions_by_message as _reactions_by_message,
)
from backend.app.services.link_preview.service import (
    previews_by_message as _previews_by_message,
)
from backend.app.services.whatsapp.repositories.lid_mappings import (
    resolve_lid_phones as _resolve_lid_phones,
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
    request_pairing_code_for_token,
    start_pairing_session,
)
from backend.app.services.whatsapp.orchestration.history_evidence import (
    get_history_evidence,
    is_history_exhausted_or_stalled,
    is_provider_recently_unresponsive,
)


_in_flight_history_fetches: Dict[Tuple[int, Optional[int]], asyncio.Future] = {}


# ---------------------------------------------------------------------------
# Yardimcilar
# ---------------------------------------------------------------------------

from backend.app.services.whatsapp.identity import (
    NAME_RANK as _NAME_RANK,
    is_broadcast_only_jid,
    is_degenerate_jid,
    is_phone_like as _is_phone_like,
    is_raw_jid_name as _is_raw_jid_name,
    is_self_identity as _is_self_identity,
    strip_jid_prefix as _strip_jid_prefix,
    jid_to_phone,
    safe_display_name as _safe_display_name,
    resolve_contact_identity as _resolve_contact_identity,
    IdentityResolutionState as _IdentityResolutionState,
    phone_to_jid as _phone_to_jid,
    extract_clean_phone as _extract_clean_phone,
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
    _BACKFILL_MAX_CHATS,
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
    format_reaction_preview as _format_reaction_preview,
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


async def gateway_health_probe() -> Dict[str, Any]:
    """A7: fail-closed gateway reachability probe (GET /whatsapp/gateway/health).

    Returns a summary dict on success. Raises ``gw.WhatsAppGatewayError`` (or a
    wrapped transport error) when the gateway is unreachable -- the thin router
    layer maps that to a 503 with ``gateway_available=False``. Never masks the
    failure as healthy; response carries no secrets.
    """
    data = await gw.health()
    if not isinstance(data, dict):
        raise gw.WhatsAppGatewayError("Gateway health response is invalid.")
    return {"gateway_available": True, "status": "ok", **data}


def resolve_gate_phase(
    *,
    job_state: str,
    job_stage: str,
    gw_phase: str,
    session_status: Optional[str],
    avatars_missing: int,
    initial_sync_completed: bool = False,
) -> tuple[str, str]:
    """Decide the loading gate's phase and stage.

    The gate answers ONE question: is the line's FIRST sync still running? Only
    `syncing_history`, `connecting` and `error` block; every other outcome lets
    the chat list open.

    Two production defects shaped these rules.

    1. Avatars must never hold the gate. `avatars_missing > 0` used to be
       checked before the ready branch, so one profile photo the gateway could
       not fetch pinned the gate to "loading_profiles" forever: progress froze at
       90 + 10*fetched/total (98% in the common single-contact case) and the
       chat list never opened. Avatars are not persisted in our database — they
       stream from the gateway on every probe — so "missing" regenerates each
       time and never clears on its own. WhatsApp Web renders a contact's
       initial instead; messages are what someone is waiting for, and they are
       already stored. Avatars therefore no longer participate in the decision
       at all (the payload still reports them via `avatars_pending`).

    2. `initial_sync_completed` is the durable truth. The gateway's sync phase
       and the backend `SyncJob` both live only in memory, so a page refresh or
       a container restart erases them. `whatsapp_sessions.initial_sync_completed_at`
       does not. Once it is stamped, the first-load gate is finished — a
       refresh must never show an unfinishable loading screen again, and a
       manual re-sync belongs in the in-list banner, not in a full-screen gate.

    3. The gateway finishing its OWN history sync is NOT the first sync
       finishing. `gw_phase == "ready"` used to open the gate outright (as long
       as no backend job happened to be running), so the chat list opened while
       chats were still being pulled in — measured 2026-10-02: the gateway
       emits `session_sync_completed` and the backend reconcile job only becomes
       `SYNCING` a moment later, and a job scheduled on `session_connected` can
       be skipped entirely when the session's owner is not resolvable yet. The
       durable stamp is the only thing that may open the gate; without it the
       gate keeps blocking.

    A failed job is still a failure — an error is never masked by the durable
    stamp. A reconnect, by contrast, must not re-open the first-load gate for a
    user who already has their chats: the session banner already reports the
    socket state, so the stamp wins there.
    """
    if job_state == "FAILED":
        return "error", job_stage
    if initial_sync_completed:
        return "ready", "complete"
    if session_status in ("CONNECTING", "RESTORING"):
        # Connecting is still connecting. Reporting "loading avatars" while the
        # socket is still coming up would name a wait that is not happening yet.
        return "connecting", "connecting"
    if job_state == "SYNCING":
        return "syncing_history", job_stage
    if gw_phase == "syncing":
        return "syncing_history", (job_stage if job_stage != "idle" else "chats")
    if gw_phase == "ready" and job_state in ("COMPLETED", "IDLE"):
        # Defect 3 (see docstring). No durable stamp means the backend has not
        # finished a pass over the gateway's final chat set, so this is still the
        # first sync. Reporting "ready" here is what let the list open while
        # chats were still arriving; keep blocking until the reconcile pass
        # stamps the column.
        return "syncing_history", (
            job_stage if job_stage not in ("idle", "complete") else "chats"
        )
    # Nothing durable and nothing running: there is no wait to explain. The UI
    # does not open a gate for `idle`, so the chat list is usable immediately.
    return "idle", "idle"


async def get_loading_gate(db: AsyncSession, user_id: str) -> Dict[str, Any]:
    """Faz 0 — Loading Gate: tek-authority QR sonrasi yukleme kapisi.

    WhatsApp Web paritesi: `phase` sirasi `qr -> connecting -> syncing_history
    -> loading_profiles -> ready` seklindedir. Kaynaklar (uydurma YOK):
      - `_list_sessions_internal` (DB satiri + gateway canli status/sync)
      - `_sync_orchestrator.get_sync_job` (backend SyncJob stage/sayaclar)
      - `gw.request_avatar_backfill` (gateway'deki eksik avatar sayisi)
    Gateway erisilemezse fail-closed: `gateway_available=False` + `phase=error`
    (AGENTS.md §1.1 — "senkron yok" ile karistirilamaz).
    """
    sessions, gateway_error = await _list_sessions_internal(db, user_id)
    if gateway_error:
        return {
            "session_id": sessions[0]["id"] if sessions else None,
            "phase": "error",
            "stage": "unavailable",
            "progress": 0,
            "counts": {
                "chats_total": 0, "chats_synced": 0,
                "messages_total": 0, "messages_synced": 0,
                "avatars_total": 0, "avatars_fetched": 0, "avatars_missing": 0,
            },
            "gateway_available": False,
            "gateway_error": gateway_error,
        }

    connected = [s for s in sessions if s.get("status") == "CONNECTED"]
    active = connected or sessions
    if not active:
        return {
            "session_id": None, "phase": "idle", "stage": "idle", "progress": 0,
            "counts": {"chats_total": 0, "chats_synced": 0, "messages_total": 0, "messages_synced": 0,
                        "avatars_total": 0, "avatars_fetched": 0, "avatars_missing": 0},
            "gateway_available": True, "gateway_error": None,
        }
    session = active[0]
    sync: Dict[str, Any] = session.get("sync") or {"phase": "idle", "progress": 0}
    job_snap = _sync_orchestrator.get_sync_job(user_id) or {}

    counts: Dict[str, int] = {
        "chats_total": int(job_snap.get("chats_total", 0) or 0),
        "chats_synced": int(job_snap.get("chats_synced", 0) or 0),
        "messages_total": int(job_snap.get("messages_total", 0) or 0),
        "messages_synced": int(job_snap.get("messages_synced", 0) or 0),
        "avatars_total": 0, "avatars_fetched": 0, "avatars_missing": 0,
    }

    # Gateway avatar durumu (fail-closed: hata yutulmaz, avatars_missing=0
    # iddia edilmez — alan bilgisi "bilinmiyor" sayilir ve kapilmez).
    # `_session_dict` gateway_id tasimadigi icin kimlik ayri sorgulanir.
    avatar_state: Optional[Dict[str, Any]] = None
    gid_row = await db.execute(
        select(WhatsAppSession.gateway_id).where(WhatsAppSession.id == session["id"])
    )
    gid = gid_row.scalar_one_or_none()
    if gid and session.get("status") == "CONNECTED":
        try:
            avatar_state = await gw.request_avatar_backfill(gid)
        except Exception as exc:  # noqa: BLE001 — fail-closed bubble-up in payload
            logger.warning("[WhatsApp] loading-gate avatar probe failed: %s", exc)
            avatar_state = None
    if avatar_state and isinstance(avatar_state.get("missing"), int):
        counts["avatars_missing"] = int(avatar_state["missing"])
        counts["avatars_total"] = counts["chats_synced"] or counts["chats_total"] or 0
        counts["avatars_fetched"] = max(0, counts["avatars_total"] - counts["avatars_missing"])

    gw_phase = str(sync.get("phase", "idle"))
    job_state = str(job_snap.get("state") or "IDLE")
    job_stage = str(job_snap.get("stage") or "idle")
    job_error = job_snap.get("error")

    phase, stage = resolve_gate_phase(
        job_state=job_state,
        job_stage=job_stage,
        gw_phase=gw_phase,
        session_status=session.get("status"),
        avatars_missing=counts["avatars_missing"],
        initial_sync_completed=bool(session.get("initial_sync_completed")),
    )

    progress = int(sync.get("progress") or 0)
    if phase == "ready":
        progress = 100
    elif job_state == "SYNCING":
        # The bar must never read 100% while the first sync is still running.
        # The gateway reports `progress: 100` the moment ITS history sync
        # finishes, but the backend still has to pull the final chat set — so cap
        # the gateway's contribution at 90 and take the job's own progress when
        # it is further along. `ready` (above) is the only path to 100.
        gateway_progress = min(progress, 90)
        backend_progress = (
            min(90, int(90 * counts["chats_synced"] / counts["chats_total"]))
            if counts["chats_total"] > 0
            else 0
        )
        progress = max(gateway_progress, backend_progress)

    return {
        "session_id": session.get("id"),
        "phase": phase,
        "stage": stage,
        "progress": max(0, min(100, progress)),
        "counts": counts,
        # Informational only. Avatars keep streaming in after the gate opens, so
        # this is a hint for the UI, never a reason to keep someone waiting.
        "avatars_pending": counts["avatars_missing"] > 0,
        "gateway_available": True,
        "gateway_error": None,
        "error": job_error,
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
    gateway_session_id: Optional[str] = None,
    session_id: Optional[int] = None,
) -> Contact:
    return await _event_orchestrator._upsert_contact(
        db,
        user_id,
        jid,
        display_name,
        name_source,
        gateway_session_id,
        session_id,
    )


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


async def _repair_phone_sender_names(db: AsyncSession, user_id: str) -> int:
    """Gonderen etiketi telefon olarak donmus mesajlari kisi adiyla onarir.

    `core/migrations.py::backfill_phone_sender_names` yalnizca acilista kosar;
    taze bir QR eslesmesinde mesajlar history sync sirasinda, adlar ise ayni
    sync'in sonunda yazildigi icin o migration tam olarak gerektigi anda
    calismaz. Sync job'inin `finalizing` fazindan cagrilir.
    """
    return await _sync_orchestrator._repair_phone_sender_names(db, user_id)


async def sync_conversations(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """LEGACY senkron hatti (chat basina gateway round-trip + tek commit)."""
    return await _sync_orchestrator.sync_conversations(db, user_id)


async def _sync_conversations_impl(
    db: AsyncSession, user_id: str, session: Optional[WhatsAppSession] = None
) -> List[Dict[str, Any]]:
    # `session` ONCEDEN yoktu ve bu shim orkestratordaki metodu GOLGELEDIGI icin
    # bulk kanali olmayan bir gateway'de legacy yol her zaman
    # `TypeError: unexpected keyword argument 'session'` ile patliyor, yani
    # senkron tamamen DUSUYORDU (fail-closed, ama islevsiz). Orkestratorun kendi
    # metodu parametreyi zaten kabul ediyor; burada da iletilir.
    return await _sync_orchestrator._sync_conversations_impl(db, user_id, session=session)



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

    # Liste rozeti: her sohbetin EN SON mesajina birakilan EN YENI ifade.
    # Tek sorgu; eski bir mesaja birakilan ifadeyi liste gostermez (kural
    # sunucuda, `latest_reaction_by_conversation` icinde).
    reaction_map: Dict[int, Dict[str, Any]] = {}
    if conv_ids:
        try:
            reaction_map = await _latest_reaction_by_conversation(db, conv_ids)
        except Exception as reaction_exc:  # noqa: BLE001 - rozet, listeyi dusurmemeli
            logger.warning("Sohbet listesi reaksiyon rozetleri alinamadi: %s", reaction_exc)
            reaction_map = {}

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

    # Phase 17.5: Auto-resolve any LID-keyed contacts from whatsapp_private.lid_mappings
    lid_map: Dict[str, str] = {}
    candidate_lids = []
    for r in rows:
        c = r.contact or contacts_map.get(r.contact_id)
        if c and c.phone_e164 and "@lid" in c.phone_e164:
            clean = c.phone_e164.replace("jid:", "").strip()
            candidate_lids.append(clean if "@" in clean else f"{clean}@lid")
    if candidate_lids:
        raw_lids = [l.split("@")[0] for l in candidate_lids]
        search_lids = list(set(candidate_lids + raw_lids + [f"{l}@lid" for l in raw_lids]))
        # G-3: tenant-scoped batch read. This used to be a bare
        # `WHERE lid_jid = ANY(:lids)` scan over every tenant's mapping rows.
        # A LID -> phone pair is a global WhatsApp protocol fact, but the row
        # itself is not globally readable: only this user's own sessions may
        # answer for this user's conversations.
        resolved_lids = await _resolve_lid_phones(db, search_lids, user_id=user_id)
        for lid_jid, phone_jid in resolved_lids.items():
            pn = jid_to_phone(phone_jid)
            if pn:
                lid_map[lid_jid] = pn
                lid_map[lid_jid.split("@")[0]] = pn
                lid_map[f"{lid_jid.split('@')[0]}@lid"] = pn

    seen_self_conversation = False
    out: List[Dict[str, Any]] = []
    for r in rows:
        contact = r.contact or contacts_map.get(r.contact_id)
        phone = contact.phone_e164 if contact else None

        if phone and "@lid" in phone:
            clean_lid = phone.replace("jid:", "").strip()
            resolved_pn = lid_map.get(clean_lid) or lid_map.get(clean_lid.split("@")[0]) or lid_map.get(f"{clean_lid.split('@')[0]}@lid")
            if resolved_pn:
                # C-5: normalize IN MEMORY only. A GET must never mutate persistence.
                # Re-keying `contact.phone_e164` and rewriting `messages.sender_phone`
                # used to happen right here, followed by a `db.commit()` from a read
                # path — which can also flush and discard unrelated pending work on
                # the same session. The repair now lives on the write path that
                # actually learns the mapping: `_heal_lid_contact_identity`, invoked
                # from the `lid_mapped` event handler.
                phone = resolved_pn

        if phone and active_sess_phone and _is_self_identity(phone, active_sess_phone):
            if seen_self_conversation:
                continue
            seen_self_conversation = True

        is_grp = bool(r.is_group) or bool(phone and "@g.us" in phone)
        resolved_name, id_state = _resolve_contact_identity(contact, phone=phone, is_group=is_grp)

        # Faz 10: eski kose-parantezli degerler okuma aninda da etikete
        # normalize edilir ('[IMAGE]' -> '📷 Fotoğraf'); normal metin aynen gecer.
        preview = _normalize_preview_text(None, r.last_message_preview) or None
        rx = reaction_map.get(r.id)
        if rx and rx.get("emoji"):
            preview = _format_reaction_preview(
                rx["emoji"],
                from_me=bool(rx.get("from_me")),
                sender_name=resolved_name if is_grp else None,
                is_group=is_grp,
                lang="tr",
            )
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
                # Faz 7 & Phase 15.4: Ham jid/lid presentation'a sızmaz,
                # 5-tier hiyerarşiyle çözülen temiz ad / telefon / None döner.
                "name": resolved_name,
                "phone": phone,
                "identity_state": id_state,
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
                "last_reaction": reaction_map.get(r.id),
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
    provider_timeout_ms: Optional[int] = None,
) -> List[Message]:
    return await _sync_orchestrator._hydrate_messages_on_demand(
        db, owner, conv, limit,
        before_ts_ms=before_ts_ms,
        oldest_msg_id=oldest_msg_id,
        oldest_msg_from_me=oldest_msg_from_me,
        provider_timeout_ms=provider_timeout_ms,
    )


# A plain open no longer runs a provider round-trip at all, so there is no open
# path budget to tune: the local page is returned immediately and the older page
# arrives through the explicit pagination path, which keeps the gateway's own
# full budget. The former `OPEN_PATH_PROVIDER_TIMEOUT_MS = 4000` constant was
# removed with that change — see `list_messages`.


async def _hydrate_or_tolerate_provider_timeout(
    db: AsyncSession, owner: str, conv: Conversation, limit: int,
    *, have_rows: bool,
    before_ts_ms: Optional[int] = None,
    oldest_msg_id: Optional[str] = None,
    oldest_msg_from_me: Optional[bool] = None,
    provider_timeout_ms: Optional[int] = None,
) -> List[Message]:
    """One on-demand provider round-trip, where a timeout must not destroy local data.

    H-3 keeps a full provider timeout retryable (a timeout proves nothing about
    completeness), and that is preserved: the evidence still records TIMEOUT and
    the round-trip is still re-attempted later.

    What a timeout must NOT do is throw away messages we already loaded. The
    endpoint maps an escaping exception to 502, so a provider outage used to make
    a conversation with real local rows render as an error — the rows existed but
    were discarded. When `have_rows` is true we therefore serve what we have and
    leave `has_more` untouched (still true: we genuinely do not know).

    `have_rows` therefore means "the caller cannot be misled into reading this
    page as an empty conversation" — NOT "this page returned rows". A paginated
    page is empty by construction once it walks past the oldest stored row, while
    the caller still holds the entire newer page it was just handed; passing
    `bool(rows)` there made a load-older timeout surface as a 502 (measured live
    2026-10-02: 25.2 s, then `WhatsAppHistoryTimeout`, rendered as "Mesajlar
    yüklenemedi" next to a "load older" control that could never succeed).

    With `have_rows` false the exception still propagates, because there the
    alternative is returning an empty list — i.e. claiming "no messages exist" —
    which is exactly the falsehood the 502 exists to prevent.

    `provider_timeout_ms` is chosen by the CALLER. The explicit "load older" path
    passes `None` so the gateway's own full window applies — the user is actively
    asking for those older messages. A plain open with local rows never reaches
    this helper at all (see `get_messages`); the zero-row open does, and keeps the
    full window for the same reason. The parameter is kept because the budget must
    stay a caller decision.
    """
    try:
        return await _hydrate_messages_on_demand(
            db, owner, conv, limit,
            before_ts_ms=before_ts_ms,
            oldest_msg_id=oldest_msg_id,
            oldest_msg_from_me=oldest_msg_from_me,
            provider_timeout_ms=provider_timeout_ms,
        )
    except WhatsAppHistoryTimeout:
        if not have_rows:
            raise
        logger.warning(
            "Provider history timed out (conv=%s); serving local rows instead of failing",
            conv.id,
        )
        return []


def resolve_has_more(
    *,
    db_has_more: bool,
    page_size: int,
    rows_returned: int,
    evidence: Optional[Dict[str, Any]] = None,
) -> bool:
    """Decide whether older messages are still reachable, for one page.

    `db_has_more` is an EXISTS probe against OUR OWN message table and is
    authoritative: we store what we fetched, and it stays stored. Provider
    history evidence can only ever explain WHY there is nothing more, never veto
    a page we already know is incomplete.

    The regression this exists to prevent: has_more used to be recomputed from
    provider evidence whenever the database probe found nothing older, and
    FULLY_EXHAUSTED or CURSOR_STALLED then forced it to False. A conversation
    holding 66 stored rows served 50 and reported no more, so the "load older"
    affordance never rendered and the remaining 16 were unreachable through the
    UI. A provider cursor stalling says nothing about rows already persisted, so
    trusting it there made stored history permanently invisible.

    TIMEOUT and PROVIDER_ERROR are deliberately NOT treated as exhaustion. A
    provider that failed to answer has not told us it reached the end of the
    history, so claiming completeness from a failure would be the same lie in the
    opposite direction — it would hide the affordance and strand the user on a
    partial thread that is merely unverified. We keep the affordance and let the
    click retry.

    Only a definitive "I have nothing older" from both sides ends the thread.
    """
    if db_has_more:
        return True
    if page_size > 0 and rows_returned >= page_size:
        # A full page with nothing older in our table: the provider may still
        # hold something we never stored, so keep the affordance.
        return True
    ev = evidence or {}
    state = ev.get("state")
    if state in ("FULLY_EXHAUSTED", "CURSOR_STALLED") or ev.get("provider_exhausted"):
        return False
    if state in ("TIMEOUT", "PROVIDER_ERROR"):
        return True
    if not ev.get("provider_checked"):
        # The provider never gave an answer yet, so completeness is unproven.
        return True
    # The provider has been checked, no timeout/error occurred, our DB has no
    # older rows, and fewer rows were returned than the page size: there are no older messages.
    return False


async def _history_evidence_session_id(
    db: AsyncSession, user_id: str, conv: Conversation
) -> Optional[str]:
    """`whatsapp_private.history_sync_states.session_id` anahtari GATEWAY oturum
    UUID'sidir (TEXT FK -> gateway_sessions.session_id), backend integer PK'si
    DEGILDIR. Yazicilar `str(session_row.gateway_id)` kullanir (sync.py).

    Okuma tarafinda `conv.session_id` (integer) kullanildigi surece hicbir satir
    eslesmiyordu; bu da (a) exhaustion/stall short-circuit'ini etkisiz kiliyor,
    (b) `has_more` degerini sonsuza kadar True'ya geri ceviriyordu.

    Tek sorguyla dogru anahtari cozer; eski/kaynagi olmayan satirlar icin
    fail-soft None doner (sorguyu kirmaz).
    """
    if not conv.session_id:
        return None
    try:
        gw_id = await _conversation_gateway_id(db, user_id, conv)
    except Exception as exc:  # noqa: BLE001 - legacy rows may have no session row
        logger.debug(
            "History evidence session id unresolved (conv=%s): %s", conv.id, exc
        )
        return None
    if not gw_id or gw_id == "None":
        return None
    return gw_id


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
    # Phase 17 kanit tablosu GATEWAY oturum UUID'siyle anahtarlanir; bir kez
    # cozup hem exhaustion kontrolunde hem evidence okumasinda ayni anahtari
    # kullaniyoruz (yazicilarin kullandigi anahtarla ayni).
    history_session_id = await _history_evidence_session_id(db, user_id, conv)
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

                    # Check if already conclusively exhausted or stalled before calling provider
                    should_skip_provider = False
                    if conv.contact_id:
                        cres = await db.execute(select(Contact.phone_e164).where(Contact.id == conv.contact_id))
                        p_val = cres.scalar_one_or_none()
                        if p_val:
                            j_val = p_val[4:] if p_val.startswith("jid:") else _phone_to_jid(p_val)
                            if j_val and history_session_id and await is_history_exhausted_or_stalled(
                                db, j_val, session_id=history_session_id
                            ):
                                should_skip_provider = True
                            # A recent provider TIMEOUT/PROVIDER_ERROR means asking
                            # again right now would re-pay the gateway's whole
                            # provider wait (~25 s measured live 2026-10-02) and
                            # fail identically.
                            #
                            # Skipping is allowed ONLY when the caller cannot read
                            # the answer as "this conversation has no messages" —
                            # the falsehood the 502 exists to prevent. Two shapes
                            # qualify:
                            #   * the page already has rows, or
                            #   * an explicit "load older" whose `before` row we
                            #     resolved in THIS conversation (`before_row`): the
                            #     caller holds the newer page by construction, since
                            #     it is the one that sent us that row's id.
                            # With `before is None` and zero rows, skipping would
                            # answer an empty page and fabricate "no messages
                            # exist", so that case must stay a retryable failure.
                            #
                            # Keying this on `rows` ALONE was the bug: a load-older
                            # page is empty BY CONSTRUCTION (nothing is older than
                            # the row we were handed), so the guard was dead exactly
                            # where the futile round-trip was being paid on every
                            # click. Live: conv 18192 held 2 outbound rows, every
                            # click waited 25.2 s and 502'd.
                            #
                            # Distinct from sync.py's in-memory `_history_jid_cooldown`,
                            # which only guards the kill-switched background sweep. This
                            # one guards the user-facing on-demand path and is backed by
                            # durable evidence, so it survives restarts and is shared
                            # across workers.
                            elif (
                                (rows or before_row is not None)
                                and j_val
                                and history_session_id
                                and await is_provider_recently_unresponsive(
                                    db, j_val, session_id=history_session_id
                                )
                            ):
                                logger.info(
                                    "On-demand provider request skipped (conv=%s): provider recently unresponsive",
                                    conv.id,
                                )
                                should_skip_provider = True

                    if len(rows) < page_size and not should_skip_provider:
                        if not rows and before is None:
                            # Nothing local to show: waiting is the only honest
                            # answer (an empty pane would claim "no messages").
                            older = await _hydrate_or_tolerate_provider_timeout(
                                db, user_id, conv, page_size, have_rows=False
                            )
                            if older:
                                res = await db.execute(base)
                                rows = list(res.scalars().all())
                        elif before is None:
                            # Plain open WITH local rows in hand: never block the
                            # first paint on the provider. Measured live
                            # 2026-09-26: the gateway's history PDO answered late
                            # or not at all, so this awaited round-trip burned its
                            # whole budget on EVERY open (elapsed_ms 3005 / 3225 /
                            # 4016 / 4018 / 4311 — i.e. the pane sat blank for
                            # ~4 s before showing rows the backend already had).
                            # Returning the local page immediately lets the thread
                            # paint; the older page still arrives through the
                            # client's own "load older" call, which keeps the
                            # gateway's full budget because there the user is
                            # actively asking for those messages. `has_more` is
                            # computed below from local rows + durable history
                            # evidence, so it stays True and the thread's existing
                            # auto-load trigger fires as before.
                            pass
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
                                older = await _hydrate_or_tolerate_provider_timeout(
                                    db,
                                    user_id,
                                    conv,
                                    page_size - len(rows),
                                    # This branch is only reachable for an explicit
                                    # "load older" (`before is not None`) AND with a
                                    # resolvable cursor (`cursor_ms is not None`),
                                    # which requires either rows on this page or a
                                    # `before_row` that resolved inside THIS
                                    # conversation — i.e. the caller already holds
                                    # that newer row. So an empty page here can never
                                    # be read as "this conversation has no messages",
                                    # and a provider timeout must degrade to "no
                                    # older page this time" rather than a 502. See
                                    # the `have_rows` contract on the helper.
                                    have_rows=True,
                                    before_ts_ms=cursor_ms,
                                    oldest_msg_id=anchor_id,
                                    oldest_msg_from_me=anchor_from_me,
                                    # Reached only for an explicit "load older"
                                    # (`before is not None`), where the user is
                                    # actively asking for those messages, so the
                                    # gateway's own full budget applies.
                                    provider_timeout_ms=None,
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

    history_evidence: Dict[str, Any] = {
        "state": "NOT_CHECKED",
        "provider_checked": False,
        "provider_exhausted": False,
        "provider_msgs_returned": 0,
    }

    if history_session_id and conv.contact_id:
        try:
            cres = await db.execute(select(Contact.phone_e164).where(Contact.id == conv.contact_id))
            phone_val = cres.scalar_one_or_none()
            if phone_val:
                jid_val = phone_val[4:] if phone_val.startswith("jid:") else _phone_to_jid(phone_val)
                if jid_val:
                    evidence = await get_history_evidence(db, jid_val, session_id=history_session_id)
                    history_evidence = {
                        "state": evidence.get("state", "NOT_CHECKED"),
                        "provider_checked": bool(evidence.get("provider_checked", False)),
                        "provider_exhausted": bool(evidence.get("provider_exhausted", False)),
                        "provider_msgs_returned": int(evidence.get("provider_msgs_returned", 0)),
                    }
                    # Provider evidence may explain why there is no more, but it
                    # must not be able to hide history we already hold. See
                    # resolve_has_more for the regression this replaced.
                    has_more = resolve_has_more(
                        db_has_more=has_more,
                        page_size=page_size,
                        rows_returned=len(rows),
                        evidence=evidence,
                    )
        except Exception as e:
            logger.debug("history_sync_states check failed: %s", e)
            if not has_more and len(rows) >= page_size:
                has_more = True

    if len(rows) > page_size:
        rows = rows[-page_size:]
    # Reaksiyonlar TOPLU cozulur: mesaj basina sorgu atmak 50 mesajlik bir
    # sayfayi 50 ek sorguya cevirirdi. Yaris kaybi olmamasi icin rozetler
    # yalnizca DB'den okunur; canli guncelleme WS `message_reaction` olayiyla
    # gelir.
    try:
        grouped = await _reactions_by_message(db, [r.id for r in rows])
    except Exception as reaction_exc:  # noqa: BLE001 - rozet, sayfayi dusurmemeli
        logger.warning("Mesaj reaksiyonlari alinamadi: %s", reaction_exc)
        grouped = {}
    # Link onizlemeleri de TOPLU cozulur ve YALNIZCA onbellekten okunur. Bu yol
    # `@profiled("chat_open")`; buraya bir HTTP cagrisi koymak sohbet acilisini
    # saniyelere cikarirdi. Onbellegi bos olan URL'ler icin is arka planda
    # baslatilir (bkz. link_preview.service.previews_by_message).
    try:
        previews = await _previews_by_message(db, rows)
    except Exception as preview_exc:  # noqa: BLE001 - onizleme, sayfayi dusurmemeli
        logger.warning("Link onizlemeleri alinamadi: %s", preview_exc)
        previews = {}
    messages = [
        _serialize_message(r, reactions=grouped.get(r.id, []), preview=previews.get(r.id))
        for r in rows
    ]
    return {
        "messages": messages,
        "has_more": has_more,
        "oldest_message_id": messages[0]["id"] if messages else None,
        "newest_message_id": messages[-1]["id"] if messages else None,
        "history_evidence": history_evidence,
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


async def send_reaction(
    db: AsyncSession, user_id: str, conversation_id: int, message_id: int, emoji: str
) -> Dict[str, Any]:
    """Mesaja tepki birakir/degistirir/kaldirir (`emoji=""` geri ceker)."""
    return await _messaging_orchestrator.send_reaction(
        db, user_id, conversation_id, message_id, emoji
    )


async def get_message(
    db: AsyncSession, user_id: str, conversation_id: int, message_id: int
) -> Dict[str, Any]:
    return await _messaging_orchestrator.get_message(db, user_id, conversation_id, message_id)


async def refresh_all_avatars(db: AsyncSession, user_id: str) -> Dict[str, Any]:
    """Sohbet listesinde eksik kalan profil fotoğrafları için gateway'de
    backfill sweep'i tetikler (QR sonrası parite: tüm fotoğraflar iner).

    Tek jid'lik `refresh_contact_avatar`'ın tersine bu yol TÜM eksikleri
    kapsar; sweep eksik kalmayana dek backoff'lu turlarla çalışır ve yeni
    avatarlar `conversation_updated` olaylarıyla UI'a canlı akar. Bağlı hat
    yoksa NoWhatsAppSession (409), gateway erişilemezse hata (502) — sahte
    başarı üretilmez.
    """
    ws_session = await _require_user_session(db, user_id)
    result = await gw.request_avatar_backfill(str(ws_session.gateway_id))
    if not isinstance(result, dict):
        raise gw.WhatsAppGatewayError("Gateway avatar backfill yanıtı geçersiz.")
    return {
        "success": bool(result.get("success", True)),
        "missing": int(result.get("missing") or 0),
    }


async def get_contact_status(
    db: AsyncSession,
    user_id: str,
    phone_or_jid: str,
    session_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Kişinin WhatsApp 'Hakkında' (About / Status) metnini dinamik olarak gateway üzerinden çeker."""
    try:
        ws_session = await _require_user_session(db, user_id, session_id=session_id)
        clean_jid = phone_or_jid if "@" in phone_or_jid else f"{re.sub(r'[^0-9]', '', phone_or_jid)}@s.whatsapp.net"
        return await gw.fetch_contact_status(str(ws_session.gateway_id), clean_jid)
    except Exception as exc:
        logger.info("[WA-CONTACT-STATUS] Kişi durumu çekilemedi (%s): %s", phone_or_jid, exc)
        return {"status": None, "error": str(exc)}


async def get_group_participants(
    db: AsyncSession,
    user_id: str,
    conversation_id: int,
) -> Dict[str, Any]:
    """WhatsApp grup katılımcılarını ve metadata'sını çeker."""
    try:
        conv, jid = await _resolve_jid(db, user_id, conversation_id)
        if not conv.is_group and "@g.us" not in jid:
            return {"id": jid, "subject": "", "participants": []}
        ws_session = await _require_user_session(db, user_id, session_id=conv.session_id)
        return await gw.get_group_participants(str(ws_session.gateway_id), jid)
    except Exception as exc:
        logger.info("[WA-GROUP-PARTICIPANTS] Grup katılımcıları çekilemedi (%s): %s", conversation_id, exc)
        return {"id": "", "subject": "", "participants": [], "error": str(exc)}


async def start_conversation(
    db: AsyncSession,
    user_id: str,
    phone: str,
    name: Optional[str] = None,
    message: Optional[str] = None,
    session_id: Optional[int] = None,
) -> Dict[str, Any]:
    """WhatsApp Web paritesi: numara ile yeni sohbet baslat (A6 kapanisi).

    Eskiden repository'de kosulsuz throw vardi; UI'daki "Yeni Sohbet" akisi
    (NewChatModal) her denemede hata uretiyordu. Artik gercek davranis:
      1. Bagli hat zorunlu (NoWhatsAppSession -> 409, sahte basari yok).
      2. Numara `extract_clean_phone` ile E.164'e normalize edilir; cozulemezse
         ValueError (422) — LID/grup kimliklerinden telefon sentezlenmez.
      3. Contact + Conversation satirlari olusturulur/yeniden kullanilir.
      4. `message` verildiyse bagli hattan GERCEK olarak gönderilir; gönderim
         başarısızsa sohbet yine kaydedilir ama hata yükseltilir (truthfulness).
      5. Canonical REST sozlugu `list_conversations(conversation_id=...)` ile
         üretilir — WS ve REST aynı contract'ı taşır.
    """
    clean_phone = _extract_clean_phone(phone)
    if not clean_phone:
        raise ValueError(
            "Geçerli bir telefon numarası girin (ülke kodu dahil, örn. +90 5XX XXX XX XX)."
        )

    ws_session = await _require_user_session(db, user_id, session_id=session_id)
    jid = _phone_to_jid(clean_phone)
    contact_name: Optional[str] = None
    if name and name.strip():
        trimmed = name.strip()
        if not _is_raw_jid_name(trimmed) and not _is_phone_like(trimmed):
            contact_name = trimmed
    conv = await _ensure_conversation(
        db,
        user_id,
        jid,
        session_id=ws_session.id,
        contact_name=contact_name,
    )
    await db.commit()

    if message and message.strip():
        # Fail-closed: gönderim başarısızsa hata çağırana taşınır (HTTP 502/409),
        # "sohbet açıldı ama mesaj gitti" yalanı üretilmez.
        await send_text_message(db, user_id, conv.id, message.strip())

    items, _total = await list_conversations(db, user_id, conversation_id=conv.id)
    payload = items[0] if items else {"id": conv.id}
    try:
        from backend.app.api.v1.websocket import ws_manager

        await ws_manager.broadcast(
            {
                "event": "conversation_updated",
                "user_id": user_id,
                "conversation_id": conv.id,
                "conversation": payload,
            },
            target_user_id=user_id,
        )
    except Exception as exc:  # noqa: BLE001 - broadcast is best-effort
        logger.debug("start_conversation broadcast failed (conv=%s): %s", conv.id, exc)
    return payload


@profiled("conversation_status_update")
async def update_conversation_status(
    db: AsyncSession, user_id: str, conversation_id: int, status: str
) -> Dict[str, Any]:
    """Sohbetin CRM durumunu (ACTIVE / ARCHIVED / CLOSED) KALICI olarak yazar.

    WhatsApp'in kendi arsiv durumu (`Conversation.is_archived`, gateway
    metadata'sindan senkronlanir) ile karistirilmamalidir — bu kullanicinin
    acik aksiyonudur.

    Truthfulness (AGENTS.md §1.1): UI bu islemi eskiden yalnizca yerel state'te
    uygulayip basari toast'i gosteriyordu; hicbir kalici yazma yoktu ve
    degisiklik bir sonraki yenilemede kayboluyordu. Artik gercek yazma yapilir
    ve sonuc ayni tenant'in diger sekmelerine yayinlanir.
    """
    try:
        target = ConversationStatus(str(status).strip().upper())
    except ValueError as exc:
        raise ValueError(f"Gecersiz sohbet durumu: {status}") from exc

    conv = await _get_conversation_or_404(db, user_id, conversation_id)
    if conv.status != target:
        now = utc_now_naive()
        conv.status = target
        if target == ConversationStatus.ARCHIVED:
            conv.archived_at = now
            conv.closed_at = None
        elif target == ConversationStatus.CLOSED:
            conv.closed_at = now
        else:
            conv.archived_at = None
            conv.closed_at = None
        conv.updated_at = now
        await db.commit()
        await db.refresh(conv)

    result = {
        "id": conv.id,
        "status": conv.status.value if hasattr(conv.status, "value") else str(conv.status),
    }
    try:
        from backend.app.api.v1.websocket import ws_manager

        await ws_manager.broadcast(
            {
                "event": "conversation_status_updated",
                "user_id": user_id,
                "conversation_id": conv.id,
                "status": result["status"],
            },
            target_user_id=user_id,
        )
    except Exception as exc:  # noqa: BLE001 - broadcast is best-effort
        logger.debug("Conversation status broadcast failed (conv=%s): %s", conv.id, exc)
    return result


@profiled("conversation_delete")
async def delete_conversation(
    db: AsyncSession, user_id: str, conversation_id: int
) -> Dict[str, Any]:
    """Sohbeti ve O SOHBETE AIT TUM MESAJLARI kalici olarak siler.

    WhatsApp Web'deki "Sohbeti sil" karsiligi: sohbet yerel olarak kaldirilir.
    Karsi tarafin cihazindaki gecmis SILINMEZ (WhatsApp semantigi budur) — ama
    BIZIM taraftaki mesaj gecmisi geri donusu olmadan gider. WhatsApp
    konusmalari icin yedek YOKTUR, bu yuzden cagiran taraf (arayuz) kullaniciya
    sonucu acikca soylemek zorundadir.

    Ayrica sohbet WhatsApp tarafinda da silinir (`deleteChatAction` app-state
    yamasi), boylece hesabin diger cihazlari (telefon) da senkron kalir. Bu
    cagri en iyi cabadir: basarisiz olursa yerel silme YINE yapilir, ama sonuc
    `remote_deleted=False` olarak DONDURULUR.

    Neden ORM cascade DEGIL: `Conversation.messages` iliskisinde
    `cascade="all, delete-orphan"` var, ama ona guvenmek binlerce mesajlik bir
    sohbette TUM satirlari oturuma yukleyip tek tek silerdi. Burada toplu
    DELETE kullanilir; islem sabit sayida sorgu uretir.

    Yetki: kapsam `_get_conversation_or_404` ile kurulur — baska kiracinin
    sohbeti 404 doner, "bulunamadi" ile "yetkin yok" ayrimi sizdirilmaz.
    """
    from sqlalchemy import delete

    from backend.app.models.message_reaction import MessageReaction

    conv = await _get_conversation_or_404(db, user_id, conversation_id)

    # --- Uzaktan silme: WhatsApp tarafi -------------------------------------
    # WhatsApp Web'de bir sohbeti silmek, hesabin DIGER cihazlarinda (telefon)
    # kalan kopyayi kaldirmaz; bunun icin `deleteChatAction` app-state yamasi
    # gerekir. Yama gonderilmezse Tezlify "sildi" derken telefonda sohbet durur
    # ve bir sonraki gecmis senkronu onu geri getirebilir — yani silme
    # senkronu iki yonlu degil, tek yonlu olur.
    #
    # EN IYI CABADIR ve yerel silmeyi ASLA engellemez: kullanici silme kararini
    # verdi, yerel veri gitmelidir. Ama sonuc DONDURULUR (`remote_deleted`), ki
    # arayuz "WhatsApp'ta da silindi" iddiasini ancak dogruysa kurabilsin
    # (AGENTS.md §1.1 — sessiz yalan yok).
    remote_deleted = False
    remote_error: Optional[str] = None
    remote_jid: Optional[str] = None
    try:
        _remote_conv, remote_jid = await _resolve_jid(db, user_id, conversation_id)
    except LookupError as exc:
        # Kisisi olmayan bir sohbetin WhatsApp kimligi yoktur. Bu bir hata
        # degil, uzaktan silmenin MUMKUN OLMADIGI durumdur — ve silme yine
        # yapilmalidir; bu yuzden 404'e cevrilmez.
        remote_error = "NO_REMOTE_IDENTITY"
        logger.info("Sohbet uzaktan silinemedi (conv=%s): %s", conversation_id, exc)
    if remote_jid:
        try:
            # WhatsApp companion eşitlemesinde telefonun sohbeti kalıcı temizleyebilmesi için
            # en son bilinen mesaj çıpasını (wa_message_id, timestamp, participant) gateway'e ilet.
            last_message_hint = None
            try:
                last_msg = await db.scalar(
                    select(Message)
                    .where(
                        Message.conversation_id == conv.id,
                        get_user_filter(Message.user_id, user_id),
                    )
                    .order_by(_msg_time_col().desc(), Message.id.desc())
                    .limit(1)
                )
                if last_msg and last_msg.wa_message_id:
                    msg_dt = _msg_time(last_msg)
                    last_message_hint = {
                        "wa_message_id": last_msg.wa_message_id,
                        "timestamp_s": int(msg_dt.timestamp()) if msg_dt else 0,
                        "from_me": (last_msg.direction == MessageDirection.OUTBOUND),
                        "participant_jid": getattr(last_msg, "sender_jid", None) or getattr(last_msg, "participant_jid", None),
                    }
            except Exception as _hint_err:
                logger.debug("Sohbet silme mesaj çıpası çözülemedi: %s", _hint_err)

            session_row = await _conversation_session(db, user_id, conv)
            async def _invoke_remote_delete(gid: str):
                try:
                    return await gw.delete_conversation_remote(
                        gid, remote_jid, last_message_hint=last_message_hint
                    )
                except TypeError:
                    return await gw.delete_conversation_remote(gid, remote_jid)

            gateway_result = await _gateway_op_or_mark_relink(
                db, session_row, _invoke_remote_delete
            )
            # Tasima katmanindaki 2xx, WhatsApp'in kabul ettiginin kaniti
            # DEGILDIR; gateway saglayici reddinde `success: false` doner.
            if isinstance(gateway_result, dict) and gateway_result.get("success") is True:
                remote_deleted = True
            else:
                raw = gateway_result.get("error") if isinstance(gateway_result, dict) else None
                remote_error = str(raw or "INVALID_GATEWAY_RESPONSE")[:300]
        except WhatsAppRelinkRequired:
            remote_error = "WHATSAPP_AUTH_RELINK_REQUIRED"
        except NoWhatsAppSession as exc:
            remote_error = str(exc)[:300]
        except Exception as exc:  # noqa: BLE001 - uzaktan silme yerel silmeyi durduramaz
            remote_error = str(exc)[:300]
            logger.warning("Sohbet uzaktan silinemedi (conv=%s): %s", conversation_id, exc)

    # Reaksiyonlar once: `message_reactions` hem `messages.id` hem
    # `conversations.id`'ye FK ile baglidir. SQLite'ta FK zorlamasi varsayilan
    # olarak KAPALIDIR, bu yuzden DB seviyesindeki ON DELETE CASCADE'e guvenmek
    # testte sessizce yetim satir birakirdi. Acik silme iki lehcede de ayni
    # sonucu verir.
    reactions_deleted = (
        await db.execute(
            delete(MessageReaction).where(
                MessageReaction.conversation_id == conv.id
            )
        )
    ).rowcount
    messages_deleted = (
        await db.execute(delete(Message).where(Message.conversation_id == conv.id))
    ).rowcount
    await db.delete(conv)
    await db.commit()

    result = {
        "id": conversation_id,
        "deleted": True,
        "messages_deleted": int(messages_deleted or 0),
        "reactions_deleted": int(reactions_deleted or 0),
        # Uzaktan silme sonucu: arayuz bunu kullaniciya soylemek ZORUNDA.
        # `False` ise sohbet yalnizca Tezlify'dan kaldirildi.
        "remote_deleted": remote_deleted,
        "remote_error": remote_error,
    }
    logger.info(
        "Sohbet silindi (conv=%s, messages=%s, reactions=%s, remote=%s)",
        conversation_id,
        result["messages_deleted"],
        result["reactions_deleted"],
        remote_deleted,
    )
    try:
        from backend.app.api.v1.websocket import ws_manager

        await ws_manager.broadcast(
            {
                "event": "conversation_deleted",
                "user_id": user_id,
                "conversation_id": conversation_id,
            },
            target_user_id=user_id,
        )
    except Exception as exc:  # noqa: BLE001 - broadcast is best-effort
        logger.debug("Conversation delete broadcast failed (conv=%s): %s", conv.id, exc)
    return result


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
    *,
    recovery_pass: bool = False,
    only_conv_ids: Optional[Set[int]] = None,
) -> None:
    # DIKKAT — bu shim orkestratorun ayni adli metodunu GOLGELER
    # (`_get_helper` once servis niteligini tercih eder). Bu yuzden imza
    # birebir uyusmali: eksik bir parametre, cagri aninda
    # `TypeError: unexpected keyword argument` olarak patlar ve yalnizca o kod
    # yoluna girildiginde gorunur (bkz. `_sync_conversations_impl`'deki ayni
    # tuzagin duzeltmesi). `recovery_pass`/`only_conv_ids` bos sohbet geri
    # doldurma turu icin ZORUNLUDUR.
    return await _sync_orchestrator._run_bulk_message_sync(
        db, job, jid_by_conv, gateway_id, ws_session=ws_session,
        recovery_pass=recovery_pass, only_conv_ids=only_conv_ids,
    )


def _schedule_initial_sync(
    owner: str, *, reconcile: bool = False, session_key: Optional[str] = None
) -> None:
    return _sync_orchestrator._schedule_initial_sync(
        owner, reconcile=reconcile, session_key=session_key
    )


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
    session_id: Optional[int] = None,
) -> Optional[Conversation]:
    """Non-destructively reconciles and unifies legacy split conversations."""
    return await _event_orchestrator.reconcile_legacy_split_conversation(
        db, user_id, lid_jid, phone_jid, session_id=session_id
    )


async def _map_conversation_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    return await _event_orchestrator._map_conversation_event(db, event)


async def _map_session_event(db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
    return await _event_orchestrator._map_session_event(db, event)


# ---------------------------------------------------------------------------
# LID/telefon bölünmüş sohbet onarımı (yönetim ucu)
# ---------------------------------------------------------------------------
#
# Süpürme periyodik olarak kendi kendine koşar, ama operatörün "şu an bekleyen
# bir şey var mı, varsa onar" diyebileceği bir kapı yoktu: tek yol `docker exec`
# ile onarım betiğini koşturmaktı. Bu iki fonksiyon o kapıyı açar ve işi
# SÜPÜRMEYLE AYNI birleştirmeye delege eder (ikinci bir taşıma mantığı yok).
#
# Yalnızca çağıranın kiracısı görünür: `candidate_lid_split_pairs` zaten
# `user_id` kapsamıyla çalışır.

async def list_lid_split_candidates(
    db: AsyncSession, user_id: str, *, limit: int = 50  # = reconciliation.DEFAULT_REPAIR_LIMIT
) -> Dict[str, Any]:
    """Birleştirilmeyi bekleyen bölünmüş çiftleri KANITLARIYLA listeler.

    `truncated=True`, `limit`e sığmayan aday kaldığı dürüstlüğüdür: sınırlı bir
    listede "hepsi bu" demek yalan olurdu.
    """
    from backend.app.services.whatsapp.identity import contact_phone_for_jid
    from backend.app.services.whatsapp.reconciliation import candidate_lid_split_pairs

    capped = max(1, min(int(limit), 200))
    pairs = await candidate_lid_split_pairs(db, user_id=user_id, limit=capped + 1)
    truncated = len(pairs) > capped
    items: List[Dict[str, Any]] = []
    for pair in pairs[:capped]:
        display_name: Optional[str] = None
        canonical_phone = contact_phone_for_jid(pair["phone_jid"])
        if canonical_phone:
            display_name = await db.scalar(
                select(Contact.display_name).where(
                    Contact.phone_e164 == canonical_phone,
                    get_user_filter(Contact.user_id, user_id),
                )
            )
        message_count = await db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == pair["lid_conversation_id"])
        )
        unread_count = await db.scalar(
            select(Conversation.unread_count).where(
                Conversation.id == pair["lid_conversation_id"]
            )
        )
        items.append(
            {
                "lid_jid": pair["lid_jid"],
                "phone_jid": pair["phone_jid"],
                "lid_conversation_id": int(pair["lid_conversation_id"]),
                "display_name": display_name,
                "message_count": int(message_count or 0),
                "unread_count": int(unread_count or 0),
            }
        )
    return {"items": items, "total": len(items), "truncated": truncated}


async def merge_lid_splits(
    db: AsyncSession,
    user_id: str,
    *,
    lid_jid: Optional[str] = None,
    limit: int = 50,  # = reconciliation.DEFAULT_REPAIR_LIMIT
) -> Dict[str, Any]:
    """Tek istekte onarım: `lid_jid` verilirse o çift, yoksa bekleyenler.

    Her sonuç `merged` + `reason` ile dürüstçe döner. Kilit başka bir süreçte
    ise iş ERTELENİR (`reason=merge_lease_held`) ve LID sohbeti aday kalır —
    yani onarım kaybolmaz, bir sonraki tur devralır.
    """
    from backend.app.services.whatsapp.reconciliation import (
        candidate_lid_split_pairs,
        merge_split_conversation,
    )

    capped = max(1, min(int(limit), 200))
    pairs = await candidate_lid_split_pairs(db, user_id=user_id, limit=capped + 1)
    if lid_jid:
        wanted = str(lid_jid).strip()
        pairs = [
            p
            for p in pairs
            if str(p["lid_jid"]) == wanted or f"jid:{p['lid_jid']}" == wanted
        ]
    else:
        pairs = pairs[:capped]

    results: List[Dict[str, Any]] = []
    merged_count = deferred = errors = 0
    for pair in pairs:
        info: Dict[str, Any] = {}
        try:
            merged = await merge_split_conversation(
                db,
                pair["user_id"],
                pair["lid_jid"],
                pair["phone_jid"],
                session_id=None,
                lock_wait_seconds=5.0,
                result_info=info,
            )
        except Exception as exc:  # noqa: BLE001 - tek çift tüm isteği düşürmez
            await db.rollback()
            errors += 1
            results.append(
                {
                    "lid_jid": pair["lid_jid"],
                    "phone_jid": pair["phone_jid"],
                    "merged": False,
                    "reason": "merge_error",
                }
            )
            logger.warning(
                "LID onarımı başarısız (lid=%s): %s", pair["lid_jid"], exc
            )
            continue
        if merged is None:
            reason = str(info.get("skipped_reason") or "reconcile_returned_none")
            if reason == "merge_lease_held":
                deferred += 1
            else:
                errors += 1
            results.append(
                {
                    "lid_jid": pair["lid_jid"],
                    "phone_jid": pair["phone_jid"],
                    "merged": False,
                    "reason": reason,
                }
            )
            continue
        merged_count += 1
        results.append(
            {
                "lid_jid": pair["lid_jid"],
                "phone_jid": pair["phone_jid"],
                "merged": True,
                "canonical_conversation_id": int(merged.id),
                "moved_unique": info.get("moved_unique"),
                "deduped_duplicates": info.get("deduped_duplicates"),
                "stranded_after": info.get("stranded_unique"),
                "canonical_unread_count": merged.unread_count,
            }
        )
        logger.info(
            "LID onarımı (yönetim ucu): %s → %s (taşınan=%s, tekilleşen=%s)",
            pair["lid_jid"],
            pair["phone_jid"],
            info.get("moved_unique"),
            info.get("deduped_duplicates"),
        )

    return {
        "requested": len(pairs),
        "merged": merged_count,
        "deferred": deferred,
        "errors": errors,
        "results": results,
    }

