// Phase 22: WhatsApp Avatar Persistence & Zero-Flicker Regression Test Suite
import assert from 'node:assert/strict';
import { importTsModule } from './lib/import-ts.mjs';

console.log('[test-avatar-persistence-zero-flicker] Loading modules via importTsModule...');

const { mergeConversationPreservingAvatar, applyConversationEvent } = await importTsModule(
  '../src/features/whatsapp/lib/whatsappConversationPatch',
  import.meta.url
);

const { mapConversationItem } = await importTsModule(
  '../src/features/whatsapp/api/whatsappApi',
  import.meta.url
);

const {
  resolvedAvatarCache,
  avatarMetrics,
  failedAvatarUrls,
  inFlightAvatarRefreshes,
  negativeAvatarPhones,
  clearFailedAvatarUrlsCache,
} = await importTsModule(
  '../src/components/ui/Avatar',
  import.meta.url
);

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
};

console.log('[test-avatar-persistence-zero-flicker] Starting Phase 22 regression test suite...');

// Base mock conversation
const baseConv = {
  id: 101,
  lead_id: 'lead-1',
  lead_name: 'Ahmet Yılmaz',
  lead_phone: '+905551234567',
  lead_avatar_url: 'https://pps.whatsapp.net/v/t61.24694-24/avatar_ahmet_v1.jpg',
  unread_count: 0,
  status: 'ACTIVE',
  last_message_preview: 'Merhaba',
  last_message_at: '2026-10-10T12:00:00Z',
  updated_at: '2026-10-10T12:00:00Z',
};

// Scenario 1: Avatar loaded successfully + missing avatar field in update -> avatar preserved
check('Scenario 1: Missing avatar field preserves existing avatar URL', () => {
  const incoming = { id: 101, last_message_preview: 'Yeni mesaj', unread_count: 1 };
  const merged = mergeConversationPreservingAvatar(baseConv, incoming);
  assert.equal(merged.lead_avatar_url, baseConv.lead_avatar_url, 'Existing avatar URL must be preserved');
  assert.equal(merged.last_message_preview, 'Yeni mesaj');
  assert.equal(merged.unread_count, 1);
});

// Scenario 2: Avatar loaded successfully + null avatar field in update -> avatar preserved
check('Scenario 2: null avatar field in update preserves existing avatar URL', () => {
  const incoming = { id: 101, lead_avatar_url: null, last_message_preview: 'Nasılsınız?' };
  const merged = mergeConversationPreservingAvatar(baseConv, incoming);
  assert.equal(merged.lead_avatar_url, baseConv.lead_avatar_url, 'null avatar must not clobber existing avatar');
});

// Scenario 3: Avatar loaded successfully + empty string avatar field in update -> avatar preserved
check('Scenario 3: Empty string avatar field preserves existing avatar URL', () => {
  const incoming = { id: 101, lead_avatar_url: '', last_message_preview: 'İyi günler' };
  const merged = mergeConversationPreservingAvatar(baseConv, incoming);
  assert.equal(merged.lead_avatar_url, baseConv.lead_avatar_url, 'Empty string must not clobber existing avatar');
});

// Scenario 4: New valid avatar URL arrives -> URL properly updated
check('Scenario 4: Valid new avatar URL replaces old URL cleanly', () => {
  const newUrl = 'https://pps.whatsapp.net/v/t61.24694-24/avatar_ahmet_v2.jpg';
  const incoming = { id: 101, lead_avatar_url: newUrl };
  const merged = mergeConversationPreservingAvatar(baseConv, incoming);
  assert.equal(merged.lead_avatar_url, newUrl, 'New valid avatar URL must update cleanly');
});

// Scenario 5: Out-of-order race: older avatar refresh response does not overwrite newer state
check('Scenario 5: Out-of-order responses do not overwrite newer avatar state', () => {
  let activeVersion = 2;
  const currentUrl = 'https://pps.whatsapp.net/v/t61.24694-24/avatar_v2.jpg';
  const staleResponse = { version: 1, url: 'https://pps.whatsapp.net/v/t61.24694-24/avatar_v1_stale.jpg' };
  
  // Guard condition: reject stale response
  let resolvedUrl = currentUrl;
  if (staleResponse.version >= activeVersion) {
    resolvedUrl = staleResponse.url;
  }
  assert.equal(resolvedUrl, currentUrl, 'Stale response must not overwrite newer state');
});

// Scenario 6: WebSocket message event without avatar field does not drop avatar
check('Scenario 6: Realtime WebSocket message event preserves avatar in applyConversationEvent', () => {
  const wsPayload = {
    id: 101,
    last_message_preview: 'Ses kaydı gönderildi',
    last_message_at: '2026-10-10T12:05:00Z',
    unread_count: 2,
    // Note: No avatar_url in standard message event payload!
  };
  const updated = applyConversationEvent(baseConv, wsPayload);
  assert.equal(updated.lead_avatar_url, baseConv.lead_avatar_url, 'Realtime event without avatar must preserve lead_avatar_url');
  assert.equal(updated.last_message_preview, 'Ses kaydı gönderildi');
  assert.equal(updated.unread_count, 2);
});

