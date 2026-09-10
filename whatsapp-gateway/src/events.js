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

  let backendSocket = null;
  let reconnectTimer = null;
  let isManuallyClosed = false;

  function connectToBackend() {
    if (isManuallyClosed || backendSocket) return;
    try {
      const ws = new WebSocket(backendWsUrl);
      backendSocket = ws;

      ws.on('open', () => {
        console.log('[bridge] Connected to backend WebSocket');
        // Replay buffered events on reconnect (FIFO)
        while (buffer.length > 0) {
          const evt = buffer.shift();
          if (backendSocket?.readyState === WebSocket.OPEN) {
            backendSocket.send(JSON.stringify(evt));
          }
        }
      });

      ws.on('close', () => {
        backendSocket = null;
        if (!isManuallyClosed) {
          reconnectTimer = setTimeout(connectToBackend, 3000);
        }
      });

      ws.on('error', (err) => {
        console.warn('[bridge] Backend WS error:', err.message);
        ws.close();
      });
    } catch (err) {
      console.warn('[bridge] Backend WS connect failed:', err.message);
      reconnectTimer = setTimeout(connectToBackend, 3000);
    }
  }

  function broadcast(event) {
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
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (backendSocket) backendSocket.close();
      unsubscribe();
    },
  };
}