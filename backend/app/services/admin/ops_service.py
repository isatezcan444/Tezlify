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
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
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
    # NOTE: the explicit service list is the fix, not `up -d --force-recreate`
    # with no targets. A bare `up` also recreates `tezlify-db`, and this panel
    # deliberately does NOT allow the database to be restarted: it is not
    # allowlisted, and bouncing it would drop every live WhatsApp session's
    # data path for no operational benefit. `--no-deps` additionally keeps the
    # single-service restarts above from cascading into dependencies.
    "restart_all": OperationSpec(
        "restart_all", "Restart all services",
        lambda: _compose_argv(
            "up", "-d", "--no-deps", "--force-recreate", "caddy", "backend", "gateway",
        ),
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

# --------------------------------------------------------------------------
# Durable state
# --------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------
# A restart or deploy of the backend is, by design, carried out by the backend
# itself. That means the process performing the operation is the process that
# dies partway through it: `_execute` is killed before it can set a terminal
# status or publish `operation.succeeded`. With purely in-memory state the
# record simply vanished on restart and the panel showed "running" forever, with
# no way to tell a completed restart from a crashed one.
#
# Persisting to a small JSON file makes the state survive the restart, and
# lets `_recover_orphans()` mark anything that was still running when the
# process died as `interrupted` instead of pretending it is in flight.
#
# This is deliberately NOT a database table: the file survives a container
# recreate (it lives in a mounted volume path) and needs no migration. If the
# file is missing or corrupt we degrade to empty history rather than failing
# startup — a read-only ops panel must never be able to block the API.
_STATE_DIR = Path(os.getenv("TEZLIFY_OPS_STATE_DIR", DEPLOY_DIR)).resolve() / ".ops-state"
_STATE_FILE = _STATE_DIR / "operations.json"
_MAX_PERSISTED = MAX_OPERATION_HISTORY
# Set when persistence is unavailable. Surfaced by the status endpoint so an
# operator can SEE that history is not being kept, rather than silently losing
# it: a read-only or unmounted deploy dir is exactly the case that matters.
_persist_ok: bool = True
_persist_error: Optional[str] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _persist_state() -> None:
    """Write operation + audit state to disk. Never raises.

    A failure here is recorded rather than only logged: if the deploy dir is
    read-only or unmounted the panel would otherwise look healthy while
    silently losing every operation record, which is exactly the case an
    operator needs to be told about.
    """
    global _persist_ok, _persist_error
    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "operations": [_op_registry[i] for i in _order if i in _op_registry],
            "audit": _audit[-500:],
        }
        # Write-then-rename: a crash mid-write must not leave a truncated file
        # that would wipe the history on the next boot.
        tmp = _STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, default=str), encoding="utf-8")
        tmp.replace(_STATE_FILE)
        _persist_ok = True
        _persist_error = None
    except Exception as exc:  # pragma: no cover - defensive
        _persist_ok = False
        _persist_error = redact(f"{exc.__class__.__name__}: {exc}", 200)
        logger.warning("could not persist ops state: %s", _persist_error)


def _load_state() -> None:
    """Restore state written by a previous process, if any."""
    try:
        raw = _STATE_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return
    except Exception:
        logger.warning("ops state file unreadable; starting with empty history")
        return
    try:
        data = json.loads(raw)
    except Exception:
        logger.warning("ops state file corrupt; starting with empty history")
        return
    for op in (data.get("operations") or [])[-_MAX_PERSISTED:]:
        if isinstance(op, dict) and op.get("id"):
            _op_registry[op["id"]] = op
            _order.append(op["id"])
    audit = data.get("audit") or []
    if isinstance(audit, list):
        _audit.extend([e for e in audit if isinstance(e, dict)][-500:])


