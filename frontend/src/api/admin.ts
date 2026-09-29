import { API_BASE, authFetch, parseError } from './client';
import {
  AdminMonitoringResponse,
  AdminOverviewResponse,
  AdminWhatsAppResponse,
  AdminBackupsResponse,
  AdminDeploymentResponse,
  AdminSecurityResponse,
  OpsAuditEntry,
  OpsCatalogueEntry,
  OpsHealthCheck,
  OpsLogsResponse,
  OpsOperation,
  OpsStatusResponse,
} from '../types/admin';

export class AdminApi {
  /**
   * Fetches real-time host, container fleet, and database operations overview.
   */
  static async getOverview(): Promise<AdminOverviewResponse> {
    const res = await authFetch(`${API_BASE}/admin/overview`);
    if (!res.ok) {
      if (res.status === 403) throw new Error('ACCESS_DENIED');
      const errMsg = await parseError(res, 'Operasyon verileri şu anda alınamadı');
      throw new Error(errMsg);
    }
    return res.json();
  }

  /**
   * Fetches real-time WhatsApp gateway bridge, session fleet, socket ownership, outbox, and retry store.
   */
  static async getWhatsApp(): Promise<AdminWhatsAppResponse> {
    const res = await authFetch(`${API_BASE}/admin/whatsapp`);
    if (!res.ok) {
      if (res.status === 403) throw new Error('ACCESS_DENIED');
      const errMsg = await parseError(res, 'WhatsApp operasyon verileri şu anda alınamadı');
      throw new Error(errMsg);
    }
    return res.json();
  }

  /**
   * Fetches real-time system monitor timer, observer timer, R1-R13 invariants, and telemetry history.
   */
  static async getMonitoring(): Promise<AdminMonitoringResponse> {
    const res = await authFetch(`${API_BASE}/admin/monitoring`);
    if (!res.ok) {
      if (res.status === 403) throw new Error('ACCESS_DENIED');
      const errMsg = await parseError(res, 'İzleme verileri şu anda alınamadı');
      throw new Error(errMsg);
    }
    return res.json();
  }

  /**
   * Fetches read-only backup metadata: postgres, media, config file info and total disk usage.
   * Zero file content, zero binary download, zero mutations.
   */
  static async getBackups(): Promise<AdminBackupsResponse> {
    const res = await authFetch(`${API_BASE}/admin/backups`);
    if (!res.ok) {
      if (res.status === 403) throw new Error('ACCESS_DENIED');
      const errMsg = await parseError(res, 'Yedekleme verileri şu anda alınamadı');
      throw new Error(errMsg);
    }
    return res.json();
  }

  /**
   * Fetches read-only deployment and infrastructure metadata: source control, frontend releases, containers, host state.
   * Zero mutations, zero restarts, zero secrets.
   */
  static async getDeployment(): Promise<AdminDeploymentResponse> {
    const res = await authFetch(`${API_BASE}/admin/deployment`);
    if (!res.ok) {
      if (res.status === 403) throw new Error('ACCESS_DENIED');
      const errMsg = await parseError(res, 'Dağıtım verileri şu anda alınamadı');
      throw new Error(errMsg);
    }
    return res.json();
  }

  /**
   * Fetches read-only security hardening posture and audit telemetry.
   * Zero secrets, zero credential leakage, zero mutation operations.
   */
  static async getSecurity(): Promise<AdminSecurityResponse> {
    const res = await authFetch(`${API_BASE}/admin/security`);
    if (!res.ok) {
      if (res.status === 403) throw new Error('ACCESS_DENIED');
      const errMsg = await parseError(res, 'Güvenlik verileri şu anda alınamadı');
      throw new Error(errMsg);
    }
    return res.json();
  }
}

/**
 * Operations Center.
 *
 * `startOperation` accepts an operation NAME from the catalogue the server
 * returned — there is deliberately no way to pass a command. `confirm` must be
 * true for destructive operations. A 409 means the server already has a
 * sibling operation in flight, which the UI surfaces distinctly from a
 * validation error.
 */
export class OpsApi {
  private static async guard(res: Response, fallback: string): Promise<void> {
    if (res.ok) return;
    if (res.status === 403) throw new Error('ACCESS_DENIED');
    const msg = await parseError(res, fallback);
    throw new Error(msg);
  }

  static async getStatus(history = 20): Promise<OpsStatusResponse> {
    const res = await authFetch(`${API_BASE}/admin/ops/status?history=${history}`);
    await OpsApi.guard(res, 'Operasyon durumu alınamadı');
    return res.json();
  }

  static async getCatalogue(): Promise<OpsCatalogueEntry[]> {
    const res = await authFetch(`${API_BASE}/admin/ops/catalogue`);
    await OpsApi.guard(res, 'Operasyon listesi alınamadı');
    return res.json();
  }

  static async getHealth(): Promise<OpsHealthCheck> {
    const res = await authFetch(`${API_BASE}/admin/ops/health`);
    await OpsApi.guard(res, 'Sağlık durumu alınamadı');
    return res.json();
  }

  static async getLogs(service: string, tail = 200, level?: string): Promise<OpsLogsResponse> {
    const params = new URLSearchParams({ service, tail: String(tail) });
    if (level && level !== 'ALL') params.set('level', level);
    const res = await authFetch(`${API_BASE}/admin/ops/logs?${params.toString()}`);
    await OpsApi.guard(res, 'Loglar alınamadı');
    return res.json();
  }

  static async getAudit(limit = 100): Promise<OpsAuditEntry[]> {
    const res = await authFetch(`${API_BASE}/admin/ops/audit?limit=${limit}`);
    await OpsApi.guard(res, 'Denetim kaydı alınamadı');
    return res.json();
  }

  static async getOperation(id: string): Promise<OpsOperation> {
    const res = await authFetch(`${API_BASE}/admin/ops/operations/${encodeURIComponent(id)}`);
    await OpsApi.guard(res, 'Operasyon alınamadı');
    return res.json();
  }

  static async startOperation(name: string, confirm: boolean): Promise<OpsOperation> {
    const res = await authFetch(`${API_BASE}/admin/ops/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, confirm }),
    });
    await OpsApi.guard(res, 'Operasyon başlatılamadı');
    return res.json();
  }
}
