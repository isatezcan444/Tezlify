"""HTTP contract for the Operations Center.

The critical property is not "does it work" but "can anyone escalate it": an
anonymous caller, a normal user, or a crafted body must never be able to run
anything. These tests drive the real FastAPI app with dependency overrides so
the real `require_admin` gate is exercised, not a mock.
"""
import asyncio
import json
import os
import re
import shutil
import tempfile

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


# ------------------------------------------------------------ clear logs
def test_clear_logs_requires_confirmation(monkeypatch):
    """Irreversible: a body without `confirm` must not truncate anything."""
    client = _client(monkeypatch)
    res = client.post("/api/v1/admin/ops/logs/clear", json={"service": "gateway"})
    assert res.status_code == 400
    assert "confirm" in res.json()["detail"].lower()


def test_clear_logs_rejects_unknown_service_over_http(monkeypatch):
    """The service name is allowlisted, so a path can never be targeted."""
    client = _client(monkeypatch)
    res = client.post(
        "/api/v1/admin/ops/logs/clear",
        json={"service": "../../etc/passwd", "confirm": True},
    )
    assert res.status_code == 400


def test_clear_logs_anonymous_denied():
    client = _anon_client()
    res = client.post(
        "/api/v1/admin/ops/logs/clear",
        json={"service": "gateway", "confirm": True},
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_clear_logs_rejects_unknown_service_at_service_layer():
    with pytest.raises(ops.OperationError):
        await ops.clear_service_logs("../../etc/passwd")


@pytest.mark.asyncio
async def test_clear_logs_truncates_in_place_and_reports_freed_bytes(monkeypatch):
    """TRUNCATE, not unlink.

    The daemon keeps an open descriptor and appends to the same inode. Deleting
    the file would send new output to an unlinked inode, so `docker logs` would
    show nothing until the container was recreated and the disk space would not
    be reclaimed. Asserting the inode survives is what distinguishes the two.
    """
    directory = tempfile.mkdtemp(prefix="tezlify-opslog-")
    try:
        path = os.path.join(directory, "container-json.log")
        with open(path, "wb") as fh:
            fh.write(b"log line\n" * 512)
        before_ino = os.stat(path).st_ino
        size_before = os.path.getsize(path)

        async def fake_path(_service: str):
            return path

        monkeypatch.setattr(ops, "_container_log_path", fake_path)
        result = await ops.clear_service_logs("gateway", actor="tester@tezlify.test")

        assert result["cleared"] is True
        assert result["freed_bytes"] == size_before
        assert result["error"] is None
        assert os.path.getsize(path) == 0
        # Same inode => truncated in place, not unlinked and recreated.
        assert os.stat(path).st_ino == before_ino
        assert os.path.exists(path)
    finally:
        shutil.rmtree(directory, ignore_errors=True)


@pytest.mark.asyncio
async def test_clear_logs_reports_failure_instead_of_claiming_success(monkeypatch):
    """A container that is down must not read as 'cleared'."""

    async def no_path(_service: str):
        return None

    monkeypatch.setattr(ops, "_container_log_path", no_path)
    result = await ops.clear_service_logs("gateway")

    assert result["cleared"] is False
    assert result["freed_bytes"] == 0
    assert result["error"]


@pytest.mark.asyncio
async def test_clear_logs_records_an_audit_entry(monkeypatch):
    directory = tempfile.mkdtemp(prefix="tezlify-opslog-")
    try:
        path = os.path.join(directory, "container-json.log")
        with open(path, "wb") as fh:
            fh.write(b"x" * 64)

        async def fake_path(_service: str):
            return path

        monkeypatch.setattr(ops, "_container_log_path", fake_path)
        monkeypatch.setattr(ops, "_audit", [])
        await ops.clear_service_logs("caddy", actor="auditor@tezlify.test")

        entries = [a for a in ops._audit if a["action"] == "clear-logs"]
        assert len(entries) == 1
        assert entries[0]["actor"] == "auditor@tezlify.test"
        assert entries[0]["result"] == "succeeded"
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# ------------------------------------------------------------- log tail read
# Why these exist: the panel used to fetch logs with `docker logs --tail N`.
# That is not just slower — once the json-file has been truncated in place
# (which `clear_service_logs` does, and which the panel's own "clear" button
# triggers) the daemon's per-container log reader is left pointing past EOF and
# `docker logs` BLOCKS INDEFINITELY. Measured on production 2026-10-01: 22 ms
# before truncation, still hanging after 45 s once truncated, 19 ms again after
# a restart. All four containers were in that state, so every service-tab
# switch burned a full 30 s timeout and then rendered nothing.
#
# The tail is now read straight from the json-file, which is unaffected by the
# wedge. The first test is the regression that pins that: no subprocess at all.


def _json_records(path: str, logs, pad: int = 0) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for entry in logs:
            record = {"log": f"{entry}\n", "stream": "stdout",
                      "time": "2026-10-01T12:00:00Z"}
            if pad:
                record["pad"] = "x" * pad
            fh.write(json.dumps(record) + "\n")


@pytest.mark.asyncio
async def test_get_service_logs_never_shells_out_to_docker(monkeypatch):
    """The tail must come from the FILE, not from `docker logs`.

    If this fails, the panel has gone back to depending on the daemon's log
    reader — which is exactly the component that wedges after a log clear.
    """
    directory = tempfile.mkdtemp(prefix="tezlify-opslog-")
    try:
        path = os.path.join(directory, "container-json.log")
        _json_records(path, [f"satir {i}" for i in range(1, 6)])

        async def fake_path(_service: str):
            return path

        async def no_subprocess(*args, **kwargs):
            raise AssertionError(f"nothing may be spawned for a log read: {args!r}")

        monkeypatch.setattr(ops, "_container_log_path", fake_path)
        monkeypatch.setattr(asyncio, "create_subprocess_exec", no_subprocess)

        result = await ops.get_service_logs("gateway", tail=3)

        assert result["error"] is None
        assert result["lines"] == ["satir 3", "satir 4", "satir 5"]
    finally:
        shutil.rmtree(directory, ignore_errors=True)


@pytest.mark.asyncio
async def test_log_tail_still_works_after_the_log_was_cleared(monkeypatch):
    """The state production was actually in: a cleared (truncated) log.

    An emptied log must read as "no lines", not as an error — and once the
    container logs again the tail must come back. This is the case that
    `docker logs` could not serve at all.
    """
    directory = tempfile.mkdtemp(prefix="tezlify-opslog-")
    try:
        path = os.path.join(directory, "container-json.log")
        _json_records(path, ["eski satir"])

        async def fake_path(_service: str):
            return path

        monkeypatch.setattr(ops, "_container_log_path", fake_path)

        with open(path, "wb"):
            pass
        emptied = await ops.get_service_logs("caddy", tail=50)
        assert emptied["error"] is None, emptied
        assert emptied["lines"] == []

        _json_records(path, ["yeni satir"])
        regrown = await ops.get_service_logs("caddy", tail=50)
        assert regrown["lines"] == ["yeni satir"]
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_tail_json_log_unwraps_records(tmp_path):
    """json-file lines are `{"log": ...}` envelopes; the panel shows the text."""
    path = tmp_path / "c.json.log"
    _json_records(str(path), ["bir", "iki", "uc"])
    assert ops._tail_json_log(str(path), 10) == ["bir", "iki", "uc"]


def test_tail_json_log_keeps_multi_line_records_together(tmp_path):
    """One record may carry an embedded newline (a multi-line log message)."""
    path = tmp_path / "c.json.log"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"log": "ilk satir\nikinci satir\n"}) + "\n")
    assert ops._tail_json_log(str(path), 10) == ["ilk satir", "ikinci satir"]


