export const API_READ_CACHE_TIMEOUT_MS = 15_000;

type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

type CacheOptions = {
  timeoutMs?: number;
};

export function createApiReadCache(options: CacheOptions = {}) {
  const timeoutMs = options.timeoutMs ?? API_READ_CACHE_TIMEOUT_MS;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid cache loader timeout");
  }

  const readCache = new Map<string, CacheEntry>();
  const pendingReads = new Map<string, Promise<unknown>>();

  async function cachedRead<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs = 30_000
  ): Promise<T> {
    const cached = readCache.get(key);

    if (cached && Date.now() < cached.expiresAt) {
      return cached.value as T;
    }

    const pending = pendingReads.get(key);

    if (pending) {
      return pending as Promise<T>;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const job = Promise.race<T>([
      Promise.resolve().then(loader),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Cache loader timed out"));
        }, timeoutMs);
      }),
    ]);

    pendingReads.set(key, job);

    try {
      const value = await job;

      if (pendingReads.get(key) === job) {
        readCache.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
        });
      }

      return value;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      if (pendingReads.get(key) === job) {
        pendingReads.delete(key);
      }
    }
  }

  return { cachedRead };
}
