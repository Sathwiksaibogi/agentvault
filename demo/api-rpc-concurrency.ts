export type RpcConcurrencyOptions = {
  maxActive: number;
  maxQueued: number;
  queueTimeoutMs: number;
};

type QueuedOperation = {
  start: () => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
};

export function createRpcConcurrencyGate(options: RpcConcurrencyOptions) {
  const { maxActive, maxQueued, queueTimeoutMs } = options;

  if (
    !Number.isSafeInteger(maxActive) ||
    maxActive <= 0 ||
    !Number.isSafeInteger(maxQueued) ||
    maxQueued < 0 ||
    !Number.isSafeInteger(queueTimeoutMs) ||
    queueTimeoutMs <= 0
  ) {
    throw new Error("Invalid RPC concurrency configuration");
  }

  let active = 0;
  let closed = false;
  let closeReason: unknown = new Error("RPC concurrency gate is closed");

  const queue: QueuedOperation[] = [];

  function drain(): void {
    if (closed) return;

    while (active < maxActive && queue.length > 0) {
      const next = queue.shift()!;
      next.cleanup();
      next.start();
    }
  }

  function run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (closed) {
      return Promise.reject(closeReason);
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("RPC request aborted"));
    }

    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;

        Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            drain();
          });
      };

      if (active < maxActive && queue.length === 0) {
        start();
        return;
      }

      if (queue.length >= maxQueued) {
        reject(new Error("RPC concurrency queue is full"));
        return;
      }

      let timer: ReturnType<typeof setTimeout>;

      const entry: QueuedOperation = {
        start,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };

      const removeFromQueue = () => {
        const index = queue.indexOf(entry);

        if (index !== -1) {
          queue.splice(index, 1);
          entry.cleanup();
        }
      };

      const onAbort = () => {
        removeFromQueue();
        reject(signal?.reason ?? new Error("RPC request aborted"));
      };

      timer = setTimeout(() => {
        removeFromQueue();
        reject(new Error("RPC concurrency queue timed out"));
      }, queueTimeoutMs);

      queue.push(entry);

      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  function close(
    reason: unknown = new Error("RPC concurrency gate is closed")
  ): void {
    if (closed) return;

    closed = true;
    closeReason = reason;

    while (queue.length > 0) {
      const entry = queue.shift()!;
      entry.cleanup();
      entry.reject(closeReason);
    }
  }

  return { run, close };
}
