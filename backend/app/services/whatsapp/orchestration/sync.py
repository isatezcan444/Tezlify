"""WhatsApp Sync & History Orchestration Service (Phase 11.10).

Coordinates multi-phase synchronization and on-demand history hydration:
- SyncJob state machine (SYNCING -> COMPLETED / FAILED)
- Chunked background initial sync job execution (_run_sync_job)
- Streaming WebSocket progress broadcasts (_broadcast_sync_event, _sync_event)
- Bulk contact upsert & conversation snapshot creation (_persist_chat_snapshot)
- Bulk message pagination and hydration from gateway (_run_bulk_message_sync)
- On-demand history hydration for chat view & scroll (_hydrate_messages_on_demand)
- Background progressive history expansion (_run_background_history_expansion)
- Last message preview repairs (_repair_last_message_previews)
- Throttle-controlled live chats bootstrap (_schedule_chats_bootstrap)
"""
import asyncio
from datetime import datetime, timezone
import logging
import time
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Set, Tuple
import uuid

from sqlalchemy import delete, func, insert, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.services.whatsapp.exceptions import (
    NoWhatsAppSession,
    WhatsAppRelinkRequired,
)
from backend.app.services import whatsapp_gateway as gw
from backend.app.services.whatsapp.gateway import (
    is_gateway_session_missing as _is_gateway_session_missing,
)
from backend.app.services.whatsapp.identity import (
    NAME_RANK as _NAME_RANK,
    contact_phone_for_jid as _contact_phone_for_jid,
    is_broadcast_only_jid,
    is_degenerate_jid,
    is_raw_jid_name as _is_raw_jid_name,
    jid_to_phone,
    phone_to_jid,
    safe_display_name as _safe_display_name,
)
from backend.app.services.whatsapp.orchestration.messaging import (
    serialize_message as _serialize_message,
)
from backend.app.services.whatsapp.preview_normalization import (
    as_naive_utc as _as_naive_utc,
    build_last_message_summary,
    normalize_preview_text as _normalize_preview_text,
    parse_dt as _parse_dt,
)
from backend.app.services.whatsapp_profiling import profiled
from backend.app.services.whatsapp.repositories.contacts import (
    get_contact_avatar as _get_contact_avatar,
    set_contact_avatar as _set_contact_avatar,
    set_contact_name as _set_contact_name,
)
from backend.app.services.whatsapp.repositories.conversations import (
    apply_conversation_last_message as _apply_last_message,
)
from backend.app.services.whatsapp.repositories.messages import (
    build_message_from_gateway as _message_row_from_gateway,
    hydration_cursor_ms as _hydration_cursor_ms,
    msg_time as _msg_time,
    msg_time_col as _msg_time_col,
    get_sync_watermark_epoch as _sync_watermark_epoch,
)

logger = logging.getLogger(__name__)

_SYNC_BULK_PAGE_SIZE = 1000   # gateway bulk message limit per page
_SYNC_PERSIST_BATCH = 200     # dedup-SELECT + INSERT chunk size
_SYNC_EVENT_CHUNK = 100       # WS message chunk event size
_SYNC_CHAT_PAGE_SIZE = 40     # conversation snapshot page size
_SYNC_PER_CHAT_LIMIT = 50     # per-chat limit for initial hydration
_BOOTSTRAP_EMIT_INTERVAL_S = 2.0


class SyncJob:
    """Represents a single initial-sync job run with a SYNCING/COMPLETED/FAILED state machine."""

    __slots__ = (
        "sync_id",
        "user_id",
        "state",
        "stage",
        "error",
        "cancel_requested",
        "chats_total",
        "chats_synced",
        "contacts_synced",
        "messages_total",
        "messages_synced",
        "started_at",
        "finished_at",
        "done",
        "task",
        "stage_timings",
    )

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
        self.stage_timings: Dict[str, float] = {}

    def snapshot(self) -> Dict[str, Any]:
        """Returns real status for GET /sync/job and WebSocket reconnect recovery."""
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


# In-memory sync job registries & throttles
_sync_jobs: Dict[str, SyncJob] = {}
_bulk_channel_cache: Dict[str, Any] = {"ok": False, "checked_at": 0.0}
_last_bootstrap_emit: Dict[str, float] = {}
_metadata_tasks: Dict[str, asyncio.Task[None]] = {}
_sync_conversations_inflight: Set[str] = set()
_initial_sync_inflight: Set[str] = set()
_initial_sync_pending: Set[str] = set()
_history_expansion_running: Set[str] = set()
_history_expansion_done: Set[str] = set()


