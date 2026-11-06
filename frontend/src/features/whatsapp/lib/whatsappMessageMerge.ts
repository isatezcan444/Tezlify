import type { Message, ConversationMessageStatus } from '../../../types';
import { compareMessagesChronological, isRealDbId } from './whatsappOrdering';

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
          quoted_message: previous.quoted_message || duplicate.quoted_message,
          is_view_once: Boolean(previous.is_view_once || duplicate.is_view_once),
          is_forwarded: Boolean(previous.is_forwarded || duplicate.is_forwarded),
          is_pinned: typeof previous.is_pinned === 'boolean' ? previous.is_pinned : duplicate.is_pinned,
          pinned_at: previous.pinned_at !== undefined ? previous.pinned_at : duplicate.pinned_at,
          pinned_until: previous.pinned_until !== undefined ? previous.pinned_until : duplicate.pinned_until,
          reactions: Array.isArray(previous.reactions) && previous.reactions.length > 0
            ? previous.reactions
            : duplicate.reactions,
          status: mergeDeliveryStatus(previous.status, duplicate.status),
        } : duplicate;
        result[duplicateSlot] = undefined;
        for (const [key, value] of identities) if (value === duplicateSlot) identities.set(key, slot);
      }
    }
    const isRevoked = Boolean(message.is_revoked || previous?.is_revoked);
    const keepPreviousEdited = Boolean(
      previous?.is_edited && (
        !message.is_edited ||
        (previous.edited_at && message.edited_at && new Date(previous.edited_at).getTime() >= new Date(message.edited_at).getTime())
      )
    );
    const resolvedBody = isRevoked
      ? ''
      : keepPreviousEdited
        ? previous.body
        : ((message.body && message.body.trim() !== '') ? message.body : (previous?.body || ''));
    const resolvedReactions = (Array.isArray(message.reactions) && message.reactions.length > 0)
      ? message.reactions
      : (Array.isArray(previous?.reactions) && previous.reactions.length > 0 ? previous.reactions : (message.reactions || []));
    result[slot] = previous ? {
      ...previous,
      ...message,
      id: isRealDbId(previous.id) && !isRealDbId(message.id) ? previous.id : message.id,
      body: resolvedBody,
      message_type: (message.message_type && message.message_type !== 'TEXT') ? message.message_type : (previous.message_type || message.message_type),
      wa_message_id: message.wa_message_id || previous.wa_message_id,
      client_message_id: message.client_message_id || previous.client_message_id,
      media_id: isRevoked ? undefined : (message.media_id || previous.media_id),
      media_url: isRevoked ? undefined : (message.media_url || previous.media_url),
      media_mime_type: isRevoked ? undefined : (message.media_mime_type || previous.media_mime_type),
      media_filename: isRevoked ? undefined : (message.media_filename || previous.media_filename),
      media_caption: isRevoked ? undefined : (message.media_caption || previous.media_caption),
      link_preview: isRevoked ? undefined : (message.link_preview || previous.link_preview),
      quoted_message: isRevoked ? undefined : (message.quoted_message || previous.quoted_message),
      reactions: resolvedReactions,
      status: mergeDeliveryStatus(previous.status, message.status),
      is_forwarded: Boolean(message.is_forwarded || previous.is_forwarded),
      is_pinned: typeof message.is_pinned === 'boolean' ? message.is_pinned : previous.is_pinned,
      pinned_at: message.pinned_at !== undefined ? message.pinned_at : previous.pinned_at,
      pinned_until: message.pinned_until !== undefined ? message.pinned_until : previous.pinned_until,
      is_view_once: Boolean(message.is_view_once || previous.is_view_once),
      is_edited: Boolean(message.is_edited || previous.is_edited),
      edited_at: message.edited_at || previous.edited_at,
      is_revoked: isRevoked,
      revoked_at: message.revoked_at || previous.revoked_at,
      is_deleted_for_me: Boolean(message.is_deleted_for_me || previous.is_deleted_for_me),
      deleted_for_me_at: message.deleted_for_me_at || previous.deleted_for_me_at,
      is_starred: typeof message.is_starred === 'boolean' ? message.is_starred : previous.is_starred,
      starred_at: message.starred_at !== undefined ? message.starred_at : previous.starred_at,
    } : message;
    for (const key of keys) identities.set(key, slot);
  }
  return result.filter((message): message is Message => message !== undefined && !message.is_deleted_for_me).sort(compareMessagesChronological);
}