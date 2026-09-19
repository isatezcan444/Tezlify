import type { Conversation } from '../../../types';
import { mapConversationItem, buildConversationUpdatedPayload } from '../api/whatsappApi';
import { normalizePreviewText, shouldApplyPreview } from './whatsappPreview';
import { resolveUnreadCount } from './whatsappUnread';

/** A `conversation_updated` WS payload / REST conversation object. */
export type ConversationEventPayload = Record<string, any>;

/**
 * Apply one conversation event to a conversation row.
 *
 * This is the SINGLE merge path used by the hub page for `conversation_updated`
 * (both the list row and the selected conversation). It is pure so the same
 * logic can be driven by the DOM tests instead of a copy of it.
 *
 * Invariants it must hold:
 *  - a partial payload may only write fields it actually carries (the mapper
 *    copies on `!== undefined`); an explicit `null` stays authoritative;
 *  - an unresolved identity keeps the previously known name;
 *  - an OLDER gateway preview never rewinds `last_message_at` / the preview;
 *  - `unread_count` follows the backend policy and can go DOWN (P5-3 / P6-1).
 */
export function applyConversationEvent(
  current: Conversation,
  payload: ConversationEventPayload,
  t: (key: string) => string = (key) => key
): Conversation {
  const mapped = mapConversationItem(buildConversationUpdatedPayload(current.id, payload));

  const gwPreview = payload.last_message_preview
    ? normalizePreviewText(payload.message_type, String(payload.last_message_preview), t)
    : '';
  const gwTs = payload.last_message_at;

  const next: Conversation = { ...current, ...mapped };

  // Cozulmemis kimlikte mevcut ad korunur (gateway null gonderir).
  if (!mapped.lead_name) next.lead_name = current.lead_name;

  const applyGw = Boolean(gwPreview) && shouldApplyPreview(gwTs, current.last_message_at);
  next.last_message_preview = applyGw ? gwPreview : current.last_message_preview;
  next.last_message_at = applyGw ? gwTs || current.last_message_at : current.last_message_at;
  next.last_message_state = (applyGw ? gwPreview : current.last_message_preview)
    ? 'RESOLVED'
    : current.last_message_state;

  // P5-3: the badge must be able to go DOWN. The old `Math.max()` rule could
  // only raise it, so a chat read on the phone never cleared in the UI.
  next.unread_count = resolveUnreadCount(current.unread_count, payload.unread_count);

  return next;
}
