/** Durable gateway-to-backend event relay with ACK/replay semantics. */
import WebSocket from 'ws';
import { diagnostic } from './observability.js';

export function createEventBridge({ backendWsUrl, sessionManager, eventOutbox = null }) {
  const clients = new Set();
  const fallbackBuffer = [];
  const fallbackCapacity = 500;
  let fallbackDropped = 0;
  let backendSocket = null;
  let reconnectTimer = null;
  let retryTimer = null;
  let cleanupTimer = null;
  let manuallyClosed = false;
  let connectAttempt = 0;
  let pumpRunning = false;

  const bridgeSecret = process.env.WHATSAPP_GATEWAY_SECRET || '';
  const targetUrl = bridgeSecret
    ? `${backendWsUrl}${backendWsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(bridgeSecret)}`
    : backendWsUrl;

  function isOpen() {
    return backendSocket?.readyState === WebSocket.OPEN;
  }

  function nextBackoffMs() {
    const base = Math.min(3000 * 2 ** Math.max(0, connectAttempt - 1), 30000);
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  function scheduleReconnect() {
    if (manuallyClosed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToBackend();
    }, nextBackoffMs());
  }

  function sendLocal(event) {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  let pumpScheduled = false;

  async function pumpOutbox() {
    if (!eventOutbox || !isOpen()) return;
    if (pumpRunning) {
      pumpScheduled = true;
      return;
    }
    pumpRunning = true;
    try {
      while (isOpen()) {
        pumpScheduled = false;
        const batch = await eventOutbox.claimPending(50);
        if (!batch || batch.length === 0) break;
        for (const item of batch) {
          if (!isOpen()) break;
          backendSocket.send(JSON.stringify(item.event));
        }
        diagnostic('event_outbox_batch_sent', {
          count: batch.length,
          first_sequence: batch[0].sequence,
          last_sequence: batch[batch.length - 1].sequence,
        });
        if (batch.length < 50) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (error) {
      diagnostic('event_outbox_pump_failed', {
        error_name: error?.name || 'Error',
        error_code: error?.code || null,
      });
    } finally {
      pumpRunning = false;
      if (pumpScheduled && isOpen()) {
        setImmediate(() => { void pumpOutbox(); });
      }
    }
  }

  async function cleanupOutbox() {
    try {
      await eventOutbox.cleanup();
    } catch (error) {
      diagnostic('event_outbox_cleanup_failed', {
        error_name: error?.name || 'Error', error_code: error?.code || null,
      });
    }
  }

  function flushFallbackBuffer() {
    const queued = fallbackBuffer.length;
    let replayed = 0;
    let discarded = 0;
    while (fallbackBuffer.length > 0 && isOpen()) {
      const event = fallbackBuffer.shift();
      const sessionId = event?.gateway_session_id;
      if (sessionId && !sessionManager.getSession(sessionId)) {
        discarded += 1;
        continue;
      }
      backendSocket.send(JSON.stringify(event));
      replayed += 1;
    }
    diagnostic('event_bridge_flush', {
      queued,
      replayed,
      discarded_deleted_session: discarded,
      dropped_while_disconnected: fallbackDropped,
    });
    fallbackDropped = 0;
  }

  function connectToBackend() {
    if (manuallyClosed || backendSocket) return;
    try {
      const socket = new WebSocket(targetUrl);
      backendSocket = socket;

      socket.on('open', () => {
        connectAttempt = 0;
        if (eventOutbox) {
          void eventOutbox.requeueInflight().then(pumpOutbox).catch((error) => {
            diagnostic('event_outbox_requeue_failed', {
              error_name: error?.name || 'Error', error_code: error?.code || null,
            });
          });
        } else {
          flushFallbackBuffer();
        }
      });

      socket.on('message', (raw) => {
        try {
          const message = JSON.parse(String(raw));
          // Backend keepalive ping — respond with pong to confirm bridge is alive.
          if (message?.type === 'ping') {
            if (isOpen()) socket.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (message?.type === 'pong') return;
          if (!eventOutbox) return;
          if (message?.type === 'gateway_event_ack' && message.event_id) {
            void eventOutbox.acknowledge(message.event_id).then(pumpOutbox);
          } else if (message?.type === 'gateway_event_nack' && message.event_id) {
            void eventOutbox.reject(message.event_id, { permanent: message.permanent === true })
              .then(pumpOutbox);
          }
        } catch (error) {
          diagnostic('event_bridge_invalid_ack', { error_name: error?.name || 'Error' });
        }
      });

      socket.on('close', (code, reason) => {
        diagnostic('event_bridge_socket_closed', { code, reason: reason?.toString?.() || '' });
        if (backendSocket === socket) backendSocket = null;
        scheduleReconnect();
      });

      socket.on('error', (error) => {
        connectAttempt += 1;
        if (connectAttempt === 1 || connectAttempt % 10 === 0) {
          diagnostic('event_bridge_connection_failed', {
            attempt: connectAttempt,
            error_code: error?.code || null,
          });
        }
        socket.close();
      });
    } catch (error) {
      connectAttempt += 1;
      diagnostic('event_bridge_connection_failed', {
        attempt: connectAttempt,
        error_code: error?.code || null,
      });
      backendSocket = null;
      scheduleReconnect();
    }
  }

  async function publish(event) {
    const sessionId = event?.gateway_session_id || event?.session_id;
    const isDelete = String(event?.event || '').startsWith('session_deleted');
    if (sessionId && !sessionManager.getSession(String(sessionId)) && !isDelete) return;

    const eventType = String(event?.event || event?.event_type || '');
    if (eventType === 'session_sync_progress') {
      sendLocal(event);
      if (isOpen()) {
        backendSocket.send(JSON.stringify(event));
      }
      return;
    }

    if (eventOutbox) {
      try {
        const durableEvent = await eventOutbox.enqueue(event);
        sendLocal(durableEvent);
        await pumpOutbox();
      } catch (error) {
        diagnostic('event_outbox_enqueue_failed', {
          event_type: String(event?.event || event?.event_type || 'unknown'),
          error_name: error?.name || 'Error',
          error_code: error?.code || null,
        });
      }
      return;
    }

    sendLocal(event);
    if (isOpen()) {
      backendSocket.send(JSON.stringify(event));
    } else if (fallbackBuffer.length < fallbackCapacity) {
      fallbackBuffer.push(event);
    } else {
      fallbackDropped += 1;
      if (fallbackDropped === 1 || fallbackDropped % 100 === 0) {
        diagnostic('event_bridge_buffer_overflow', {
          capacity: fallbackCapacity,
          dropped_since_disconnect: fallbackDropped,
          event_type: String(event?.event || 'unknown'),
        });
      }
    }
  }

  const unsubscribe = sessionManager.onEvent((event) => { void publish(event); });
  connectToBackend();
  if (eventOutbox) {
    retryTimer = setInterval(() => { void pumpOutbox(); }, 10_000);
    void cleanupOutbox();
    cleanupTimer = setInterval(() => { void cleanupOutbox(); }, 10 * 60 * 1000);
  }

  return {
    attachClient(socket) {
      clients.add(socket);
      socket.send(JSON.stringify({
        event: 'gateway_connected',
        sessions_count: sessionManager.listSessions().length,
      }));
    },
    detachClient(socket) { clients.delete(socket); },
    async cleanup() { return eventOutbox ? eventOutbox.cleanup() : 0; },
    close() {
      manuallyClosed = true;
      if (retryTimer) clearInterval(retryTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (backendSocket) backendSocket.close();
      unsubscribe();
    },
  };
}
