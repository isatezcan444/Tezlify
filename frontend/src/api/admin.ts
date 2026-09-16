import { API_BASE, authFetch, parseError } from './client';
import { AdminOverviewResponse } from '../types/admin';

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
}
