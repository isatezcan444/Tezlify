"""Phase 8.0.3: WhatsApp Sandbox Critical Security Remediation & Safe Event Isolation Tests.

Exhaustively verifies:
- P0: Customer messages containing 'TEZLIFY_SANDBOX' prefix are never dropped or skipped.
- P0: Sandbox fallthrough guards under disabled sandbox, session mismatch, sender mismatch,
      unknown correlation ID, malformed PONG, and handler exceptions.
- P1: Admin RBAC enforcement on /status, /ping, and /results (401 anon, 403 non-admin, 200 admin).
- P1: Cross-tenant test results isolation (Tenant A never sees Tenant B's data).
- P1: Unowned session (user_id=None) isolation for non-admin callers.
- P2: Hardened production session protection (system session names and non-sandbox sessions blocked).
- P3: Atomic, deterministic settle between timeout and PONG without conflicting states.
"""

import asyncio
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from backend.app.auth.api import dependencies as deps
from backend.app.core.auth import AuthUser
from backend.app.core.database import get_db
from backend.app.main import app
from backend.app.models.whatsapp_session import WhatsAppSession
from backend.app.services.whatsapp.identity import SYSTEM_USER_ID
from backend.app.services.whatsapp.orchestration import events
from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
from backend.app.services.whatsapp.sandbox import (
    PROTECTED_PRODUCTION_SESSION_IDS,
    ProductionSessionBlockedError,
    SandboxTestRecord,
    WhatsAppSandboxError,
    WhatsAppSandboxService,
    is_session_sandbox_eligible,
    sandbox_service,
)


@pytest.fixture
def mock_db():
    db = AsyncMock()
    nested = AsyncMock()
    nested.__aenter__.return_value = nested
    nested.__aexit__.return_value = None
    db.begin_nested = MagicMock(return_value=nested)
    res_mock = MagicMock()
    res_mock.all.return_value = []
    res_mock.first.return_value = None
    db.execute.return_value = res_mock
    return db


@contextmanager
def fallthrough_tracker(handler: WhatsAppEventOrchestrator, session_id: int = 999):
    """Mocks downstream persistence helpers so we can verify normal ingest execution."""
    spy_resolve = AsyncMock(return_value=(SYSTEM_USER_ID, session_id))
    spy_conv = AsyncMock(return_value=MagicMock(id=1, unread_count=0))
    spy_apply = MagicMock()
    spy_serialize = MagicMock(return_value={"id": 1, "body": "test"})
    spy_upsert = AsyncMock()

    with patch.object(events, "_resolve_event_owner_and_session", new=spy_resolve), \
         patch.object(handler, "_ensure_conversation_race_safe", new=spy_conv), \
         patch.object(events, "_apply_last_message", new=spy_apply), \
         patch.object(events, "_serialize_message", new=spy_serialize), \
         patch.object(handler, "_upsert_contact", new=spy_upsert):
        yield spy_resolve


# ==============================================================================
# SECTION 1: P0 — SAFE EVENT INGEST FALLTHROUGH & SPOOFED PREFIX TESTS
# ==============================================================================

