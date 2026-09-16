import { API_BASE, authFetch, parseError } from './client';
import {
  AdminMonitoringResponse,
  AdminOverviewResponse,
  AdminWhatsAppResponse,
  AdminBackupsResponse,
  AdminDeploymentResponse,
  AdminSecurityResponse,
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
