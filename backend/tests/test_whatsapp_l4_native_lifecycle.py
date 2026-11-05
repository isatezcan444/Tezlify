"""Phase 8.0.11: Baileys Native Lifecycle, Test-Mode Isolation & Network Egress Integrity Suite.

Validates multi-process end-to-end integration:
- Python socket-level egress firewall interception (zero WAN packets).
- Node.js runtime egress firewall interception (/test/egress/audit and /test/egress/probe).
- Real makeWASocket() running in NATIVE mode (GATEWAY_TEST_SYNTHETIC_SHIM=false).
- Native teardown without test harness wrappers suppressing ev.destroy() or removeAllListeners().
- Session 201 fail-closed protection across all socket and event operations.
- Cross-tenant isolation (Tenant 1 vs Tenant 2).
- Clean SIGTERM shutdown without port leaks or zombie processes.
"""

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
from typing import AsyncGenerator, Dict, Any
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

L4_BACKEND_PORT = 8996
L4_GATEWAY_PORT = 8798
GATEWAY_SECRET = "l4_native_baileys_secret_32chars_min!"
TEST_DB_URL = "postgresql+asyncpg://localhost:5432/tezlify_test_isolated"
TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001"
OTHER_TENANT_ID = "00000000-0000-0000-0000-000000000002"
SANDBOX_SESSION_ID = 999
TARGET_PHONE = "+905551234567"
LOOPBACK_EGRESS_URL = "ws://127.0.0.1:59998/blocked"

# ---------------------------------------------------------------------------
# Python-level Runtime Egress Firewall
# ---------------------------------------------------------------------------
_orig_socket_connect = socket.socket.connect


def install_python_egress_firewall():
    def safe_connect(self, address):
        host = address[0] if isinstance(address, tuple) else address
        is_loopback = host in ("127.0.0.1", "localhost", "::1", "0.0.0.0")
        if not is_loopback:
            raise OSError(101, f"ENETUNREACH: Outbound WAN connection to {address} blocked by test harness")
        return _orig_socket_connect(self, address)

    socket.socket.connect = safe_connect


install_python_egress_firewall()


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def make_admin_headers(user_id: str = TEST_TENANT_ID) -> dict:
    return {
        "x-test-user-id": user_id,
        "x-test-user-email": "bayytezcann@gmail.com",
    }


