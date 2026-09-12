/**
 * WhatsApp canlı API istemcisi (Aşama 3).
 *
 * FastAPI `/api/v1/whatsapp/*` uç noktalarını çağırır ve yanıtları frontend
 * tiplerine (`WhatsAppSession`, `Conversation`, `Message`) eşler.
 * Gateway kapalıysa `WhatsAppApiError` fırlatır; repository bunu yakalayıp
 * demo katmanına düşer — asla sahte başarı üretilmez.
 */
import { useCallback, useEffect, useState } from 'react';
import { authFetch, API_BASE, parseError, ApiClient } from './client';
import {
  Conversation,
  ConversationMessagesResponse,
  ConversationStatus,
  LiveModeStatus,
  Message,
  SessionSyncState,
  WhatsAppSession,
} from '../types';

export class WhatsAppApiError extends Error {}

export { LiveModeStatus };

// ---------------------------------------------------------------------------
// Live probe (örnek: gateway çalışmıyorsa demo katmanına düş)
// ---------------------------------------------------------------------------
let liveProbe: { value: boolean; checkedAt: number } | null = null;
const LIVE_TTL_MS = 30_000;

export function isLiveCached(): boolean | null {
  if (!liveProbe) return null;
  if (Date.now() - liveProbe.checkedAt > LIVE_TTL_MS) return null;
  return liveProbe.value;
}

export function invalidateLiveProbe(): void {
  liveProbe = null;
}

export async function probeLive(): Promise<boolean> {
  const cached = isLiveCached();
  if (cached !== null) return cached;
  try {
    const res = await authFetch(`${API_BASE}/whatsapp/sessions`, { method: 'GET' });
    liveProbe = { value: res.ok, checkedAt: Date.now() };
  } catch {
    liveProbe = { value: false, checkedAt: Date.now() };
  }
  return liveProbe.value;
}

// ---------------------------------------------------------------------------
// Raw fetch helper
// ---------------------------------------------------------------------------
async function apiGet<T>(path: string): Promise<T> {
  const res = await authFetch(`${API_BASE}${path}`);
  if (!res.ok) throw new WhatsAppApiError(await parseError(res, 'WhatsApp API hatası'));
  return res.json() as Promise<T>;
}

async function apiSend<T>(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const res = await authFetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new WhatsAppApiError(await parseError(res, 'WhatsApp API hatası'));
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Dosya -> base64 yardimcilari (medya yukleme)
// ---------------------------------------------------------------------------
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      // "data:<mime>;base64,XXXX" -> "XXXX"
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new WhatsAppApiError('Dosya okunamadi'));
    reader.readAsDataURL(file);
  });
}

function mediaTypeFromFile(mime: string, name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio';
  return 'document';
}

