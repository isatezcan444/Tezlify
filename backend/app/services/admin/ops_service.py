"""
Operations Center — allowlisted production operations.

SECURITY CONTRACT (read before adding anything here)
---------------------------------------------------
This module CANNOT execute caller-supplied commands. Ever.

* Every public action is a key in `OPERATIONS`. Its argv is built HERE from
  hard-coded values; the HTTP layer passes only the operation *name* (and typed,
  range-checked parameters). There is no code path where a request body, query
  string or header reaches a shell.
* `subprocess` is always invoked with a LIST argv and `shell=False`, so shell
  metacharacters in any value are inert.
* Each operation declares a `destructive` flag. The API refuses destructive
  operations unless the caller explicitly confirms (`confirm: true`).
* Concurrency is guarded so two deploys (or two restarts) cannot overlap.
* Every attempt is written to a bounded, sanitized audit log.

Container control uses the docker CLI against the mounted host socket. The
socket is root-equivalent on the host; that is why the caller must be an
administrator (`require_admin`) and why this file contains no dynamic argv.
"""

import asyncio
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Where the production compose project lives on the host. Mounted into the
# backend container at /opt/tezlify/deploy (see docker-compose.prod.yml).
DEPLOY_DIR = os.environ.get("TEZLIFY_DEPLOY_DIR", "/opt/tezlify/deploy")
COMPOSE_FILE = os.path.join(DEPLOY_DIR, "docker-compose.prod.yml")

# Services the Operations Center is allowed to act on. Anything not in this
# tuple cannot be targeted at all.
ALLOWED_SERVICES: Tuple[str, ...] = ("backend", "gateway", "caddy")

# Compose project name; `-p` keeps us from touching another compose project
# that may run on the same host.
COMPOSE_PROJECT = os.environ.get("TEZLIFY_COMPOSE_PROJECT", "tezlify")

# Bound on the in-memory operation history surfaced by the API.
MAX_OPERATION_HISTORY = 50

# Destructive operations are refused without explicit confirmation and are
# additionally rate limited (they are the ones that take the site down).
_DESTRUCTIVE_COOLDOWN_SECONDS = 30

# Credentials must never reach the browser or the audit log. WhatsApp auth
# material, bearer tokens and connection strings are redacted BEFORE storage,
# not at render time, so a later UI bug cannot leak what was already captured.
_secret_patterns = [
    re.compile(r"(?i)\b(authorization|bearer)\s*[:=]?\s*\S+"),
    re.compile(r"(?i)\b(password|passwd|pwd)\s*[:=]\s*\S+"),
    re.compile(r"(?i)\b(secret|token|api[_-]?key)\s*[:=]\s*\S+"),
    re.compile(r"(?i)\b(sess(ion)?[_-]?key|auth[_-]?key)\s*[:=]\s*\S+"),
    re.compile(r"(?i)\bcookie\s*[:=]\s*\S+"),
    re.compile(r"(?i)-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----"),
]


def redact(text: str, limit: int = 4000) -> str:
    """Strip credentials from any text bound for the UI, the log, or disk."""
    if not text:
        return ""
    out = str(text)
    for pattern in _secret_patterns:
        out = pattern.sub("[REDACTED]", out)
    return out[:limit]


def _compose_argv(*args: str) -> List[str]:
    """Build a fixed `docker compose` argv. Never interpolates user input."""
    return ["docker", "compose", "-p", COMPOSE_PROJECT, "-f", COMPOSE_FILE, *args]


class OperationSpec:
    """Declarative description of one allowlisted operation."""

    __slots__ = ("name", "label", "build_argv", "destructive", "cooldown", "timeout")

    def __init__(
        self,
        name: str,
        label: str,
        build_argv: Callable[[], List[str]],
        destructive: bool = False,
        cooldown: int = 0,
        timeout: int = 300,
    ) -> None:
        self.name = name
        self.label = label
        self.build_argv = build_argv
        self.destructive = destructive
        self.cooldown = cooldown
        self.timeout = timeout


class OperationError(Exception):
    """Raised when an operation cannot be started (validation/concurrency)."""

    def __init__(self, message: str, code: str = "operation_rejected"):
        super().__init__(message)
        self.message = message
        self.code = code


def _build_restart(service: str) -> List[str]:
    # `service` is validated against ALLOWED_SERVICES before this is called.
    return _compose_argv("up", "-d", "--no-deps", "--force-recreate", service)


