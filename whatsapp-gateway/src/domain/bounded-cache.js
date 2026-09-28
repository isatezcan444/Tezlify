/**
 * WhatsApp profile-picture URL lifetime.
 *
 * `profilePictureUrl` returns a signed `pps.whatsapp.net` link that is only
 * valid for a short window. The signature carries an expiry in the `oe=`
 * parameter as a hex-encoded unix-seconds timestamp, and `stp=` describes the
 * variant. Two consequences drive this module:
 *
 *  1. A stored URL goes stale on its own. Serving it after expiry yields 403,
 *     so "we already have an avatar_url" is NOT the same as "we have a usable
 *     avatar_url". Treating the two as equivalent is what pins a contact to a
 *     dead image until a manual refresh.
 *  2. Refreshing must stay inside the existing pacing policy, so expiry is
 *     detected here (pure) and acted on by the caller's sweep.
 *
 * A URL we cannot parse is treated as EXPIRING SOON rather than valid: an
 * unrecognised signature must not be trusted to stay good forever.
 */

/** Default refresh lead time: renew before the signature actually lapses. */
export const AVATAR_URL_EXPIRY_LEAD_MS = 6 * 60 * 60 * 1000;

/**
 * @param {string|null|undefined} url
 * @returns {number|null} expiry as unix ms, or null when not parseable.
 */
export function avatarUrlExpiryMs(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/[?&]oe=([0-9a-fA-F]+)/);
  if (!match) return null;
  const seconds = Number.parseInt(match[1], 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * True when the URL is absent, or close enough to its signature expiry that it
 * should not be trusted for a render.
 *
 * A url WITHOUT a parseable `oe=` signature returns FALSE: we have no evidence
 * it expires, and re-querying WhatsApp for every such contact on every sweep
 * would be a request storm (and would break stable CDN-style urls). Only a
 * url we can positively read an expiry from is ever treated as stale.
 *
 * @param {string|null|undefined} url
 * @param {number} [leadMs] renew this long before the real expiry.
 * @param {number} [nowMs]
 */
export function isAvatarUrlExpired(url, leadMs = AVATAR_URL_EXPIRY_LEAD_MS, nowMs = Date.now()) {
  if (!url) return true;
  const expiry = avatarUrlExpiryMs(url);
  if (expiry === null) return false;
  return expiry - Math.max(0, leadMs) <= nowMs;
}

/** Small process-local cache implementing Baileys' CacheStore contract. */
export function createBoundedCache({ maxEntries = 10_000, ttlMs = 60 * 60 * 1000 } = {}) {
  const entries = new Map();
  const max = Math.max(1, Number(maxEntries) || 10_000);
  const ttl = Math.max(1_000, Number(ttlMs) || 3_600_000);

  function prune(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size > max) entries.delete(entries.keys().next().value);
  }

  return {
    get(key) {
      const entry = entries.get(String(key));
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) entries.delete(String(key));
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(String(key));
      entries.set(String(key), { value, expiresAt: Date.now() + ttl });
      prune();
    },
    del(key) { entries.delete(String(key)); },
    flushAll() { entries.clear(); },
    close() { entries.clear(); },
    get size() { prune(); return entries.size; },
  };
}
