import pytest
from datetime import datetime, timedelta
from unittest.mock import patch, AsyncMock
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.campaign_runner import CampaignRunner


async def get_in_memory_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False), engine


@pytest.mark.asyncio
async def test_campaign_scheduled_status_and_columns():
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        future_time = utc_now_naive() + timedelta(days=2)
        campaign = Campaign(
            name="Scheduled Test Campaign",
            message_template="Hello {name}",
            status=CampaignStatus.SCHEDULED,
            scheduled_at=future_time,
        )
        db.add(campaign)
        await db.commit()
        await db.refresh(campaign)

        assert campaign.id is not None
        assert campaign.status == CampaignStatus.SCHEDULED
        assert campaign.scheduled_at == future_time

    await engine.dispose()


@pytest.mark.asyncio
async def test_check_and_start_scheduled_campaigns():
    session_maker, engine = await get_in_memory_db()
    async with session_maker() as db:
        wa_sess = WhatsAppSession(
            gateway_id="gw_test_123",
            session_name="sched_line",
            phone_number="+905551112233",
            status=SessionStatus.CONNECTED,
        )
        db.add(wa_sess)
        await db.flush()

        past_time = utc_now_naive() - timedelta(minutes=5)
        campaign = Campaign(
            name="Due Scheduled Campaign",
            message_template="Hello {name}",
            status=CampaignStatus.SCHEDULED,
            scheduled_at=past_time,
            whatsapp_session_id=wa_sess.id,
        )
        db.add(campaign)
        await db.commit()

        with patch("backend.app.services.campaign_runner.AsyncSessionLocal", side_effect=session_maker):
            with patch.object(CampaignRunner, "start_campaign", new_callable=AsyncMock) as mock_start:
                mock_start.return_value = True

                started = await CampaignRunner.check_and_start_scheduled_campaigns()
                assert started == 1
                mock_start.assert_called_once_with(
                    campaign_id=campaign.id,
                    lead_ids=None,
                    limit=50,
                    session_id=wa_sess.id,
                )

    await engine.dispose()
