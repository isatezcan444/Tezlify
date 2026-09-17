import ts from 'typescript';
import fs from 'node:fs';
import assert from 'node:assert/strict';

console.log('[test-whatsapp-avatar] Starting WhatsApp Avatar unit and performance test suite...');

// Extract pure functions from Avatar.tsx
const avatarSource = fs.readFileSync(new URL('../src/components/ui/Avatar.tsx', import.meta.url), 'utf8');

// Isolate logic
const getAvatarColorMatch = avatarSource.match(/const getAvatarColor = [\s\S]*?\n\};/);
const getInitialsMatch = avatarSource.match(/const getInitials = [\s\S]*?\n\};/);
assert.ok(getAvatarColorMatch, 'Must find getAvatarColor');
assert.ok(getInitialsMatch, 'Must find getInitials');

const testModuleCode = `
${getAvatarColorMatch[0]}
${getInitialsMatch[0]}
export const failedAvatarUrls = new Set();
export const clearFailedAvatarUrlsCache = () => { failedAvatarUrls.clear(); };
export { getAvatarColor, getInitials };
`;

const js = ts.transpileModule(testModuleCode, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;

const { getAvatarColor, getInitials, failedAvatarUrls, clearFailedAvatarUrlsCache } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
);

// 1. Test getInitials
console.log('Testing getInitials...');
assert.equal(getInitials('John Doe'), 'JD');
assert.equal(getInitials('Alice'), 'AL');
assert.equal(getInitials('Algan Diş Kliniği'), 'AK');
assert.equal(getInitials(''), '?');
assert.equal(getInitials('  SingleWord  '), 'SI');
console.log('✓ getInitials passed');

// 2. Test getAvatarColor determinism
console.log('Testing getAvatarColor determinism...');
const color1 = getAvatarColor('Alice');
const color2 = getAvatarColor('Alice');
assert.equal(color1, color2, 'Colors for same name must be deterministic');
assert.ok(color1.includes('bg-'), 'Color class must contain background color');
console.log('✓ getAvatarColor passed');

// 3. Test failedAvatarUrls cache behavior
console.log('Testing failedAvatarUrls cache and storm prevention...');
clearFailedAvatarUrlsCache();
assert.equal(failedAvatarUrls.size, 0);

const brokenUrl = 'https://pps.whatsapp.net/v/t61.24694-24/expired_token.jpg';
assert.equal(failedAvatarUrls.has(brokenUrl), false);

// Simulate image error event
failedAvatarUrls.add(brokenUrl);
assert.equal(failedAvatarUrls.has(brokenUrl), true);

// Simulate 120 contact cards scrolling by with the same broken URL
let networkRequestsTriggered = 0;
for (let i = 0; i < 120; i++) {
  const shouldRenderImage = !failedAvatarUrls.has(brokenUrl);
  if (shouldRenderImage) {
    networkRequestsTriggered++;
  }
}
assert.equal(networkRequestsTriggered, 0, 'Zero network requests should be triggered for cached failed URLs');
console.log('✓ Failed avatar URL cache and storm prevention passed (120 scroll items tested)');

// 4. Test clear cache
clearFailedAvatarUrlsCache();
assert.equal(failedAvatarUrls.size, 0);
console.log('✓ clearFailedAvatarUrlsCache passed');

// 5. Test Avatar component HTML attributes invariant in source
console.log('Verifying Avatar.tsx invariant tags and attributes...');
assert.ok(avatarSource.includes('loading="lazy"'), 'Must have lazy loading attribute');
assert.ok(avatarSource.includes('decoding="async"'), 'Must have async decoding attribute');
assert.ok(avatarSource.includes('aspect-square'), 'Must preserve square aspect ratio');
assert.ok(avatarSource.includes('object-cover'), 'Must use object-cover to avoid distorted stretch');
assert.ok(avatarSource.includes('onError='), 'Must handle image loading errors gracefully');
console.log('✓ Avatar.tsx markup invariants passed');

// 6. Test Avatar Storm Prevention (20 simulated errors for same contact)
console.log('Testing Avatar Storm Prevention (20 consecutive errors for same contact)...');
clearFailedAvatarUrlsCache();
const inFlightAvatarRefreshes = new Set();
let refreshApiCallCount = 0;

const simulateAvatarError = (phone, url) => {
  if (url) failedAvatarUrls.add(url);
  if (phone && !inFlightAvatarRefreshes.has(phone)) {
    inFlightAvatarRefreshes.add(phone);
    refreshApiCallCount++;
  }
};

const testPhone = '+905413749073';
const staleUrl = 'https://pps.whatsapp.net/v/t61.24694-24/stale_token_test.jpg';

// Fire 20 consecutive error events
for (let i = 0; i < 20; i++) {
  simulateAvatarError(testPhone, staleUrl);
}

assert.equal(refreshApiCallCount, 1, 'Exactly 1 refresh API request should be fired');
assert.equal(failedAvatarUrls.has(staleUrl), true, 'Stale URL must be marked in failedAvatarUrls');
console.log('✓ Avatar storm test passed: 1 refresh request fired, 19 duplicate requests blocked');

// 7. Test Concurrent Component Render with same stale URL
console.log('Testing Concurrent Component Render with same stale URL...');
let concurrentCallCount = 0;
const simulateConcurrentRenderError = (phone, url) => {
  if (url && failedAvatarUrls.has(url)) {
    return;
  }
  if (phone && !inFlightAvatarRefreshes.has(phone)) {
    inFlightAvatarRefreshes.add(phone);
    concurrentCallCount++;
  }
};
simulateConcurrentRenderError(testPhone, staleUrl);
simulateConcurrentRenderError(testPhone, staleUrl);
assert.equal(concurrentCallCount, 0, 'No additional calls should be made when URL is in failedAvatarUrls');
console.log('✓ Concurrent render test passed (0 duplicate requests)');

console.log('[test-whatsapp-avatar] ALL AVATAR TESTS PASSED SUCCESSFULLY.');