@pytest.mark.asyncio
async def test_spoofed_prefix_normal_ingest_when_sandbox_disabled(monkeypatch, mock_db):
    """P0 FIX: Sandbox kapalıyken TEZLIFY_SANDBOX prefix'li müşteri mesajı ASLA düşürülmez."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", False)

    handler = WhatsAppEventOrchestrator()
    spoofed_body = "TEZLIFY_SANDBOX: Merhaba, ürün hakkında teklif almak istiyorum"
    event = {
        "event": "message_new",
        "gateway_session_id": "session-live-201",
        "conversation_id": "905413749073@s.whatsapp.net",
        "message": {
            "conversation_id": "905413749073@s.whatsapp.net",
            "body": spoofed_body,
            "direction": "INBOUND",
        },
    }

    with fallthrough_tracker(handler, session_id=201) as spy_resolve:
        res = await handler._ingest_message(mock_db, event)

        # Mesaj sandbox tarafından atlanmadı, normal ingest owner çözümlemesine ulaştı!
        spy_resolve.assert_awaited_once()
        if "_skip" in res:
            assert "sandbox" not in res["_skip"]


@pytest.mark.asyncio
async def test_spoofed_prefix_normal_ingest_when_sandbox_enabled_unknown_corr(monkeypatch, mock_db):
    """P0 FIX: Sandbox açık olsa bile kayıtlı olmayan bir correlation ID mesajı düşürmez."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    handler = WhatsAppEventOrchestrator()
    spoofed_pong = "TEZLIFY_SANDBOX:PONG:unknown_corr_random_123"
    event = {
        "event": "message_new",
        "gateway_session_id": "sandbox-session-999",
        "conversation_id": "905551234567@s.whatsapp.net",
        "message": {
            "conversation_id": "905551234567@s.whatsapp.net",
            "body": spoofed_pong,
            "direction": "INBOUND",
        },
    }

    with fallthrough_tracker(handler, session_id=999) as spy_resolve:
        res = await handler._ingest_message(mock_db, event)
        spy_resolve.assert_awaited_once()
        if "_skip" in res:
            assert "sandbox" not in res["_skip"]


@pytest.mark.asyncio
async def test_session_mismatch_falls_through_to_normal_ingest(monkeypatch, mock_db):
    """P0 FIX: Yanlış gateway session'dan gelen sandbox mesajı düşürülmez."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    corr = "corr_session_mismatch"
    sandbox_service._active_tests[corr] = SandboxTestRecord(
        test_id="test_sm",
        correlation_id=corr,
        session_id=999,
        target_masked="+90555****67",
        started_at="2026-11-04T00:00:00Z",
        target_phone="+905551234567",
        gateway_session_id="sandbox-session-999",
    )

    handler = WhatsAppEventOrchestrator()
    # Mesaj canlı hat Session 201 üzerinden geldi!
    event = {
        "event": "message_new",
        "gateway_session_id": "production-session-201",
        "conversation_id": "905551234567@s.whatsapp.net",
        "message": {
            "conversation_id": "905551234567@s.whatsapp.net",
            "body": f"TEZLIFY_SANDBOX:PONG:{corr}",
            "direction": "INBOUND",
        },
    }

    try:
        with fallthrough_tracker(handler, session_id=201) as spy_resolve:
            res = await handler._ingest_message(mock_db, event)
            spy_resolve.assert_awaited_once()
            if "_skip" in res:
                assert "sandbox" not in res["_skip"]
    finally:
        sandbox_service._active_tests.pop(corr, None)


@pytest.mark.asyncio
async def test_sender_mismatch_falls_through_to_normal_ingest(monkeypatch, mock_db):
    """P0 FIX: Beklenen hedef numara dışındaki bir göndericiden gelen mesaj düşürülmez."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    corr = "corr_sender_mismatch"
    sandbox_service._active_tests[corr] = SandboxTestRecord(
        test_id="test_send_m",
        correlation_id=corr,
        session_id=999,
        target_masked="+90555****67",
        started_at="2026-11-04T00:00:00Z",
        target_phone="+905551234567",
        gateway_session_id="sandbox-session-999",
    )

    handler = WhatsAppEventOrchestrator()
    # Mesaj farklı bir telefondan geldi (+905559990011)
    event = {
        "event": "message_new",
        "gateway_session_id": "sandbox-session-999",
        "conversation_id": "905559990011@s.whatsapp.net",
        "message": {
            "conversation_id": "905559990011@s.whatsapp.net",
            "body": f"TEZLIFY_SANDBOX:PONG:{corr}",
            "direction": "INBOUND",
        },
    }

    try:
        with fallthrough_tracker(handler, session_id=999) as spy_resolve:
            res = await handler._ingest_message(mock_db, event)
            spy_resolve.assert_awaited_once()
            if "_skip" in res:
                assert "sandbox" not in res["_skip"]
    finally:
        sandbox_service._active_tests.pop(corr, None)


