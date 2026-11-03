/**
 * ESM resolve hook used only by the media-store test harness.
 * Redirects third-party specifiers to local stubs so the harness can run
 * without a populated node_modules tree.
 */
const STUBS = new Map([
  ['@whiskeysockets/baileys', new URL('./stubs/baileys.mjs', import.meta.url).href],
  ['uuid', new URL('./stubs/uuid.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const url = STUBS.get(specifier);
  if (url) {
    return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
