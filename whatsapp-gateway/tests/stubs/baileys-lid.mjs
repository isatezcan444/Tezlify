/**
 * Test stub for `@whiskeysockets/baileys`, covering every symbol imported by
 * the modules reachable from `session-manager.js`. No network or WhatsApp
 * account is ever touched: any function that would need Baileys throws.
 */
const notAvailable = (name) => async () => {
  throw new Error(`baileys stub: ${name} is not available in unit tests`);
};

export const makeWASocket = notAvailable('makeWASocket');
export const useMultiFileAuthState = notAvailable('useMultiFileAuthState');
export const makeCacheableSignalKeyStore = notAvailable('makeCacheableSignalKeyStore');
export const fetchLatestBaileysVersion = notAvailable('fetchLatestBaileysVersion');
export const downloadMediaMessage = notAvailable('downloadMediaMessage');
export const downloadContentFromMessage = notAvailable('downloadContentFromMessage');

export const Browsers = {
  macOS: () => ['Mac OS', 'Chrome', '1.0'],
  ubuntu: () => ['Ubuntu', 'Chrome', '1.0'],
  windows: () => ['Windows', 'Chrome', '1.0'],
  appropriate: () => ['Mac OS', 'Chrome', '1.0'],
};

export const DisconnectReason = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
};

export const BufferJSON = {
  replacer(_key, value) {
    return value && value.type === 'Buffer' && Array.isArray(value.data)
      ? { type: 'Buffer', data: value.data }
      : value;
  },
  reviver(_key, value) {
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    return value;
  },
};

export const initAuthCreds = async () => ({});

export const proto = {
  Message: {
    fromObject: (value) => value,
    toObject: (value) => value,
    encode: () => Buffer.alloc(0),
    decode: () => ({}),
  },
  WebMessageInfo: {
    Status: {
      ERROR: 0,
      PENDING: 1,
      SERVER_ACK: 2,
      DELIVERY_ACK: 3,
      READ: 4,
      PLAYED: 5,
    },
    fromObject: (value) => value,
    encode: () => Buffer.alloc(0),
    decode: () => ({}),
  },
};

export function extractMessageContent(content) {
  return content;
}

export function getContentType(content) {
  if (!content || typeof content !== 'object') return null;
  return Object.keys(content)[0] || null;
}

export default {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  downloadContentFromMessage,
  Browsers,
  DisconnectReason,
  BufferJSON,
  initAuthCreds,
  proto,
  extractMessageContent,
  getContentType,
};
