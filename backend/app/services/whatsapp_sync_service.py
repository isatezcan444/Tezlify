"""
WhatsApp Sync Service.
Coordinates synchronization of WhatsApp chat history and live two-way message mirroring
between Baileys wa-gateway, Leads, Conversations, and Messages.
"""
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
        phone_e164: str,
        contact_name: Optional[str] = None,
    ) -> tuple[Lead, Conversation]:
        """
        Idempotently resolves or provisions a Lead and an active WHATSAPP Conversation.
        Strictly scoped to the tenant's user_id.
        """
        # 1. Resolve or create Lead
        lead_stmt = select(Lead).where(
            Lead.phone_e164 == phone_e164,
            Lead.user_id == user_id,
        )
        lead_res = await db.execute(lead_stmt)
        lead = lead_res.scalar_one_or_none()

        if not lead:
            display_name = contact_name.strip() if contact_name and contact_name.strip() else f"WhatsApp ({phone_e164})"
            lead = Lead(
                user_id=user_id,
                name=display_name,
                phone=phone_e164,
                phone_e164=phone_e164,
                is_whatsapp_eligible=True,
                category="WhatsApp Sohbeti",
                notes=f"WhatsApp üzerinden senkronize edildi ({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')})",
                status=LeadStatus.CONTACTED,
            )
            db.add(lead)
            await db.flush()
        elif contact_name and contact_name.strip() and (not lead.name or lead.name.startswith("WhatsApp (")):
            # Update placeholder name if real contact name arrived from WhatsApp
            lead.name = contact_name.strip()
            await db.flush()

        # 2. Resolve or create Conversation
        conv_stmt = select(Conversation).where(
            Conversation.lead_id == lead.id,
            Conversation.channel == "WHATSAPP",
            Conversation.user_id == user_id,
        )
        conv_res = await db.execute(conv_stmt)
        conv = conv_res.scalar_one_or_none()

        if not conv:
            conv = Conversation(
                user_id=user_id,
                lead_id=lead.id,
                channel="WHATSAPP",
                status=ConversationStatus.ACTIVE,
                unread_count=0,
                last_message_at=_to_naive_utc(datetime.now(timezone.utc)),
            )
            db.add(conv)
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
        Processes a live single-message event (inbound from contact OR outbound from user's phone).
        """
        raw_phone = event_data.get("phone")
        message_text = (event_data.get("message") or "").strip()
        from_me = bool(event_data.get("fromMe", False))
        wa_message_id = event_data.get("wa_message_id")
        timestamp = event_data.get("timestamp")

        if not raw_phone or not message_text:
            return {"status": "ignored", "reason": "Missing phone or message"}

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
            phone_e164=contact_e164,
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
            phone_raw = chat.get("phone") or chat.get("id", "").split("@")[0]
            phone_data = PhoneService.normalize_to_e164(phone_raw)
            if not phone_data:
                continue
            e164 = phone_data["e164"]
            lead, conv = await cls.get_or_create_lead_and_conversation(
                db=db,
                user_id=user_id,
                phone_e164=e164,
                contact_name=chat.get("name"),
            )
            chat_map[e164] = conv

        # 2. Ingest Messages
        imported_count = 0
        for m in messages:
            phone_raw = m.get("phone")
            phone_data = PhoneService.normalize_to_e164(phone_raw)
            if not phone_data:
                continue
            e164 = phone_data["e164"]

            conv = chat_map.get(e164)
            if not conv:
                _, conv = await cls.get_or_create_lead_and_conversation(
                    db=db,
                    user_id=user_id,
                    phone_e164=e164,
                )
                chat_map[e164] = conv

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
            msg_time = datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None) if ts else datetime.now(timezone.utc).replace(tzinfo=None)

            new_msg = Message(
                user_id=user_id,
                conversation_id=conv.id,
                direction=MessageDirection.OUTBOUND if from_me else MessageDirection.INBOUND,
                message_type=MessageType.TEXT,
                body=text,
                wa_message_id=wa_id,
                sender_phone=my_phone if from_me else e164,
                recipient_phone=e164 if from_me else my_phone,
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
