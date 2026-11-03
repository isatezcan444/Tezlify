"""AŞAMA 6.4 — Provider logout hatasında orphan CONNECTED oturumu.

Neden bu dosya var
------------------
Gateway `sock.logout()` sağlayıcı tarafında başarısız olsa bile yerel oturumu
kapatır ve HTTP 500 gövdesinde `local_status: "DISCONNECTED"` döner. Backend
bu bilgiyi yok sayarsa satır `CONNECTED` kalır ve UI'da "bağlı ama ölü" bir
oturum görünür (6.0 P1-2).

Sözleşme
--------
- Sağlayıcı hatası ASLA başarı olarak raporlanmaz; `logout_session` yeniden
  fırlatır (API 502 döner).
- Gateway yerel oturumu kapattığını bildiriyorsa backend bunu kalıcılaştırır:
  status DISCONNECTED, is_active False, is_phone_online False.
- Bu bilgi yoksa (taşıma hatası, gövdesiz 5xx) satır ELLENMEZ: fail-closed.
- 404 "session not found" mevcut davranışını korur (başarı + DISCONNECTED).
- Bir oturumun hatası başka oturumun durumunu değiştirmez.

Mock testleri (AsyncMock DB) ile gerçek yerel DB testi ayrı işaretlenmiştir.
"""
import json
import uuid as _uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from backend.app.core.config import settings
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.orchestration.sessions import logout_session
from backend.app.services.whatsapp_gateway import WhatsAppGatewayError

TEST_USER = "12345678-1234-1234-1234-123456789012"


def _provider_failure_body(message: str = "provider unlink rejected", local_status="DISCONNECTED") -> str:
    body = {"success": False}
    if local_status is not None:
        body["local_status"] = local_status
    body["reason"] = "provider"
    body["error"] = message
    return json.dumps(body)


def _provider_error(
    message: str = "Gateway hatası 500: provider logout failed",
    body: str | None = None,
) -> WhatsAppGatewayError:
    return WhatsAppGatewayError(
        message,
        status_code=500,
        response_body=body if body is not None else _provider_failure_body(),
    )


def _row(**overrides) -> WhatsAppSession:
    values = {
        "id": 5,
        "user_id": TEST_USER,
        "gateway_id": "gw-64",
        "session_name": "phase-6.4",
        "status": SessionStatus.CONNECTED,
        "is_active": True,
        "is_phone_online": True,
    }
    values.update(overrides)
    return WhatsAppSession(**values)


