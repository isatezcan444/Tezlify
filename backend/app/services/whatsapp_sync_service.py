"""
WhatsApp Sync Service.
Coordinates synchronization of WhatsApp chat history and live two-way message mirroring
between Baileys wa-gateway, Leads, Conversations, and Messages.
"""
import time
import logging
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_

from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.message import (
    Message,
    MessageDirection,
    MessageType,
    ConversationMessageStatus,
)
from backend.app.services.phone_service import PhoneService
from backend.app.api.v1.websocket import ws_manager

logger = logging.getLogger(__name__)


def _to_naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _split_jid_number(participant_raw: Optional[str]) -> tuple[bool, str]:
    """Splits 'user[:device]@domain' into (is_lid, digit_or_empty).

    A @lid value is an opaque device identity — never a dialable number.
    """
    if not participant_raw or not isinstance(participant_raw, str):
        return False, ""
    is_lid = participant_raw.strip().endswith("@lid")
    number = participant_raw.split(":")[0].split("@")[0].strip()
    if not number or not number.isdigit():
        return is_lid, ""
    return is_lid, number


def _normalize_pn_jid(participant_pn: Optional[str]) -> Optional[str]:
    """Normalizes a gateway-resolved phone JID ('9053..@s.whatsapp.net' or
    '+9053..') to E.164, else None."""
    if not participant_pn or not isinstance(participant_pn, str):
        return None
    candidate = participant_pn.strip()
    if "@" in candidate:
        candidate = "+" + candidate.split(":")[0].split("@")[0].strip()
    phone_data = PhoneService.normalize_to_e164(candidate)
    if phone_data and phone_data.get("is_valid"):
        return phone_data["e164"]
    return None


#: Sender names that carry no information — eligible for upgrade on resync.
POOR_SENDER_NAMES = frozenset({"", "Grup Üyesi"})


def _is_poor_sender_name(sender_name: Optional[str], sender_phone: Optional[str] = None) -> bool:
    """True when a stored sender name is missing, generic, or merely echoes
    the sender's own phone number (a previous honest fallback, still
    upgradeable to a real contact name later)."""
    if not sender_name or sender_name in POOR_SENDER_NAMES:
        return True
    if sender_phone and "@" not in sender_phone:
        norm = PhoneService.normalize_to_e164(sender_phone)
        if norm and norm.get("is_valid") and sender_name.strip() == norm["e164"]:
            return True
        if sender_name.strip() == sender_phone.strip():
            return True
    return False


