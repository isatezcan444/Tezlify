/**
 * Loading-gate authority guards.
 *
 * WhatsApp-Web parity is "first messages loading -> complete -> open the chat".
 * Two production defects broke that contract:
 *
 *   1. The gateway finishing its own history pass (`session_sync_completed`)
 *      closed the gate while the BACKEND's first sync — chats snapshot,
 *      contacts, messages, empty-chat backfill — was still running. The
 *      backend's durable stamp (`whatsapp_sessions.initial_sync_completed_at`,
 *      exposed as `initial_sync_completed`) is the only completion truth.
 *   2. A refresh after QR pairing could show a gate that never finished: the
 *      avatar count and the in-memory gateway phase were consulted, and both
 *      can be regenerated forever with nothing left to complete.
 *
 * These guards fail if either shortcut comes back. They read the shipped
 * sources, the same style as the hydration guards in
 * verify-whatsapp-merge-equivalence.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

// 1. The hook must re-ask the backend when the gateway says ready.
const hook = read('src/features/whatsapp/hooks/useWhatsAppLoadingGate.ts');
assert.match(
  hook,
  /derived\.phase === 'ready'[\s\S]{0,900}void refresh\(\)/,
  "gateway 'ready' must re-ask the backend instead of closing the gate",
);
assert.doesNotMatch(
  hook,
  /derived\.phase === 'ready'\s*\)?\s*applyGate\(/,
  "the gateway's own history completion must never set the gate to ready directly",
);

// 2. The page must not self-promote the sync banner to ready on gateway completion.
const page = read('src/pages/WhatsAppHubPage.tsx');
assert.doesNotMatch(
  page,
  /session_sync_completed[\s\S]{0,400}setSessionSync\(\s*\{[^}]*phase:\s*'ready'/,
  "session_sync_completed must not self-promote sessionSync to 'ready'",
);
assert.match(
  page,
  /session_sync_completed[\s\S]{0,1200}refreshLoadingGate\(\)/,
  'session_sync_completed must re-ask the backend loading gate',
);

// 3. Only a genuinely running first sync holds the full-screen gate.
assert.match(
  page,
  /const loadingGateActive =\s*\n?\s*loadingGate\?\.phase === 'syncing_history'/,
  "avatars/profiles must never hold the gate; only 'syncing_history' does",
);

console.log('[verify-whatsapp-loading-gate] ok - backend is the single gate authority');