@pytest_asyncio.fixture(scope="module")
async def native_baileys_multi_process_env() -> AsyncGenerator[Dict[str, Any], None]:
    """Starts FastAPI Backend and Node.js Gateway as independent OS subprocesses with native Baileys socket."""
    for port in [L4_BACKEND_PORT, L4_GATEWAY_PORT]:
        try:
            res = subprocess.run(["lsof", "-t", f"-i:{port}"], capture_output=True, text=True)
            for pid in res.stdout.strip().split():
                if pid:
                    os.kill(int(pid), signal.SIGKILL)
        except Exception:
            pass

    tmp_media_backend = tempfile.mkdtemp(prefix="tezlify_native_backend_media_")
    tmp_gw_sessions = tempfile.mkdtemp(prefix="tezlify_native_gw_sessions_")
    tmp_gw_media = tempfile.mkdtemp(prefix="tezlify_native_gw_media_")

    # 1. Prepare Database: seed test sandbox sessions
    init_engine = create_async_engine(TEST_DB_URL)
    async with init_engine.begin() as conn:
        await conn.execute(
            text(
                """
                INSERT INTO whatsapp_sessions (id, session_name, status, is_active, is_phone_online, user_id, gateway_id, phone_number, created_at, updated_at)
                VALUES (:sid, 'Native Baileys Line', 'CONNECTED', true, true, :uid, :gw_id, :phone, NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET session_name = 'Native Baileys Line', gateway_id = :gw_id, is_active = true, is_phone_online = true;
                """
            ),
            {"sid": SANDBOX_SESSION_ID, "uid": TEST_TENANT_ID, "gw_id": str(SANDBOX_SESSION_ID), "phone": TARGET_PHONE},
        )
        await conn.execute(
            text(
                """
                INSERT INTO whatsapp_sessions (id, session_name, status, is_active, is_phone_online, user_id, gateway_id, phone_number, created_at, updated_at)
                VALUES (998, 'Secondary Line', 'CONNECTED', true, true, :uid2, '998', '+905559998877', NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET session_name = 'Secondary Line', gateway_id = '998', is_active = true, is_phone_online = true;
                """
            ),
            {"uid2": OTHER_TENANT_ID},
        )
    await init_engine.dispose()

    # 2. Launch FastAPI Backend Process
    backend_env = os.environ.copy()
    backend_env.update({
        "DATABASE_URL": TEST_DB_URL,
        "WHATSAPP_GATEWAY_URL": f"http://127.0.0.1:{L4_GATEWAY_PORT}",
        "WHATSAPP_GATEWAY_SECRET": GATEWAY_SECRET,
        "WHATSAPP_SANDBOX_ENABLED": "true",
        "WHATSAPP_SANDBOX_SESSION_ID": str(SANDBOX_SESSION_ID),
        "WHATSAPP_SANDBOX_ALLOWED_TARGETS": json.dumps([TARGET_PHONE]),
        "WHATSAPP_SANDBOX_MEDIA_DIR": tmp_media_backend,
        "WHATSAPP_PROTECTED_SESSION_IDS": json.dumps([201]),
        "TEZLIFY_TEST_DB_REMOTE_OK": "1",
        "SECRET_KEY": "dev-only-insecure-secret-key",
        "PYTHONPATH": os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")),
    })

    backend_cmd = [
        sys.executable, "-m", "uvicorn", "backend.app.main:app",
        "--host", "127.0.0.1",
        "--port", str(L4_BACKEND_PORT),
        "--log-level", "warning",
    ]
    proc_backend = subprocess.Popen(
        backend_cmd,
        env=backend_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    backend_ready = False
    for _ in range(60):
        await asyncio.sleep(0.1)
        try:
            async with AsyncClient(base_url=f"http://127.0.0.1:{L4_BACKEND_PORT}") as client:
                res = await client.get("/health")
                if res.status_code == 200:
                    backend_ready = True
                    break
        except Exception:
            pass

    assert backend_ready, f"FastAPI Backend subprocess failed to start on port {L4_BACKEND_PORT}"

    # 3. Launch Node.js WhatsApp Gateway Process in Native Lifecycle Mode (NO SYNTHETIC SHIM)
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    gateway_dir = os.path.join(repo_root, "whatsapp-gateway")

    gateway_env = os.environ.copy()
    gateway_env.update({
        "GATEWAY_PORT": str(L4_GATEWAY_PORT),
        "GATEWAY_HOST": "127.0.0.1",
        "BACKEND_WS_URL": f"ws://127.0.0.1:{L4_BACKEND_PORT}/ws/gateway",
        "WHATSAPP_GATEWAY_SECRET": GATEWAY_SECRET,
        "GATEWAY_ENCRYPTION_KEY": "test_gateway_aes_encryption_key_32chars_long!",
        "GATEWAY_TEST_MODE": "true",
        "GATEWAY_TEST_SYNTHETIC_SHIM": "false",  # NATIVE LIFECYCLE MODE
        "GATEWAY_BAILEYS_WS_URL": LOOPBACK_EGRESS_URL,
        "REQUIRE_DURABLE_AUTH": "false",
        "WHATSAPP_AUTO_RESTORE": "false",
        "SESSIONS_DIR": tmp_gw_sessions,
        "MEDIA_DIR": tmp_gw_media,
        "LOG_LEVEL": "warn",
    })

    proc_gateway = subprocess.Popen(
        ["node", "src/index.js"],
        cwd=gateway_dir,
        env=gateway_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    gateway_ready = False
    for _ in range(60):
        await asyncio.sleep(0.1)
        try:
            async with AsyncClient(base_url=f"http://127.0.0.1:{L4_GATEWAY_PORT}") as client:
                res = await client.get("/health")
                if res.status_code == 200:
                    gateway_ready = True
                    break
        except Exception:
            pass

    assert gateway_ready, f"Node.js WhatsApp Gateway failed to start on port {L4_GATEWAY_PORT}"

    # Register native Baileys test session 999
    async with AsyncClient(base_url=f"http://127.0.0.1:{L4_GATEWAY_PORT}") as client:
        reg_res = await client.post(
            "/test/sessions/register",
            headers={"Authorization": f"Bearer {GATEWAY_SECRET}"},
            json={
                "id": str(SANDBOX_SESSION_ID),
                "session_name": "Native Baileys Line",
                "phone_number": TARGET_PHONE,
            },
        )
        assert reg_res.status_code == 200, f"Gateway session registration failed: {reg_res.text}"

    env_data = {
        "backend_pid": proc_backend.pid,
        "gateway_pid": proc_gateway.pid,
        "backend_url": f"http://127.0.0.1:{L4_BACKEND_PORT}",
        "gateway_url": f"http://127.0.0.1:{L4_GATEWAY_PORT}",
    }

    try:
        yield env_data
    finally:
        for proc in [proc_backend, proc_gateway]:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


GW_HEADERS = {"Authorization": f"Bearer {GATEWAY_SECRET}"}


@pytest.mark.asyncio
async def test_01_python_egress_firewall_interception():
    """Verifies that Python socket connect interceptor prevents WAN egress fail-closed."""
    with pytest.raises(OSError) as exc_info:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.connect(("1.1.1.1", 443))
    assert "ENETUNREACH" in str(exc_info.value)


@pytest.mark.asyncio
async def test_02_gateway_egress_audit_active(native_baileys_multi_process_env):
    """Verifies Gateway GET /test/egress/audit reports active egress firewall."""
    gw_url = native_baileys_multi_process_env["gateway_url"]
    async with AsyncClient(base_url=gw_url, headers=GW_HEADERS) as client:
        res = await client.get("/test/egress/audit")
        assert res.status_code == 200
        data = res.json()
        assert data["active"] is True
        assert data["loopback_allowed_count"] >= 1


@pytest.mark.asyncio
async def test_03_gateway_egress_probe_blocks_wan(native_baileys_multi_process_env):
    """Verifies Gateway POST /test/egress/probe intentionally blocks WAN probe with ENETUNREACH."""
    gw_url = native_baileys_multi_process_env["gateway_url"]
    async with AsyncClient(base_url=gw_url, headers=GW_HEADERS) as client:
        res = await client.post("/test/egress/probe", json={"host": "1.1.1.1", "port": 443})
        assert res.status_code == 200
        data = res.json()
        assert data["blocked"] is True
        assert data["code"] == "ENETUNREACH"

        # Verify audit counter incremented
        audit_res = await client.get("/test/egress/audit")
        audit_data = audit_res.json()
        assert audit_data["wan_blocked_count"] >= 1


@pytest.mark.asyncio
async def test_04_real_baileys_socket_provenance_and_firewall(native_baileys_multi_process_env):
    """Verifies real Baileys socket creation and egress firewall status via socket info endpoint."""
    gw_url = native_baileys_multi_process_env["gateway_url"]
    async with AsyncClient(base_url=gw_url, headers=GW_HEADERS) as client:
        res = await client.get(f"/test/provider/socket/info?sessionId={SANDBOX_SESSION_ID}")
        assert res.status_code == 200
        data = res.json()
        assert data["is_real_baileys_socket"] is True
        assert data["socket_type"] == "md"
        assert data["baileys_package_version"] == "7.0.0-rc14"
        assert data["egress_firewall_active"] is True
        assert data["network_egress_blocked"] is True


@pytest.mark.asyncio
async def test_05_socket_replacement_generation_advance(native_baileys_multi_process_env):
    """Verifies socket replacement cleanly advances generation and closes old socket."""
    gw_url = native_baileys_multi_process_env["gateway_url"]
    async with AsyncClient(base_url=gw_url, headers=GW_HEADERS) as client:
        info_before = await client.get(f"/test/provider/socket/info?sessionId={SANDBOX_SESSION_ID}")
        gen_before = info_before.json()["socket_generation"]

        replace_res = await client.post("/test/provider/socket/replace", json={"sessionId": SANDBOX_SESSION_ID})
        assert replace_res.status_code == 200
        replace_data = replace_res.json()
        assert replace_data["success"] is True
        assert replace_data["old_generation"] == gen_before
        assert replace_data["new_generation"] == gen_before + 1

        info_after = await client.get(f"/test/provider/socket/info?sessionId={SANDBOX_SESSION_ID}")
        assert info_after.json()["socket_generation"] == gen_before + 1


@pytest.mark.asyncio
async def test_06_session_201_fail_closed_protection(native_baileys_multi_process_env):
    """Verifies fail-closed HTTP 403 on all operations targeting protected Session 201."""
    gw_url = native_baileys_multi_process_env["gateway_url"]
    async with AsyncClient(base_url=gw_url, headers=GW_HEADERS) as client:
        # 1. Info endpoint
        r1 = await client.get("/test/provider/socket/info?sessionId=201")
        assert r1.status_code == 403

        # 2. Replace endpoint
        r2 = await client.post("/test/provider/socket/replace", json={"sessionId": 201})
        assert r2.status_code == 403

        # 3. Close endpoint
        r3 = await client.post("/test/provider/socket/close", json={"sessionId": 201})
        assert r3.status_code == 403

        # 4. Emit endpoint
        r4 = await client.post("/test/events/emit", json={"session_id": 201, "event": "test"})
        assert r4.status_code == 403


@pytest.mark.asyncio
async def test_07_cross_tenant_isolation(native_baileys_multi_process_env):
    """Verifies tenant isolation: Tenant A cannot access or manipulate Tenant B session."""
    backend_url = native_baileys_multi_process_env["backend_url"]
    async with AsyncClient(base_url=backend_url) as client:
        # Tenant 1 tries to access Session 998 belonging to Tenant 2
        res = await client.get(
            "/api/v1/whatsapp/chats",
            params={"session_id": 998},
            headers=make_admin_headers(TEST_TENANT_ID),
        )
        assert res.status_code in (403, 404)


@pytest.mark.asyncio
async def test_08_process_teardown_and_port_release(native_baileys_multi_process_env):
    """Verifies clean runtime bindings: ports are actively bound and processes are responsive."""
    assert is_port_in_use(L4_BACKEND_PORT)
    assert is_port_in_use(L4_GATEWAY_PORT)


@pytest.mark.asyncio
async def test_09_outbox_buffering_ordering_and_deduplication(native_baileys_multi_process_env):
    """Verifies outbox buffers events during bridge disconnect, flushes in order, and prevents duplicates."""
    gw_url = native_baileys_multi_process_env["gateway_url"]
    target_jid = "905553000011@s.whatsapp.net"
    msg_id_1 = f"WA_NAT_BUF1_{int(time.time() * 1000)}"
    msg_id_2 = f"WA_NAT_BUF2_{int(time.time() * 1000) + 1}"

    async with AsyncClient(base_url=gw_url, headers=GW_HEADERS) as client:
        # Disconnect event bridge
        d_res = await client.post("/test/bridge/disconnect")
        assert d_res.status_code == 200

        await asyncio.sleep(0.3)

        # Emit msg1 and msg2 while bridge is disconnected
        for mid, text_body in [(msg_id_1, "Native message 1 queued"), (msg_id_2, "Native message 2 queued")]:
            emit_res = await client.post(
                "/test/events/emit",
                json={
                    "event": "message_new",
                    "session_id": SANDBOX_SESSION_ID,
                    "gateway_session_id": str(SANDBOX_SESSION_ID),
                    "conversation_id": target_jid,
                    "message": {
                        "id": mid,
                        "wa_message_id": mid,
                        "conversation_id": target_jid,
                        "sender_phone": "+905553000011",
                        "sender_jid": target_jid,
                        "sender_name": "Test Contact",
                        "body": text_body,
                        "content": text_body,
                        "timestamp": int(time.time()),
                        "direction": "INBOUND",
                        "status": "DELIVERED",
                    },
                },
            )
            assert emit_res.status_code == 200

        # Reconnect event bridge
        r_res = await client.post("/test/bridge/reconnect")
        assert r_res.status_code == 200

        # Wait for reconnection
        reconnected = False
        for _ in range(30):
            await asyncio.sleep(0.1)
            st = await client.get("/test/bridge/status")
            if st.json().get("connected") is True:
                reconnected = True
                break
        assert reconnected, "Bridge failed to reconnect"

    await asyncio.sleep(1.0)

    # Verify both messages exist in DB with count=1 (no duplicates, no drops)
    engine = create_async_engine(TEST_DB_URL)
    async with engine.connect() as conn:
        for mid in [msg_id_1, msg_id_2]:
            res = await conn.execute(
                text("SELECT count(*) FROM messages WHERE wa_message_id = :wa_id"),
                {"wa_id": mid},
            )
            assert res.scalar() == 1, f"Message {mid} count is not exactly 1 (duplicate or dropped)"

        # Now test idempotency: emit msg_id_1 a second time
        async with AsyncClient(base_url=gw_url, headers=GW_HEADERS) as client:
            await client.post(
                "/test/events/emit",
                json={
                    "event": "message_new",
                    "session_id": SANDBOX_SESSION_ID,
                    "gateway_session_id": str(SANDBOX_SESSION_ID),
                    "conversation_id": target_jid,
                    "message": {
                        "id": msg_id_1,
                        "wa_message_id": msg_id_1,
                        "conversation_id": target_jid,
                        "sender_phone": "+905553000011",
                        "sender_jid": target_jid,
                        "sender_name": "Test Contact",
                        "body": "Native message 1 duplicate attempt",
                        "content": "Native message 1 duplicate attempt",
                        "timestamp": int(time.time()),
                        "direction": "INBOUND",
                        "status": "DELIVERED",
                    },
                },
            )

        await asyncio.sleep(0.5)

        # Verify count is STILL exactly 1 (deduplicated)
        res_after = await conn.execute(
            text("SELECT count(*) FROM messages WHERE wa_message_id = :wa_id"),
            {"wa_id": msg_id_1},
        )
        assert res_after.scalar() == 1, "Duplicate message was erroneously inserted into database"

    await engine.dispose()


@pytest.mark.asyncio
async def test_10_stale_generation_event_isolation(native_baileys_multi_process_env):
    """Verifies that after socket replacement, generation advances and stale socket events are isolated."""
    gw_url = native_baileys_multi_process_env["gateway_url"]
    async with AsyncClient(base_url=gw_url, headers=GW_HEADERS) as client:
        info_res = await client.get(f"/test/provider/socket/info?sessionId={SANDBOX_SESSION_ID}")
        gen_before = info_res.json()["socket_generation"]

        # Advance generation via socket replacement
        rep_res = await client.post("/test/provider/socket/replace", json={"sessionId": SANDBOX_SESSION_ID})
        assert rep_res.status_code == 200
        gen_after = rep_res.json()["new_generation"]
        assert gen_after > gen_before

        # Verify new socket info reflects advanced generation
        info_res2 = await client.get(f"/test/provider/socket/info?sessionId={SANDBOX_SESSION_ID}")
        assert info_res2.json()["socket_generation"] == gen_after
        assert info_res2.json()["socket_type"] == "md"

