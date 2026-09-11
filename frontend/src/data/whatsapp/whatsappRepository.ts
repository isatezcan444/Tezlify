/**
 * WhatsApp Repository — Live-only data access layer.
 *
 * All data comes from the Baileys gateway via the FastAPI backend
 * (`/api/v1/whatsapp/*` + `/ws/gateway`). There is zero mock data,
 * zero simulation, and zero false-positive success.
 *
 * Contract:
 * - Every method delegates to WhatsAppApi (live API calls).
 * - If the gateway/backend is unreachable, the error propagates.
 * - Real-time events from `/ws/gateway` are dispatched as
 *   `tezlify:ws_event` CustomEvents for UI components to consume.
 */
import { WhatsAppApi, probeLive, invalidateLiveProbe, WhatsAppApiError } from '../../api/whatsappApi';
import {
  Conversation,
  ConversationDetail,
  ConversationMessagesResponse,
  WhatsAppSession,
  WhatsAppTemplate,
  ConversationStatus,
} from '../../types';

export { WhatsAppApiError };

// ---------------------------------------------------------------------------
// Event bridge — real-time gateway events → CustomEvent dispatch
// ---------------------------------------------------------------------------

function emit(event: Record<string, any>) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('tezlify:ws_event', { detail: event }));
}

export function subscribeGatewayEvents(onEvent: (event: any) => void): () => void {
  return WhatsAppApi.subscribe(onEvent);
}

// ---------------------------------------------------------------------------
// Live session helpers
// ---------------------------------------------------------------------------

async function requireLive(): Promise<void> {
  const live = await probeLive();
  if (!live) {
    invalidateLiveProbe();
    throw new WhatsAppApiError('WhatsApp gateway ba\u011flant\u0131s\u0131 yok. L\u00fctfen gateway servisini ba\u015flat\u0131n.');
  }
}

// ---------------------------------------------------------------------------
// Repository — live-only. Methods without a backend equivalent throw.
// -------------------------------------------------------------------------

export class WhatsAppRepository {
  // -------------------------------------------------------------------------
  // Sessions & QR (live-only)
  // -------------------------------------------------------------------------

  static async getWhatsAppSessions(): Promise<WhatsAppSession[]> {
    // Session records are persisted by the backend. Listing them stays useful
    // during a transient gateway outage; actions still fail closed via
    // `requireLive` below and never claim a successful connection.
    return WhatsAppApi.listSessions();
  }

  static async createWhatsAppSession(name: string, _maxDailyLimit: number = 50): Promise<WhatsAppSession> {
    await requireLive();
    return WhatsAppApi.createSession(name);
  }

  static async getSessionQr(sessionId: number): Promise<{ status: string; qr_code: string | null; phone: string | null; error_message: string | null }> {
    await requireLive();
    return WhatsAppApi.getSessionQr(sessionId);
  }

  static async refreshSessionQr(sessionId: number): Promise<{ success: boolean; status: string; qr_code: string | null; error_message: string | null }> {
    await requireLive();
    return WhatsAppApi.refreshSessionQr(sessionId);
  }

  static async disconnectSession(sessionId: number): Promise<any> {
    await requireLive();
    return WhatsAppApi.logoutSession(sessionId);
  }

  static async deleteSession(sessionId: number): Promise<void> {
    await requireLive();
    await WhatsAppApi.deleteSession(sessionId);
  }

  // -------------------------------------------------------------------------
  // Contacts (live-only)
  // -------------------------------------------------------------------------

  static async getWhatsAppContacts(): Promise<any[]> {
    await requireLive();
    return WhatsAppApi.getContacts();
  }

  // -------------------------------------------------------------------------
  // Conversations & messages (live-only)
  // -------------------------------------------------------------------------

  static async getConversations(params?: {
    status?: string;
    unread_only?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
    sync?: boolean;
  }): Promise<Conversation[]> {
    await requireLive();
    return WhatsAppApi.getConversations({
      status: params?.status as ConversationStatus | undefined,
      unread_only: params?.unread_only,
      search: params?.search,
      limit: params?.limit,
      offset: params?.offset,
      sync: params?.sync,
    });
  }

