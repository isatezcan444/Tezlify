import { useEffect, useRef, useState } from 'react';
import { subscribeRealtime, type RealtimeSubscription } from '../api/client';
import type { OpsOperation, OpsRealtimeEvent } from '../types/admin';

export interface OpsEventHandlers {
  /** Fired for every `operation.*` event the server publishes. */
  onOperation: (operation: OpsOperation, event: string) => void;
  /** Fired when the socket transitions between connected and disconnected. */
  onConnectionChange?: (connected: boolean) => void;
}

/**
 * Subscribe to Operations Center realtime events on the shared `/ws` stream.
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend already publishes `operation.started` / `.progress` / `.log` /
 * `.<status>` (ops_service._publish) on the product's existing WebSocket, but
 * nothing consumed them, so the panel had to poll every few seconds to notice
 * that a restart had finished. This hook wires that stream to the page.
 *
 * DESIGN NOTES
 * ------------
 * - It reuses `createWebSocket`, the same managed factory WhatsApp uses, so
 *   auth-failure handling, token refresh and exponential backoff stay
 *   identical. A second bespoke socket would have duplicated that logic and
 *   reintroduced the 401 reconnect loop documented in client.ts.
 * - Events for operations started by ANOTHER admin tab are also delivered;
 *   that is intentional, since the server broadcasts to the owning user.
 * - Malformed frames are ignored rather than thrown: the shared stream also
 *   carries scraper and WhatsApp events that have no `operation` field.
 *
 * @param enabled Only connect while the admin panel is actually mounted and
 *   the user is an admin; a non-admin must not hold a socket open.
 * @returns whether the realtime stream is currently connected.
 */
export function useOpsEvents(
  enabled: boolean,
  { onOperation, onConnectionChange }: OpsEventHandlers,
): boolean {
  const [connected, setConnected] = useState<boolean>(false);
  // Handlers are read through a ref so a caller re-rendering with a new
  // closure does not tear down and rebuild the socket.
  const handlersRef = useRef<OpsEventHandlers>({ onOperation, onConnectionChange });
  handlersRef.current = { onOperation, onConnectionChange };

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }

    let socket: RealtimeSubscription | null = null;
    try {
      socket = subscribeRealtime(
        (data: unknown) => {
          const msg = data as Partial<OpsRealtimeEvent> | null;
          if (!msg || typeof msg.event !== 'string') return;
          if (!msg.event.startsWith('operation.')) return;
          if (!msg.operation || typeof msg.operation.id !== 'string') return;
          handlersRef.current.onOperation(msg.operation, msg.event);
        },
        (isConnected: boolean) => {
          setConnected(isConnected);
          handlersRef.current.onConnectionChange?.(isConnected);
        },
      );
    } catch {
      // A realtime hiccup must never break the panel: the page keeps its
      // polling fallback, so the operator can still see and run operations.
      setConnected(false);
    }

    return () => {
      socket?.close();
      setConnected(false);
    };
  }, [enabled]);

  return connected;
}