# ---------------------------------------------------------------------------
# Mock DB tests — orchestration contract only (no database involved).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provider_failure_with_local_disconnect_persists_and_raises():
    db = AsyncMock()
    row = _row()
    with patch(
        "backend.app.services.whatsapp.orchestration.sessions._get_session_or_404",
        new_callable=AsyncMock,
        return_value=row,
    ), patch(
        "backend.app.services.whatsapp_gateway.logout_session",
        new_callable=AsyncMock,
        side_effect=_provider_error(),
    ):
        with pytest.raises(WhatsAppGatewayError):
            await logout_session(db, TEST_USER, row.id)

    assert row.status == SessionStatus.DISCONNECTED
    assert row.is_active is False
    assert row.is_phone_online is False
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_transport_failure_without_local_status_leaves_row_untouched():
    db = AsyncMock()
    row = _row()
    transport_error = WhatsAppGatewayError("Gateway'e ulaşılamadı: connection refused")
    with patch(
        "backend.app.services.whatsapp.orchestration.sessions._get_session_or_404",
        new_callable=AsyncMock,
        return_value=row,
    ), patch(
        "backend.app.services.whatsapp_gateway.logout_session",
        new_callable=AsyncMock,
        side_effect=transport_error,
    ):
        with pytest.raises(WhatsAppGatewayError):
            await logout_session(db, TEST_USER, row.id)

    assert row.status == SessionStatus.CONNECTED
    assert row.is_active is True
    assert row.is_phone_online is True
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_5xx_without_local_status_is_fail_closed():
    db = AsyncMock()
    row = _row()
    with patch(
        "backend.app.services.whatsapp.orchestration.sessions._get_session_or_404",
        new_callable=AsyncMock,
        return_value=row,
    ), patch(
        "backend.app.services.whatsapp_gateway.logout_session",
        new_callable=AsyncMock,
        side_effect=_provider_error(body='{"success":false,"error":"boom"}'),
    ):
        with pytest.raises(WhatsAppGatewayError):
            await logout_session(db, TEST_USER, row.id)

    assert row.status == SessionStatus.CONNECTED
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_malformed_local_status_is_fail_closed():
    db = AsyncMock()
    row = _row()
    with patch(
        "backend.app.services.whatsapp.orchestration.sessions._get_session_or_404",
        new_callable=AsyncMock,
        return_value=row,
    ), patch(
        "backend.app.services.whatsapp_gateway.logout_session",
        new_callable=AsyncMock,
        side_effect=_provider_error(body="unexpected plain text"),
    ):
        with pytest.raises(WhatsAppGatewayError):
            await logout_session(db, TEST_USER, row.id)

    assert row.status == SessionStatus.CONNECTED
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_gateway_session_keeps_existing_success_behaviour():
    db = AsyncMock()
    row = _row()
    with patch(
        "backend.app.services.whatsapp.orchestration.sessions._get_session_or_404",
        new_callable=AsyncMock,
        return_value=row,
    ), patch(
        "backend.app.services.whatsapp_gateway.logout_session",
        new_callable=AsyncMock,
        side_effect=WhatsAppGatewayError(
            'Gateway hatası 404: {"error":"session not found"}',
            status_code=404,
            response_body='{"error":"session not found"}',
        ),
    ):
        result = await logout_session(db, TEST_USER, row.id)

    assert result == {"success": True, "status": "DISCONNECTED"}
    assert row.status == SessionStatus.DISCONNECTED
    db.commit.assert_awaited_once()


# ---------------------------------------------------------------------------
# Real local SQLite database test — proves the reconciled state is persisted
# and that another session is untouched. No PostgreSQL provider is contacted.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_real_db_persists_reconciled_state_and_isolates_sessions():
    # A loop-local NullPool engine: the module-level `AsyncSessionLocal` may be
    # bound to another event loop under pytest-asyncio, and pooled connections
    # cannot cross loops.
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    gw_a = f"gw64-a-{_uuid.uuid4().hex[:10]}"
    gw_b = f"gw64-b-{_uuid.uuid4().hex[:10]}"
    ids: list[int] = []

    try:
        async with maker() as db:
            row_a = WhatsAppSession(
                user_id=TEST_USER,
                gateway_id=gw_a,
                session_name=f"64-a-{gw_a[-6:]}",
                status=SessionStatus.CONNECTED,
                is_active=True,
                is_phone_online=True,
            )
            row_b = WhatsAppSession(
                user_id=TEST_USER,
                gateway_id=gw_b,
                session_name=f"64-b-{gw_b[-6:]}",
                status=SessionStatus.CONNECTED,
                is_active=True,
                is_phone_online=True,
            )
            db.add_all([row_a, row_b])
            await db.commit()
            ids = [row_a.id, row_b.id]
            session_a_id = row_a.id
            session_b_id = row_b.id

        with patch(
            "backend.app.services.whatsapp_gateway.logout_session",
            new_callable=AsyncMock,
            side_effect=_provider_error(),
        ):
            async with maker() as db:
                with pytest.raises(WhatsAppGatewayError):
                    await logout_session(db, TEST_USER, session_a_id)

        async with maker() as db:
            persisted_a = await db.get(WhatsAppSession, session_a_id)
            persisted_b = await db.get(WhatsAppSession, session_b_id)
            assert persisted_a.status == SessionStatus.DISCONNECTED
            assert persisted_a.is_active is False
            assert persisted_a.is_phone_online is False
            assert persisted_b.status == SessionStatus.CONNECTED
            assert persisted_b.is_active is True
            assert persisted_b.is_phone_online is True
    finally:
        async with maker() as db:
            await db.execute(delete(WhatsAppSession).where(WhatsAppSession.id.in_(ids)))
            await db.commit()
        await engine.dispose()
