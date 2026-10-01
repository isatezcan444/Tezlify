"""WhatsApp Inbound Gateway Event Orchestration Service (Phase 11.10).

Handles all incoming events from the Baileys gateway (/ws/gateway):
- Inbound & outbound messages (message_new / message_upsert)
- Split conversation reconciliation (LID vs Phone JID)
- Conversation & presence updates (conversation_updated, presence_updated)
- Session lifecycle & connection state (session_connected, connection_error, etc.)
- Contact synchronization (contact_synced)
- Deduplication and idempotency tracking (processed_events table)
- Fail-closed orphan event handling (EventOwnerUnresolved -> rollback), with a
  bounded replay queue so an event whose owner is only *not yet* resolvable is
  held and retried instead of being discarded
"""
from collections import deque
from datetime import datetime
import logging
import time
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Tuple
import uuid

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message_reaction import MessageReaction
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.exceptions import EventOwnerUnresolved
from backend.app.services.whatsapp.identity import (
    NAME_RANK as _NAME_RANK,
    SYSTEM_USER_ID,
    contact_phone_for_jid as _contact_phone_for_jid,
    is_broadcast_only_jid,
    is_degenerate_jid,
    is_raw_jid_name as _is_raw_jid_name,
    is_self_identity as _is_self_identity,
    resolve_contact_identity as _resolve_contact_identity,
    strip_jid_prefix as _strip_jid_prefix,
    jid_to_phone,
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
    apply_conversation_unread_count as _apply_unread_count,
    find_whatsapp_conversation as _find_whatsapp_conversation,
    get_conversation_scope_filters as _conversation_scope_filters,
)
from backend.app.services.whatsapp.repositories.lid_mappings import (
    resolve_lid_phone as _resolve_lid_phone,
)
from backend.app.services.whatsapp.repositories.reactions import (
    conversation_reaction as _conversation_reaction,
    reaction_identity as _reaction_identity,
    upsert_reaction as _upsert_reaction,
)
from backend.app.services.whatsapp.repositories.messages import (
    build_message_from_gateway as _message_row_from_gateway,
    message_exists_by_wa_id,
)
from backend.app.services.whatsapp.repositories.sessions import (
    resolve_event_owner as _resolve_event_owner,
    resolve_event_owner_and_session as _resolve_event_owner_and_session,
)
from backend.app.services.whatsapp.status_policy import (
    advance_message_status as _advance_message_status,
)

logger = logging.getLogger(__name__)

# Events that are intentionally not persisted but must reach the UI
_PASSTHROUGH_EVENTS: FrozenSet[str] = frozenset({"history_sync_completed"})

