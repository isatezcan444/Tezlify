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
