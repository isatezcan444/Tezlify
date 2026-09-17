import type { Message, ConversationMessageStatus } from '../../../types';

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
        previous = previous ? { ...duplicate, ...previous,
          status: mergeDeliveryStatus(previous.status, duplicate.status) } : duplicate;
        result[duplicateSlot] = undefined;
        for (const [key, value] of identities) if (value === duplicateSlot) identities.set(key, slot);
      }
    }
    result[slot] = previous ? { ...previous, ...message,
      id: Number(previous.id) > 0 && !(Number(message.id) > 0) ? previous.id : message.id,
      wa_message_id: message.wa_message_id || previous.wa_message_id,
      client_message_id: message.client_message_id || previous.client_message_id,
      status: mergeDeliveryStatus(previous.status, message.status) } : message;
    for (const key of keys) identities.set(key, slot);
  }
  return result.filter((message): message is Message => message !== undefined).sort((a, b) => {
    const time = (m: Message) => new Date(m.external_timestamp || m.created_at || 0).getTime() || 0;
    return time(a) - time(b) || Number(a.id) - Number(b.id);
  });
}