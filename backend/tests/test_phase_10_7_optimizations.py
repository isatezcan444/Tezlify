import uuid
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.models.profile import Profile
from backend.app.models.message import Message
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.models.campaign_group import CampaignGroup
from backend.app.models.campaign import Campaign
from backend.app.models.discovery_run import DiscoveryRun
from backend.app.models.conversation import Conversation
from backend.app.models.blacklist import Blacklist, ScraperJob
from backend.app.models.contact import Contact
from backend.app.models.raw_candidate import RawCandidate
from backend.app.services.whatsapp_service import _ensure_conversation_race_safe, _ingest_message


@pytest.mark.asyncio
async def test_model_definitions_no_duplicate_pk_index():
    """Verifies that the 12 models have primary_key=True without redundant index=True on id."""
    models = [
        Message, WhatsAppSession, MessageLog, CampaignGroup, Lead, Campaign,
        DiscoveryRun, Conversation, Blacklist, ScraperJob, Contact, RawCandidate, Profile
    ]
    for m in models:
        col = m.__table__.c.id
        assert col.primary_key is True, f"{m.__name__}.id must be primary key"
        assert col.index is not True, f"{m.__name__}.id must NOT have index=True (it duplicates the PK index)"


@pytest.mark.asyncio
async def test_analytics_dashboard_consolidated_queries():
    """Verifies that the consolidated analytics query returns accurate metrics."""
    user_id = str(uuid.uuid4())
    suffix = str(uuid.uuid4().int)[:7]
    p1, p2, p3 = f"0555{suffix[:6]}1", f"0555{suffix[:6]}2", f"0555{suffix[:6]}3"
    e1, e3 = f"+90{p1[1:]}", f"+90{p3[1:]}"

    async with AsyncSessionLocal() as db:
        lead1 = Lead(
            user_id=user_id,
            name="Eligible Lead",
            phone=p1,
            phone_e164=e1,
            is_whatsapp_eligible=True,
            status=LeadStatus.NEW,
        )
        lead2 = Lead(
            user_id=user_id,
            name="Ineligible Lead",
            phone=p2,
            is_whatsapp_eligible=False,
            status=LeadStatus.NEW,
        )
        lead3 = Lead(
            user_id=user_id,
            name="Contacted Lead",
            phone=p3,
            phone_e164=e3,
            is_whatsapp_eligible=True,
            status=LeadStatus.CONTACTED,
        )
        db.add_all([lead1, lead2, lead3])
        await db.flush()

        msg1 = MessageLog(
            user_id=user_id,
            lead_id=lead1.id,
            status=MessageStatus.SENT,
            target_phone=e1,
            rendered_message="Test message",
        )
        msg2 = MessageLog(
            user_id=user_id,
            lead_id=lead2.id,
            status=MessageStatus.FAILED,
            target_phone=p2,
            rendered_message="Failed message",
        )
        db.add_all([msg1, msg2])
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/api/v1/analytics/dashboard",
            headers={"x-test-user-id": user_id, "x-test-user-email": "user@test.com"}
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["total_leads"] >= 3
        assert data["whatsapp_eligible_leads"] >= 2
        assert "NEW" in data["leads_by_status"]
        assert "CONTACTED" in data["leads_by_status"]
        assert data["total_messages_sent"] >= 1
        assert "daily_volume" in data
        assert "top_categories" in data


@pytest.mark.asyncio
async def test_contact_single_lookup_in_ensure_conversation():
    """Verifies that _ensure_conversation_race_safe attaches _contact and single lookup works."""
    async with AsyncSessionLocal() as db:
        owner = str(uuid.uuid4())
        jid = "905551112233@s.whatsapp.net"
        event = {"gateway_session_id": "gw-sess-1"}

        conv = await _ensure_conversation_race_safe(
            db, owner, jid, event,
            contact_name="Test Contact Name",
            contact_source="PUSH_NAME"
        )
        assert conv is not None
        assert hasattr(conv, "_contact")
        assert conv._contact is not None
        assert conv._contact.display_name == "Test Contact Name"
        await db.rollback()
