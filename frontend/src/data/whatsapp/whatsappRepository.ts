/**
 * Frontend-only WhatsApp repository.
 *
 * The WhatsApp backend (API, gateway, Meta Cloud, Baileys, webhooks, workers)
 * has been removed from this project. The preserved WhatsApp UI screens are
 * backed by this single centralized in-memory data source, mirroring the old
 * `ApiClient` method contracts so components keep their original structure.
 *
 * Behavior notes:
 * - All state lives here (numbers, sessions, conversations, messages, logs).
 * - Mutations dispatch the same `tezlify:ws_event` CustomEvents the UI
 *   components already listen to (`session_connected`, `session_qr_updated`,
 *   `message_status_updated`, `conversation_read`, ...), so the existing
 *   realtime-driven rendering keeps working without a backend socket.
 * - Message dispatch is simulated: PENDING -> SENT -> DELIVERED progression.
 * - Nothing here performs network I/O and no credentials are stored.
 */
import {
  WhatsAppNumber,
  WhatsAppNumberStatus,
  WhatsAppNumberValidatePayload,
  WhatsAppNumberValidateResult,
  WhatsAppNumberConnectPayload,
  WhatsAppNumberUpdatePayload,
  WhatsAppNumberVerifyResult,
  WhatsAppSession,
  Conversation,
  ConversationDetail,
  ConversationMessagesResponse,
  ConversationStatus,
  Message,
  ConversationMessageStatus,
  WhatsAppTemplate,
  MessageLog,
} from '../../types';
import {
  initialNumbers,
  initialSessions,
  initialConversations,
  initialMessages,
  initialTemplates,
  initialMessageLogs,
} from './mockData';
import { generateFakeQrDataUri } from './fakeQr';

// ---------------------------------------------------------------------------
// Module-level in-memory state (single source of truth for the WhatsApp UI)
// ---------------------------------------------------------------------------
const numbers: WhatsAppNumber[] = [...initialNumbers];
const sessions: WhatsAppSession[] = [...initialSessions];
const conversations: Conversation[] = [...initialConversations];
const messagesByConversation: Record<number, Message[]> = { ...initialMessages };
const templates: WhatsAppTemplate[] = [...initialTemplates];
const messageLogs: MessageLog[] = [...initialMessageLogs];

let nextNumberId = 100;
let nextSessionId = 100;
let nextConversationId = 100;
let nextMessageId = 1000;
let nextLogId = 10000;

const nowIso = () => new Date().toISOString();
const last10 = (p?: string | null) => (p ? p.replace(/\D/g, '').slice(-10) : '');

function emit(event: Record<string, any>) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('tezlify:ws_event', { detail: event }));
}

function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => {
    const tA = new Date(a.created_at || a.external_timestamp || 0).getTime();
    const tB = new Date(b.created_at || b.external_timestamp || 0).getTime();
    if (tA !== tB) return tA - tB;
    const nA = typeof a.id === 'number' ? a.id : 0;
    const nB = typeof b.id === 'number' ? b.id : 0;
    return nA - nB;
  });
}

function conversationDetail(conv: Conversation): ConversationDetail {
  const messages = sortMessages(messagesByConversation[conv.id] || []);
  const last = messages[messages.length - 1];
  const oldestNumeric = messages.find((m) => typeof m.id === 'number' && m.id > 0)?.id;
  return {
    ...conv,
    last_message_preview: conv.last_message_preview ?? last?.body ?? null,
    messages,
    has_more: false,
    oldest_message_id: typeof oldestNumeric === 'number' ? oldestNumeric : undefined,
    newest_message_id:
      typeof last?.id === 'number' ? last.id : undefined,
  };
}

function findConversationOrThrow(id: number): Conversation {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) throw new Error('Konuşma bulunamadı');
  return conv;
}

