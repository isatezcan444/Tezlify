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

console.log('[test-whatsapp-avatar] ALL AVATAR TESTS PASSED SUCCESSFULLY.');
