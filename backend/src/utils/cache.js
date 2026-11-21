/**
 * Simple in-process TTL cache backed by a Map.
 *
 * Suitable for single-instance MVP deployments. Not suitable for
 * multi-instance deployments where cache coherency across processes
 * is required — use Redis or a shared cache layer in that scenario.
 *
 * The cache is bounded by `maxEntries` and evicts the least-recently-used
 * entry when at capacity. Map iteration order is insertion order, so
 * re-inserting a key on access marks it as most-recently-used.
 */
class TtlCache {
  constructor(maxEntries = 1000) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this._maxEntries = maxEntries;
    this._store = new Map();
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    // Mark as most-recently-used by re-inserting at the end.
    this._store.delete(key);
    this._store.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new RangeError('ttlMs must be a finite, non-negative number');
    }
    // If the key already exists, remove it first so re-insertion updates
    // its position in the LRU order.
    if (this._store.has(key)) {
      this._store.delete(key);
    }
    // Evict least-recently-used entries until there is room.
    while (this._store.size >= this._maxEntries) {
      const oldestKey = this._store.keys().next().value;
      this._store.delete(oldestKey);
    }
    this._store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key) {
    this._store.delete(key);
  }

  /**
   * Remove all entries whose key starts with the given prefix.
   */
  invalidatePrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }
}

module.exports = new TtlCache();
module.exports.TtlCache = TtlCache;