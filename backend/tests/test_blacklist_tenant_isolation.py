"""The blacklist is PER-TENANT, including on the send path.

The create endpoint always wrote `user_id` and the list endpoint always filtered
by it, but `OutreachManager.is_blacklisted` / `get_blacklisted_phones` matched on
`phone_e164` alone. So tenant A adding a number to their opt-out list silently
suppressed tenant B's campaign sends to that number — a cross-tenant leak with a
compliance flavour: B's own opt-outs were honoured, A's were honoured for B too.

`user_id` is now a required keyword argument, so a new call site cannot omit it
and quietly restore the old behaviour.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.models.blacklist import Blacklist
from backend.app.services.outreach_manager import OutreachManager


@pytest_asyncio.fixture
async def db(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/blacklist.db")
    async with engine.begin() as conn:
        await conn.run_sync(Blacklist.__table__.create)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    await engine.dispose()


TENANT_A = str(uuid.uuid4())
TENANT_B = str(uuid.uuid4())
PHONE = "+905551112233"


@pytest.mark.asyncio
async def test_single_check_is_scoped_to_the_owner(db):
    db.add(Blacklist(user_id=TENANT_A, phone_e164=PHONE, reason="USER_REQUEST"))
    await db.commit()

    assert await OutreachManager.is_blacklisted(db, PHONE, user_id=TENANT_A) is True
    assert await OutreachManager.is_blacklisted(db, PHONE, user_id=TENANT_B) is False, (
        "one tenant's opt-out must not suppress another tenant's send"
    )


@pytest.mark.asyncio
async def test_batch_check_is_scoped_to_the_owner(db):
    db.add(Blacklist(user_id=TENANT_A, phone_e164=PHONE, reason="USER_REQUEST"))
    await db.commit()

    assert await OutreachManager.get_blacklisted_phones(
        db, [PHONE], user_id=TENANT_A
    ) == {PHONE}
    assert await OutreachManager.get_blacklisted_phones(db, [PHONE], user_id=TENANT_B) == set()


@pytest.mark.asyncio
async def test_unknown_phone_is_never_blacklisted(db):
    assert await OutreachManager.is_blacklisted(db, "+905559998877", user_id=TENANT_A) is False
    assert await OutreachManager.get_blacklisted_phones(db, [], user_id=TENANT_A) == set()
