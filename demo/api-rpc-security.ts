export const API_RPC_TIMEOUT_MS = 10_000;
export const API_RPC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function createBoundedRpcFetch(
  fetchImpl: typeof fetch,
  timeoutMs = API_RPC_TIMEOUT_MS
): typeof fetch {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid RPC timeout");
  }

  return async (input, init) => {
    const controller = new AbortController();
    const callerSignal = init?.signal;

    const abortFromCaller = () => {
      controller.abort(callerSignal?.reason);
    };

    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });
    }

    const timeout = setTimeout(() => {
      controller.abort(new Error("RPC request timed out"));
    }, timeoutMs);

    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      const fetchPromise = Promise.resolve(
        fetchImpl(input, {
          ...init,
          signal: controller.signal,
        })
      );

      let onAbort!: () => void;

      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(controller.signal.reason ?? new Error("RPC request aborted"));
        };

        controller.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        if (controller.signal.aborted) {
          onAbort();
        }
      });

      let response: Response;

      try {
        response = await Promise.race([fetchPromise, aborted]);
      } catch (error) {
        // If fetch eventually resolves after our deadline, discard its body.
        // Do not wait for cancellation: a non-cooperative stream may hang.
        void fetchPromise
          .then((lateResponse) => {
            if (lateResponse.body) {
              void lateResponse.body.cancel().catch(() => undefined);
            }
          })
          .catch(() => undefined);

        throw error;
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }

      const contentLength = response.headers.get("content-length");

      if (
        contentLength !== null &&
        /^\d+$/.test(contentLength) &&
        Number(contentLength) > API_RPC_MAX_RESPONSE_BYTES
      ) {
        if (response.body) {
          void response.body.cancel().catch(() => undefined);
        }

        throw new Error("RPC response exceeds maximum size");
      }

      const reader = response.body?.getReader();

      if (!reader) {
        return response;
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let completed = false;

      try {
        for (;;) {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("RPC request aborted");
          }

          let onAbort!: () => void;

          const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => {
              reject(
                controller.signal.reason ?? new Error("RPC request aborted")
              );
            };

            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });

            if (controller.signal.aborted) {
              onAbort();
            }
          });

          let result: ReadableStreamReadResult<Uint8Array>;

          try {
            result = await Promise.race([reader.read(), aborted]);
          } finally {
            controller.signal.removeEventListener("abort", onAbort);
          }

          const { done, value } = result;

          if (done) {
            completed = true;
            break;
          }

          totalBytes += value.byteLength;

          if (totalBytes > API_RPC_MAX_RESPONSE_BYTES) {
            throw new Error("RPC response exceeds maximum size");
          }

          chunks.push(value);
        }
      } finally {
        if (!completed) {
          void reader.cancel().catch(() => undefined);
        }

        reader.releaseLock();
      }

      const body = new Uint8Array(totalBytes);
      let offset = 0;

      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}
