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
  WhatsAppNumber,
  WhatsAppNumberValidatePayload,
  WhatsAppNumberValidateResult,
  WhatsAppNumberConnectPayload,
  WhatsAppNumberUpdatePayload,
  WhatsAppNumberVerifyResult,
  WhatsAppTemplate,
  MessageLog,
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
  // Numbers (Meta Cloud) — no backend equivalent, throws
  // -------------------------------------------------------------------------

  static async getWhatsAppNumbers(): Promise<WhatsAppNumber[]> {
    throw new WhatsAppApiError(
      'Telefon numaralar\u0131 y\u00f6netimi Meta Cloud API i\u00e7in gereklidir. Bu \u00f6zellik kald\u0131r\u0131ld\u0131.',
    );
  }

  static async validateWhatsAppNumber(_payload: WhatsAppNumberValidatePayload): Promise<WhatsAppNumberValidateResult> {
    throw new WhatsAppApiError(
      'WhatsApp numaras\u0131 do\u011frusundlama Meta Cloud API i\u00e7in gereklidir. Bu \u00f6zellik kald\u0131r\u0131ld\u0131.',
    );
  }

  static async connectWhatsAppNumber(_payload: WhatsAppNumberConnectPayload): Promise<WhatsAppNumber> {
    throw new WhatsAppApiError(
      'WhatsApp numaras\u0131 ba\u011fland\u0131\u015f\u0131 Meta Cloud API i\u00e7in gereklidir. Baileys QR oturumu kullan\u0131n.',
    );
  }

  static async updateWhatsAppNumber(_numberId: number, _payload: WhatsAppNumberUpdatePayload): Promise<WhatsAppNumber> {
    throw new WhatsAppApiError('Bu \u00f6zellik kald\u0131r\u0131ld\u0131.');
  }

  static async verifyWhatsAppNumber(_numberId: number): Promise<WhatsAppNumberVerifyResult> {
    throw new WhatsAppApiError('Bu \u00f6zellik kald\u0131r\u0131ld\u0131.');
  }

  static async disconnectWhatsAppNumber(_numberId: number): Promise<WhatsAppNumber> {
    throw new WhatsAppApiError('Bu \u00f6zellik kald\u0131r\u0131ld\u0131.');
  }

  static async deleteWhatsAppNumber(_numberId: number): Promise<{ success: boolean; message: string }> {
    throw new WhatsAppApiError('Bu \u00f6zellik kald\u0131r\u0131ld\u0130.');
  }

  static async sendTestMessage(_phone: string, _message: string, _sessionId?: number): Promise<any> {
    throw new WhatsAppApiError('Test mesaj\u0131 g\u00f6ndermek i\u00e7in canl\u0131 bir oturum ba\u011flan\u0131n.');
  }

  static async getMessageLogs(): Promise<MessageLog[]> {
    throw new WhatsAppApiError('Mesaj loglar\u0131 \u00e7\u00edn y\u00f6netici gateway gereklidir.');
  }

  // -------------------------------------------------------------------------
  // Sessions & QR (live-only)
  // -------------------------------------------------------------------------

  static async getWhatsAppSessions(): Promise<WhatsAppSession[]> {
    await requireLive();
    return WhatsAppApi.listSessions();
  }

  static async createWhatsAppSession(name: string, _maxDailyLimit: number = 50): Promise<WhatsAppSession> {
    await requireLive();
    return WhatsAppApi.createSession(name);
  }

  static async getSessionQr(sessionId: number): Promise<{ status: string; qr_code: string | null; phone: string | null }> {
    await requireLive();
    return WhatsAppApi.getSessionQr(sessionId);
  }

  static async refreshSessionQr(sessionId: number): Promise<{ success: boolean; status: string; qr_code: string | null }> {
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
  }): Promise<Conversation[]> {
    await requireLive();
    return WhatsAppApi.getConversations({
      status: params?.status as ConversationStatus | undefined,
      unread_only: params?.unread_only,
      search: params?.search,
      limit: params?.limit,
      offset: params?.offset,
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
    mediaData: { media_type: string; media_url: string; caption?: string; filename?: string },
    idempotencyKey?: string,
  ): Promise<any> {
    await requireLive();
    return WhatsAppApi.sendMedia(conversationId, mediaData, idempotencyKey);
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
