"""Tests for WhatsApp Sandbox Configuration & Security Guards (Phase 8.0.1).

Verifies fail-closed configuration parsing, production session 201 blocking,
allowlist enforcement, tenant isolation, and PII masking.
"""

import pytest
from unittest.mock import MagicMock
from backend.app.core.config import Settings
from backend.app.services.whatsapp.sandbox import (
    PROTECTED_PRODUCTION_SESSION_IDS,
    ProductionSessionBlockedError,
    SandboxDisabledError,
    SandboxRateLimitExceededError,
    SandboxSessionNotConfiguredError,
    SandboxTargetNotAllowedError,
    WhatsAppSandboxError,
    WhatsAppSandboxService,
    mask_phone_number,
    normalize_target_phone,
)


def test_sandbox_default_configuration_is_disabled():
    """Varsayılan Settings nesnesinde Sandbox kesinlikle KAPALIDIR (fail-closed)."""
    cfg = Settings(
        WHATSAPP_SANDBOX_ENABLED=False,
        WHATSAPP_SANDBOX_SESSION_ID=None,
        WHATSAPP_SANDBOX_ALLOWED_TARGETS=[],
    )
    assert cfg.WHATSAPP_SANDBOX_ENABLED is False
    assert cfg.WHATSAPP_SANDBOX_SESSION_ID is None
    assert cfg.WHATSAPP_SANDBOX_ALLOWED_TARGETS == []
    assert cfg.WHATSAPP_SANDBOX_MAX_MESSAGES == 10
    assert cfg.WHATSAPP_SANDBOX_TIMEOUT_MS == 15000


@pytest.mark.parametrize(
    "val,expected",
    [
        (True, True),
        ("true", True),
        ("1", True),
        ("TRUE", True),
        (False, False),
        ("false", False),
        ("0", False),
        ("FALSE", False),
        ("yes", False),  # Fail-closed: 'yes' is not accepted
        ("on", False),   # Fail-closed: 'on' is not accepted
        ("random_junk", False),
        (None, False),
        ("", False),
    ],
)
def test_sandbox_enabled_fail_closed_parsing(val, expected):
    """Yalnızca açık 'true' veya '1' sandbox'ı açar; tüm belirsiz değerler False olur."""
    cfg = Settings(WHATSAPP_SANDBOX_ENABLED=val)
    assert cfg.WHATSAPP_SANDBOX_ENABLED is expected


@pytest.mark.parametrize(
    "raw_input,expected",
    [
        (None, []),
        ("", []),
        ("+905551112233", ["+905551112233"]),
        ("+905551112233, +905554445566", ["+905551112233", "+905554445566"]),
        ('["+905551112233", "+905554445566"]', ["+905551112233", "+905554445566"]),
        (["+905551112233", "+905554445566"], ["+905551112233", "+905554445566"]),
    ],
)
def test_sandbox_allowed_targets_parsing(raw_input, expected):
    """Allowlist string, JSON array veya liste olarak güvenle ayrıştırılır."""
    cfg = Settings(WHATSAPP_SANDBOX_ALLOWED_TARGETS=raw_input)
    assert cfg.WHATSAPP_SANDBOX_ALLOWED_TARGETS == expected


def test_sandbox_session_id_parsing():
    """Session ID tamsayıya dönüştürülür, geçersizler None olur."""
    assert Settings(WHATSAPP_SANDBOX_SESSION_ID=202).WHATSAPP_SANDBOX_SESSION_ID == 202
    assert Settings(WHATSAPP_SANDBOX_SESSION_ID="203").WHATSAPP_SANDBOX_SESSION_ID == 203
    assert Settings(WHATSAPP_SANDBOX_SESSION_ID="").WHATSAPP_SANDBOX_SESSION_ID is None
    assert Settings(WHATSAPP_SANDBOX_SESSION_ID="invalid").WHATSAPP_SANDBOX_SESSION_ID is None


