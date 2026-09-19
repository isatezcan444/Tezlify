/**
 * Test double for the Baileys network boundary (Phase 6.4).
 *
 * Re-exports the REAL installed Baileys and overrides only `makeWASocket`,
 * which is the single call that opens a real WebSocket to WhatsApp. Everything
 * else in the module graph (qrcode encoding, DisconnectReason, Browsers,
 * fetchLatestBaileysVersion, message decoders...) is the genuine article, so a
 * test asserting "the gateway forwards qr" is asserting on real qrcode output,
 * not a stubbed string.
 *
 * Tests control the socket through `globalThis.__FAKE_BAILEYS__`.
 */
export * from '@whiskeysockets/baileys';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const registry = globalThis.__FAKE_BAILEYS__ || (globalThis.__FAKE_BAILEYS__ = {
  sockets: [],
  onCreate: null,
  pairingCalls: [],
  // What requestPairingCode() should do; tests override.
  pairingImpl: null,
});

export function makeWASocket(options = {}) {
  const ev = new EventEmitter();
  ev.setMaxListeners(0);

  const sock = {
    id: `fake-${randomUUID().slice(0, 8)}`,
    options,
    ev,
    user: undefined,
    ended: false,
    end() { this.ended = true; },
    logout: async () => {},
    async requestPairingCode(phone) {
      registry.pairingCalls.push({ phone, sock: this, at: Date.now() });
      if (registry.pairingImpl) return registry.pairingImpl(phone, this);
      return '12345678';
    },
    /**
     * Emulate Baileys' pairing side-effect on the AUTH STATE, which is the one
     * thing `makeWASocket` does that a pure event-firing stub would miss.
     *
     * Real Baileys mutates `auth.creds` in place during the pairing handshake —
     * it sets `creds.me = {id, name, lid}` and `creds.registered = true` — and
     * only then emits `creds.update` followed by `connection.update {open}`.
     * Those credentials are what `useMultiFileAuthState` writes to
     * `creds.json`, and their presence on disk is exactly what suppresses the
     * QR on a later restart. Without this method a "restart" test would assert
     * on credentials that were never registered and prove nothing.
     */
    completePairing(jid = '905413749073@s.whatsapp.net') {
      const creds = options && options.auth && options.auth.creds;
      if (!creds) throw new Error('fake socket was not given an auth state');
      creds.me = { id: jid, name: 'Test Device', lid: '100000000000001@lid' };
      creds.registered = true;
      return creds;
    },
    async sendMessage() { return { key: { id: randomUUID() } }; },
    async sendPresenceUpdate() {},
    async readMessages() {},
    async profilePictureUrl() { return null; },
    async onWhatsApp() { return []; },
    async groupMetadata() { return { participants: [] }; },
    async chatModify() {},
    async sendReceipt() {},
    async fetchMessageHistory() { return []; },
    ws: { close() {}, readyState: 1 },
  };

  registry.sockets.push(sock);

  if (process.env.FAKE_BAILEYS_TRACE === '1') {
    console.log(
      `[fake-baileys] makeWASocket #${registry.sockets.length} id=${sock.id} ` +
        `autoQr=${process.env.FAKE_BAILEYS_AUTO_QR || '0'} ` +
        `autoConnectMs=${process.env.FAKE_BAILEYS_AUTO_CONNECT_MS || '0'} ` +
        `registered=${Boolean(options?.auth?.creds?.registered)}`
    );
  }

  // Standalone-server mode: when the REAL gateway is launched as a process
  // (`src/index.js`) there is no test in-process to drive the socket, so the
  // double must behave like a provider that actually issues a QR. Only enabled
  // by an explicit env flag, and it never touches product code.
  if (process.env.FAKE_BAILEYS_AUTO_QR === '1') {
    const delayMs = parseInt(process.env.FAKE_BAILEYS_AUTO_QR_DELAY_MS || '60', 10);
    let n = 0;
    const emit = () => {
      if (sock.ended) return;
      n += 1;
      ev.emit('connection.update', { qr: `2@FAKE-QR-${sock.id}-${n},${Date.now()}` });
    };
    setTimeout(emit, delayMs);
    if (process.env.FAKE_BAILEYS_AUTO_QR_ROTATE === '1') {
      setInterval(emit, parseInt(process.env.FAKE_BAILEYS_AUTO_QR_INTERVAL_MS || '2500', 10));
    }
    // Stand-in for the user actually scanning: complete the handshake and open
    // the connection, exactly as real Baileys would after a genuine scan.
    const connectMs = parseInt(process.env.FAKE_BAILEYS_AUTO_CONNECT_MS || '0', 10);
    if (connectMs > 0) {
      setTimeout(() => {
        if (process.env.FAKE_BAILEYS_TRACE === '1') {
          console.log(`[fake-baileys] auto-connect firing for ${sock.id} (ended=${sock.ended})`);
        }
        if (sock.ended) return;
        const creds = options && options.auth && options.auth.creds;
        if (creds) {
          creds.me = { id: '905413749073@s.whatsapp.net', name: 'Fake Phone', lid: '100000000000001@lid' };
          creds.registered = true;
        }
        ev.emit('creds.update', {});
        ev.emit('connection.update', { connection: 'open' });
      }, connectMs);
    }
  }

  if (registry.onCreate) registry.onCreate(sock, options);
  return sock;
}

export function __fakeRegistry() { return registry; }
