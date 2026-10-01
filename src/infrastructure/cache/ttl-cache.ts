interface CacheEntry<T> {
  value?: T;
  hasValue: boolean;
  freshUntil: number;
  staleUntil: number;
  pending?: Promise<T> | undefined;
}

export interface TtlCacheOptions {
  /** Time a loaded value is served without reloading. `<= 0` disables the cache. */
  ttlMs: number;
  /**
   * Extra time after `ttlMs` during which the previous value is still served
   * immediately while a single background reload refreshes it.
   */
  staleMs?: number;
  /** Maximum number of keys kept (oldest inserted evicted first). */
  maxEntries?: number;
  /** Called when a background reload fails; the previous value is kept. */
  onBackgroundError?: (error: unknown, key: string) => void;
  now?: () => number;
}

/**
 * Small in-process cache for expensive, tenant-independent aggregates
 * (catalog stats, source counts, archive facets/counts).
 *
 * - Concurrent misses for the same key share one loader call, so a
 *   dashboard burst runs each aggregate query once instead of N times.
 * - After `ttlMs`, the previous value keeps being served for `staleMs`
 *   while one background reload runs, so readers do not wait on it.
 * - Failed loads are not cached.
 *
 * Never cache tenant-scoped or user-scoped data here.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;
  private readonly onBackgroundError:
    | ((error: unknown, key: string) => void)
    | undefined;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.staleMs = options.staleMs ?? 0;
    this.maxEntries = options.maxEntries ?? 100;
    this.onBackgroundError = options.onBackgroundError;
    this.now = options.now ?? Date.now;
  }

  async get(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) {
      return loader();
    }

    const now = this.now();
    const current = this.entries.get(key);

    if (current?.hasValue && current.freshUntil > now) {
      return current.value as T;
    }

    if (current?.hasValue && current.staleUntil > now) {
      if (!current.pending) {
        this.load(key, loader, current).catch((error: unknown) => {
          this.onBackgroundError?.(error, key);
        });
      }
      return current.value as T;
    }

    if (current?.pending) {
      return current.pending;
    }

    return this.load(key, loader, undefined);
  }

  clear(): void {
    this.entries.clear();
  }

  private load(
    key: string,
    loader: () => Promise<T>,
    previous: CacheEntry<T> | undefined,
  ): Promise<T> {
    const entry: CacheEntry<T> = previous ?? {
      hasValue: false,
      freshUntil: 0,
      staleUntil: 0,
    };

    const pending = loader().then(
      (value) => {
        const loadedAt = this.now();
        if (this.entries.get(key) === entry) {
          entry.value = value;
          entry.hasValue = true;
          entry.freshUntil = loadedAt + this.ttlMs;
          entry.staleUntil = loadedAt + this.ttlMs + this.staleMs;
          entry.pending = undefined;
        }
        return value;
      },
      (error: unknown) => {
        if (this.entries.get(key) === entry) {
          entry.pending = undefined;
          if (!entry.hasValue) {
            this.entries.delete(key);
          }
        }
        throw error;
      },
    );

    entry.pending = pending;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evictOverflow();

    return pending;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
