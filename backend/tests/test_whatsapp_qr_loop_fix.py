import asyncio
import base64
import json
import uuid
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select

from backend.app.main import app
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.whatsapp_number import WhatsAppNumber, WhatsAppNumberProvider, WhatsAppNumberStatus
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.services.whatsapp_number_service import WhatsAppNumberService


def _make_jwt(user_id: str) -> str:
    """Constructs an unverified mock JWT for testing (matches auth middleware decode_jwt_unverified)."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": user_id,
        "user_id": user_id,
        "email": f"test_{user_id[:6]}@tezlify.com",
        "user_metadata": {"full_name": f"Test User {user_id[:6]}"}
    }).encode()).decode().rstrip("=")
    return f"{header}.{payload}.mock_sig"


@pytest.mark.asyncio
async def test_01_create_qr_connection_once_creates_exactly_one_number_and_one_session():
    """1. Create QR connection once -> 1 WhatsAppNumber, 1 WhatsAppSession."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Test Single Line 1", "max_daily_limit": 50},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 201
        data = res.json()
        session_id = data["id"]

    async with AsyncSessionLocal() as db:
        sessions = (await db.execute(
            select(WhatsAppSession).where(WhatsAppSession.user_id == user_id)
        )).scalars().all()
        assert len(sessions) == 1
        assert sessions[0].id == session_id

        numbers = (await db.execute(
            select(WhatsAppNumber).where(WhatsAppNumber.user_id == user_id)
        )).scalars().all()
        assert len(numbers) == 1
        assert numbers[0].provider == WhatsAppNumberProvider.BAILEYS_QR
        assert sessions[0].whatsapp_number_id == numbers[0].id
        assert numbers[0].session_id == session_id


@pytest.mark.asyncio
async def test_02_call_create_or_init_twice_still_exactly_one_number_and_session():
    """2. Call create/init twice -> still 1 number, still 1 session (idempotent)."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # First call
        res1 = await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Line Idemp A", "max_daily_limit": 50},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res1.status_code == 201
        session_id_1 = res1.json()["id"]

        # Second call (even with different random session_name, e.g. simulating re-render)
        res2 = await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Line Idemp B (Random 9999)", "max_daily_limit": 50},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res2.status_code == 201
        session_id_2 = res2.json()["id"]

        # Invariant D: must return the existing active session
        assert session_id_1 == session_id_2

    async with AsyncSessionLocal() as db:
        sessions = (await db.execute(
            select(WhatsAppSession).where(WhatsAppSession.user_id == user_id)
        )).scalars().all()
        assert len(sessions) == 1

        numbers = (await db.execute(
            select(WhatsAppNumber).where(WhatsAppNumber.user_id == user_id)
        )).scalars().all()
        assert len(numbers) == 1


@pytest.mark.asyncio
async def test_03_refresh_qr_10_times_never_creates_additional_records():
    """3. Refresh QR 10 times -> still 1 number, still 1 session."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Line Refresh Test", "max_daily_limit": 50},
            headers={"Authorization": f"Bearer {token}"},
        )
        session_id = res.json()["id"]

        # Refresh 10 times consecutively
        for _ in range(10):
            refresh_res = await client.post(
                f"/api/v1/whatsapp/sessions/{session_id}/refresh-qr",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert refresh_res.status_code == 200

    async with AsyncSessionLocal() as db:
        sessions = (await db.execute(
            select(WhatsAppSession).where(WhatsAppSession.user_id == user_id)
        )).scalars().all()
        assert len(sessions) == 1

        numbers = (await db.execute(
            select(WhatsAppNumber).where(WhatsAppNumber.user_id == user_id)
        )).scalars().all()
        assert len(numbers) == 1


@pytest.mark.asyncio
async def test_04_repeated_get_qr_no_db_mutation_or_new_records():
    """4. Repeated GET QR -> no new records."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Line Polling Test", "max_daily_limit": 50},
            headers={"Authorization": f"Bearer {token}"},
        )
        session_id = res.json()["id"]

        for _ in range(15):
            qr_res = await client.get(
                f"/api/v1/whatsapp/sessions/{session_id}/qr",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert qr_res.status_code == 200

    async with AsyncSessionLocal() as db:
        sessions = (await db.execute(
            select(WhatsAppSession).where(WhatsAppSession.user_id == user_id)
        )).scalars().all()
        assert len(sessions) == 1

        numbers = (await db.execute(
            select(WhatsAppNumber).where(WhatsAppNumber.user_id == user_id)
        )).scalars().all()
        assert len(numbers) == 1


@pytest.mark.asyncio
async def test_05_repeated_get_numbers_status_no_db_mutation():
    """5. Repeated GET numbers -> no DB mutation."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Line List Poll Test", "max_daily_limit": 50},
            headers={"Authorization": f"Bearer {token}"},
        )

        for _ in range(10):
            res = await client.get(
                "/api/v1/whatsapp/numbers",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert res.status_code == 200
            data = res.json()
            assert len(data) == 1
            assert data[0]["provider"] == "BAILEYS_QR"
            assert data[0]["session_id"] is not None


@pytest.mark.asyncio
async def test_06_websocket_lifecycle_events_repeated_no_duplicate_number_session():
    """6. Repeated WebSocket lifecycle webhook events -> no duplicate number/session."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Line Ws Lifecycle Test", "max_daily_limit": 50},
            headers={"Authorization": f"Bearer {token}"},
        )
        session_id = res.json()["id"]

        from backend.app.core.config import settings
        secret = settings.WA_GATEWAY_WEBHOOK_SECRET

        # Send multiple duplicate lifecycle webhook events
        for _ in range(5):
            wh_res = await client.post(
                "/api/v1/whatsapp/webhook/session-lifecycle",
                json={
                    "event": "QR_UPDATED",
                    "tenant_id": user_id,
                    "session_id": session_id,
                    "session_name": "Line Ws Lifecycle Test",
                    "qr_code": "data:image/png;base64,mockqr",
                },
                headers={"X-Webhook-Secret": secret},
            )
            assert wh_res.status_code == 200

        # Send connected event
        conn_res = await client.post(
            "/api/v1/whatsapp/webhook/session-lifecycle",
            json={
                "event": "CONNECTED",
                "tenant_id": user_id,
                "session_id": session_id,
                "session_name": "Line Ws Lifecycle Test",
                "phone_number_e164": "+905559876543",
            },
            headers={"X-Webhook-Secret": secret},
        )
        assert conn_res.status_code == 200

    async with AsyncSessionLocal() as db:
        sessions = (await db.execute(
            select(WhatsAppSession).where(WhatsAppSession.user_id == user_id)
        )).scalars().all()
        assert len(sessions) == 1
        assert sessions[0].status == SessionStatus.CONNECTED
        assert sessions[0].phone_number == "+905559876543"

        numbers = (await db.execute(
            select(WhatsAppNumber).where(WhatsAppNumber.user_id == user_id)
        )).scalars().all()
        assert len(numbers) == 1
        assert numbers[0].phone_number_e164 == "+905559876543"
        assert numbers[0].status == WhatsAppNumberStatus.ACTIVE


@pytest.mark.asyncio
async def test_07_concurrent_qr_creation_requests_only_one_active_number_and_session():
    """7. Concurrent QR creation requests -> only one active QR number/session."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async def _create(idx: int):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/api/v1/whatsapp/sessions",
                json={"session_name": f"Concurrent Line {idx}", "max_daily_limit": 50},
                headers={"Authorization": f"Bearer {token}"},
            )

    # Launch 5 concurrent creation requests
    results = await asyncio.gather(*[_create(i) for i in range(5)])
    for r in results:
        assert r.status_code == 201

    session_ids = {r.json()["id"] for r in results}
    # All concurrent requests must resolve to the exact same session
    assert len(session_ids) == 1

    async with AsyncSessionLocal() as db:
        sessions = (await db.execute(
            select(WhatsAppSession).where(WhatsAppSession.user_id == user_id)
        )).scalars().all()
        assert len(sessions) == 1

        numbers = (await db.execute(
            select(WhatsAppNumber).where(WhatsAppNumber.user_id == user_id)
        )).scalars().all()
        assert len(numbers) == 1


