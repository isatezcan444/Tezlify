/**
 * CLI entry point that actually INSTALLS the Baileys resolve hook.
 *
 * `baileys-stub-loader.mjs` only *exports* `resolve`; it does nothing on its own.
 * It works in tests because `pairing-harness.mjs` passes it to `module.register`.
 * Running `node --import ./scripts/baileys-stub-loader.mjs src/index.js` merely
 * LOADS the module — the hook is never installed, so the gateway silently talks
 * to the REAL WhatsApp network while the run still looks like it is using a
 * fake. That trap produced a live gateway run whose "fake" never fired.
 *
 * Use this file instead:
 *
 *   node --import ./scripts/register-baileys-stub.mjs src/index.js
 *
 * Verify the double is really in play by setting FAKE_BAILEYS_TRACE=1: the fake
 * prints a `[fake-baileys] makeWASocket ...` line for every socket it builds.
 */
import { register } from 'node:module';

register('./baileys-stub-loader.mjs', import.meta.url);
