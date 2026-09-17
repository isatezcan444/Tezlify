"""WhatsApp Inbound Gateway Event Orchestration Service (Phase 11.10).

Handles all incoming events from the Baileys gateway (/ws/gateway):
- Inbound & outbound messages (message_new / message_upsert)
- Split conversation reconciliation (LID vs Phone JID)
- Conversation & presence updates (conversation_updated, presence_updated)
- Session lifecycle & connection state (session_connected, connection_error, etc.)
- Contact synchronization (contact_synced)
- Deduplication and idempotency tracking (processed_events table)
- Fail-closed orphan event handling (EventOwnerUnresolved -> rollback)
"""
from datetime import datetime
import logging
import time
from typing import Any, Dict, FrozenSet, List, Optional, Tuple
import uuid

from sqlalchemy import or_, select, text
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
    find_whatsapp_conversation as _find_whatsapp_conversation,
    get_conversation_scope_filters as _conversation_scope_filters,
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


def _skip_event(event: Dict[str, Any], reason: str) -> Dict[str, Any]:
    """Marks an event with _skip so it is not broadcast but debug-logged."""
    logger.debug("Gateway olayi kalici yazilmadi (%s)", reason)
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


class WhatsAppEventOrchestrator:
    """Coordinates incoming Baileys gateway event ingestion, validation, persistence, and dispatch."""

    def __init__(self, service: Optional[Any] = None) -> None:
        self.service = service

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
    ) -> Contact:
        clean_jid = _strip_jid_prefix(jid)
        if is_degenerate_jid(clean_jid):
            raise ValueError(f"Degenerate WhatsApp JID reddedildi: {jid}")
        if is_broadcast_only_jid(clean_jid):
            raise ValueError(f"Broadcast-only WhatsApp JID reddedildi: {jid}")

        # Check if clean_jid is the authenticated user's self identity
        sess_stmt = (
            select(WhatsAppSession)
            .where(
                get_user_filter(WhatsAppSession.user_id, user_id),
                WhatsAppSession.status == SessionStatus.CONNECTED,
                WhatsAppSession.is_active.is_(True),
            )
            .order_by(WhatsAppSession.id.desc())
        )
        active_sess = (await db.execute(sess_stmt)).scalars().first()
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
            phone_e164 = canonical_phone
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
            contact = Contact(
                user_id=user_id,
                phone_e164=phone_e164,
                display_name=(None if _is_raw_jid_name(display_name) else display_name) or jid_to_phone(clean_jid),
            )
            if display_name and str(name_source or "") in _NAME_RANK:
                contact.custom_attributes = {"name_source": str(name_source)}
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
        contact = await upsert_contact(db, user_id, jid, contact_name, contact_source)
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
        db.add(row)
        summary = build_last_message_summary(
            message_type=row.message_type.value,
            body=row.body,
            sender_name=row.sender_name,
            is_group="@g.us" in jid_str,
            direction=row.direction.value,
        )
        apply_last_message(conv, ts, summary)
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
            contact = await upsert_contact(db, owner, jid_str, name_for_contact, source_for_contact)

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
                canonical.wa_message_id = wa_id or canonical.wa_message_id
                advance_message_status(canonical, msg.get("status"))
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
            sender_phone=msg.get("sender_phone") or jid_to_phone(jid_str) or "unknown",
            sender_name=(
                "ME"
                if direction == MessageDirection.OUTBOUND
                else (msg.get("participant_name") or (None if is_group_jid else contact.display_name))
            ),
            recipient_phone=msg.get("recipient_phone") or "ME" if direction == MessageDirection.INBOUND else contact.phone_e164,
            status=ConversationMessageStatus.RECEIVED if direction == MessageDirection.INBOUND else ConversationMessageStatus.SENT,
            external_timestamp=_as_naive_utc(_parse_dt(msg.get("created_at"))),
        )
        db.add(row)
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
        await db.flush()

        event["conversation_id"] = conv.id
        event["message"] = serialize_message(row)
        return event

    async def _ingest_contact_synced(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        resolve_event_owner = self._get_helper("_resolve_event_owner", _resolve_event_owner)
        upsert_contact = self._get_helper("_upsert_contact", self._upsert_contact)
        contact_payload = event.get("contact") or {}
        jid = contact_payload.get("id") or contact_payload.get("jid")
        if not jid or "@" not in str(jid):
            return _skip_event(event, "contact_synced: gecerli jid yok")
        clean_jid = _strip_jid_prefix(str(jid))
        if is_broadcast_only_jid(clean_jid):
            return _skip_event(event, f"contact_synced: broadcast-only jid ({clean_jid})")
        if is_degenerate_jid(clean_jid):
            return _skip_event(event, f"contact_synced: dejenere jid ({clean_jid})")
        phone_e164 = _contact_phone_for_jid(clean_jid)
        owner = await resolve_event_owner(db, clean_jid, event.get("gateway_session_id"))
        event["user_id"] = owner

        sess_stmt = (
            select(WhatsAppSession)
            .where(
                get_user_filter(WhatsAppSession.user_id, owner),
                WhatsAppSession.status == SessionStatus.CONNECTED,
                WhatsAppSession.is_active.is_(True),
            )
            .order_by(WhatsAppSession.id.desc())
        )
        active_sess = (await db.execute(sess_stmt)).scalars().first()
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
                contact = await upsert_contact(db, owner, clean_jid, name, source)
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

    async def _ingest_lid_mapped(self, db: AsyncSession, event: Dict[str, Any]) -> Dict[str, Any]:
        resolve_event_owner = self._get_helper("_resolve_event_owner", _resolve_event_owner)
        lid = event.get("lid")
        phone_jid = event.get("phone_jid")
        if not lid or not phone_jid:
            return _skip_event(event, "lid_mapped: lid veya phone_jid eksik")
        clean_lid = _strip_jid_prefix(str(lid))
        clean_phone = _strip_jid_prefix(str(phone_jid))
        owner = await resolve_event_owner(db, clean_phone, event.get("gateway_session_id"))
        event["user_id"] = owner
        reconciled = await self.reconcile_legacy_split_conversation(db, owner, clean_lid, clean_phone)
        if reconciled:
            event["reconciled_conversation_id"] = reconciled.id
            event["event"] = "conversations_updated"
            event["conversation"] = {
                "id": reconciled.id,
                "archived_lid": clean_lid,
                "lead_phone": reconciled.contact.phone_e164 if reconciled.contact else clean_phone,
                "last_message_preview": reconciled.last_message_preview,
                "last_message_at": reconciled.last_message_at.isoformat() if reconciled.last_message_at else None,
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
                        msg.contact_id = canonical_contact.id
                        if msg.wa_message_id:
                            existing_wa_ids.add(msg.wa_message_id)
                        moved_msgs += 1

                await db.delete(dup_conv)
                merged_convs.append(dup_conv.id)

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
            try:
                if payload.get("unread_count") is not None:
                    conv.unread_count = max(conv.unread_count or 0, int(payload["unread_count"]))
            except (TypeError, ValueError) as exc:
                logger.warning(
                    "Gateway unread_count gecersiz; mevcut deger korundu (conv=%s value=%r): %s",
                    conv.id, payload.get("unread_count"), exc,
                )
            await db.commit()
            if owner != SYSTEM_USER_ID and schedule_chats_bootstrap is not None:
                schedule_chats_bootstrap(owner)
            return event
        if event.get("event") == "conversation_read":
            if (conv.unread_count or 0) > 0:
                conv.unread_count = 0
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
                    raise LookupError("Provider ACK precedes its message record; retry required")
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
                phone_from_event = (event.get("phone") or event.get("phone_number") or "").strip()
                user_id_from_event = (event.get("user_id") or "").strip()
                if phone_from_event and user_id_from_event:
                    try:
                        relink_result = await perform_atomic_relink(
                            db,
                            user_id=user_id_from_event,
                            phone=phone_from_event,
                            new_gateway_id=str(gw_session_id),
                        )
                        logger.info(
                            "[Phase15.3] map_session_event relink OK: session=%s %s→%s (history=%d)",
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
                        logger.error("[Phase15.3] Relink ambiguous in map_session_event: %s", exc)
                        raise EventOwnerUnresolved(str(exc)) from exc
                    except RelinkCandidateNotFound:
                        pass  # Fall through to EventOwnerUnresolved below
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

                if evt in ("session_sync_completed", "session_connected"):
                    owner = result.get("user_id")
                    if owner and owner != SYSTEM_USER_ID and schedule_initial_sync is not None:
                        schedule_initial_sync(
                            str(owner), reconcile=evt == "session_sync_completed"
                        )
                return result
            except EventOwnerUnresolved as exc:
                await db.rollback()
                log_orphan_event(evt, exc, event.get("gateway_session_id"))
                return None
            except IntegrityError as exc:
                await db.rollback()
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
_ingest_contact_synced = _default_orchestrator._ingest_contact_synced
reconcile_legacy_split_conversation = _default_orchestrator.reconcile_legacy_split_conversation
_map_conversation_event = _default_orchestrator._map_conversation_event
_map_session_event = _default_orchestrator._map_session_event
_passthrough_event = _default_orchestrator._passthrough_event
_upsert_contact = _default_orchestrator._upsert_contact
_ensure_conversation = _default_orchestrator._ensure_conversation
_ensure_conversation_race_safe = _default_orchestrator._ensure_conversation_race_safe
_persist_gateway_message = _default_orchestrator._persist_gateway_message
