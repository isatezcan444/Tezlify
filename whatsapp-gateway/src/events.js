/**
 * Event Bridge - forwards gateway events to the FastAPI backend via WebSocket.
 *
 * The backend subscribes to realtime WhatsApp events (messages, contacts,
 * chats, presence, session lifecycle) by connecting to the gateway WS at
 * `/ws`. The bridge also buffers events while the backend is disconnected
 * and replays them on reconnect so nothing is lost during deploys.
 */
import WebSocket from 'ws';

export function createEventBridge({ backendWsUrl, sessionManager }) {
  const clients = new Set(); // local WS clients (e.g. backend)
  const buffer = []; // events queued while backend is disconnected
  const MAX_BUFFER = 500;

  // When the backend protects /ws/gateway with WHATSAPP_GATEWAY_SECRET,
  // the gateway must present the same secret via ?token= (fail-closed auth).
  const bridgeSecret = process.env.WHATSAPP_GATEWAY_SECRET || '';
  const authedBackendWsUrl = bridgeSecret
    ? `${backendWsUrl}${backendWsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(bridgeSecret)}`
    : backendWsUrl;

  let backendSocket = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let isManuallyClosed = false;
  // Sorun (Render log): backend yeniden baslarken (redeploy / hibernate) köprü
  // sabit 3 sn'de bir yeniden baglanmayi deniyordu ve HER denemede
  // "connect ECONNREFUSED" WARNING'i yaziyordu — tek bir restart 10-20 satir
  // log uretiyordu. Artik ustel geri cekilme (3s -> 30s cap) + tekrar eden
  // hatalarda log seyreltme uygulanir. Baglanma davranisi degismez.
  let connectAttempt = 0;

  const RECONNECT_BASE_MS = 3000;
  const RECONNECT_MAX_MS = 30000;

  function nextBackoffMs() {
    const exp = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, connectAttempt - 1), RECONNECT_MAX_MS);
    // %20 jitter — es zamanli yeniden baglanma dalgasini onler.
    return Math.round(exp * (0.8 + Math.random() * 0.4));
  }

  function scheduleReconnect() {
    if (isManuallyClosed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectToBackend, nextBackoffMs());
  }

  function connectToBackend() {
    if (isManuallyClosed || backendSocket) return;
    try {
      const ws = new WebSocket(authedBackendWsUrl);
      backendSocket = ws;

      ws.on('open', () => {
        console.log('[bridge] Connected to backend WebSocket');
        connectAttempt = 0; // basarili baglanti sayaci sifirlar
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (backendSocket?.readyState === WebSocket.OPEN) {
            backendSocket.ping();
          }
        }, 25000);

        // Replay buffered events on reconnect (FIFO). Silinen oturumun
        // bayat olaylari replay'e girmeden dusurulur — aksi halde backend
        // her reconnect'te yuzlerce sahipsiz olayla sel olur (Render log).
        while (buffer.length > 0) {
          const evt = buffer.shift();
          const gwSid = evt && evt.gateway_session_id;
          if (gwSid && typeof sessionManager.getSession === 'function' && !sessionManager.getSession(gwSid)) {
            continue;
          }
          if (backendSocket?.readyState === WebSocket.OPEN) {
            backendSocket.send(JSON.stringify(evt));
          }
        }
      });

      ws.on('close', () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        backendSocket = null;
        scheduleReconnect();
      });

      ws.on('error', (err) => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        connectAttempt += 1;
        const isStartupRefused = (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) && connectAttempt <= 15;
        if (isStartupRefused) {
          if (connectAttempt === 1 || connectAttempt % 5 === 0) {
            console.log(`[bridge] Backend baslatiliyor, baglanti bekleniyor (deneme=${connectAttempt})...`);
          }
        } else if (connectAttempt === 1 || connectAttempt % 10 === 0) {
          console.warn(
            `[bridge] Backend WS error (deneme=${connectAttempt}): ${err.message}`
          );
        }
        ws.close();
      });
    } catch (err) {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      connectAttempt += 1;
      const isStartupRefused = (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) && connectAttempt <= 15;
      if (isStartupRefused) {
        if (connectAttempt === 1 || connectAttempt % 5 === 0) {
          console.log(`[bridge] Backend baslatiliyor, baglanti bekleniyor (deneme=${connectAttempt})...`);
        }
      } else {
        console.warn(`[bridge] Backend WS connect failed (deneme=${connectAttempt}): ${err.message}`);
      }
      scheduleReconnect();
    }
  }

  function broadcast(event) {
    const gwSid = event && (event.gateway_session_id || event.session_id);
    if (gwSid && typeof sessionManager.getSession === 'function' && !sessionManager.getSession(gwSid) && !String(event.event || '').startsWith('session_deleted')) {
      return;
    }
    const payload = JSON.stringify(event);
    // 1. Local WS clients (backend may also attach here)
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
    // 2. Outbound socket to backend
    if (backendSocket?.readyState === WebSocket.OPEN) {
      backendSocket.send(payload);
    } else {
      if (buffer.length < MAX_BUFFER) buffer.push(event);
    }
  }

  // Subscribe to all session manager events
  const unsubscribe = sessionManager.onEvent((event) => {
    broadcast(event);
  });

  // Start outbound connection to backend
  connectToBackend();

  return {
    attachClient(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({
        event: 'gateway_connected',
        sessions_count: sessionManager.listSessions().length,
      }));
    },
    detachClient(ws) {
      clients.delete(ws);
    },
    close() {
      isManuallyClosed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (backendSocket) backendSocket.close();
      unsubscribe();
    },
  };
}