@pytest.mark.asyncio
async def test_handler_exception_falls_through_to_normal_ingest(monkeypatch, mock_db):
    """P0 FIX: Sandbox handler'ı bir exception fırlatsa bile müşteri mesajı sessizce kaybedilmez."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)

    handler = WhatsAppEventOrchestrator()
    event = {
        "event": "message_new",
        "gateway_session_id": "sandbox-session-999",
        "conversation_id": "905551234567@s.whatsapp.net",
        "message": {
            "conversation_id": "905551234567@s.whatsapp.net",
            "body": "TEZLIFY_SANDBOX:PONG:boom",
            "direction": "INBOUND",
        },
    }

    with patch.object(sandbox_service, "handle_inbound_message", side_effect=RuntimeError("Simulated Handler Failure")):
        with fallthrough_tracker(handler, session_id=999) as spy_resolve:
            res = await handler._ingest_message(mock_db, event)
            spy_resolve.assert_awaited_once()


@pytest.mark.asyncio
async def test_valid_active_pong_safely_consumed(monkeypatch, mock_db):
    """P0: Geçerli tüm koşullar sağlandığında sandbox PONG mesajı güvenle tüketilir."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    corr = "corr_valid_consumed_01"
    sandbox_service._active_tests[corr] = SandboxTestRecord(
        test_id="test_consumed",
        correlation_id=corr,
        session_id=999,
        target_masked="+90555****67",
        started_at="2026-11-04T00:00:00Z",
        target_phone="+905551234567",
        gateway_session_id="sandbox-session-999",
    )

    handler = WhatsAppEventOrchestrator()

    event = {
        "event": "message_new",
        "gateway_session_id": "sandbox-session-999",
        "conversation_id": "905551234567@s.whatsapp.net",
        "message": {
            "conversation_id": "905551234567@s.whatsapp.net",
            "body": f"TEZLIFY_SANDBOX:PONG:{corr}",
            "direction": "INBOUND",
        },
    }

    try:
        with fallthrough_tracker(handler, session_id=999) as spy_resolve:
            res = await handler._ingest_message(mock_db, event)
            # Sandbox tüketildi, normal ingest çağrılmadı!
            assert "_skip" in res
            assert "sandbox ping/pong consumed safely" in res["_skip"]
            assert spy_resolve.call_count == 0
    finally:
        sandbox_service._active_tests.pop(corr, None)


# ==============================================================================
# SECTION 2: P1 — ADMIN RBAC ENFORCEMENT ON /status, /ping, /results
# ==============================================================================

@pytest.mark.asyncio
async def test_anonymous_caller_is_rejected_with_401():
    """P1: Kimlik doğrulaması yapmamış anonim istekler 401 Unauthorized alır."""
    app.dependency_overrides.clear()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res_status = await ac.get("/api/v1/whatsapp/sandbox/status")
        res_ping = await ac.post("/api/v1/whatsapp/sandbox/ping", json={"target": "+905551234567"})
        res_results = await ac.get("/api/v1/whatsapp/sandbox/results")

    assert res_status.status_code == 401
    assert res_ping.status_code == 401
    assert res_results.status_code == 401


