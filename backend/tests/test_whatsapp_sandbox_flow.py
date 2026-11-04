"""Tests for WhatsApp Sandbox Ping/Pong Flow, Correlation & Verification (Phase 8.0.1).

Verifies the controlled Ping/Pong lifecycle, delivery receipts, correlation matching,
rate limiting, timeout handling, error reporting, and DB pollution prevention.
"""

import asyncio
import time
import pytest
from unittest.mock import AsyncMock, MagicMock

from backend.app.services.whatsapp.sandbox import (
    DuplicateCorrelationIdError,
    ProductionSessionBlockedError,
    SandboxDisabledError,
    SandboxRateLimitExceededError,
    SandboxTargetNotAllowedError,
    WhatsAppSandboxService,
    mask_phone_number,
)


@pytest.mark.asyncio
async def test_ping_message_format_and_parsing():
    """PING mesajı TEZLIFY_SANDBOX prefix'i ve correlation ID içerir."""
    service = WhatsAppSandboxService()
    corr_id = service.generate_correlation_id()
    assert corr_id.startswith("TEZLIFY_SANDBOX:")

    ts = 1793820000000
    ping_body = service.build_ping_body(corr_id, timestamp_ms=ts)
    assert ping_body == f"TEZLIFY_SANDBOX:PING:{corr_id}:{ts}"
    assert service.is_sandbox_message(ping_body) is True

    parsed_ping = service.parse_sandbox_message(ping_body)
    assert parsed_ping is not None
    assert parsed_ping["type"] == "PING"
    assert parsed_ping["correlation_id"] == corr_id
    assert parsed_ping["timestamp_ms"] == ts

    pong_body = service.build_pong_body(corr_id)
    assert pong_body == f"TEZLIFY_SANDBOX:PONG:{corr_id}"
    assert service.is_sandbox_message(pong_body) is True

    parsed_pong = service.parse_sandbox_message(pong_body)
    assert parsed_pong is not None
    assert parsed_pong["type"] == "PONG"
    assert parsed_pong["correlation_id"] == corr_id

    # Normal mesajlar sandbox olarak algılanmaz
    assert service.is_sandbox_message("Merhaba, nasılsınız?") is False
    assert service.parse_sandbox_message("Merhaba") is None


@pytest.mark.asyncio
async def test_duplicate_correlation_id_rejected():
    """Aynı correlation ID yeniden kullanılamaz (idempotency / dedup)."""
    service = WhatsAppSandboxService()
    corr_id = "TEZLIFY_SANDBOX:test_dedup_01"

    service.register_correlation_id(corr_id)
    with pytest.raises(DuplicateCorrelationIdError) as exc_info:
        service.register_correlation_id(corr_id)
    assert "already been used" in str(exc_info.value)


@pytest.mark.asyncio
async def test_rate_limit_enforcement(monkeypatch):
    """Azami test mesajı sınırı (WHATSAPP_SANDBOX_MAX_MESSAGES) aşıldığında istek reddedilir."""
    service = WhatsAppSandboxService()
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_MAX_MESSAGES", 3)

    # 3 gönderim kaydedelim
    now = time.monotonic()
    service._dispatch_timestamps.append(now - 10)
    service._dispatch_timestamps.append(now - 5)
    service._dispatch_timestamps.append(now - 1)

    with pytest.raises(SandboxRateLimitExceededError) as exc_info:
        service.check_rate_limit()
    assert "maximum 3 messages" in str(exc_info.value)


@pytest.mark.asyncio
async def test_successful_ping_pong_flow_with_mock_gateway(monkeypatch):
    """Başarılı tam akış: Gönderim -> Delivery Receipt -> PONG eşleşmesi -> Başarılı Sonuç."""
    service = WhatsAppSandboxService()
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    fake_wa_id = "3EB0MOCK12345678"
    mock_gw = AsyncMock()
    mock_gw.send_text_message.return_value = {
        "wa_message_id": fake_wa_id,
        "status": "PENDING",
        "client_message_id": "test-cid",
    }

    # Asenkron olarak teslimat raporu ve PONG mesajı simüle edelim
    async def simulate_incoming_responses(corr_id):
        await asyncio.sleep(0.05)
        # 1. Delivery Receipt
        service.handle_status_or_receipt(fake_wa_id, "DELIVERED")
        await asyncio.sleep(0.05)
        # 2. Inbound PONG
        pong = service.build_pong_body(corr_id)
        service.handle_inbound_message(pong, "+905551234567")

    corr = "TEZLIFY_SANDBOX:flow_success_01"
    sim_task = asyncio.create_task(simulate_incoming_responses(corr))

    res = await service.run_ping_pong_test(
        target_phone="+905551234567",
        session_id=999,
        correlation_id=corr,
        timeout_ms=5000,
        gateway_client=mock_gw,
        user_id="user_test_01",
        session_owner_id="user_test_01",
        is_admin=True,
    )
    await sim_task

    assert res["correlation_id"] == corr
    assert res["session_id"] == 999
    assert res["send_status"] == "SENT"
    assert res["delivery_status"] == "DELIVERED"
    assert res["pong_status"] == "MATCHED"
    assert res["error_code"] is None
    assert res["duration_ms"] is not None
    assert res["duration_ms"] > 0
    assert res["target_masked"] == "+90555****67"

    # History kaydı doğrulaması
    history_user = service.get_results_history(user_id="user_test_01")
    assert len(history_user) == 1
    assert history_user[0]["correlation_id"] == corr
    history_admin = service.get_results_history(is_admin=True)
    assert len(history_admin) >= 1


