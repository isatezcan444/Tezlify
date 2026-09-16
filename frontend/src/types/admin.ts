/**
 * Admin & Operations Center TypeScript Definitions
 * Strictly maps the backend Phase 10.6.1 response DTOs.
 */

export type OverallSystemStatus = 'OK' | 'WARN' | 'CRITICAL';

export interface AdminSystemInfo {
  timestamp: string;
  load_average: number[];
  cpu_cores: number;
  memory_total_mb: number;
  memory_used_mb: number;
  memory_available_mb: number;
  disk_total_gb: number;
  disk_used_gb: number;
  disk_free_gb: number;
  disk_used_percent: number;
  uptime: string;
  reboot_required: boolean;
}

export interface AdminContainerInfo {
  name: string;
  status: string;
  started_at: string | null;
  restart_count: number;
  oom_killed: boolean;
  rss_mb: number;
}

export interface AdminDatabaseInfo {
  health: string;
  connections_total: number;
  connections_active: number;
  connections_idle: number;
  database_size_mb: number;
}

export interface AdminOverviewResponse {
  timestamp: string;
  overall_status: OverallSystemStatus;
  overall_status_reasons: string[];
  system: AdminSystemInfo;
  containers: AdminContainerInfo[];
  database: AdminDatabaseInfo;
}

// ---------------------------------------------------------------------------
// WhatsApp Operations Definitions
// ---------------------------------------------------------------------------

export interface AdminGatewayBridgeStatus {
  connected: boolean;
  reconnect_count: number;
  last_connected_at: string | null;
  last_event_at: string | null;
}

export interface AdminGatewayRuntimeStatus {
  health_status: string;
  session_count: number;
  connected_count: number;
  pending_qr_count: number;
}

export interface AdminDBSessionSummary {
  total: number;
  connected: number;
  scan_qr: number;
  relink_required: number;
}

export interface AdminWhatsAppSessionSummary {
  id: number;
  session_name: string;
  status: string;
  is_active: boolean;
  is_phone_online: boolean;
  phone_number_masked: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface AdminSocketLeasesStatus {
  active_count: number;
  duplicate_count: number;
  stale_count: number;
}

export interface AdminOutboxStatus {
  total: number;
  pending: number;
  in_flight: number;
  delivered: number;
  dead_letter: number;
}

export interface AdminRetryStatus {
  retry_backlog: number;
}

export interface AdminWhatsAppResponse {
  timestamp: string;
  gateway_bridge: AdminGatewayBridgeStatus;
  gateway_runtime: AdminGatewayRuntimeStatus;
  db_session_summary: AdminDBSessionSummary;
  sessions: AdminWhatsAppSessionSummary[];
  socket_leases: AdminSocketLeasesStatus;
  outbox: AdminOutboxStatus;
  retry: AdminRetryStatus;
}

// ---------------------------------------------------------------------------
// Monitoring & Reliability Definitions
// ---------------------------------------------------------------------------

export interface AdminTimerInfo {
  timer_status: string;
  interval: string;
  latest_run: string | null;
}

export interface AdminObservationMetadata {
  baseline_timestamp: string | null;
  latest_observation_timestamp: string | null;
  observed_duration: string | null;
  target_duration: string;
  observation_status: string;
  sample_count: number;
  elapsed_seconds?: number | null;
  target_seconds?: number;
  remaining_seconds?: number | null;
  progress_percent?: number | null;
}

export interface AdminInvariantStatus {
  id: string;
  name: string;
  passed: boolean;
  last_evaluated_at: string | null;
  safe_summary: string;
}

export interface AdminObservationRecord {
  timestamp: string;
  all_invariants_pass: boolean;
  loadavg: number[];
  active_socket_leases: number;
  outbox_pending: number;
  dead_letter: number;
  backend_rss_mb: number;
  gateway_rss_mb: number;
}

export interface AdminMonitoringResponse {
  timestamp: string;
  overall_status: OverallSystemStatus;
  overall_status_reasons: string[];
  system_monitor: AdminTimerInfo;
  whatsapp_observer: AdminTimerInfo;
  observation: AdminObservationMetadata;
  invariants: AdminInvariantStatus[];
  recent_observations: AdminObservationRecord[];
}

// ---------------------------------------------------------------------------
// Backup & Disaster Recovery Definitions
// ---------------------------------------------------------------------------

export interface AdminBackupFileInfo {
  latest_backup_filename: string | null;
  size_bytes: number | null;
  size_human: string | null;
  created_at: string | null;
  age_hours: number | null;
}

export interface AdminBackupDiskUsage {
  bytes: number;
  human: string;
}

export interface AdminBackupsResponse {
  timestamp: string;
  certification_status: string;
  off_host_status: string;
  postgres: AdminBackupFileInfo;
  media: AdminBackupFileInfo;
  config: AdminBackupFileInfo;
  total_backup_disk_usage: AdminBackupDiskUsage;
}
