/**
 * ESM resolve hook for the phase 6.1 pending-LID durability harness.
 * Maps every third-party specifier reachable from `session-manager.js` to a
 * local stub so the real ingestion/release code can run without node_modules.
 */
const STUBS = new Map([
  ['@whiskeysockets/baileys', new URL('./stubs/baileys-lid.mjs', import.meta.url).href],
  ['@whiskeysockets/baileys/lib/Utils/crypto.js', new URL('./stubs/baileys-crypto.mjs', import.meta.url).href],
  ['whatsapp-rust-bridge', new URL('./stubs/whatsapp-rust-bridge.mjs', import.meta.url).href],
  ['uuid', new URL('./stubs/uuid.mjs', import.meta.url).href],
  ['pino', new URL('./stubs/pino.mjs', import.meta.url).href],
  ['pg', new URL('./stubs/pg.mjs', import.meta.url).href],
  ['qrcode', new URL('./stubs/qrcode.mjs', import.meta.url).href],
  ['ws', new URL('./stubs/ws.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const url = STUBS.get(specifier);
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
