const TtlCache = require('./cache');

describe('TtlCache', () => {
  describe('constructor', () => {
    test('defaults maxEntries to a positive number', () => {
      const cache = new TtlCache();
      expect(cache.maxEntries).toBeGreaterThan(0);
    });

    test('accepts a custom maxEntries', () => {
      const cache = new TtlCache({ maxEntries: 5 });
      expect(cache.maxEntries).toBe(5);
    });

    test('rejects invalid maxEntries', () => {
      expect(() => new TtlCache({ maxEntries: 0 })).toThrow();
      expect(() => new TtlCache({ maxEntries: -1 })).toThrow();
      expect(() => new TtlCache({ maxEntries: NaN })).toThrow();
      expect(() => new TtlCache({ maxEntries: Infinity })).toThrow();
    });
  });

  describe('set() TTL validation', () => {
    test('rejects negative TTLs', () => {
      const cache = new TtlCache();
      expect(() => cache.set('key', 'value', -1)).toThrow();
    });

    test('rejects NaN TTLs', () => {
      const cache = new TtlCache();
      expect(() => cache.set('key', 'value', NaN)).toThrow();
    });

    test('rejects Infinity TTLs', () => {
      const cache = new TtlCache();
      expect(() => cache.set('key', 'value', Infinity)).toThrow();
    });

    test('rejects non-numeric TTLs', () => {
      const cache = new TtlCache();
      expect(() => cache.set('key', 'value', '1000')).toThrow();
      expect(() => cache.set('key', 'value', undefined)).toThrow();
    });

    test('accepts valid positive TTLs', () => {
      const cache = new TtlCache();
      expect(() => cache.set('key', 'value', 1000)).not.toThrow();
      expect(cache.get('key')).toBe('value');
    });

    test('does not store the entry when TTL is invalid', () => {
      const cache = new TtlCache();
      expect(() => cache.set('key', 'value', -1)).toThrow();
      expect(cache.get('key')).toBeUndefined();
      expect(cache.size).toBe(0);
    });
  });

  describe('get()', () => {
    test('returns stored value before expiry', () => {
      const cache = new TtlCache();
      cache.set('key', 'value', 10000);
      expect(cache.get('key')).toBe('value');
    });

    test('returns undefined for missing keys', () => {
      const cache = new TtlCache();
      expect(cache.get('missing')).toBeUndefined();
    });

    test('removes and returns undefined for expired entries', () => {
      jest.useFakeTimers();
      try {
        const cache = new TtlCache();
        cache.set('key', 'value', 1000);
        expect(cache.get('key')).toBe('value');

        jest.advanceTimersByTime(1001);

        expect(cache.get('key')).toBeUndefined();
        expect(cache.size).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('LRU eviction', () => {
    test('evicts the least recently used entry when exceeding maxEntries', () => {
      const cache = new TtlCache({ maxEntries: 3 });
      cache.set('a', 1, 10000);
      cache.set('b', 2, 10000);
      cache.set('c', 3, 10000);

      cache.set('d', 4, 10000);

      expect(cache.size).toBe(3);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    test('get() refreshes recency so the accessed entry is not evicted', () => {
      const cache = new TtlCache({ maxEntries: 3 });
      cache.set('a', 1, 10000);
      cache.set('b', 2, 10000);
      cache.set('c', 3, 10000);

      // Access 'a' so it becomes most recently used.
      expect(cache.get('a')).toBe(1);

      cache.set('d', 4, 10000);

      expect(cache.size).toBe(3);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    test('set() on an existing key refreshes recency', () => {
      const cache = new TtlCache({ maxEntries: 3 });
      cache.set('a', 1, 10000);
      cache.set('b', 2, 10000);
      cache.set('c', 3, 10000);

      cache.set('a', 10, 10000);

      cache.set('d', 4, 10000);

      expect(cache.size).toBe(3);
      expect(cache.get('a')).toBe(10);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    test('evicts in strict LRU order across multiple insertions', () => {
      const cache = new TtlCache({ maxEntries: 2 });
      cache.set('a', 1, 10000);
      cache.set('b', 2, 10000);

      cache.set('c', 3, 10000); // evicts 'a'
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);

      cache.set('d', 4, 10000); // evicts 'b'
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    test('never exceeds maxEntries', () => {
      const cache = new TtlCache({ maxEntries: 5 });
      for (let i = 0; i < 100; i += 1) {
        cache.set(`key-${i}`, i, 10000);
        expect(cache.size).toBeLessThanOrEqual(5);
      }
      expect(cache.size).toBe(5);
    });
  });

  describe('invalidate()', () => {
    test('removes a specific entry', () => {
      const cache = new TtlCache();
      cache.set('key', 'value', 10000);
      cache.invalidate('key');
      expect(cache.get('key')).toBeUndefined();
      expect(cache.size).toBe(0);
    });
  });

  describe('clear()', () => {
    test('removes all entries', () => {
      const cache = new TtlCache();
      cache.set('a', 1, 10000);
      cache.set('b', 2, 10000);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });
  });
});