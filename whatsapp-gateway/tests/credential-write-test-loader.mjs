/**
 * ESM resolve hook for the phase 6.3 credential-write harness.
 *
 * `pg` resolves to a REAL driver when TZ63_PG_MODULE_URL points at one (the
 * isolated local PostgreSQL run), otherwise to the inert stub so the file
 * storage tests still load. All other third-party modules are local stubs.
 */
const STUBS = new Map([
  ['@whiskeysockets/baileys', new URL('./stubs/baileys-credential.mjs', import.meta.url).href],
  ['@whiskeysockets/baileys/lib/Utils/crypto.js', new URL('./stubs/baileys-crypto.mjs', import.meta.url).href],
  ['whatsapp-rust-bridge', new URL('./stubs/whatsapp-rust-bridge.mjs', import.meta.url).href],
  ['uuid', new URL('./stubs/uuid.mjs', import.meta.url).href],
  ['pino', new URL('./stubs/pino.mjs', import.meta.url).href],
  ['qrcode', new URL('./stubs/qrcode.mjs', import.meta.url).href],
  ['ws', new URL('./stubs/ws.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pg') {
    const real = process.env.TZ63_PG_MODULE_URL;
    const url = real || new URL('./stubs/pg.mjs', import.meta.url).href;
    return { url, shortCircuit: true };
  }
  const url = STUBS.get(specifier);
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