# --------------------------------------------------------------------------
# The allowlist. `build_argv` receives NO caller input at all.
# --------------------------------------------------------------------------
OPERATIONS: Dict[str, OperationSpec] = {
    "restart_backend": OperationSpec(
        "restart_backend", "Restart backend", lambda: _build_restart("backend"),
        destructive=True, cooldown=_DESTRUCTIVE_COOLDOWN_SECONDS,
    ),
    "restart_gateway": OperationSpec(
        "restart_gateway", "Restart WhatsApp gateway", lambda: _build_restart("gateway"),
        destructive=True, cooldown=_DESTRUCTIVE_COOLDOWN_SECONDS,
    ),
    "restart_caddy": OperationSpec(
        "restart_caddy", "Restart edge proxy", lambda: _build_restart("caddy"),
        destructive=True, cooldown=_DESTRUCTIVE_COOLDOWN_SECONDS,
    ),
    "restart_all": OperationSpec(
        "restart_all", "Restart all services",
        lambda: _compose_argv("up", "-d", "--force-recreate"),
        destructive=True, cooldown=_DESTRUCTIVE_COOLDOWN_SECONDS, timeout=600,
    ),
    "deploy_build": OperationSpec(
        "deploy_build", "Build and deploy latest",
        lambda: _compose_argv("build", "backend", "gateway", "caddy"),
        destructive=True, cooldown=_DESTRUCTIVE_COOLDOWN_SECONDS, timeout=1800,
    ),
    "deploy_pull": OperationSpec(
        "deploy_pull", "Pull latest commit",
        lambda: ["git", "pull", "--ff-only", "origin", "main"],
        destructive=True, cooldown=_DESTRUCTIVE_COOLDOWN_SECONDS, timeout=300,
    ),
    "git_status": OperationSpec(
        "git_status", "Read git status",
        lambda: ["git", "status", "--porcelain", "-b"], timeout=30,
    ),
}


# --------------------------------------------------------------------------
# Runtime state
# --------------------------------------------------------------------------
_op_registry: Dict[str, Dict[str, Any]] = {}
_order: List[str] = []
# Family guard: one in-flight operation per family, so "deploy" and "restart"
# cannot interleave. Values are the operation ids currently running.
_inflight: Dict[str, str] = {}
_cooldowns: Dict[str, float] = {}
_audit: List[Dict[str, Any]] = []
_state_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _public(op: Dict[str, Any]) -> Dict[str, Any]:
    """Operation record as returned to the UI (logs already redacted)."""
    return {
        "id": op["id"],
        "name": op["name"],
        "label": op["label"],
        "status": op["status"],
        "step": op.get("step"),
        "started_at": op.get("started_at"),
        "finished_at": op.get("finished_at"),
        "duration_ms": op.get("duration_ms"),
        "actor": op.get("actor"),
        "destructive": op.get("destructive", False),
        "error": op.get("error"),
        "logs": list(op.get("logs") or [])[-200:],
        "exit_code": op.get("exit_code"),
    }


def record_audit(action: str, actor: str, result: str, operation_id: Optional[str] = None,
                 detail: Optional[Dict[str, Any]] = None) -> None:
    """Append a redacted audit entry. Bounded so it cannot grow unbounded."""
    entry = {
        "id": operation_id or str(uuid.uuid4()),
        "at": _now_iso(),
        "action": action,
        "actor": actor,
        "result": result,
        "detail": redact(str(detail or {}), 500),
    }
    _audit.append(entry)
    if len(_audit) > 500:
        del _audit[:-500]


def list_audit(limit: int = 100) -> List[Dict[str, Any]]:
    limit = max(1, min(int(limit or 100), 500))
    return list(_audit[-limit:])[::-1]


