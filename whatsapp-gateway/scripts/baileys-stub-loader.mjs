/**
 * Resolve hook: redirect `makeWASocket` to a controllable fake, ONLY for
 * session-manager.js.
 *
 * Phase 6.4 §21: use the REAL installed Baileys wherever possible and mock only
 * at the network boundary. `makeWASocket` is exactly that boundary — it opens a
 * real WebSocket to WhatsApp's servers. Everything else (qrcode encoding,
 * auth-state files, DisconnectReason, Browsers, ...) stays real.
 *
 * The redirect is scoped to `session-manager.js` so that the stub file itself
 * can still `export * from '@whiskeysockets/baileys'` without recursing.
 */
const STUB = new URL('./fake-baileys.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === '@whiskeysockets/baileys' &&
    context.parentURL &&
    (context.parentURL.includes('session-manager.js') || context.parentURL.includes('socket-connector.js'))
  ) {
    return { url: STUB, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