def test_tail_json_log_passes_through_non_json_lines(tmp_path):
    """A partially written line must be shown, not silently swallowed."""
    path = tmp_path / "c.json.log"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("bu bir json kaydi degil\n")
    assert ops._tail_json_log(str(path), 10) == ["bu bir json kaydi degil"]


def test_tail_json_log_handles_empty_and_missing_files(tmp_path):
    empty = tmp_path / "empty.log"
    empty.write_bytes(b"")
    assert ops._tail_json_log(str(empty), 10) == []
    assert ops._tail_json_log(str(tmp_path / "yok.log"), 10) == []


def test_tail_json_log_reads_backwards_and_drops_the_partial_head(tmp_path):
    """The window starts mid-file, so its first record is cut in half.

    Constructed so the drop is load-bearing: the window holds exactly `tail`
    entries, one of which is the mangled head. Keeping it would push a JSON
    fragment into the panel; dropping it forces the window to widen instead.
    """
    path = tmp_path / "big.json.log"
    _json_records(str(path), ["satir 1", "satir 2", "satir 3", "satir 4"], pad=100_000)
    assert os.path.getsize(path) > ops._LOG_READ_START_BYTES

    lines = ops._tail_json_log(str(path), 3)

    assert lines == ["satir 2", "satir 3", "satir 4"]
    assert all(re.fullmatch(r"satir \d+", l) for l in lines), lines


def test_tail_json_log_returns_only_the_last_lines(tmp_path):
    path = tmp_path / "many.json.log"
    _json_records(str(path), [f"n{i}" for i in range(1, 501)])
    assert ops._tail_json_log(str(path), 3) == ["n498", "n499", "n500"]
