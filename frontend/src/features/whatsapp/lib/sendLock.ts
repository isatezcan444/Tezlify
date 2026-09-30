/**
 * Single-flight guard for sending one message.
 *
 * WHY THIS EXISTS
 * ---------------
 * ChatComposer guarded sends with React state (`sending`). State commits
 * asynchronously, so a double Enter — or Enter plus a click on the send button
 * in the same tick — both read `sending === false` and both called `onSend`.
 *
 * The backend's idempotency guard does not save us here. It is keyed on
 * `client_message_id`, and every call mints a fresh one
 * (`cmsg_<ts>_<rand>`), so two sends of the same text look like two unrelated
 * messages and both reach WhatsApp. The user sees their message appear twice,
 * and the recipient gets it twice.
 *
 * The guard must therefore be synchronous and independent of render, exactly
 * like the older-page lock. A ref flips before the async work starts, so a
 * second trigger in the same tick is rejected outright.
 *
 * Once the send settles the lock is released, so a failure never strands the
 * composer: the next attempt must go through.
 */

export interface SendLock {
  /** Run `fn` only if the lock is free. Returns null when a send is in flight. */
  run<T>(fn: () => Promise<T>): Promise<T | null>;
  /** True while a send is in flight. */
  isLocked(): boolean;
}

export function createSendLock(): SendLock {
  let inFlight = false;
  return {
    async run<T>(fn: () => Promise<T>): Promise<T | null> {
      if (inFlight) return null;
      inFlight = true;
      try {
        return await fn();
      } finally {
        // Released on success AND on failure: a rejected send must not leave the
        // composer permanently unable to send.
        inFlight = false;
      }
    },
    isLocked: () => inFlight,
  };
}
