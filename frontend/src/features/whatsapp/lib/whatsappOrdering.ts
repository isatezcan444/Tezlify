import { Conversation } from '../../../types';
import { parseServerTime } from '../../../lib/utils';
import { extractCleanPhone } from './whatsappIdentity';

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

/**
 * I-7 — canonical dedup key for a conversation.
 *
 * `conversation.id` is the PRIMARY authority: it is the backend's unique
 * conversation key and the only value that cannot collide across two distinct
 * people. The old frontend key truncated the phone to its last 10 digits, so
 * two different contacts sharing a suffix could be merged into one visible row.
 *
 * The phone/JID fallback is used ONLY for rows that arrive without an id (which
 * should not happen) and uses the FULL canonical digits — never a suffix.
 */
export function getConversationIdentityKey(c: Partial<Conversation> | null | undefined): string {
  if (!c) return 'anon';
  const id = (c as any).id;
  if (typeof id === 'number' && Number.isFinite(id) && id > 0) return `id:${id}`;
  const raw = c.lead_phone || (c as any).phone || (c as any).jid || '';
  const rawStr = String(raw).trim();
  if (rawStr) {
    // §31: the phone-cleaning rule lives ONLY in `whatsappIdentity`. A LID or a
    // group identifier is NOT a phone number, so it must never be keyed as one
    // (`extractCleanPhone` returns null for `@lid` / `@g.us` by contract).
    // This also collapses equivalent spellings of the SAME number
    // (`+905321234567` / `05321234567` / `5321234567`) onto one key, which the
    // previous hand-rolled digit strip did not do.
    const clean = extractCleanPhone(rawStr);
    if (clean) return `phone:${clean}`;
    return `jid:${rawStr}`;
  }
  return `anon:${String(id ?? '')}`;
}

/**
 * Deduplicate conversations by canonical identity, preserving the incoming
 * (already sorted) order and summing unread counts of merged duplicates.
 */
export function dedupeConversationsByCanonicalIdentity(list: Conversation[]): Conversation[] {
  const seen = new Map<string, Conversation>();
  for (const c of list) {
    const key = getConversationIdentityKey(c);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...c });
      continue;
    }
    const existingTime = getConversationActivityTimestamp(existing);
    const currentTime = getConversationActivityTimestamp(c);
    if (currentTime > existingTime || (currentTime === existingTime && c.id > existing.id)) {
      seen.set(key, {
        ...c,
        unread_count: (c.unread_count || 0) + (existing.unread_count || 0),
      });
    } else {
      existing.unread_count = (existing.unread_count || 0) + (c.unread_count || 0);
    }
  }
  return Array.from(seen.values());
}

/**
 * F-6 — roll back the optimistic preview/activity write of a failed outbound
 * send so a message that never went out cannot read as the latest activity.
 *
 * The rollback is applied only when the conversation still carries the exact
 * optimistic values; if a real message superseded them meanwhile, the newer
 * activity is left untouched.
 */
export function restoreConversationActivity(
  c: Conversation,
  optimistic: { last_message_preview?: string; last_message_at?: string },
  previous: { last_message_preview?: string; last_message_at?: string },
): Conversation {
  const stillOptimistic =
    c.last_message_at === optimistic.last_message_at &&
    c.last_message_preview === optimistic.last_message_preview;
  if (!stillOptimistic) return c;
  return {
    ...c,
    last_message_preview: previous.last_message_preview,
    last_message_at: previous.last_message_at,
  };
}
