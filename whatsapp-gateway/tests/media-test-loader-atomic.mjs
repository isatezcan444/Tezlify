/**
 * ESM resolve hook for the 5.4.5 atomicity harness. Maps third-party
 * specifiers to local stubs; the Baileys stub exposes a configurable
 * download implementation instead of always throwing.
 */
const STUBS = new Map([
  ['@whiskeysockets/baileys', new URL('./stubs/baileys-atomic.mjs', import.meta.url).href],
  ['uuid', new URL('./stubs/uuid.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const url = STUBS.get(specifier);
  if (url) {
    return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
