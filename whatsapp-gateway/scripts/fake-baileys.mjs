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
  if (registry.onCreate) registry.onCreate(sock, options);
  return sock;
}

export function __fakeRegistry() { return registry; }
