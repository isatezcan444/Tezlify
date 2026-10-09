import type { Message, ConversationMessageStatus } from '../../../types';
import { compareMessagesChronological } from './whatsappOrdering';

export function mergeDeliveryStatus(current: ConversationMessageStatus, incoming: ConversationMessageStatus): ConversationMessageStatus {
  const rank: Record<ConversationMessageStatus, number> = { PENDING: 0, FAILED: 0, SENT: 1, DELIVERED: 2, READ: 3, RECEIVED: 3 };
  if (incoming === 'FAILED') return rank[current] > 0 ? current : incoming;
  if (current === 'FAILED' && incoming === 'PENDING') return current;
  return rank[incoming] >= rank[current] ? incoming : current;
}

/** Reconcile snapshots, HTTP responses and events using identity, never message text. */
export function mergeWhatsAppMessages(current: Message[], incoming: Message[]): Message[] {
  const result: Array<Message | undefined> = [];
  const identities = new Map<string, number>();
  for (const message of [...current, ...incoming]) {
    const keys = [`id:${message.id}`, ...(message.wa_message_id ? [`wa:${message.wa_message_id}`] : []),
      ...(message.client_message_id ? [`client:${message.client_message_id}`] : [])];
    const slots = [...new Set(keys.map((key) => identities.get(key)).filter((value): value is number => value !== undefined))];
    const slot = slots[0] ?? result.length;
    let previous = result[slot];
    // A provider echo and optimistic row may predate the event linking both IDs.
    for (const duplicateSlot of slots.slice(1)) {
      const duplicate = result[duplicateSlot];
      if (duplicate) {
        previous = previous ? {
          ...duplicate,
          ...previous,
          reactions: Array.isArray(previous.reactions) && previous.reactions.length > 0
            ? previous.reactions
            : duplicate.reactions,
          status: mergeDeliveryStatus(previous.status, duplicate.status),
        } : duplicate;
        result[duplicateSlot] = undefined;
        for (const [key, value] of identities) if (value === duplicateSlot) identities.set(key, slot);
      }
    }
    result[slot] = previous ? {
      ...previous,
      ...message,
      id: Number(previous.id) > 0 && !(Number(message.id) > 0) ? previous.id : message.id,
      body: (message.body && message.body.trim() !== '') ? message.body : previous.body,
      message_type: (message.message_type && message.message_type !== 'TEXT') ? message.message_type : (previous.message_type || message.message_type),
      wa_message_id: message.wa_message_id || previous.wa_message_id,
      client_message_id: message.client_message_id || previous.client_message_id,
      media_id: message.media_id || previous.media_id,
      media_url: message.media_url || previous.media_url,
      media_mime_type: message.media_mime_type || previous.media_mime_type,
      media_filename: message.media_filename || previous.media_filename,
      media_caption: message.media_caption || previous.media_caption,
      link_preview: message.link_preview || previous.link_preview,
      reactions: Array.isArray(message.reactions) ? message.reactions : previous.reactions,
      status: mergeDeliveryStatus(previous.status, message.status),
    } : message;
    for (const key of keys) identities.set(key, slot);
  }
  return result.filter((message): message is Message => message !== undefined).sort(compareMessagesChronological);
}