class WhatsAppSyncService:
    """Handles synchronization of WhatsApp chat history and two-way messaging."""

    @classmethod
    async def get_or_create_lead_and_conversation(
        cls,
        db: AsyncSession,
        user_id: Optional[str],
        phone_e164: Optional[str] = None,
        contact_name: Optional[str] = None,
        is_group: bool = False,
        group_jid: Optional[str] = None,
        avatar_url: Optional[str] = None,
        conversation_timestamp: Optional[datetime] = None,
        raw_key: Optional[str] = None,
    ) -> tuple[Lead, Conversation]:
        """
        Idempotently resolves or provisions a Lead and an active WHATSAPP Conversation.
        Supports individual contacts, WhatsApp groups (@g.us), and unresolvable
        LID identities (raw_key: keyed by raw JID string, phone_e164 stays None —
        a fake +number is never fabricated).
        Strictly scoped to the tenant's user_id.
        """
        resolved_is_group = bool(
            is_group
            or (group_jid and group_jid.endswith("@g.us"))
            or (phone_e164 and phone_e164.endswith("@g.us"))
        )

        lead: Optional[Lead] = None

        if resolved_is_group:
            effective_jid = group_jid or phone_e164 or ""
            lead_stmt = select(Lead).where(
                Lead.phone == effective_jid,
                Lead.user_id == user_id,
            )
            lead_res = await db.execute(lead_stmt.limit(1))
            lead = lead_res.scalars().first()

            if not lead:
                display_name = (contact_name or "").strip() or "WhatsApp Grubu"
                custom_data = {"is_group": True, "jid": effective_jid}
                if avatar_url:
                    custom_data["avatar_url"] = avatar_url

                lead = Lead(
                    user_id=user_id,
                    name=display_name,
                    phone=effective_jid,
                    phone_e164=None,
                    is_whatsapp_eligible=True,
                    category="WhatsApp Grubu",
                    notes=f"WhatsApp Grubu senkronize edildi ({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')})",
                    custom_data=custom_data,
                    status=LeadStatus.CONTACTED,
                )
                db.add(lead)
                await db.flush()
            else:
                updated = False
                if contact_name and contact_name.strip() and lead.name in ("WhatsApp Grubu", "", None):
                    lead.name = contact_name.strip()
                    updated = True
                if avatar_url:
                    cdata = dict(lead.custom_data or {})
                    if cdata.get("avatar_url") != avatar_url:
                        cdata["avatar_url"] = avatar_url
                        lead.custom_data = cdata
                        updated = True
                if updated:
                    await db.flush()
        else:
            if not phone_e164 and not raw_key:
                raise ValueError("phone_e164 is required for individual direct chats.")

            lead = None
            if phone_e164:
                lead_stmt = select(Lead).where(
                    Lead.phone_e164 == phone_e164,
                    Lead.user_id == user_id,
                )
                lead_res = await db.execute(lead_stmt.limit(1))
                lead = lead_res.scalars().first()

            if not lead and raw_key:
                # Unresolvable identity (e.g. @lid without PN mapping): key by
                # the raw JID string so the chat is never lost.
                lead_stmt = select(Lead).where(
                    Lead.phone == raw_key,
                    Lead.user_id == user_id,
                )
                lead_res = await db.execute(lead_stmt.limit(1))
                lead = lead_res.scalars().first()
                if lead is not None and phone_e164:
                    # Self-healing: the phone is now known — upgrade the
                    # placeholder row in place instead of splitting identity.
                    lead.phone = phone_e164
                    lead.phone_e164 = phone_e164
                    lead.is_whatsapp_eligible = True
                    await db.flush()

            if not lead:
                display_name = contact_name.strip() if contact_name and contact_name.strip() else f"WhatsApp ({phone_e164 or raw_key})"
                custom_data = {}
                if avatar_url:
                    custom_data["avatar_url"] = avatar_url

                lead = Lead(
                    user_id=user_id,
                    name=display_name,
                    phone=phone_e164 or raw_key,
                    phone_e164=phone_e164,
                    is_whatsapp_eligible=bool(phone_e164),
                    category="WhatsApp Sohbeti",
                    notes=f"WhatsApp üzerinden senkronize edildi ({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')})",
                    custom_data=custom_data if custom_data else None,
                    status=LeadStatus.CONTACTED,
                )
                db.add(lead)
                await db.flush()
            else:
                updated = False
                if contact_name and contact_name.strip() and (not lead.name or lead.name.startswith("WhatsApp (")):
                    lead.name = contact_name.strip()
                    updated = True
                if avatar_url:
                    cdata = dict(lead.custom_data or {})
                    if cdata.get("avatar_url") != avatar_url:
                        cdata["avatar_url"] = avatar_url
                        lead.custom_data = cdata
                        updated = True
                if updated:
                    await db.flush()

        # 2. Resolve or create Conversation
        conv_stmt = select(Conversation).where(
            Conversation.lead_id == lead.id,
            Conversation.channel == "WHATSAPP",
            Conversation.user_id == user_id,
        )
        conv = (await db.execute(conv_stmt.limit(1))).scalars().first()

        naive_conv_time = _to_naive_utc(conversation_timestamp)

        if not conv:
            conv = Conversation(
                user_id=user_id,
                lead_id=lead.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                unread_count=0,
                last_message_at=naive_conv_time,
            )
            db.add(conv)
            await db.flush()
        elif naive_conv_time:
            current_last = _to_naive_utc(conv.last_message_at)
            if not current_last or current_last.year < 2020 or naive_conv_time > current_last:
                conv.last_message_at = naive_conv_time
                await db.flush()

        return lead, conv

    @staticmethod
    def _participant_identity(
        participant_raw: Optional[str], participant_pn: Optional[str]
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        """Resolves a message author to (e164, display, raw).

        PN (the gateway's LID→phone mapping for THIS connected phone) wins.
        A raw phone JID normalizes; a @lid value without mapping stays opaque.
        Display is the real number when known, else None — a fake +number is
        never fabricated from a LID.
        """
        if participant_pn:
            e164 = _normalize_pn_jid(participant_pn)
            if e164:
                return e164, e164, participant_raw
        if participant_raw:
            is_lid, number = _split_jid_number(participant_raw)
            if number and not is_lid:
                phone_norm = PhoneService.normalize_to_e164(f"+{number}")
                if phone_norm and phone_norm.get("is_valid"):
                    return phone_norm["e164"], phone_norm["e164"], participant_raw
                return None, f"+{number}", participant_raw
            return None, None, participant_raw
        return None, None, None

    @classmethod
    async def _resolve_sender_via_participant(
        cls,
        db: AsyncSession,
        user_id: Optional[str],
        participant_raw: Optional[str],
        participant_pn: Optional[str],
    ) -> Optional[str]:
        """CRM contact name for a participant, else real-phone display, else None."""
        e164, display, _raw = cls._participant_identity(participant_raw, participant_pn)
        if e164:
            name = await cls._lookup_lead_name(db, user_id, e164)
            return name or e164
        return display

    @classmethod
    async def _heal_poor_sender_names(
        cls, db: AsyncSession, user_id: Optional[str], limit: int = 1000
    ) -> int:
        """Upgrades uninformative sender_names on historical rows.

        Covers legacy 'Grup Üyesi'/empty placeholders using the phone already
        stored on each row (CRM leads lookup, else the real number itself).
        Outbound rows become 'Siz'. Returns healed count. Only ever writes
        truthful values — unknown senders are left untouched.
        """
        stmt = (
            select(Message)
            .where(
                Message.user_id == user_id,
                or_(Message.sender_name.is_(None), Message.sender_name.in_(["", "Grup Üyesi"])),
            )
            .order_by(Message.id.desc())
            .limit(limit)
        )
        rows = (await db.execute(stmt)).scalars().all()
        if not rows:
            return 0

        # Batch the CRM name lookup over distinct phones (one round-trip).
        wanted: set[str] = set()
        for row in rows:
            if (
                row.direction == MessageDirection.INBOUND
                and row.sender_phone
                and "@" not in row.sender_phone
            ):
                norm = PhoneService.normalize_to_e164(row.sender_phone)
                if norm and norm.get("is_valid"):
                    wanted.add(norm["e164"])
        name_by_phone: dict[str, str] = {}
        if wanted:
            lead_rows = (
                await db.execute(
                    select(Lead.phone_e164, Lead.name)
                    .where(Lead.phone_e164.in_(wanted), Lead.user_id == user_id)
                )
            ).all()
            for e164, name in lead_rows:
                if name and not name.startswith("WhatsApp ("):
                    name_by_phone[e164] = name

        healed = 0
        for row in rows:
            if row.direction == MessageDirection.OUTBOUND:
                row.sender_name = "Siz"
                healed += 1
                continue
            if not row.sender_phone or "@" in row.sender_phone:
                continue
            norm = PhoneService.normalize_to_e164(row.sender_phone)
            if not norm or not norm.get("is_valid"):
                continue
            e164 = norm["e164"]
            row.sender_name = name_by_phone.get(e164, e164)
            healed += 1
        return healed

    @classmethod
    async def _lookup_lead_name(        cls, db: AsyncSession, user_id: Optional[str], e164: Optional[str]
    ) -> Optional[str]:
        """Returns the CRM contact name for a phone number, else None.

        Only real saved names qualify (never 'WhatsApp (...)' placeholders,
        never fabricated numbers). A None user_id matches NULL-tenant rows
        via IS NULL, same as every other query in this service.
        """
        if not e164:
            return None
        stmt = (
            select(Lead)
            .where(Lead.phone_e164 == e164, Lead.user_id == user_id)
            .limit(1)
        )
        row = (await db.execute(stmt)).scalars().first()
        if row and row.name and not row.name.startswith("WhatsApp ("):
            return row.name
        return None

    @classmethod
    async def process_message_event(
        cls,
        db: AsyncSession,
        session_name: str,
        event_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Processes a live single-message event (inbound from contact/group OR outbound from user's phone).
        """
        raw_phone = event_data.get("phone")
        message_text = (event_data.get("message") or "").strip()
        from_me = bool(event_data.get("fromMe", False))
        wa_message_id = event_data.get("wa_message_id")
        timestamp = event_data.get("timestamp")
        is_group = bool(event_data.get("is_group", False) or (raw_phone and raw_phone.endswith("@g.us")))

        if not raw_phone or not message_text:
            return {"status": "ignored", "reason": "Missing phone or message"}

        if is_group:
            contact_e164 = raw_phone
            raw_contact_key = None
        else:
            phone_data = PhoneService.normalize_to_e164(raw_phone)
            if phone_data and phone_data.get("is_valid"):
                contact_e164 = phone_data["e164"]
                raw_contact_key = None
            elif raw_phone and "@" in raw_phone:
                # Unresolvable identity (e.g. @lid without PN mapping yet):
                # key the chat by raw JID instead of dropping the message.
                contact_e164 = None
                raw_contact_key = raw_phone
            else:
                return {"status": "ignored", "reason": "Invalid phone format"}

        # Resolve WhatsApp session to find user_id & sender phone
        sess_stmt = select(WhatsAppSession).where(WhatsAppSession.session_name == session_name)
        sess_res = await db.execute(sess_stmt.limit(1))
        session = sess_res.scalars().first()
        if not session:
            return {"status": "ignored", "reason": f"Session {session_name} not found"}

        user_id = session.user_id
        my_phone = session.phone_number or "ME"

        gateway_name = event_data.get("sender_name")
        remote_jid = event_data.get("remote_jid") or ""
        raw_lid_key = remote_jid if remote_jid.strip().endswith("@lid") else None
        lead, conv = await cls.get_or_create_lead_and_conversation(
            db=db,
            user_id=user_id,
            phone_e164=None if is_group else contact_e164,
            contact_name=gateway_name if (gateway_name and not from_me) else None,
            is_group=is_group,
            group_jid=contact_e164 if is_group else None,
            raw_key=(None if is_group else (raw_contact_key or raw_lid_key)),
        )

        # Check idempotency by wa_message_id
        if wa_message_id:
            existing_msg_stmt = select(Message).where(Message.wa_message_id == wa_message_id)
            existing_msg = (await db.execute(existing_msg_stmt.limit(1))).scalars().first()
            if existing_msg:
                return {"status": "duplicate", "message_id": existing_msg.id}

        msg_time = datetime.fromtimestamp(timestamp, tz=timezone.utc) if (timestamp and float(timestamp) > 86400) else datetime.now(timezone.utc)
        # Convert to naive UTC for db compatibility
        naive_msg_time = msg_time.replace(tzinfo=None)

        direction = MessageDirection.OUTBOUND if from_me else MessageDirection.INBOUND
        status = ConversationMessageStatus.SENT if from_me else ConversationMessageStatus.RECEIVED
        sender = my_phone if from_me else contact_e164  # Will be refined below for group inbound
        recipient = contact_e164 if from_me else my_phone

        sender_name = event_data.get("sender_name")
        participant_raw = event_data.get("participant")

        if from_me:
            sender_name = "Siz"
        elif not sender_name:
            # Name chain: pushName/contacts (gateway, per connected phone) →
            # CRM leads table ("Annem", "Tolga Cebeci"…) → real phone display.
            # Never a fabricated number, never a generic placeholder.
            sender_name = await cls._resolve_sender_via_participant(
                db, user_id, participant_raw, event_data.get("participant_pn")
            )

        # Sender identity for group inbound (DM path keeps contact_e164).
        if not from_me and is_group:
            participant_e164, participant_display, participant_fallback = cls._participant_identity(
                participant_raw, event_data.get("participant_pn")
            )
            if participant_e164:
                sender = participant_e164
            elif participant_display:
                sender = participant_display
            elif participant_fallback:
                sender = participant_fallback
            else:
                sender = contact_e164

        new_msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=direction,
            message_type=MessageType.TEXT,
            body=message_text,
            wa_message_id=wa_message_id,
            sender_phone=sender,
            recipient_phone=recipient,
            sender_name=sender_name,
            status=status,
            created_at=naive_msg_time,
        )
        db.add(new_msg)

        # Update Conversation state
        conv.last_message_at = naive_msg_time
        if not from_me:
            conv.unread_count += 1
            if lead.status == LeadStatus.NEW or lead.status == LeadStatus.CONTACTED:
                lead.status = LeadStatus.REPLIED

        await db.commit()
        await db.refresh(new_msg)
        await db.refresh(conv)

        # Broadcast realtime WebSocket notification
        await ws_manager.broadcast({
            "event": "new_message",
            "conversation_id": conv.id,
            "lead_id": lead.id,
            "lead_name": lead.name,
            "lead_phone": contact_e164,
            "message": {
                "id": new_msg.id,
                "conversation_id": conv.id,
                "direction": new_msg.direction.value,
                "body": new_msg.body,
                "sender_name": new_msg.sender_name,
                "wa_message_id": new_msg.wa_message_id,
                "status": new_msg.status.value,
                "created_at": new_msg.created_at.isoformat(),
            },
            "unread_count": conv.unread_count,
        })

        return {
            "status": "success",
            "message_id": new_msg.id,
            "conversation_id": conv.id,
            "direction": new_msg.direction.value,
        }

    @classmethod
    async def sync_history_batch(
        cls,
        db: AsyncSession,
        session_name: str,
        chats: List[Dict[str, Any]],
        messages: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Bulk ingests WhatsApp chat and message history from Baileys initial sync.
        """
        sess_stmt = select(WhatsAppSession).where(WhatsAppSession.session_name == session_name)
        sess_res = await db.execute(sess_stmt.limit(1))
        session = sess_res.scalars().first()
        if not session:
            return {"status": "ignored", "reason": f"Session {session_name} not found"}

        user_id = session.user_id
        my_phone = session.phone_number or "ME"

        # 1. Provision Leads & Conversations for all chats
        chat_map: Dict[str, Conversation] = {}
        for chat in chats:
            chat_id = chat.get("id") or ""
            phone_raw = chat.get("phone") or (chat_id.split("@")[0] if "@" in chat_id else chat_id)
            is_group = bool(
                chat.get("is_group")
                or chat_id.endswith("@g.us")
                or (phone_raw and phone_raw.endswith("@g.us"))
            )

            contact_key = ""
            e164 = None
            raw_key = None
            if is_group:
                contact_key = chat_id if chat_id.endswith("@g.us") else phone_raw
            else:
                phone_data = PhoneService.normalize_to_e164(phone_raw)
                if phone_data and phone_data.get("is_valid"):
                    e164 = phone_data["e164"]
                    contact_key = e164
                elif chat_id and "@" in chat_id:
                    # Unresolvable identity (e.g. @lid without PN mapping):
                    # key by raw JID so the chat is never lost.
                    raw_key = chat_id
                    contact_key = chat_id
                else:
                    continue

            raw_ts = chat.get("conversation_timestamp")
            conv_time = None
            if raw_ts:
                try:
                    ts_num = float(raw_ts["low"] if isinstance(raw_ts, dict) and "low" in raw_ts else raw_ts)
                    if ts_num > 1e11:
                        ts_num /= 1000
                    if ts_num > 86400:
                        conv_time = datetime.fromtimestamp(ts_num, tz=timezone.utc)
                except Exception:
                    pass

            lead, conv = await cls.get_or_create_lead_and_conversation(
                db=db,
                user_id=user_id,
                phone_e164=e164,
                contact_name=chat.get("name"),
                is_group=is_group,
                group_jid=contact_key if is_group else None,
                avatar_url=chat.get("avatar_url"),
                conversation_timestamp=conv_time,
                raw_key=(None if (is_group or e164) else raw_key),
            )
            chat_map[contact_key] = conv

            # If chat came with last_message_preview, ensure there's at least one message in conversation
            preview_text = (chat.get("last_message_preview") or "").strip()
            if preview_text:
                existing_msg_stmt = select(Message.id).where(Message.conversation_id == conv.id).limit(1)
                has_existing = (await db.execute(existing_msg_stmt)).scalars().first()
                if not has_existing:
                    msg_time = _to_naive_utc(conv_time) or _to_naive_utc(datetime.now(timezone.utc))
                    init_from_me = bool(chat.get("last_message_from_me", False))
                    init_sender_name = chat.get("last_message_sender_name")
                    if init_from_me:
                        init_sender_name = "Siz"
                    elif not init_sender_name and is_group:
                        participant_init = chat.get("last_message_participant")
                        if participant_init:
                            init_raw_num = participant_init.split(":")[0].split("@")[0]
                            if init_raw_num and init_raw_num.isdigit():
                                pn_init = PhoneService.normalize_to_e164(f"+{init_raw_num}")
                                if pn_init:
                                    pl_init = (await db.execute(select(Lead).where(Lead.phone_e164 == pn_init["e164"], Lead.user_id == user_id).limit(1))).scalars().first()
                                    if pl_init and pl_init.name and not pl_init.name.startswith("WhatsApp ("):
                                        init_sender_name = pl_init.name
                                    else:
                                        init_sender_name = pn_init["e164"]
                                else:
                                    init_sender_name = f"+{init_raw_num}"

                    init_msg = Message(
                        user_id=user_id,
                        conversation_id=conv.id,
                        direction=MessageDirection.OUTBOUND if init_from_me else MessageDirection.INBOUND,
                        message_type=MessageType.TEXT,
                        body=preview_text,
                        wa_message_id=f"wa_init_{conv.id}_{int(time.time())}",
                        sender_phone=my_phone if init_from_me else contact_key,
                        recipient_phone=contact_key if init_from_me else my_phone,
                        sender_name=init_sender_name,
                        status=ConversationMessageStatus.SENT if init_from_me else ConversationMessageStatus.RECEIVED,
                        created_at=msg_time,
                    )
                    db.add(init_msg)

        # 2. Ingest Messages
        imported_count = 0
        for m in messages:
            phone_raw = m.get("phone") or ""
            is_group = bool(m.get("is_group") or phone_raw.endswith("@g.us"))
            msg_remote_jid = m.get("remote_jid") or ""
            msg_raw_key: Optional[str] = None
            if is_group:
                contact_key = phone_raw
                e164 = None
            else:
                phone_data = PhoneService.normalize_to_e164(phone_raw)
                if phone_data and phone_data.get("is_valid"):
                    e164 = phone_data["e164"]
                    contact_key = e164
                elif "@" in phone_raw:
                    # Unresolvable identity: key by raw JID, never drop.
                    e164 = None
                    msg_raw_key = phone_raw
                    contact_key = phone_raw
                elif msg_remote_jid.strip().endswith("@lid"):
                    e164 = None
                    msg_raw_key = msg_remote_jid
                    contact_key = msg_remote_jid
                else:
                    continue

            conv = chat_map.get(contact_key)
            if not conv:
                _, conv = await cls.get_or_create_lead_and_conversation(
                    db=db,
                    user_id=user_id,
                    phone_e164=e164,
                    is_group=is_group,
                    group_jid=contact_key if is_group else None,
                    raw_key=(None if (is_group or e164) else msg_raw_key),
                )
                chat_map[contact_key] = conv

            wa_id = m.get("wa_message_id")
            if wa_id:
                # Deduplication: check if message already exists
                ex_stmt = select(Message).where(Message.wa_message_id == wa_id).limit(1)
                existing_m = (await db.execute(ex_stmt)).scalars().first()
                if existing_m:
                    # If existing message has a poor sender_name (null or generic fallback),
                    # upgrade it with the newly resolved name from contacts/leads
                    new_sname_check = m.get("sender_name")
                    if not new_sname_check:
                        new_sname_check = await cls._resolve_sender_via_participant(
                            db, user_id, m.get("participant"), m.get("participant_pn")
                        )
                    if new_sname_check and _is_poor_sender_name(existing_m.sender_name, existing_m.sender_phone):
                        existing_m.sender_name = new_sname_check
                    continue

            from_me = bool(m.get("fromMe", False))
            text = (m.get("message") or "").strip()
            if not text:
                continue

            ts = m.get("timestamp")
            try:
                ts_num = float(ts["low"] if isinstance(ts, dict) and "low" in ts else ts) if ts else None
                if ts_num and ts_num > 1e11:
                    ts_num /= 1000
                msg_time = datetime.fromtimestamp(ts_num, tz=timezone.utc).replace(tzinfo=None) if (ts_num and ts_num > 86400) else datetime.now(timezone.utc).replace(tzinfo=None)
            except Exception:
                msg_time = datetime.now(timezone.utc).replace(tzinfo=None)

            # Eşitle pseudo-messages carry no wa_message_id (last-message
            # previews). Without a content match they would duplicate on every
            # click — match the latest same-body message instead, upgrade its
            # name if poor, and skip the insert.
            if not wa_id:
                dup_stmt = (
                    select(Message)
                    .where(
                        Message.conversation_id == conv.id,
                        Message.body == text,
                        Message.direction == (MessageDirection.OUTBOUND if from_me else MessageDirection.INBOUND),
                    )
                    .order_by(Message.id.desc())
                    .limit(1)
                )
                dup_row = (await db.execute(dup_stmt)).scalars().first()
                if dup_row:
                    heal_name = m.get("sender_name") or await cls._resolve_sender_via_participant(
                        db, user_id, m.get("participant"), m.get("participant_pn")
                    )
                    if heal_name and _is_poor_sender_name(dup_row.sender_name, dup_row.sender_phone):
                        dup_row.sender_name = heal_name
                    continue

            sender_name = m.get("sender_name")
            participant_raw_h = m.get("participant")

            if from_me:
                sender_name = "Siz"
            else:
                if not sender_name:
                    sender_name = await cls._resolve_sender_via_participant(
                        db, user_id, participant_raw_h, m.get("participant_pn")
                    )

            inbound_sender_phone_h = None
            if from_me:
                inbound_sender_phone_h = my_phone
            else:
                resolved_e164_h, resolved_display_h, resolved_raw_h = cls._participant_identity(
                    participant_raw_h, m.get("participant_pn")
                )
                inbound_sender_phone_h = resolved_e164_h or resolved_display_h or resolved_raw_h or contact_key
            new_msg = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.OUTBOUND if from_me else MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body=text,
                wa_message_id=wa_id,
                sender_phone=inbound_sender_phone_h,
                recipient_phone=contact_key if from_me else my_phone,
                sender_name=sender_name,
                status=ConversationMessageStatus.SENT if from_me else ConversationMessageStatus.RECEIVED,
                created_at=msg_time,
            )
            db.add(new_msg)
            conv_last = _to_naive_utc(conv.last_message_at)
            if not conv_last or msg_time > conv_last:
                conv.last_message_at = msg_time
            imported_count += 1

        await db.commit()
        healed_count = await cls._heal_poor_sender_names(db, user_id)
        if healed_count:
            await db.commit()
        logger.info(f"[WhatsAppSyncService] Batch sync completed for {session_name}: {len(chat_map)} chats, {imported_count} messages")

        await ws_manager.broadcast({
            "event": "conversations_updated",
            "count": len(chat_map),
        })

        return {
            "status": "success",
            "chats_synced": len(chat_map),
            "messages_imported": imported_count,
        }
