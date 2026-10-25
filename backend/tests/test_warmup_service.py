import pytest
from datetime import datetime, timedelta
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.services.warmup_service import WarmupService, WARMUP_SCHEDULE


@pytest.mark.asyncio
async def test_warmup_schedule_calculation():
    """Warmup progression formula verification across multiple days."""
    schedule = WarmupService.get_schedule()
    assert len(schedule) == 6
    assert schedule[0]["daily_limit"] == 10
    assert schedule[1]["daily_limit"] == 20
    assert schedule[2]["daily_limit"] == 35
    assert schedule[3]["daily_limit"] == 50
    assert schedule[4]["daily_limit"] == 75
    assert schedule[5]["daily_limit"] == 100

    # Custom targets
    assert WarmupService.calculate_limit_for_day(1, target_limit=50) == 10
    assert WarmupService.calculate_limit_for_day(3, target_limit=50) == 35
    assert WarmupService.calculate_limit_for_day(4, target_limit=50) == 50
    assert WarmupService.calculate_limit_for_day(5, target_limit=50) == 50
    assert WarmupService.calculate_limit_for_day(6, target_limit=50) == 50


@pytest.mark.asyncio
async def test_warmup_day_progression_with_dates():
    """Verify days elapsed calculation based on start date."""
    now = utc_now_naive()

    # Day 1: started today
    day, limit, grad = WarmupService.compute_day_and_limit(started_at=now, target_limit=100, now_dt=now)
    assert day == 1
    assert limit == 10
    assert grad is False

    # Day 3: started 2 days ago
    started_2_days_ago = now - timedelta(days=2)
    day, limit, grad = WarmupService.compute_day_and_limit(started_at=started_2_days_ago, target_limit=100, now_dt=now)
    assert day == 3
    assert limit == 35
    assert grad is False

    # Day 6: started 5 days ago (graduates)
    started_5_days_ago = now - timedelta(days=5)
    day, limit, grad = WarmupService.compute_day_and_limit(started_at=started_5_days_ago, target_limit=100, now_dt=now)
    assert day == 6
    assert limit == 100
    assert grad is True


@pytest.mark.asyncio
async def test_warmup_service_sync_and_toggle():
    """Tests session warm-up activation, status query, and synchronization with SQLite."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with async_session() as db:
        # Create a session without warmup
        sess = WhatsAppSession(
            gateway_id="gw_warmup_1",
            session_name="Hat Test",
            status=SessionStatus.CONNECTED,
            phone_number="+905551112233",
            is_active=True,
            is_warmup_enabled=False,
        )
        db.add(sess)
        await db.commit()
        await db.refresh(sess)

        # Toggle warmup ON
        toggled = await WarmupService.toggle_warmup(
            session_id=sess.id,
            enabled=True,
            target_limit=80,
            db=db,
        )
        assert toggled.is_warmup_enabled is True
        assert toggled.warmup_current_day == 1
        assert toggled.warmup_daily_limit == 10
        assert toggled.warmup_target_limit == 80
        assert toggled.warmup_started_at is not None

        # Add Campaign & Lead for messages sent today
        from backend.app.models.campaign import Campaign
        from backend.app.models.lead import Lead

        lead = Lead(
            name="Test Lead",
            phone="05559998877",
            phone_e164="+905559998877",
            city="İstanbul",
            district="Kadıköy",
        )
        db.add(lead)
        await db.commit()
        await db.refresh(lead)

        camp = Campaign(
            name="Warmup Campaign",
            message_template="Merhaba {name}",
            whatsapp_session_id=sess.id,
        )
        db.add(camp)
        await db.commit()
        await db.refresh(camp)

        now = utc_now_naive()
        log1 = MessageLog(
            lead_id=lead.id,
            campaign_id=camp.id,
            target_phone="+905559998877",
            rendered_message="Merhaba Test Lead",
            status=MessageStatus.SENT,
            sent_at=now,
        )
        log2 = MessageLog(
            lead_id=lead.id,
            campaign_id=camp.id,
            target_phone="+905559998878",
            rendered_message="Merhaba Test Lead 2",
            status=MessageStatus.DELIVERED,
            sent_at=now,
        )
        db.add_all([log1, log2])
        await db.commit()

        # Query warmup status
        status = await WarmupService.get_warmup_status(toggled, db)
        assert status["session_id"] == sess.id
        assert status["is_warmup_enabled"] is True
        assert status["current_day"] == 1
        assert status["daily_limit"] == 10
        assert status["sent_today"] == 2
        assert status["remaining_today"] == 8
        assert status["is_graduated"] is False

        # Toggle warmup OFF
        off = await WarmupService.toggle_warmup(
            session_id=sess.id,
            enabled=False,
            target_limit=80,
            db=db,
        )
        assert off.is_warmup_enabled is False

    await engine.dispose()
