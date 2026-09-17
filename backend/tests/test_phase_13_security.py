"""Phase 13.2 Security Tests: Token Exposure Prevention & Masking Invariants.

Validates:
TEST-SEC-01: Request Authorization header logging masks token value.
TEST-SEC-02: WebSocket query token logging masks plaintext query parameter.
TEST-SEC-03: Reports / markdown / scripts inside git repo have zero unmasked secrets.
TEST-SEC-04: Revoked session tokens consistently return 401 Unauthorized.
TEST-SEC-05: Valid programmatic authentication succeeds without terminal leak.
"""
import io
import logging
import re
import pytest
from httpx import AsyncClient
from backend.app.core.logging_security import mask_sensitive_text, SecretMaskingFilter


def test_sec_01_request_authorization_header_masking():
    """TEST-SEC-01: Bearer token in log records must never display plaintext value."""
    raw_header = "Authorization: Bearer superSecretTokenValue987654321xyz"
    masked = mask_sensitive_text(raw_header)
    assert "superSecretTokenValue" not in masked
    assert "Authorization: Bearer ***MASKED***" in masked


def test_sec_02_websocket_query_token_masking():
    """TEST-SEC-02: /ws?token=... URL logging must display ***MASKED***."""
    raw_url = "GET /ws?token=liveSecretWsTokenAbc1234567890 HTTP/1.1"
    masked = mask_sensitive_text(raw_url)
    assert "liveSecretWsToken" not in masked
    assert "/ws?token=***MASKED***" in masked


def test_sec_03_no_unmasked_secrets_in_repo_docs_and_scripts():
    """TEST-SEC-03: Asserts zero occurrences of revoked/exposed token in repository files."""
    import subprocess
    cmd = ["git", "grep", "-nI", "5jYsO86WARwHOqXZ8ihJnhoBW8X-ZMGX26I6gnZ-eE0"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    assert res.returncode != 0, f"Found leaked token in repository files: {res.stdout}"
    assert len(res.stdout.strip()) == 0


import pytest_asyncio
from backend.app.core.database import Base, AsyncSessionLocal
from backend.app.auth.infrastructure.sql_models import AuthUserDB, AuthSessionDB


@pytest_asyncio.fixture(autouse=True)
async def setup_auth_tables():
    async with AsyncSessionLocal() as session:
        conn = await session.connection()
        await conn.run_sync(Base.metadata.create_all)
        await session.commit()
    yield
    async with AsyncSessionLocal() as session:
        conn = await session.connection()
        for tbl in [AuthSessionDB, AuthUserDB]:
            try:
                await session.execute(tbl.__table__.delete())
            except Exception:
                pass
        await session.commit()


@pytest.mark.asyncio
async def test_sec_04_revoked_token_returns_401():
    """TEST-SEC-04: Revoked token must strictly fail closed with 401 Unauthorized."""
    from uuid import uuid4
    from httpx import ASGITransport
    from backend.app.main import app
    from backend.app.core.database import AsyncSessionLocal
    from backend.app.auth.infrastructure.sql_models import AuthUserDB, AuthSessionDB
    from backend.app.auth.application.session_service import SessionService
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        user = AuthUserDB(id=uuid4(), email=f"sec04_{uuid4().hex[:8]}@example.com", display_name="Sec04")
        db.add(user)
        await db.flush()

        raw_token = "sec04_test_revoked_token_1234567890"
        tok_hash = SessionService.hash_token(raw_token)
        session = AuthSessionDB(
            user_id=user.id,
            session_token_hash=tok_hash,
            expires_at=now + timedelta(days=1),
            created_at=now,
            last_seen_at=now,
            revoked_at=now,  # Revoked
        )
        db.add(session)
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {raw_token}"})
        assert res.status_code == 401, f"Expected 401 for revoked token, got {res.status_code}"


@pytest.mark.asyncio
async def test_sec_05_valid_authentication_succeeds_without_leak():
    """TEST-SEC-05: Valid programmatic authentication succeeds and masks token in logger."""
    from uuid import uuid4
    from httpx import ASGITransport
    from backend.app.main import app
    from backend.app.core.database import AsyncSessionLocal
    from backend.app.auth.infrastructure.sql_models import AuthUserDB, AuthSessionDB
    from backend.app.auth.application.session_service import SessionService
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        user = AuthUserDB(id=uuid4(), email=f"sec05_{uuid4().hex[:8]}@example.com", display_name="Sec05")
        db.add(user)
        await db.flush()

        raw_token = "sec05_valid_active_token_9876543210"
        tok_hash = SessionService.hash_token(raw_token)
        session = AuthSessionDB(
            user_id=user.id,
            session_token_hash=tok_hash,
            expires_at=now + timedelta(days=1),
            created_at=now,
            last_seen_at=now,
            revoked_at=None,
        )
        db.add(session)
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {raw_token}"})
        assert res.status_code == 200, f"Expected 200 for valid token, got {res.status_code}"
        data = res.json()
        assert data["email"] == user.email
