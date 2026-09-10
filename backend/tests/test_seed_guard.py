"""Seed guard: demo data seeds ONLY on a truly fresh database.

User data in ANY core table (leads, campaigns) proves prior use and blocks
seeding on every restart.
"""
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.core.seed import should_seed_demo_data
from backend.app.models.campaign import Campaign
from backend.app.models.lead import Lead


async def _fresh_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return maker, engine


@pytest.mark.asyncio
async def test_seed_allowed_on_empty_database():
    maker, engine = await _fresh_db()
    try:
        async with maker() as db:
            assert await should_seed_demo_data(db) is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_seed_blocked_when_any_user_data_exists():
    maker, engine = await _fresh_db()
    try:
        # Case 1: a lead remains (user data exists)
        async with maker() as db:
            db.add(Lead(name="Kalan Lead", phone="+905320000001", phone_e164="+905320000001"))
            await db.commit()
            assert await should_seed_demo_data(db) is False

        # Case 2: leads wiped but a campaign remains
        async with maker() as db:
            for lead in (await db.execute(select(Lead))).scalars().all():
                await db.delete(lead)
            db.add(Campaign(name="Kalan Kampanya", message_template="Merhaba {name}"))
            await db.commit()
            assert await should_seed_demo_data(db) is False
    finally:
        await engine.dispose()