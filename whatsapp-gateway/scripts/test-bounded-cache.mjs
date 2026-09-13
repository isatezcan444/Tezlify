import assert from 'node:assert/strict';
import { createBoundedCache } from '../src/domain/bounded-cache.js';

const cache = createBoundedCache({ maxEntries: 2, ttlMs: 10_000 });
cache.set('a', 1);
cache.set('b', 2);
assert.equal(cache.get('a'), 1);
cache.set('c', 3);
assert.equal(cache.get('a'), undefined);
assert.equal(cache.get('c'), 3);
cache.del('c');
assert.equal(cache.get('c'), undefined);
cache.set('d', 4);
cache.flushAll();
assert.equal(cache.get('d'), undefined);
console.log('[test-bounded-cache] 6 assertions passed');
