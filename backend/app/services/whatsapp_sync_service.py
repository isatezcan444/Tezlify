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
            lead_res = await db.execute(lead_stmt)
            lead = lead_res.scalar_one_or_none()

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
            lead_res = await db.execute(lead_stmt)
            lead = lead_res.scalar_one_or_none()

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
        conv_res = await db.execute(conv_stmt)
        conv = conv_res.scalar_one_or_none()

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
            if not current_last or naive_conv_time > current_last:
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

        msg_time = datetime.fromtimestamp(timestamp, tz=timezone.utc) if timestamp else datetime.now(timezone.utc)
        # Convert to naive UTC for db compatibility
        naive_msg_time = msg_time.replace(tzinfo=None)

        direction = MessageDirection.OUTBOUND if from_me else MessageDirection.INBOUND
        status = ConversationMessageStatus.SENT if from_me else ConversationMessageStatus.RECEIVED
        sender = my_phone if from_me else contact_e164
        recipient = contact_e164 if from_me else my_phone

        new_msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=direction,
            message_type=MessageType.TEXT,
            body=message_text,
            wa_message_id=wa_message_id,
            sender_phone=sender,
            recipient_phone=recipient,
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
                    init_msg = Message(
                        user_id=user_id,
                        conversation_id=conv.id,
                        direction=MessageDirection.INBOUND,
                        message_type=MessageType.TEXT,
                        body=preview_text,
                        wa_message_id=f"wa_init_{conv.id}_{int(time.time())}",
                        sender_phone=contact_key,
                        recipient_phone=my_phone,
                        status=ConversationMessageStatus.RECEIVED,
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
                # Deduplication
                ex_stmt = select(Message.id).where(Message.wa_message_id == wa_id)
                if (await db.execute(ex_stmt)).scalar_one_or_none():
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
                msg_time = datetime.fromtimestamp(ts_num, tz=timezone.utc).replace(tzinfo=None) if ts_num else datetime.now(timezone.utc).replace(tzinfo=None)
            except Exception:
                msg_time = datetime.now(timezone.utc).replace(tzinfo=None)

            new_msg = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.OUTBOUND if from_me else MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body=text,
                wa_message_id=wa_id,
                sender_phone=my_phone if from_me else contact_key,
                recipient_phone=contact_key if from_me else my_phone,
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
