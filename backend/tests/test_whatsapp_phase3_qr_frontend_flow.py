"""
Backend Integration & Flow Tests for Phase 3: Frontend QR Connection Flow.

Validates:
1. create_session automatically provisions and links a 1:1 WhatsAppNumber root with provider=BAILEYS_QR.
2. create_session on existing disconnected session reuses session and preserves 1:1 relationship.
3. phone_number_id is strictly NULL on BAILEYS_QR number; real phone stored in phone_number_e164.
4. refresh_session_qr preserves session identity and linked number without creating duplicate records.
5. verify_number on BAILEYS_QR number checks session connection without Meta Cloud tokens.
6. disconnect_number on BAILEYS_QR number sets both number and linked session to DISCONNECTED.
7. remove_number safely unlinks/cleans up session without cascading data destruction.
"""
import uuid
import pytest
from unittest.mock import AsyncMock, patch
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import AsyncSessionLocal, engine, Base
from backend.app.core.migrations import (
    ensure_whatsapp_numbers_table,
    ensure_whatsapp_sessions_number_fk,
)
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberStatus, WhatsAppNumberProvider
from backend.app.services.whatsapp_number_service import WhatsAppNumberService
from backend.app.schemas.whatsapp import WhatsAppSessionCreate
from backend.app.core.auth import AuthUser


_db_initialized = False

async def _init_p3_db():
    global _db_initialized
    if _db_initialized:
        return
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await ensure_whatsapp_numbers_table(engine)
    await ensure_whatsapp_sessions_number_fk(engine)
    _db_initialized = True


@pytest.mark.asyncio
async def test_01_create_session_automatically_links_baileys_qr_number():
    """Verifies that create_session creates both WhatsAppSession and WhatsAppNumber (provider=BAILEYS_QR)."""
    await _init_p3_db()
    from backend.app.api.v1.endpoints.whatsapp import create_session
    from fastapi import BackgroundTasks

    user_id = str(uuid.uuid4())
    auth_user = AuthUser(id=user_id, email="p3_1@example.com", role="USER")
    session_name = f"Hat P3 Test {uuid.uuid4().hex[:6]}"
    session_in = WhatsAppSessionCreate(
        session_name=session_name,
        phone_number=None,
        max_daily_limit=50,
    )

    bg_tasks = BackgroundTasks()

    async with AsyncSessionLocal() as db_session:
        with patch("backend.app.api.v1.endpoints.whatsapp.gateway_client.create_session", new_callable=AsyncMock) as mock_gw:
            mock_gw.return_value = {"success": True, "status": "SCAN_QR", "qr_code": "data:image/png;base64,FAKEQR123"}

            res = await create_session(
                session_in=session_in,
                background_tasks=bg_tasks,
                db=db_session,
                current_user=auth_user,
            )

            assert res is not None
            assert res.session_name == session_name
            assert res.whatsapp_number_id is not None

            # Verify linked WhatsAppNumber
            wanum = await db_session.get(WhatsAppNumber, res.whatsapp_number_id)
            assert wanum is not None
            assert wanum.name == session_name
            assert wanum.provider == WhatsAppNumberProvider.BAILEYS_QR
            assert wanum.phone_number_id is None
            assert wanum.status == WhatsAppNumberStatus.ACTIVE


@pytest.mark.asyncio
async def test_02_create_session_reuses_existing_disconnected_session():
    """Verifies that re-initializing an existing disconnected session preserves its 1:1 number link."""
    await _init_p3_db()
    from backend.app.api.v1.endpoints.whatsapp import create_session
    from fastapi import BackgroundTasks

    user_id = str(uuid.uuid4())
    auth_user = AuthUser(id=user_id, email="p3_2@example.com", role="USER")
    session_name = f"Hat Reconnect {uuid.uuid4().hex[:6]}"

    async with AsyncSessionLocal() as db_session:
        # Create initial number & session
        wanum = await WhatsAppNumberService.create_qr_number(
            db=db_session,
            name=session_name,
            user_id=user_id,
            phone_number_e164=None,
        )
        session = WhatsAppSession(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            session_name=session_name,
            status=SessionStatus.DISCONNECTED,
            max_daily_limit=50,
        )
        db_session.add(session)
        await db_session.commit()
        await db_session.refresh(session)

        session_in = WhatsAppSessionCreate(
            session_name=session_name,
            max_daily_limit=50,
        )
        bg_tasks = BackgroundTasks()

        with patch("backend.app.api.v1.endpoints.whatsapp.gateway_client.create_session", new_callable=AsyncMock) as mock_gw:
            mock_gw.return_value = {"success": True, "status": "SCAN_QR", "qr_code": "data:image/png;base64,NEWQR"}

            res = await create_session(
                session_in=session_in,
                background_tasks=bg_tasks,
                db=db_session,
                current_user=auth_user,
            )

            assert res.id == session.id
            assert res.whatsapp_number_id == wanum.id
            assert res.status == SessionStatus.SCAN_QR


