/**
 * Baileys test double for the phase 6.3 credential-write harness.
 *
 * `useMultiFileAuthState` performs REAL filesystem writes so the disk branch of
 * `saveCreds` can be verified without mocking the write itself. The socket is a
 * passive stub: no network or WhatsApp account is touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BufferJSON, proto, DisconnectReason } from './baileys-lid.mjs';

export { BufferJSON, proto, DisconnectReason };

export const extractMessageContent = (message) => message?.message ?? message ?? null;

export const getContentType = (message) => {
  const content = extractMessageContent(message);
  if (!content || typeof content !== 'object') return undefined;
  return Object.keys(content).find((key) => key !== 'messageContextInfo');
};

export const initAuthCreds = () => ({ registered: false });

export const useMultiFileAuthState = async (sessionDir) => {
  fs.mkdirSync(sessionDir, { recursive: true });
  const credsFile = path.join(sessionDir, 'creds.json');
  let creds = { registered: false };
  if (fs.existsSync(credsFile)) {
    creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'), BufferJSON.reviver);
  }
  const state = {
    creds,
    keys: {
      get: async () => ({}),
      set: async () => {},
    },
  };
  const saveCreds = async () => {
    fs.writeFileSync(credsFile, JSON.stringify(state.creds, BufferJSON.replacer));
  };
  return { state, saveCreds };
};

export const makeCacheableSignalKeyStore = (keys) => keys;

export const fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 0] });

export const makeWASocket = (config) => {
  const listeners = new Map();
  return {
    authState: config?.auth,
    ev: {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
      },
      emit() {},
      removeAllListeners() {
        listeners.clear();
      },
      listeners,
    },
    sendNode: async () => {},
    sendPresenceUpdate: async () => {},
    query: async () => ({}),
    end: () => {},
  };
};

export const Browsers = {
  macOS: () => ['Mac OS', 'Chrome', '1.0'],
  ubuntu: () => ['Ubuntu', 'Chrome', '1.0'],
  windows: () => ['Windows', 'Chrome', '1.0'],
  appropriate: () => ['Mac OS', 'Chrome', '1.0'],
};
