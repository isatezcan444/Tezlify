"""WhatsApp Operations Center — HTTP surface.

Every route here is behind `require_admin` (fail-closed: 401 anonymous, 403
non-admin). The router is the only place that converts an HTTP request into a
service call, and it passes exactly three things: the operation NAME, the
confirmation flag, and the acting user. No request-supplied value is ever
forwarded into a command.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from backend.app.core.auth import AuthUser
from backend.app.auth.api.dependencies import require_admin
from backend.app.schemas.ops import (
    OpsAuditEntry,
    OpsCatalogueEntry,
    OpsHealthCheck,
    OpsLogsResponse,
    OpsOperation,
    OpsOperationRequest,
    OpsServiceStatus,
    OpsStatusResponse,
)
from backend.app.services.admin import ops_service as ops

logger = logging.getLogger(__name__)

router = APIRouter()


def _health(raw: dict) -> OpsHealthCheck:
    return OpsHealthCheck(
        checks=raw.get("checks", {}),
        all_healthy=bool(raw.get("all_healthy", False)),
        checked_at=raw.get("checked_at") or "",
    )


def _operation(raw: dict) -> OpsOperation:
    health = raw.get("health")
    return OpsOperation(
        id=raw["id"],
        name=raw["name"],
        label=raw["label"],
        status=raw["status"],
        step=raw.get("step"),
        started_at=raw.get("started_at"),
        finished_at=raw.get("finished_at"),
        duration_ms=raw.get("duration_ms"),
        actor=raw.get("actor"),
        destructive=bool(raw.get("destructive", False)),
        error=raw.get("error"),
        exit_code=raw.get("exit_code"),
        logs=raw.get("logs") or [],
        health=_health(health) if isinstance(health, dict) else None,
    )



@router.get("/status", response_model=OpsStatusResponse)
async def get_ops_status(
    current_admin: AuthUser = Depends(require_admin),
    history: int = Query(20, ge=1, le=50),
) -> OpsStatusResponse:
    """Live service state, recent operations, audit trail and the catalogue."""
    services = await ops.get_service_status()
    health_raw = await ops.run_health_check()
    running_raw = ops.running_operation()
    return OpsStatusResponse(
        services=[OpsServiceStatus(**s) for s in services],
        health=_health(health_raw),
        operations=[_operation(o) for o in ops.list_operations(limit=history)],
        running=_operation(running_raw) if running_raw else None,
        catalogue=[OpsCatalogueEntry(**c) for c in ops.available_operations()],
        audit=[OpsAuditEntry(**a) for a in ops.list_audit(limit=50)],
        # Surfaces a deploy dir that cannot be written. Without this the panel
        # would look healthy while silently losing every operation record.
        persistence_ok=ops.persistence_status()["ok"],
        persistence_error=ops.persistence_status()["error"],
    )


@router.get("/catalogue", response_model=list[OpsCatalogueEntry])
async def get_ops_catalogue(
    current_admin: AuthUser = Depends(require_admin),
) -> list[OpsCatalogueEntry]:
    """The allowlist. Only these names can ever be started."""
    return [OpsCatalogueEntry(**c) for c in ops.available_operations()]


@router.get("/logs", response_model=OpsLogsResponse)
async def get_ops_logs(
    service: str = Query(..., min_length=1, max_length=32),
    tail: int = Query(200, ge=1, le=500),
    level: Optional[str] = Query(None, max_length=16),
    current_admin: AuthUser = Depends(require_admin),
) -> OpsLogsResponse:
    """Bounded, redacted tail of one allowlisted container's logs."""
    try:
        result = await ops.get_service_logs(service=service, tail=tail, level=level)
    except ops.OperationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=exc.message
        ) from exc
    return OpsLogsResponse(**result)


@router.get("/health", response_model=OpsHealthCheck)
async def get_ops_health(
    current_admin: AuthUser = Depends(require_admin),
) -> OpsHealthCheck:
    """Per-service verification, independent of any operation."""
    return _health(await ops.run_health_check())


@router.get("/audit", response_model=list[OpsAuditEntry])
async def get_ops_audit(
    limit: int = Query(100, ge=1, le=500),
    current_admin: AuthUser = Depends(require_admin),
) -> list[OpsAuditEntry]:
    """Who ran what, when, and with what result."""
    return [OpsAuditEntry(**a) for a in ops.list_audit(limit=limit)]


@router.post("/operations", response_model=OpsOperation, status_code=status.HTTP_202_ACCEPTED)
async def start_operation(
    payload: OpsOperationRequest,
    current_admin: AuthUser = Depends(require_admin),
) -> OpsOperation:
    """Start one allowlisted operation.

    Returns 202: the operation continues on the server even if the browser
    closes the tab. The caller re-attaches via `GET /operations/{id}`.
    """
    try:
        record = await ops.start_operation(
            name=payload.name,
            actor=current_admin.email or current_admin.id,
            user_id=current_admin.id,
            confirm=payload.confirm,
        )
    except ops.OperationError as exc:
        # 409 for "something is already running" so the UI can tell a conflict
        # apart from a bad request; 400 for validation problems.
        conflict = exc.code in ("operation_in_progress", "operation_cooldown")
        raise HTTPException(
            status_code=(
                status.HTTP_409_CONFLICT if conflict else status.HTTP_400_BAD_REQUEST
            ),
            detail=exc.message,
        ) from exc
    return _operation(record)


@router.get("/operations", response_model=list[OpsOperation])
async def list_operations(
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0, le=500),
    status: Optional[str] = Query(None, max_length=20),
    name: Optional[str] = Query(None, max_length=80),
    current_admin: AuthUser = Depends(require_admin),
) -> list[OpsOperation]:
    """Newest-first operation history, paged and filterable.

    The panel previously showed a fixed newest-20 window, so an operator could
    not answer "what did we deploy last Tuesday" even though the record was
    retained. Paging over the kept window is the point of keeping it.
    """
    return [
        _operation(o)
        for o in ops.list_operations(limit=limit, offset=offset, status=status, name=name)
    ]


@router.get("/operations/{operation_id}", response_model=OpsOperation)
async def get_operation(
    operation_id: str,
    current_admin: AuthUser = Depends(require_admin),
) -> OpsOperation:
    """Re-attach to an operation after a browser refresh."""
    record = ops.get_operation(operation_id)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found"
        )
    return _operation(record)
