/**
 * Per-isolate, byte-bounded LRU for parsed immutable deployment metadata.
 *
 * Callers key entries by immutable storage objects only (a deployment's
 * manifest key plus the object it read). Never cache authorization, session,
 * share, membership or publication resolution here: those decisions are made
 * freshly by Convex on every request, before any cached bytes are consulted.
 *
 * Concurrent misses for one key share a single load. Failed loads and loads
 * that ask not to be retained are removed, so they are retried by the next
 * request. Weights approximate the source JSON size of the parsed value.
 */
type Entry = { pending: Promise<unknown>; weight: number };

export type CacheLoad<T> = { value: T; weight: number | null };

/** Small entries still carry Map/object overhead. */
const MIN_ENTRY_WEIGHT = 256;

export class ImmutableMetadataCache {
  private readonly entries = new Map<string, Entry>();
  private total = 0;

  constructor(readonly maxWeight: number, readonly maxEntryWeight: number) {}

  get weight(): number { return this.total; }
  get size(): number { return this.entries.size; }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  get<T>(key: string, load: () => Promise<CacheLoad<T>>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.pending as Promise<T>;
    }
    const entry = { weight: 0 } as Entry;
    this.entries.set(key, entry);
    const pending = (async () => {
      try {
        const { value, weight } = await load();
        // Identity guards: a clear() during the load must not resurrect it.
        if (this.entries.get(key) === entry) {
          const charged = weight === null ? null : Math.max(MIN_ENTRY_WEIGHT, weight);
          if (charged === null || charged > this.maxEntryWeight) this.entries.delete(key);
          else {
            entry.weight = charged;
            this.total += charged;
            this.evict(key);
          }
        }
        return value;
      } catch (error) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }
    })();
    entry.pending = pending;
    return pending;
  }

  private evict(keep: string): void {
    for (const [key, entry] of this.entries) {
      if (this.total <= this.maxWeight) return;
      if (key === keep) continue;
      this.entries.delete(key);
      this.total -= entry.weight;
    }
  }
}

/** Shared by every route in this isolate; see docs/TECHNICAL.md. */
export const deploymentMetadataCache = new ImmutableMetadataCache(4 * 1024 * 1024, 2 * 1024 * 1024);