  static async getConversation(conversationId: number): Promise<ConversationDetail> {
    await requireLive();
    const list = await WhatsAppApi.getConversations({ limit: 200 });
    const conv = list.find((c) => c.id === conversationId);
    if (!conv) throw new WhatsAppApiError('Konu\u015fma bulunamad\u0131');
    const messages = await WhatsAppApi.getMessages(conversationId, { limit: 100 });
    return { ...conv, messages: messages.messages, has_more: messages.has_more };
  }

  static async getConversationMessages(
    conversationId: number,
    params?: { limit?: number; before?: number },
  ): Promise<ConversationMessagesResponse> {
    await requireLive();
    return WhatsAppApi.getMessages(conversationId, params);
  }

  static async markConversationAsRead(conversationId: number): Promise<Conversation> {
    await requireLive();
    return WhatsAppApi.markConversationRead(conversationId);
  }

  static async markLeadConversationAsRead(leadId: number): Promise<Conversation> {
    const convs = await WhatsAppRepository.getConversations({ search: String(leadId), limit: 50 });
    const conv = convs.find((c) => c.lead_id === leadId || c.id === leadId);
    if (!conv) throw new WhatsAppApiError('Lead konu\u015fmas\u0131 bulunamad\u0131');
    return WhatsAppRepository.markConversationAsRead(conv.id);
  }

  static async sendMessage(
    conversationId: number,
    body: string,
    idempotencyKey?: string,
  ): Promise<any> {
    await requireLive();
    return WhatsAppApi.sendMessage(conversationId, body, idempotencyKey);
  }

  static async sendMedia(
    conversationId: number,
    mediaData: {
      media_type: string;
      media_url?: string;
      media_base64?: string;
      mime_type?: string;
      caption?: string;
      filename?: string;
    },
    idempotencyKey?: string,
  ): Promise<any> {
    await requireLive();
    return WhatsAppApi.sendMedia(conversationId, mediaData, idempotencyKey);
  }

  /** WhatsApp Web tarzı dosya secimi: yerel dosyayi base64 olarak gonderir. */
  static async sendMediaFile(
    conversationId: number,
    file: File,
    caption?: string,
    idempotencyKey?: string,
  ): Promise<any> {
    await requireLive();
    return WhatsAppApi.sendMediaFile(conversationId, file, caption, idempotencyKey);
  }

  /** Karsı tarafa 'yazıyor...' göstergesi gönderir (fail-soft: UI gürültüsü). */
  static async sendTyping(conversationId: number, typing: boolean = true): Promise<void> {
    try {
      await WhatsAppApi.sendTyping(conversationId, typing);
    } catch {
      // Yazıyor göstergesi kritik değildir; sessizce yut.
    }
  }

  static async getTemplates(): Promise<WhatsAppTemplate[]> {
    throw new WhatsAppApiError('Mesaj \u015fablonlar\u0131 Meta Cloud API i\u00e7in gereklidir.');
  }

  static async sendTemplate(
    _conversationId: number,
    _templateKey: string,
    _variables: Record<string, string> = {},
    _idempotencyKey?: string,
  ): Promise<any> {
    throw new WhatsAppApiError('Mesaj \u015fablonlar\u0131 Meta Cloud API i\u00e7in gereklidir.');
  }

  static async retryMessage(_conversationId: number, _messageId: number | string): Promise<any> {
    throw new WhatsAppApiError('Bu \u00f6zellik kald\u0131r\u0131ld\u0131.');
  }

  static async startConversation(_data: { phone: string; name?: string; message?: string }): Promise<ConversationDetail> {
    throw new WhatsAppApiError('Yeni konu\u015fma ba\u015flatmak i\u00e7in canl\u0131 gateway gereklidir.');
  }

  static async getLeadConversation(_leadId: number): Promise<ConversationDetail> {
    throw new WhatsAppApiError('Bu \u00f6zellik kald\u0131r\u0131ld\u0130.');
  }

  static async updateConversationStatus(
    _conversationId: number,
    _status: ConversationStatus,
  ): Promise<Conversation> {
    throw new WhatsAppApiError('Konu\u015fma durumu gateway taraf\u0131ndan sa\u011flan\u0131r.');
  }
}