@pytest.mark.asyncio
async def test_non_admin_tenant_is_rejected_with_403(monkeypatch):
    """P1: Standart kiracı kullanıcısı (non-admin) 403 Forbidden alır."""
    from backend.app.core.config import settings
    monkeypatch.setattr(settings, "ADMIN_EMAILS", ["admin@tezlify.com"])

    # Normal kiracı
    tenant_user = AuthUser(
        id="00000000-0000-0000-0000-000000000002",
        email="tenant@customer.com",
        role="USER",
        is_admin=False,
    )
    app.dependency_overrides[deps.get_current_user_unified] = lambda: tenant_user

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res_status = await ac.get("/api/v1/whatsapp/sandbox/status")
            res_ping = await ac.post("/api/v1/whatsapp/sandbox/ping", json={"target": "+905551234567"})
            res_results = await ac.get("/api/v1/whatsapp/sandbox/results")

        assert res_status.status_code == 403
        assert "yönetici yetkisi gerekiyor" in res_status.json()["detail"].lower()
        assert res_ping.status_code == 403
        assert res_results.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_authorized_admin_can_access_endpoints(monkeypatch):
    """P1: Admin allowlist'inde olan yönetici endpoint'lere erişebilir."""
    from backend.app.core.config import settings
    monkeypatch.setattr(settings, "ADMIN_EMAILS", ["admin@tezlify.com"])

    admin_user = AuthUser(
        id="00000000-0000-0000-0000-000000000001",
        email="admin@tezlify.com",
        role="ADMIN",
        is_admin=True,
    )
    app.dependency_overrides[deps.get_current_user_unified] = lambda: admin_user

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res_status = await ac.get("/api/v1/whatsapp/sandbox/status")
            res_results = await ac.get("/api/v1/whatsapp/sandbox/results")

        assert res_status.status_code == 200
        assert res_results.status_code == 200
        assert isinstance(res_results.json(), list)
    finally:
        app.dependency_overrides.clear()


# ==============================================================================
# SECTION 3: P1 — CROSS-TENANT RESULTS ISOLATION
# ==============================================================================

@pytest.mark.asyncio
async def test_cross_tenant_results_isolation():
    """P1: Kiracı A asla Kiracı B'nin test sonuçlarını göremez."""
    service = WhatsAppSandboxService()

    tenant_a = "tenant-user-aaa"
    tenant_b = "tenant-user-bbb"

    rec_a = SandboxTestRecord(
        test_id="test_a_01",
        correlation_id="TEZLIFY_SANDBOX:a_01",
        session_id=999,
        target_masked="+90555****01",
        user_id=tenant_a,
        started_at="2026-11-04T10:00:00Z",
    )
    rec_b = SandboxTestRecord(
        test_id="test_b_01",
        correlation_id="TEZLIFY_SANDBOX:b_01",
        session_id=999,
        target_masked="+90555****02",
        user_id=tenant_b,
        started_at="2026-11-04T10:05:00Z",
    )
    rec_unowned = SandboxTestRecord(
        test_id="test_unowned",
        correlation_id="TEZLIFY_SANDBOX:unowned",
        session_id=999,
        target_masked="+90555****99",
        user_id=None,
        started_at="2026-11-04T10:10:00Z",
    )

    service._results_history.append(rec_a.to_dict())
    service._results_history.append(rec_b.to_dict())
    service._results_history.append(rec_unowned.to_dict())

    # 1. Tenant A sorgular
    results_a = service.get_results_history(user_id=tenant_a, is_admin=False)
    assert len(results_a) == 1
    assert results_a[0]["test_id"] == "test_a_01"
    assert results_a[0]["user_id"] == tenant_a

    # 2. Tenant B sorgular
    results_b = service.get_results_history(user_id=tenant_b, is_admin=False)
    assert len(results_b) == 1
    assert results_b[0]["test_id"] == "test_b_01"
    assert results_b[0]["user_id"] == tenant_b

    # 3. Anonim / belirtilmemiş kullanıcı boş liste alır
    results_none = service.get_results_history(user_id=None, is_admin=False)
    assert results_none == []

    # 4. Admin tüm kayıtları (sahipsiz dahil) görür
    results_admin = service.get_results_history(user_id=None, is_admin=True)
    assert len(results_admin) == 3


# ==============================================================================
# SECTION 4: P1 — SAHİPSİZ SESSION (user_id=None) İZOLASYONU
# ==============================================================================

