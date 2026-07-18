/**
 * A bounded least-recently-used cache. The compile cache uses it to return PDF
 * bytes for previously compiled LaTeX without re-invoking pdflatex — on the
 * preview-then-approve path, undo/redo, and re-approval. Bounded so it cannot
 * grow without limit; process-local (empty after a restart).
 *
 * Insertion order in a Map is the recency order: get() re-inserts to mark a key
 * most-recent, and set() evicts the oldest (first) key when over capacity.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max <= 0) {
      throw new Error('LruCache max must be a positive integer');
    }
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined || !this.map.has(key)) return value;
    // Mark most-recently-used by re-inserting at the end.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
