import time
import pytest
import pytest_asyncio
from datetime import datetime, timedelta
from uuid import uuid4
import jwt
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.database import Base, AsyncSessionLocal
from backend.app.auth.domain.exceptions import (
    InvalidOAuthStateException,
    InvalidIdentityException,
    OAuthTokenExchangeException,
)
from backend.app.auth.infrastructure.sql_models import (
    AuthUserDB,
    OAuthAccountDB,
    AuthSessionDB,
    OAuthStateDB,
)
from backend.app.auth.infrastructure.google_provider import GoogleOAuthProvider
from backend.app.auth.application.session_service import SessionService
from backend.app.auth.application.user_service import UserService
from backend.app.auth.application.oauth_service import OAuthService


TEST_CLIENT_ID = "test-google-client-id"
TEST_CLIENT_SECRET = "test-google-client-secret"
TEST_REDIRECT_URI = "https://api.test/api/v1/auth/google/callback"


def create_mock_id_token(
    sub="google-12345",
    email="testuser@gmail.com",
    name="Test User",
    picture="https://avatar.com/u.jpg",
    iss="https://accounts.google.com",
    aud=TEST_CLIENT_ID,
    exp_delta_seconds=3600,
):
    now = int(time.time())
    payload = {
        "iss": iss,
        "aud": aud,
        "sub": sub,
        "email": email,
        "name": name,
        "picture": picture,
        "email_verified": True,
        "iat": now,
        "exp": now + exp_delta_seconds,
    }
    return jwt.encode(payload, "secret-dummy-32-bytes-long-signature-key-ok", algorithm="HS256")


@pytest_asyncio.fixture(autouse=True)
async def setup_auth_tables():
    async with AsyncSessionLocal() as session:
        conn = await session.connection()
        await conn.run_sync(Base.metadata.create_all)
        await session.commit()
    yield
    async with AsyncSessionLocal() as session:
        conn = await session.connection()
        # Clean up staging auth tables
        for tbl in [OAuthStateDB, AuthSessionDB, OAuthAccountDB, AuthUserDB]:
            try:
                await session.execute(tbl.__table__.delete())
            except Exception:
                pass
        await session.commit()


@pytest.fixture
def mock_google_provider():
    return GoogleOAuthProvider(
        client_id=TEST_CLIENT_ID,
        client_secret=TEST_CLIENT_SECRET,
        redirect_uri=TEST_REDIRECT_URI,
    )


@pytest.fixture
def auth_services(mock_google_provider):
    u_svc = UserService()
    s_svc = SessionService()
    o_svc = OAuthService(mock_google_provider, u_svc, s_svc)
    return {
        "user_service": u_svc,
        "session_service": s_svc,
        "oauth_service": o_svc,
        "google_provider": mock_google_provider,
    }


# ===========================================================================
# 16 CRITICAL SECURITY TEST SCENARIOS
# ===========================================================================

@pytest.mark.asyncio
async def test_01_login_success(setup_auth_tables, auth_services, monkeypatch):
    """Scenario 1: Happy path OAuth authorization and session creation."""
    o_svc = auth_services["oauth_service"]
    g_prov = auth_services["google_provider"]

    async with AsyncSessionLocal() as db:
        auth_url, state = await o_svc.initiate_google_flow(db)
        assert "state=" in auth_url

        mock_token = create_mock_id_token()
        async def mock_exchange(code):
            return {"access_token": "ya29.xyz", "id_token": mock_token}
        monkeypatch.setattr(g_prov, "exchange_code", mock_exchange)

        user, session, raw_token = await o_svc.handle_callback(db, code="auth-code-1", state=state)
        assert user.email == "testuser@gmail.com"
        assert session.user_id == user.id
        assert len(raw_token) > 20


@pytest.mark.asyncio
async def test_02_same_google_identity_twice(setup_auth_tables, auth_services, monkeypatch):
    """Scenario 2: Logging in with the same Google identity does not duplicate user."""
    o_svc = auth_services["oauth_service"]
    g_prov = auth_services["google_provider"]

    async with AsyncSessionLocal() as db:
        # First login
        _, state1 = await o_svc.initiate_google_flow(db)
        mock_token = create_mock_id_token(sub="google-persistent-id", email="same@gmail.com")
        async def mock_exchange(code):
            return {"access_token": "a", "id_token": mock_token}
        monkeypatch.setattr(g_prov, "exchange_code", mock_exchange)

        user1, _, _ = await o_svc.handle_callback(db, code="c1", state=state1)

        # Second login
        _, state2 = await o_svc.initiate_google_flow(db)
        user2, _, _ = await o_svc.handle_callback(db, code="c2", state=state2)

        assert user1.id == user2.id, "Same Google identity must map to identical User ID"


