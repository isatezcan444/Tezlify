/** Owns socket generation and reconnect timer invariants for one session. */
export class SocketLifecycle {
  constructor({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._generation = 0;
    this._socket = null;
    this._reconnectTimer = null;
  }

  get generation() {
    return this._generation;
  }

  get hasReconnectTimer() {
    return this._reconnectTimer !== null;
  }

  beginAttempt() {
    this.cancelReconnect();
    this._generation += 1;
    return this._generation;
  }

  attach(generation, socket) {
    if (generation !== this._generation) return socket;
    const previous = this._socket;
    this._socket = socket;
    return previous && previous !== socket ? previous : null;
  }

  isCurrent(generation, socket) {
    return generation === this._generation && socket === this._socket;
  }

  scheduleReconnect(generation, socket, delayMs, callback) {
    if (!this.isCurrent(generation, socket) || this._reconnectTimer !== null) return false;
    const handle = this._setTimer(() => {
      if (this._reconnectTimer !== handle) return;
      this._reconnectTimer = null;
      if (this.isCurrent(generation, socket)) callback();
    }, delayMs);
    this._reconnectTimer = handle;
    return true;
  }

  cancelReconnect() {
    if (this._reconnectTimer === null) return;
    this._clearTimer(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  invalidate() {
    this.cancelReconnect();
    this._generation += 1;
    this._socket = null;
  }
}
