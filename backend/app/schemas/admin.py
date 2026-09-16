"""Pydantic schemas for the Read-Only Admin / Operations Center API.

Invariants:
- All models use ConfigDict(extra="forbid") to prevent unintended data attachment.
- Explicit schema definitions ensure zero secret, token, password, or private key leakage.
- Phone numbers are masked; message bodies and raw payloads are strictly excluded.
"""

from typing import Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Overview Schemas
# ---------------------------------------------------------------------------

class AdminSystemInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    load_average: List[float] = Field(default_factory=list, description="[1m, 5m, 15m] load average")
    cpu_cores: int = 1
    memory_total_mb: float = 0.0
    memory_used_mb: float = 0.0
    memory_available_mb: float = 0.0
    disk_total_gb: float = 0.0
    disk_used_gb: float = 0.0
    disk_free_gb: float = 0.0
    disk_used_percent: float = 0.0
    uptime: str = "unknown"
    reboot_required: bool = False


class AdminContainerInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    status: str
    started_at: Optional[str] = None
    restart_count: int = 0
    oom_killed: bool = False
    rss_mb: float = 0.0


class AdminDatabaseInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    health: str
    connections_total: int = 0
    connections_active: int = 0
    connections_idle: int = 0
    database_size_mb: float = 0.0


class AdminOverviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    overall_status: str = Field(description="'OK', 'WARN', or 'CRITICAL'")
    overall_status_reasons: List[str] = Field(default_factory=list)
    system: AdminSystemInfo
    containers: List[AdminContainerInfo]
    database: AdminDatabaseInfo


# ---------------------------------------------------------------------------
# WhatsApp Operations Schemas
# ---------------------------------------------------------------------------

class AdminGatewayBridgeStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connected: bool = False
    reconnect_count: int = 0
    last_connected_at: Optional[str] = None
    last_event_at: Optional[str] = None


class AdminGatewayRuntimeStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    health_status: str = "unknown"
    session_count: int = 0
    connected_count: int = 0
    pending_qr_count: int = 0


class AdminDBSessionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: int = 0
    connected: int = 0
    scan_qr: int = 0
    relink_required: int = 0


class AdminWhatsAppSessionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    session_name: str
    status: str
    is_active: bool
    is_phone_online: bool
    phone_number_masked: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class AdminSocketLeasesStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    active_count: int = 0
    duplicate_count: int = 0
    stale_count: int = 0


class AdminOutboxStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: int = 0
    pending: int = 0
    in_flight: int = 0
    delivered: int = 0
    dead_letter: int = 0


class AdminRetryStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    retry_backlog: int = 0


class AdminWhatsAppResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    gateway_bridge: AdminGatewayBridgeStatus
    gateway_runtime: AdminGatewayRuntimeStatus
    db_session_summary: AdminDBSessionSummary
    sessions: List[AdminWhatsAppSessionSummary] = Field(default_factory=list)
    socket_leases: AdminSocketLeasesStatus
    outbox: AdminOutboxStatus
    retry: AdminRetryStatus


# ---------------------------------------------------------------------------
# Monitoring Schemas
# ---------------------------------------------------------------------------

class AdminTimerInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timer_status: str = "unknown"
    interval: str = "unknown"
    latest_run: Optional[str] = None


class AdminObservationMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baseline_timestamp: Optional[str] = None
    latest_observation_timestamp: Optional[str] = None
    observed_duration: Optional[str] = None
    target_duration: str = "72 hours"
    observation_status: str = "OBSERVATION_WINDOW_INCOMPLETE"
    sample_count: int = 0
    elapsed_seconds: Optional[float] = None
    target_seconds: float = 259200.0
    remaining_seconds: Optional[float] = None
    progress_percent: Optional[float] = None


class AdminInvariantStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    passed: bool
    last_evaluated_at: Optional[str] = None
    safe_summary: str


class AdminObservationRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    all_invariants_pass: bool
    loadavg: List[float] = Field(default_factory=list)
    active_socket_leases: int = 0
    outbox_pending: int = 0
    dead_letter: int = 0
    backend_rss_mb: float = 0.0
    gateway_rss_mb: float = 0.0


class AdminMonitoringResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    overall_status: str = Field(default="OK", description="'OK', 'WARN', or 'CRITICAL'")
    overall_status_reasons: List[str] = Field(default_factory=list)
    system_monitor: AdminTimerInfo
    whatsapp_observer: AdminTimerInfo
    observation: AdminObservationMetadata
    invariants: List[AdminInvariantStatus] = Field(default_factory=list)
    recent_observations: List[AdminObservationRecord] = Field(default_factory=list)



# ---------------------------------------------------------------------------
# Backups Schemas
# ---------------------------------------------------------------------------

class AdminBackupFileInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    latest_backup_filename: Optional[str] = None
    size_bytes: Optional[int] = None
    size_human: Optional[str] = None
    created_at: Optional[str] = None
    age_hours: Optional[float] = None


class AdminBackupDiskUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bytes: int = 0
    human: str = "0 B"


class AdminBackupsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    certification_status: str = "BACKUP_RESTORE_VERIFIED"
    off_host_status: str = "OFF_HOST_BACKUP_NOT_CONFIGURED"
    postgres: AdminBackupFileInfo
    media: AdminBackupFileInfo
    config: AdminBackupFileInfo
    total_backup_disk_usage: AdminBackupDiskUsage


# ---------------------------------------------------------------------------
# Deployment Schemas
# ---------------------------------------------------------------------------

class AdminGitState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    branch: Optional[str] = None
    commit_hash: Optional[str] = None
    commit_message: Optional[str] = None
    commit_timestamp: Optional[str] = None
    working_tree_clean: Optional[bool] = None


class AdminFrontendReleaseInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_release: str = "v20260916_phase10_6_5"
    current_symlink: str = "/opt/tezlify/frontend_current"
    candidate_symlink: Optional[str] = "/opt/tezlify/frontend_candidate"
    next_symlink: Optional[str] = "/opt/tezlify/frontend_next"
    deployed_commit: Optional[str] = None
    deployed_at: Optional[str] = None
    js_asset: Optional[str] = None
    css_asset: Optional[str] = None


class AdminContainerDeploymentState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    image: Optional[str] = None
    status: str
    started_at: Optional[str] = None
    restart_count: int = 0
    oom_killed: bool = False
    health: Optional[str] = None
    short_id: Optional[str] = None
    rss_mb: Optional[float] = None


class AdminHostDeploymentState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    distro: str = "unknown"
    kernel: str = "unknown"
    architecture: str = "unknown"
    cpu_cores: int = 1
    memory_total_mb: float = 0.0
    uptime: str = "unknown"
    reboot_required: bool = False


class AdminDeploymentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    environment: str = "production"
    branch: Optional[str] = None
    commit_hash: Optional[str] = None
    commit_message: Optional[str] = None
    commit_timestamp: Optional[str] = None
    working_tree_clean: Optional[bool] = None
    deployment_directory: str = "/opt/tezlify"
    kernel: str = "unknown"
    distro: str = "unknown"
    reboot_required: bool = False

    # Enhanced optional fields
    overall_status: Optional[str] = None
    release_readiness: Optional[str] = None
    git: Optional[AdminGitState] = None
    frontend: Optional[AdminFrontendReleaseInfo] = None
    containers: Optional[List[AdminContainerDeploymentState]] = None
    host: Optional[AdminHostDeploymentState] = None


# ---------------------------------------------------------------------------
# Security Audit Schemas
# ---------------------------------------------------------------------------

class AdminSSHSecurityInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    permit_root_login: str = "unknown"
    password_authentication: str = "unknown"
    pubkey_authentication: str = "unknown"
    max_auth_tries: Optional[int] = None
    status: str = "UNKNOWN"


class AdminFirewallSecurityInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ufw_active: bool = False
    allowed_ports: List[str] = Field(default_factory=list)
    public_ports: List[str] = Field(default_factory=lambda: ["22/tcp", "80/tcp", "443/tcp"])
    internal_ports: List[str] = Field(default_factory=lambda: ["8000/tcp", "8787/tcp", "5432/tcp"])
    status: str = "UNKNOWN"


class AdminContainerItemSecurity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    base_os: str = "Linux"
    privileged: bool = False
    user: str = "root"
    docker_socket_mounted: bool = False
    host_ports: List[str] = Field(default_factory=list)
    status: str = "SECURE"


class AdminContainerSecurityInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    privileged: bool = False
    docker_socket_mounted: bool = False
    status: str = "SECURE"


class AdminCaddySecurityInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    security_headers_state: str = "CONFIGURED"
    hsts_status: str = "NOT_ENABLED_BY_DESIGN"
    csp_status: str = "NOT_CONFIGURED"
    details: Dict[str, str] = Field(default_factory=dict)


class AdminFail2BanSecurityInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str = "NOT_CONFIGURED"


class AdminPostgresSecurityInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    internal_only: bool = True
    auth_encryption: str = "scram-sha-256"
    public_exposure: bool = False
    status: str = "SECURE"


class AdminKernelSecurityInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    distro: str = "Ubuntu 24.04.4 LTS"
    container_distro: Optional[str] = None
    kernel: str = "6.17.0-1020-oracle"
    architecture: str = "aarch64"
    reboot_required: bool = False
    status: str = "SECURE"


class AdminSecurityResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    overall_status: str = "PASS"
    certification_status: str = "SECURITY_HARDENING_VERIFIED"
    ssh: AdminSSHSecurityInfo
    firewall: AdminFirewallSecurityInfo
    container: AdminContainerSecurityInfo
    caddy: AdminCaddySecurityInfo
    fail2ban: AdminFail2BanSecurityInfo
    containers: List[AdminContainerItemSecurity] = Field(default_factory=list)
    postgresql: Optional[AdminPostgresSecurityInfo] = None
    kernel: Optional[AdminKernelSecurityInfo] = None
    warnings: List[str] = Field(default_factory=list)