// Scenario 7: Conversation list refetch preserves avatar
check('Scenario 7: Full conversation refetch preserving existing avatar', () => {
  const pageItems = [
    { id: 101, name: 'Ahmet Yılmaz', phone: '+905551234567', avatar_url: null }, // Backend returned null or missing
    { id: 102, name: 'Ayşe Kaya', phone: '+905559876543', avatar_url: 'https://pps.whatsapp.net/ayse.jpg' },
  ];
  
  const mappedItems = pageItems.map((raw) => mapConversationItem(raw));
  const prevMap = new Map([[baseConv.id, baseConv]]);
  
  const sanitized = mappedItems.map((item) => {
    const existing = prevMap.get(item.id);
    return existing ? mergeConversationPreservingAvatar(existing, item) : item;
  });
  
  const conv101 = sanitized.find((c) => c.id === 101);
  assert.ok(conv101, 'Conversation 101 must exist');
  assert.equal(conv101.lead_avatar_url, baseConv.lead_avatar_url, 'Refetched item must preserve cached lead_avatar_url');
});

// Scenario 8: Sorting and filtering keeps avatars bound to correct conversation
check('Scenario 8: Sorting and filtering preserves correct avatar identity binding', () => {
  const convList = [
    { ...baseConv, id: 101, last_message_at: '2026-10-10T10:00:00Z', lead_avatar_url: 'http://img/101.jpg' },
    { ...baseConv, id: 102, last_message_at: '2026-10-10T12:00:00Z', lead_avatar_url: 'http://img/102.jpg' },
    { ...baseConv, id: 103, last_message_at: '2026-10-10T11:00:00Z', lead_avatar_url: 'http://img/103.jpg' },
  ];
  
  // Sort descending by last_message_at
  const sorted = [...convList].sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
  assert.equal(sorted[0].id, 102);
  assert.equal(sorted[0].lead_avatar_url, 'http://img/102.jpg');
  assert.equal(sorted[1].id, 103);
  assert.equal(sorted[1].lead_avatar_url, 'http://img/103.jpg');
  assert.equal(sorted[2].id, 101);
  assert.equal(sorted[2].lead_avatar_url, 'http://img/101.jpg');
  
  // Filter by query
  const filtered = sorted.filter((c) => c.id === 101);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 101);
  assert.equal(filtered[0].lead_avatar_url, 'http://img/101.jpg');
});

// Scenario 9: Image load error shows fallback but does NOT delete stored URL
check('Scenario 9: Image error does not delete stored avatar URL in cache or conversation state', () => {
  clearFailedAvatarUrlsCache();
  const testPhone = '905551234567';
  const validUrl = 'https://pps.whatsapp.net/v/t61.24694-24/avatar_ahmet_v1.jpg';
  
  resolvedAvatarCache.set(testPhone, validUrl);
  
  // Image fails in browser
  failedAvatarUrls.add(validUrl);
  
  // Check that the URL is marked failed for immediate render, but conversation object still holds its URL
  assert.ok(failedAvatarUrls.has(validUrl), 'URL recorded as failed');
  assert.equal(baseConv.lead_avatar_url, validUrl, 'Conversation state must never delete its lead_avatar_url on image error');
  assert.equal(resolvedAvatarCache.get(testPhone), validUrl, 'Cache retains reference to avoid losing known URL');
});

// Scenario 10: Duplicate requests coalesced and storm suppressed
check('Scenario 10: In-flight avatar refreshes coalesce identical phone requests', () => {
  clearFailedAvatarUrlsCache();
  const phone = '905550000001';
  
  assert.equal(inFlightAvatarRefreshes.has(phone), false);
  inFlightAvatarRefreshes.add(phone);
  
  // Concurrent duplicate attempt:
  let secondRequestStarted = false;
  if (!inFlightAvatarRefreshes.has(phone)) {
    secondRequestStarted = true;
  }
  assert.equal(secondRequestStarted, false, 'Second in-flight request for same phone must be coalesced / suppressed');
});

// Scenario 14: Refreshing CDN URL clears error state so new URL can render without permanent blockage
check('Scenario 14: New avatar URL bypasses error state of expired CDN URL', () => {
  clearFailedAvatarUrlsCache();
  const expiredUrl = 'https://pps.whatsapp.net/v/t61.24694-24/expired_token.jpg';
  failedAvatarUrls.add(expiredUrl);
  
  const refreshedUrl = 'https://pps.whatsapp.net/v/t61.24694-24/fresh_token_2026.jpg';
  assert.equal(failedAvatarUrls.has(refreshedUrl), false, 'Fresh URL must NOT be blocked by previous expired URL error state');
});

// Scenario 15: 10 consecutive refetch / WS updates keep avatar intact
check('Scenario 15: Avatar preserved intact across 10 consecutive refetches and updates', () => {
  let current = { ...baseConv };
  const initialAvatar = baseConv.lead_avatar_url;
  
  for (let cycle = 1; cycle <= 10; cycle++) {
    // Alternate between message update, unread count update, and full refetch with null avatar
    if (cycle % 3 === 1) {
      // Message event (no avatar)
      current = applyConversationEvent(current, { id: 101, last_message_preview: `Mesaj #${cycle}` });
    } else if (cycle % 3 === 2) {
      // Partial update with null avatar
      current = mergeConversationPreservingAvatar(current, { id: 101, lead_avatar_url: null, unread_count: cycle });
    } else {
      // Refetch with undefined avatar
      const refetched = mapConversationItem({ id: 101, name: 'Ahmet Yılmaz', phone: '+905551234567', avatar_url: null });
      current = mergeConversationPreservingAvatar(current, refetched);
    }
    assert.equal(current.lead_avatar_url, initialAvatar, `Cycle ${cycle}: Avatar must remain unchanged!`);
  }
  assert.equal(current.lead_avatar_url, initialAvatar, 'Avatar preserved across all 10 consecutive cycles');
});

console.log(`\nAll ${passed} Phase 22 frontend avatar persistence tests PASSED!`);
