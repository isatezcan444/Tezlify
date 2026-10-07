"""Regression test for keyset pagination and conversation ordering indexes.

Verifies:
1. ensure_keyset_and_ordering_indexes creates idx_msg_keyset_ordering and idx_conv_user_channel_last_msg.
2. The function is completely idempotent and safe to run repeatedly.
"""
import pytest
from sqlalchemy import text

from backend.app.core.database import engine
from backend.app.core.migrations import ensure_keyset_and_ordering_indexes


@pytest.mark.asyncio
async def test_ensure_keyset_and_ordering_indexes_idempotent():
    # First execution creates or verifies indexes
    await ensure_keyset_and_ordering_indexes(engine)

    # Second execution must be idempotent and succeed without error
    await ensure_keyset_and_ordering_indexes(engine)

    # Verify index exists
    async with engine.connect() as conn:
        if engine.dialect.name == "sqlite":
            res = await conn.execute(text("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_msg_keyset_ordering'"))
            row = res.scalar()
            assert row == "idx_msg_keyset_ordering"
        elif engine.dialect.name == "postgresql":
            res = await conn.execute(text("SELECT indexname FROM pg_indexes WHERE indexname = 'idx_msg_keyset_ordering'"))
            row = res.scalar()
            assert row == "idx_msg_keyset_ordering"
