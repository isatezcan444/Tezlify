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
 *   3. The mirror image of (1): once the gate correctly stops opening on the
 *      gateway's signal, the BACKEND's own completion must be what opens it.
 *      The backend job now waits for the gateway's history sync before pulling,
 *      so `session_sync_completed` arrives EARLIER than the backend finishing —
 *      and the gate then had no later signal to re-ask it, leaving the full
 *      screen up after everything had finished.
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

// 4. Defect 3: the BACKEND's own sync job is what opens the gate, so its
//    terminal events must re-ask it. Sliced by branch header so the completion
//    and failure branches cannot mask each other (a plain window after the
//    first header would happily match the second branch's refresh).
const branch = (startMarker, endMarker) => {
  const start = page.indexOf(startMarker);
  const end = page.indexOf(endMarker);
  assert.ok(start !== -1, `branch start not found: ${startMarker}`);
  assert.ok(end > start, `branch end not found after start: ${endMarker}`);
  return page.slice(start, end);
};

assert.match(
  branch(
    "eventData.event === 'whatsapp_sync_complete'",
    "eventData.event === 'whatsapp_sync_failed'",
  ),
  /void refreshLoadingGate\(\)/,
  "the backend's own sync completion must re-ask the loading gate",
);
assert.match(
  branch(
    "eventData.event === 'whatsapp_sync_failed'",
    'Gateway completion is not persistence completion',
  ),
  /void refreshLoadingGate\(\)/,
  'a failed backend sync must re-ask the loading gate so it reports the error',
);

// 5. Initial sync pending must directly keep the gate active until chats/messages are fetched
assert.match(
  page,
  /initialSyncPending\s*\|\|/,
  'initialSyncPending must directly keep syncGateActive open',
);
assert.doesNotMatch(
  page,
  /session_sync_progress[\s\S]{0,300}setSessionSync\(\s*\{[^}]*phase:\s*'ready'/,
  "session_sync_progress must not set sessionSync to 'ready'",
);

console.log('[verify-whatsapp-loading-gate] ok - backend is the single gate authority');