@pytest.mark.asyncio
async def test_03_duplicate_oauth_account_prevented(setup_auth_tables, auth_services):
    """Scenario 3: Unique constraint on (provider, provider_subject)."""
    u_svc = auth_services["user_service"]

    async with AsyncSessionLocal() as db:
        u1 = await u_svc.get_or_create_from_oauth(
            db, provider="google", provider_subject="sub-unique-1", email="u1@test.com"
        )
        # Calling again with same provider & subject returns same user
        u2 = await u_svc.get_or_create_from_oauth(
            db, provider="google", provider_subject="sub-unique-1", email="u1@test.com"
        )
        assert u1.id == u2.id


@pytest.mark.asyncio
async def test_04_state_mismatch(setup_auth_tables, auth_services):
    """Scenario 4: Tampered/forged OAuth state is rejected."""
    o_svc = auth_services["oauth_service"]

    async with AsyncSessionLocal() as db:
        await o_svc.initiate_google_flow(db)
        with pytest.raises(InvalidOAuthStateException):
            await o_svc.verify_and_consume_state(db, raw_state="forged-state-abc")


@pytest.mark.asyncio
async def test_05_state_replay_prevented(setup_auth_tables, auth_services):
    """Scenario 5: State can only be consumed once (anti-replay)."""
    o_svc = auth_services["oauth_service"]

    async with AsyncSessionLocal() as db:
        _, state = await o_svc.initiate_google_flow(db)
        assert await o_svc.verify_and_consume_state(db, state) is True

        # Second attempt with same state must raise exception
        with pytest.raises(InvalidOAuthStateException, match="already been consumed"):
            await o_svc.verify_and_consume_state(db, state)


@pytest.mark.asyncio
async def test_06_expired_state_rejected(setup_auth_tables, auth_services):
    """Scenario 6: Expired state is rejected."""
    o_svc = auth_services["oauth_service"]

    async with AsyncSessionLocal() as db:
        raw_state = "expired-state-test"
        state_hash = o_svc.hash_state(raw_state)
        # Manually create state expired 1 minute ago
        db_state = OAuthStateDB(
            state_hash=state_hash,
            expires_at=datetime.utcnow() - timedelta(minutes=1),
            created_at=datetime.utcnow() - timedelta(minutes=11),
        )
        db.add(db_state)
        await db.commit()

        with pytest.raises(InvalidOAuthStateException, match="expired"):
            await o_svc.verify_and_consume_state(db, raw_state)


@pytest.mark.asyncio
async def test_07_invalid_callback_code(setup_auth_tables, auth_services, monkeypatch):
    """Scenario 7: Google rejects authorization code."""
    o_svc = auth_services["oauth_service"]
    g_prov = auth_services["google_provider"]

    async with AsyncSessionLocal() as db:
        _, state = await o_svc.initiate_google_flow(db)

        async def fail_exchange(code):
            raise OAuthTokenExchangeException("Google 400 invalid_grant")
        monkeypatch.setattr(g_prov, "exchange_code", fail_exchange)

        with pytest.raises(OAuthTokenExchangeException):
            await o_svc.handle_callback(db, code="bad-code", state=state)


@pytest.mark.asyncio
async def test_08_invalid_issuer(auth_services):
    """Scenario 8: Token from unexpected issuer is rejected."""
    g_prov = auth_services["google_provider"]
    forged_token = create_mock_id_token(iss="https://attacker-idp.com")

    with pytest.raises(InvalidIdentityException, match="issuer"):
        g_prov.verify_and_extract_identity(forged_token)


@pytest.mark.asyncio
async def test_09_invalid_audience(auth_services):
    """Scenario 9: Token minted for another app (aud mismatch) is rejected."""
    g_prov = auth_services["google_provider"]
    forged_token = create_mock_id_token(aud="attacker-app-client-id")

    with pytest.raises(InvalidIdentityException, match="audience"):
        g_prov.verify_and_extract_identity(forged_token)


@pytest.mark.asyncio
async def test_10_expired_google_identity(auth_services):
    """Scenario 10: Expired Google ID token is rejected."""
    g_prov = auth_services["google_provider"]
    expired_token = create_mock_id_token(exp_delta_seconds=-60)

    with pytest.raises(InvalidIdentityException, match="expired"):
        g_prov.verify_and_extract_identity(expired_token)


