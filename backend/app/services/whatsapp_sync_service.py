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
from sqlalchemy import select

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
    ) -> tuple[Lead, Conversation]:
        """
        Idempotently resolves or provisions a Lead and an active WHATSAPP Conversation.
        Supports both individual contacts and WhatsApp groups (@g.us).
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
            if not phone_e164:
                raise ValueError("phone_e164 is required for individual direct chats.")

            lead_stmt = select(Lead).where(
                Lead.phone_e164 == phone_e164,
                Lead.user_id == user_id,
            )
            lead_res = await db.execute(lead_stmt.limit(1))
            lead = lead_res.scalars().first()

            if not lead:
                display_name = contact_name.strip() if contact_name and contact_name.strip() else f"WhatsApp ({phone_e164})"
                custom_data = {}
                if avatar_url:
                    custom_data["avatar_url"] = avatar_url

                lead = Lead(
                    user_id=user_id,
                    name=display_name,
                    phone=phone_e164,
                    phone_e164=phone_e164,
                    is_whatsapp_eligible=True,
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
        else:
            phone_data = PhoneService.normalize_to_e164(raw_phone)
            if not phone_data:
                return {"status": "ignored", "reason": "Invalid phone format"}
            contact_e164 = phone_data["e164"]

        # Resolve WhatsApp session to find user_id & sender phone
        sess_stmt = select(WhatsAppSession).where(WhatsAppSession.session_name == session_name)
        sess_res = await db.execute(sess_stmt)
        session = sess_res.scalar_one_or_none()
        if not session:
            return {"status": "ignored", "reason": f"Session {session_name} not found"}

        user_id = session.user_id
        my_phone = session.phone_number or "ME"

        lead, conv = await cls.get_or_create_lead_and_conversation(
            db=db,
            user_id=user_id,
            phone_e164=None if is_group else contact_e164,
            is_group=is_group,
            group_jid=contact_e164 if is_group else None,
        )

        # Check idempotency by wa_message_id
        if wa_message_id:
            existing_msg_stmt = select(Message).where(Message.wa_message_id == wa_message_id)
            existing_msg = (await db.execute(existing_msg_stmt)).scalar_one_or_none()
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
        participant_e164: Optional[str] = None

        if from_me:
            sender_name = "Siz"
        else:
            if is_group and participant_raw:
                # Normalize participant JID to strip multi-device index (:1, :0 etc.)
                # e.g. "905342236672:1@s.whatsapp.net" -> "+905342236672"
                raw_number = participant_raw.split(":")[0].split("@")[0]
                if raw_number and raw_number.isdigit():
                    phone_norm = PhoneService.normalize_to_e164(f"+{raw_number}")
                    if phone_norm:
                        participant_e164 = phone_norm["e164"]

            # If wa-gateway provided a pushName, use it directly
            if not sender_name and participant_e164:
                # Try to resolve the sender's real name from the leads table
                lead_stmt = select(Lead).where(Lead.phone_e164 == participant_e164, Lead.user_id == user_id)
                participant_lead = (await db.execute(lead_stmt.limit(1))).scalars().first()
                if participant_lead and participant_lead.name and not participant_lead.name.startswith("WhatsApp ("):
                    sender_name = participant_lead.name
                else:
                    # Fallback to phone number
                    sender_name = participant_e164

            elif not sender_name and participant_raw:
                # Last resort: extract phone from raw JID
                raw_number = participant_raw.split(":")[0].split("@")[0]
                if raw_number and raw_number.isdigit():
                    sender_name = f"+{raw_number}"

        # For inbound group messages, update sender_phone to the individual participant's phone
        if not from_me and is_group and participant_e164:
            sender = participant_e164

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
        sess_res = await db.execute(sess_stmt)
        session = sess_res.scalar_one_or_none()
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
            if is_group:
                contact_key = chat_id if chat_id.endswith("@g.us") else phone_raw
            else:
                phone_data = PhoneService.normalize_to_e164(phone_raw)
                if not phone_data:
                    continue
                e164 = phone_data["e164"]
                contact_key = e164

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
            )
            chat_map[contact_key] = conv

            # If chat came with last_message_preview, ensure there's at least one message in conversation
            preview_text = (chat.get("last_message_preview") or "").strip()
            if preview_text:
                existing_msg_stmt = select(Message.id).where(Message.conversation_id == conv.id).limit(1)
                has_existing = (await db.execute(existing_msg_stmt)).scalar_one_or_none()
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
            if is_group:
                contact_key = phone_raw
                e164 = None
            else:
                phone_data = PhoneService.normalize_to_e164(phone_raw)
                if not phone_data:
                    continue
                e164 = phone_data["e164"]
                contact_key = e164

            conv = chat_map.get(contact_key)
            if not conv:
                _, conv = await cls.get_or_create_lead_and_conversation(
                    db=db,
                    user_id=user_id,
                    phone_e164=e164,
                    is_group=is_group,
                    group_jid=contact_key if is_group else None,
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
                    if not new_sname_check and m.get("participant"):
                        rn = m.get("participant", "").split(":")[0].split("@")[0]
                        if rn and rn.isdigit():
                            pn = PhoneService.normalize_to_e164(f"+{rn}")
                            if pn:
                                pl = (await db.execute(select(Lead).where(Lead.phone_e164 == pn["e164"], Lead.user_id == user_id).limit(1))).scalars().first()
                                if pl and pl.name and not pl.name.startswith("WhatsApp ("):
                                    new_sname_check = pl.name
                                else:
                                    new_sname_check = pn["e164"]
                    if new_sname_check and (not existing_m.sender_name or existing_m.sender_name in ("Grup Üyesi", "")):
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

            sender_name = m.get("sender_name")
            participant_raw_h = m.get("participant")
            participant_e164_h: Optional[str] = None

            if from_me:
                sender_name = "Siz"
            else:
                if is_group and participant_raw_h:
                    raw_num = participant_raw_h.split(":")[0].split("@")[0]
                    if raw_num and raw_num.isdigit():
                        phone_norm_h = PhoneService.normalize_to_e164(f"+{raw_num}")
                        if phone_norm_h:
                            participant_e164_h = phone_norm_h["e164"]

                if not sender_name and participant_e164_h:
                    lead_stmt_h = select(Lead).where(Lead.phone_e164 == participant_e164_h, Lead.user_id == user_id)
                    participant_lead_h = (await db.execute(lead_stmt_h.limit(1))).scalars().first()
                    if participant_lead_h and participant_lead_h.name and not participant_lead_h.name.startswith("WhatsApp ("):
                        sender_name = participant_lead_h.name
                    else:
                        sender_name = participant_e164_h
                elif not sender_name and participant_raw_h:
                    raw_num = participant_raw_h.split(":")[0].split("@")[0]
                    if raw_num and raw_num.isdigit():
                        sender_name = f"+{raw_num}"

            inbound_sender_phone_h = (participant_e164_h if (not from_me and is_group and participant_e164_h) else None) or (my_phone if from_me else contact_key)
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
