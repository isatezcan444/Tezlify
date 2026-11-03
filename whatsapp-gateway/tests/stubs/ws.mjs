/**
 * Test stub for `ws`. The event bridge is exercised with a fake outbox; this
 * socket deliberately never connects so no backend traffic is produced.
 */
export class WebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = WebSocket.CONNECTING;
    this.handlers = new Map();
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  send() {
    throw new Error('ws stub: no backend connection in unit tests');
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    return this;
  }

  terminate() {
    this.readyState = WebSocket.CLOSED;
    return this;
  }

  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
}

export class WebSocketServer extends WebSocket {
  constructor() {
    throw new Error('ws stub: WebSocketServer is not available in unit tests');
  }
}

export default WebSocket;
