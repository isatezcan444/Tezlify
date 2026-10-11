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
