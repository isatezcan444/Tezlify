"""
Tezlify WhatsApp Rebuild - Phase 2: Session Lifecycle & Event Contract Tests

Verifies backend handling of the unified Gateway Session Lifecycle Webhook:
1. Webhook authentication (fail-closed, invalid secret denied with 401).
2. SESSION_CREATED event sets status to CONNECTING.
3. QR_UPDATED event updates qr_code and sets status to SCAN_QR.
4. CONNECTED event sets status to CONNECTED, updates phone_number,
   and propagates phone_number_e164 to linked WhatsAppNumber without creating fake phone_number_id.
5. DISCONNECTED event sets status to DISCONNECTED and is_phone_online to False.
6. LOGGED_OUT event sets status to DISCONNECTED, clears qr_code, and sets is_phone_online to False.
7. Tenant isolation invariant: mismatch between webhook tenant_id and session.user_id is rejected with 403.
"""

import uuid
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.config import settings
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberProvider, WhatsAppNumberStatus
from backend.app.services.whatsapp_number_service import WhatsAppNumberService


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_lifecycle_webhook_auth_fail_closed():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Missing secret
        res1 = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={"event": "CONNECTED", "session_name": "unknown"}
        )
        assert res1.status_code == 401

        # Invalid secret
        res2 = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={"event": "CONNECTED", "session_name": "unknown"},
            headers={"X-Webhook-Secret": "wrong-secret"}
        )
        assert res2.status_code == 401


@pytest.mark.anyio
async def test_lifecycle_webhook_session_created_and_qr_updated():
    user_id = str(uuid.uuid4())
    session_name = f"lifecycle_test_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=user_id,
            session_name=session_name,
            status=SessionStatus.DISCONNECTED,
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        session_id = session.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. SESSION_CREATED
        headers = {"X-Webhook-Secret": settings.WA_GATEWAY_WEBHOOK_SECRET}
        res_created = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={
                "event": "SESSION_CREATED",
                "tenant_id": user_id,
                "session_id": session_id,
                "session_name": session_name,
                "status": "CONNECTING"
            },
            headers=headers
        )
        assert res_created.status_code == 200

        async with AsyncSessionLocal() as db:
            s_after_create = await db.get(WhatsAppSession, session_id)
            assert s_after_create.status == SessionStatus.CONNECTING

        # 2. QR_UPDATED
        mock_qr = "data:image/png;base64,mockqrpayload123"
        res_qr = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={
                "event": "QR_UPDATED",
                "tenant_id": user_id,
                "session_id": session_id,
                "session_name": session_name,
                "status": "QR_READY",
                "qr_code": mock_qr
            },
            headers=headers
        )
        assert res_qr.status_code == 200

        async with AsyncSessionLocal() as db:
            s_after_qr = await db.get(WhatsAppSession, session_id)
            assert s_after_qr.status == SessionStatus.SCAN_QR
            assert s_after_qr.qr_code == mock_qr

        # Cleanup
        async with AsyncSessionLocal() as db:
            s = await db.get(WhatsAppSession, session_id)
            if s:
                await db.delete(s)
                await db.commit()