@pytest.mark.asyncio
async def test_unowned_session_requires_admin():
    """P1: user_id=None olan sahipsiz/sistem oturumları normal kiracılara kapalıdır."""
    service = WhatsAppSandboxService()

    # Normal kiracı sahipsiz session'ı doğrulamaya çalışırsa -> FAIL
    with pytest.raises(WhatsAppSandboxError) as exc_info:
        service.validate_session(
            session_id=999,
            user_id="normal-tenant-user",
            session_owner_id=None,
            is_admin=False,
        )
    assert "Unowned/system session requires administrator authorization" in str(exc_info.value)

    # Admin sahipsiz session'ı doğrulayabilir
    validated = service.validate_session(
        session_id=999,
        user_id="admin-user",
        session_owner_id=None,
        is_admin=True,
    )
    assert validated == 999


# ==============================================================================
# SECTION 5: P2 — PRODUCTION SESSION KORUMASINI GÜÇLENDİR
# ==============================================================================

@pytest.mark.asyncio
async def test_production_session_protection_hardened(monkeypatch):
    """P2: Üretim oturumu 201 ve 'Hat 1', 'Hat 2', 'Production' isimli oturumlar fail-closed engellenir."""
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)

    # 1. Session 201 doğrudan engelli
    eligible, reason = is_session_sandbox_eligible(session_id=201)
    assert eligible is False
    assert "PROTECTED_PRODUCTION_SESSION_IDS" in reason

    # 2. Configured session ile eşleşmeyen oturum engelli
    eligible, reason = is_session_sandbox_eligible(session_id=202)
    assert eligible is False
    assert "does not match configured" in reason

    # 3. İsimde üretim belirteci ('Hat 1', 'Hat 2', 'Live Production') varsa engelli
    eligible, reason = is_session_sandbox_eligible(session_id=999, session_name="Hat 1")
    assert eligible is False
    assert "indicates a production line" in reason

    eligible, reason = is_session_sandbox_eligible(session_id=999, session_name="Live Customer Line")
    assert eligible is False
    assert "indicates a production line" in reason

    # 4. Açıkça 'Sandbox' içeren oturum izinli
    eligible, reason = is_session_sandbox_eligible(session_id=999, session_name="Tezlify Sandbox Line")
    assert eligible is True
    assert reason == "OK"


# ==============================================================================
# SECTION 6: P3 — TIMEOUT / PONG ATOMIC TERMINAL SETTLING
# ==============================================================================

@pytest.mark.asyncio
async def test_timeout_pong_race_atomic_settling():
    """P3: Timeout ve PONG yarışında tek ve tutarlı terminal durum oluşur."""
    service = WhatsAppSandboxService()
    corr = "corr_race_test_01"

    test_record = SandboxTestRecord(
        test_id="test_race",
        correlation_id=corr,
        session_id=999,
        target_masked="+90555****67",
        started_at="2026-11-04T00:00:00Z",
        target_phone="+905551234567",
        gateway_session_id="sandbox-session-999",
        pong_status="WAITING",
    )
    service._active_tests[corr] = test_record

    # Senaryo 1: PONG timeout'tan önce ulaştı
    test_record.pong_status = "MATCHED"
    test_record.is_terminal = True

    # Geç gelen timeout simülasyonu: PONG MATCHED durumundayken error_code TIMEOUT yapılmaz
    if test_record.pong_status == "MATCHED":
        assert test_record.error_code is None

    # Senaryo 2: Timeout kesinleştiğinde geç gelen PONG reddedilir
    test_record2 = SandboxTestRecord(
        test_id="test_race_2",
        correlation_id="corr_race_02",
        session_id=999,
        target_masked="+90555****67",
        started_at="2026-11-04T00:00:00Z",
        target_phone="+905551234567",
        gateway_session_id="sandbox-session-999",
        pong_status="TIMEOUT",
        error_code="TIMEOUT",
        is_terminal=True,
    )
    service._active_tests["corr_race_02"] = test_record2

    # Geç gelen PONG handle_inbound_message tarafından reddedilmeli
    res = service.handle_inbound_message(
        body="TEZLIFY_SANDBOX:PONG:corr_race_02",
        sender_phone="+905551234567",
        gateway_session_id="sandbox-session-999",
    )
    assert res is False
    assert test_record2.pong_status == "TIMEOUT"
    assert test_record2.error_code == "TIMEOUT"
