import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection } from "@solana/web3.js";

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