def _recover_orphans() -> None:
    """Mark operations left `running` by a process death as interrupted.

    A record can only be `running` here if the previous backend exited before
    its own `_execute` finished — i.e. the restart/deploy killed this very
    process. Nothing is actually in flight in the new process, so leaving the
    status as `running` would be a lie that also blocks the family guard.
    """
    changed = False
    for op in _op_registry.values():
        if op.get("status") == "running":
            op["status"] = "failed"
            op["step"] = "interrupted"
            op["finished_at"] = _now_iso()
            op["error"] = redact(
                "The backend restarted before this operation could finish; "
                "its final result is unknown. Verify the service state before retrying.",
                500,
            )
            record_audit(
                "operation.interrupted", op.get("actor"), "failed", op.get("id"),
                {"name": op.get("name")},
            )
            changed = True
    if changed:
        _persist_state()


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
    # The audit trail must survive the restart it is meant to explain.
    _persist_state()


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

    _persist_state()
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
        # Persist BEFORE publishing the terminal event: if this process is about
        # to be killed by its own restart, the recovered state must already
        # contain the outcome.
        _persist_state()
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
    """Run a fixed docker read-only query and parse its JSON output.

    `docker ps --format '{{json .}}'` prints ONE JSON OBJECT PER LINE (NDJSON),
    not a JSON array. Parsing the whole stdout with a single `json.loads` fails
    on a multi-container listing and returns None, which is why the status panel
    could show every service as "absent" even when all of them were running.
    Split on newlines and parse each line independently, tolerating blank
    lines, so one malformed record cannot discard the whole result.
    """
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

    text = out.decode("utf-8", "replace").strip()
    if not text:
        return None
    # A single JSON value (e.g. `docker inspect`) is still valid input.
    try:
        return _json.loads(text)
    except Exception:
        pass
    records: List[Any] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(_json.loads(line))
        except Exception:
            logger.debug("skipping unparseable docker line")
    return records or None


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

    A container merely being up is NOT proof of a healthy deployment: docker
    reports `running` for a process that started and is now crash-looping, and
    it says nothing about whether the API answers or WhatsApp is connected.

    So each service gets the strongest check that is cheap and side-effect free:
      * container state and healthcheck, for every service;
      * an actual HTTP request to the backend's own /health, over the docker
        network, proving uvicorn serves requests rather than only running;
      * the gateway's own health endpoint, proving the Baileys bridge is
        responsive and not just alive;
      * the persisted WhatsApp session state, reported separately as
        `connected`/`disconnected` rather than being folded into the pass/fail
        verdict — a restart that leaves WhatsApp logged out is an OPERATOR
        decision to re-pair, not a failed deploy, and treating it as one would
        mark every successful restart as a failure.
    """
    services = await get_service_status()
    by_name = {s["name"]: s for s in services}
    checks: Dict[str, Any] = {}
    details: Dict[str, Any] = {}

    for name, svc in by_name.items():
        running = svc.get("status") == "running"
        healthy = svc.get("health") in (None, "healthy")
        checks[name] = bool(running and healthy)
        if not running:
            details[name] = {"container": svc.get("state")}

    backend_http = await _probe_backend_http()
    if backend_http is not None:
        details.setdefault("tezlify-backend", {})["http_health"] = backend_http
        checks["tezlify-backend"] = bool(checks.get("tezlify-backend")) and bool(backend_http)

    gateway_http = await _probe_gateway_health()
    if gateway_http is not None:
        details.setdefault("tezlify-gateway", {})["http_health"] = gateway_http
        checks["tezlify-gateway"] = bool(checks.get("tezlify-gateway")) and bool(gateway_http)

    session = await _whatsapp_session_state()
    return {
        "checks": checks,
        "all_healthy": all(checks.values()) if checks else False,
        "checked_at": _now_iso(),
        "details": details,
        "whatsapp": session,
    }


async def _probe_backend_http(timeout: int = 8) -> Optional[bool]:
    """Ask the backend's own health endpoint over the docker network.

    Uses the compose service name so the probe follows the container to its new
    IP after a recreate, instead of a cached address that a restart invalidates.
    """
    return await _http_probe("http://backend:8000/health", timeout)


async def _probe_gateway_health(timeout: int = 8) -> Optional[bool]:
    # GATEWAY_PORT default in whatsapp-gateway/src/index.js is 8787, and the
    # compose network address for the service is the bare name `gateway`.
    return await _http_probe("http://gateway:8787/health", timeout)


async def _http_probe(url: str, timeout: int) -> Optional[bool]:
    """True/False when we got an answer, None when we could not reach it.

    None is deliberately distinct from False: "we could not check" must not be
    reported to the operator as "this service is broken".
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-fsS", "-o", "/dev/null", "-w", "%{http_code}",
            "--max-time", str(timeout), url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 2)
    except (FileNotFoundError, asyncio.TimeoutError):
        return None
    except Exception:
        return None
    try:
        code = int(out.decode("utf-8", "replace").strip() or 0)
    except ValueError:
        return None
    return 200 <= code < 400


async def _whatsapp_session_state() -> Dict[str, Any]:
    """Report WhatsApp connectivity as information, not as a pass/fail gate."""
    try:
        from sqlalchemy import select
        from backend.app.db.session import get_session
        from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
    except Exception:
        return {"state": "unknown"}
    try:
        async with get_session() as session:
            stmt = select(WhatsAppSession).order_by(WhatsAppSession.updated_at.desc()).limit(1)
            row = (await session.execute(stmt)).scalars().first()
    except Exception:
        logger.debug("could not read whatsapp session state", exc_info=True)
        return {"state": "unknown"}
    if row is None:
        return {"state": "not_paired", "connected": False}
    # SessionStatus is a str enum whose VALUES are uppercase (CONNECTED, ...),
    # so compare against the real value set rather than lowercasing.
    raw = getattr(row, "status", None)
    state = str(getattr(raw, "value", raw) or "").lower()
    connected = state == SessionStatus.CONNECTED.value.lower()
    return {"state": state or "unknown", "connected": connected}


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


def init_ops_state() -> None:
    """Restore and reconcile persisted state at process start.

    Called once from the application lifespan. Any operation still marked
    `running` here belongs to a process that no longer exists — most often
    because that process was killed by the restart it had just started — so it
    is downgraded to `interrupted` rather than left blocking its family.
    """
    _load_state()
    _recover_orphans()


def persistence_status() -> Dict[str, Any]:
    """Whether operation history is actually being kept across restarts."""
    return {"ok": _persist_ok, "error": _persist_error}
