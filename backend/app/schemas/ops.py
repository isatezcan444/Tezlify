"""Schemas for the WhatsApp Operations Center.

The operation surface is intentionally narrow: a request carries only an
operation NAME and a confirmation flag. There is no field anywhere in this
module that accepts a command, a service name, or any other string the backend
would pass to a shell.
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class OpsServiceStatus(BaseModel):
    """Live state of one container, read from the docker daemon."""

    name: str
    status: str
    state: Optional[str] = None
    image: Optional[str] = None
    health: Optional[str] = None
    uptime: Optional[str] = None
    started_at: Optional[str] = None
    restart_count: Optional[int] = None
    oom_killed: bool = False
    rss_mb: Optional[float] = None


class OpsHealthCheck(BaseModel):
    """Post-operation verification. A zero exit code is not health."""

    checks: Dict[str, bool] = Field(default_factory=dict)
    all_healthy: bool = False
    checked_at: str
    # Per-service probe detail (container state, HTTP probe result). Present so
    # an operator can see WHY a check failed instead of only that it did.
    details: Dict[str, Any] = Field(default_factory=dict)
    # WhatsApp connectivity, reported separately: a restart that leaves the
    # session logged out is an operator action to re-pair, not a failed deploy.
    whatsapp: Dict[str, Any] = Field(default_factory=dict)


class OpsOperation(BaseModel):
    """One operation's lifecycle record. Logs are already redacted."""

    id: str
    name: str
    label: str
    status: Literal["running", "succeeded", "failed"]
    step: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    duration_ms: Optional[int] = None
    actor: Optional[str] = None
    destructive: bool = False
    error: Optional[str] = None
    exit_code: Optional[int] = None
    logs: List[str] = Field(default_factory=list)
    health: Optional[OpsHealthCheck] = None
    # Multi-step progress. `deploy_full` runs pull -> build -> restart, so the
    # operator needs to see WHICH step is in flight, not just a spinner.
    current_step: Optional[str] = None
    total_steps: int = 1


class OpsCatalogueEntry(BaseModel):
    """Describes one callable operation. `name` is the only valid input."""

    name: str
    label: str
    destructive: bool
    # What the operation will actually do, so the confirmation dialog can show
    # the operator the real steps instead of a bare verb like "Deploy".
    description: str = ""


class OpsAuditEntry(BaseModel):
    id: str
    at: str
    action: str
    actor: Optional[str] = None
    result: str
    detail: Optional[str] = None


class OpsStatusResponse(BaseModel):
    """Everything the Operations Center needs for its status header."""

    services: List[OpsServiceStatus] = Field(default_factory=list)
    health: OpsHealthCheck
    operations: List[OpsOperation] = Field(default_factory=list)
    running: Optional[OpsOperation] = None
    catalogue: List[OpsCatalogueEntry] = Field(default_factory=list)
    audit: List[OpsAuditEntry] = Field(default_factory=list)
    # False when the deploy dir is not writable, so operation history is not
    # being kept across restarts. The UI must say so instead of pretending.
    persistence_ok: bool = True
    persistence_error: Optional[str] = None


class OpsLogsResponse(BaseModel):
    service: str
    lines: List[str] = Field(default_factory=list)
    error: Optional[str] = None


class OpsOperationRequest(BaseModel):
    """Start an allowlisted operation.

    `name` must match a key in the server-side allowlist. `confirm` is required
    for destructive operations. There is deliberately no `command`, `argv`,
    `service` or free-form argument field.
    """

    name: str = Field(..., min_length=1, max_length=64)
    confirm: bool = False
