import { describe, it, expect } from 'vitest';
import { LruCache } from './cache';

describe('LruCache', () => {
  it('rejects a non-positive max', () => {
    expect(() => new LruCache(0)).toThrow();
    expect(() => new LruCache(-1)).toThrow();
  });

  it('stores and retrieves values', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('counts a get as a use, protecting the touched key from eviction', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' is now most-recent; 'b' is oldest
    cache.set('c', 3); // evicts 'b', not 'a'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('updating an existing key refreshes recency without growing size', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11); // refresh 'a'
    cache.set('c', 3); // evicts 'b'
    expect(cache.get('a')).toBe(11);
    expect(cache.has('b')).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('clear empties the cache', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });
});
