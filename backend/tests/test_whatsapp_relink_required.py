"""Stable WhatsApp identity behavior when gateway auth/session is missing."""

import base64
import json
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text

from backend.app.core.database import AsyncSessionLocal
from backend.app.main import app
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services import whatsapp_gateway as gateway
from backend.app.services.whatsapp_service import (
    WhatsAppRelinkRequired,
    _gateway_op_or_mark_relink,
)

TEST_USER = "12345678-1234-1234-1234-123456789012"
TEST_USER_HEX = "12345678123412341234123456789012"
STABLE_GATEWAY_ID = "aaaaaaaa-1111-2222-3333-444444444444"


@pytest_asyncio.fixture(autouse=True)
async def _cleanup_database_sessions():
    async def wipe() -> None:
        async with AsyncSessionLocal() as db:
            await db.execute(
                text("DELETE FROM whatsapp_sessions WHERE user_id = :user_id"),
                {"user_id": TEST_USER_HEX},
            )
            await db.commit()

    await wipe()
    yield
    await wipe()


def _unsigned_test_jwt(user_id: str = TEST_USER) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": user_id, "email": "wa-test@tezlify.com"}).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.test-signature"


async def _seed_session(status: SessionStatus = SessionStatus.CONNECTED) -> int:
    async with AsyncSessionLocal() as db:
        row = WhatsAppSession(
            user_id=TEST_USER,
            gateway_id=STABLE_GATEWAY_ID,
            session_name="Primary line",
            status=status,
            is_active=True,
            is_phone_online=status is SessionStatus.CONNECTED,
        )
        db.add(row)
        await db.commit()
        return int(row.id)


@pytest.mark.asyncio
async def test_missing_gateway_session_keeps_identity_and_requires_relink() -> None:
    db = AsyncMock()
    row = WhatsAppSession(
        id=17,
        user_id="12345678-1234-1234-1234-123456789012",
        gateway_id="stable-gateway-id",
        session_name="Primary line",
        status=SessionStatus.CONNECTED,
        is_active=True,
        is_phone_online=True,
    )
    operation = AsyncMock(
        side_effect=gateway.WhatsAppGatewayError(
            'Gateway hatası 404: {"error":"Session not found"}'
        )
    )

    with pytest.raises(WhatsAppRelinkRequired):
        await _gateway_op_or_mark_relink(db, row, operation)

    assert row.gateway_id == "stable-gateway-id"
    assert row.status is SessionStatus.RELINK_REQUIRED
    assert row.is_active is True
    assert row.is_phone_online is False
    operation.assert_awaited_once_with("stable-gateway-id")
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_non_missing_gateway_error_does_not_change_session_state() -> None:
    db = AsyncMock()
    row = WhatsAppSession(
        id=18,
        user_id="12345678-1234-1234-1234-123456789012",
        gateway_id="stable-gateway-id",
        session_name="Primary line",
        status=SessionStatus.CONNECTING,
        is_active=True,
    )
    error = gateway.WhatsAppGatewayError("Gateway transport timeout")
    operation = AsyncMock(side_effect=error)

    with pytest.raises(gateway.WhatsAppGatewayError) as caught:
        await _gateway_op_or_mark_relink(db, row, operation)

    assert caught.value is error
    assert row.status is SessionStatus.CONNECTING
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_pair_endpoint_returns_relink_state_without_replacing_gateway_id() -> None:
    session_id = await _seed_session()
    missing = gateway.WhatsAppGatewayError(
        'Gateway hatası 404: {"error":"Session not found"}'
    )
    headers = {"Authorization": f"Bearer {_unsigned_test_jwt()}"}

    with pytest.MonkeyPatch.context() as monkeypatch:
        pair = AsyncMock(side_effect=missing)
        create = AsyncMock()
        monkeypatch.setattr(gateway, "request_pairing_code", pair)
        monkeypatch.setattr(gateway, "create_session", create)
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                f"/api/v1/whatsapp/sessions/{session_id}/pair",
                json={"phone": "+905321002030"},
                headers=headers,
            )

    assert response.status_code == 409
    assert response.headers["x-whatsapp-state"] == "RELINK_REQUIRED"
    create.assert_not_awaited()
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(WhatsAppSession).where(WhatsAppSession.id == session_id)
            )
        ).scalar_one()
        assert row.gateway_id == STABLE_GATEWAY_ID
        assert row.status is SessionStatus.RELINK_REQUIRED
        assert row.error_message == "WHATSAPP_AUTH_RELINK_REQUIRED"


@pytest.mark.asyncio
async def test_logout_of_already_missing_gateway_session_is_idempotent() -> None:
    session_id = await _seed_session()
    missing = gateway.WhatsAppGatewayError(
        'Gateway hatası 404: {"error":"Session not found"}'
    )

    with pytest.MonkeyPatch.context() as monkeypatch:
        logout = AsyncMock(side_effect=missing)
        create = AsyncMock()
        monkeypatch.setattr(gateway, "logout_session", logout)
        monkeypatch.setattr(gateway, "create_session", create)
        async with AsyncSessionLocal() as db:
            from backend.app.services import whatsapp_service

            result = await whatsapp_service.logout_session(db, TEST_USER, session_id)

    assert result == {"success": True, "status": "DISCONNECTED"}
    create.assert_not_awaited()
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(WhatsAppSession).where(WhatsAppSession.id == session_id)
            )
        ).scalar_one()
        assert row.gateway_id == STABLE_GATEWAY_ID
        assert row.status is SessionStatus.DISCONNECTED
        assert row.is_active is False
