import pytest
from unittest.mock import patch, AsyncMock
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.models.campaign import Campaign
from backend.app.models.lead import Lead, LeadStatus, EntityType, VerificationStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.campaign_runner import CampaignRunner

TEST_USER_ID = "00000000-0000-4000-8000-000000000001"


async def get_in_memory_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


def make_lead(lead_id: str, phone: str):
    return Lead(
        user_id=TEST_USER_ID,
        name=f"Lead {lead_id}",
        phone=phone,
        phone_e164=phone,
        is_whatsapp_eligible=True,
        entity_type=EntityType.BUSINESS.value,
        is_verified=True,
        verification_status=VerificationStatus.VERIFIED.value,
        status=LeadStatus.NEW,
    )


@pytest.mark.asyncio
async def test_multi_session_pool_round_robin_distribution():
    """Verify that outbound messages rotate round-robin across connected lines in the Hat Havuzu pool."""
    session_maker, engine = await get_in_memory_db()

    async with session_maker() as db:
        sess1 = WhatsAppSession(
            user_id=TEST_USER_ID,
            gateway_id="gw_line_1",
            session_name="Hat 1",
            phone_number="+905551110001",
            status=SessionStatus.CONNECTED,
        )
        sess2 = WhatsAppSession(
            user_id=TEST_USER_ID,
            gateway_id="gw_line_2",
            session_name="Hat 2",
            phone_number="+905551110002",
            status=SessionStatus.CONNECTED,
        )
        db.add_all([sess1, sess2])
        await db.flush()

        lead1 = make_lead("1", "+905320000001")
        lead2 = make_lead("2", "+905320000002")
        lead3 = make_lead("3", "+905320000003")
        lead4 = make_lead("4", "+905320000004")
        db.add_all([lead1, lead2, lead3, lead4])
        await db.flush()

        campaign = Campaign(
            user_id=TEST_USER_ID,
            name="Pool Campaign",
            message_template="Hello {name}",
            whatsapp_session_ids=[sess1.id, sess2.id],
            min_delay_seconds=0,
            max_delay_seconds=0,
        )
        db.add(campaign)
        await db.commit()
        await db.refresh(campaign)

        dispatched_sessions = []

        async def mock_process_outreach(*args, **kwargs):
            session_id = kwargs.get("session_id")
            dispatched_sessions.append(session_id)
            return True, "SENT", 123

        with patch("backend.app.services.campaign_runner.AsyncSessionLocal", session_maker), \
             patch("backend.app.services.outreach_manager.OutreachManager.process_single_outreach", side_effect=mock_process_outreach), \
             patch("backend.app.services.campaign_runner.ws_manager.broadcast", new_callable=AsyncMock), \
             patch("backend.app.services.campaign_runner.WebhookDispatcher.emit"), \
             patch("asyncio.sleep", new_callable=AsyncMock):

            await CampaignRunner._execute_campaign_worker(
                campaign_id=campaign.id,
                lead_ids=[lead1.id, lead2.id, lead3.id, lead4.id],
                session_ids=[sess1.id, sess2.id],
            )

        # Dispatches must alternate between Hat 1 and Hat 2
        assert len(dispatched_sessions) == 4
        assert dispatched_sessions[0] == sess1.id
        assert dispatched_sessions[1] == sess2.id
        assert dispatched_sessions[2] == sess1.id
        assert dispatched_sessions[3] == sess2.id

    await engine.dispose()


@pytest.mark.asyncio
async def test_multi_session_pool_failover_when_one_line_hits_limit():
    """Verify that when one line in the pool reaches its daily limit, remaining leads route to the active line."""
    session_maker, engine = await get_in_memory_db()

    async with session_maker() as db:
        sess1 = WhatsAppSession(
            user_id=TEST_USER_ID,
            gateway_id="gw_line_1_exhausted",
            session_name="Hat 1",
            phone_number="+905551110001",
            status=SessionStatus.CONNECTED,
        )
        sess2 = WhatsAppSession(
            user_id=TEST_USER_ID,
            gateway_id="gw_line_2_fresh",
            session_name="Hat 2",
            phone_number="+905551110002",
            status=SessionStatus.CONNECTED,
        )
        db.add_all([sess1, sess2])
        await db.flush()

        lead1 = make_lead("1", "+905320000001")
        lead2 = make_lead("2", "+905320000002")
        db.add_all([lead1, lead2])
        await db.flush()

        campaign = Campaign(
            user_id=TEST_USER_ID,
            name="Pool Failover Campaign",
            message_template="Hello {name}",
            whatsapp_session_ids=[sess1.id, sess2.id],
            daily_message_limit=10,
            min_delay_seconds=0,
            max_delay_seconds=0,
        )
        db.add(campaign)
        await db.commit()
        await db.refresh(campaign)

        dispatched_sessions = []

        async def mock_process_outreach(*args, **kwargs):
            session_id = kwargs.get("session_id")
            dispatched_sessions.append(session_id)
            return True, "SENT", 456

        # Mock count_sent_today so sess1 has already reached limit 10, while sess2 has only sent 2
        async def mock_count_sent(session, db_sess):
            if session.id == sess1.id:
                return 10  # exhausted
            return 2       # 8 remaining

        with patch("backend.app.services.campaign_runner.AsyncSessionLocal", session_maker), \
             patch("backend.app.services.warmup_service.WarmupService.count_sent_today", side_effect=mock_count_sent), \
             patch("backend.app.services.outreach_manager.OutreachManager.process_single_outreach", side_effect=mock_process_outreach), \
             patch("backend.app.services.campaign_runner.ws_manager.broadcast", new_callable=AsyncMock), \
             patch("backend.app.services.campaign_runner.WebhookDispatcher.emit"), \
             patch("asyncio.sleep", new_callable=AsyncMock):

            await CampaignRunner._execute_campaign_worker(
                campaign_id=campaign.id,
                lead_ids=[lead1.id, lead2.id],
                session_ids=[sess1.id, sess2.id],
            )

        # Both leads should have routed exclusively to sess2 because sess1 was exhausted
        assert len(dispatched_sessions) == 2
        assert dispatched_sessions[0] == sess2.id
        assert dispatched_sessions[1] == sess2.id

    await engine.dispose()