function touchConversation(conv: Conversation, preview: string) {
  conv.last_message_at = nowIso();
  conv.last_message_preview = preview;
  conv.updated_at = nowIso();
  if (conv.status === 'ARCHIVED') conv.status = 'ACTIVE';
}

function simulateDelivery(msg: Message, convId: number) {
  const steps: ConversationMessageStatus[] = ['SENT', 'DELIVERED'];
  steps.forEach((status, idx) => {
    setTimeout(() => {
      const stored = (messagesByConversation[convId] || []).find((m) => m.id === msg.id);
      if (!stored) return;
      stored.status = status;
      emit({
        event: 'message_status_updated',
        id: msg.id,
        message_id: msg.id,
        conversation_id: convId,
        wa_message_id: msg.wa_message_id,
        client_message_id: msg.client_message_id,
        status,
        timestamp: nowIso(),
      });
    }, 500 * (idx + 1));
  });
}

function enqueueMessage(convId: number, partial: Partial<Message> & { body: string }): Message {
  const msg: Message = {
    id: nextMessageId++,
    conversation_id: convId,
    direction: 'OUTBOUND',
    message_type: 'TEXT',
    status: 'PENDING',
    sender_phone: 'ME',
    recipient_phone: '',
    created_at: nowIso(),
    ...partial,
  };
  if (!messagesByConversation[convId]) messagesByConversation[convId] = [];
  messagesByConversation[convId].push(msg);
  return { ...msg };
}

function recordLog(leadId: number, phone: string, rendered: string, status: string) {
  messageLogs.unshift({
    id: nextLogId++,
    lead_id: leadId,
    target_phone: phone,
    rendered_message: rendered,
    status,
    reply_received: false,
    sent_at: nowIso(),
    created_at: nowIso(),
  });
}

export class WhatsAppRepository {
  // -------------------------------------------------------------------------
  // Active numbers
  // -------------------------------------------------------------------------
  static async getWhatsAppNumbers(): Promise<WhatsAppNumber[]> {
    return numbers.map((n) => ({ ...n }));
  }

  static async validateWhatsAppNumber(payload: WhatsAppNumberValidatePayload): Promise<WhatsAppNumberValidateResult> {
    const waba = (payload.waba_id || '').trim();
    const pnid = (payload.phone_number_id || '').trim();
    const token = (payload.access_token || '').trim();
    if (!waba || !pnid || !token) {
      return { is_valid: false, phone_number_id: pnid, error: 'WABA ID, Phone Number ID ve Access Token zorunludur.' };
    }
    const display = `+90 850 ${String(Math.abs(hashInt(pnid)) % 1000000).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2')}`;
    return {
      is_valid: true,
      phone_number_id: pnid,
      display_phone_number: display,
      verified_name: payload.name?.trim() || 'Tezlify İşletmesi',
      quality_rating: 'GREEN',
      waba_id: waba,
    };
  }

