import { Conversation, Message } from '../../../types';
import { parseServerTime } from '../../../lib/utils';
import { extractCleanPhone } from './whatsappIdentity';

/**
 * Normalizes any timestamp representation into epoch milliseconds.
 * Accurately detects:
 * - 10-digit unix seconds (e.g. 1730000000 -> Nov 2024) and scales by 1000
 * - 13-digit epoch milliseconds
 * - ISO-8601 strings, server naive UTC representations
 */
export function normalizeMessageTimestampMs(raw: string | number | Date | null | undefined): number {
  if (!raw) return 0;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return isNaN(t) ? 0 : t;
  }
  if (typeof raw === 'number') {
    if (isNaN(raw) || raw <= 0) return 0;
    return raw < 100_000_000_000 ? raw * 1000 : raw;
  }
  const s = String(raw).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) {
    const num = Number(s);
    if (isNaN(num) || num <= 0) return 0;
    return num < 100_000_000_000 ? num * 1000 : num;
  }
  const d = parseServerTime(s);
  if (d && !isNaN(d.getTime())) {
    const t = d.getTime();
    if (t > 0 && t < 100_000_000_000) return t * 1000;
    return t;
  }
  return 0;
}

/**
 * Returns epoch milliseconds for a message timestamp honoring server UTC parsing
 * and unix second/millisecond normalization.
 */
export function getMessageTimestampMs(m: Partial<Message> | null | undefined): number {
  if (!m) return 0;
  return normalizeMessageTimestampMs(m.external_timestamp || m.created_at);
}

/**
 * Distinguishes genuine database-persisted integer IDs from optimistic client IDs.
 * Real DB IDs are positive integers < 1,000,000,000.
 */
export function isRealDbId(id: string | number | undefined | null): boolean {
  if (id === null || id === undefined) return false;
  if (typeof id === 'number') {
    return Number.isInteger(id) && id > 0 && id < 1_000_000_000;
  }
  if (typeof id === 'string') {
    if (id.startsWith('optimistic_') || id.startsWith('temp_')) return false;
    if (/^\d+$/.test(id)) {
      const n = Number(id);
      return Number.isInteger(n) && n > 0 && n < 1_000_000_000;
    }
  }
  return false;
}

/**
 * Deterministically sorts messages chronologically ascending (oldest first, newest last).
 * Ordering contract:
 * 1. Normalized timestamp ascending (primary key)
 * 2. Conversational causality: INBOUND before OUTBOUND when timestamps match
 * 3. Database integer ID ascending for confirmed server rows
 * 4. Confirmed server message before unconfirmed optimistic message
 * 5. Stable string key fallback (wa_message_id / client_message_id / id) for total order
 */
export function compareMessagesChronological(a: Message, b: Message): number {
  const timeA = getMessageTimestampMs(a);
  const timeB = getMessageTimestampMs(b);

  if (timeA !== timeB) {
    return timeA - timeB;
  }

  // Same timestamp: Conversational causality tie-breaker.
  // When an inbound question and outbound reply share the same second/instant,
  // the inbound message from the contact came first.
  const dirA = a.direction;
  const dirB = b.direction;
  if (dirA !== dirB) {
    if (dirA === 'INBOUND' && dirB === 'OUTBOUND') return -1;
    if (dirA === 'OUTBOUND' && dirB === 'INBOUND') return 1;
  }

  // Differentiate real DB IDs from 13-digit optimistic timestamps/strings:
  const isRealA = isRealDbId(a.id);
  const isRealB = isRealDbId(b.id);

  if (isRealA && isRealB) {
    const numA = Number(a.id);
    const numB = Number(b.id);
    if (numA !== numB) return numA - numB;
  } else if (isRealA && !isRealB) {
    // Confirmed database row happened before pending optimistic message
    return -1;
  } else if (!isRealA && isRealB) {
    return 1;
  }

  // Both are optimistic or same ID: use stable identity string
  const keyA = a.wa_message_id || a.client_message_id || String(a.id || '');
  const keyB = b.wa_message_id || b.client_message_id || String(b.id || '');
  return keyA.localeCompare(keyB);
}

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