# Rate-limit suppression for orphan event logging to avoid log flood
_orphan_suppressed: Dict[str, Dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Deferred provider ACKs
# ---------------------------------------------------------------------------
# A `message_status_updated` event can arrive BEFORE the `message_new` that
# carries its message record: WhatsApp acknowledges a message while its upsert
# is still travelling, and the gateway forwards both independently (a reconnect
# or a busy provider can widen the gap to seconds).
#
# The old code raised `LookupError("Provider ACK precedes its message record;
# retry required")`. Nothing retried — the dispatcher caught it as a generic
# failure and DROPPED the event for good: the thread kept its old status
# forever, and the log filled with errors for ACKs that had a perfectly good
# home a moment later.
#
# The ACK is not wrong and it is not lost work; it is early. Buffer it under the
# identities it carries, and apply it the moment the record is created (or the
# dedup path finds it). Bounded TTL + size keep a never-arriving message from
# leaking memory.
_DEFERRED_STATUS_TTL_S = 300.0
_DEFERRED_STATUS_MAX_KEYS = 1000
_deferred_status_updates: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def _status_identity_keys(event: Dict[str, Any]) -> List[str]:
    """Identity keys under which an ACK — or a message row — can be found."""
    keys: List[str] = []
    wa_id = event.get("wa_message_id")
    client_mid = event.get("client_message_id")
    if wa_id:
        keys.append(f"wa:{wa_id}")
    if client_mid:
        keys.append(f"client:{client_mid}")
    return keys


def defer_status_update(event: Dict[str, Any]) -> None:
    """Buffers an early provider ACK until its message record exists."""
    now = time.monotonic()
    expired = [
        key for key, (seen_at, _) in _deferred_status_updates.items()
        if now - seen_at > _DEFERRED_STATUS_TTL_S
    ]
    for key in expired:
        _deferred_status_updates.pop(key, None)
    payload = dict(event)
    keys = _status_identity_keys(payload)
    if not keys:
        # Nothing to key on; the ACK can never be matched to a record.
        return
    # Evict oldest entries (by first-seen time) until there is room for the
    # whole payload. Inserting under every key means the same payload object
    # may occupy more than one slot.
    while len(_deferred_status_updates) + len(keys) > _DEFERRED_STATUS_MAX_KEYS:
        oldest = min(_deferred_status_updates.items(), key=lambda item: item[1][0], default=None)
        if oldest is None:
            break
        _deferred_status_updates.pop(oldest[0], None)
    for key in keys:
        _deferred_status_updates[key] = (now, payload)


def _consume_deferred_status(row: Message) -> Optional[Dict[str, Any]]:
    """Removes and returns the buffered ACK that belongs to `row`, if any.

    The payload is stored under every identity it carries, so a hit on one key
    must remove its siblings too — otherwise the same ACK would be applied
    twice (once via `wa:` and once via `client:`).
    """
    keys = _status_identity_keys({
        "wa_message_id": row.wa_message_id,
        "client_message_id": row.client_message_id,
    })
    hit: Optional[Dict[str, Any]] = None
    for key in keys:
        entry = _deferred_status_updates.pop(key, None)
        if entry is None:
            continue
        payload = entry[1]
        if hit is None:
            hit = payload
        for sibling in list(_deferred_status_updates):
            if _deferred_status_updates[sibling][1] is payload:
                _deferred_status_updates.pop(sibling, None)
    return hit


def apply_deferred_status(
    row: Message,
    advance: Callable[[Any, Optional[str]], bool] = _advance_message_status,
) -> bool:
    """Applies a buffered early ACK to a freshly persisted/deduped message.

    Mirrors the live `message_status_updated` branch: FAILED is terminal and
    must win even after SENT (WhatsApp rejects after it has accepted), and every
    other status advances monotonically. Returns True when the row changed.
    """
    event = _consume_deferred_status(row)
    if event is None:
        return False
    new_status = str(event.get("status") or "").upper()
    if not new_status:
        return False
    if new_status == "FAILED":
        # Same boundary the live ACK branch pins: only a still-unproven send
        # (PENDING) may be failed; a late failure echo must not undo a SENT /
        # DELIVERED / READ message.
        if row.status != ConversationMessageStatus.PENDING:
            return False
        row.status = ConversationMessageStatus.FAILED
        row.failed_at = datetime.utcnow()
        row.error_message = str(event.get("error_message") or "Provider rejected the message.")[:300]
        return True
    return bool(advance(row, new_status))


def _skip_event(event: Dict[str, Any], reason: str) -> Dict[str, Any]:
    """Marks an event so it is not broadcast, and records WHY at a visible level.

    The reason used to go to `logger.debug` only, so in production (INFO) a
    dropped event produced a counter increment and nothing else: the gateway
    bridge logged "skipped=49" with no way to learn which events were dropped
    or why. An operator reading that had no thread to pull — which is exactly
    the "messages just do not arrive" class of report.

    The reason strings are bounded and drawn from a fixed set in this module,
    not from message bodies, so WARNING cannot leak conversation content.
    """
    logger.warning("Gateway olayi kalici yazilmadi: %s", reason)
    event["_skip"] = reason
    return event


def _defer_event(event: Dict[str, Any], reason: str) -> Dict[str, Any]:
    """Marks an event as intentionally buffered (not dropped, not broadcast).

    Unlike `_skip_event`, deferral is an expected outcome — an early provider
    ACK — so it is logged at DEBUG. The event is not published yet; it is
    re-applied when its message record arrives and the broadcast then carries
    the true status.
    """
    logger.debug("Gateway olayi ertelendi: %s", reason)
    event["_skip"] = reason
    return event


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


# ---------------------------------------------------------------------------
# Owner-unresolved replay queue
# ---------------------------------------------------------------------------
# Why this exists: an event whose owner cannot be resolved is not garbage, it is
# EARLY. In production a `lid_mapped` arrived while the QR session's
# `whatsapp_sessions` row did not exist yet, so `_resolve_event_owner_and_session`
# failed and the event was discarded. That one drop starved the entire LID
# identity-healing path (`_heal_lid_contact_identity` +
# `reconcile_legacy_split_conversation`), which is why the reported chat stayed
# split and its messages looked like they had never arrived.
#
# From the user's side, discarding an event the system could have handled
# seconds later is indistinguishable from losing a message. So it is HELD:
# bounded, time-limited, and replayed the moment an event for the same gateway
# session does resolve — which is the evidence the blocker has cleared.
_ORPHAN_QUEUE_MAX = 500
_ORPHAN_TTL_SECONDS = 300.0
_orphan_queue: "deque[Dict[str, Any]]" = deque(maxlen=_ORPHAN_QUEUE_MAX)
# Gateway sessions that produced an orphan. Membership gates the drain so the
# common (non-orphaning) path pays one set lookup and nothing else.
_orphan_sessions: set = set()
# Overflow and TTL evictions are COUNTED, never silently forgotten: a queue that
# quietly discards is the very failure this replaces.
_orphan_dropped = 0
_orphan_replayed = 0
_orphan_drain_inflight = False


def _push_orphan_item(item: Dict[str, Any]) -> None:
    """Appends to the bounded queue, counting any eviction it forces."""
    global _orphan_dropped
    if _orphan_queue.maxlen is not None and len(_orphan_queue) >= _orphan_queue.maxlen:
        _orphan_dropped += 1
    _orphan_queue.append(item)


def _enqueue_orphan_event(event: Dict[str, Any], reason: str) -> None:
    """Holds an owner-unresolved event for replay instead of discarding it."""
    gw_session = str(event.get("gateway_session_id") or "-")
    # Shallow copy WITHOUT `_skip`: a later attempt must start clean, and the
    # caller's dict may still be mutated after this call.
    held = {k: v for k, v in event.items() if k != "_skip"}
    _push_orphan_item(
        {"queued_at": time.monotonic(), "reason": reason, "event": held}
    )
    _orphan_sessions.add(gw_session)


def orphan_queue_stats() -> Dict[str, Any]:
    """Observability for the held-event queue (and a test seam)."""
    return {
        "queued": len(_orphan_queue),
        "dropped": int(_orphan_dropped),
        "replayed": int(_orphan_replayed),
        "sessions": sorted(_orphan_sessions),
        "max": _ORPHAN_QUEUE_MAX,
        "ttl_seconds": _ORPHAN_TTL_SECONDS,
    }


def reset_orphan_queue() -> None:
    """Clears held events and counters. Test isolation hook."""
    global _orphan_dropped, _orphan_replayed, _orphan_drain_inflight
    _orphan_queue.clear()
    _orphan_sessions.clear()
    _orphan_dropped = 0
    _orphan_replayed = 0
    _orphan_drain_inflight = False


class WhatsAppEventOrchestrator:
    """Coordinates incoming Baileys gateway event ingestion, validation, persistence, and dispatch."""

    def __init__(self, service: Optional[Any] = None) -> None:
        self.service = service

    async def _drain_orphan_queue(self, gateway_session_id: Optional[str]) -> int:
        """Replays held events once their owner has become resolvable.

        Triggered after an event for `gateway_session_id` resolved to an owner:
        that is direct evidence the original blocker is gone (the session row
        exists, the contact was created, ...).

        Re-entrancy is blocked on purpose. A replayed event that is STILL
        unresolvable is pushed back instead of being retried in place, so a
        permanently orphaned event can never spin.
        """
        global _orphan_drain_inflight, _orphan_replayed, _orphan_dropped
        key = str(gateway_session_id or "-")
        if _orphan_drain_inflight or key not in _orphan_sessions:
            return 0
        if not any(
            str(item["event"].get("gateway_session_id") or "-") == key
            for item in _orphan_queue
        ):
            _orphan_sessions.discard(key)
            return 0

        _orphan_drain_inflight = True
        now = time.monotonic()
        try:
            mine: List[Dict[str, Any]] = []
            keep: List[Dict[str, Any]] = []
            for item in list(_orphan_queue):
                if str(item["event"].get("gateway_session_id") or "-") == key:
                    mine.append(item)
                else:
                    keep.append(item)

            # Rebuild in place so the bounded deque keeps enforcing its cap.
            _orphan_queue.clear()
            for item in keep:
                _push_orphan_item(item)

            replayed = 0
            for item in mine:
                if now - float(item["queued_at"]) > _ORPHAN_TTL_SECONDS:
                    _orphan_dropped += 1
                    logger.warning(
                        "Sahipsiz gateway olayi suresi doldu, yayinlanmadi (event=%s, session=%s)",
                        item["event"].get("event"), key,
                    )
                    continue
                try:
                    result = await self.ingest_gateway_event(item["event"])
                except Exception as exc:  # noqa: BLE001 - replay must never break ingest
                    logger.warning(
                        "Sahipsiz olay yeniden oynanamadi (session=%s): %s", key, exc
                    )
                    result = None
                if isinstance(result, dict) and result.get("user_id"):
                    replayed += 1
                    _orphan_replayed += 1
                else:
                    # Still unresolvable — hold it again rather than dropping it.
                    _push_orphan_item(item)
            if replayed:
                logger.info(
                    "Sahipsiz gateway olaylari yeniden oynandi (session=%s, adet=%s)",
                    key, replayed,
                )
            still_held = any(
                str(item["event"].get("gateway_session_id") or "-") == key
                for item in _orphan_queue
            )
            if not still_held:
                _orphan_sessions.discard(key)
            return replayed
        finally:
            _orphan_drain_inflight = False

    def _get_helper(self, name: str, default: Any) -> Any:
        if self.service is not None:
            return getattr(self.service, name, default)
        return default

    async def _passthrough_event(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        resolve_event_owner = self._get_helper("_resolve_event_owner", _resolve_event_owner)
        gw_session_id = event.get("gateway_session_id")
        if not gw_session_id:
            return _skip_event(event, "passthrough: gateway_session_id yok")
        owner = await resolve_event_owner(db, "", str(gw_session_id))
        event["user_id"] = owner
        return event

    async def _upsert_contact(
        self,
        db: AsyncSession,
        user_id: str,
        jid: str,
        display_name: Optional[str],
        name_source: Optional[str] = None,
        gateway_session_id: Optional[str] = None,
        session_id: Optional[int] = None,
    ) -> Contact:
        clean_jid = _strip_jid_prefix(jid)
        if is_degenerate_jid(clean_jid):
            raise ValueError(f"Degenerate WhatsApp JID reddedildi: {jid}")
        if is_broadcast_only_jid(clean_jid):
            raise ValueError(f"Broadcast-only WhatsApp JID reddedildi: {jid}")

        # Check if clean_jid is the authenticated user's self identity
        session_filters = [
            get_user_filter(WhatsAppSession.user_id, user_id),
            WhatsAppSession.status == SessionStatus.CONNECTED,
            WhatsAppSession.is_active.is_(True),
        ]
        if session_id is not None:
            session_filters.append(WhatsAppSession.id == session_id)
        elif gateway_session_id:
            session_filters.append(WhatsAppSession.gateway_id == str(gateway_session_id))
        sess_rows = list(
            (await db.execute(select(WhatsAppSession).where(*session_filters))).scalars().all()
        )
        # Without an explicit line identity, self-detection is safe only for a
        # genuinely single-line user. Never guess between multiple sessions.
        active_sess = sess_rows[0] if len(sess_rows) == 1 else None
        if active_sess and active_sess.phone_number and _is_self_identity(clean_jid, active_sess.phone_number):
            canonical_phone = active_sess.phone_number
            self_contact = (
                await db.execute(
                    select(Contact).where(
                        Contact.phone_e164 == canonical_phone,
                        get_user_filter(Contact.user_id, user_id),
                    )
                )
            ).scalars().first()
            if self_contact:
                if _set_contact_name(self_contact, display_name, name_source):
                    await db.flush()
                return self_contact
            # Kendi kimligimize ait contact kaydi henuz yok: `phone_e164` bu
            # dalda atanmadigi icin asagidaki sorgu UnboundLocalError ile
            # patliyordu ve olay sessizce dusuyordu. Aday JID'in kendi
            # telefonuna duserek devam et.
            phone_e164 = _contact_phone_for_jid(clean_jid)
        else:
            if "@lid" in clean_jid:
                # G-3: tenant-scoped resolution. `lid_mappings` carries no
                # `user_id`; the mapping row belongs to a gateway session and
                # that session belongs to exactly one user. A lookup for THIS
                # user must never read another user's row, so the resolver
                # prefers the caller's own session and then the caller's other
                # sessions -- and stops there. Previously this was a bare
                # `WHERE lid_jid = :lid` global scan, which let tenant A resolve
                # a LID using tenant B's mapping row.
                mapped_phone_jid = await _resolve_lid_phone(
                    db,
                    clean_jid if "@" in clean_jid else f"{clean_jid}@lid",
                    user_id=user_id,
                    gateway_session_id=gateway_session_id,
                )
                phone_e164 = _contact_phone_for_jid(mapped_phone_jid or clean_jid)
            else:
                phone_e164 = _contact_phone_for_jid(clean_jid)

        stmt = select(Contact).where(
            Contact.phone_e164 == phone_e164,
            get_user_filter(Contact.user_id, user_id),
        )
        res = await db.execute(stmt)
        contact = res.scalars().first()
        if contact is None and phone_e164.startswith("jid:"):
            legacy = jid_to_phone(clean_jid)
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
            # Phase 15.4 paritesi: 'push' karsi tarafin KENDI sectigi profil
            # takma adidir, kullanicinin rehber kaydi DEGILDIR. Bu yuzden
            # `display_name` olarak ASLA yazilmaz — yalnizca
            # `custom_attributes['push_name']` metadata'si olarak saklanir.
            # `_set_contact_name` (repositories/contacts.py) ve bulk sync yolu
            # (sync.py) bu kurali uyguluyordu; contact CREATE dali uygulamiyordu
            # ve yabanci numaranin pushName'i veritabanina ad olarak yaziliyordu.
            name_source_str = str(name_source or "")
            is_push_name = name_source_str == "push"
            clean_name = (
                str(display_name).strip()
                if display_name and not is_push_name and not _is_raw_jid_name(display_name)
                else None
            )
            contact = Contact(
                user_id=user_id,
                phone_e164=phone_e164,
                display_name=clean_name or jid_to_phone(clean_jid),
            )
            if display_name and name_source_str in _NAME_RANK:
                attrs: Dict[str, Any] = {"name_source": name_source_str}
                if is_push_name and not _is_raw_jid_name(display_name):
                    attrs["push_name"] = str(display_name).strip()[:150]
                contact.custom_attributes = attrs
            try:
                async with db.begin_nested():
                    db.add(contact)
                    await db.flush()
            except IntegrityError:
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

    async def _ensure_conversation(
        self,
        db: AsyncSession,
        user_id: str,
        jid: str,
        preview: Optional[str] = None,
        session_id: Optional[int] = None,
        contact_name: Optional[str] = None,
        contact_source: Optional[str] = None,
    ) -> Conversation:
        upsert_contact = self._get_helper("_upsert_contact", self._upsert_contact)
        contact = await upsert_contact(
            db,
            user_id,
            jid,
            contact_name,
            contact_source,
            session_id=session_id,
        )
        # "once SELECT, sonra INSERT" kalibi. Es zamanli iki olay ikisi de
        # SELECT'te "yok" gorup IKI sohbet uretmeye calisabilir; yarisi kapatan
        # sey VERITABANI kisitidir (`uq_conv_user_session_contact_channel`) ve
        # `_ensure_conversation_race_safe` icindeki
        # IntegrityError -> rollback -> yeniden cozumleme -> retry yoludur.
        #
        # NOT (Faz 5): bu fonksiyona uygulama ici bir asyncio kilidi eklenmedi.
        # Boyle bir kilit yarisi KAPATMAZ: iki olay farkli DB oturumu
        # kullandiginda ilk oturumun `flush()` ettigi satir henuz commit
        # edilmedigi icin ikinci oturum onu goremez; kilit serbest kaldiktan
        # sonra yapilan SELECT yine "yok" der. Olculerek dogrulandi.
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
                session_id=session_id,
                last_message_preview=preview,
                is_group="@g.us" in jid,
                is_archived=False,
                last_message_at=None,
            )
            db.add(conv)
            await db.flush()
        elif session_id is not None and conv.session_id is None:
            conv.session_id = session_id
        conv._contact = contact
        return conv

    async def _ensure_conversation_race_safe(
        self,
        db: AsyncSession,
        owner: str,
        jid_str: str,
        event: Dict[str, Any],
        session_id: Optional[int] = None,
        contact_name: Optional[str] = None,
        contact_source: Optional[str] = None,
    ) -> Conversation:
        resolve_event_owner = self._get_helper("_resolve_event_owner", _resolve_event_owner)
        ensure_conversation = self._get_helper("_ensure_conversation", self._ensure_conversation)
        extra_kw: Dict[str, Any] = {}
        if contact_name is not None:
            extra_kw["contact_name"] = contact_name
        if contact_source is not None:
            extra_kw["contact_source"] = contact_source
        try:
            return await ensure_conversation(
                db, owner, jid_str, session_id=session_id, **extra_kw,
            )
        except IntegrityError:
            await db.rollback()
            fresh_owner = await resolve_event_owner(db, jid_str, event.get("gateway_session_id"))
            event["user_id"] = fresh_owner
            return await ensure_conversation(
                db, fresh_owner, jid_str, session_id=session_id, **extra_kw,
            )

    async def _persist_gateway_message(self, db: AsyncSession, owner: str, msg: Dict[str, Any]) -> bool:
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)
        message_row_from_gateway = self._get_helper("_message_row_from_gateway", _message_row_from_gateway)
        ensure_conversation_race_safe = self._get_helper("_ensure_conversation_race_safe", self._ensure_conversation_race_safe)
        jid = msg.get("conversation_id")
        if not jid or "@" not in str(jid):
            return False
        jid_str = str(jid)
        if is_broadcast_only_jid(jid_str):
            return False
        wa_id = msg.get("wa_message_id")
        conv = await ensure_conversation_race_safe(db, owner, jid_str, msg)
        if wa_id and await message_exists_by_wa_id(db, conv.id, wa_id):
            return False
        row = message_row_from_gateway(owner, conv, msg)
        if row is None:
            return False
        ts = _as_naive_utc(_parse_dt(msg.get("created_at")))
        summary = build_last_message_summary(
            message_type=row.message_type.value,
            body=row.body,
            sender_name=row.sender_name,
            is_group="@g.us" in jid_str,
            direction=row.direction.value,
        )
        # The existence check above is a pre-filter, not a guarantee: two
        # concurrent ingests of the same WhatsApp message (history replay racing
        # a live `message_new`) both pass it, and the loser then violates
        # `uq_msg_conv_wa_message_id`. Without a savepoint that IntegrityError
        # poisons the whole transaction — every remaining event in the batch is
        # rolled back with it, which is how a single duplicate could drop a
        # burst of real messages. Inside a nested block only THIS insert rolls
        # back, and the duplicate is correctly treated as "already have it".
        if wa_id:
            try:
                async with db.begin_nested():
                    db.add(row)
                    await db.flush()
            except IntegrityError:
                logger.info(
                    "Duplicate WhatsApp message ignored (concurrent ingest race): "
                    "conversation_id=%s wa_message_id=%s",
                    conv.id, wa_id,
                )
                return False
        else:
            db.add(row)
        apply_last_message(conv, ts, summary)
        if not wa_id:
            await db.flush()
        return True

    async def _ingest_message(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        resolve_event_owner_and_session = self._get_helper(
            "_resolve_event_owner_and_session", _resolve_event_owner_and_session
        )
        advance_message_status = self._get_helper("_advance_message_status", _advance_message_status)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)
        serialize_message = self._get_helper("_serialize_message", _serialize_message)
        ensure_conversation_race_safe = self._get_helper("_ensure_conversation_race_safe", self._ensure_conversation_race_safe)
        upsert_contact = self._get_helper("_upsert_contact", self._upsert_contact)

        msg = event.get("message") or {}
        jid = msg.get("conversation_id") or event.get("conversation_id")
        if not jid or "@" not in str(jid):
            return _skip_event(event, "message_new: gecerli jid yok")
        jid_str = str(jid)
        if is_broadcast_only_jid(jid_str):
            return _skip_event(event, f"message_new: broadcast-only jid ({jid_str})")
        if is_degenerate_jid(jid_str):
            return _skip_event(event, f"message_new: dejenere jid ({jid_str})")

        owner, ws_session_id = await resolve_event_owner_and_session(
            db, jid_str, event.get("gateway_session_id")
        )
        event["user_id"] = owner

        is_group_jid = "@g.us" in jid_str
        msg_direction = (
            MessageDirection.INBOUND
            if str(msg.get("direction", "INBOUND")).upper() == "INBOUND"
            else MessageDirection.OUTBOUND
        )
        name_for_contact = None if (is_group_jid or msg_direction == MessageDirection.OUTBOUND) else msg.get("sender_name")
        source_for_contact = None if (is_group_jid or msg_direction == MessageDirection.OUTBOUND) else msg.get("sender_name_source")
        conv = await ensure_conversation_race_safe(
            db, owner, jid_str, event, session_id=ws_session_id,
            contact_name=name_for_contact, contact_source=source_for_contact,
        )
        contact = getattr(conv, "_contact", None)
        if contact is None:
            contact = await upsert_contact(
                db,
                owner,
                jid_str,
                name_for_contact,
                source_for_contact,
                session_id=ws_session_id,
            )

        wa_id = msg.get("wa_message_id")
        client_id = msg.get("client_message_id")
        if wa_id or client_id:
            existing = await db.execute(
                select(Message).where(
                    or_(
                        Message.wa_message_id == wa_id if wa_id else False,
                        Message.client_message_id == client_id if client_id else False,
                    ),
                    Message.conversation_id == conv.id,
                    get_user_filter(Message.user_id, owner),
                )
            )
            canonical = existing.scalars().first()
            if canonical is not None:
                # Fill the provider id, never REPLACE a known one with a
                # different value. The gateway records an outbound send under a
                # deterministic pre-send id and can echo that record before (or
                # after) the real provider id is confirmed; overwriting the real
                # id here broke every later dedup/ACK lookup for that message and
                # produced a second row when the provider echo arrived.
                canonical.wa_message_id = canonical.wa_message_id or wa_id
                advance_message_status(canonical, msg.get("status"))
                # An early ACK may be buffered for this record; apply it before
                # serializing so the broadcast carries the true status.
                apply_deferred_status(canonical, advance=advance_message_status)
                await db.commit()
                event["conversation_id"] = conv.id
                event["message"] = serialize_message(canonical)
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
            # D3: no fake phone numbers (hard invariant). LID senders have no
            # resolvable phone, so persist NULL instead of the literal "unknown".
            sender_phone=msg.get("sender_phone") or jid_to_phone(jid_str) or None,
            sender_name=(
                "ME"
                if direction == MessageDirection.OUTBOUND
                else (msg.get("participant_name") or (None if is_group_jid else contact.display_name))
            ),
            # Operator precedence made this read as
            #   (msg.get("recipient_phone") or "ME") if INBOUND else contact.phone_e164
            # because `or` binds tighter than the conditional expression. For
            # an OUTBOUND message on a contact with no phone_e164 — which is
            # every LID contact, since a LID carries no phone number — this
            # wrote NULL into Message.recipient_phone, a NOT NULL column. The
            # IntegrityError was swallowed further down, so the entire
            # message_new event was dropped and the bubble silently vanished.
            #
            # The intent, matching repositories/messages.py: an inbound row is
            # addressed to us, an outbound row to the conversation's own JID.
            # Neither needs the contact to have a phone number, so the JID is
            # the final fallback rather than a NULL.
            recipient_phone=(
                (msg.get("recipient_phone") or "ME")
                if direction == MessageDirection.INBOUND
                else (msg.get("recipient_phone") or contact.phone_e164 or jid)
            ),
            status=ConversationMessageStatus.RECEIVED if direction == MessageDirection.INBOUND else ConversationMessageStatus.SENT,
            external_timestamp=_as_naive_utc(_parse_dt(msg.get("created_at"))),
        )
        # The pre-flight SELECT above is a filter, not a guarantee. The same
        # WhatsApp message can be ingested twice at the same instant — the
        # gateway delivers one send's echo both as the send result and as the
        # `messages.upsert` for the same id, and a sync job's history replay can
        # overlap a live `message_new` — and the loser then violates
        # `uq_msg_conv_wa_message_id`.
        #
        # Without a savepoint that IntegrityError aborts the WHOLE transaction:
        # the contact upsert and the conversation row written for this very
        # message are rolled back with it, and the only recovery left is
        # `ingest_gateway_event`'s transaction-wide rollback. Inside a nested
        # block only this INSERT rolls back, nothing else is lost, and the event
        # is still broadcast from the row that actually won. Measured in
        # production on 2026-09-30 14:32:01 (conversation 17600): this path was
        # the one that poisoned the transaction, because the sibling insert in
        # `_persist_gateway_message` already had this guard and this one did not.
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError:
            logger.info(
                "Duplicate WhatsApp message ignored (concurrent ingest race): "
                "conversation_id=%s wa_message_id=%s client_message_id=%s",
                conv.id, wa_id, client_id,
            )
            # The winner's row exists and is committed. Re-select it and
            # broadcast THAT row, so the open thread shows the bubble the
            # provider actually acknowledged instead of losing it. The lookup
            # is intentionally not conversation-scoped: an LID reconciliation
            # can have moved the winner to a sibling conversation.
            recovered = await self._recover_message_new_after_integrity_error(db, event)
            if recovered is None:
                return _skip_event(
                    event,
                    f"message_new: yaris kaybedildi, kazanan satir bulunamadi ({jid_str})",
                )
            return recovered
        summary = build_last_message_summary(
            message_type=mtype_str,
            body=body,
            sender_name=row.sender_name,
            is_group=is_group_jid,
            direction=direction.value,
        )
        apply_last_message(conv, _as_naive_utc(_parse_dt(msg.get("created_at"))) or datetime.utcnow(), summary)
        if direction == MessageDirection.INBOUND:
            conv.unread_count = (conv.unread_count or 0) + 1
        # A provider ACK may have arrived while this record was being persisted
        # (see the deferred-ACK block at the top of this module). Apply it now,
        # before serialization, instead of losing it.
        apply_deferred_status(row, advance=advance_message_status)

        event["conversation_id"] = conv.id
        event["jid"] = jid_str
        event["is_group"] = is_group_jid
        event["lead_phone"] = contact.phone_e164 if contact else None
        event["message"] = serialize_message(row)
        return event

    async def _ingest_contact_synced(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        resolve_event_owner_and_session = self._get_helper(
            "_resolve_event_owner_and_session", _resolve_event_owner_and_session
        )
        upsert_contact = self._get_helper("_upsert_contact", self._upsert_contact)
        contact_payload = event.get("contact") or {}
        jid = contact_payload.get("id") or contact_payload.get("jid")
        if not jid or "@" not in str(jid):
            return _skip_event(event, "contact_synced: gecerli jid yok")
        clean_jid = _strip_jid_prefix(str(jid))
        if is_broadcast_only_jid(clean_jid):
            return _skip_event(event, f"contact_synced: broadcast-only jid ({clean_jid})")
        # G-3: resolve the owning tenant BEFORE the LID lookup so the mapping
        # read can be scoped to that tenant. Resolving it afterwards is what
        # forced the old global `WHERE lid_jid = :lid` scan, which let one
        # tenant's session resolve a LID from another tenant's mapping row.
        # `resolve_event_owner` is fail-closed (EventOwnerUnresolved) and was
        # already called unconditionally on this path -- only its position moved.
        owner, ws_session_id = await resolve_event_owner_and_session(
            db, clean_jid, event.get("gateway_session_id")
        )
        event["user_id"] = owner

        if "@lid" in clean_jid:
            mapped_phone_jid = await _resolve_lid_phone(
                db,
                clean_jid if "@" in clean_jid else f"{clean_jid}@lid",
                user_id=owner,
                gateway_session_id=event.get("gateway_session_id"),
            )
            phone_e164 = _contact_phone_for_jid(mapped_phone_jid or clean_jid)
        else:
            phone_e164 = _contact_phone_for_jid(clean_jid)

        active_sess = await db.get(WhatsAppSession, ws_session_id) if ws_session_id else None
        if active_sess and active_sess.phone_number and _is_self_identity(clean_jid, active_sess.phone_number):
            phone_e164 = active_sess.phone_number

        res = await db.execute(
            select(Contact).where(
                Contact.phone_e164 == phone_e164,
                get_user_filter(Contact.user_id, owner),
            )
        )
        contact = res.scalars().first()
        name = contact_payload.get("name")
        source = str(contact_payload.get("name_source") or "")
        avatar_url = contact_payload.get("avatar_url")
        if contact is None:
            high_rank = source in ("addressbook", "verified", "group_subject")
            if (high_rank and name and not _is_raw_jid_name(name)) or avatar_url:
                contact = await upsert_contact(
                    db,
                    owner,
                    clean_jid,
                    name,
                    source,
                    gateway_session_id=event.get("gateway_session_id"),
                    session_id=ws_session_id,
                )
                if avatar_url:
                    _set_contact_avatar(contact, avatar_url)
                await db.commit()
            return event
        _set_contact_name(contact, name, source)
        if avatar_url:
            _set_contact_avatar(contact, avatar_url)
        await db.commit()
        return event

    async def reconcile_legacy_split_conversation(
        self,
        db: AsyncSession,
        user_id: str,
        lid_jid: str,
        phone_jid: str,
        session_id: Optional[int] = None,
    ) -> Optional[Conversation]:
        get_conversation_lock = self._get_helper("_get_conversation_lock", None)
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

        if not lid_contact:
            return None
        if not canonical_contact:
            upsert_contact = self._get_helper("_upsert_contact", self._upsert_contact)
            canonical_contact = await upsert_contact(db, user_id, phone_jid, lid_contact.display_name, None)

        # Merge avatar if lid contact has it and canonical does not
        lid_attrs = lid_contact.custom_attributes or {}
        canon_attrs = canonical_contact.custom_attributes or {}
        if lid_attrs.get("avatar_url") and not canon_attrs.get("avatar_url"):
            canon_attrs["avatar_url"] = lid_attrs["avatar_url"]
            canonical_contact.custom_attributes = dict(canon_attrs)
            await db.flush()

        conv_res = await db.execute(
            select(Conversation).where(
                Conversation.contact_id.in_([lid_contact.id, canonical_contact.id]),
                get_user_filter(Conversation.user_id, user_id),
                *(
                    [Conversation.session_id == session_id]
                    if session_id is not None
                    else []
                ),
            )
        )
        convs = {c.contact_id: c for c in conv_res.scalars().all()}
        legacy_conv = convs.get(lid_contact.id)
        canonical_conv = convs.get(canonical_contact.id)

        if not legacy_conv:
            return canonical_conv
        if not canonical_conv:
            ensure_conversation = self._get_helper("_ensure_conversation", self._ensure_conversation)
            canonical_conv = await ensure_conversation(
                db, user_id, phone_jid, session_id=legacy_conv.session_id
            )

        if legacy_conv.id == canonical_conv.id:
            return canonical_conv

        ranks = {"PENDING": 0, "FAILED": 0, "SENT": 1, "DELIVERED": 2, "READ": 3, "RECEIVED": 4}

        async def _do_reconciliation():
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

        if get_conversation_lock is not None:
            async with get_conversation_lock(user_id, legacy_conv.id), get_conversation_lock(user_id, canonical_conv.id):
                return await _do_reconciliation()
        return await _do_reconciliation()

    async def _heal_lid_contact_identity(
        self,
        db: AsyncSession,
        user_id: str,
        lid_jid: str,
        phone_jid: str,
    ) -> int:
        """Write-path repair: re-keys a LID-keyed contact onto its canonical PN.

        Phase 2 (C-5). This repair used to live inside `list_conversations`, i.e.
        inside a GET. A read endpoint must normalize in memory and must NOT mutate
        persistence: besides being a read/write conflation, committing from a read
        path can silently flush and discard unrelated pending work on the same
        session. The repair belongs where the mapping is LEARNED — the `lid_mapped`
        event — which is this method's only caller.

        Legacy rows whose mapping was learned before this path existed are a
        data-remediation concern, deliberately out of scope here.

        Returns the number of contacts re-keyed.
        """
        canonical_phone = _contact_phone_for_jid(phone_jid)
        if not canonical_phone:
            return 0
        lid_phone = lid_jid if str(lid_jid).startswith("jid:") else f"jid:{lid_jid}"
        if lid_phone == canonical_phone:
            return 0

        # If the canonical contact already exists, the two rows must be MERGED,
        # not re-keyed — `reconcile_legacy_split_conversation` owns that case.
        # Re-keying here would collide on the (user_id, phone_e164) uniqueness.
        existing = await db.execute(
            select(Contact.id).where(
                Contact.phone_e164 == canonical_phone,
                get_user_filter(Contact.user_id, user_id),
            )
        )
        if existing.first() is not None:
            return 0

        res = await db.execute(
            select(Contact).where(
                Contact.phone_e164 == lid_phone,
                get_user_filter(Contact.user_id, user_id),
            )
        )
        healed = 0
        for contact in res.scalars().all():
            contact.phone_e164 = canonical_phone
            healed += 1
            conv_res = await db.execute(
                select(Conversation.id).where(
                    Conversation.contact_id == contact.id,
                    get_user_filter(Conversation.user_id, user_id),
                )
            )
            for conv_id in conv_res.scalars().all():
                await db.execute(
                    text(
                        "UPDATE messages SET sender_phone = :pn "
                        "WHERE conversation_id = :cid AND sender_phone LIKE '%@lid'"
                    ),
                    {"pn": canonical_phone, "cid": conv_id},
                )
        if healed:
            await db.flush()
            logger.info(
                "[lid_heal] %d LID contact(s) re-keyed to %s (owner=%s)",
                healed, canonical_phone, user_id,
            )
        return healed

    async def _ingest_message_reaction(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        """Bir mesaj reaksiyonunu kalici hale getirir ve yayinlanabilir hale getirir.

        Reaksiyon bir MESAJ DEGILDIR: hedef mesaja bagli, kisi basina tek ve
        degistirilebilir bir ifadedir. Bu yuzden `message_new` yolundan gecmez,
        kendi tablosuna yazilir ve yalnizca listedeki rozeti guncelleyen kucuk
        bir olay yayinlar.

        Hedef mesaj bulunamazsa olay ATILIR, mesaj satiri URETILMEZ: eski hata
        tam da bunu yapiyordu (`[REACTION]` govdeli sahte bir balon).
        """
        resolve_event_owner_and_session = self._get_helper(
            "_resolve_event_owner_and_session", _resolve_event_owner_and_session
        )
        find_conversation = self._get_helper("_find_whatsapp_conversation", _find_whatsapp_conversation)

        jid = event.get("conversation_id") or event.get("jid")
        if not jid or "@" not in str(jid):
            return _skip_event(event, "message_reaction: gecerli jid yok")
        jid_str = str(jid)
        if is_broadcast_only_jid(jid_str) or is_degenerate_jid(jid_str):
            return _skip_event(event, f"message_reaction: gecersiz jid ({jid_str})")
        target_wa_id = event.get("target_wa_message_id")
        if not target_wa_id:
            return _skip_event(event, "message_reaction: hedef mesaj kimligi yok")

        owner, _ws_session_id = await resolve_event_owner_and_session(
            db, jid_str, event.get("gateway_session_id")
        )
        event["user_id"] = owner

        # Reaksiyon, sohbeti YARATMAZ: hedef mesaj yoksa sohbet de yoktur.
        conv = await find_conversation(db, owner, jid_str)
        if conv is None:
            return _skip_event(event, f"message_reaction: sohbet yok ({jid_str})")
        target = await db.scalar(
            select(Message).where(
                Message.conversation_id == conv.id,
                Message.wa_message_id == str(target_wa_id),
                get_user_filter(Message.user_id, owner),
            )
        )
        if target is None:
            return _skip_event(event, f"message_reaction: hedef mesaj yok ({jid_str})")

        from_me = bool(event.get("from_me"))
        reactor_jid = _reaction_identity(from_me, event.get("reactor_jid"))
        if not reactor_jid:
            return _skip_event(event, "message_reaction: reaksiyon sahibi cozulemedi")
        # WhatsApp sozlesmesi: 32 karakterden uzun ifade yok. Kesme sinirda
        # yapilir; DB sutunu da 32.
        emoji = str(event.get("emoji") or "")[:32]

        await _upsert_reaction(
            db,
            user_id=owner,
            message_id=target.id,
            conversation_id=conv.id,
            reactor_jid=reactor_jid,
            from_me=from_me,
            emoji=emoji,
        )
        return {
            "event": "message_reaction",
            "user_id": owner,
            "conversation_id": conv.id,
            "jid": jid_str,
            "message_id": target.id,
            "wa_message_id": str(target_wa_id),
            "emoji": emoji,
            "from_me": from_me,
            "reactor_jid": reactor_jid,
            "removed": not emoji,
            # Liste rozeti SUNUCUDA hesaplanir: "en son mesajin ifadesi" kurali
            # istemcide tekrarlanirsa iki taraf ayrisabilir. Reaksiyon eski bir
            # mesaja aitse bu alan mevcut rozeti korur (ya da yoksa null).
            "conversation_reaction": await _conversation_reaction(db, conv.id),
        }

    async def _ingest_lid_mapped(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        resolve_event_owner_and_session = self._get_helper(
            "_resolve_event_owner_and_session", _resolve_event_owner_and_session
        )
        resolve_event_owner = self._get_helper("_resolve_event_owner", _resolve_event_owner)
        lid = event.get("lid")
        phone_jid = event.get("phone_jid")
        if not lid or not phone_jid:
            return _skip_event(event, "lid_mapped: lid veya phone_jid eksik")
        clean_lid = _strip_jid_prefix(str(lid))
        clean_phone = _strip_jid_prefix(str(phone_jid))
        try:
            owner, ws_session_id = await resolve_event_owner_and_session(
                db, clean_phone, event.get("gateway_session_id")
            )
        except EventOwnerUnresolved:
            owner = await resolve_event_owner(db, clean_phone, event.get("gateway_session_id"))
            ws_session_id = None
        event["user_id"] = owner
        # C-5: heal LID-keyed contacts on the WRITE path (here), never on a GET.
        try:
            await self._heal_lid_contact_identity(db, owner, clean_lid, clean_phone)
        except Exception as heal_exc:  # noqa: BLE001 - healing must not drop the event
            logger.warning("lid_mapped: LID contact heal skipped (%s): %s", clean_lid, heal_exc)
        reconciled = await self.reconcile_legacy_split_conversation(
            db,
            owner,
            clean_lid,
            clean_phone,
            session_id=ws_session_id,
        )
        if reconciled:
            event["reconciled_conversation_id"] = reconciled.id
            event["event"] = "conversations_updated"
            # REST ve WebSocket AYNI conversation sozlesmesini tasimali.
            # Onceden burada yalnizca `lead_phone` gonderiliyordu; frontend
            # mapper'i (`mapConversationItem`) `phone` okudugu icin alan
            # undefined kaliyor ve `{...existing, ...mapped}` birlestirmesi
            # sohbetin adini VE telefonunu siliyordu (kimlik kaybi).
            # Artik REST `list_conversations` ile ayni alan adlari uretilir.
            rc_contact = reconciled.contact
            rc_phone = rc_contact.phone_e164 if rc_contact else clean_phone
            rc_is_group = bool(reconciled.is_group) or bool(rc_phone and "@g.us" in str(rc_phone))
            rc_name, rc_id_state = _resolve_contact_identity(
                rc_contact, phone=rc_phone, is_group=rc_is_group
            )
            event["conversation"] = {
                "id": reconciled.id,
                "archived_lid": clean_lid,
                "session_id": reconciled.session_id,
                "contact_id": reconciled.contact_id,
                "lead_id": reconciled.lead_id,
                "name": rc_name,
                "phone": rc_phone,
                "identity_state": rc_id_state,
                "is_group": rc_is_group,
                "is_archived": bool(reconciled.is_archived),
                "avatar_url": _get_contact_avatar(rc_contact),
                "last_message_preview": _normalize_preview_text(
                    None, reconciled.last_message_preview
                )
                or None,
                "last_message_at": reconciled.last_message_at.isoformat()
                if reconciled.last_message_at
                else None,
                "created_at": reconciled.created_at.isoformat()
                if reconciled.created_at
                else None,
                "updated_at": reconciled.updated_at.isoformat()
                if reconciled.updated_at
                else None,
                "unread_count": reconciled.unread_count,
                "status": reconciled.status.value
                if hasattr(reconciled.status, "value")
                else str(reconciled.status),
            }
        return event

    async def reconcile_self_identity(
        self,
        db: AsyncSession,
        user_id: str,
        session: WhatsAppSession,
        self_lid: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Reconciles duplicate contacts and conversations created for the authenticated user's self number.

        Merges duplicate conversation (e.g. LID conversation) into the canonical self conversation,
        deduplicates messages by wa_message_id, re-points unique messages, and deletes duplicate rows.
        """
        if not session or not session.phone_number:
            return {"status": "skipped", "reason": "session has no phone number"}

        canonical_phone = session.phone_number

        if not self_lid and session.gateway_id:
            try:
                from backend.app.services import whatsapp_gateway as gw
                gw_info = await gw.get_session_status(session.gateway_id)
                if isinstance(gw_info, dict):
                    self_lid = gw_info.get("self_lid")
            except Exception:
                pass

        canonical_contact = (
            await db.execute(
                select(Contact).where(
                    Contact.phone_e164 == canonical_phone,
                    get_user_filter(Contact.user_id, user_id),
                )
            )
        ).scalars().first()

        if not canonical_contact:
            canonical_contact = Contact(
                user_id=user_id,
                phone_e164=canonical_phone,
                display_name=session.session_name or canonical_phone,
            )
            db.add(canonical_contact)
            await db.flush()

        canonical_conv = (
            await db.execute(
                select(Conversation).where(
                    Conversation.contact_id == canonical_contact.id,
                    Conversation.session_id == session.id,
                    get_user_filter(Conversation.user_id, user_id),
                ).order_by(Conversation.id.asc())
            )
        ).scalars().first()

        if not canonical_conv:
            canonical_conv = Conversation(
                user_id=user_id,
                contact_id=canonical_contact.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                session_id=session.id,
                is_group=False,
                is_archived=False,
            )
            db.add(canonical_conv)
            await db.flush()

        all_contacts = (
            await db.execute(
                select(Contact).where(
                    get_user_filter(Contact.user_id, user_id),
                    Contact.id != canonical_contact.id,
                )
            )
        ).scalars().all()

        duplicate_contacts = [
            c for c in all_contacts
            if c.phone_e164 and _is_self_identity(c.phone_e164, canonical_phone, self_lid)
        ]

        merged_convs: List[int] = []
        moved_msgs = 0
        deleted_msgs = 0
        deleted_contacts: List[int] = []

        for dup_c in duplicate_contacts:
            canonical_avatar = _get_contact_avatar(canonical_contact)
            dup_avatar = _get_contact_avatar(dup_c)
            if not canonical_avatar and dup_avatar:
                _set_contact_avatar(canonical_contact, dup_avatar)

            dup_convs = (
                await db.execute(
                    select(Conversation).where(
                        Conversation.contact_id == dup_c.id,
                        Conversation.session_id == session.id,
                        get_user_filter(Conversation.user_id, user_id),
                    )
                )
            ).scalars().all()

            for dup_conv in dup_convs:
                if dup_conv.id == canonical_conv.id:
                    continue
                dup_messages = (
                    await db.execute(
                        select(Message).where(Message.conversation_id == dup_conv.id)
                    )
                ).scalars().all()

                existing_wa_ids = set(
                    (
                        await db.execute(
                            select(Message.wa_message_id).where(
                                Message.conversation_id == canonical_conv.id,
                                Message.wa_message_id.isnot(None),
                            )
                        )
                    ).scalars().all()
                )

                for msg in dup_messages:
                    if msg.wa_message_id and msg.wa_message_id in existing_wa_ids:
                        await db.delete(msg)
                        deleted_msgs += 1
                    else:
                        msg.conversation_id = canonical_conv.id
                        # D2: `msg.contact_id` was assigned here but the Message
                        # model has no such column (silent no-op). Ownership
                        # lives on the Conversation; removed the dead assignment.
                        if msg.wa_message_id:
                            existing_wa_ids.add(msg.wa_message_id)
                        moved_msgs += 1

                await db.delete(dup_conv)
                merged_convs.append(dup_conv.id)

            remaining_ref = await db.execute(
                select(Conversation.id).where(Conversation.contact_id == dup_c.id).limit(1)
            )
            if remaining_ref.first() is None:
                await db.delete(dup_c)
                deleted_contacts.append(dup_c.id)

        await db.commit()
        if merged_convs or deleted_contacts:
            logger.info(
                "[WhatsApp] Self identity reconciled (user=%s): merged_convs=%s, deleted_contacts=%s, moved_msgs=%d, deleted_msgs=%d",
                user_id, merged_convs, deleted_contacts, moved_msgs, deleted_msgs,
            )
        return {
            "status": "reconciled",
            "merged_conversations": merged_convs,
            "deleted_contacts": deleted_contacts,
            "moved_messages": moved_msgs,
            "deleted_duplicate_messages": deleted_msgs,
            "canonical_conversation_id": canonical_conv.id,
            "canonical_contact_id": canonical_contact.id,
        }

    async def _map_conversation_event(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        resolve_event_owner_and_session = self._get_helper(
            "_resolve_event_owner_and_session", _resolve_event_owner_and_session
        )
        advance_message_status = self._get_helper("_advance_message_status", _advance_message_status)
        apply_last_message = self._get_helper("_apply_last_message", _apply_last_message)
        apply_unread_count = self._get_helper("_apply_unread_count", _apply_unread_count)
        find_whatsapp_conversation = self._get_helper("_find_whatsapp_conversation", _find_whatsapp_conversation)
        schedule_chats_bootstrap = self._get_helper("_schedule_chats_bootstrap", None)

        jid = event.get("conversation_id")
        if not jid or "@" not in str(jid):
            conv_payload = event.get("conversation") or {}
            candidate = conv_payload.get("id") or conv_payload.get("jid")
            if candidate and "@" in str(candidate):
                jid = candidate
            else:
                return _skip_event(event, f"{event.get('event')}: sohbet jid'i cozulemedi")
        clean_jid = _strip_jid_prefix(str(jid))
        if is_broadcast_only_jid(clean_jid):
            return _skip_event(event, f"{event.get('event')}: broadcast-only jid ({clean_jid})")
        if is_degenerate_jid(clean_jid):
            return _skip_event(event, f"{event.get('event')}: dejenere jid ({clean_jid})")

        owner, ws_session_id = await resolve_event_owner_and_session(
            db, clean_jid, event.get("gateway_session_id")
        )
        if ws_session_id:
            sess_row = await db.get(WhatsAppSession, ws_session_id)
            if sess_row and sess_row.phone_number and _is_self_identity(clean_jid, sess_row.phone_number):
                from backend.app.services.whatsapp.identity import phone_to_jid
                jid = phone_to_jid(sess_row.phone_number)

        event["user_id"] = owner
        evt_name = event.get("event")

        ensure_conversation_race_safe = self._get_helper(
            "_ensure_conversation_race_safe", self._ensure_conversation_race_safe
        )
        upsert_contact = self._get_helper("_upsert_contact", self._upsert_contact)

        if evt_name == "conversation_updated":
            conv = await ensure_conversation_race_safe(db, owner, str(jid), event, session_id=ws_session_id)
        elif evt_name == "message_status_updated":
            conv = None
            matching_msg = None
            wa_id = event.get("wa_message_id")
            client_mid = event.get("client_message_id")
            if wa_id or client_mid:
                msg_res = await db.execute(
                    select(Message, Conversation)
                    .join(Conversation, Message.conversation_id == Conversation.id)
                    .where(
                        or_(
                            Message.wa_message_id == wa_id if wa_id else False,
                            Message.client_message_id == client_mid if client_mid else False,
                        ),
                        get_user_filter(Conversation.user_id, owner),
                        # Deliberately NOT scoped to the event's session: a relink
                        # or a LID/phone split moves the message row to another
                        # conversation of the SAME owner, and scoping by session
                        # made the ACK miss it — which is how a real ACK turned
                        # into "provider ACK precedes its message record". The
                        # owner filter still makes cross-tenant reads impossible.
                    )
                )
                first_pair = msg_res.first()
                if first_pair:
                    matching_msg, conv = first_pair
            if conv is None:
                conv = await find_whatsapp_conversation(db, owner, str(jid), session_id=ws_session_id)
            if conv is None:
                return _skip_event(event, f"{evt_name}: sohbet yok, durum olayi sohbet yaratmaz ({jid})")
        else:
            conv = await find_whatsapp_conversation(db, owner, str(jid), session_id=ws_session_id)
            if conv is None:
                return _skip_event(event, f"{evt_name}: sohbet yok, durum olayi sohbet yaratmaz ({jid})")

        event["conversation_id"] = conv.id
        if event.get("event") == "presence_updated":
            presence = str(event.get("presence") or "").lower()
            event["typing"] = presence in ("composing", "recording")
            return event
        if event.get("event") == "conversation_updated":
            payload = event.get("conversation") or {}
            conv.is_group = bool(payload.get("is_group")) or "@g.us" in str(jid)
            if "archived" in payload:
                conv.is_archived = bool(payload.get("archived"))
            name = payload.get("name")
            if name or payload.get("avatar_url"):
                contact = await upsert_contact(db, owner, str(jid), None)
                _set_contact_name(contact, name, payload.get("name_source"))
                _set_contact_avatar(contact, payload.get("avatar_url"))
                await db.flush()
            preview = payload.get("last_message_preview")
            if preview:
                gw_ts = _as_naive_utc(_parse_dt(payload.get("last_message_at")))
                summary = _normalize_preview_text(payload.get("message_type"), str(preview))
                if summary:
                    if conv.last_message_at is None or not conv.last_message_preview:
                        apply_last_message(conv, None, summary)
                        if gw_ts and (conv.last_message_at is None or gw_ts > conv.last_message_at):
                            conv.last_message_at = gw_ts
                    else:
                        apply_last_message(conv, gw_ts, summary)
            last_at = _as_naive_utc(_parse_dt(payload.get("last_message_at")))
            if last_at and (conv.last_message_at is None or last_at > conv.last_message_at):
                conv.last_message_at = last_at
            # Tek karar noktasi: `should_apply_unread_count`. Eski `max()` kurali
            # okunmamis sayisinin ASLA dusmemesine yol aciyordu — baska bir
            # cihazda (telefon/WhatsApp Web) okunan sohbetin rozeti hic
            # temizlenmiyordu. Kural artik dususu kabul eder; yalnizca
            # kanitlanabilir sekilde ESKI snapshot'lari (bizim okumamizdan ya da
            # elimizdeki en yeni mesajdan once uretilmis) reddeder.
            try:
                if payload.get("unread_count") is not None:
                    apply_unread_count(
                        conv,
                        int(payload["unread_count"]),
                        incoming_activity_ts=_as_naive_utc(
                            _parse_dt(payload.get("last_message_at"))
                        ),
                    )
            except (TypeError, ValueError) as exc:
                logger.warning(
                    "Gateway unread_count gecersiz; mevcut deger korundu (conv=%s value=%r): %s",
                    conv.id, payload.get("unread_count"), exc,
                )
            await db.commit()
            if owner != SYSTEM_USER_ID and schedule_chats_bootstrap is not None:
                schedule_chats_bootstrap(owner)
            # Phase 2 (single authority): emit the SAME canonical conversation shape
            # that REST `list_conversations` emits. Previously the raw gateway object
            # was forwarded verbatim, which used different field names (e.g.
            # `lead_phone`) than the REST payload — so REST and WebSocket disagreed
            # about a conversation's identity, and the frontend merge
            # `{...existing, ...mapped}` could blank out known state.
            canonical_contact = (
                await db.get(Contact, conv.contact_id) if conv.contact_id else None
            )
            canonical_phone = canonical_contact.phone_e164 if canonical_contact else None
            canonical_is_group = bool(conv.is_group) or bool(
                canonical_phone and "@g.us" in str(canonical_phone)
            )
            canonical_name, canonical_id_state = _resolve_contact_identity(
                canonical_contact, phone=canonical_phone, is_group=canonical_is_group
            )
            canonical_preview = _normalize_preview_text(None, conv.last_message_preview) or None
            event["conversation"] = {
                "id": conv.id,
                "session_id": conv.session_id,
                "contact_id": conv.contact_id,
                "lead_id": conv.lead_id,
                "name": canonical_name,
                "phone": canonical_phone,
                "identity_state": canonical_id_state,
                "is_group": canonical_is_group,
                "is_archived": bool(conv.is_archived),
                "avatar_url": _get_contact_avatar(canonical_contact),
                "last_message_preview": canonical_preview,
                "last_message_at": conv.last_message_at.isoformat()
                if conv.last_message_at
                else None,
                "created_at": conv.created_at.isoformat() if conv.created_at else None,
                "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
                "unread_count": conv.unread_count,
                "last_message_state": "RESOLVED" if canonical_preview else "REPAIRING",
                "status": conv.status.value
                if hasattr(conv.status, "value")
                else str(conv.status),
            }
            return event
        if event.get("event") == "conversation_read":
            # `last_read_at` MUST be stamped alongside the counter: it is the
            # only record of WHEN the read happened, and
            # `should_apply_unread_count` uses it to reject a snapshot that was
            # produced before the read. Only stamping it on an already-nonzero
            # counter meant a read of an already-empty badge left no evidence,
            # so the next stale snapshot could resurrect the badge.
            if (conv.unread_count or 0) > 0:
                conv.unread_count = 0
            conv.last_read_at = datetime.utcnow()
            await db.commit()
        elif event.get("event") == "message_status_updated":
            wa_id = event.get("wa_message_id")
            new_status = (event.get("status") or "").upper()
            if wa_id and new_status in ConversationMessageStatus.__members__:
                row = matching_msg
                if row is None:
                    res = await db.execute(
                        select(Message).where(
                            or_(
                                Message.wa_message_id == wa_id,
                                Message.client_message_id == event["client_message_id"]
                                if event.get("client_message_id") else False,
                            ),
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
                        advance_message_status(row, new_status)
                    if row.status != orig_status or row.wa_message_id != orig_wa_id:
                        await db.commit()
                    event["message_id"] = row.id
                    event["client_message_id"] = row.client_message_id
                    event["status"] = row.status.value
                else:
                    # Early ACK, not a failure. WhatsApp acknowledged the message
                    # while its `message_new` upsert was still travelling, so the
                    # record will exist shortly. Buffer the ACK and apply it when
                    # the record lands. The old `LookupError` made the dispatcher
                    # discard the event permanently — the status never arrived and
                    # every early ACK logged a stack trace.
                    defer_status_update(event)
                    return _defer_event(
                        event,
                        f"message_status_updated: kayit henuz yok, ACK ertelendi ({wa_id or event.get('client_message_id')})",
                    )
        return event

    async def _map_session_event(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        gw_session_id = event.get("session_id") or event.get("gateway_session_id")
        if not gw_session_id:
            return _skip_event(event, "session_*: session_id yok")
        evt = event.get("event") or event.get("event_type") or ""
        res = await db.execute(select(WhatsAppSession).where(WhatsAppSession.gateway_id == str(gw_session_id)))
        row = res.scalar_one_or_none()
        if row is None:
            # Phase 15.3 Scenario A self-healing:
            # A session_connected event arrived with a gateway UUID unknown to our DB.
            # Delegate to RelinkReconciliationService — atomic, deterministic, idempotent.
            # This layer does NOT perform direct DB mutations; all repair is in relink.py.
            if evt == "session_connected":
                from backend.app.services.whatsapp.orchestration.relink import (
                    RelinkCandidateAmbiguous,
                    RelinkCandidateNotFound,
                    perform_atomic_relink,
                )
                from backend.app.services.whatsapp.orchestration.sessions import (
                    find_ephemeral_pairing_by_gateway_id,
                    remove_ephemeral_pairing_by_gateway_id,
                )
                from backend.app.services.whatsapp.orchestration.promotion import (
                    promote_ephemeral_pairing,
                )

                phone_from_event = (event.get("phone") or event.get("phone_number") or "").strip()
                user_id_from_event = (event.get("user_id") or "").strip()

                # 1. Resolve through ephemeral pairing registry if available
                pairing = find_ephemeral_pairing_by_gateway_id(str(gw_session_id))
                if pairing:
                    user_id_from_event = user_id_from_event or pairing.get("user_id")
                    if not phone_from_event and pairing.get("phone"):
                        phone_from_event = pairing["phone"]

                # 1b. P6-8: AUTHORITATIVE PROMOTION. Before this branch existed the
                #     ONLY code path able to CREATE a durable row for a first-time
                #     pairing was `get_pairing_qr` polling, so a phone that really
                #     connected produced no row unless the browser kept polling.
                #     `promote_ephemeral_pairing` completes the promotion from this
                #     event alone (create OR relink), resolving the owner from the
                #     in-memory registry, the DURABLE pairing record, or the
                #     explicit owner on the event — and fails closed otherwise.
                promoted = await promote_ephemeral_pairing(
                    db,
                    gateway_session_id=str(gw_session_id),
                    user_id=str(user_id_from_event) if user_id_from_event else None,
                    phone=phone_from_event or None,
                    session_name=event.get("session_name"),
                    self_jid=event.get("self_jid"),
                    self_lid=event.get("self_lid"),
                    in_memory_pairing=pairing,
                )
                if promoted is not None:
                    remove_ephemeral_pairing_by_gateway_id(str(gw_session_id))
                    event["session_id"] = promoted.id
                    event["session_name"] = event.get("session_name") or promoted.session_name
                    event["user_id"] = str(promoted.user_id) if promoted.user_id else None
                    if promoted.user_id and promoted.phone_number:
                        try:
                            await self.reconcile_self_identity(
                                db, str(promoted.user_id), promoted, self_lid=event.get("self_lid")
                            )
                        except Exception as rec_err:
                            logger.warning(
                                "[WhatsApp] Self identity reconciliation warning: %s", rec_err
                            )
                    return event

                # 2. If user_id is still unknown, resolve deterministically via phone + RELINK_REQUIRED
                # Section 10: 0 -> fail closed, 1 -> valid, >1 -> fail closed
                if not user_id_from_event and phone_from_event:
                    clean_digits = phone_from_event.split("@")[0].lstrip("+")
                    clean_e164 = f"+{clean_digits}"
                    cand_stmt = select(WhatsAppSession).where(
                        or_(
                            WhatsAppSession.phone_number == phone_from_event,
                            WhatsAppSession.phone_number == clean_e164,
                            WhatsAppSession.phone_number == clean_digits,
                        ),
                        WhatsAppSession.status == SessionStatus.RELINK_REQUIRED,
                        WhatsAppSession.is_active.is_(True),
                    )
                    cand_res = await db.execute(cand_stmt)
                    candidates = cand_res.scalars().all()
                    if len(candidates) == 1:
                        user_id_from_event = str(candidates[0].user_id)
                    elif len(candidates) > 1:
                        logger.error(
                            "[Phase15.4] Multiple (%d) RELINK_REQUIRED candidates for phone %s — fail closed",
                            len(candidates),
                            phone_from_event,
                        )
                        raise EventOwnerUnresolved(
                            f"Ambiguous relink candidates for phone {phone_from_event} — fail closed."
                        )

                if phone_from_event and user_id_from_event:
                    try:
                        relink_result = await perform_atomic_relink(
                            db,
                            user_id=user_id_from_event,
                            phone=phone_from_event,
                            new_gateway_id=str(gw_session_id),
                        )
                        remove_ephemeral_pairing_by_gateway_id(str(gw_session_id))
                        logger.info(
                            "[Phase15.4] map_session_event relink OK: session=%s %s→%s (history=%d)",
                            relink_result.session_id,
                            relink_result.old_gateway_id,
                            relink_result.new_gateway_id,
                            relink_result.history_rows_migrated,
                        )
                        res2 = await db.execute(
                            select(WhatsAppSession).where(WhatsAppSession.id == relink_result.session_id)
                        )
                        row = res2.scalar_one_or_none()
                        if row is not None:
                            event["session_id"] = row.id
                            event["session_name"] = event.get("session_name") or row.session_name
                            event["user_id"] = str(row.user_id) if row.user_id else None
                            if row.user_id and row.phone_number:
                                try:
                                    await self.reconcile_self_identity(
                                        db, str(row.user_id), row, self_lid=event.get("self_lid")
                                    )
                                except Exception as rec_err:
                                    logger.warning(
                                        "[WhatsApp] Self identity reconciliation warning: %s", rec_err
                                    )
                            return event
                    except RelinkCandidateAmbiguous as exc:
                        logger.error("[Phase15.4] Relink ambiguous in map_session_event: %s", exc)
                        raise EventOwnerUnresolved(str(exc)) from exc
                    except RelinkCandidateNotFound:
                        pass  # Fall through to EventOwnerUnresolved below
            # P6-9: a NEW (ephemeral) pairing has NO `whatsapp_sessions` row —
            # that is the point of the lifecycle (zero rows until connected).
            # Its owner was recorded in the ephemeral registry when the pairing
            # was started, so resolve the tenant THERE.
            #
            # This must NOT become a global broadcast: the event is attributed
            # to the single recorded owner and to nobody else. Anything that
            # cannot be attributed still fails closed below.
            from backend.app.services.whatsapp.orchestration.sessions import (
                find_ephemeral_pairing_by_gateway_id,
            )

            eph = find_ephemeral_pairing_by_gateway_id(str(gw_session_id))
            if eph and eph.get("user_id"):
                event["user_id"] = str(eph["user_id"])
                event["session_name"] = (
                    event.get("session_name") or eph.get("session_name")
                )
                event["pair_token"] = event.get("pair_token") or eph.get("pair_token")
                # No DB row exists yet, so there is nothing to mutate: the event
                # is only routed to its owner. (QR is intentionally not
                # persisted — the UI shows it straight from the socket.)
                return event

            raise EventOwnerUnresolved(
                f"Bilinmeyen gateway oturumu (session_id={gw_session_id}, event={evt}) — "
                "gateway yeniden baslatilmis olabilir; QR ile yeniden eslestirin."
            )
        event["session_id"] = row.id
        event["session_name"] = event.get("session_name") or row.session_name
        event["user_id"] = str(row.user_id) if row.user_id else None
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
            if row.user_id and row.phone_number:
                try:
                    await self.reconcile_self_identity(
                        db, str(row.user_id), row, self_lid=event.get("self_lid")
                    )
                except Exception as rec_err:
                    logger.warning("[WhatsApp] Self identity auto-reconciliation warning: %s", rec_err)
        elif evt == "session_disconnected":
            # A4: gateway emits reason ('LOGGED_OUT' | 'BANNED') but the
            # broadcast payload used to drop it, so the UI could never tell a
            # logout/ban from a transient disconnect. Copy reason into the
            # event dict so the broadcast carries it (frontend contract:
            # event name stays "session_disconnected", payload gains "reason").
            reason = event.get("reason")
            if reason:
                event["reason"] = str(reason)
            row.status = SessionStatus.DISCONNECTED
            row.is_phone_online = False
            if str(reason or "") == "LOGGED_OUT":
                # SessionStatus has no LOGGED_OUT member; keep DISCONNECTED and
                # surface the cause via error_message so the UI can react.
                row.error_message = "WHATSAPP_LOGGED_OUT"
            row.updated_at = datetime.utcnow()
        elif evt == "session_qr_updated":
            row.status = SessionStatus.SCAN_QR
            qr = event.get("qr_code")
            if qr:
                row.qr_code = str(qr)
            row.error_message = None
            row.updated_at = datetime.utcnow()
        return event

    async def _recover_message_new_after_integrity_error(
        self,
        db: AsyncSession,
        event: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """message_new icin IntegrityError sonrasi canli broadcast kurtarmasi.

        Senkron-job'un bulk ingest'i ile gercek zamanli ingest ayni
        (conversation_id, wa_message_id)/(conversation_id, client_message_id)
        satiri icin yarisabilir; kaybeden taraf IntegrityError alir. Mesaj o
        anda DB'ye YAZILMISTIR — olayi dusurmek, sohbet listesi
        conversation_updated ile guncellenirken acik thread'deki balonun
        sessizce kaybolmasi demektir. Kazanan satir yeniden secilip olay yine
        de yayinlanir; satir bulunamazsa None doner (olay bilincli dusulur).
        """
        resolve_event_owner_and_session = self._get_helper(
            "_resolve_event_owner_and_session", _resolve_event_owner_and_session
        )
        advance_message_status = self._get_helper("_advance_message_status", _advance_message_status)
        serialize_message = self._get_helper("_serialize_message", _serialize_message)

        msg = event.get("message") or {}
        jid = msg.get("conversation_id") or event.get("conversation_id")
        if not jid or "@" not in str(jid):
            return None
        wa_id = msg.get("wa_message_id")
        client_id = msg.get("client_message_id")
        if not wa_id and not client_id:
            return None
        # Sahip tercihen olaydan okunur: `_ingest_message`, INSERT'e girmeden
        # once `event["user_id"]` yazmistir; yeniden cozumlemek hem gereksiz
        # bir tur hem de sahibi cozumleme noktasina bagli senkronizasyon
        # yardimcilarinin (test barrier'lari) yeniden girilmesi riskidir.
        owner = event.get("user_id")
        if owner is None:
            try:
                owner, _ws_session_id = await resolve_event_owner_and_session(
                    db, str(jid), event.get("gateway_session_id")
                )
            except EventOwnerUnresolved:
                return None
            event["user_id"] = owner

        # Konusma kimligi cozumlenmez: kazanan satir kendi conversation_id'sini
        # tasir (LID -> PN baristirmasinda kardes konusmaya tasinmis olabilir)
        # ve yayın o kimlikle yapilir — API'den yeniden cekim her zaman ayni
        # satiri gosterir, sahte veri uretilmez.
        res = await db.execute(
            select(Message)
            .where(
                or_(
                    Message.wa_message_id == wa_id if wa_id else False,
                    Message.client_message_id == client_id if client_id else False,
                ),
                get_user_filter(Message.user_id, owner),
            )
            .order_by(Message.id.desc())
            .limit(1)
        )
        canonical = res.scalars().first()
        if canonical is None:
            return None
        advance_message_status(canonical, msg.get("status"))
        event["conversation_id"] = canonical.conversation_id
        event["jid"] = str(jid)
        event["message"] = serialize_message(canonical)
        return event



    async def _ingest_conversation_deleted(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        """Telefonda silinen sohbeti burada da siler (urun karari: TAM silme).

        WhatsApp paritesi: bir cihazda silinen sohbet her cihazda kaybolur.
        Gateway, Baileys'in `chats.delete` olayini `conversation_deleted` olarak
        yayiyor; YETKI karari burada verilir — jid'den kullaniciya cozum ve
        kiraci filtresi gateway'de yoktur ve olmamalidir.

        Silme TOPLU yapilir; ORM cascade'e birakilmaz. Ayni gerekce
        `whatsapp_service.delete_conversation` icin de yazilmisti: 10 bin
        mesajlik bir sohbeti oturuma yukleyip tek tek silmek bellegi sisirir.
        """
        resolve_event_owner_and_session = self._get_helper(
            "_resolve_event_owner_and_session", _resolve_event_owner_and_session
        )
        find_whatsapp_conversation = self._get_helper(
            "_find_whatsapp_conversation", _find_whatsapp_conversation
        )

        jid = event.get("conversation_id")
        if not jid or "@" not in str(jid):
            return _skip_event(event, "conversation_deleted: sohbet jid'i cozulemedi")
        clean_jid = _strip_jid_prefix(str(jid))
        if is_broadcast_only_jid(clean_jid) or is_degenerate_jid(clean_jid):
            return _skip_event(event, f"conversation_deleted: gecersiz jid ({clean_jid})")

        owner, ws_session_id = await resolve_event_owner_and_session(
            db, clean_jid, event.get("gateway_session_id")
        )
        event["user_id"] = owner

        conv = await find_whatsapp_conversation(db, owner, str(jid), session_id=ws_session_id)
        if conv is None:
            # Idempotency, not an error: the same delete can arrive twice (durable
            # outbox replay + the live socket). The second delivery has nothing
            # left to delete.
            return _skip_event(event, f"conversation_deleted: sohbet zaten yok ({clean_jid})")

        conv_id = int(conv.id)
        reactions_deleted = (
            await db.execute(
                delete(MessageReaction).where(MessageReaction.conversation_id == conv_id)
            )
        ).rowcount
        messages_deleted = (
            await db.execute(delete(Message).where(Message.conversation_id == conv_id))
        ).rowcount
        await db.delete(conv)
        await db.commit()
        logger.info(
            "Telefondan silinen sohbet kaldirildi (conv=%s, messages=%s, reactions=%s)",
            conv_id,
            int(messages_deleted or 0),
            int(reactions_deleted or 0),
        )
        # NUMERIC id: this is exactly the shape `delete_conversation` broadcasts,
        # so the frontend's existing `conversation_deleted` branch handles both
        # the in-app delete and this phone-side one.
        event["conversation_id"] = conv_id
        event["wa_jid"] = clean_jid
        event["origin"] = event.get("origin") or "phone"
        event["deleted"] = True
        event["messages_deleted"] = int(messages_deleted or 0)
        event["reactions_deleted"] = int(reactions_deleted or 0)
        return event

    async def _ingest_messages_deleted(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        """Telefonda mesaj silindi ya da sohbet TEMIZLENDI.

        Iki sekil ayni olay adiyla gelir ama ayni islem DEGILDIR; karistirmak ya
        temizlenen sohbetin mesajlarini birakir ya da yalnizca TEMIZLENEN bir
        sohbeti komple siler:
          - `all: true`      -> mesajlar gider, sohbet KALIR
          - `wa_message_ids` -> yalnizca o mesajlar gider

        Sohbetin KENDISI silinirse ayri olay gelir (`conversation_deleted`).
        """
        resolve_event_owner_and_session = self._get_helper(
            "_resolve_event_owner_and_session", _resolve_event_owner_and_session
        )
        find_whatsapp_conversation = self._get_helper(
            "_find_whatsapp_conversation", _find_whatsapp_conversation
        )

        jid = event.get("conversation_id")
        if not jid or "@" not in str(jid):
            return _skip_event(event, "messages_deleted: sohbet jid'i cozulemedi")
        clean_jid = _strip_jid_prefix(str(jid))
        if is_broadcast_only_jid(clean_jid) or is_degenerate_jid(clean_jid):
            return _skip_event(event, f"messages_deleted: gecersiz jid ({clean_jid})")

        owner, ws_session_id = await resolve_event_owner_and_session(
            db, clean_jid, event.get("gateway_session_id")
        )
        event["user_id"] = owner

        conv = await find_whatsapp_conversation(db, owner, str(jid), session_id=ws_session_id)
        if conv is None:
            return _skip_event(event, f"messages_deleted: sohbet yok ({clean_jid})")
        conv_id = int(conv.id)

        if event.get("all"):
            deleted = (
                await db.execute(delete(Message).where(Message.conversation_id == conv_id))
            ).rowcount
            await db.execute(
                delete(MessageReaction).where(MessageReaction.conversation_id == conv_id)
            )
            # Nothing is left to preview or to be unread, so a preview/unread
            # pointing at a deleted message would make the list show text this
            # chat no longer has.
            conv.last_message_preview = None
            conv.unread_count = 0
            conv.last_message_at = None
            await db.commit()
            event["conversation_id"] = conv_id
            event["wa_jid"] = clean_jid
            event["all"] = True
            event["messages_deleted"] = int(deleted or 0)
            return event

        wa_ids = [str(x) for x in (event.get("wa_message_ids") or []) if x]
        if not wa_ids:
            return _skip_event(event, "messages_deleted: ne `all` ne `wa_message_ids` var")
        deleted = (
            await db.execute(
                delete(Message).where(
                    Message.conversation_id == conv_id,
                    Message.wa_message_id.in_(wa_ids),
                )
            )
        ).rowcount
        remaining = (
            await db.execute(
                select(func.count())
                .select_from(Message)
                .where(Message.conversation_id == conv_id)
            )
        ).scalar_one()
        if not remaining:
            # Every message went one-by-one: clear the same fields `all` clears.
            conv.last_message_preview = None
            conv.unread_count = 0
            conv.last_message_at = None
        await db.commit()
        event["conversation_id"] = conv_id
        event["wa_jid"] = clean_jid
        event["wa_message_ids"] = wa_ids
        event["messages_deleted"] = int(deleted or 0)
        event["messages_remaining"] = int(remaining or 0)
        return event

    @profiled("gateway_event")
    async def ingest_gateway_event(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Gateway event ingestion coordinator.

        Processes incoming events from Baileys gateway over /ws/gateway:
        - Validates and deduplicates event_id via processed_events table
        - Resolves tenant owner and maps event entities
        - Triggers initial sync scheduling on sync completion events
        - Fails closed on EventOwnerUnresolved or unhandled exceptions
        """
        schedule_initial_sync = self._get_helper("_schedule_initial_sync", None)
        initial_sync_inflight = self._get_helper("_initial_sync_inflight", set())
        ingest_message = self._get_helper("_ingest_message", self._ingest_message)
        map_conversation_event = self._get_helper("_map_conversation_event", self._map_conversation_event)
        ingest_contact_synced = self._get_helper("_ingest_contact_synced", self._ingest_contact_synced)
        map_session_event = self._get_helper("_map_session_event", self._map_session_event)
        passthrough_event = self._get_helper("_passthrough_event", self._passthrough_event)
        log_orphan_event = self._get_helper("_log_orphan_event", _log_orphan_event)
        enqueue_orphan_event = self._get_helper(
            "_enqueue_orphan_event", _enqueue_orphan_event
        )

        session_factory = self._get_helper("AsyncSessionLocal", AsyncSessionLocal)
        async with session_factory() as db:
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
                    result = await ingest_message(db, event)
                elif evt in ("conversation_updated", "conversation_read", "message_status_updated", "presence_updated"):
                    result = await map_conversation_event(db, event)
                elif evt == "contact_synced":
                    result = await ingest_contact_synced(db, event)
                elif evt == "conversation_deleted":
                    result = await self._ingest_conversation_deleted(db, event)
                elif evt == "messages_deleted":
                    result = await self._ingest_messages_deleted(db, event)
                elif evt == "message_reaction":
                    result = await self._ingest_message_reaction(db, event)
                elif evt == "lid_mapped":
                    result = await self._ingest_lid_mapped(db, event)
                elif evt == "connection_error" or str(evt).startswith("session_"):
                    result = await map_session_event(db, event)
                elif evt in _PASSTHROUGH_EVENTS:
                    result = await passthrough_event(db, event)
                else:
                    logger.error("Bilinmeyen gateway olayi yayinlanmadi (event=%s)", evt)
                    return None

                if not isinstance(result, dict):
                    logger.error("Gateway olayi sozluk degil, yayinlanmadi (event=%s)", evt)
                    return None
                if result.get("_skip"):
                    return None
                if not result.get("user_id"):
                    logger.warning(
                        "Gateway olayi sahipsiz (event=%s, gateway_session_id=%s) — "
                        "yayinlanmadi, yeniden oynanmak uzere tutuldu",
                        evt, event.get("gateway_session_id"),
                    )
                    enqueue_orphan_event(event, f"owner_unresolved:{evt}")
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

                if evt in ("session_sync_completed", "session_connected"):
                    owner = result.get("user_id")
                    if owner and owner != SYSTEM_USER_ID and schedule_initial_sync is not None:
                        # S-5: attribute the reconcile to the session that asked for
                        # it, so a reconnect storm coalesces per session instead of
                        # fanning out into parallel sync jobs.
                        schedule_initial_sync(
                            str(owner),
                            reconcile=evt == "session_sync_completed",
                            session_key=event.get("gateway_session_id"),
                        )
                # This event resolved an owner for its gateway session, so any
                # event held for that same session can be retried now: the
                # blocker (missing session row / contact) has demonstrably
                # cleared. No-op unless this session ever produced an orphan.
                await self._drain_orphan_queue(event.get("gateway_session_id"))
                return result
            except EventOwnerUnresolved as exc:
                await db.rollback()
                log_orphan_event(evt, exc, event.get("gateway_session_id"))
                # NOT discarded. The owner is often resolvable seconds later:
                # during a QR pairing the session's own row is created only on
                # promotion, so events that arrive while the phone is still
                # linking are unresolvable for a moment — and dropping them is
                # what starved the LID identity heal in production. Held for
                # replay; see `_drain_orphan_queue`.
                enqueue_orphan_event(event, f"owner_unresolved:{evt}")
                return None
            except IntegrityError as exc:
                await db.rollback()
                # Yaris kaybedildi demek mesajin YOK oldugu anlamina gelmez:
                # kazanan taraf zaten yazdi. message_new icin olay dusurulmez —
                # kazanan satir yeniden secilip broadcast edilir; aksi halde
                # liste conversation_updated ile guncellenirken acik thread'deki
                # balon sessizce kaybolur.
                recovered_event: Optional[Dict[str, Any]] = None
                if evt == "message_new":
                    try:
                        recovered_event = await self._recover_message_new_after_integrity_error(db, event)
                    except Exception as rec_exc:
                        await db.rollback()
                        logger.warning("message_new IntegrityError kurtarmasi basarisiz (event=%s): %s", evt, rec_exc)
                        recovered_event = None
                if recovered_event is not None:
                    if event_id and db.bind is not None and db.bind.dialect.name == "postgresql":
                        await db.execute(
                            text(
                                "INSERT INTO whatsapp_private.processed_events (event_id) "
                                "VALUES (:event_id) ON CONFLICT (event_id) DO NOTHING"
                            ),
                            {"event_id": event_id},
                        )
                    await db.commit()
                    logger.info(
                        "message_new DB yarisi kazanan satirla yeniden yayinlandi "
                        "(event=%s, conversation_id=%s)",
                        evt, recovered_event.get("conversation_id"),
                    )
                    return recovered_event
                logger.warning("Gateway olayi atlandi (DB yarisi, event=%s): %s", evt, exc)
                return None
            except Exception as exc:
                await db.rollback()
                logger.exception("Gateway olayi islenemedi, yayinlanmadi (event=%s): %s", evt, exc)
                return None


# Default module-level orchestrator instance
_default_orchestrator = WhatsAppEventOrchestrator()

ingest_gateway_event = _default_orchestrator.ingest_gateway_event
_ingest_message = _default_orchestrator._ingest_message
_ingest_message_reaction = _default_orchestrator._ingest_message_reaction
_ingest_contact_synced = _default_orchestrator._ingest_contact_synced
reconcile_legacy_split_conversation = _default_orchestrator.reconcile_legacy_split_conversation
_map_conversation_event = _default_orchestrator._map_conversation_event
_map_session_event = _default_orchestrator._map_session_event
_passthrough_event = _default_orchestrator._passthrough_event
_upsert_contact = _default_orchestrator._upsert_contact
_ensure_conversation = _default_orchestrator._ensure_conversation
_ensure_conversation_race_safe = _default_orchestrator._ensure_conversation_race_safe
_persist_gateway_message = _default_orchestrator._persist_gateway_message
