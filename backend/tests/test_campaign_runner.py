import pytest
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.services.campaign_runner import CampaignRunner


async def get_in_memory_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


@pytest.mark.asyncio
async def test_campaign_runner_idempotency_and_state():
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        camp = Campaign(
            name="Test Outreach",
            message_template="Merhaba {name}",
            min_delay_seconds=10,
            max_delay_seconds=20,
            status=CampaignStatus.DRAFT
        )
        db.add(camp)
        await db.commit()
        await db.refresh(camp)

        # Non-running status check
        assert CampaignRunner.is_campaign_running(camp.id) is False

    await engine.dispose()


@pytest.mark.asyncio
async def test_campaign_runner_fails_fast_without_whatsapp_session():
    """When a tenant has no CONNECTED WhatsAppSession, worker pauses campaign immediately without burning leads."""
    import uuid
    from unittest.mock import AsyncMock, patch
    from backend.app.core.database import AsyncSessionLocal
    from backend.app.models.lead import Lead, LeadStatus, EntityType, VerificationStatus, ConfidenceLevel

    user_id = str(uuid.uuid4())
    rand_phone = f"+90555{uuid.uuid4().int % 10000000:07d}"
    async with AsyncSessionLocal() as db:
        lead = Lead(
            user_id=user_id,
            name="Test Firm",
            phone=rand_phone,
            phone_e164=rand_phone,
            is_whatsapp_eligible=True,
            entity_type=EntityType.BUSINESS.value,
            verification_status=VerificationStatus.VERIFIED.value,
            is_verified=True,
            confidence_level=ConfidenceLevel.HIGH.value,
            confidence_score=90,
            status=LeadStatus.NEW,
        )
        db.add(lead)
        camp = Campaign(
            user_id=user_id,
            name="No Session Camp",
            message_template="Merhaba {name}",
            status=CampaignStatus.ACTIVE,
        )
        db.add(camp)
        await db.commit()
        await db.refresh(camp)
        camp_id = camp.id

    mock_broadcast = AsyncMock()
    with patch("backend.app.services.campaign_runner.ws_manager.broadcast", mock_broadcast):
        # Run worker directly
        await CampaignRunner._execute_campaign_worker(camp_id)

    async with AsyncSessionLocal() as db:
        updated_camp = await db.get(Campaign, camp_id)
        assert updated_camp.status == CampaignStatus.PAUSED
        assert updated_camp.sent_count == 0
        assert updated_camp.failed_count == 0

    # Verify broadcast alerted the user
    broadcast_events = [call.args[0]["event"] for call in mock_broadcast.call_args_list if call.args]
    assert "campaign_failed" in broadcast_events


@pytest.mark.asyncio
async def test_campaign_runner_pauses_on_daily_limit_reached():
    """When today's sent count reaches daily_message_limit, worker pauses campaign before sending."""
    import uuid
    from unittest.mock import AsyncMock, patch
    from backend.app.core.database import AsyncSessionLocal
    from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
    from backend.app.models.message_log import MessageLog, MessageStatus
    from backend.app.core.datetime_utils import utc_now_naive

    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        ws_sess = WhatsAppSession(
            user_id=user_id,
            gateway_id=f"gw_{uuid.uuid4().hex[:10]}",
            session_name="Daily Limit Line",
            status=SessionStatus.CONNECTED,
            phone_number="+905329998877",
        )
        db.add(ws_sess)
        camp = Campaign(
            user_id=user_id,
            name="Daily Limit Camp",
            message_template="Merhaba {name}",
            status=CampaignStatus.ACTIVE,
            daily_message_limit=2,
        )
        db.add(camp)
        await db.flush()

        # Insert 2 already sent messages today
        for _ in range(2):
            msg_log = MessageLog(
                user_id=user_id,
                lead_id=1,
                target_phone="+905321112233",
                rendered_message="Test",
                status=MessageStatus.SENT,
                sent_at=utc_now_naive(),
            )
            db.add(msg_log)
        await db.commit()
        camp_id = camp.id

    try:
        mock_broadcast = AsyncMock()
        with patch("backend.app.services.campaign_runner.ws_manager.broadcast", mock_broadcast):
            await CampaignRunner._execute_campaign_worker(camp_id)

        async with AsyncSessionLocal() as db:
            updated_camp = await db.get(Campaign, camp_id)
            assert updated_camp.status == CampaignStatus.PAUSED

        # Verify campaign_paused broadcast with daily_limit_reached reason
        paused_events = [
            call.args[0]
            for call in mock_broadcast.call_args_list
            if call.args and call.args[0].get("event") == "campaign_paused"
        ]
        assert len(paused_events) >= 1
        assert paused_events[0]["reason"] == "daily_limit_reached"
    finally:
        async with AsyncSessionLocal() as db:
            from sqlalchemy import delete
            await db.execute(delete(WhatsAppSession).where(WhatsAppSession.id == ws_sess.id))
            await db.commit()


