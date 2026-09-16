"""Comprehensive security and sensitive data leakage tests for the Admin API.

Invariants:
- Zero credential, secret, password, private key, token, or session leak in any response.
- Recursive key and value inspection across all 6 admin endpoint responses.
- Phone numbers must be masked; raw E.164 phone numbers must not appear.
- Dead-letter message bodies and outbox payloads must never be returned.
"""

import re
import pytest
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.config import settings

FORBIDDEN_KEY_PATTERNS = [
    r"^password$",
    r".*_password$",
    r"db_password",
    r"secret",
    r"private_key",
    r"credential",
    r"auth_state",
    r"signal_key",
    r"ciphertext",
    r"salt",
    r"^body$",
    r"message_body",
    r"media_content",
]

FORBIDDEN_VALUE_PATTERNS = [
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"postgresql(\+asyncpg)?://[^:]+:[^@]+@",
    r"ey[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}",  # JWT signature pattern
    r"\+?905[0-9]{9}\b",  # Raw Turkish E.164 without masking
]

ADMIN_ENDPOINTS = [
    "/api/v1/admin/overview",
    "/api/v1/admin/whatsapp",
    "/api/v1/admin/monitoring",
    "/api/v1/admin/backups",
    "/api/v1/admin/deployment",
    "/api/v1/admin/security",
]


def _inspect_data_recursive(data, path=""):
    """Recursively validates that no sensitive key names or leaked secret values exist."""
    if isinstance(data, dict):
        for k, v in data.items():
            current_path = f"{path}.{k}" if path else str(k)
            # 1. Key name check
            k_lower = str(k).lower()
            for pattern in FORBIDDEN_KEY_PATTERNS:
                assert not re.search(pattern, k_lower), (
                    f"Forbidden key '{k}' matched pattern '{pattern}' at {current_path}"
                )
            _inspect_data_recursive(v, current_path)
    elif isinstance(data, list):
        for idx, item in enumerate(data):
            _inspect_data_recursive(item, f"{path}[{idx}]")
    elif isinstance(data, str):
        # 2. String value regex checks
        for pattern in FORBIDDEN_VALUE_PATTERNS:
            assert not re.search(pattern, data), (
                f"Value at {path} matched forbidden pattern '{pattern}': {data[:40]}..."
            )


@pytest.mark.asyncio
async def test_admin_endpoints_zero_sensitive_data_leakage(monkeypatch):
    """Recursively validates that all 6 admin endpoints have zero sensitive data leakage."""
    monkeypatch.setattr(settings, "ADMIN_EMAILS", ["admin@tezlify.com"])

    transport = ASGITransport(app=app)
    headers = {
        "X-Test-User-Id": "admin-id",
        "X-Test-User-Email": "admin@tezlify.com",
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        for ep in ADMIN_ENDPOINTS:
            res = await ac.get(ep, headers=headers)
            assert res.status_code == 200, f"Endpoint {ep} returned {res.status_code}: {res.text}"
            data = res.json()
            assert isinstance(data, dict), f"Expected dict response from {ep}"
            _inspect_data_recursive(data, path=ep)


@pytest.mark.asyncio
async def test_admin_whatsapp_phone_number_masking():
    """Verifies that phone numbers in sessions list are properly masked."""
    from backend.app.services.admin.whatsapp_admin_service import mask_phone_number

    assert mask_phone_number(None) is None
    assert mask_phone_number("") is None
    assert mask_phone_number("123") == "***"
    
    masked = mask_phone_number("+905521234567")
    assert masked is not None
    assert masked.startswith("+90552")
    assert masked.endswith("67")
    assert "***" in masked
    assert "12345" not in masked  # Middle digits masked