@pytest.mark.asyncio
async def test_ping_timeout_when_no_pong_arrives(monkeypatch):
    """PONG veya teslimat gelmediğinde süre aşımı (TIMEOUT) yapılandırılmış şekilde kaydedilir."""
    service = WhatsAppSandboxService()
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    mock_gw = AsyncMock()
    mock_gw.send_text_message.return_value = {
        "wa_message_id": "3EB0TIMEOUTMSG",
        "status": "PENDING",
    }

    corr = "TEZLIFY_SANDBOX:timeout_test_01"
    # 200 ms timeout ile çalıştıralım
    res = await service.run_ping_pong_test(
        target_phone="+905551234567",
        session_id=999,
        correlation_id=corr,
        timeout_ms=200,
        gateway_client=mock_gw,
    )

    assert res["correlation_id"] == corr
    assert res["send_status"] == "SENT"
    assert res["delivery_status"] == "TIMEOUT"
    assert res["pong_status"] == "TIMEOUT"
    assert res["error_code"] == "TIMEOUT"
    assert "timed out" in res["error_detail"].lower()


@pytest.mark.asyncio
async def test_gateway_dispatch_failure(monkeypatch):
    """Gateway HTTP hatası aldığında FAILED olarak işaretlenir ve sistem çökmez."""
    service = WhatsAppSandboxService()
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    mock_gw = AsyncMock()
    mock_gw.send_text_message.side_effect = RuntimeError("502 Bad Gateway: Gateway daemon unreachable")

    corr = "TEZLIFY_SANDBOX:gw_fail_01"
    res = await service.run_ping_pong_test(
        target_phone="+905551234567",
        session_id=999,
        correlation_id=corr,
        timeout_ms=2000,
        gateway_client=mock_gw,
    )

    assert res["send_status"] == "FAILED"
    assert res["delivery_status"] == "SKIPPED"
    assert res["pong_status"] == "SKIPPED"
    assert res["error_code"] == "GATEWAY_ERROR"
    assert "502 Bad Gateway" in res["error_detail"]


@pytest.mark.asyncio
async def test_mismatched_and_late_pong_handling():
    """Bilinmeyen veya geç gelen PONG mesajları servisi çökertmez (graceful ignore)."""
    service = WhatsAppSandboxService()

    # Aktif test yokken gelen PONG False döner
    assert service.handle_inbound_message("TEZLIFY_SANDBOX:PONG:unknown_corr", "+905551234567") is False

    # Yanlış format False döner
    assert service.handle_inbound_message("INVALID_MESSAGE_BODY", "+905551234567") is False


@pytest.mark.asyncio
async def test_delivery_receipt_idempotence(monkeypatch):
    """Tekrarlanan receipt mesajları güvenle güncellenir ve çökme oluşturmaz."""
    service = WhatsAppSandboxService()
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    fake_wa_id = "3EB0IDEMPOTENT"
    corr = "TEZLIFY_SANDBOX:idempotent_test"

    # Manuel aktif test kaydı
    record = service.run_ping_pong_test  # referans
    service._wa_id_to_corr[fake_wa_id] = corr
    from backend.app.services.whatsapp.sandbox import SandboxTestRecord
    service._active_tests[corr] = SandboxTestRecord(
        test_id="test_idemp",
        correlation_id=corr,
        session_id=999,
        target_masked="+90555****67",
        started_at="2026-11-04T00:00:00Z",
    )

    assert service.handle_status_or_receipt(fake_wa_id, "DELIVERED") is True
    assert service._active_tests[corr].delivery_status == "DELIVERED"

    # Tekrar gelirse READ'e güncellenir
    assert service.handle_status_or_receipt(fake_wa_id, "READ") is True
    assert service._active_tests[corr].delivery_status == "READ"


@pytest.mark.asyncio
async def test_event_ingestion_intercepts_sandbox_messages_without_db_write(monkeypatch):
    """events.py içindeki _ingest_message kancası geçerli sandbox PONG mesajlarını yakalar ve DB'ye yazmaz."""
    from backend.app.services.whatsapp.orchestration.events import WhatsAppEventOrchestrator
    from backend.app.services.whatsapp.sandbox import SandboxTestRecord, sandbox_service

    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )

    corr = "corr_hook_test"
    sandbox_service._active_tests[corr] = SandboxTestRecord(
        test_id="test_hook",
        correlation_id=corr,
        session_id=999,
        target_masked="+90555****67",
        started_at="2026-11-04T00:00:00Z",
        target_phone="+905551234567",
        gateway_session_id="sandbox-session-999",
    )

    handler = WhatsAppEventOrchestrator()
    db_mock = AsyncMock()

    sandbox_body = f"TEZLIFY_SANDBOX:PONG:{corr}"
    event = {
        "event": "message_new",
        "gateway_session_id": "sandbox-session-999",
        "conversation_id": "905551234567@s.whatsapp.net",
        "message": {
            "conversation_id": "905551234567@s.whatsapp.net",
            "body": sandbox_body,
            "direction": "INBOUND",
        },
    }

    try:
        # _ingest_message çağrıldığında
        res = await handler._ingest_message(db_mock, event)

        # Atlanmış (_skip) dönmeli ve veritabanına sorgu/yazım yapılmamalı
        assert "_skip" in res
        assert "sandbox ping/pong consumed safely without db mutation" in res["_skip"]
        assert db_mock.execute.call_count == 0
        assert db_mock.commit.call_count == 0
    finally:
        sandbox_service._active_tests.pop(corr, None)