@pytest.mark.asyncio
async def test_03_refresh_session_qr_preserves_session_identity():
    """Verifies that refresh-qr does not change session ID or linked number."""
    await _init_p3_db()
    from backend.app.api.v1.endpoints.whatsapp import refresh_session_qr_code

    user_id = str(uuid.uuid4())
    auth_user = AuthUser(id=user_id, email="p3_3@example.com", role="USER")
    session_name = f"Hat Refresh {uuid.uuid4().hex[:6]}"

    async with AsyncSessionLocal() as db_session:
        wanum = await WhatsAppNumberService.create_qr_number(
            db=db_session,
            name=session_name,
            user_id=user_id,
        )
        session = WhatsAppSession(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            session_name=session_name,
            status=SessionStatus.SCAN_QR,
            qr_code="initial_qr",
        )
        db_session.add(session)
        await db_session.commit()
        await db_session.refresh(session)

        with patch("backend.app.api.v1.endpoints.whatsapp.gateway_client.get_session_status", new_callable=AsyncMock) as mock_status, \
             patch("backend.app.api.v1.endpoints.whatsapp.gateway_client.refresh_session_qr", new_callable=AsyncMock) as mock_refresh:

            mock_status.return_value = {"status": "SCAN_QR"}
            mock_refresh.return_value = {"success": True, "status": "SCAN_QR", "qr_code": "new_refreshed_qr"}

            res = await refresh_session_qr_code(
                session_id=session.id,
                db=db_session,
                current_user=auth_user,
            )

            assert res["success"] is True
            assert res["qr_code"] == "new_refreshed_qr"

            # Session ID and linked number must remain unchanged
            await db_session.refresh(session)
            assert session.whatsapp_number_id == wanum.id
            assert session.qr_code == "new_refreshed_qr"


@pytest.mark.asyncio
async def test_04_verify_number_on_baileys_qr():
    """Verifies that verify_number checks linked session connection without requiring Meta access tokens."""
    await _init_p3_db()
    user_id = str(uuid.uuid4())
    session_name = f"Hat Verify {uuid.uuid4().hex[:6]}"

    async with AsyncSessionLocal() as db_session:
        wanum = await WhatsAppNumberService.create_qr_number(
            db=db_session,
            name=session_name,
            user_id=user_id,
        )
        session = WhatsAppSession(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
            phone_number="+905551234567",
        )
        db_session.add(session)
        await db_session.commit()

        res = await WhatsAppNumberService.verify_number(
            db=db_session,
            number_id=wanum.id,
            user_id=user_id,
        )

        assert res["id"] == wanum.id
        assert res["status"] == WhatsAppNumberStatus.ACTIVE
        assert res["verified"] is True
        assert res["quality_rating"] == "GREEN"


@pytest.mark.asyncio
async def test_05_disconnect_number_on_baileys_qr():
    """Verifies that disconnecting a BAILEYS_QR number sets both number and linked session to DISCONNECTED."""
    await _init_p3_db()
    user_id = str(uuid.uuid4())
    session_name = f"Hat Disconnect {uuid.uuid4().hex[:6]}"

    async with AsyncSessionLocal() as db_session:
        wanum = await WhatsAppNumberService.create_qr_number(
            db=db_session,
            name=session_name,
            user_id=user_id,
        )
        session = WhatsAppSession(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
            is_phone_online=True,
        )
        db_session.add(session)
        await db_session.commit()

        disconnected = await WhatsAppNumberService.disconnect_number(
            db=db_session,
            number_id=wanum.id,
            user_id=user_id,
        )

        assert disconnected.status == WhatsAppNumberStatus.DISCONNECTED

        await db_session.refresh(session)
        assert session.status == SessionStatus.DISCONNECTED
        assert session.is_phone_online is False


@pytest.mark.asyncio
async def test_06_remove_number_safely_unlinks_session():
    """Verifies that removing a BAILEYS_QR number deletes linked sessions (product rule)."""
    await _init_p3_db()
    user_id = str(uuid.uuid4())
    session_name = f"Hat Remove {uuid.uuid4().hex[:6]}"

    async with AsyncSessionLocal() as db_session:
        wanum = await WhatsAppNumberService.create_qr_number(
            db=db_session,
            name=session_name,
            user_id=user_id,
        )
        session = WhatsAppSession(
            user_id=user_id,
            whatsapp_number_id=wanum.id,
            session_name=session_name,
            status=SessionStatus.DISCONNECTED,
        )
        db_session.add(session)
        await db_session.commit()
        session_id = session.id

        await WhatsAppNumberService.remove_number_safely(
            db=db_session,
            number_id=wanum.id,
            user_id=user_id,
        )

        # Linked session row is deleted so the next pairing starts from fresh QR
        assert await db_session.get(WhatsAppSession, session_id) is None

        # Number should no longer exist
        deleted = await db_session.get(WhatsAppNumber, wanum.id)
        assert deleted is None
