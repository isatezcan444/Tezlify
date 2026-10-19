"""Test Message Info and read receipt resolution for direct and group chats.

Ensures WhatsApp Web parity:
- Direct messages expose sent_at, delivered_at, read_at timestamps and status.
- Group messages expose Okuyanlar (read_by) and Teslim Edilenler (delivered_to).
- Message serialization includes granular delivery timestamps.
"""
import uuid
import pytest
from datetime import datetime
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.contact import Contact
from backend.app.models.conversation import Conversation
from backend.app.models.message import (
    ConversationMessageStatus,
    Message,
    MessageDirection,
    MessageType,
)
from backend.app.models.message_reaction import MessageReaction
from backend.app.services.whatsapp.orchestration.messaging import serialize_message
from backend.app.services.whatsapp_service import get_message_info


def test_serialize_message_includes_delivery_timestamps():
    msg = Message(
        id=101,
        conversation_id=1,
        direction=MessageDirection.OUTBOUND,
        message_type=MessageType.TEXT,
        status=ConversationMessageStatus.READ,
        body="Merhaba",
        sent_at=datetime(2026, 10, 19, 11, 0, 0),
        delivered_at=datetime(2026, 10, 19, 11, 1, 0),
        read_at=datetime(2026, 10, 19, 11, 2, 0),
        created_at=datetime(2026, 10, 19, 10, 59, 59),
    )
    data = serialize_message(msg)
    assert data["sent_at"] == "2026-10-19T11:00:00"
    assert data["delivered_at"] == "2026-10-19T11:01:00"
    assert data["read_at"] == "2026-10-19T11:02:00"
    assert data["status"] == "READ"


@pytest.mark.asyncio
async def test_get_message_info_group_and_direct():
    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        try:
            # 1. Contact and group conversation
            contact_grp = Contact(
                user_id=user_id,
                phone_e164="120363028374928374@g.us",
                display_name="Proje Grubu",
            )
            db.add(contact_grp)
            await db.flush()

            conv_grp = Conversation(
                user_id=user_id,
                channel="WHATSAPP",
                status="ACTIVE",
                is_group=True,
                contact_id=contact_grp.id,
            )
            db.add(conv_grp)
            await db.flush()

            msg_grp = Message(
                user_id=user_id,
                conversation_id=conv_grp.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                status=ConversationMessageStatus.DELIVERED,
                body="Yarın saat 10'da toplantı var.",
                recipient_phone="120363028374928374@g.us",
                created_at=datetime(2026, 10, 19, 9, 0, 0),
                sent_at=datetime(2026, 10, 19, 9, 0, 5),
                delivered_at=datetime(2026, 10, 19, 9, 0, 10),
            )
            db.add(msg_grp)
            await db.flush()

            # Add reaction from participant (read evidence)
            rx = MessageReaction(
                message_id=msg_grp.id,
                conversation_id=conv_grp.id,
                user_id=user_id,
                emoji="👍",
                reactor_jid="905551112233@s.whatsapp.net",
                from_me=False,
            )
            db.add(rx)
            await db.commit()

            # Query get_message_info for group
            info_grp = await get_message_info(db, user_id, conv_grp.id, msg_grp.id)
            assert info_grp["is_group"] is True
            assert info_grp["conversation_id"] == conv_grp.id
            assert len(info_grp["read_by"]) >= 1
            assert info_grp["read_by"][0]["jid"] == "905551112233@s.whatsapp.net"
            assert info_grp["read_by"][0]["via"] == "reaction"

            # 2. Direct conversation
            contact_direct = Contact(
                user_id=user_id,
                phone_e164="+905321112233",
                display_name="Müşteri Ali",
            )
            db.add(contact_direct)
            await db.flush()

            conv_direct = Conversation(
                user_id=user_id,
                channel="WHATSAPP",
                status="ACTIVE",
                is_group=False,
                contact_id=contact_direct.id,
            )
            db.add(conv_direct)
            await db.flush()

            msg_direct = Message(
                user_id=user_id,
                conversation_id=conv_direct.id,
                direction=MessageDirection.OUTBOUND,
                message_type=MessageType.TEXT,
                status=ConversationMessageStatus.READ,
                body="Faturanız hazırlanmıştır.",
                recipient_phone="+905321112233",
                created_at=datetime(2026, 10, 19, 10, 0, 0),
                sent_at=datetime(2026, 10, 19, 10, 0, 2),
                delivered_at=datetime(2026, 10, 19, 10, 0, 5),
                read_at=datetime(2026, 10, 19, 10, 5, 0),
            )
            db.add(msg_direct)
            await db.commit()

            info_direct = await get_message_info(db, user_id, conv_direct.id, msg_direct.id)
            assert info_direct["is_group"] is False
            assert info_direct["status"] == "READ"
            assert info_direct["read_at"] == "2026-10-19T10:05:00"
            assert info_direct["delivered_at"] == "2026-10-19T10:00:05"
            assert info_direct["sent_at"] == "2026-10-19T10:00:02"

        finally:
            await db.rollback()
