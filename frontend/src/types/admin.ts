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
