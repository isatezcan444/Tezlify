import asyncio
import time
import statistics
from uuid import uuid4
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.core.database import Base, AsyncSessionLocal
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
from backend.tests.test_oracle_native_auth import create_mock_id_token


async def run_benchmark(iterations: int = 100):
    run_id = uuid4().hex[:8]
    # 1. Setup DB and clean up any leftover benchmark rows
    async with AsyncSessionLocal() as session:
        conn = await session.connection()
        await conn.run_sync(Base.metadata.create_all)
        for tbl in [OAuthStateDB, AuthSessionDB, OAuthAccountDB, AuthUserDB]:
            try:
                await session.execute(tbl.__table__.delete())
            except Exception:
                pass
        await session.commit()

    u_svc = UserService()
    s_svc = SessionService()
    g_prov = GoogleOAuthProvider(
        client_id="bench-client-id",
        client_secret="bench-client-secret",
        redirect_uri="https://api.test/api/v1/auth/google/callback",
    )
    o_svc = OAuthService(g_prov, u_svc, s_svc)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        callback_latencies = []
        me_latencies = []
        session_lookup_latencies = []
        logout_latencies = []

        print(f"Running benchmark with {iterations} iterations...")

        for i in range(iterations):
            # Create a real test user and session for lookup
            async with AsyncSessionLocal() as db:
                db_user = AuthUserDB(email=f"bench_{run_id}_{i}@tezlify.com", display_name=f"Bench {i}")
                db.add(db_user)
                await db.flush()
                _, test_token = await s_svc.create_session(db, db_user.id, ttl_days=7)
                await db.commit()

            # Measure session lookup
            async with AsyncSessionLocal() as db:
                t0 = time.perf_counter()
                found = await s_svc.get_session_by_token(db, test_token)
                t1 = time.perf_counter()
                session_lookup_latencies.append((t1 - t0) * 1000.0)
                assert found is not None

            # B. Measure /me endpoint
            t0 = time.perf_counter()
            resp = await ac.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {test_token}"})
            t1 = time.perf_counter()
            me_latencies.append((t1 - t0) * 1000.0)
            assert resp.status_code == 200

            # C. Measure OAuth callback
            async with AsyncSessionLocal() as db:
                _, state = await o_svc.initiate_google_flow(db)
                await db.commit()

            mock_id = create_mock_id_token(
                aud="bench-client-id",
                sub=f"google-bench-{run_id}-{i}",
                email=f"oauth_bench_{run_id}_{i}@tezlify.com",
                name=f"OAuth Bench {i}",
            )
            async def mock_ex(code):
                return {"access_token": "mock", "id_token": mock_id}
            g_prov.exchange_code = mock_ex

            async with AsyncSessionLocal() as db:
                t0 = time.perf_counter()
                _, _, cb_token = await o_svc.handle_callback(db, code=f"code-{i}", state=state)
                await db.commit()
                t1 = time.perf_counter()
                callback_latencies.append((t1 - t0) * 1000.0)

            # D. Measure Logout
            t0 = time.perf_counter()
            logout_resp = await ac.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {cb_token}"})
            t1 = time.perf_counter()
            logout_latencies.append((t1 - t0) * 1000.0)
            assert logout_resp.status_code == 200

        # Cleanup
        async with AsyncSessionLocal() as db:
            for tbl in [OAuthStateDB, AuthSessionDB, OAuthAccountDB, AuthUserDB]:
                try:
                    await db.execute(tbl.__table__.delete())
                except Exception:
                    pass
            await db.commit()

        def compute_stats(name, data):
            s_data = sorted(data)
            n = len(s_data)
            med = statistics.median(s_data)
            p95 = s_data[int(0.95 * n)]
            p99 = s_data[int(0.99 * n)]
            avg = statistics.mean(s_data)
            print(f"| {name:<18} | {med:6.2f} ms | {p95:6.2f} ms | {p99:6.2f} ms | {avg:6.2f} ms |")
            return {"median": med, "p95": p95, "p99": p99, "mean": avg}

        print("\n=======================================================")
        print("ORACLE NATIVE AUTH LOCAL POSTGRESQL BENCHMARK (N = 100)")
        print("=======================================================")
        print(f"| {'Operation':<18} | {'Median':<9} | {'p95':<9} | {'p99':<9} | {'Mean':<9} |")
        print("|--------------------|-----------|-----------|-----------|-----------|")
        compute_stats("Session Lookup", session_lookup_latencies)
        compute_stats("/me Endpoint", me_latencies)
        compute_stats("OAuth Callback", callback_latencies)
        compute_stats("Logout", logout_latencies)
        print("=======================================================\n")


if __name__ == "__main__":
    asyncio.run(run_benchmark(100))
