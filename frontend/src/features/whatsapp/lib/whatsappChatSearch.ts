/**
 * Pure helper functions for in-thread message search in WhatsApp.
 * Extracted from WhatsAppHubPage as part of Phase 2.1 safe micro-refactoring.
 */

export interface SearchableMessage {
  id: number | string;
  body?: string | null;
  media_caption?: string | null;
  media_filename?: string | null;
}

/**
 * Filters a message list for search matches.
 * Case-insensitive match on body, media_caption, or media_filename.
 * Matches are returned in the original message collection order as numeric IDs.
 *
 * @param messages List of messages in the active conversation
 * @param query Search query entered by user
 * @returns Array of matching message IDs (numbers)
 */
export function filterMatchingMessageIds(
  messages: SearchableMessage[] | undefined | null,
  query: string
): number[] {
  const q = (query || '').trim().toLowerCase();
  if (!q || !messages || messages.length === 0) {
    return [];
  }

  return messages
    .filter((msg) => {
      const body = (msg.body || '').toLowerCase();
      const caption = (msg.media_caption || '').toLowerCase();
      const filename = (msg.media_filename || '').toLowerCase();
      return body.includes(q) || caption.includes(q) || filename.includes(q);
    })
    .map((msg) => Number(msg.id));
}

/**
 * Resolves the currently active match ID given match IDs and a current 0-based index.
 * Falls back to matchingMessageIds[0] if current index is out of bounds.
 * Returns null if matchingMessageIds is empty.
 *
 * @param matchingIds Array of matched message IDs
 * @param currentIndex 0-based index of current match
 * @returns Active message ID (number) or null
 */
export function resolveActiveSearchMessageId(
  matchingIds: number[],
  currentIndex: number
): number | null {
  if (!matchingIds || matchingIds.length === 0) {
    return null;
  }
  return matchingIds[currentIndex] ?? matchingIds[0];
}

/**
 * Computes next match index with circular wrap-around.
 * If totalMatches <= 1, returns currentIndex without advancing.
 *
 * @param totalMatches Total count of matches
 * @param currentIndex Current 0-based index
 * @returns Next match index
 */
export function getNextSearchMatchIndex(totalMatches: number, currentIndex: number): number {
  if (totalMatches <= 1) {
    return currentIndex;
  }
  return (currentIndex + 1) % totalMatches;
}

/**
 * Computes previous match index with circular wrap-around.
 * If totalMatches <= 1, returns currentIndex without retreating.
 *
 * @param totalMatches Total count of matches
 * @param currentIndex Current 0-based index
 * @returns Previous match index
 */
export function getPrevSearchMatchIndex(totalMatches: number, currentIndex: number): number {
  if (totalMatches <= 1) {
    return currentIndex;
  }
  return (currentIndex - 1 + totalMatches) % totalMatches;
}

/**
 * Filters and returns full message objects matching the search query.
 * Case-insensitive match on body, media_caption, or media_filename.
 */
export function filterMatchingMessages<T extends SearchableMessage>(
  messages: T[] | undefined | null,
  query: string
): T[] {
  const q = (query || '').trim().toLowerCase();
  if (!q || !messages || messages.length === 0) {
    return [];
  }

  return messages.filter((msg) => {
    const body = (msg.body || '').toLowerCase();
    const caption = (msg.media_caption || '').toLowerCase();
    const filename = (msg.media_filename || '').toLowerCase();
    return body.includes(q) || caption.includes(q) || filename.includes(q);
  });
}

/**
 * Finds the first message occurring on or closest to a specified ISO date (YYYY-MM-DD).
 * Useful for "Jump to Date" feature in WhatsApp chat threads.
 *
 * @param messages List of messages sorted chronologically
 * @param targetDateStr Date string formatted as 'YYYY-MM-DD'
 * @returns Message ID (number) or null if not found
 */
export function findMessageIdByDate(
  messages: Array<SearchableMessage & { created_at?: string | null; timestamp?: string | number | null }> | undefined | null,
  targetDateStr: string
): number | null {
  if (!messages || messages.length === 0 || !targetDateStr) {
    return null;
  }

  const cleanTarget = targetDateStr.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanTarget)) {
    return null;
  }

  // Find exact day match first
  for (const msg of messages) {
    const rawDate = msg.created_at || (msg.timestamp ? new Date(msg.timestamp).toISOString() : null);
    if (rawDate && rawDate.slice(0, 10) === cleanTarget) {
      return Number(msg.id);
    }
  }

  // If no exact match, find closest message on or after target date
  for (const msg of messages) {
    const rawDate = msg.created_at || (msg.timestamp ? new Date(msg.timestamp).toISOString() : null);
    if (rawDate && rawDate.slice(0, 10) >= cleanTarget) {
      return Number(msg.id);
    }
  }

  // Fallback to the last available message
  return Number(messages[messages.length - 1].id);
}