@pytest.mark.anyio
async def test_lifecycle_webhook_connected_syncs_phone_to_whatsapp_number():
    user_id = str(uuid.uuid4())
    session_name = f"connected_sync_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        # Create BAILEYS_QR number
        number = await WhatsAppNumberService.create_qr_number(
            db=db,
            name="Test QR Line",
            user_id=user_id,
            display_phone_number=None,
            phone_number_e164=None
        )
        assert number.phone_number_id is None
        assert number.phone_number_e164 is None

        # Create session and link
        session = WhatsAppSession(
            user_id=user_id,
            session_name=session_name,
            status=SessionStatus.SCAN_QR,
            qr_code="initial_qr",
            whatsapp_number_id=number.id
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        await db.refresh(number)
        session_id = session.id
        number_id = number.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        headers = {"X-Webhook-Secret": settings.WA_GATEWAY_WEBHOOK_SECRET}
        res_conn = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={
                "event": "CONNECTED",
                "tenant_id": user_id,
                "session_id": session_id,
                "session_name": session_name,
                "status": "CONNECTED",
                "phone_number_e164": "+905321002030"
            },
            headers=headers
        )
        assert res_conn.status_code == 200
        data = res_conn.json()
        assert data["status"] == "success"
        assert data["phone"] == "+905321002030"

    async with AsyncSessionLocal() as db:
        updated_sess = await db.get(WhatsAppSession, session_id)
        assert updated_sess.status == SessionStatus.CONNECTED
        assert updated_sess.phone_number == "+905321002030"
        assert updated_sess.qr_code is None
        assert updated_sess.is_phone_online is True

        updated_num = await db.get(WhatsAppNumber, number_id)
        assert updated_num.phone_number_e164 == "+905321002030"
        assert updated_num.display_phone_number == "+905321002030"
        assert updated_num.phone_number_id is None  # CRITICAL: remains NULL, no fake id
        assert updated_num.status == WhatsAppNumberStatus.ACTIVE

        # Cleanup
        await db.delete(updated_sess)
        await db.delete(updated_num)
        await db.commit()


@pytest.mark.anyio
async def test_lifecycle_webhook_disconnected_and_logged_out():
    user_id = str(uuid.uuid4())
    session_name = f"disc_logout_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=user_id,
            session_name=session_name,
            status=SessionStatus.CONNECTED,
            phone_number="+905329998877",
            qr_code=None,
            is_phone_online=True
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        session_id = session.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        headers = {"X-Webhook-Secret": settings.WA_GATEWAY_WEBHOOK_SECRET}

        # 1. DISCONNECTED
        res_disc = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={
                "event": "DISCONNECTED",
                "tenant_id": user_id,
                "session_id": session_id,
                "session_name": session_name,
                "status": "DISCONNECTED",
                "error_code": 408,
                "error_message": "Connection timed out"
            },
            headers=headers
        )
        assert res_disc.status_code == 200

        async with AsyncSessionLocal() as db:
            s = await db.get(WhatsAppSession, session_id)
            assert s.status == SessionStatus.DISCONNECTED
            assert s.is_phone_online is False

        # 2. LOGGED_OUT
        res_logout = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={
                "event": "LOGGED_OUT",
                "tenant_id": user_id,
                "session_id": session_id,
                "session_name": session_name,
                "status": "LOGGED_OUT",
                "error_code": 401,
                "error_message": "WhatsApp session logged out"
            },
            headers=headers
        )
        assert res_logout.status_code == 200

        async with AsyncSessionLocal() as db:
            s = await db.get(WhatsAppSession, session_id)
            assert s.status == SessionStatus.DISCONNECTED
            assert s.is_phone_online is False
            assert s.qr_code is None

            # Cleanup
            await db.delete(s)
            await db.commit()


@pytest.mark.anyio
async def test_lifecycle_webhook_tenant_isolation_violation():
    tenant_owner = str(uuid.uuid4())
    attacker_tenant = str(uuid.uuid4())
    session_name = f"tenant_iso_{uuid.uuid4().hex[:8]}"

    async with AsyncSessionLocal() as db:
        session = WhatsAppSession(
            user_id=tenant_owner,
            session_name=session_name,
            status=SessionStatus.SCAN_QR,
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        session_id = session.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        headers = {"X-Webhook-Secret": settings.WA_GATEWAY_WEBHOOK_SECRET}
        # Attacker tries to dispatch event for victim's session
        res = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={
                "event": "CONNECTED",
                "tenant_id": attacker_tenant,
                "session_id": session_id,
                "session_name": session_name,
                "status": "CONNECTED",
                "phone_number_e164": "+905320000000"
            },
            headers=headers
        )
        assert res.status_code == 403
        assert "Tenant isolation violation" in res.json()["detail"]

    # Cleanup
    async with AsyncSessionLocal() as db:
        s = await db.get(WhatsAppSession, session_id)
        if s:
            await db.delete(s)
            await db.commit()