@pytest.mark.asyncio
async def test_campaign_runner_pauses_on_mid_campaign_session_disconnect():
    """If WhatsApp session drops mid-campaign, runner pauses safely without failing subsequent leads."""
    import uuid
    from unittest.mock import AsyncMock, patch
    from backend.app.core.database import AsyncSessionLocal
    from backend.app.models.lead import Lead, LeadStatus, EntityType, VerificationStatus, ConfidenceLevel
    from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus

    user_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        ws_sess = WhatsAppSession(
            user_id=user_id,
            gateway_id=f"gw_{uuid.uuid4().hex[:10]}",
            session_name="Disconnect Line",
            status=SessionStatus.CONNECTED,
            phone_number="+905329998800",
        )
        db.add(ws_sess)
        
        # Add 3 leads
        for i in range(3):
            p = f"+90555{uuid.uuid4().int % 10000000:07d}"
            lead = Lead(
                user_id=user_id,
                name=f"Lead {i}",
                phone=p,
                phone_e164=p,
                is_whatsapp_eligible=True,
                entity_type=EntityType.BUSINESS.value,
                verification_status=VerificationStatus.VERIFIED.value,
                is_verified=True,
                confidence_level=ConfidenceLevel.HIGH.value,
                confidence_score=90,
                status=LeadStatus.NEW,
            )
            db.add(lead)

        camp = Campaign(
            user_id=user_id,
            name="Disconnect Camp",
            message_template="Merhaba {name}",
            status=CampaignStatus.ACTIVE,
            min_delay_seconds=0,
            max_delay_seconds=0,
            working_hours_enabled=False,
        )
        db.add(camp)
        await db.commit()
        camp_id = camp.id

    try:
        mock_broadcast = AsyncMock()
        # Mock OutreachManager to simulate: 1st lead succeeds, 2nd lead fails with connection lost
        call_count = 0
        async def mock_outreach(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return True, "Mesaj iletildi", 101
            else:
                return False, "WhatsApp gönderim hatası: Bağlı bir WhatsApp oturumu bulunamadı.", None

        with patch("backend.app.services.campaign_runner.ws_manager.broadcast", mock_broadcast), \
             patch("backend.app.services.outreach_manager.OutreachManager.process_single_outreach", side_effect=mock_outreach):
            await CampaignRunner._execute_campaign_worker(camp_id)

        # Lead 3 must NEVER have been attempted!
        assert call_count == 2

        async with AsyncSessionLocal() as db:
            updated_camp = await db.get(Campaign, camp_id)
            assert updated_camp.status == CampaignStatus.PAUSED

        paused_events = [
            call.args[0]
            for call in mock_broadcast.call_args_list
            if call.args and call.args[0].get("event") == "campaign_paused"
        ]
        assert len(paused_events) >= 1
        assert paused_events[0]["reason"] == "session_disconnected"
    finally:
        async with AsyncSessionLocal() as db:
            from sqlalchemy import delete
            await db.execute(delete(WhatsAppSession).where(WhatsAppSession.id == ws_sess.id))
            await db.commit()


