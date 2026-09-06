import { 
  Lead, 
  Campaign, 
  WhatsAppSession, 
  DashboardStats, 
  ScraperJob, 
  MessageLog, 
  BlacklistEntry, 
  BlacklistPaginationResponse, 
  AntiBanConfig,
  Conversation,
  ConversationDetail,
  ConversationMessagesResponse,
  ConversationStatus,
  Message,
  WhatsAppTemplate,
  GenerateMessagePayload,
  GenerateMessageResponse,
  CampaignGroup,
  CampaignGroupDetail,
  CampaignGroupCreatePayload,
  AddLeadsToGroupResponse,
} from '../types';

const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const isRemoteHost = typeof window !== 'undefined' && host !== 'localhost' && host !== '127.0.0.1';

function resolveApiBase(): string {
  const envApi = import.meta.env?.VITE_API_URL as string | undefined;
  if (envApi) {
    return envApi.endsWith('/api/v1') ? envApi : `${envApi.replace(/\/$/, '')}/api/v1`;
  }
  if (isRemoteHost) {
    return 'https://tezlify.onrender.com/api/v1';
  }
  return `http://${host}:8000/api/v1`;
}

function resolveWsUrl(): string {
  const envWs = import.meta.env?.VITE_WS_URL as string | undefined;
  if (envWs) {
    if (isHttps && envWs.startsWith('ws://')) {
      return envWs.replace(/^ws:\/\//i, 'wss://');
    }
    return envWs;
  }
  const envApi = import.meta.env?.VITE_API_URL as string | undefined;
  if (envApi) {
    const wsProto = envApi.startsWith('https://') || isHttps ? 'wss://' : 'ws://';
    const cleanHost = envApi.replace(/^https?:\/\//i, '').replace(/\/api\/v1\/?$/i, '').replace(/\/$/, '');
    return `${wsProto}${cleanHost}/ws`;
  }
  if (isRemoteHost) {
    return 'wss://tezlify.onrender.com/ws';
  }
  const wsProto = isHttps ? 'wss://' : 'ws://';
  return `${wsProto}${host}:8000/ws`;
}

export const API_BASE = resolveApiBase();
export const WS_URL = resolveWsUrl();

export class ApiClient {
  // --- Analytics ---
  static async getDashboardStats(): Promise<DashboardStats> {
    const res = await fetch(`${API_BASE}/analytics/dashboard`);
    if (!res.ok) throw new Error('Failed to fetch dashboard stats');
    return res.json();
  }

  // --- Leads ---
  static async getLeads(params: {
    page?: number;
    size?: number;
    search?: string;
    city?: string;
    district?: string;
    districts?: string[];
    category?: string;
    categories?: string[];
    status?: string;
    whatsapp_eligible_only?: boolean;
  }): Promise<{ items: Lead[]; total: number; page: number; size: number; pages: number }> {
    const query = new URLSearchParams();
    if (params.page) query.set('page', params.page.toString());
    if (params.size) query.set('size', params.size.toString());
    if (params.search) query.set('search', params.search);
    if (params.city) query.set('city', params.city);
    if (params.district) query.set('district', params.district);
    if (params.districts && params.districts.length > 0) {
      params.districts.forEach(d => query.append('districts', d));
    }
    if (params.category) query.set('category', params.category);
    if (params.categories && params.categories.length > 0) {
      params.categories.forEach(c => query.append('categories', c));
    }
    if (params.status) query.set('status', params.status);
    if (params.whatsapp_eligible_only) query.set('whatsapp_eligible_only', 'true');

    const res = await fetch(`${API_BASE}/leads?${query.toString()}`);
    if (!res.ok) throw new Error('Failed to fetch leads');
    return res.json();
  }

  static async getLead(id: number): Promise<Lead> {
    const res = await fetch(`${API_BASE}/leads/${id}`);
    if (!res.ok) throw new Error('Lead detayı yüklenemedi');
    return res.json();
  }

  static async getLeadCategories(): Promise<string[]> {
    const res = await fetch(`${API_BASE}/leads/categories`);
    if (!res.ok) return [];
    return res.json();
  }

  static async createLead(lead: Partial<Lead>): Promise<Lead> {
    const res = await fetch(`${API_BASE}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Lead oluşturulamadı');
    }
    return res.json();
  }

  static async updateLead(id: number, lead: Partial<Lead>): Promise<Lead> {
    const res = await fetch(`${API_BASE}/leads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    });
    if (!res.ok) throw new Error('Lead güncellenemedi');
    return res.json();
  }

  static async deleteLead(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/leads/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Lead silinemedi');
  }

  static async bulkDeleteLeads(payload: {
    lead_ids?: number[];
    delete_all_matching?: boolean;
    search?: string;
    city?: string;
    districts?: string[];
    categories?: string[];
    status?: string;
    whatsapp_eligible_only?: boolean;
  }): Promise<{ deleted_count: number }> {
    const res = await fetch(`${API_BASE}/leads/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Toplu silme işlemi başarısız oldu');
    return res.json();
  }

  static async bulkBlacklistLeads(payload: {
    lead_ids?: number[];
    blacklist_all_matching?: boolean;
    reason?: string;
    search?: string;
    city?: string;
    districts?: string[];
    categories?: string[];
    status?: string;
    whatsapp_eligible_only?: boolean;
  }): Promise<{ blacklisted_count: number; leads_updated: number }> {
    const res = await fetch(`${API_BASE}/leads/bulk-blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Toplu kara listeye ekleme işlemi başarısız oldu');
    return res.json();
  }

  static async exportCsv(filters: any = {}): Promise<void> {
    const res = await fetch(`${API_BASE}/leads/export/csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filters)
    });
    if (!res.ok) {
      throw new Error('CSV dışa aktarma başarısız oldu');
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tezlify_leads_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }

  static async exportExcel(filters: any = {}): Promise<void> {
    const res = await fetch(`${API_BASE}/leads/export/excel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filters)
    });
    if (!res.ok) {
      throw new Error('Excel dışa aktarma başarısız oldu');
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tezlify_leads_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }

  // --- Scraper ---
  static async startScraper(params: { keyword: string; city: string; districts: string[]; max_results: number }): Promise<ScraperJob> {
    const res = await fetch(`${API_BASE}/scraper/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Tarama başlatılamadı');
    }
    return res.json();
  }

  static async cancelScraper(jobId: number): Promise<ScraperJob> {
    const res = await fetch(`${API_BASE}/scraper/cancel/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('Tarama iptal edilemedi');
    return res.json();
  }

  static async getScraperJobs(): Promise<ScraperJob[]> {
    const res = await fetch(`${API_BASE}/scraper/jobs`);
    if (!res.ok) throw new Error('Failed to fetch scraper jobs');
    return res.json();
  }

  static async getScraperJob(jobId: number): Promise<ScraperJob> {
    const res = await fetch(`${API_BASE}/scraper/jobs/${jobId}`);
    if (!res.ok) throw new Error('Failed to fetch scraper job details');
    return res.json();
  }

  static async saveScraperLeads(jobId: number, leads: any[]): Promise<{ job_id: number; saved: any[]; new_count: number; updated_count: number }> {
    const res = await fetch(`${API_BASE}/scraper/jobs/${jobId}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leads })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Sonuçlar kaydedilemedi');
    }
    return res.json();
  }

  // --- Campaigns ---
  static async getCampaigns(): Promise<Campaign[]> {
    const res = await fetch(`${API_BASE}/campaigns`);
    if (!res.ok) throw new Error('Failed to fetch campaigns');
    return res.json();
  }

  static async createCampaign(campaign: Partial<Campaign>): Promise<Campaign> {
    const res = await fetch(`${API_BASE}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(campaign)
    });
    if (!res.ok) throw new Error('Kampanya oluşturulamadı');
    return res.json();
  }

  static async deleteCampaign(campaignId: number): Promise<void> {
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Kampanya silinemedi');
    }
  }

  static async bulkDeleteCampaigns(campaignIds: number[]): Promise<{ deleted_count: number; message: string }> {
    const res = await fetch(`${API_BASE}/campaigns/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_ids: campaignIds }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Toplu kampanya silme işlemi başarısız oldu');
    }
    return res.json();
  }

  // --- Campaign Groups ---
  static async getCampaignGroups(): Promise<CampaignGroup[]> {
    const res = await fetch(`${API_BASE}/campaign-groups`);
    if (!res.ok) throw new Error('Kampanya grupları yüklenemedi');
    return res.json();
  }

  static async getCampaignGroup(id: number): Promise<CampaignGroupDetail> {
    const res = await fetch(`${API_BASE}/campaign-groups/${id}`);
    if (!res.ok) throw new Error('Kampanya grubu detayı yüklenemedi');
    return res.json();
  }

  static async createCampaignGroup(data: CampaignGroupCreatePayload): Promise<CampaignGroup> {
    const res = await fetch(`${API_BASE}/campaign-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Kampanya grubu oluşturulamadı');
    }
    return res.json();
  }

  static async updateCampaignGroup(id: number, data: Partial<CampaignGroupCreatePayload>): Promise<CampaignGroup> {
    const res = await fetch(`${API_BASE}/campaign-groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Kampanya grubu güncellenemedi');
    }
    return res.json();
  }

  static async deleteCampaignGroup(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/campaign-groups/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Kampanya grubu silinemedi');
    }
  }

  static async bulkDeleteCampaignGroups(groupIds: number[]): Promise<{ deleted_count: number; message: string }> {
    const res = await fetch(`${API_BASE}/campaign-groups/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_ids: groupIds }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Toplu kampanya grubu silme işlemi başarısız oldu');
    }
    return res.json();
  }

  static async addLeadsToCampaignGroup(groupId: number, leadIds: number[]): Promise<AddLeadsToGroupResponse> {
    const res = await fetch(`${API_BASE}/campaign-groups/${groupId}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_ids: leadIds }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'İşletmeler gruba eklenemedi');
    }
    return res.json();
  }

  static async removeLeadFromCampaignGroup(
    groupId: number,
    leadId: number
  ): Promise<{ message: string; total_leads_count: number; whatsapp_eligible_count: number }> {
    const res = await fetch(`${API_BASE}/campaign-groups/${groupId}/leads/${leadId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'İşletme gruptan çıkarılamadı');
    }
    return res.json();
  }

  static async generateCampaignMessage(payload: GenerateMessagePayload): Promise<GenerateMessageResponse> {
    const res = await fetch(`${API_BASE}/campaigns/generate-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Mesaj oluşturulamadı');
    }
    return res.json();
  }

  static async previewSpintax(template: string, count: number = 5): Promise<{ permutations_count: number; samples: string[] }> {
    const res = await fetch(`${API_BASE}/campaigns/spintax/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template, count })
    });
    if (!res.ok) throw new Error('Spintax önizleme hatası');
    return res.json();
  }

  static async launchCampaign(campaignId: number, params: { lead_ids?: number[]; limit?: number } = {}): Promise<any> {
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Kampanya başlatılamadı');
    }
    return res.json();
  }

  static async pauseCampaign(campaignId: number): Promise<any> {
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/pause`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Kampanya duraklatılamadı');
    return res.json();
  }

  // --- Settings & Anti-Ban Suite ---
  static async getAntiBanSettings(): Promise<AntiBanConfig> {
    const res = await fetch(`${API_BASE}/settings/antiban`);
    if (!res.ok) throw new Error('Anti-ban ayarları alınamadı');
    return res.json();
  }

  static async updateAntiBanSettings(settings: Partial<AntiBanConfig>): Promise<AntiBanConfig> {
    const res = await fetch(`${API_BASE}/settings/antiban`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!res.ok) throw new Error('Anti-ban ayarları güncellenemedi');
    return res.json();
  }

  // --- WhatsApp ---
  static async getWhatsAppSessions(): Promise<WhatsAppSession[]> {
    const res = await fetch(`${API_BASE}/whatsapp/sessions`);
    if (!res.ok) throw new Error('Failed to fetch WhatsApp sessions');
    return res.json();
  }

  static async createWhatsAppSession(name: string, maxDailyLimit: number = 50): Promise<WhatsAppSession> {
    const res = await fetch(`${API_BASE}/whatsapp/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_name: name, max_daily_limit: maxDailyLimit })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Oturum oluşturulamadı');
    }
    return res.json();
  }

  static async simulateConnectSession(sessionId: number): Promise<any> {
    const res = await fetch(`${API_BASE}/whatsapp/sessions/${sessionId}/connect-demo`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Oturum bağlanamadı');
    return res.json();
  }

  static async disconnectSession(sessionId: number): Promise<any> {
    const res = await fetch(`${API_BASE}/whatsapp/sessions/${sessionId}/disconnect`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error('Oturum kesilemedi');
    return res.json();
  }

  static async deleteSession(sessionId: number): Promise<void> {
    const res = await fetch(`${API_BASE}/whatsapp/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Oturum silinemedi');
  }

  static async sendTestMessage(phone: string, message: string, sessionId?: number): Promise<any> {
    const res = await fetch(`${API_BASE}/whatsapp/send-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_e164: phone, message, session_id: sessionId })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Test mesajı gönderilemedi');
    }
    return res.json();
  }

  static async sendSingleMessage(payload: { phone: string; message: string; lead_id?: number }): Promise<any> {
    return this.sendTestMessage(payload.phone, payload.message);
  }

  static async getMessageLogs(): Promise<MessageLog[]> {
    const res = await fetch(`${API_BASE}/whatsapp/logs`);
    if (!res.ok) throw new Error('Failed to fetch message logs');
    return res.json();
  }

  // --- Blacklist ---
  static async getBlacklist(params?: {
    page?: number;
    size?: number;
    search?: string;
    reason?: string;
  }): Promise<BlacklistPaginationResponse> {
    const query = new URLSearchParams();
    if (params?.page) query.append('page', params.page.toString());
    if (params?.size) query.append('size', params.size.toString());
    if (params?.search) query.append('search', params.search);
    if (params?.reason) query.append('reason', params.reason);

    const qs = query.toString();
    const url = qs ? `${API_BASE}/blacklist?${qs}` : `${API_BASE}/blacklist`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Kara liste yüklenirken hata oluştu');
    return res.json();
  }

  static async addToBlacklist(phone: string, reason: string = 'USER_REQUEST'): Promise<BlacklistEntry> {
    const res = await fetch(`${API_BASE}/blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_e164: phone, reason })
    });
    if (!res.ok) throw new Error('Numara kara listeye eklenemedi');
    return res.json();
  }

  static async addBlacklist(payload: { phone: string; reason?: string } | string, reason?: string): Promise<BlacklistEntry> {
    if (typeof payload === 'string') {
      return this.addToBlacklist(payload, reason || 'USER_REQUEST');
    }
    return this.addToBlacklist(payload.phone, payload.reason || 'USER_REQUEST');
  }

  static async removeFromBlacklist(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/blacklist/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Numara kara listeden silinemedi');
  }

  static async bulkRemoveFromBlacklist(payload: {
    ids?: number[];
    delete_all_matching?: boolean;
    search?: string;
    reason?: string;
  } | number[]): Promise<{ deleted_count: number }> {
    const body = Array.isArray(payload) ? { ids: payload } : payload;
    const res = await fetch(`${API_BASE}/blacklist/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('Toplu kara listeden silme işlemi başarısız oldu');
    return res.json();
  }

  // --- Conversations & WhatsApp Chat ---
  static async getConversations(params?: {
    status?: ConversationStatus;
    unread_only?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.unread_only) query.set('unread_only', 'true');
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const res = await fetch(`${API_BASE}/conversations?${query.toString()}`);
    if (!res.ok) throw new Error('Konuşmalar yüklenemedi');
    return res.json();
  }

  static async updateConversationStatus(
    conversationId: number,
    status: ConversationStatus
  ): Promise<Conversation> {
    const res = await fetch(`${API_BASE}/conversations/${conversationId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error('Konuşma durumu güncellenemedi');
    return res.json();
  }

  static async getConversation(
    conversationId: number,
    params?: { limit?: number; before?: number }
  ): Promise<ConversationDetail> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.before) query.set('before', params.before.toString());
    const qStr = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(`${API_BASE}/conversations/${conversationId}${qStr}`);
    if (!res.ok) throw new Error('Konuşma detayı yüklenemedi');
    return res.json();
  }

  static async getConversationMessages(
    conversationId: number,
    params?: { limit?: number; before?: number }
  ): Promise<ConversationMessagesResponse> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.before) query.set('before', params.before.toString());
    const qStr = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(`${API_BASE}/conversations/${conversationId}/messages${qStr}`);
    if (!res.ok) throw new Error('Mesajlar yüklenemedi');
    return res.json();
  }

  static async sendMessage(
    conversationId: number,
    body: string,
    idempotencyKey?: string
  ): Promise<Message> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) {
      headers['X-Idempotency-Key'] = idempotencyKey;
    }
    const res = await fetch(`${API_BASE}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body, type: 'text' }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || 'Mesaj gönderilemedi');
    }
    return res.json();
  }

  static async getLeadConversation(
    leadId: number,
    params?: { limit?: number; before?: number }
  ): Promise<ConversationDetail> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.before) query.set('before', params.before.toString());
    const qStr = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(`${API_BASE}/conversations/lead/${leadId}${qStr}`);
    if (!res.ok) throw new Error('Lead konuşması yüklenemedi');
    return res.json();
  }

  static async getTemplates(): Promise<WhatsAppTemplate[]> {
    const res = await fetch(`${API_BASE}/conversations/templates`);
    if (!res.ok) throw new Error('Şablonlar yüklenemedi');
    return res.json();
  }

  static async sendTemplate(
    conversationId: number,
    templateKey: string,
    variables: Record<string, string> = {},
    idempotencyKey?: string
  ): Promise<Message> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) {
      headers['X-Idempotency-Key'] = idempotencyKey;
    }
    const res = await fetch(`${API_BASE}/conversations/${conversationId}/templates/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ template_key: templateKey, variables }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || 'Şablon mesajı gönderilemedi');
    }
    return res.json();
  }

  static async retryMessage(
    conversationId: number,
    messageId: number
  ): Promise<Message> {
    const res = await fetch(`${API_BASE}/conversations/${conversationId}/messages/${messageId}/retry`, {
      method: 'POST',
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || 'Mesaj tekrar gönderilemedi');
    }
    return res.json();
  }

  static async sendMedia(
    conversationId: number,
    mediaData: { media_type: string; media_url: string; caption?: string; filename?: string },
    idempotencyKey?: string
  ): Promise<Message> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) {
      headers['X-Idempotency-Key'] = idempotencyKey;
    }
    const res = await fetch(`${API_BASE}/conversations/${conversationId}/media`, {
      method: 'POST',
      headers,
      body: JSON.stringify(mediaData),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || 'Medya gönderilemedi');
    }
    return res.json();
  }

  static async markConversationAsRead(conversationId: number): Promise<Conversation> {
    const res = await fetch(`${API_BASE}/conversations/${conversationId}/read`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('Konuşma okundu olarak işaretlenemedi');
    return res.json();
  }

  static async markLeadConversationAsRead(leadId: number): Promise<Conversation> {
    const res = await fetch(`${API_BASE}/conversations/lead/${leadId}/read`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('Lead konuşması okundu olarak işaretlenemedi');
    return res.json();
  }

  // --- Smart Outreach & Category Confirmation ---
  static async recommendCategories(payload: {
    offer_title: string;
    offer_description?: string;
    business_goal?: string;
    target_sector_hint?: string;
  }): Promise<import('../types').CategoryRecommendationResponse> {
    const res = await fetch(`${API_BASE}/smart-outreach/recommend-categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Kategori önerisi alınamadı' }));
      throw new Error(err.detail || 'Kategori önerisi alınamadı');
    }
    return res.json();
  }

  static async matchLeads(payload: {
    offer_title: string;
    offer_description?: string;
    business_goal?: string;
    approved_target_categories?: string[];
    lead_ids?: number[];
    city?: string;
    category_filter?: string;
    min_fit_score?: number;
  }): Promise<import('../types').MatchLeadsResponse> {
    const res = await fetch(`${API_BASE}/smart-outreach/match-leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Müşteri eşleştirmesi yapılamadı' }));
      throw new Error(err.detail || 'Müşteri eşleştirmesi yapılamadı');
    }
    return res.json();
  }

  static async recommendMessage(payload: {
    lead_id: number;
    offer_title: string;
    offer_description?: string;
    business_goal?: string;
    target_category?: string;
  }): Promise<import('../types').MessageRecommendationResponse> {
    const res = await fetch(`${API_BASE}/smart-outreach/recommend-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Mesaj önerisi alınamadı' }));
      throw new Error(err.detail || 'Mesaj önerisi alınamadı');
    }
    return res.json();
  }

  static async startTargetedDiscovery(payload: {
    offer_title: string;
    offer_description?: string;
    business_goal?: string;
    city: string;
    districts?: string[];
    approved_target_categories: string[];
    user_added_categories?: string[];
    max_results_per_category?: number;
  }): Promise<{ status: string; approved_categories_count: number; job_ids: number[]; message: string }> {
    const res = await fetch(`${API_BASE}/smart-outreach/start-targeted-discovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Hedefli arama başlatılamadı' }));
      throw new Error(err.detail || 'Hedefli arama başlatılamadı');
    }
    return res.json();
  }
}

export interface ManagedWebSocket {
  close: () => void;
  readonly socket: WebSocket | null;
}

export function createWebSocket(
  onMessage: (data: any) => void,
  onStatusChange?: (connected: boolean) => void
): ManagedWebSocket {
  let ws: WebSocket | null = null;
  let isManuallyClosed = false;
  let reconnectTimeout: any = null;

  function connect() {
    if (isManuallyClosed) return;
    try {
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        console.log('[Tezlify WS] Connected to realtime event stream');
        onStatusChange?.(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessage(data);
        } catch (e) {
          // ignore non-json ping/pong
        }
      };

      ws.onclose = () => {
        onStatusChange?.(false);
        if (!isManuallyClosed) {
          reconnectTimeout = setTimeout(() => {
            connect();
          }, 3000);
        }
      };

      ws.onerror = (err) => {
        console.warn('[Tezlify WS] Error:', err);
        ws?.close();
      };
    } catch (e) {
      if (!isManuallyClosed) {
        reconnectTimeout = setTimeout(connect, 3000);
      }
    }
  }

  connect();

  return {
    close: () => {
      isManuallyClosed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    },
    get socket() {
      return ws;
    },
  };
}
