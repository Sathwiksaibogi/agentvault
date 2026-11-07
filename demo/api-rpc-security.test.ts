import assert from "node:assert/strict";
import { test } from "node:test";

import { createBoundedRpcFetch } from "./api-rpc-security";

test("RPC transport preserves successful responses", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('{"result":"ok"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 100);

  const response = await boundedFetch("https://rpc.example.test");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: "ok" });
});

test("RPC transport aborts a stalled fetch", async () => {
  let aborted = false;

  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;

      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 30);

  await assert.rejects(boundedFetch("https://rpc.example.test"), /aborted/);

  assert.equal(aborted, true);
});

test("RPC transport preserves caller cancellation", async () => {
  const controller = new AbortController();
  let aborted = false;

  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("caller aborted"));
        },
        { once: true }
      );
    });

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 1000);

  const request = boundedFetch("https://rpc.example.test", {
    signal: controller.signal,
  });

  controller.abort();

  await assert.rejects(request, /caller aborted/);
  assert.equal(aborted, true);
});

test("RPC transport aborts a stalled response body", async () => {
  let aborted = false;

  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            controller.error(new Error("body aborted"));
          },
          { once: true }
        );
      },
    });

    return new Response(body, { status: 200 });
  };

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 30);

  await assert.rejects(
    boundedFetch("https://rpc.example.test"),
    /body aborted/
  );

  assert.equal(aborted, true);
});

test("RPC transport rejects oversized response bodies", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
      status: 200,
    });

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 1000);

  await assert.rejects(
    boundedFetch("https://rpc.example.test"),
    /RPC response exceeds maximum size/
  );
});

test("RPC transport rejects already-aborted requests", async () => {
  const controller = new AbortController();
  controller.abort();

  let fetchCalled = false;

  const fetchImpl: typeof fetch = async () => {
    fetchCalled = true;
    return new Response("unexpected");
  };

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 1000);

  await assert.rejects(
    boundedFetch("https://rpc.example.test", {
      signal: controller.signal,
    })
  );

  assert.equal(fetchCalled, false);
});

test("RPC transport cancels an oversized response stream", async () => {
  let streamCancelled = false;

  const fetchImpl: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        streamCancelled = true;
      },
    });

    return new Response(body, { status: 200 });
  };

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 1000);

  await assert.rejects(
    boundedFetch("https://rpc.example.test"),
    /RPC response exceeds maximum size/
  );

  assert.equal(streamCancelled, true);
});

test("RPC transport does not wait indefinitely for stream cancellation", async () => {
  let cancellationAttempted = false;

  const fetchImpl: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },

      cancel() {
        cancellationAttempted = true;

        // Simulate a non-cooperative stream.
        return new Promise<void>(() => {});
      },
    });

    return new Response(body, { status: 200 });
  };

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 100);

  const outcome = await Promise.race([
    boundedFetch("https://rpc.example.test").then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 300)),
  ]);

  assert.equal(outcome, "rejected");
  assert.equal(cancellationAttempted, true);
});

test("RPC transport cancels a response rejected by Content-Length", async () => {
  let cancelled = false;

  const fetchImpl: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "content-length": String(2 * 1024 * 1024 + 1),
      },
    });
  };

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 100);

  await assert.rejects(
    boundedFetch("https://rpc.example.test"),
    /RPC response exceeds maximum size/
  );

  assert.equal(cancelled, true);
});
