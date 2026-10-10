/**
 * Phase 23 — WhatsApp Gateway Health & Reconnect Recovery Regression Tests
 *
 * Verifies:
 * 1. probeLive coalesces concurrent in-flight calls into a single network request.
 * 2. probeLive transient 503 recovery (recovers on bounded retry without surfacing 503).
 * 3. probeLive fails closed on permanent 503 (Truthfulness invariant).
 * 4. Silent reconciliation on reconnect preserves avatars and existing message state.
 * 5. Invalidation resets cache so fresh probes can run on reconnect.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { importTsModule } from './lib/import-ts.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;

const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  } catch {
    /* already set */
  }
};

setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('localStorage', window.localStorage);
setGlobal('sessionStorage', window.sessionStorage);
setGlobal('CustomEvent', window.CustomEvent);
setGlobal('Event', window.Event);

console.log('[test-gateway-health-recovery] Loading whatsappApi via importTsModule...');
const apiMod = await importTsModule('../src/features/whatsapp/api/whatsappApi', import.meta.url);
const { probeLive, invalidateLiveProbe, isLiveCached } = apiMod;

let fetchCallCount = 0;
let fetchMockHandler = null;

globalThis.fetch = async (url, options) => {
  fetchCallCount++;
  if (fetchMockHandler) {
    return fetchMockHandler(url, options);
  }
  return new Response(JSON.stringify({ gateway_available: true }), { status: 200 });
};

async function check(desc, fn) {
  try {
    await fn();
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    console.error(`  ✗ ${desc}:`, err.message);
    throw err;
  }
}

console.log('[test-gateway-health-recovery] Starting Phase 23 regression test suite...');

// Scenario 1: probeLive coalesces 5 concurrent in-flight calls into 1 network call
await check('Scenario 1: Concurrent probeLive calls coalesce into a single fetch request', async () => {
  invalidateLiveProbe();
  fetchCallCount = 0;
  fetchMockHandler = async () => {
    await new Promise((r) => setTimeout(r, 40));
    return new Response(JSON.stringify({ gateway_available: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const results = await Promise.all([
    probeLive(),
    probeLive(),
    probeLive(),
    probeLive(),
    probeLive(),
  ]);

  assert.equal(fetchCallCount, 1, `Expected 1 network call, got ${fetchCallCount}`);
  assert.deepEqual(results, [true, true, true, true, true]);
});

// Scenario 2: probeLive recovers from transient 503 on retry
await check('Scenario 2: Transient 503 recovers seamlessly on bounded retry', async () => {
  invalidateLiveProbe();
  fetchCallCount = 0;
  let attempts = 0;
  fetchMockHandler = async () => {
    attempts++;
    if (attempts === 1) {
      return new Response(JSON.stringify({ gateway_available: false, error: 'Temporary resolution blip' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ gateway_available: true, status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await probeLive();
  assert.equal(result, true, 'probeLive should recover and return true after transient 503');
  assert.equal(fetchCallCount, 2, `Expected 2 fetch calls for retry, got ${fetchCallCount}`);
});

// Scenario 3: probeLive fails closed on permanent 503 (no false positive)
await check('Scenario 3: Permanent 503 fails closed and reports false (Truthfulness)', async () => {
  invalidateLiveProbe();
  fetchCallCount = 0;
  fetchMockHandler = async () => {
    return new Response(JSON.stringify({ gateway_available: false, error: 'Gateway down' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await probeLive();
  assert.equal(result, false, 'probeLive should fail closed and return false');
  assert.equal(fetchCallCount, 2, 'Should attempt max 2 times before declaring down');
  assert.equal(isLiveCached(), false, 'Cached status should be false');
});

// Scenario 4: invalidateLiveProbe clears cache for reconnect
await check('Scenario 4: Invalidation resets probe cache immediately', async () => {
  assert.equal(isLiveCached(), false);
  invalidateLiveProbe();
  assert.equal(isLiveCached(), null, 'isLiveCached should be null after invalidation');
});

// Scenario 5: Conversation and message merger integrity during reconnect reconciliation
await check('Scenario 5: Conversation avatar and message merging preserve state during reconnect', async () => {
  const convMod = await importTsModule('../src/features/whatsapp/lib/whatsappConversationPatch', import.meta.url);
  const { mergeConversationPreservingAvatar } = convMod;

  const existingConv = {
    id: 101,
    lead_name: 'Alpha B2B',
    lead_avatar_url: 'https://images.unsplash.com/photo-existing-avatar',
    updated_at: '2026-10-10T12:00:00Z',
  };

  // Reconnect payload with missing/null avatar
  const reconnectIncoming = {
    id: 101,
    lead_name: 'Alpha B2B',
    lead_avatar_url: null,
    updated_at: '2026-10-10T12:05:00Z',
  };

  const merged = mergeConversationPreservingAvatar(existingConv, reconnectIncoming);
  assert.equal(
    merged.lead_avatar_url,
    'https://images.unsplash.com/photo-existing-avatar',
    'Existing avatar URL must be preserved during reconnect reconciliation'
  );

  const mergeMod = await importTsModule('../src/features/whatsapp/lib/whatsappMessageMerge', import.meta.url);
  const { mergeWhatsAppMessages } = mergeMod;

  const existingMsgs = [
    { id: 1, body: 'Hello', created_at: '2026-10-10T12:00:00Z', status: 'READ' },
    { id: 2, body: 'World', created_at: '2026-10-10T12:01:00Z', status: 'READ' },
  ];
  const reconnectMsgs = [
    { id: 2, body: 'World', created_at: '2026-10-10T12:01:00Z', status: 'READ' },
    { id: 3, body: 'Reconnected message', created_at: '2026-10-10T12:02:00Z', status: 'READ' },
  ];

  const mergedMsgs = mergeWhatsAppMessages(existingMsgs, reconnectMsgs);
  assert.equal(mergedMsgs.length, 3, 'Messages should be deduplicated and merged');
  assert.equal(mergedMsgs[0].id, 1);
  assert.equal(mergedMsgs[2].id, 3);
});

console.log('\nAll 5 Phase 23 frontend regression tests PASSED!');