@pytest.mark.asyncio
async def test_08_existing_active_qr_session_returns_existing_without_duplicate():
    """8. Existing active QR session + new connect request -> returns existing session."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create initial connected session
        res1 = await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Active Session Initial"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res1.status_code == 201
        sess1_id = res1.json()["id"]

        # Simulate connection
        async with AsyncSessionLocal() as db:
            s = await db.get(WhatsAppSession, sess1_id)
            s.status = SessionStatus.CONNECTED
            s.phone_number = "+905321112233"
            await db.commit()

        # Another user action to connect
        res2 = await client.post(
            "/api/v1/whatsapp/sessions",
            json={"session_name": "Another Hat Click"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res2.status_code == 201
        assert res2.json()["id"] == sess1_id
        assert res2.json()["status"] == "CONNECTED"


@pytest.mark.asyncio
async def test_09_meta_cloud_records_remain_unaffected():
    """Ensure META_CLOUD number creation and multiple lines remain 100% unaffected."""
    user_id = str(uuid.uuid4())
    token = _make_jwt(user_id)
    transport = ASGITransport(app=app)

    async with AsyncSessionLocal() as db:
        num1 = await WhatsAppNumberService.create_number(
            db=db,
            user_id=user_id,
            name="Meta Line 1",
            waba_id="waba_111",
            phone_number_id=f"phone_id_{uuid.uuid4().hex[:8]}",
            display_phone_number="+90 850 111 00 01",
            access_token="test_token_12345678901234567890",
        )
        num2 = await WhatsAppNumberService.create_number(
            db=db,
            user_id=user_id,
            name="Meta Line 2",
            waba_id="waba_222",
            phone_number_id=f"phone_id_{uuid.uuid4().hex[:8]}",
            display_phone_number="+90 850 111 00 02",
            access_token="test_token_12345678901234567890",
        )
        await db.commit()

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get(
            "/api/v1/whatsapp/numbers",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200
        data = res.json()
        # Meta Cloud allows multiple numbers
        meta_numbers = [n for n in data if n["provider"] == "META_CLOUD"]
        assert len(meta_numbers) == 2