// ---------------------------------------------------------------------------
// Backend -> Frontend tip eşleyicileri
// ---------------------------------------------------------------------------
interface BackendSession {
  id: number;
  session_name: string;
  status: string;
  phone_number?: string | null;
  is_active?: boolean;
  is_phone_online?: boolean;
  battery_level?: number | null;
  qr_code?: string | null;
  error_message?: string | null;
  sync?: SessionSyncState | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function mapSession(s: BackendSession): WhatsAppSession {
  return {
    id: s.id,
    session_name: s.session_name,
    phone_number: s.phone_number ?? undefined,
    status: (s.status as WhatsAppSession['status']) || 'DISCONNECTED',
    qr_code: s.qr_code ?? undefined,
    is_active: s.is_active ?? true,
    warm_up_day: 1,
    daily_sent_count: 0,
    max_daily_limit: 50,
    is_phone_online: s.is_phone_online ?? false,
    battery_level: s.battery_level ?? undefined,
    error_message: s.error_message ?? undefined,
    sync: s.sync ?? undefined,
    created_at: s.created_at || new Date().toISOString(),
    updated_at: s.updated_at || new Date().toISOString(),
  };
}

interface BackendConversation {
  id: number;
  contact_id?: number | null;
  lead_id?: number | null;
  name?: string | null;
  phone?: string | null;
  is_group?: boolean;
  avatar_url?: string | null;
  last_message_preview?: string | null;
  last_message_at?: string | null;
  unread_count?: number;
  status?: string;
}

function mapConversation(c: BackendConversation): Conversation {
  const last = c.last_message_at || new Date().toISOString();
  const isGroup = Boolean(c.is_group) || Boolean(c.phone?.endsWith('@g.us'));
  return {
    id: c.id,
    lead_id: c.lead_id ?? null,
    contact_id: c.contact_id ?? null,
    channel: 'WHATSAPP',
    status: (c.status as ConversationStatus) || 'ACTIVE',
    unread_count: c.unread_count ?? 0,
    lead_name: c.name || undefined,
    lead_phone: c.phone || undefined,
    is_group: isGroup,
    lead_avatar_url: c.avatar_url || undefined,
    last_message_preview: c.last_message_preview || undefined,
    last_message_at: last,
    created_at: last,
    updated_at: last,
  };
}

interface BackendMessage {
  id?: number | string | null;
  conversation_id?: number | string | null;
  direction?: string;
  message_type?: string;
  status?: string;
  body?: string | null;
  media_id?: string | null;
  media_mime_type?: string | null;
  media_filename?: string | null;
  media_caption?: string | null;
  wa_message_id?: string | null;
  client_message_id?: string | null;
  sender_phone?: string | null;
  sender_name?: string | null;
  recipient_phone?: string | null;
  error_message?: string | null;
  created_at?: string | null;
}

function mapMessage(m: BackendMessage, convId: number): Message {
  // Medya proxy'si auth korumalıdır: <img>/<audio> etiketleri Authorization
  // başlığı taşıyamaz, bu yüzden backend'in kabul ettiği ?token= sorgu
  // parametresi eklenir.
  const mediaUrl = m.media_id
    ? (() => {
        const base = `${API_BASE}/whatsapp/media/${m.media_id}`;
        const tok = ApiClient.getAuthToken();
        return tok ? `${base}?token=${encodeURIComponent(tok)}` : base;
      })()
    : undefined;
  return {
    id: m.id ?? `srv_${Date.now()}`,
    conversation_id: (m.conversation_id as number) ?? convId,
    direction: (m.direction as Message['direction']) || 'INBOUND',
    message_type: (m.message_type as Message['message_type']) || 'TEXT',
    status: (m.status as Message['status']) || 'RECEIVED',
    body: m.body ?? undefined,
    media_id: m.media_id ?? undefined,
    media_mime_type: m.media_mime_type ?? undefined,
    media_filename: m.media_filename ?? undefined,
    media_caption: m.media_caption ?? undefined,
    media_url: m.media_id ? `${API_BASE}/whatsapp/media/${m.media_id}` : undefined,
    wa_message_id: m.wa_message_id ?? undefined,
    client_message_id: m.client_message_id ?? undefined,
    sender_phone: m.sender_phone ?? undefined,
    sender_name: m.sender_name ?? undefined,
    recipient_phone: m.recipient_phone ?? undefined,
    error_message: m.error_message ?? undefined,
    external_timestamp: m.created_at ?? undefined,
    created_at: m.created_at || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API — repository'nin canlı katmanı buraya delege eder
// ---------------------------------------------------------------------------

export function useLiveMode(): { status: LiveModeStatus; probe: () => Promise<LiveModeStatus> } {
  const [status, setStatus] = useState<LiveModeStatus>(LiveModeStatus.LIVE_DISCONNECTED);

  const probe = useCallback(async (): Promise<LiveModeStatus> => {
    const isLive = await probeLive();
    const next = isLive ? LiveModeStatus.LIVE_CONNECTED : LiveModeStatus.LIVE_DISCONNECTED;
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    setStatus(LiveModeStatus.LIVE_CONNECTING);
    probe();
    const interval = setInterval(probe, 30_000);
    return () => clearInterval(interval);
  }, [probe]);

  return { status, probe };
}

export const WhatsAppApi = {
  probeLive,

  async listSessions(): Promise<WhatsAppSession[]> {
    const data = await apiGet<{ sessions: BackendSession[] }>('/whatsapp/sessions');
    return (data.sessions || []).map(mapSession);
  },

  async createSession(name: string): Promise<WhatsAppSession> {
    const s = await apiSend<BackendSession>('/whatsapp/sessions', 'POST', { name });
    return mapSession(s);
  },

  async getSessionQr(sessionId: number): Promise<{ status: string; qr_code: string | null; phone: string | null; error_message: string | null }> {
    const data = await apiGet<{ status: string; qr_code: string | null; phone: string | null; error_message?: string | null }>(
      `/whatsapp/sessions/${sessionId}/qr`
    );
    return {
      status: data.status,
      qr_code: data.qr_code ?? null,
      phone: data.phone ?? null,
      error_message: data.error_message ?? null,
    };
  },

  async refreshSessionQr(
    sessionId: number
  ): Promise<{ success: boolean; status: string; qr_code: string | null; error_message: string | null }> {
    const data = await apiSend<{ status: string; qr_code: string | null; error_message?: string | null }>(
      `/whatsapp/sessions/${sessionId}/qr/refresh`,
      'POST'
    );
    return { success: true, status: data.status, qr_code: data.qr_code ?? null, error_message: data.error_message ?? null };
  },

  async requestPairingCode(
    sessionId: number,
    phone: string
  ): Promise<{ success: boolean; pairing_code: string; phone: string | null }> {
    const data = await apiSend<{ success: boolean; pairing_code: string | null; phone?: string | null }>(
      `/whatsapp/sessions/${sessionId}/pair`,
      'POST',
      { phone }
    );
    if (!data.pairing_code) {
      throw new WhatsAppApiError('Gateway eşleştirme kodu döndürmedi.');
    }
    return { success: true, pairing_code: data.pairing_code, phone: data.phone ?? null };
  },

  async logoutSession(sessionId: number): Promise<{ success: boolean; status: string }> {
    return apiSend<{ success: boolean; status: string }>(`/whatsapp/sessions/${sessionId}/logout`, 'POST');
  },

  async deleteSession(sessionId: number): Promise<void> {
    await apiSend<{ success: boolean }>(`/whatsapp/sessions/${sessionId}`, 'DELETE');
  },

  // Faz 7: QR sonrası gerçek initial-sync durumu (gateway Baileys progress).
  async getSyncStatus(): Promise<{ sessions: Array<{ id: number; session_name?: string; status?: string; sync: SessionSyncState }> }> {
    return apiGet<{ sessions: Array<{ id: number; session_name?: string; status?: string; sync: SessionSyncState }> }>(
      '/whatsapp/sync-status'
    );
  },

  async getConversations(params?: {
    status?: ConversationStatus;
    unread_only?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
    sync?: boolean;
  }): Promise<Conversation[]> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.unread_only) qs.set('unread_only', 'true');
    if (params?.search?.trim()) qs.set('search', params.search.trim());
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    if (params?.sync) qs.set('sync', 'true');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const data = await apiGet<{ items: BackendConversation[]; total: number }>(`/whatsapp/conversations${suffix}`);
    return (data.items || []).map(mapConversation);
  },

  async getMessages(
    conversationId: number,
    params?: { limit?: number; before?: number }
  ): Promise<ConversationMessagesResponse> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.before) qs.set('before', String(params.before));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const data = await apiGet<{
      messages: BackendMessage[];
      has_more: boolean;
      oldest_message_id?: number | string | null;
      newest_message_id?: number | string | null;
    }>(`/whatsapp/conversations/${conversationId}/messages${suffix}`);
    return {
      messages: (data.messages || []).map((m) => mapMessage(m, conversationId)),
      has_more: data.has_more ?? false,
      oldest_message_id: (data.oldest_message_id as number | undefined) ?? undefined,
      newest_message_id: (data.newest_message_id as number | undefined) ?? undefined,
    };
  },

  async sendMessage(conversationId: number, body: string, clientMessageId?: string): Promise<Message> {
    const data = await apiSend<{
      id?: number | string | null;
      wa_message_id?: string | null;
      client_message_id?: string | null;
      status: string;
      body?: string | null;
    }>(`/whatsapp/conversations/${conversationId}/messages`, 'POST', {
      body,
      client_message_id: clientMessageId,
    });
    return mapMessage(
      {
        id: data.id,
        conversation_id: conversationId,
        direction: 'OUTBOUND',
        message_type: 'TEXT',
        status: data.status,
        body: data.body ?? body,
        wa_message_id: data.wa_message_id,
        client_message_id: data.client_message_id ?? clientMessageId,
        sender_phone: 'ME',
        created_at: new Date().toISOString(),
      },
      conversationId
    );
  },

  async sendMedia(
    conversationId: number,
    media: { media_type: string; media_url?: string; media_base64?: string; mime_type?: string; caption?: string; filename?: string },
    clientMessageId?: string
  ): Promise<Message> {
    if (!media.media_url && !media.media_base64) {
      throw new WhatsAppApiError('media_url veya media_base64 zorunludur');
    }
    const data = await apiSend<{
      id?: number | string | null;
      wa_message_id?: string | null;
      client_message_id?: string | null;
      status: string;
      body?: string | null;
    }>(`/whatsapp/conversations/${conversationId}/media`, 'POST', {
      media_type: media.media_type.toLowerCase(),
      media_url: media.media_url,
      media_base64: media.media_base64,
      mime_type: media.mime_type,
      caption: media.caption,
      filename: media.filename,
      client_message_id: clientMessageId,
    });
    return mapMessage(
      {
        id: data.id,
        conversation_id: conversationId,
        direction: 'OUTBOUND',
        message_type: media.media_type.toUpperCase(),
        status: data.status,
        body: data.body ?? media.caption ?? media.filename ?? '',
        media_filename: media.filename,
        media_caption: media.caption,
        wa_message_id: data.wa_message_id,
        client_message_id: data.client_message_id ?? clientMessageId,
        sender_phone: 'ME',
        created_at: new Date().toISOString(),
      },
      conversationId
    );
  },

  /** Bir dosyayi okuyup base64 medya mesaji olarak gonderir (WhatsApp Web dosya secimi). */
  async sendMediaFile(
    conversationId: number,
    file: File,
    caption?: string,
    clientMessageId?: string
  ): Promise<Message> {
    const base64 = await fileToBase64(file);
    const type = mediaTypeFromFile(file.type, file.name);
    return WhatsAppApi.sendMedia(
      conversationId,
      {
        media_type: type,
        media_base64: base64,
        mime_type: file.type || 'application/octet-stream',
        caption,
        filename: file.name,
      },
      clientMessageId
    );
  },

  /** Karsı tarafa 'yazıyor...' gostermesi gonderir. */
  async sendTyping(conversationId: number, typing: boolean = true): Promise<void> {
    await apiSend<{ success: boolean }>(`/whatsapp/conversations/${conversationId}/typing`, 'POST', { typing });
  },

  async markConversationRead(conversationId: number): Promise<Conversation> {
    await apiSend<{ success: boolean }>(`/whatsapp/conversations/${conversationId}/read`, 'POST');
    // Backend guncel konusmayi dondurdugu icin listeden temsilini bul:
    const convs = await WhatsAppApi.getConversations({ limit: 200 });
    const conv = convs.find((c) => c.id === conversationId);
    if (conv) return { ...conv, unread_count: 0 };
    throw new WhatsAppApiError('Konuşma bulunamadı');
  },

  async getContacts(): Promise<any[]> {
    const data = await apiGet<{ contacts: any[] }>('/whatsapp/contacts');
    return data.contacts || [];
  },

  getLiveMessages(conversationId: number, onMessage: (msg: Message) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (!detail) return;
      if (detail.conversation_id !== conversationId) return;
      if (
        detail.event === 'message_new' ||
        detail.event === 'inbound_reply' ||
        detail.event === 'outbound_message_sent'
      ) {
        const msgData = detail.message && typeof detail.message === 'object' ? detail.message : detail;
        onMessage(mapMessage(msgData, conversationId));
      }
    };
    window.addEventListener('tezlify:ws_event', handler);
    return () => window.removeEventListener('tezlify:ws_event', handler);
  },

  subscribe(onEvent: (event: any) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (detail) onEvent(detail);
    };
    window.addEventListener('tezlify:ws_event', handler);
    return () => window.removeEventListener('tezlify:ws_event', handler);
  },

  useLiveMode,
};