@pytest.mark.asyncio
async def test_11_missing_session_rejected(setup_auth_tables):
    """Scenario 11: Request without session returns 401."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/v1/auth/me")
        assert resp.status_code == 401


@pytest.mark.asyncio
async def test_12_expired_session_rejected(setup_auth_tables, auth_services):
    """Scenario 12: Expired native session returns 401."""
    s_svc = auth_services["session_service"]

    async with AsyncSessionLocal() as db:
        user = AuthUserDB(email="exp@test.com")
        db.add(user)
        await db.flush()

        session, raw_token = await s_svc.create_session(db, user.id, ttl_days=-1)
        await db.commit()

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {raw_token}"})
            assert resp.status_code == 401


@pytest.mark.asyncio
async def test_13_revoked_session_rejected(setup_auth_tables, auth_services):
    """Scenario 13: Revoked session returns 401."""
    s_svc = auth_services["session_service"]

    async with AsyncSessionLocal() as db:
        user = AuthUserDB(email="rev@test.com")
        db.add(user)
        await db.flush()

        session, raw_token = await s_svc.create_session(db, user.id, ttl_days=7)
        await s_svc.revoke_session(db, raw_token)
        await db.commit()

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {raw_token}"})
            assert resp.status_code == 401


@pytest.mark.asyncio
async def test_14_logout_revocation(setup_auth_tables, auth_services):
    """Scenario 14: Calling /api/v1/auth/logout revokes session and clears cookie."""
    s_svc = auth_services["session_service"]

    async with AsyncSessionLocal() as db:
        user = AuthUserDB(email="logout@test.com")
        db.add(user)
        await db.flush()

        session, raw_token = await s_svc.create_session(db, user.id, ttl_days=7)
        await db.commit()

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            # Call logout
            resp = await ac.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {raw_token}"})
            assert resp.status_code == 200
            assert resp.json()["success"] is True

            # Subsequent request with same token must now fail
            resp2 = await ac.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {raw_token}"})
            assert resp2.status_code == 401


@pytest.mark.asyncio
async def test_15_session_fixation_prevention(setup_auth_tables, auth_services, monkeypatch):
    """Scenario 15: Each login generates a completely new random session token."""
    o_svc = auth_services["oauth_service"]
    g_prov = auth_services["google_provider"]

    async with AsyncSessionLocal() as db:
        mock_token = create_mock_id_token()
        async def mock_exchange(code):
            return {"access_token": "a", "id_token": mock_token}
        monkeypatch.setattr(g_prov, "exchange_code", mock_exchange)

        _, state1 = await o_svc.initiate_google_flow(db)
        _, _, token1 = await o_svc.handle_callback(db, "c1", state1)

        _, state2 = await o_svc.initiate_google_flow(db)
        _, _, token2 = await o_svc.handle_callback(db, "c2", state2)

        assert token1 != token2, "Session tokens must be uniquely generated per login"


@pytest.mark.asyncio
async def test_16_unauthorized_protected_endpoints(setup_auth_tables):
    """Scenario 16: Core protected endpoints reject requests with missing or forged tokens."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        endpoints = [
            "/api/v1/auth/me",
            "/api/v1/whatsapp/sessions",
            "/api/v1/campaigns",
        ]
        for ep in endpoints:
            res = await ac.get(ep, headers={"Authorization": "Bearer invalid-forged-token"})
            assert res.status_code == 401, f"{ep} did not enforce 401 on forged token"


@pytest.mark.asyncio
async def test_17_callback_redirects_to_oracle_origin(setup_auth_tables, auth_services, monkeypatch):
    """Scenario 17: OAuth callback redirect URL dynamically targets Oracle origin and never Vercel."""
    from backend.app.auth.api import routes as auth_routes
    mock_token = create_mock_id_token(aud=auth_routes.GOOGLE_CLIENT_ID)
    async def mock_exchange(code):
        return {"access_token": "a", "id_token": mock_token}
    monkeypatch.setattr(auth_routes.google_provider, "exchange_code", mock_exchange)

    async with AsyncSessionLocal() as db:
        _, state = await auth_routes.oauth_service.initiate_google_flow(db)
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="https://api.130.162.247.20.sslip.io") as ac:
        res = await ac.get(
            f"/api/v1/auth/google/callback?code=test-code&state={state}&redirect=true",
            headers={"Host": "api.130.162.247.20.sslip.io", "X-Forwarded-Proto": "https"},
            follow_redirects=False,
        )
        assert res.status_code == 302
        location = res.headers.get("location")
        assert location.startswith("https://api.130.162.247.20.sslip.io/")
        assert "vercel.app" not in location
        assert "session_token=" in location