  static async connectWhatsAppNumber(payload: WhatsAppNumberConnectPayload): Promise<WhatsAppNumber> {
    const number: WhatsAppNumber = {
      id: nextNumberId++,
      provider: 'META_CLOUD',
      name: payload.name || 'WhatsApp Hattı',
      display_phone_number: `+90 850 ${payload.phone_number_id.slice(-6).replace(/(\d{3})(\d{3})/, '$1 $2')}`,
      phone_number_e164: `+90850${payload.phone_number_id.slice(-7)}`,
      phone_number_id: payload.phone_number_id,
      waba_id: payload.waba_id,
      business_account_id: payload.business_account_id,
      status: 'ACTIVE',
      quality_rating: 'GREEN',
      verified_name: payload.name || 'Tezlify İşletmesi',
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    numbers.unshift(number);
    emit({ event: 'number_updated', id: number.id, status: number.status });
    return { ...number };
  }

  static async updateWhatsAppNumber(numberId: number, payload: WhatsAppNumberUpdatePayload): Promise<WhatsAppNumber> {
    const number = numbers.find((n) => n.id === numberId);
    if (!number) throw new Error('WhatsApp hattı bulunamadı.');
    if (payload.name !== undefined) number.name = payload.name;
    number.updated_at = nowIso();
    emit({ event: 'number_updated', id: number.id, status: number.status });
    return { ...number };
  }

  static async verifyWhatsAppNumber(numberId: number): Promise<WhatsAppNumberVerifyResult> {
    const number = numbers.find((n) => n.id === numberId);
    if (!number) throw new Error('WhatsApp hattı bulunamadı.');
    number.status = 'ACTIVE';
    number.quality_rating = number.quality_rating || 'GREEN';
    number.last_verified_at = nowIso();
    number.updated_at = nowIso();
    emit({ event: 'number_updated', id: number.id, status: number.status });
    return {
      id: number.id,
      status: number.status,
      verified: true,
      verified_name: number.verified_name,
      quality_rating: number.quality_rating,
      last_verified_at: number.last_verified_at,
    };
  }

  static async disconnectWhatsAppNumber(numberId: number): Promise<WhatsAppNumber> {
    const number = numbers.find((n) => n.id === numberId);
    if (!number) throw new Error('WhatsApp hattı bulunamadı.');
    number.status = 'DISCONNECTED';
    number.updated_at = nowIso();
    emit({ event: 'number_updated', id: number.id, status: number.status });
    return { ...number };
  }

  static async deleteWhatsAppNumber(numberId: number): Promise<{ success: boolean; message: string }> {
    const idx = numbers.findIndex((n) => n.id === numberId);
    if (idx === -1) throw new Error('WhatsApp hattı bulunamadı.');
    numbers.splice(idx, 1);
    emit({ event: 'conversations_cleared' });
    return { success: true, message: 'Numara silindi' };
  }

  // -------------------------------------------------------------------------
  // Sessions & QR (frontend-only simulation)
  // -------------------------------------------------------------------------
  static async getWhatsAppSessions(): Promise<WhatsAppSession[]> {
    return sessions.map((s) => ({ ...s }));
  }

  static async createWhatsAppSession(name: string, maxDailyLimit: number = 50): Promise<WhatsAppSession> {
    const sessionName = name.trim() || 'Hat 1';
    const session: WhatsAppSession = {
      id: nextSessionId++,
      session_name: sessionName,
      status: 'SCAN_QR',
      qr_code: generateFakeQrDataUri(`session:${sessionName}:${Date.now()}`),
      is_active: true,
      warm_up_day: 1,
      daily_sent_count: 0,
      max_daily_limit: maxDailyLimit,
      is_phone_online: false,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    sessions.push(session);
    // Simulate device pairing after a short delay (frontend-only demo flow).
    setTimeout(() => {
      session.status = 'CONNECTED';
      session.phone_number = '+90 532 100 20 30';
      session.is_phone_online = true;
      session.battery_level = 100;
      session.qr_code = null;
      session.updated_at = nowIso();
      // Link a BAILEYS_QR number to the connected session so the hub's
      // "Aktif Numaralar" tab reflects the new line.
      const linked = numbers.find((n) => n.session_id === session.id);
      if (!linked) {
        const number: WhatsAppNumber = {
          id: nextNumberId++,
          provider: 'BAILEYS_QR',
          name: sessionName,
          display_phone_number: session.phone_number,
          phone_number_e164: '+905321002030',
          status: 'ACTIVE',
          session_id: session.id,
          quality_rating: 'UNKNOWN',
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        numbers.unshift(number);
        emit({ event: 'number_updated', id: number.id, status: number.status });
      }
      emit({
        event: 'session_connected',
        session_id: session.id,
        session_name: session.session_name,
        phone: session.phone_number,
        phone_number: session.phone_number,
      });
    }, 3500);
    emit({ event: 'session_qr_updated', session_id: session.id, qr_code: session.qr_code });
    return { ...session };
  }

  static async getSessionQr(sessionId: number): Promise<{ status: string; qr_code: string | null; phone: string | null }> {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error('Oturum bulunamadı.');
    return { status: session.status, qr_code: session.qr_code, phone: session.phone_number || null };
  }

  static async refreshSessionQr(sessionId: number): Promise<{ success: boolean; status: string; qr_code: string | null }> {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error('Oturum bulunamadı.');
    if (session.status === 'CONNECTED') {
      return { success: true, status: session.status, qr_code: null };
    }
    session.status = 'SCAN_QR';
    session.qr_code = generateFakeQrDataUri(`session:${session.session_name}:${Date.now()}`);
    session.updated_at = nowIso();
    emit({ event: 'session_qr_updated', session_id: session.id, qr_code: session.qr_code });
    return { success: true, status: session.status, qr_code: session.qr_code };
  }

  static async disconnectSession(sessionId: number): Promise<any> {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error('Oturum bulunamadı.');
    session.status = 'DISCONNECTED';
    session.updated_at = nowIso();
    emit({ event: 'session_disconnected', session_id: session.id, session_name: session.session_name });
    return { success: true, status: session.status };
  }

  static async deleteSession(sessionId: number): Promise<void> {
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return;
    sessions.splice(idx, 1);
    emit({ event: 'session_disconnected', session_id: sessionId });
  }

  // -------------------------------------------------------------------------
  // Conversations & messages
  // -------------------------------------------------------------------------
  static async getConversations(params?: {
    status?: ConversationStatus;
    whatsapp_number_id?: number;
    unread_only?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]> {
    let list = [...conversations];
    if (params?.status) list = list.filter((c) => c.status === params.status);
    if (params?.whatsapp_number_id !== undefined && params.whatsapp_number_id !== null) {
      list = list.filter((c) => c.whatsapp_number_id === params.whatsapp_number_id);
    }
    if (params?.unread_only) list = list.filter((c) => (c.unread_count || 0) > 0);
    if (params?.search && params.search.trim()) {
      const q = params.search.trim().toLowerCase();
      list = list.filter((c) =>
        (c.lead_name || '').toLowerCase().includes(q) ||
        (c.lead_phone || '').toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      const tA = new Date(a.last_message_at || a.created_at).getTime();
      const tB = new Date(b.last_message_at || b.created_at).getTime();
      return tB - tA || b.id - a.id;
    });
    if (params?.offset) list = list.slice(params.offset);
    if (params?.limit) list = list.slice(0, params.limit);
    return list.map((c) => ({ ...c }));
  }

  static async getConversation(conversationId: number): Promise<ConversationDetail> {
    return conversationDetail(findConversationOrThrow(conversationId));
  }

  static async getConversationMessages(
    conversationId: number,
    _params?: { limit?: number; before?: number }
  ): Promise<ConversationMessagesResponse> {
    const conv = findConversationOrThrow(conversationId);
    const messages = sortMessages(messagesByConversation[conv.id] || []);
    return {
      messages: messages.map((m) => ({ ...m })),
      has_more: false,
      oldest_message_id: messages.find((m) => typeof m.id === 'number')?.id as number | undefined,
      newest_message_id: typeof messages[messages.length - 1]?.id === 'number' ? (messages[messages.length - 1].id as number) : undefined,
    };
  }

  static async getLeadConversation(leadId: number): Promise<ConversationDetail> {
    let conv = conversations.find((c) => c.lead_id === leadId);
    if (!conv) {
      conv = {
        id: nextConversationId++,
        lead_id: leadId,
        channel: 'WHATSAPP',
        status: 'ACTIVE',
        unread_count: 0,
        lead_name: `Müşteri #${leadId}`,
        lead_phone: '',
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      conversations.unshift(conv);
      messagesByConversation[conv.id] = [];
    }
    return conversationDetail(conv);
  }

  static async startConversation(data: { phone: string; name?: string; message?: string }): Promise<ConversationDetail> {
    const raw = (data.phone || '').trim();
    if (!raw) throw new Error('Telefon numarası gereklidir.');
    const digits = raw.replace(/\D/g, '');
    const e164 = digits.startsWith('90') ? `+${digits}` : `+90${digits.replace(/^0/, '')}`;

    const existing = conversations.find((c) => last10(c.lead_phone) === last10(e164));
    if (existing) {
      if (data.message?.trim()) {
        await WhatsAppRepository.sendMessage(existing.id, data.message.trim());
      }
      return conversationDetail(existing);
    }

    const conv: Conversation = {
      id: nextConversationId++,
      lead_id: nextConversationId,
      whatsapp_number_id: numbers[0]?.id,
      contact_id: nextConversationId,
      channel: 'WHATSAPP',
      status: 'ACTIVE',
      unread_count: 0,
      lead_name: data.name?.trim() || 'Yeni Müşteri',
      lead_phone: e164,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    conversations.unshift(conv);
    messagesByConversation[conv.id] = [];

    if (data.message?.trim()) {
      await WhatsAppRepository.sendMessage(conv.id, data.message.trim());
    }
    return conversationDetail(conv);
  }

  static async updateConversationStatus(conversationId: number, status: ConversationStatus): Promise<Conversation> {
    const conv = findConversationOrThrow(conversationId);
    conv.status = status;
    conv.updated_at = nowIso();
    emit({ event: 'conversation_status_updated', conversation_id: conv.id, status });
    return { ...conv };
  }

  static async markConversationAsRead(conversationId: number): Promise<Conversation> {
    const conv = findConversationOrThrow(conversationId);
    conv.unread_count = 0;
    conv.last_read_at = nowIso();
    emit({ event: 'conversation_read', conversation_id: conv.id, unread_count: 0 });
    return { ...conv };
  }

  static async markLeadConversationAsRead(leadId: number): Promise<Conversation> {
    const conv = conversations.find((c) => c.lead_id === leadId);
    if (!conv) throw new Error('Lead konuşması bulunamadı');
    return WhatsAppRepository.markConversationAsRead(conv.id);
  }

  static async sendMessage(conversationId: number, body: string, idempotencyKey?: string): Promise<Message> {
    const conv = findConversationOrThrow(conversationId);
    const clean = (body || '').trim();
    if (!clean) throw new Error('Mesaj metni boş olamaz.');

    const existing = (messagesByConversation[conversationId] || []).find(
      (m) => idempotencyKey && m.client_message_id === idempotencyKey
    );
    if (existing) return { ...existing };

    const msg = enqueueMessage(conversationId, {
      body: clean,
      client_message_id: idempotencyKey || `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_name: 'Siz',
      sender_phone: 'ME',
      recipient_phone: conv.lead_phone || '',
    });
    touchConversation(conv, clean);
    simulateDelivery(msg, conversationId);
    return { ...msg };
  }

  static async sendTemplate(
    conversationId: number,
    templateKey: string,
    variables: Record<string, string> = {},
    idempotencyKey?: string
  ): Promise<Message> {
    const conv = findConversationOrThrow(conversationId);
    const tmpl = templates.find((t) => t.key === templateKey);
    const body = tmpl ? renderTemplate(tmpl, variables, conv.lead_name || '') : `[Şablon: ${templateKey}]`;
    const msg = enqueueMessage(conversationId, {
      body,
      message_type: 'TEMPLATE',
      client_message_id: idempotencyKey || `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_name: 'Siz',
      sender_phone: 'ME',
      recipient_phone: conv.lead_phone || '',
    });
    touchConversation(conv, body);
    simulateDelivery(msg, conversationId);
    return { ...msg };
  }

  static async retryMessage(conversationId: number, messageId: number | string): Promise<Message> {
    const list = messagesByConversation[conversationId] || [];
    const target = list.find((m) => m.id === messageId);
    if (!target) throw new Error('Mesaj bulunamadı.');
    if (target.direction !== 'OUTBOUND') throw new Error('Yalnızca giden mesajlar tekrar denenebilir.');
    target.status = 'PENDING';
    target.error_message = undefined;
    simulateDelivery(target, conversationId);
    return { ...target };
  }

  static async sendMedia(
    conversationId: number,
    mediaData: { media_type: string; media_url: string; caption?: string; filename?: string },
    idempotencyKey?: string
  ): Promise<Message> {
    const conv = findConversationOrThrow(conversationId);
    const isImage = mediaData.media_type.toLowerCase() === 'image';
    const msg = enqueueMessage(conversationId, {
      body: mediaData.caption || mediaData.filename || mediaData.media_url || `[${isImage ? 'Görsel' : 'Belge'}]`,
      message_type: isImage ? 'IMAGE' : 'DOCUMENT',
      client_message_id: idempotencyKey || `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      media_url: mediaData.media_url,
      media_filename: mediaData.filename,
      media_caption: mediaData.caption,
      sender_name: 'Siz',
      sender_phone: 'ME',
      recipient_phone: conv.lead_phone || '',
    });
    touchConversation(conv, msg.body || '');
    simulateDelivery(msg, conversationId);
    return { ...msg };
  }

  static async getTemplates(): Promise<WhatsAppTemplate[]> {
    return templates.map((t) => ({ ...t }));
  }

  // -------------------------------------------------------------------------
  // Test sandbox & logs
  // -------------------------------------------------------------------------
  static async sendTestMessage(phone: string, message: string, _sessionId?: number): Promise<any> {
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits) throw new Error('Geçerli bir telefon numarası girin.');
    const e164 = digits.startsWith('90') ? `+${digits}` : `+90${digits.replace(/^0/, '')}`;
    const mid = `sim_${Date.now()}_${Math.floor(100000 + Math.random() * 900000)}`;
    recordLog(0, e164, message || '', 'SENT');
    emit({
      event: 'outbound_message_sent',
      recipient_phone: e164,
      message,
      message_id: mid,
      status: 'SENT',
    });
    return {
      success: true,
      message: 'Test mesajı gönderildi (frontend-only simülasyon)',
      message_id: mid,
      is_simulated: true,
    };
  }

  static async getMessageLogs(): Promise<MessageLog[]> {
    return messageLogs.map((l) => ({ ...l }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hashInt(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return h;
}

function renderTemplate(tmpl: WhatsAppTemplate, variables: Record<string, string>, leadName: string): string {
  let rendered = tmpl.body_pattern;
  for (const v of tmpl.variables || []) {
    const value =
      variables[v.key] ||
      (v.default_from === 'lead_name' ? leadName : '') ||
      v.default_value ||
      `[${v.label}]`;
    rendered = rendered.replace(new RegExp(`\\{${v.key}\\}`, 'g'), value);
  }
  return rendered;
}

/** Internal reset helper for tests/demos. */
export function __resetWhatsAppRepository() {
  numbers.length = 0;
  sessions.length = 0;
  conversations.length = 0;
  Object.keys(messagesByConversation).forEach((k) => delete messagesByConversation[Number(k)]);
  templates.length = 0;
  messageLogs.length = 0;
  numbers.push(...initialNumbers.map((n) => ({ ...n })));
  sessions.push(...initialSessions.map((s) => ({ ...s })));
  conversations.push(...initialConversations.map((c) => ({ ...c })));
  Object.entries(initialMessages).forEach(([k, v]) => {
    messagesByConversation[Number(k)] = v.map((m) => ({ ...m }));
  });
  templates.push(...initialTemplates.map((t) => ({ ...t })));
  messageLogs.push(...initialMessageLogs.map((l) => ({ ...l })));
  nextNumberId = 100;
  nextSessionId = 100;
  nextConversationId = 100;
  nextMessageId = 1000;
  nextLogId = 10000;
}