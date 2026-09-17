"""
Phase 10.9 Targeted Production Optimizations Regression Test Suite.

Verifies:
1. OutreachManager batch blacklist pre-query and lightweight existence check.
2. WhatsAppService message status advancement and reuse of pre-resolved message rows.
3. Message serialization integrity without redundant db.refresh() roundtrips.
"""

import pytest
import uuid
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.blacklist import Blacklist
from backend.app.models.conversation import Conversation, ConversationStatus
from backend.app.models.contact import Contact
from backend.app.models.message import (
    Message,
    MessageDirection,
    MessageType,
    ConversationMessageStatus,
)
from backend.app.services.outreach_manager import OutreachManager
from backend.app.services.whatsapp_service import (
    _advance_message_status,
    _serialize_message,
)


async def get_test_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


@pytest.mark.asyncio
async def test_batch_blacklist_lookup_and_outreach():
    session_maker, engine = await get_test_db()
    async with session_maker() as db:
        # Seed blacklist
        b1 = Blacklist(phone_e164="+905551112233", reason="opt_out")
        b2 = Blacklist(phone_e164="+905552223344", reason="spam")
        db.add_all([b1, b2])
        await db.commit()

        # 1. Test get_blacklisted_phones batch resolution
        phones = ["+905551112233", "+905552223344", "+905553334455", "+905554445566"]
        blacklisted = await OutreachManager.get_blacklisted_phones(db, phones)
        assert blacklisted == {"+905551112233", "+905552223344"}

        # Empty list check
        empty = await OutreachManager.get_blacklisted_phones(db, [])
        assert empty == set()

        # 2. Test lightweight single check
        assert await OutreachManager.is_blacklisted(db, "+905551112233") is True
        assert await OutreachManager.is_blacklisted(db, "+905553334455") is False

        # 3. Test process_single_outreach with batch blacklist pre-check
        lead_bl = Lead(
            name="Blacklisted Shop",
            phone="05551112233",
            phone_e164="+905551112233",
            is_whatsapp_eligible=True,
            status=LeadStatus.NEW,
        )
        lead_ok = Lead(
            name="Clean Shop",
            phone="05553334455",
            phone_e164="+905553334455",
            is_whatsapp_eligible=True,
            status=LeadStatus.NEW,
        )
        camp = Campaign(
            name="Test Campaign",
            message_template="Merhaba {name}",
            working_hours_start="00:00",
            working_hours_end="23:59",
            status=CampaignStatus.ACTIVE,
        )
        db.add_all([lead_bl, lead_ok, camp])
        await db.commit()

        # Process blacklisted lead using pre-resolved set
        success_bl, msg_bl, _ = await OutreachManager.process_single_outreach(
            db=db,
            lead_id=lead_bl.id,
            campaign_id=camp.id,
            lead=lead_bl,
            campaign=camp,
            blacklisted_phones=blacklisted,
        )
        assert success_bl is False
        assert "Blacklisted" in msg_bl
        assert lead_bl.status == LeadStatus.UNSUBSCRIBED

    await engine.dispose()


@pytest.mark.asyncio
async def test_message_status_monotonic_advancement():
    session_maker, engine = await get_test_db()
    async with session_maker() as db:
        user_id = str(uuid.uuid4())
        conv = Conversation(
            user_id=user_id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.flush()

        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Test message",
            sender_phone="ME",
            recipient_phone="+905551234567",
            status=ConversationMessageStatus.SENT,
            wa_message_id="WA_12345",
        )
        db.add(msg)
        await db.commit()

        # Monotonic check: SENT -> DELIVERED (advances)
        _advance_message_status(msg, "DELIVERED")
        assert msg.status == ConversationMessageStatus.DELIVERED
        assert msg.delivered_at is not None

        # Monotonic check: DELIVERED -> SENT (should NOT regress)
        _advance_message_status(msg, "SENT")
        assert msg.status == ConversationMessageStatus.DELIVERED

        # Monotonic check: DELIVERED -> READ (advances)
        _advance_message_status(msg, "READ")
        assert msg.status == ConversationMessageStatus.READ
        assert msg.read_at is not None

        # Monotonic check: READ -> DELIVERED (should NOT regress)
        _advance_message_status(msg, "DELIVERED")
        assert msg.status == ConversationMessageStatus.READ

    await engine.dispose()


@pytest.mark.asyncio
async def test_message_serialization_without_refresh():
    session_maker, engine = await get_test_db()
    async with session_maker() as db:
        user_id = str(uuid.uuid4())
        conv = Conversation(
            user_id=user_id,
            channel="WHATSAPP",
            status=ConversationStatus.ACTIVE,
        )
        db.add(conv)
        await db.flush()

        row = Message(
            user_id=user_id,
            conversation_id=conv.id,
            direction=MessageDirection.INBOUND,
            message_type=MessageType.TEXT,
            body="Inbound text content",
            sender_phone="+905559876543",
            recipient_phone="ME",
            sender_name="Customer",
            status=ConversationMessageStatus.RECEIVED,
            wa_message_id="WA_IN_999",
            client_message_id=str(uuid.uuid4()),
            external_timestamp=datetime.now(timezone.utc),
        )
        db.add(row)
        # Flush populates row.id
        await db.flush()

        # Serialize directly without calling db.refresh(row)
        serialized = _serialize_message(row)
        assert serialized["id"] == row.id
        assert serialized["conversation_id"] == conv.id
        assert serialized["direction"] == "INBOUND"
        assert serialized["body"] == "Inbound text content"
        assert serialized["sender_phone"] == "+905559876543"
        assert serialized["wa_message_id"] == "WA_IN_999"
        assert serialized["status"] == "RECEIVED"
        assert serialized["created_at"] is not None

    await engine.dispose()
