/** Durable gateway-to-backend event relay with ACK/replay semantics. */
import WebSocket from 'ws';
import { diagnostic } from './observability.js';

export function createEventBridge({ backendWsUrl, sessionManager, eventOutbox = null }) {
  const clients = new Set();
  const fallbackBuffer = [];
  const fallbackCapacity = 500;
  let fallbackDropped = 0;

  // QR-window (ephemeral) event buffer. See `bufferForPairing`.
  const pairingBuffers = new Map();
  const pairingCapacity = 2000;
  const pairingSessionCap = 20;
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
            void eventOutbox.acknowledge(message.event_id)
              .then(pumpOutbox)
              .catch((err) => {
                diagnostic('event_bridge_ack_error', { error_name: err?.name || 'Error', error_message: err?.message });
              });
          } else if (message?.type === 'gateway_event_nack' && message.event_id) {
            void eventOutbox.reject(message.event_id, { permanent: message.permanent === true })
              .then(pumpOutbox)
              .catch((err) => {
                diagnostic('event_bridge_nack_error', { error_name: err?.name || 'Error', error_message: err?.message });
              });
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

  // Kalici olmayan en-iyi-caba teslimi (outbox yokken ya da outbox yazimi
  // basarisiz oldugunda). Kuyruk sinirlidir; tasma diagnostik ile raporlanir.
  function deliverBestEffort(event) {
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

  /**
   * Holds a durable event that was produced while the session had no
   * `gateway_sessions` row yet.
   *
   * Why: the outbox has an FK to that table, and during a QR pairing the row is
   * created only on promotion, so every INSERT for the window fails with PG
   * 23503 (production logged ~24/day). Those events then took the best-effort
   * path, which means a backend that was momentarily unreachable lost them
   * outright — a real delivery gap, distinct from the "delivered but ownerless"
   * case the backend's own replay queue now covers.
   *
   * Held events are flushed into the DURABLE queue the moment the session is
   * registered, so promotion is what unblocks them. Bounded twice over (per
   * session, and by session count) and every eviction is counted: a silent
   * buffer is the same bug one layer down.
   */
  function bufferForPairing(sessionId, event) {
    const key = String(sessionId);
    let slot = pairingBuffers.get(key);
    if (!slot) {
      // Oldest session buffer evicted first; sessions are few, so this only
      // fires if ephemeral sessions leak without ever being cleaned up.
      if (pairingBuffers.size >= pairingSessionCap) {
        const oldest = pairingBuffers.keys().next().value;
        pairingBuffers.delete(oldest);
        diagnostic('pairing_buffer_session_evicted', { capacity: pairingSessionCap });
      }
      slot = { items: [], dropped: 0 };
      pairingBuffers.set(key, slot);
    }
    if (slot.items.length < pairingCapacity) {
      slot.items.push(event);
      return;
    }
    slot.dropped += 1;
    if (slot.dropped === 1 || slot.dropped % 50 === 0) {
      diagnostic('pairing_buffer_overflow', {
        capacity: pairingCapacity,
        dropped: slot.dropped,
        event_type: String(event?.event || 'unknown'),
      });
    }
  }

  /**
   * Moves a session's held QR-window events into the durable outbox.
   *
   * Called just before the first durable event of that session is enqueued, so
   * the buffered events are written first and keep their original order.
   */
  async function flushPairingBuffer(sessionId) {
    if (!eventOutbox) return 0;
    const key = String(sessionId);
    const slot = pairingBuffers.get(key);
    if (!slot) return 0;
    pairingBuffers.delete(key);
    if (slot.dropped) {
      diagnostic('pairing_buffer_flushed_with_losses', {
        flushed: slot.items.length,
        dropped: slot.dropped,
      });
    }
    let flushed = 0;
    for (const held of slot.items) {
      try {
        const durableEvent = await eventOutbox.enqueue(held);
        sendLocal(durableEvent);
        flushed += 1;
      } catch (error) {
        diagnostic('pairing_buffer_flush_failed', {
          event_type: String(held?.event || 'unknown'),
          error_code: error?.code || null,
        });
        deliverBestEffort(held);
      }
    }
    if (flushed) await pumpOutbox();
    return flushed;
  }

  function prunePairingBuffers() {
    for (const key of [...pairingBuffers.keys()]) {
      const live = sessionManager.getSession(key);
      if (!live || live.ephemeral === false) {
        // A registered session should have been flushed already; if it still
        // has a buffer, its flush event never arrived. Drop it rather than hold
        // memory for a session that can no longer promote.
        pairingBuffers.delete(key);
      }
    }
  }

  async function publish(event) {
    const sessionId = event?.gateway_session_id || event?.session_id;
    const session = sessionId ? sessionManager.getSession(String(sessionId)) : null;
    const isDelete = String(event?.event || '').startsWith('session_deleted');
    if (sessionId && !session && !isDelete) return;

    // An ephemeral (No-Create) pairing has NO gateway_sessions row by design:
    // `createSession` deliberately skips registerSession and the lease until
    // `connection.open` promotes it. The outbox FK
    // (event_outbox_session_id_fkey) therefore rejects every event emitted
    // during the QR window (PG 23503) — production logged 24 such failures in
    // one day and each attempt cost a failed statement. Durable storage is only
    // promised for REGISTERED sessions, the same boundary registerSession and
    // the lease already enforce, so an ephemeral session takes the best-effort
    // path directly instead of failing an INSERT it can never satisfy.
    // After promotion `session.ephemeral` flips to false and durable writes
    // resume on the next event.
    const skipDurable = Boolean(session?.ephemeral);

    // Promotion is the unblocking signal: the row exists now, so anything held
    // from the QR window can go to the durable queue — BEFORE this event, so
    // the original order is preserved.
    if (eventOutbox && !skipDurable && sessionId) {
      await flushPairingBuffer(sessionId);
    }

    const eventType = String(event?.event || event?.event_type || '');
    if (eventType === 'session_sync_progress') {
      // NOT: ilerleme olayı kasıtlı olarak KALICI DEĞİLDİR (her history chunk'ı
      // için üretilir; outbox'a yazmak kuyruğu sel basar). Ephemeral bir UI
      // sinyalidir; kaybı veri kaybı değildir. Durable olaylar outbox yolundan
      // gider.
      sendLocal(event);
      if (isOpen()) {
        backendSocket.send(JSON.stringify(event));
      }
      return;
    }

    if (eventOutbox && !skipDurable) {
      try {
        const durableEvent = await eventOutbox.enqueue(event);
        sendLocal(durableEvent);
        await pumpOutbox();
      } catch (error) {
        // G-10(c): outbox yazımı başarısızsa olay SESSİZCE DÜŞÜRÜLMEZ.
        // Enqueue atomik olarak başarısız olduğu için kayıt YOKTUR (çift
        // teslim riski yok); kalıcı olmayan yoldaki gibi en iyi çabayla
        // ilet. Böylece yalnızca outbox DB'si bozukken olay kaybolmaz.
        diagnostic('event_outbox_enqueue_failed', {
          event_type: String(event?.event || event?.event_type || 'unknown'),
          error_name: error?.name || 'Error',
          error_code: error?.code || null,
        });
        deliverBestEffort(event);
      }
      return;
    }

    if (eventOutbox && skipDurable) {
      // Durable event during the QR window: HELD, not best-effort only. Sending
      // it now would be useless anyway (the backend cannot resolve an owner
      // without the row) and would risk double delivery once it is flushed.
      // `sendLocal` still keeps the in-process clients informed.
      bufferForPairing(sessionId, event);
      sendLocal(event);
      return;
    }

    deliverBestEffort(event);
  }

  const unsubscribe = sessionManager.onEvent((event) => { void publish(event); });
  connectToBackend();
  if (eventOutbox) {
    retryTimer = setInterval(() => { void pumpOutbox(); }, 10_000);
    void cleanupOutbox();
    cleanupTimer = setInterval(() => {
      void cleanupOutbox();
      prunePairingBuffers();
    }, 10 * 60 * 1000);
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