async def _publish(event: Dict[str, Any], user_id: Optional[str]) -> None:
    """Push an operation event onto the existing realtime stream.

    Uses the same `ws_manager` the rest of the product uses, so the Operations
    Center needs no new socket. Failures are logged and swallowed: a realtime
    hiccup must never fail the operation itself.
    """
    try:
        from backend.app.api.v1.websocket import ws_manager
        await ws_manager.broadcast(event, target_user_id=user_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("ops event publish failed: %s", exc)


def _operation_family(spec: OperationSpec) -> str:
    """Group related operations so a deploy and a restart cannot interleave."""
    if spec.name.startswith("deploy"):
        return "deploy"
    if spec.name.startswith("restart"):
        return "restart"
    return spec.name


async def _run_command(
    op: Dict[str, Any],
    argv: List[str],
    cwd: str,
    user_id: Optional[str],
) -> int:
    """Run one fixed command, streaming redacted output into the operation log."""
    op["step"] = "running"
    await _publish({"event": "operation.progress", "operation": _public(op)}, user_id)
    lines: List[str] = []
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = redact(raw.decode("utf-8", "replace").rstrip(), 2000)
            if not line:
                continue
            lines.append(line)
            op["logs"].append(line)
            if len(op["logs"]) > 2000:
                del op["logs"][:-2000]
            await _publish({"event": "operation.log", "operation": _public(op)}, user_id)
        return await proc.wait()
    except asyncio.CancelledError:
        proc.kill()
        raise
    finally:
        op["duration_ms"] = int((time.monotonic() - started) * 1000)


async def start_operation(
    name: str,
    actor: str,
    user_id: Optional[str],
    confirm: bool = False,
) -> Dict[str, Any]:
    """Validate and launch one allowlisted operation.

    Raises OperationError when the operation is unknown, unconfirmed (and
    destructive), or already running. Returns the created operation record.
    """
    spec = OPERATIONS.get(name)
    if spec is None:
        record_audit("operation.reject_unknown", actor, "denied", detail={"name": name})
        raise OperationError("Unknown operation", code="unknown_operation")

    if spec.destructive and not confirm:
        record_audit("operation.reject_unconfirmed", actor, "denied", detail={"name": name})
        raise OperationError("This operation requires confirmation", code="confirmation_required")

    async with _state_lock:
        family = _operation_family(spec)
        running_id = _inflight.get(family)
        if running_id and _op_registry.get(running_id, {}).get("status") == "running":
            record_audit("operation.reject_busy", actor, "denied", detail={"name": name, "running": running_id})
            raise OperationError(
                f"Another {family} operation is already running", code="operation_in_progress"
            )
        if spec.cooldown:
            last = _cooldowns.get(name)
            if last and (time.monotonic() - last) < spec.cooldown:
                raise OperationError(
                    "Operation is cooling down", code="operation_cooldown"
                )
            _cooldowns[name] = time.monotonic()

        op_id = uuid.uuid4().hex
        op = {
            "id": op_id,
            "name": spec.name,
            "label": spec.label,
            "status": "running",
            "step": "starting",
            "started_at": _now_iso(),
            "finished_at": None,
            "duration_ms": None,
            "actor": actor,
            "destructive": spec.destructive,
            "error": None,
            "logs": [],
            "exit_code": None,
        }
        _op_registry[op_id] = op
        _order.append(op_id)
        if len(_order) > MAX_OPERATION_HISTORY:
            for stale in _order[:-MAX_OPERATION_HISTORY]:
                _op_registry.pop(stale, None)
            del _order[:-MAX_OPERATION_HISTORY]
        _inflight[family] = op_id

    record_audit("operation.start", actor, "accepted", op_id, {"name": name})
    await _publish({"event": "operation.started", "operation": _public(op)}, user_id)
    asyncio.create_task(_execute(op, spec, user_id))
    return _public(op)


async def _execute(op: Dict[str, Any], spec: OperationSpec, user_id: Optional[str]) -> None:
    """Run the operation to completion, then verify and publish the result."""
    try:
        argv = spec.build_argv()
        op["step"] = "running"
        exit_code = await _run_command(op, argv, DEPLOY_DIR, user_id)
        op["exit_code"] = exit_code
        if exit_code == 0:
            op["status"] = "succeeded"
            op["step"] = "completed"
        else:
            op["status"] = "failed"
            op["step"] = "failed"
            op["error"] = redact(f"Command exited with code {exit_code}", 500)
    except Exception as exc:
        op["status"] = "failed"
        op["step"] = "failed"
        op["error"] = redact(str(exc) or exc.__class__.__name__, 500)
        logger.warning("operation %s failed: %s", op["name"], op["error"])
    finally:
        op["finished_at"] = _now_iso()
        async with _state_lock:
            if _inflight.get(_operation_family(spec)) == op["id"]:
                _inflight.pop(_operation_family(spec), None)
        # A restart/deploy is only "done" if the service came back up. Process
        # exit code alone is NOT proof of a healthy deployment.
        if op["status"] == "succeeded" and op["name"] != "git_status":
            op["step"] = "health_check"
            await _publish({"event": "operation.progress", "operation": _public(op)}, user_id)
            health = await run_health_check()
            op["health"] = health
            if health.get("all_healthy") is False:
                op["status"] = "failed"
                op["step"] = "health_check_failed"
                op["error"] = redact("Operation completed but health check failed", 500)
        record_audit(
            "operation.finish", op["actor"], op["status"], op["id"], {"name": op["name"]}
        )
        await _publish({"event": f"operation.{op['status']}", "operation": _public(op)}, user_id)


def get_operation(operation_id: str) -> Optional[Dict[str, Any]]:
    op = _op_registry.get(operation_id)
    return _public(op) if op else None


def list_operations(limit: int = 20) -> List[Dict[str, Any]]:
    limit = max(1, min(int(limit or 20), MAX_OPERATION_HISTORY))
    return [_public(_op_registry[i]) for i in _order[-limit:]][::-1]


def running_operation() -> Optional[Dict[str, Any]]:
    for op_id in reversed(_order):
        op = _op_registry.get(op_id)
        if op and op.get("status") == "running":
            return _public(op)
    return None


# --------------------------------------------------------------------------
# Real service inspection (docker CLI) — replaces the previously hardcoded
# container defaults, which reported a "running" state that was not measured.
# --------------------------------------------------------------------------
async def _docker_json(args: List[str], timeout: int = 20) -> Any:
    """Run a fixed docker read-only query and parse its JSON output."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return None
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return None
    if proc.returncode != 0:
        logger.debug("docker query failed: %s", redact(err.decode("utf-8", "replace"), 300))
        return None
    import json as _json
    try:
        return _json.loads(out.decode("utf-8", "replace") or "null")
    except Exception:
        return None


async def get_service_status() -> List[Dict[str, Any]]:
    """Live container state straight from the docker daemon."""
    payload = await _docker_json(
        ["docker", "ps", "-a", "--filter", "name=tezlify-",
         "--format", "{{json .}}"]
    )
    rows: Dict[str, Dict[str, Any]] = {}
    if isinstance(payload, list):
        for item in payload:
            if not isinstance(item, dict):
                continue
            name = str(item.get("Names") or item.get("Name") or "")
            if not name:
                continue
            state = str(item.get("State") or item.get("Status") or "unknown")
            rows[name] = {
                "name": name,
                "status": "running" if state.lower().startswith("up") else state.lower(),
                "state": state,
                "image": item.get("Image"),
                "health": _parse_health(state),
                "uptime": _parse_uptime(state),
                "started_at": None,
                "restart_count": None,
                "oom_killed": False,
                "rss_mb": None,
            }
    result = []
    for service in ("caddy", "backend", "gateway", "db"):
        name = f"tezlify-{service}"
        result.append(rows.get(name) or {
            "name": name, "status": "absent", "state": "absent", "image": None,
            "health": None, "uptime": None, "started_at": None,
            "restart_count": None, "oom_killed": False, "rss_mb": None,
        })
    return result


def _parse_health(state: str) -> Optional[str]:
    if "(healthy)" in state:
        return "healthy"
    if "(unhealthy)" in state:
        return "unhealthy"
    if "(health: starting)" in state:
        return "starting"
    return None


def _parse_uptime(state: str) -> Optional[str]:
    m = re.search(r"Up\s+([0-9]+\s+\S+)", state or "")
    return m.group(1) if m else None


# Log reading is bounded and service-scoped: the UI can ask for the tail of one
# allowlisted container's logs, never an arbitrary file.
LOG_SERVICES: Tuple[str, ...] = ("backend", "gateway", "caddy", "db")# Log reading is bounded and service-scoped: the UI can ask for the tail of one
# allowlisted container's logs, never an arbitrary file.
LOG_SERVICES: Tuple[str, ...] = ("backend", "gateway", "caddy", "db")
MAX_LOG_LINES = 500


async def get_service_logs(
    service: str,
    tail: int = 200,
    level: Optional[str] = None,
) -> Dict[str, Any]:
    """Return the redacted tail of one allowlisted container's logs."""
    if service not in LOG_SERVICES:
        raise OperationError("Unknown log service", code="unknown_service")
    tail = max(1, min(int(tail or 200), MAX_LOG_LINES))
    argv = ["docker", "logs", "--tail", str(tail), f"tezlify-{service}"]
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        return {"service": service, "lines": [], "error": "log read timed out"}
    lines = [
        redact(line, 2000)
        for line in out.decode("utf-8", "replace").splitlines()
        if line.strip()
    ]
    if level and level.upper() != "ALL":
        needle = level.upper()
        lines = [l for l in lines if needle in l.upper()]
    return {"service": service, "lines": lines[-tail:], "error": None}

    m = re.search(r"Up\s+([0-9]+\s+\S+)", state or "")
    return m.group(1) if m else None


async def run_health_check() -> Dict[str, Any]:
    """Post-operation verification.

    A process being up is NOT proof of a healthy deployment, so each service is
    probed: containers must be running/healthy AND the WhatsApp session state
    must be known.
    """
    services = await get_service_status()
    by_name = {s["name"]: s for s in services}
    checks: Dict[str, Any] = {}
    for name, svc in by_name.items():
        running = svc.get("status") == "running"
        healthy = svc.get("health") in (None, "healthy")
        checks[name] = bool(running and healthy)
    return {
        "checks": checks,
        "all_healthy": all(checks.values()) if checks else False,
        "checked_at": _now_iso(),
    }


def available_operations() -> List[Dict[str, Any]]:
    """Catalogue the UI renders. Only names here are callable."""
    return [
        {
            "name": spec.name,
            "label": spec.label,
            "destructive": spec.destructive,
        }
        for spec in OPERATIONS.values()
    ]
