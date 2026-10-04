import pytest
import uuid
from datetime import datetime
from unittest.mock import AsyncMock, patch
from sqlalchemy import select

from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead, LeadStatus, EntityType, VerificationStatus, ConfidenceLevel
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.models.conversation import Conversation
from backend.app.models.contact import Contact
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.message import Message, ConversationMessageStatus, MessageDirection, MessageType
from backend.app.services.outreach_manager import OutreachManager
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator


def random_phone():
    return f"+90555{uuid.uuid4().int % 10000000:07d}"


@pytest.mark.asyncio
async def test_outreach_manager_updates_last_contacted_and_links_lead():
    async with AsyncSessionLocal() as db:
        user_id = str(uuid.uuid4())
        phone = random_phone()
        lead = Lead(
            user_id=user_id,
            name="Test Business",
            phone=phone,
            phone_e164=phone,
            is_mobile=True,
            is_whatsapp_eligible=True,
            entity_type=EntityType.BUSINESS.value,
            verification_status=VerificationStatus.VERIFIED.value,
            is_verified=True,
            confidence_level=ConfidenceLevel.HIGH.value,
            confidence_score=95,
            status=LeadStatus.NEW,
        )
        db.add(lead)
        await db.flush()

        campaign = Campaign(
            user_id=user_id,
            name="Test Camp",
            message_template="Hello {name}",
            status=CampaignStatus.ACTIVE,
            working_hours_enabled=False,
        )
        db.add(campaign)
        await db.flush()

        contact = Contact(
            user_id=user_id,
            phone_e164=phone,
            display_name="Test Business",
        )
        db.add(contact)
        await db.flush()

        conv = Conversation(
            user_id=user_id,
            contact_id=contact.id,
            channel="WHATSAPP",
        )
        db.add(conv)
        await db.commit()

        mock_start_conv = AsyncMock(return_value={"id": conv.id, "success": True})
        with patch("backend.app.services.whatsapp_service.start_conversation", mock_start_conv):
            success, msg, log_id = await OutreachManager.process_single_outreach(
                db=db,
                lead_id=lead.id,
                campaign_id=campaign.id,
                lead=lead,
                campaign=campaign,
            )

        assert success is True
        assert log_id is not None
        assert lead.status == LeadStatus.CONTACTED
        assert lead.last_contacted_at is not None
        assert campaign.sent_count == 1

        # Check conversation and contact were linked to lead
        await db.refresh(conv)
        await db.refresh(contact)
        assert conv.lead_id == lead.id
        assert contact.lead_id == lead.id


@pytest.mark.asyncio
async def test_message_status_updated_syncs_delivered_and_read():
    orchestrator = WhatsAppEventOrchestrator()
    async with AsyncSessionLocal() as db:
        user_id = str(uuid.uuid4())
        gw_sess_id = f"gw_{uuid.uuid4().hex[:12]}"
        user_phone = random_phone()
        ws_sess = WhatsAppSession(
            user_id=user_id,
            session_name="Test Session",
            phone_number=user_phone,
            gateway_id=gw_sess_id,
            status=SessionStatus.CONNECTED,
        )
        db.add(ws_sess)
        await db.flush()

        target_phone = random_phone()
        lead = Lead(
            user_id=user_id,
            name="Delivery Lead",
            phone=target_phone,
            phone_e164=target_phone,
            is_mobile=True,
            is_whatsapp_eligible=True,
            entity_type=EntityType.BUSINESS.value,
            verification_status=VerificationStatus.VERIFIED.value,
            is_verified=True,
            status=LeadStatus.CONTACTED,
        )
        db.add(lead)
        await db.flush()

        camp = Campaign(
            user_id=user_id,
            name="Stats Camp",
            message_template="Hi {name}",
            sent_count=1,
            delivered_count=0,
            status=CampaignStatus.ACTIVE,
            working_hours_enabled=False,
        )
        db.add(camp)
        await db.flush()

        msg_log = MessageLog(
            user_id=user_id,
            lead_id=lead.id,
            campaign_id=camp.id,
            target_phone=lead.phone_e164,
            rendered_message="Hi Delivery Lead",
            status=MessageStatus.SENT,
        )
        db.add(msg_log)
        await db.flush()

        contact = Contact(user_id=user_id, phone_e164=lead.phone_e164, lead_id=lead.id)
        db.add(contact)
        await db.flush()

        conv = Conversation(user_id=user_id, contact_id=contact.id, lead_id=lead.id, channel="WHATSAPP")
        db.add(conv)
        await db.flush()

        wa_msg_id = f"WAMSG_{uuid.uuid4().hex[:16]}"
        msg = Message(
            user_id=user_id,
            conversation_id=conv.id,
            wa_message_id=wa_msg_id,
            direction=MessageDirection.OUTBOUND,
            message_type=MessageType.TEXT,
            body="Hi Delivery Lead",
            status=ConversationMessageStatus.SENT,
            recipient_phone=lead.phone_e164,
        )
        db.add(msg)
        await db.commit()

        # 1. DELIVERED event
        event_delivered = {
            "event": "message_status_updated",
            "gateway_session_id": gw_sess_id,
            "conversation_id": f"{lead.phone_e164.replace('+', '')}@s.whatsapp.net",
            "wa_message_id": wa_msg_id,
            "status": "DELIVERED",
        }
        res_del = await orchestrator._map_conversation_event(db, event_delivered)
        assert res_del["status"] == "DELIVERED"

        await db.refresh(msg_log)
        await db.refresh(camp)
        assert msg_log.status == MessageStatus.DELIVERED
        assert camp.delivered_count == 1

        # 2. READ event
        event_read = {
            "event": "message_status_updated",
            "gateway_session_id": gw_sess_id,
            "conversation_id": f"{lead.phone_e164.replace('+', '')}@s.whatsapp.net",
            "wa_message_id": wa_msg_id,
            "status": "READ",
        }
        res_read = await orchestrator._map_conversation_event(db, event_read)
        assert res_read["status"] == "READ"

        await db.refresh(msg_log)
        await db.refresh(camp)
        assert msg_log.status == MessageStatus.READ
        assert camp.delivered_count == 1  # Should not double increment

        # Cleanup session so it does not affect other tests
        await db.delete(ws_sess)
        await db.commit()


