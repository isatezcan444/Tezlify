/**
 * The state transition for ONE older-page response, for the hub's own paging
 * state.
 *
 * WHY THIS EXISTS
 * ---------------
 * A page that makes NO progress must be terminal. The backend is honest but it
 * is not omniscient: `resolve_has_more` (backend `whatsapp_service.py`) keeps
 * `has_more` true whenever the provider evidence is unproven — NOT_CHECKED,
 * TIMEOUT, PROVIDER_ERROR — so an EMPTY page can legitimately come back with
 * `has_more: true` and `oldest_message_id: null`. That is the backend saying
 * "there may be more; I could not prove otherwise".
 *
 * The hub used to answer that with `hasMore: Boolean(res.has_more)` and
 * `oldest: res.oldest_message_id ?? prev.oldest`. For an empty page that keeps
 * the SAME cursor AND the SAME `hasMore: true`, so the control stayed visible
 * and re-sent the identical request forever: the spinner appears, nothing
 * arrives, and the button is still there. That is the reported "loading older
 * messages sometimes just does not work at all".
 *
 * `useWhatsAppConversation.loadOlderMessages` already terminates on an empty
 * page (`has_more: false`). This is the same rule applied to the hub's state,
 * plus a no-progress check on the cursor so a page that neither adds rows nor
 * advances the cursor can never loop.
 *
 * Ending the affordance is safe: `has_more` is re-derived from the server on the
 * next hydration, so the control returns by itself once the provider answers.
 */

export interface OlderPageResult {
  messages: unknown[];
  has_more: boolean;
  oldest_message_id?: number | null;
}

export interface OlderPageState {
  hasMore: boolean;
  oldest?: number;
  loading: boolean;
  error?: boolean;
}

/**
 * Apply one older-page response to the paging state.
 *
 * `prev` is the state the request was issued from. A response that adds no rows
 * and does not move the cursor is terminal for this render tree.
 */
export function applyOlderPageResult(
  prev: OlderPageState,
  res: OlderPageResult,
): OlderPageState {
  // Pagination cursors are always real numeric DB ids; `undefined` means the
  // backend had no page to report (an empty page), never "cursor is 0".
  const cursor =
    typeof res.oldest_message_id === 'number' && res.oldest_message_id > 0
      ? res.oldest_message_id
      : undefined;

  const noProgress =
    res.messages.length === 0 && (cursor === undefined || cursor === prev.oldest);
  if (noProgress) {
    return { hasMore: false, oldest: prev.oldest, loading: false };
  }

  return {
    hasMore: Boolean(res.has_more),
    oldest: cursor ?? prev.oldest,
    loading: false,
  };
}
