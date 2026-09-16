import { API_BASE, authFetch, parseError } from './client';
import { AdminOverviewResponse, AdminWhatsAppResponse } from '../types/admin';

export class AdminApi {
  /**
   * Fetches real-time host, container fleet, and database operations overview.
   */
  static async getOverview(): Promise<AdminOverviewResponse> {
    const res = await authFetch(`${API_BASE}/admin/overview`);
    if (!res.ok) {
      if (res.status === 403) {
        throw new Error('ACCESS_DENIED');
      }
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
      if (res.status === 403) {
        throw new Error('ACCESS_DENIED');
      }
      const errMsg = await parseError(res, 'WhatsApp operasyon verileri şu anda alınamadı');
      throw new Error(errMsg);
    }
    return res.json();
  }
}
