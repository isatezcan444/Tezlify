/**
 * Cross-project guard: the client's abort budget for a message page must EXCEED
 * the server's own worst case.
 *
 * PRODUCTION SYMPTOM (2026-10-02, conv 18192 "Emre Bulut")
 *   Clicking "load older" on a chat whose provider never answers produced
 *   "Mesajlar yüklenemedi" (rose banner) plus a still-offered "load older"
 *   control, and the console showed
 *   `AbortError: signal is aborted without reason`.
 *
 * WHY IT HAPPENS
 *   Three budgets live in three different projects and silently diverged:
 *     * client abort          : MESSAGE_LOAD_TIMEOUT_MS        = 20_000 ms
 *     * gateway provider wait : timeoutMs default              = 25_000 ms
 *     * backend gateway HTTP  : WHATSAPP_GATEWAY_TIMEOUT       = 30_000 ms
 *   The client gave up ~5 s BEFORE the gateway's own provider window even
 *   expired, so the backend's answer — a 502, or a tolerated empty page — could
 *   never reach the UI. Every provider timeout became a client-side abort, and
 *   an abort renders as a hard failure.
 *
 * THE CONTRACT
 *   client abort budget > gateway provider wait
 *   client abort budget > backend gateway HTTP ceiling
 *
 *   A budget smaller than either one turns a slow-but-answerable request into a
 *   guaranteed UI error. Raising the budget costs nothing in the normal case
 *   (local reads are sub-second); it only matters in the pathological one, which
 *   is exactly where the old value lied.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

// ---- the three real values, read from the files that own them ----------------

const hubSrc = read('frontend/src/pages/WhatsAppHubPage.tsx');
const hubMatch = hubSrc.match(/MESSAGE_LOAD_TIMEOUT_MS\s*=\s*([\d_]+)/);
assert.ok(
  hubMatch,
  'MESSAGE_LOAD_TIMEOUT_MS must be a literal in WhatsAppHubPage.tsx so this guard can read it',
);
const clientAbortMs = Number(hubMatch[1].replace(/_/g, ''));

// The gateway declares its provider budget as a default parameter, so collect
// every occurrence and take the largest — that is the real worst case.
const gatewaySrc = read('whatsapp-gateway/src/session-manager.js');
const gatewayWaits = [...gatewaySrc.matchAll(/timeoutMs\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
assert.ok(
  gatewayWaits.length > 0,
  'no `timeoutMs = <n>` default found in session-manager.js — the provider budget moved',
);
const gatewayProviderMs = Math.max(...gatewayWaits);

const gatewayClientSrc = read('backend/app/services/whatsapp_gateway.py');
const backendMatch = gatewayClientSrc.match(/WHATSAPP_GATEWAY_TIMEOUT"\s*,\s*([\d.]+)/);
assert.ok(
  backendMatch,
  'the WHATSAPP_GATEWAY_TIMEOUT default must be a literal in whatsapp_gateway.py',
);
const backendHttpMs = Math.round(Number(backendMatch[1]) * 1000);

// ---- the contract -----------------------------------------------------------

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

console.log('message-page timeout budget');
console.log(
  `  client abort ${clientAbortMs} ms | gateway provider ${gatewayProviderMs} ms | ` +
    `backend HTTP ceiling ${backendHttpMs} ms`,
);

check('the client outwaits the gateway provider window', () => {
  assert.ok(
    clientAbortMs > gatewayProviderMs,
    `client abort budget ${clientAbortMs} ms must exceed the gateway provider window of ` +
      `${gatewayProviderMs} ms, or the backend answer can never reach the UI`,
  );
});

check('the client outwaits the backend gateway HTTP ceiling', () => {
  assert.ok(
    clientAbortMs > backendHttpMs,
    `client abort budget ${clientAbortMs} ms must exceed the backend gateway HTTP ceiling of ` +
      `${backendHttpMs} ms — the backend cannot answer faster than that`,
  );
});

check('the two server budgets are read from live files, not hardcoded here', () => {
  // Guards against this script becoming a mirror of itself: if someone renames
  // the constants the reads above throw, so a green run proves the sources were
  // actually parsed.
  assert.ok(gatewayWaits.length >= 1 && backendHttpMs > 0);
});

console.log(`\n${passed} checks passed`);
