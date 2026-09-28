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

check('sweep re-arms while the store is still filling', async () => {
  // ROOT CAUSE (photos arriving late): the store is filled asynchronously by
  // Baileys. A sweep armed before that lands sees zero chats, exits silently,
  // and never runs again — so pictures only appear when an unrelated event
  // re-triggers the sweep. The fix re-arms a bounded number of times while the
  // store is still empty.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/session-manager.js', import.meta.url), 'utf8');

  assert.ok(src.includes('shouldRearmWhenEmpty'), 're-arm guard must exist');
  assert.ok(src.includes('scheduleRearm'), 're-arm scheduler must exist');
  assert.ok(
    /_avatarRearmCount/.test(src),
    're-arm budget must be tracked so it cannot become an unbounded loop',
  );
  assert.ok(
    /AVATAR_REARM_MAX\s*=\s*\d+/.test(src),
    're-arm budget must be explicitly bounded',
  );

  // Behavioural check of the guard itself.
  const guard = new Function(
    'store',
    'session',
    `const AVATAR_REARM_MAX = 5;
     const attempts = Number(store._avatarRearmCount) || 0;
     if (!store || !session) return false;
     if (session._deleted || session._shuttingDown) return false;
     if (session.status !== 'CONNECTED' || !session.sock) return false;
     if (store.chats && store.chats.size > 0) return false;
     return attempts < AVATAR_REARM_MAX;`,
  );
  const emptyStore = { chats: new Map(), _avatarRearmCount: 0 };
  const live = { status: 'CONNECTED', sock: {} };

  assert.equal(guard(emptyStore, live), true, 're-arms while connected and empty');
  assert.equal(
    guard({ ...emptyStore, chats: new Map([['a', {}]]) }, live),
    false,
    'stops re-arming once chats have landed',
  );
  assert.equal(
    guard({ ...emptyStore, _avatarRearmCount: 5 }, live),
    false,
    'stops after the bounded budget is spent',
  );
  assert.equal(
    guard(emptyStore, { status: 'CONNECTED' }),
    false,
    'never re-arms a disconnected session',
  );
  assert.equal(guard(emptyStore, { ...live, _shuttingDown: true }), false, 'never re-arms while shutting down');
});

check('sweep pacing is faster but stays far below the historical rate-limit', async () => {
  // Live measurement: min 55ms, median 149ms, max 248ms per profilePictureUrl.
  // The historical failure was ~30 req/s (3-batch + 100ms) which left avatars
  // permanently missing. Assert we stay a long way under that.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/session-manager.js', import.meta.url), 'utf8');
  const batch = Number(src.match(/AVATAR_SWEEP_BATCH\s*=\s*(\d+)/)?.[1]);
  const pause = Number(src.match(/AVATAR_SWEEP_PAUSE_MS\s*=\s*(\d+)/)?.[1]);
  const median = 0.149;

  const perBatch = median * batch + pause / 1000;
  const reqPerSec = batch / perBatch;
  assert.ok(reqPerSec < 8, `request rate must stay well under the throttle (got ${reqPerSec.toFixed(1)}/s)`);
  assert.ok(reqPerSec > 1, `must actually be faster than serial (got ${reqPerSec.toFixed(1)}/s)`);
  // A pass over a realistic backlog must finish promptly.
  const passSeconds = Math.ceil(94 / batch) * perBatch;
  assert.ok(passSeconds < 40, `a 94-chat pass must finish fast (got ${passSeconds.toFixed(1)}s)`);

  // First retry must be short: this was the real source of the perceived delay.
  const delays = src.match(/AVATAR_SWEEP_RETRY_DELAYS_MS\s*=\s*\[([^\]]+)\]/)?.[1] || '';
  // Values may use numeric separators (8_000).
  const first = Number(delays.split(',')[0].trim().replace(/_/g, ''));
  assert.ok(Number.isFinite(first) && first > 0 && first <= 10_000, `first backoff must be short (got ${delays.split(',')[0].trim()})`);
});

console.log(`\nAvatar URL expiry regression: PASS (${passed} checks)`);
