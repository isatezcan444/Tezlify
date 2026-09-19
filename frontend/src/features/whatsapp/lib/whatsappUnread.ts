/**
 * Unread badge resolution for realtime `conversation_updated` events.
 *
 * The gateway OWNS `unread_count` and reports it verbatim, including DECREASES —
 * reading a chat on the phone drops it to 0 and `chats.update` forwards that.
 * The backend persists it through its own staleness policy and then emits the
 * PERSISTED value (`conv.unread_count`), so whatever arrives here is already
 * guarded against stale snapshots.
 *
 * A monotonic `max(local, incoming)` is therefore always wrong: it can only
 * ever raise, so a read performed on the phone, on WhatsApp Web, or in another
 * tab could never clear the badge the user is staring at. Applying the value
 * verbatim is what makes the badge go DOWN.
 */
export function resolveUnreadCount(
  current: number | null | undefined,
  incoming: number | null | undefined,
): number | null | undefined {
  // An explicit value is authoritative — including 0.
  if (incoming != null) return incoming;
  // A partial event carries nothing; keep known state.
  return current;
}
