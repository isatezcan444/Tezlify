/**
 * Conversation message hydration: the single owner of the per-conversation
 * load lifecycle.
 *
 * WHY THIS EXISTS
 * ---------------
 * The loading lifecycle was inlined in WhatsAppHubPage, which made three
 * defects possible at once:
 *
 * 1. hydrateConversationMessages was called from INSIDE a setSelectedConv
 *    updater. Updaters must be pure, and React StrictMode double-invokes them.
 *    Every invocation aborted the in-flight request and started a new one, so
 *    when the conversation list refreshed more often than the messages fetch
 *    completed — WebSocket events, background backfill, tab visibility — the
 *    fetch was restarted before it could finish. "Mesajlar yükleniyor..." then
 *    meant a request that was perpetually being cancelled, not one that was
 *    slow. This is the reported deadlock.
 *
 * 2. The superseded and aborted paths returned WITHOUT clearing the load
 *    state, so an interrupted conversation stayed 'loading' permanently even
 *    after nothing was in flight any more.
 *
 * 3. Nothing could be tested, because the lifecycle was entangled with 2,700
 *    lines of page state.
 *
 * The contract the UI relies on, and which this module now enforces:
 *   - a state may be 'loading' only while a request for it can still settle;
 *   - if that request is superseded or aborted, the state must leave 'loading'
 *     (another request owns it, or it becomes 'error'/'idle');
 *   - every terminal path — success, empty, rejection, timeout — settles.
 */

export type ConversationLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface HydrationRequest {
  controller: AbortController;
  token: symbol;
}

/**
 * What a message must expose to be mergeable. `id` is deliberately
 * string|number: the API type allows both, and narrowing it to number here
 * would have rejected the real Message type at compile time.
 */
export interface Identityish {
  id?: string | number | null;
  wa_message_id?: string | null;
  client_message_id?: string | null;
}

export interface ConversationHydratorOptions<T> {
  fetchMessages: (
    conversationId: number,
    init: { signal: AbortSignal },
  ) => Promise<{ messages: T[]; has_more?: boolean; oldest_message_id?: number | null }>;
  onMessages: (
    conversationId: number,
    messages: T[],
    meta: { has_more: boolean; oldest?: number | null },
  ) => void;
  getExisting?: (conversationId: number) => T[];
  merge?: (fetched: T[], existing: T[]) => T[];
  describeError?: (err: unknown) => string;
  timeoutMs?: number;
}

export interface ConversationHydrator<T> {
  hydrate: (conversationId: number) => void;
  release: (conversationId: number) => void;
  getState: (conversationId: number) => ConversationLoadState;
  getError: (conversationId: number) => string | undefined;
  subscribe: (listener: (conversationId: number, state: ConversationLoadState) => void) => void;
  dispose: () => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const mergeByIdentity = <T extends Identityish>(fetched: T[], existing: T[]): T[] => {
  const byId = new Set(fetched.map((m) => m.id).filter(Boolean));
  const byWa = new Set(fetched.map((m) => m.wa_message_id).filter(Boolean));
  const byClient = new Set(fetched.map((m) => m.client_message_id).filter(Boolean));
  const keep = existing.filter(
    (m) =>
      !(m.id && byId.has(m.id)) &&
      !(m.wa_message_id && byWa.has(m.wa_message_id)) &&
      !(m.client_message_id && byClient.has(m.client_message_id)),
  );
  return [...fetched, ...keep];
};

export function createConversationHydrator<T extends Identityish>(
  options: ConversationHydratorOptions<T>,
): ConversationHydrator<T> {
  const {
    fetchMessages,
    onMessages,
    getExisting,
    merge = mergeByIdentity,
    describeError,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const requests = new Map<number, HydrationRequest>();
  const states = new Map<number, ConversationLoadState>();
  const errors = new Map<number, string>();
  const committed = new Map<number, number>();
  const listeners = new Set<(id: number, state: ConversationLoadState) => void>();
  let disposed = false;

  const publish = (id: number, state: ConversationLoadState) => {
    states.set(id, state);
    // Copy first: a listener may unsubscribe during dispatch.
    for (const fn of Array.from(listeners)) fn(id, state);
  };

  const hydrate = (conversationId: number) => {
    if (disposed) return;

    // Supersede whatever was running for this conversation. The old one must
    // not write anything — `isCurrent` gates every commit below.
    const previous = requests.get(conversationId);
    if (previous) previous.controller.abort();

    const controller = new AbortController();
    const token = Symbol(`conversation-${conversationId}`);
    requests.set(conversationId, { controller, token });
    const isCurrent = () => requests.get(conversationId)?.token === token;

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    errors.delete(conversationId);
    publish(conversationId, 'loading');

    void (async () => {
      try {
        const res = await fetchMessages(conversationId, { signal: controller.signal });

        if (disposed) return;
        // A newer request owns this conversation now, and it is responsible for
        // the state. Returning without touching it is correct here; what is NOT
        // correct is leaving it at 'loading', which `release` below prevents.
        if (!isCurrent()) return;

        if (!res || !Array.isArray(res.messages)) {
          throw new Error('messages missing from response');
        }

        const existing = getExisting?.(conversationId) ?? [];
        const merged = merge(res.messages, existing);
        onMessages(conversationId, merged, {
          has_more: Boolean(res.has_more),
          oldest: res.oldest_message_id,
        });
        committed.set(conversationId, (committed.get(conversationId) ?? 0) + 1);
        errors.delete(conversationId);
        publish(conversationId, 'ready');
      } catch (err) {
        if (disposed) return;
        if (!isCurrent()) return;

        // Every failure settles. A stuck spinner with no request behind it is
        // the bug this module exists to make impossible.
        errors.set(conversationId, describeError ? describeError(err) : String(err));
        publish(conversationId, 'error');
      } finally {
        clearTimeout(timer);
        if (isCurrent()) requests.delete(conversationId);
      }
    })();
  };

  /**
   * Leaving a conversation cancels only its own work, and moves the state out
   * of 'loading' — otherwise returning to it shows a spinner for a request
   * that was already cancelled, and the retry never comes.
   */
  const release = (conversationId: number) => {
    const req = requests.get(conversationId);
    if (req) {
      req.controller.abort();
      requests.delete(conversationId);
    }
    if (states.get(conversationId) === 'loading') {
      publish(conversationId, 'idle');
    }
  };

  const dispose = () => {
    disposed = true;
    for (const req of requests.values()) req.controller.abort();
    requests.clear();
    for (const [id, state] of states) {
      if (state === 'loading') publish(id, 'idle');
    }
    listeners.clear();
  };

  return {
    hydrate,
    release,
    getState: (id) => states.get(id) ?? 'idle',
    getError: (id) => errors.get(id),
    subscribe: (fn) => { listeners.add(fn); },
    dispose,
  };
}