class WhatsAppSyncOrchestrator:
    """Coordinates multi-phase synchronization and on-demand history hydration."""

    def __init__(self, service: Optional[Any] = None) -> None:
        self.service = service
        self._sync_jobs = _sync_jobs
        self._bulk_channel_cache = _bulk_channel_cache
        self._last_bootstrap_emit = _last_bootstrap_emit
        self._metadata_tasks = _metadata_tasks
        self._sync_conversations_inflight = _sync_conversations_inflight
        self._initial_sync_inflight = _initial_sync_inflight
        self._initial_sync_pending = _initial_sync_pending
        self._history_expansion_running = _history_expansion_running
        self._history_expansion_done = _history_expansion_done

    def _get_helper(self, name: str, default: Any) -> Any:
        if self.service is not None:
            return getattr(self.service, name, default)
        return default

    async def _bulk_channel_available(self, gateway_id: str) -> bool:
        gateway_client = self._get_helper("gw", gw)
        now = time.monotonic()
        if now - float(self._bulk_channel_cache.get("checked_at") or 0.0) < 300:
            return bool(self._bulk_channel_cache.get("ok"))
        try:
            probe = await gateway_client.list_all_messages(gateway_id, limit=1, offset=0)
            ok = isinstance(probe, dict) and "messages" in probe
        except Exception as exc:
            ok = False
            logger.warning(
                "WhatsApp bulk mesaj kanali kullanilamiyor; legacy sync fallback (gateway=%s): %s",
                gateway_id,
                exc,
            )
        self._bulk_channel_cache["ok"] = ok
        self._bulk_channel_cache["checked_at"] = now
        return ok

    async def _broadcast_sync_event(self, payload: Dict[str, Any], owner: str) -> None:
        try:
            from backend.app.api.v1.websocket import ws_manager
            broadcast_fn = getattr(ws_manager, "broadcast", None)
            if broadcast_fn is not None:
                sent = await ws_manager.broadcast(payload, target_user_id=owner)
                if sent == 0:
                    logger.debug(
                        "Sync olayi teslim edilecek soket bulamadi (event=%s, owner=%s)",
                        payload.get("event"),
                        owner,
                    )
        except Exception as exc:
            logger.warning("Sync olayi yayilamadi (%s): %s", payload.get("event"), exc)

    def _sync_event(self, job: SyncJob, event: str, **fields: Any) -> Dict[str, Any]:
        return {"event": event, "sync_id": job.sync_id, "user_id": job.user_id, **fields}

    async def request_sync(self, db: AsyncSession, user_id: str) -> SyncJob:
        owner = str(user_id)
        job = self._sync_jobs.get(owner)
        if job is not None and job.state == "SYNCING":
            return job
        job = SyncJob(sync_id=uuid.uuid4().hex, user_id=owner)
        self._sync_jobs[owner] = job
        run_sync_job = self._get_helper("_run_sync_job", self._run_sync_job)
        job.task = asyncio.create_task(run_sync_job(job))
        return job

    def get_sync_job(self, user_id: str) -> Optional[Dict[str, Any]]:
        job = self._sync_jobs.get(str(user_id))
        return job.snapshot() if job else None

    def _cancel_stale_sync_jobs(self, user_id: str) -> int:
        self._initial_sync_pending.discard(str(user_id))
        job = self._sync_jobs.get(str(user_id))
        if job is None or job.state != "SYNCING":
            return 0
        job.cancel_requested = True
        return 1

    async def _reapply_chat_names(
        self, db: AsyncSession, owner: str, items: List[Dict[str, Any]]
    ) -> None:
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

    def _schedule_metadata_enrichment(self, gateway_id: str) -> None:
        if gateway_id in self._metadata_tasks:
            return
        gateway_client = self._get_helper("gw", gw)

        async def enrich() -> None:
            try:
                await gateway_client.sync_group_subjects(gateway_id, force=True)
            except Exception as exc:
                logger.warning("Background group enrichment failed (session=%s): %s", gateway_id, exc)
            finally:
                self._metadata_tasks.pop(gateway_id, None)

        self._metadata_tasks[gateway_id] = asyncio.create_task(enrich())

    def _schedule_chats_bootstrap(self, owner: str) -> None:
        now = time.monotonic()
        last = self._last_bootstrap_emit.get(owner)
        if last is not None and now - last < _BOOTSTRAP_EMIT_INTERVAL_S:
            return
        self._last_bootstrap_emit[owner] = now

        broadcast_sync_event = self._get_helper("_broadcast_sync_event", self._broadcast_sync_event)

        async def _emit() -> None:
            await broadcast_sync_event(
                {
                    "event": "whatsapp_sync_chats_bootstrap",
                    "sync_id": "live",
                    "user_id": owner,
                    "at": datetime.now(timezone.utc).isoformat(),
                },
                owner,
            )

        try:
            asyncio.get_running_loop().create_task(_emit())
        except RuntimeError:
            pass

    async def _repair_last_message_previews(self, db: AsyncSession, user_id: str) -> int:
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
                continue
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
            conv.last_message_preview = summary[:500]
            ts = _as_naive_utc(newest.external_timestamp or newest.sent_at or newest.created_at)
            if ts is not None:
                conv.last_message_at = ts
            fixed += 1
        if fixed:
            await db.flush()
            logger.info("Faz 10 preview onarimi: %d sohbet guncellendi (owner=%s)", fixed, user_id)
        return fixed

    async def _bulk_upsert_contacts(
        self,
        db: AsyncSession,
        user_id: str,
        items: List[Tuple[str, Optional[str], Optional[str], Optional[str]]],
    ) -> List[Tuple[str, Contact]]:
        resolved: List[Tuple[str, str, Optional[str], Optional[str], Optional[str]]] = []
        for jid, name, source, avatar in items:
            jid_str = str(jid)
            if is_degenerate_jid(jid_str):
                continue
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
                legacy = jid_to_phone(jid_str)
                if legacy:
                    contact = by_phone.get(legacy)
                    if contact is not None:
                        contact.phone_e164 = phone
            if contact is None:
                contact = Contact(
                    user_id=user_id,
                    phone_e164=phone,
                    display_name=(None if _is_raw_jid_name(name) else name) or jid_to_phone(jid_str),
                )
                if name and str(source or "") in _NAME_RANK:
                    contact.custom_attributes = {"name_source": str(source)}
                by_phone[phone] = contact
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
        self,
        db: AsyncSession,
        user_id: str,
        contacts: List[Tuple[str, Contact]],
        session_id: Optional[int] = None,
    ) -> List[Tuple[str, Contact, Conversation]]:
        contact_ids = [c.id for _jid, c in contacts if c.id is not None]
        by_contact: Dict[int, Conversation] = {}
        if contact_ids:
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
                    session_id=session_id,
                    is_group="@g.us" in jid_str,
                    is_archived=False,
                    last_message_at=None,
                )
                pending_conversations.append(conv)
                if contact.id is not None:
                    by_contact[contact.id] = conv
            out.append((jid_str, contact, conv))
        if pending_conversations:
            try:
                async with db.begin_nested():
                    for conv in pending_conversations:
                        db.add(conv)
                    await db.flush()
            except IntegrityError:
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
                for conv in res.scalars().all():
                    by_contact[int(conv.contact_id)] = conv
                out = []
                for jid_str, contact in contacts:
                    conv = by_contact.get(contact.id)
                    out.append((jid_str, contact, conv))
                await db.flush()
        return out

    async def sync_contacts(
        self,
        db: AsyncSession,
        user_id: str,
        session: Optional[WhatsAppSession] = None,
    ) -> List[Dict[str, Any]]:
        require_user_session = self._get_helper("_require_user_session", None)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", None)
        bulk_upsert_contacts = self._get_helper("_bulk_upsert_contacts", self._bulk_upsert_contacts)
        gateway_client = self._get_helper("gw", gw)

        row = session or (await require_user_session(db, user_id) if require_user_session else None)
        if gateway_op_or_mark_relink is not None:
            gw_contacts = await gateway_op_or_mark_relink(db, row, lambda gid: gateway_client.list_contacts(gid))
        else:
            gw_contacts = await gateway_client.list_contacts(str(row.gateway_id) if row else "")
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
        resolved = await bulk_upsert_contacts(db, user_id, items)
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

    async def _persist_chat_snapshot(
        self,
        db: AsyncSession,
        owner: str,
        items: List[Dict[str, Any]],
        session_id: Optional[int] = None,
    ) -> Tuple[List[Dict[str, Any]], Dict[int, str]]:
        bulk_upsert_contacts = self._get_helper("_bulk_upsert_contacts", self._bulk_upsert_contacts)
        ensure_conversations_bulk = self._get_helper("_ensure_conversations_bulk", self._ensure_conversations_bulk)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)

        candidates: List[Dict[str, Any]] = []
        for item in items:
            jid = item.get("jid") or item.get("id")
            if not jid or "@" not in str(jid):
                continue
            if is_degenerate_jid(str(jid)):
                continue
            if is_broadcast_only_jid(str(jid)):
                continue
            candidates.append(item)
        contacts = await bulk_upsert_contacts(
            db,
            owner,
            [
                (
                    str(item.get("jid") or item.get("id")),
                    item.get("name"),
                    item.get("name_source"),
                    item.get("avatar_url"),
                )
                for item in candidates
            ],
        )
        item_by_jid: Dict[str, Dict[str, Any]] = {
            str(item.get("jid") or item.get("id")): item for item in candidates
        }
        triples = await ensure_conversations_bulk(db, owner, contacts, session_id=session_id)
        out: List[Dict[str, Any]] = []
        jid_by_conv: Dict[int, str] = {}
        for jid_str, contact, conv in triples:
            item = item_by_jid.get(jid_str)
            if item is None:
                continue
            gw_ts = _as_naive_utc(_parse_dt(str(item.get("last_message_at")))) if item.get("last_message_at") else None
            gw_summary = _normalize_preview_text(item.get("message_type") or "TEXT", item.get("last_message_preview") or "")
            if gw_summary:
                if conv.last_message_at is None or (gw_ts and gw_ts > conv.last_message_at):
                    apply_last_message(conv, gw_ts, gw_summary)
                elif not conv.last_message_preview:
                    apply_last_message(conv, None, gw_summary)
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

    async def _run_bulk_message_sync(
        self,
        db: AsyncSession,
        job: SyncJob,
        jid_by_conv: Dict[int, str],
        gateway_id: str,
        ws_session: Optional[WhatsAppSession] = None,
    ) -> None:
        gateway_client = self._get_helper("gw", gw)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", None)
        message_row_from_gateway = self._get_helper("_message_row_from_gateway", _message_row_from_gateway)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)
        serialize_message = self._get_helper("_serialize_message", _serialize_message)
        broadcast_sync_event = self._get_helper("_broadcast_sync_event", self._broadcast_sync_event)
        sync_event = self._get_helper("_sync_event", self._sync_event)

        conv_by_jid: Dict[str, int] = {}
        for cid, jid_str in jid_by_conv.items():
            conv_by_jid[jid_str] = cid
        conv_by_id: Dict[int, Conversation] = {}
        existing_ids: Dict[int, Set[str]] = {}
        dedup_loaded: Set[int] = set()

        since_epoch = await _sync_watermark_epoch(db, job.user_id)

        offset = 0
        first_page = True
        while True:
            if ws_session is not None and gateway_op_or_mark_relink is not None:
                page = await gateway_op_or_mark_relink(
                    db,
                    ws_session,
                    lambda gid: gateway_client.list_all_messages(
                        gid,
                        limit=_SYNC_BULK_PAGE_SIZE,
                        offset=offset,
                        since=since_epoch,
                        per_chat_limit=_SYNC_PER_CHAT_LIMIT,
                    ),
                )
            else:
                page = await gateway_client.list_all_messages(
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
            pending: Dict[int, List[Dict[str, Any]]] = {}
            for gm in msgs:
                jid_str = str(gm.get("conversation_id") or "")
                cid = conv_by_jid.get(jid_str)
                if cid is None:
                    continue
                pending.setdefault(cid, []).append(gm)
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
                loaded = await db.execute(
                    select(Conversation).where(
                        Conversation.id.in_(batch),
                        get_user_filter(Conversation.user_id, job.user_id),
                    )
                )
                conv_by_id.update({conv.id: conv for conv in loaded.scalars().all()})
            rows: List[Tuple[Message, Dict[str, Any]]] = []
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
                    row = message_row_from_gateway(job.user_id, conv, gm)
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
                    apply_last_message(conv, _parse_dt(gm.get("created_at")), summary)
                touched.add(cid)
            serialized: List[Dict[str, Any]] = []
            if rows:
                persisted_rows: List[Message] = []
                for batch_start in range(0, len(rows), _SYNC_PERSIST_BATCH):
                    values = [
                        {
                            column.name: getattr(row, column.name)
                            for column in Message.__table__.columns
                            if column.name != "id" and getattr(row, column.name) is not None
                        }
                        for row, _ in rows[batch_start:batch_start + _SYNC_PERSIST_BATCH]
                    ]
                    inserted = await db.scalars(insert(Message).returning(Message), values)
                    persisted_rows.extend(inserted.all())
                await db.flush()
                await db.commit()
                serialized = [serialize_message(r) for r in persisted_rows]
                job.messages_synced += len(rows)
            for chunk_start in range(0, len(serialized), _SYNC_EVENT_CHUNK):
                await broadcast_sync_event(
                    sync_event(
                        job,
                        "whatsapp_sync_messages_chunk",
                        conversation_ids=sorted(touched),
                        messages=serialized[chunk_start:chunk_start + _SYNC_EVENT_CHUNK],
                        total=job.messages_total,
                        synced=job.messages_synced,
                    ),
                    job.user_id,
                )
            await broadcast_sync_event(
                sync_event(
                    job,
                    "whatsapp_sync_progress",
                    stage=job.stage,
                    chats_total=job.chats_total,
                    chats_synced=job.chats_synced,
                    contacts_synced=job.contacts_synced,
                    messages_total=job.messages_total,
                    messages_synced=job.messages_synced,
                ),
                job.user_id,
            )
            offset += len(msgs)
            if offset >= total:
                break
            if job.cancel_requested:
                raise asyncio.CancelledError()

    @profiled("initial_sync")
    async def _run_sync_job(self, job: SyncJob) -> None:
        owner = job.user_id
        session_factory = self._get_helper("AsyncSessionLocal", AsyncSessionLocal)
        user_sessions = self._get_helper("_user_sessions", None)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", None)
        gateway_client = self._get_helper("gw", gw)
        persist_chat_snapshot = self._get_helper("_persist_chat_snapshot", self._persist_chat_snapshot)
        sync_contacts = self._get_helper("sync_contacts", self.sync_contacts)
        reapply_chat_names = self._get_helper("_reapply_chat_names", self._reapply_chat_names)
        bulk_channel_available = self._get_helper("_bulk_channel_available", self._bulk_channel_available)
        run_bulk_message_sync = self._get_helper("_run_bulk_message_sync", self._run_bulk_message_sync)
        sync_conversations_impl = self._get_helper("_sync_conversations_impl", self._sync_conversations_impl)
        repair_last_message_previews = self._get_helper("_repair_last_message_previews", self._repair_last_message_previews)
        list_conversations = self._get_helper("list_conversations", None)
        schedule_metadata_enrichment = self._get_helper("_schedule_metadata_enrichment", self._schedule_metadata_enrichment)
        run_background_history_expansion = self._get_helper("_run_background_history_expansion", self._run_background_history_expansion)
        broadcast_sync_event = self._get_helper("_broadcast_sync_event", self._broadcast_sync_event)
        sync_event = self._get_helper("_sync_event", self._sync_event)

        try:
            async with session_factory() as db:
                await broadcast_sync_event(
                    sync_event(job, "whatsapp_sync_started", started_at=job.started_at.isoformat()),
                    owner,
                )
                phase_t0 = time.monotonic()

                def _mark_phase(name: str) -> None:
                    nonlocal phase_t0
                    now = time.monotonic()
                    job.stage_timings[name] = round(job.stage_timings.get(name, 0.0) + (now - phase_t0), 3)
                    phase_t0 = now

                sessions_to_sync = await user_sessions(db, owner, connected_only=True) if user_sessions else []
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
                    job.stage = "chats"
                    if gateway_op_or_mark_relink is not None:
                        data = await gateway_op_or_mark_relink(
                            db, ws_session, lambda gid: gateway_client.list_conversations(gid)
                        )
                    else:
                        data = await gateway_client.list_conversations(gateway_id)
                    items = data.get("items", []) if isinstance(data, dict) else []
                    all_items.extend(items)
                    session_convs, session_jids = await persist_chat_snapshot(
                        db, owner, items, session_id=ws_session.id
                    )
                    conv_out.extend(session_convs)
                    jid_by_conv.update(session_jids)
                    job.chats_total = len(conv_out)
                    job.chats_synced = len(conv_out)
                    if job.cancel_requested:
                        raise asyncio.CancelledError()
                    for page_start in range(0, len(session_convs), _SYNC_CHAT_PAGE_SIZE):
                        await broadcast_sync_event(
                            sync_event(
                                job,
                                "whatsapp_sync_chats_snapshot",
                                total=job.chats_total,
                                conversations=session_convs[page_start:page_start + _SYNC_CHAT_PAGE_SIZE],
                            ),
                            owner,
                        )
                    _mark_phase("chats")

                    schedule_metadata_enrichment(gateway_id)
                    _mark_phase("group_subjects")

                    job.stage = "contacts"
                    try:
                        session_contacts = await sync_contacts(db, owner, session=ws_session)
                        contacts.extend(session_contacts)
                        job.contacts_synced = len(contacts)
                    except WhatsAppRelinkRequired:
                        raise
                    except Exception as exc:
                        logger.warning("Sync job rehber adimi atlandi (owner=%s hat=%s): %s", owner, ws_session.id, exc)
                    if job.cancel_requested:
                        raise asyncio.CancelledError()
                    await broadcast_sync_event(
                        sync_event(
                            job,
                            "whatsapp_sync_contacts_snapshot",
                            total=job.contacts_synced,
                            contacts=contacts[:_SYNC_EVENT_CHUNK],
                        ),
                        owner,
                    )
                    _mark_phase("contacts")

                    try:
                        await reapply_chat_names(db, owner, items)
                    except Exception as exc:
                        logger.warning("Sync job ad onarimi atlandi (owner=%s): %s", owner, exc)

                    job.stage = "messages"
                    if await bulk_channel_available(gateway_id):
                        await run_bulk_message_sync(db, job, session_jids, gateway_id, ws_session=ws_session)
                    else:
                        logger.warning("Gateway bulk kanali yok — legacy per-chat sync (owner=%s)", owner)
                        await sync_conversations_impl(db, owner)
                    if job.cancel_requested:
                        raise asyncio.CancelledError()
                    _mark_phase("messages")

                items = all_items
                job.stage = "finalizing"
                await repair_last_message_previews(db, owner)
                await db.commit()
                result, _total = (await list_conversations(db, owner)) if list_conversations else ([], 0)
                _mark_phase("finalizing")
                job.state = "COMPLETED"
                job.stage = "complete"
                job.finished_at = datetime.now(timezone.utc)
                await broadcast_sync_event(
                    sync_event(
                        job,
                        "whatsapp_sync_complete",
                        conversations=result,
                        chats_synced=job.chats_synced,
                        contacts_synced=job.contacts_synced,
                        messages_synced=job.messages_synced,
                        finished_at=job.finished_at.isoformat(),
                        stage_timings=dict(job.stage_timings),
                        duration_s=round((job.finished_at - job.started_at).total_seconds(), 3),
                    ),
                    owner,
                )
                logger.info(
                    "Sync job tamamlandi (owner=%s sync_id=%s chats=%s msgs=%s sure=%ss fazlar=%s)",
                    owner,
                    job.sync_id,
                    job.chats_synced,
                    job.messages_synced,
                    round((job.finished_at - job.started_at).total_seconds(), 1),
                    job.stage_timings,
                )
                asyncio.create_task(run_background_history_expansion(owner, gateway_id))
        except WhatsAppRelinkRequired as exc:
            job.state = "FAILED"
            job.error = str(exc)
            job.finished_at = datetime.now(timezone.utc)
            logger.warning(
                "Sync job oturum kayip - yeniden eslestirme gerekli (owner=%s sync_id=%s): %s",
                owner,
                job.sync_id,
                exc,
            )
            await broadcast_sync_event(
                sync_event(
                    job, "whatsapp_sync_failed", error=job.error, error_code="RELINK_REQUIRED", stage=job.stage
                ),
                owner,
            )
        except asyncio.CancelledError:
            job.state = "FAILED"
            job.error = "sync iptal edildi"
            job.finished_at = datetime.now(timezone.utc)
            logger.info("Sync job iptal edildi (owner=%s sync_id=%s)", owner, job.sync_id)
            await broadcast_sync_event(
                sync_event(job, "whatsapp_sync_failed", error=job.error, stage=job.stage), owner
            )
        except Exception as exc:
            job.state = "FAILED"
            job.error = str(exc)[:500]
            job.finished_at = datetime.now(timezone.utc)
            logger.warning("Sync job basarisiz (owner=%s sync_id=%s): %s", owner, job.sync_id, exc)
            err_code = "RELINK_REQUIRED" if _is_gateway_session_missing(exc) else None
            sync_payload = sync_event(job, "whatsapp_sync_failed", error=job.error, stage=job.stage)
            if err_code:
                sync_payload["error_code"] = err_code
            await broadcast_sync_event(sync_payload, owner)
        finally:
            job.done.set()

    def _schedule_initial_sync(self, owner: str, *, reconcile: bool = False) -> None:
        if owner in self._initial_sync_inflight:
            if reconcile:
                self._initial_sync_pending.add(owner)
            return
        self._initial_sync_inflight.add(owner)
        run_initial_sync = self._get_helper("_run_initial_sync", self._run_initial_sync)
        asyncio.create_task(run_initial_sync(owner))

    async def _run_initial_sync(self, owner: str) -> None:
        session_factory = self._get_helper("AsyncSessionLocal", AsyncSessionLocal)
        request_sync = self._get_helper("request_sync", self.request_sync)
        try:
            async with session_factory() as db:
                job = await request_sync(db, owner)
                await asyncio.shield(job.done.wait())
            if job.state == "COMPLETED":
                logger.info("Initial-sync hydration tamamlandi (owner=%s)", owner)
                try:
                    from backend.app.api.v1.websocket import ws_manager
                    await ws_manager.broadcast({"event": "conversations_updated", "user_id": owner})
                    await ws_manager.broadcast({"event": "session_updated", "user_id": owner})
                except Exception as exc:
                    logger.warning("Initial-sync broadcast basarisiz (owner=%s): %s", owner, exc)
            else:
                logger.warning("Initial-sync hydration basarisiz (owner=%s): %s", owner, job.error)
        except asyncio.CancelledError:
            self._initial_sync_pending.discard(owner)
            raise
        except Exception as exc:
            logger.warning("Initial-sync hydration beklenemedi (owner=%s): %s", owner, exc)
        finally:
            self._initial_sync_inflight.discard(owner)
            if owner in self._initial_sync_pending:
                self._initial_sync_pending.discard(owner)
                self._schedule_initial_sync(owner)

    async def _run_background_history_expansion(self, user_id: str, gateway_id: str) -> None:
        if user_id in self._history_expansion_running or user_id in self._history_expansion_done:
            return
        self._history_expansion_running.add(user_id)
        session_factory = self._get_helper("AsyncSessionLocal", AsyncSessionLocal)
        hydrate_messages_on_demand = self._get_helper("_hydrate_messages_on_demand", self._hydrate_messages_on_demand)
        logger.info("Starting background history expansion for user=%s, gateway=%s", user_id, gateway_id)
        try:
            async with session_factory() as db:
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
                    async with session_factory() as db:
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
                                await hydrate_messages_on_demand(
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
            self._history_expansion_done.add(user_id)
        except Exception as exc:
            logger.warning("Background history expansion failed: %s", exc)
        finally:
            self._history_expansion_running.discard(user_id)

    async def sync_conversations(self, db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
        list_conversations = self._get_helper("list_conversations", None)
        sync_conversations_impl = self._get_helper("_sync_conversations_impl", self._sync_conversations_impl)
        if user_id in self._sync_conversations_inflight:
            if list_conversations:
                result, _total = await list_conversations(db, user_id)
                return result
            return []
        self._sync_conversations_inflight.add(user_id)
        try:
            return await sync_conversations_impl(db, user_id)
        finally:
            self._sync_conversations_inflight.discard(user_id)

    async def _sync_conversations_impl(self, db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
        require_user_session = self._get_helper("_require_user_session", None)
        sync_contacts = self._get_helper("sync_contacts", self.sync_contacts)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", None)
        gateway_client = self._get_helper("gw", gw)
        upsert_contact = self._get_helper("_upsert_contact", None)
        ensure_conversation = self._get_helper("_ensure_conversation", None)
        persist_gateway_message = self._get_helper("_persist_gateway_message", None)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)
        repair_last_message_previews = self._get_helper("_repair_last_message_previews", self._repair_last_message_previews)
        list_conversations = self._get_helper("list_conversations", None)

        session_row = await require_user_session(db, user_id)
        gateway_id = str(session_row.gateway_id)
        try:
            await sync_contacts(db, user_id, session=session_row)
        except WhatsAppRelinkRequired:
            raise
        except Exception as exc:
            logger.warning("Rehber senkronu atlandi (sohbet senkronu suruyor): %s", exc)
        try:
            if gateway_op_or_mark_relink is not None:
                await gateway_op_or_mark_relink(
                    db, session_row, lambda gid: gateway_client.sync_group_subjects(gid, force=True)
                )
            else:
                await gateway_client.sync_group_subjects(gateway_id, force=True)
        except WhatsAppRelinkRequired:
            raise
        except Exception as exc:
            logger.warning("Grup basliklari senkronu atlandi: %s", exc)
        if gateway_op_or_mark_relink is not None:
            data = await gateway_op_or_mark_relink(
                db, session_row, lambda gid: gateway_client.list_conversations(gid)
            )
        else:
            data = await gateway_client.list_conversations(gateway_id)
        items = data.get("items", []) if isinstance(data, dict) else []
        owner = user_id
        for item in items:
            jid = item.get("jid") or item.get("id")
            if not jid or "@" not in str(jid):
                continue
            jid_str = str(jid)
            if is_broadcast_only_jid(jid_str):
                continue
            if is_degenerate_jid(jid_str):
                continue
            preview_raw = item.get("last_message_preview") or ""
            chat_name = item.get("name")
            contact = await upsert_contact(db, user_id, jid_str, chat_name, item.get("name_source"))
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
                conv = await ensure_conversation(db, user_id, jid_str, session_id=session_row.id)
            try:
                msg_data = await gateway_client.get_messages(gateway_id, jid_str, limit=_SYNC_PER_CHAT_LIMIT)
                gw_messages = msg_data.get("messages", []) if isinstance(msg_data, dict) else []
                for gm in gw_messages:
                    gm = dict(gm)
                    gm.setdefault("conversation_id", jid_str)
                    await persist_gateway_message(db, owner, gm)
            except Exception as exc:
                logger.warning("Sohbet gecmisi cekilemedi (%s): %s", jid_str, exc)
            gw_ts = _as_naive_utc(_parse_dt(str(item.get("last_message_at")))) if item.get("last_message_at") else None
            gw_summary = _normalize_preview_text(item.get("message_type") or "TEXT", preview_raw)
            if gw_summary:
                if conv.last_message_at is None or (gw_ts and gw_ts > conv.last_message_at):
                    apply_last_message(conv, gw_ts, gw_summary)
                elif not conv.last_message_preview:
                    apply_last_message(conv, None, gw_summary)
            conv.is_group = bool(item.get("is_group")) or "@g.us" in jid_str
            if "archived" in item:
                conv.is_archived = bool(item.get("archived"))
            unread = int(item.get("unread_count") or 0)
            conv.unread_count = max(conv.unread_count or 0, unread)
            await db.flush()
        await repair_last_message_previews(db, user_id)
        await db.commit()
        if list_conversations:
            result, _total = await list_conversations(db, user_id)
            return result
        return []

    async def _hydrate_messages_on_demand(
        self,
        db: AsyncSession,
        owner: str,
        conv: Conversation,
        limit: int,
        before_ts_ms: Optional[int] = None,
        oldest_msg_id: Optional[str] = None,
        oldest_msg_from_me: Optional[bool] = None,
    ) -> List[Message]:
        conversation_session = self._get_helper("_conversation_session", None)
        gateway_op_or_mark_relink = self._get_helper("_gateway_op_or_mark_relink", None)
        gateway_client = self._get_helper("gw", gw)
        message_row_from_gateway = self._get_helper("_message_row_from_gateway", _message_row_from_gateway)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)

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
            session_row = (await conversation_session(db, owner, conv)) if conversation_session else None
            if gateway_op_or_mark_relink is not None and session_row is not None:
                data = await gateway_op_or_mark_relink(
                    db,
                    session_row,
                    lambda gid: gateway_client.get_messages(
                        gid,
                        jid,
                        limit=min(max(int(limit), 1), 100),
                        before=before_ts_ms,
                        fetch_provider=True,
                        oldest_msg_id=oldest_msg_id,
                        oldest_msg_from_me=oldest_msg_from_me,
                        oldest_msg_ts_ms=before_ts_ms,
                    ),
                )
            else:
                data = await gateway_client.get_messages(
                    str(session_row.gateway_id) if session_row else "",
                    jid,
                    limit=min(max(int(limit), 1), 100),
                    before=before_ts_ms,
                    fetch_provider=True,
                    oldest_msg_id=oldest_msg_id,
                    oldest_msg_from_me=oldest_msg_from_me,
                    oldest_msg_ts_ms=before_ts_ms,
                )
        except Exception as exc:
            logger.warning("On-demand hydrasyon basarisiz (conv=%s): %s", conv.id, exc)
            raise
        if not isinstance(data, dict):
            raise RuntimeError("Gateway returned an invalid messages response.")
        gw_msgs = data.get("messages", [])
        if not isinstance(gw_msgs, list):
            raise RuntimeError("Gateway returned an invalid messages payload.")
        if not gw_msgs:
            return []
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
            row = message_row_from_gateway(owner, conv, gm)
            if row is None:
                continue
            if wa:
                have.add(str(wa))
            rows.append(row)
        if not rows:
            return []
        rows.sort(key=lambda r: (r.external_timestamp or r.created_at, r.id or 0))
        db.add_all(rows)
        await db.flush()
        summary_src = rows[-1]
        apply_last_message(
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


# Module-level default instance
_default_sync_orchestrator = WhatsAppSyncOrchestrator()

request_sync = _default_sync_orchestrator.request_sync
get_sync_job = _default_sync_orchestrator.get_sync_job
sync_contacts = _default_sync_orchestrator.sync_contacts
sync_conversations = _default_sync_orchestrator.sync_conversations
_sync_conversations_impl = _default_sync_orchestrator._sync_conversations_impl
_hydrate_messages_on_demand = _default_sync_orchestrator._hydrate_messages_on_demand
_run_sync_job = _default_sync_orchestrator._run_sync_job
_run_bulk_message_sync = _default_sync_orchestrator._run_bulk_message_sync
_persist_chat_snapshot = _default_sync_orchestrator._persist_chat_snapshot
_bulk_upsert_contacts = _default_sync_orchestrator._bulk_upsert_contacts
_ensure_conversations_bulk = _default_sync_orchestrator._ensure_conversations_bulk
_repair_last_message_previews = _default_sync_orchestrator._repair_last_message_previews
_cancel_stale_sync_jobs = _default_sync_orchestrator._cancel_stale_sync_jobs
_schedule_initial_sync = _default_sync_orchestrator._schedule_initial_sync
_run_initial_sync = _default_sync_orchestrator._run_initial_sync
_schedule_chats_bootstrap = _default_sync_orchestrator._schedule_chats_bootstrap
_schedule_metadata_enrichment = _default_sync_orchestrator._schedule_metadata_enrichment
_reapply_chat_names = _default_sync_orchestrator._reapply_chat_names
_run_background_history_expansion = _default_sync_orchestrator._run_background_history_expansion
_bulk_channel_available = _default_sync_orchestrator._bulk_channel_available
_broadcast_sync_event = _default_sync_orchestrator._broadcast_sync_event
_sync_event = _default_sync_orchestrator._sync_event
