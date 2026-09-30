/**
 * Concurrency guard for the "load older messages" page fetch.
 *
 * WHY THIS EXISTS
 * ---------------
 * WhatsAppHubPage guarded older-page fetches with React state
 * (`activePaging.loading`). State is committed asynchronously, so two triggers
 * arriving in the same tick — a double click, or the scroll handler firing
 * again while the button is still visible — both read `loading === false` and
 * both fired a request for the SAME cursor.
 *
 * That is not a harmless duplicate. Two responses for one cursor race to
 * commit, the later one wins, and the scroll anchor captured for the first is
 * applied to a list whose height has already changed underneath it. The user
 * sees the thread jump, and the second response can also overwrite the paging
 * cursor written by the first, so the next page is fetched from the wrong
 * boundary and messages are skipped.
 *
 * The guard must therefore be synchronous and independent of render. A ref
 * flips on entry and is checked before any state is read, so a second trigger
 * in the same tick is rejected outright.
 *
 * The lock is per conversation: switching chats must not leave the previous
 * one locked, or returning to it could never load older messages again.
 */

export interface OlderPageRequest {
  controller: AbortController;
  token: symbol;
}

/**
 * Claim the lock for `convId`, or return null when a fetch already holds it.
 *
 * A null return means the caller must not start a request at all.
 */
export function claimOlderPage(
  inflight: Map<number, OlderPageRequest>,
  convId: number,
  createController: () => AbortController = () => new AbortController(),
): OlderPageRequest | null {
  if (inflight.has(convId)) return null;
  const request: OlderPageRequest = { controller: createController(), token: Symbol('older-page') };
  inflight.set(convId, request);
  return request;
}

/**
 * Release the lock, but only if `request` still owns it.
 *
 * The ownership check matters: a superseded request must not release the lock
 * that a newer request is now holding, or the next trigger would start a third
 * fetch while the second is still in flight.
 */
export function releaseOlderPage(
  inflight: Map<number, OlderPageRequest>,
  convId: number,
  request: OlderPageRequest,
): void {
  if (inflight.get(convId) === request) inflight.delete(convId);
}

/** True when `request` is still the current owner, i.e. its response may commit. */
export function isCurrentOlderPage(
  inflight: Map<number, OlderPageRequest>,
  convId: number,
  request: OlderPageRequest,
): boolean {
  return inflight.get(convId) === request;
}
