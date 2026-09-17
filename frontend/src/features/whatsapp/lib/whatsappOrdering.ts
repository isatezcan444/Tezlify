import { Conversation } from '../../../types';
import { parseServerTime } from '../../../lib/utils';

/**
 * Resolves the true activity timestamp of a conversation following WhatsApp Web parity:
 * Strict precedence:
 * 1. last_message_at (latest message instant)
 *
 * Conversations without messages must NEVER sort above conversations with messages.
 * We return 0 so any conversation with a valid message timestamp ranks higher.
 * updated_at (contact sync, avatar fetch) MUST NOT bump a conversation to the top.
 */
export function getConversationActivityTimestamp(c: Partial<Conversation> | null | undefined): number {
  if (!c) return 0;

  if (c.last_message_at) {
    const d = parseServerTime(c.last_message_at);
    if (d && !isNaN(d.getTime())) return d.getTime();
  }

  return 0;
}

/**
 * Deterministically sorts conversations such that the conversation with the most recent
 * activity is placed at the top (index 0).
 *
 * Conversations with no messages (timestamp == 0) remain at the bottom,
 * tied-broken by created_at descending and ID descending.
 */
export function compareConversationsByActivityDesc(a: Conversation, b: Conversation): number {
  const timeA = getConversationActivityTimestamp(a);
  const timeB = getConversationActivityTimestamp(b);

  if (timeB !== timeA) {
    return timeB - timeA;
  }

  // Both have no messages (or identical last_message_at):
  // Tie-break by created_at desc if available, then descending conversation ID
  const createdA = a.created_at ? parseServerTime(a.created_at)?.getTime() || 0 : 0;
  const createdB = b.created_at ? parseServerTime(b.created_at)?.getTime() || 0 : 0;
  if (createdB !== createdA) {
    return createdB - createdA;
  }

  return (b.id ?? 0) - (a.id ?? 0);
}