def test_phone_masking_pii_protection():
    """Telefon numaraları loglarda ve raporlarda kesinlikle maskelenir."""
    assert mask_phone_number("+905413749073") == "+90541****73"
    assert mask_phone_number("905413749073") == "905413****73"
    assert mask_phone_number("1234") == "****"
    assert mask_phone_number(None) == "—"
    assert mask_phone_number("") == "—"


def test_normalize_target_phone():
    """Hedef numara standardizasyonu."""
    assert normalize_target_phone("+90 (541) 374 90 73") == "+905413749073"
    assert normalize_target_phone("905413749073@s.whatsapp.net") == "905413749073"
    assert normalize_target_phone("+905413749073@s.whatsapp.net") == "+905413749073"


def test_production_session_201_is_strictly_protected():
    """Üretim oturumu 201 sandbox için çağrıldığında anında engellenir."""
    assert 201 in PROTECTED_PRODUCTION_SESSION_IDS
    service = WhatsAppSandboxService()

    with pytest.raises(ProductionSessionBlockedError) as exc_info:
        service.validate_session(201)
    assert "strictly protected" in str(exc_info.value)


def test_session_validation_without_configuration():
    """Hiçbir session belirtilmediğinde SandboxSessionNotConfiguredError fırlatır."""
    service = WhatsAppSandboxService()
    with pytest.raises(SandboxSessionNotConfiguredError):
        service.validate_session(None)


def test_tenant_isolation_mismatch():
    """Kiracı ID'si uyuşmadığında güvenlik hatası fırlatır."""
    service = WhatsAppSandboxService()
    with pytest.raises(WhatsAppSandboxError) as exc_info:
        service.validate_session(
            session_id=999,
            user_id="user-tenant-a",
            session_owner_id="user-tenant-b",
        )
    assert "Tenant/session" in str(exc_info.value)


def test_allowlist_empty_fails_closed(monkeypatch):
    """Allowlist boş olduğunda hiçbir hedefe izin verilmez (fail-closed)."""
    service = WhatsAppSandboxService()
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS", [])

    with pytest.raises(SandboxTargetNotAllowedError) as exc_info:
        service.validate_target_allowed("+905551234567")
    assert "empty" in str(exc_info.value).lower()


def test_allowlist_non_listed_target_rejected(monkeypatch):
    """Allowlist dışındaki numara engellenir ve hata mesajında PII maskelenir."""
    service = WhatsAppSandboxService()
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551112233"],
    )

    with pytest.raises(SandboxTargetNotAllowedError) as exc_info:
        service.validate_target_allowed("+905559998877")
    # Maskelenmiş olmalı, tam numara geçmemeli
    assert "+905559998877" not in str(exc_info.value)
    assert "+90555****77" in str(exc_info.value)


def test_can_execute_live_checks(monkeypatch):
    """can_execute_live tüm ön koşulları doğru sırayla denetler."""
    service = WhatsAppSandboxService()

    # 1. Sandbox kapalı
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", False)
    can_exec, code, _ = service.can_execute_live()
    assert can_exec is False
    assert "DISABLED" in code

    # 2. Açık ama session yok
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ENABLED", True)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", None)
    can_exec, code, _ = service.can_execute_live()
    assert can_exec is False
    assert "NO SESSION" in code

    # 3. Açık ama production session 201 seçilmiş
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 201)
    can_exec, code, _ = service.can_execute_live()
    assert can_exec is False
    assert "PRODUCTION SESSION" in code

    # 4. Geçerli test session (999) ama allowlist boş
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_SESSION_ID", 999)
    monkeypatch.setattr("backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS", [])
    can_exec, code, _ = service.can_execute_live()
    assert can_exec is False
    assert code == "BLOCKED: SANDBOX NUMBER NOT CONFIGURED"

    # 5. Her şey tam ve hazır
    monkeypatch.setattr(
        "backend.app.services.whatsapp.sandbox.settings.WHATSAPP_SANDBOX_ALLOWED_TARGETS",
        ["+905551234567"],
    )
    can_exec, code, reason = service.can_execute_live()
    assert can_exec is True
    assert code == "READY"
