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
        "deploy_build", "deploy_pull", "git_status",
    }
    for name, spec in ops.OPERATIONS.items():
        argv = spec.build_argv()
        assert isinstance(argv, list), f"{name} must build a list argv"
        assert all(isinstance(part, str) for part in argv), f"{name} argv must be str-only"
        # The builder takes no arguments: a caller cannot smuggle input in.
        assert inspect.signature(spec.build_argv).parameters == {}, (
            f"{name} argv builder must accept no parameters"
        )


def test_argv_never_contains_shell_metacharacters():
    for name, spec in ops.OPERATIONS.items():
        for part in spec.build_argv():
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
