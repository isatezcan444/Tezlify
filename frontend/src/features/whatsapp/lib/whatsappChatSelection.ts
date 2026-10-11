import { Message } from '../../../types';

/**
 * Pure helper functions for WhatsApp chat message selection, ordering, and copying.
 */

/**
 * Immutably toggles a message ID in a Set.
 * If present, deletes it; if absent, adds it.
 */
export function toggleSelectedMessageId(
  currentSet: Set<number | string>,
  messageId: number | string
): Set<number | string> {
  const next = new Set(currentSet);
  if (next.has(messageId)) {
    next.delete(messageId);
  } else {
    next.add(messageId);
  }
  return next;
}

/**
 * Resolves selected messages from a conversation's message list.
 * Strictly preserves the chronological order of the conversation.
 */
export function resolveSelectedMessages(
  messages: Message[] | undefined | null,
  selectedIds: Set<number | string>
): Message[] {
  if (!Array.isArray(messages) || messages.length === 0 || !selectedIds || selectedIds.size === 0) {
    return [];
  }
  return messages.filter((m) => m && selectedIds.has(m.id));
}

/**
 * Formats a list of messages into plaintext for clipboard copying.
 * Uses body, media caption, or filename fallback, separated by newlines.
 */
export function formatMessagesForCopy(messages: Message[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  return messages
    .map((m) => {
      if (!m) return '';
      return m.body || m.media_caption || (m.media_filename ? `[${m.media_filename}]` : '');
    })
    .filter(Boolean)
    .join('\n');
}
