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
import {
  WhatsAppApi,
  probeLive,
  invalidateLiveProbe,
  WhatsAppApiError,
  ConversationReadResult,
} from '../api/whatsappApi';
import {
  Conversation,
  ConversationDetail,
  ConversationMessagesResponse,
  MessageReaction,
  WhatsAppSession,
  WhatsAppTemplate,
  ConversationStatus,
} from '../../../types';

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

async function requireLive(signal?: AbortSignal): Promise<void> {
  const live = await probeLive(signal);
  if (!live) {
    invalidateLiveProbe();
    throw new WhatsAppApiError('whatsapp.gatewayDown');
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

  static async startPairing(name?: string): Promise<{ pair_token: string; gateway_id: string; session_name: string; status: string; qr_code?: string | null }> {
    await requireLive();
    return WhatsAppApi.startPairing(name);
  }

  static async getPairingQr(pairToken: string): Promise<{ status: string; qr_code: string | null; phone: string | null; session_id?: number | null; error_message: string | null }> {
    await requireLive();
    return WhatsAppApi.getPairingQr(pairToken);
  }

  static async cancelPairing(pairToken: string): Promise<{ success: boolean }> {
    return WhatsAppApi.cancelPairing(pairToken);
  }

  static async refreshAvatar(phone: string): Promise<{ success: boolean; avatar_url?: string | null; error?: string }> {
    await requireLive();
    return WhatsAppApi.refreshAvatar(phone);
  }

  static async getSessionQr(sessionId: number): Promise<{ status: string; qr_code: string | null; phone: string | null; error_message: string | null }> {
    await requireLive();
    return WhatsAppApi.getSessionQr(sessionId);
  }

  static async refreshSessionQr(sessionId: number): Promise<{ success: boolean; status: string; qr_code: string | null; error_message: string | null }> {
    await requireLive();
    return WhatsAppApi.refreshSessionQr(sessionId);
  }

  static async requestPairingCode(sessionId: number, phone: string): Promise<{ success: boolean; pairing_code: string; phone: string | null }> {
    await requireLive();
    return WhatsAppApi.requestPairingCode(sessionId, phone);
  }

  /**
   * P6-8: the same gateway pairing-code call for a NEW (ephemeral) pairing,
   * addressed by `pair_token` instead of a numeric session id — no numeric id
   * exists until the pairing actually connects.
   */
  static async requestPairingCodeForToken(pairToken: string, phone: string): Promise<{ success: boolean; pairing_code: string; phone: string | null }> {
    await requireLive();
    return WhatsAppApi.requestPairingCodeForToken(pairToken, phone);
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

  static async getConversationsPage(params?: {
    status?: string;
    unread_only?: boolean;
    group_only?: boolean;
    archived_only?: boolean;
    lead_id?: number;
    conversation_id?: number;
    search?: string;
    limit?: number;
    offset?: number;
    sync?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    items: Conversation[];
    total: number;
    has_more: boolean;
    next_offset?: number;
  }> {
    await requireLive(params?.signal);
    return WhatsAppApi.getConversationsPage({
      status: params?.status as ConversationStatus | undefined,
      unread_only: params?.unread_only,
      group_only: params?.group_only,
      archived_only: params?.archived_only,
      lead_id: params?.lead_id,
      conversation_id: params?.conversation_id,
      search: params?.search,
      limit: params?.limit,
      offset: params?.offset,
      sync: params?.sync,
      signal: params?.signal,
    });
  }

  static async getConversations(params?: {
    status?: string;
    unread_only?: boolean;
    group_only?: boolean;
    archived_only?: boolean;
    lead_id?: number;
    conversation_id?: number;
    search?: string;
    limit?: number;
    offset?: number;
    sync?: boolean;
    signal?: AbortSignal;
  }): Promise<Conversation[]> {
    const page = await this.getConversationsPage(params);
    return page.items;
  }


  static async getConversation(conversationId: number, signal?: AbortSignal): Promise<ConversationDetail> {
    await requireLive(signal);
    // Faz 12: hedefli tek-sohbet sorgusu — eskiden TUM liste (limit=200)
    // indirilip istemcide filtreleniyordu (agir + 200 sohbetten sonra sessizce
    // basarisiz). Ayni tenant filtresi sunucuda uygulanir.
    //
    // Latency: these two requests are INDEPENDENT, so they run concurrently.
    // Awaiting them in sequence made a click cost `list + messages`; now it
    // costs `max(list, messages)`. The sibling is started BEFORE the not-found
    // check, but its rejection is swallowed on that path so the canonical
    // `conversationNotFound` error is still the one that surfaces (a 404 from
    // /messages must not mask it) — and so it never becomes an unhandled
    // rejection when we bail out early.
    const listPromise = WhatsAppApi.getConversations({ conversation_id: conversationId, limit: 1, signal });
    const messagesPromise = WhatsAppApi.getMessages(conversationId, { limit: 50, signal });

    const list = await listPromise;
    const conv = list[0];
    if (!conv) {
      await messagesPromise.catch(() => undefined);
      throw new WhatsAppApiError('whatsapp.conversationNotFound');
    }
    // Keep detail and paginated list views on the same bounded first page.
    // Older history is fetched explicitly with the cursor by the UI.
    const messages = await messagesPromise;
    return {
      ...conv,
      messages: messages.messages,
      has_more: messages.has_more,
      oldest_message_id: messages.oldest_message_id,
      newest_message_id: messages.newest_message_id,
    };
  }

  static async getConversationMessages(
    conversationId: number,
    params?: { limit?: number; before?: number; signal?: AbortSignal },
  ): Promise<ConversationMessagesResponse> {
    await requireLive(params?.signal);
    return WhatsAppApi.getMessages(conversationId, params);
  }

  /**
   * Sohbeti okundu isaretler ve GERCEK sonucu dondurur.
   *
   * Faz 13 (truthfulness): donen `success=false` ise gateway'e okundu bilgisi
   * ILETILEMEMISTIR — cagiran bunu kullaniciya bildirmelidir. Onceki imza
   * (`Conversation | null`) basari bilgisini tasimiyordu ve cagiranlar
   * `.catch(() => {})` ile hem ag hem gateway hatasini sessizce yutuyordu.
   */
  static async markConversationAsRead(
    conversationId: number,
    known?: Conversation,
  ): Promise<ConversationReadResult> {
    await requireLive();
    return WhatsAppApi.markConversationRead(conversationId, known);
  }

  /**
   * A9 — resolve the lead's conversation via the SAME lead_id filter that
   * `getLeadConversation` uses. The old implementation searched with
   * `search: String(leadId)` (a LIKE on name/phone) plus a `c.id === leadId`
   * fallback, which could mark the WRONG conversation read.
   */
  static async markLeadConversationAsRead(leadId: number): Promise<ConversationReadResult> {
    await requireLive();
    const convs = await WhatsAppApi.getConversations({ lead_id: leadId, limit: 1 });
    const conv = convs[0];
    if (!conv) throw new WhatsAppApiError('whatsapp.leadConversationNotFound');
    return WhatsAppApi.markConversationRead(conv.id, conv);
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

  /** Karsı tarafa 'yazıyor...' göstergesi gönderir; hatayı çağırana taşır. */
  static async sendTyping(conversationId: number, typing: boolean = true): Promise<void> {
    await WhatsAppApi.sendTyping(conversationId, typing);
  }

  /**
   * Bir mesaja ifade birakir/degistirir/kaldirir (`emoji === ''` geri ceker).
   *
   * Hata YUTULMAZ: cagiran (sohbet ekrani) iyimser rozeti geri almali ve
   * kullaniciya gercek bir hata gostermelidir — aksi halde tepki birakilmis
   * gibi gorunur ama WhatsApp'a hic gitmemistir.
   */
  static async sendReaction(conversationId: number, messageId: number, emoji: string): Promise<{
    success: boolean;
    emoji: string;
    removed: boolean;
    from_me: boolean;
    reactor_jid?: string | null;
    reaction?: MessageReaction | null;
    conversation_reaction?: MessageReaction | null;
  }> {
    await requireLive();
    return WhatsAppApi.sendReaction(conversationId, messageId, emoji);
  }

  /**
   * A6 — WhatsApp Business API templates (Cloud API) are NOT part of the
   * Baileys gateway contract; the backend exposes no template endpoint.
   * Fail CLOSED and honestly: the error propagates to the UI, which must
   * surface a real toast/error state instead of a silent empty grid.
   * (Error message is an i18n key — the UI layer translates it.)
   */
  static async getTemplates(): Promise<WhatsAppTemplate[]> {
    throw new WhatsAppApiError('whatsapp.templatesNotAvailable');
  }

  static async sendTemplate(
    _conversationId: number,
    _templateKey: string,
    _variables: Record<string, string> = {},
    _idempotencyKey?: string,
  ): Promise<any> {
    throw new WhatsAppApiError('whatsapp.templatesNotAvailable');
  }

  /**
   * A5 — real retry for persisted FAILED outbound messages.
   *
   * The backend has no dedicated retry endpoint; retry means resending the
   * ORIGINAL content through the existing send path. A persisted FAILED row
   * carries `body` + `client_message_id`, and `send_text_message` is
   * idempotent on `client_message_id`, so the resend reuses the same
   * idempotency key (no duplicate rows). Media-only messages (media_id but
   * no body) cannot be resent by the backend yet — fail closed with an
   * honest error; never fake success.
   *
   * The caller owns optimistic state transitions (set PENDING before, restore
   * FAILED + toast.error on rejection).
   */
  static async retryMessage(conversationId: number, messageId: number | string): Promise<any> {
    await requireLive();
    const numericId = typeof messageId === 'number' ? messageId : Number(messageId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new WhatsAppApiError('whatsapp.msgNotPersisted');
    }
    const original = await WhatsAppApi.getMessage(conversationId, numericId);
    if (!original || String(original.direction).toUpperCase() !== 'OUTBOUND') {
      throw new WhatsAppApiError('whatsapp.msgNotPersisted');
    }
    if (original.media_id && !original.body) {
      // Media resend of a persisted FAILED media row is not supported by the
      // API contract yet — fail closed and honestly.
      throw new WhatsAppApiError('whatsapp.retryMediaNotSupported');
    }
    if (!original.body) {
      throw new WhatsAppApiError('whatsapp.msgNotPersisted');
    }
    return WhatsAppApi.sendMessage(conversationId, original.body, original.client_message_id);
  }

  /**
   * A6 kapanisi — WhatsApp Web paritesi: numara ile yeni sohbet baslat.
   *
   * Eskiden burada kosulsuz `throw` vardi ve "Yeni Sohbet" akisi her
   * denemede hataya dusüyordu. Artik backend `POST /whatsapp/conversations`
   * contact + conversation satirlarini olusturur; `message` verildiyse
   * bagli hattan GERCEK olarak gönderilir. Fail-closed: hata çağırana
   * taşınır, sahte sohbet/mesaj üretilmez (AGENTS.md §1.1).
   */
  static async startConversation(data: { phone: string; name?: string; message?: string }): Promise<Conversation> {
    await requireLive();
    return WhatsAppApi.startConversation(data.phone, data.name, data.message);
  }

  /**
   * Lead'e bagli canli WhatsApp sohbetini cozer (LeadDetailDrawer "Sohbet" sekmesi).
   *
   * Faz 12: eskiden bu metot dogrudan
   * `throw new WhatsAppApiError('Bu özellik kaldırıldı.')` yapiyordu — cekmecedeki
   * sohbet sekmesi HER acilista hata durumuna dusuyordu. Artik sunucu tarafi
   * `lead_id` filtresiyle hedefli sorgu + mesaj cekimi yapilir; istemcide
   * 200 satirlik liste taramasi YOK (AGENTS.md §1.1: sahte basari/veri uretilmez,
   * sohbet yoksa gercek hata firlatilir).
   */
  static async getLeadConversation(leadId: number, signal?: AbortSignal): Promise<ConversationDetail> {
    await requireLive(signal);
    const list = await WhatsAppApi.getConversations({ lead_id: leadId, limit: 1, signal });
    const conv = list[0];
    if (!conv) {
      throw new WhatsAppApiError('whatsapp.leadConversationNotFound');
    }
    const messages = await WhatsAppApi.getMessages(conv.id, { limit: 50, signal });
    return {
      ...conv,
      messages: messages.messages,
      has_more: messages.has_more,
      oldest_message_id: messages.oldest_message_id,
      newest_message_id: messages.newest_message_id,
    };
  }

  /**
   * Sohbetin CRM durumunu kalici olarak yazar (ACTIVE / ARCHIVED / CLOSED).
   *
   * Phase 15.4: eskiden burada kosulsuz `throw` vardi; UI ise yerel state'i
   * degistirip basari toast'i gosteriyordu (sahte basari — AGENTS.md §1.1).
   * Artik gercek `PATCH /conversations/{id}/status` cagrisi yapilir ve
   * gateway gerektirmez.
   */
  static async updateConversationStatus(
    conversationId: number,
    status: ConversationStatus,
  ): Promise<{ id: number; status: string }> {
    return WhatsAppApi.updateConversationStatus(conversationId, status);
  }

  /**
   * Sohbeti ve o sohbete ait tum mesajlari kalici olarak siler.
   *
   * Mock fallback YOKTUR: silme geri alinamaz ve yedegi yoktur, bu yuzden
   * "yerel olarak silinmis gibi gostermek" sahte bir basari olurdu
   * (AGENTS.md §1.1). Gercek cagri basarisiz olursa hata cagirana tasinir.
   */
  static async deleteConversation(
    conversationId: number,
  ): Promise<{
    id: number;
    deleted: boolean;
    messages_deleted: number;
    reactions_deleted: number;
    remote_deleted: boolean;
    remote_error: string | null;
  }> {
    return WhatsAppApi.deleteConversation(conversationId);
  }

  /**
   * Onarımı bekleyen bölünmüş LID sohbetlerini listeler (yönetim ucu).
   *
   * Mock fallback YOKTUR: "bekleyen yok" gibi görünen sahte bir boş liste,
   * operatörü gerçek bir bölünmeyi onarmamaya ikna ederdi (AGENTS.md §1.1).
   */
  static async getLidSplits(limit: number = 50) {
    // `requireLive()` BİLİNÇLİ olarak yok: bu uç nokta gateway'e değil DB'ye
    // bakar ve bölünmeler zaten çoğunlukla hat kopukken/bağlanırken birikir.
    // Gateway kapalı diye onarım görünmez olmamalı.
    return WhatsAppApi.getLidSplits(limit);
  }

  /**
   * Tek istekte onarım: sunucu birleştirmeyi yapar, sonuç olduğu gibi döner.
   * Yerel iyimser bir "birleşti" durumu ÜRETİLMEZ; liste sunucudan tazelenir.
   */
  static async mergeLidSplits(lidJid?: string, limit: number = 50) {
    // Yukarıdaki gerekçeyle aynı: gateway gerektirmez (bkz. getLidSplits).
    return WhatsAppApi.mergeLidSplits(lidJid, limit);
  }
}