@pytest.mark.asyncio
async def test_inbound_message_advances_lead_and_campaign_reply_count():
    orchestrator = WhatsAppEventOrchestrator()
    async with AsyncSessionLocal() as db:
        user_id = str(uuid.uuid4())
        gw_sess_id = f"gw_{uuid.uuid4().hex[:12]}"
        user_phone = random_phone()
        ws_sess = WhatsAppSession(
            user_id=user_id,
            session_name="Test Session 3",
            phone_number=user_phone,
            gateway_id=gw_sess_id,
            status=SessionStatus.CONNECTED,
        )
        db.add(ws_sess)
        await db.flush()

        target_phone = random_phone()
        lead = Lead(
            user_id=user_id,
            name="Replying Lead",
            phone=target_phone,
            phone_e164=target_phone,
            is_mobile=True,
            is_whatsapp_eligible=True,
            entity_type=EntityType.BUSINESS.value,
            verification_status=VerificationStatus.VERIFIED.value,
            is_verified=True,
            status=LeadStatus.CONTACTED,
        )
        db.add(lead)
        await db.flush()

        camp = Campaign(
            user_id=user_id,
            name="Reply Camp",
            message_template="Hi {name}",
            sent_count=1,
            replied_count=0,
            status=CampaignStatus.ACTIVE,
            working_hours_enabled=False,
        )
        db.add(camp)
        await db.flush()

        msg_log = MessageLog(
            user_id=user_id,
            lead_id=lead.id,
            campaign_id=camp.id,
            target_phone=lead.phone_e164,
            rendered_message="Hi Replying Lead",
            status=MessageStatus.DELIVERED,
        )
        db.add(msg_log)
        await db.flush()

        contact = Contact(user_id=user_id, phone_e164=lead.phone_e164, lead_id=lead.id)
        db.add(contact)
        await db.flush()

        conv = Conversation(user_id=user_id, contact_id=contact.id, lead_id=lead.id, channel="WHATSAPP")
        db.add(conv)
        await db.commit()

        # Inbound event
        event_inbound = {
            "event": "message_new",
            "gateway_session_id": gw_sess_id,
            "conversation_id": f"{lead.phone_e164.replace('+', '')}@s.whatsapp.net",
            "message": {
                "wa_message_id": f"INBOUND_{uuid.uuid4().hex[:12]}",
                "direction": "INBOUND",
                "message_type": "TEXT",
                "body": "Evet ilgileniyorum, teklif alabilir miyim?",
                "recipient_phone": "ME",
                "created_at": datetime.utcnow().isoformat(),
            }
        }
        res_inbound = await orchestrator._ingest_message(db, event_inbound)
        assert res_inbound is not None

        await db.refresh(lead)
        await db.refresh(msg_log)
        await db.refresh(camp)

        assert lead.status == LeadStatus.REPLIED
        assert msg_log.status == MessageStatus.REPLIED
        assert camp.replied_count == 1

        # Cleanup session so it does not affect other tests
        await db.delete(ws_sess)
        await db.commit()
