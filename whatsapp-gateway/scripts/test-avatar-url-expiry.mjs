/**
 * REGRESSION — profile-picture URL expiry.
 *
 * WhatsApp returns a SIGNED `pps.whatsapp.net` url whose `oe=` parameter is a
 * hex unix-seconds expiry. The avatar sweep used to decide "we still need this
 * avatar" with `!c.avatar_url`, so a url that had EXPIRED counted as present:
 * it was never re-queried and the UI kept rendering a dead image (HTTP 403)
 * until someone hit manual refresh. That is the "some avatars show, some stay
 * as placeholders" symptom.
 *
 * Run: node scripts/test-avatar-url-expiry.mjs
 */
import assert from 'node:assert/strict';
import { avatarUrlExpiryMs, isAvatarUrlExpired, AVATAR_URL_EXPIRY_LEAD_MS } from '../src/domain/bounded-cache.js';

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

/** Build a url that expires `inSeconds` from `nowSeconds`. */
const signedUrl = (expiryHex, variant = 'dst-jpg_s96x96_tt6') =>
  `https://pps.whatsapp.net/v/t61.24694-24/1306331266_n.jpg?stp=${variant}` +
  `&ccb=11-4&oh=01_Q5Aa&oe=${expiryHex}&_nc_sid=5e03e0&_nc_cat=106`;

const nowSec = 1_800_000_000;
const nowMs = nowSec * 1000;
const hex = (sec) => sec.toString(16).toUpperCase();

check('parses the oe= expiry as unix seconds', () => {
  assert.equal(avatarUrlExpiryMs(signedUrl(hex(nowSec + 3600))), (nowSec + 3600) * 1000);
});

check('missing url has no expiry', () => {
  assert.equal(avatarUrlExpiryMs(null), null);
  assert.equal(avatarUrlExpiryMs(undefined), null);
  assert.equal(avatarUrlExpiryMs(''), null);
});

check('url without a signature is unparseable', () => {
  assert.equal(avatarUrlExpiryMs('https://example.com/a.jpg'), null);
});

check('a freshly signed url is NOT expired', () => {
  // 8 days of validity: well past the 6h lead time.
  const url = signedUrl(hex(nowSec + 8 * 86400));
  assert.equal(isAvatarUrlExpired(url, AVATAR_URL_EXPIRY_LEAD_MS, nowMs), false);
});

check('an already-expired url IS expired (the production symptom)', () => {
  const url = signedUrl(hex(nowSec - 6 * 86400)); // 6 days ago, as observed live
  assert.equal(isAvatarUrlExpired(url, AVATAR_URL_EXPIRY_LEAD_MS, nowMs), true);
});

check('a url inside the lead window is treated as expired so it renews early', () => {
  // 1 hour left, but the lead time is 6h -> must refresh rather than render.
  const url = signedUrl(hex(nowSec + 3600));
  assert.equal(isAvatarUrlExpired(url, AVATAR_URL_EXPIRY_LEAD_MS, nowMs), true);
  // Same url with no lead time is still usable.
  assert.equal(isAvatarUrlExpired(url, 0, nowMs), false);
});

check('an unsigned url is left alone (no evidence it expires)', () => {
  // A url we cannot read an expiry from must NOT trigger a re-query on every
  // sweep: that is a request storm, and stable CDN-style urls are legitimate.
  assert.equal(isAvatarUrlExpired('https://example.com/a.jpg', AVATAR_URL_EXPIRY_LEAD_MS, nowMs), false);
  assert.equal(avatarUrlExpiryMs('https://example.com/a.jpg'), null);
});

check('empty/absent url is always "needs refresh"', () => {
  assert.equal(isAvatarUrlExpired(null, AVATAR_URL_EXPIRY_LEAD_MS, nowMs), true);
  assert.equal(isAvatarUrlExpired('', AVATAR_URL_EXPIRY_LEAD_MS, nowMs), true);
});

check('a 7-day-old url from the live DB is detected as expired', () => {
  // Real value sampled from production `contacts.custom_attributes`.
  const live =
    'https://pps.whatsapp.net/v/t61.24694-24/774510474_1337183971513483_5373539442491661765_n.jpg' +
    '?stp=dst-jpg_s96x96_tt6&ccb=11-4&oh=01_Q5Aa5gGA-G0y1KtwHrYSXpu6OeTCTILMb4yXZN3MtbdjpHnGSA' +
    '&oe=6AB2D129&_nc_sid=5e03e0&_nc_cat=106';
  const expiry = avatarUrlExpiryMs(live);
  assert.equal(expiry, 0x6AB2D129 * 1000);
  // oe=6AB2D129 == 2026-09-22T19:04:09Z, already in the past for this test run.
  assert.ok(expiry < Date.now(), 'sample url should be in the past');
  assert.equal(isAvatarUrlExpired(live, 0, Date.now()), true);
});

check('the sweep predicate treats expired and missing identically', () => {
  // Mirrors `isMissingAvatar` in session-manager.js, pinned to `nowMs` so the
  // lead-time boundary is deterministic instead of drifting with wall clock.
  const isMissingAvatar = (c) => Boolean(c && c.jid && isAvatarUrlExpired(c.avatar_url, AVATAR_URL_EXPIRY_LEAD_MS, nowMs));
  assert.equal(isMissingAvatar({ jid: 'a@s.whatsapp.net' }), true);
  assert.equal(isMissingAvatar({ jid: 'a@s.whatsapp.net', avatar_url: '' }), true);
  // THE REGRESSION: a stored-but-expired url must count as missing so the
  // sweep re-queries it. Before the fix `!c.avatar_url` said false here and the
  // dead image stayed on screen.
  assert.equal(isMissingAvatar({ jid: 'a@s.whatsapp.net', avatar_url: signedUrl(hex(nowSec - 1000)) }), true);
  assert.equal(isMissingAvatar({ jid: 'a@s.whatsapp.net', avatar_url: signedUrl(hex(nowSec + 86400)) }), false);
});

check('session-manager sweep actually uses the expiry-aware predicate', async () => {
  // Guard the WIRING, not just the helper: a fix that defines the predicate but
  // leaves the sweep on the old `!c.avatar_url` would still ship the bug.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/session-manager.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => l.includes('const isMissingAvatar'));
  assert.ok(idx >= 0, 'isMissingAvatar must exist');
  // The predicate spans two lines; read the declaration through its terminator.
  const decl = lines.slice(idx, idx + 3).join('\n');
  assert.ok(
    decl.includes('isAvatarUrlExpired'),
    'sweep predicate must consult isAvatarUrlExpired, not just !c.avatar_url',
  );
  // No call site may still gate purely on truthiness (comments excluded).
  const stale = lines.filter(
    (l) => !l.trim().startsWith('//') && /!c\.avatar_url|!chats\.get\(key\)\?\.avatar_url/.test(l),
  );
  assert.equal(stale.length, 0, `stale truthiness checks remain:\n${stale.join('\n')}`);
});

console.log(`\nAvatar URL expiry regression: PASS (${passed} checks)`);
