import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection } from "@solana/web3.js";
import { createRpcConcurrencyGate } from "./api-rpc-concurrency";

import { createBoundedRpcFetch } from "./api-rpc-security";

const RPC_URL = "http://127.0.0.1:8899";

function createTestConnection(fetchImpl: typeof fetch): Connection {
  return new Connection(RPC_URL, {
    commitment: "confirmed",
    fetch: createBoundedRpcFetch(fetchImpl, 100),
    disableRetryOnRateLimit: true,
  });
}

test("Connection parses a successful JSON-RPC response", async () => {
  let requestMethod: string | undefined;

  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    requestMethod = request.method;

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: "test-genesis-hash",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const connection = createTestConnection(fetchImpl);

  const genesisHash = await connection.getGenesisHash();

  assert.equal(genesisHash, "test-genesis-hash");
  assert.equal(requestMethod, "getGenesisHash");
});

test("Connection does not retry HTTP 429 responses", async () => {
  let attempts = 0;

  const fetchImpl: typeof fetch = async () => {
    attempts += 1;

    return new Response("rate limited", {
      status: 429,
      statusText: "Too Many Requests",
    });
  };

  const connection = createTestConnection(fetchImpl);

  await assert.rejects(connection.getGenesisHash());

  assert.equal(attempts, 1);
});

test("Connection rejects JSON-RPC errors", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: "Upstream RPC failure",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const connection = createTestConnection(fetchImpl);

  await assert.rejects(connection.getGenesisHash(), /Upstream RPC failure/);
});

test("Connection rejects a stalled RPC response", async () => {
  let aborted = false;

  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("RPC request aborted"));
        },
        { once: true }
      );
    });

  const connection = createTestConnection(fetchImpl);

  await assert.rejects(connection.getGenesisHash(), /aborted/);

  assert.equal(aborted, true);
});

test("Connection shares a concurrency limit across simultaneous RPC calls", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 2,
    maxQueued: 4,
    queueTimeoutMs: 1000,
  });

  let active = 0;
  let peak = 0;

  const fetchImpl: typeof fetch = async (_input, init) => {
    active += 1;
    peak = Math.max(peak, active);

    try {
      const request = JSON.parse(String(init?.body));

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: "test-genesis-hash",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    } finally {
      active -= 1;
    }
  };

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 1000);

  const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    fetch: (input, init) =>
      gate.run(() => boundedFetch(input, init), init?.signal),
    disableRetryOnRateLimit: true,
  });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => connection.getGenesisHash())
  );

  assert.deepEqual(results, Array(6).fill("test-genesis-hash"));
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test("holds the RPC slot until a stalled response body times out", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 1,
    maxQueued: 1,
    queueTimeoutMs: 1000,
  });

  let networkStarts = 0;
  let bodyCancelled = false;

  const fetchImpl: typeof fetch = async (_input, init) => {
    networkStarts += 1;

    const request = JSON.parse(String(init?.body));

    if (networkStarts === 1) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                })
              )
            );
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: "recovered",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const boundedFetch = createBoundedRpcFetch(fetchImpl, 50);

  const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    fetch: (input, init) =>
      gate.run(() => boundedFetch(input, init), init?.signal),
    disableRetryOnRateLimit: true,
  });

  const first = connection.getGenesisHash();

  await new Promise<void>((resolve) => setImmediate(resolve));

  const second = connection.getGenesisHash();

  // The first response body is still stalled.
  // The second request must remain queued.
  assert.equal(networkStarts, 1);

  await assert.rejects(first);

  // Once the first request times out, the gate releases its slot.
  // The second request is now allowed to reach the network.
  assert.equal(await second, "recovered");

  assert.equal(networkStarts, 2);
  assert.equal(bodyCancelled, true);
});

test("does not send cancelled queued RPC requests to the network", async () => {
  const gate = createRpcConcurrencyGate({
    maxActive: 1,
    maxQueued: 1,
    queueTimeoutMs: 1000,
  });

  const controller = new AbortController();

  let networkStarts = 0;
  let releaseFirst!: () => void;

  const boundedFetch = createBoundedRpcFetch(async (_input, init) => {
    networkStarts += 1;

    const request = JSON.parse(String(init?.body));

    if (networkStarts === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: "success",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }, 1000);

  const securedFetch: typeof fetch = (input, init) =>
    gate.run(() => boundedFetch(input, init), init?.signal);

  const first = securedFetch(RPC_URL, {
    method: "POST",
    body: "{}",
  });

  await Promise.resolve();

  const cancelled = securedFetch(RPC_URL, {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });

  controller.abort(new Error("Caller cancelled"));

  await assert.rejects(cancelled, /Caller cancelled/);

  assert.equal(networkStarts, 1);

  releaseFirst();
  await first;

  assert.equal(networkStarts, 1);
});
