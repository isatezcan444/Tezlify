import { Conversation } from '../../../types';
import { parseServerTime } from '../../../lib/utils';

/**
 * Resolves the true activity timestamp of a conversation following WhatsApp Web parity:
 * Fallback precedence:
 * 1. last_message_at (latest message instant)
 * 2. updated_at (conversation level update)
 * 3. created_at (conversation creation instant)
 */
export function getConversationActivityTimestamp(c: Partial<Conversation> | null | undefined): number {
  if (!c) return 0;

  if (c.last_message_at) {
    const d = parseServerTime(c.last_message_at);
    if (d && !isNaN(d.getTime())) return d.getTime();
  }

  if (c.updated_at) {
    const d = parseServerTime(c.updated_at);
    if (d && !isNaN(d.getTime())) return d.getTime();
  }

  if (c.created_at) {
    const d = parseServerTime(c.created_at);
    if (d && !isNaN(d.getTime())) return d.getTime();
  }

  return 0;
}

/**
 * Deterministically sorts conversations such that the conversation with the most recent
 * activity is placed at the top (index 0).
 * Ties are broken by descending conversation ID.
 */
export function compareConversationsByActivityDesc(a: Conversation, b: Conversation): number {
  const timeA = getConversationActivityTimestamp(a);
  const timeB = getConversationActivityTimestamp(b);

  if (timeB !== timeA) {
    return timeB - timeA;
  }

  return (b.id ?? 0) - (a.id ?? 0);
}
