import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDeveloperApiKeyRepository } from "./api-key-memory-repository";
import { issueDeveloperApiKey } from "./api-key-issuance";
import { createModelAPaymentHttpHandler } from "./model-a-payment-http";
import type { ApiPrincipal, ApiScope } from "./api-principal";

const VAULT_A = "11111111111111111111111111111111";
const VAULT_B = "SysvarC1ock11111111111111111111111111111111";
const AUTHORITY = "SysvarRent111111111111111111111111111111111";
const NOW = 1_800_000_000_000;
const GENESIS = "pinned-devnet-genesis";
const request = {
  requestId: "request_1234",
  agentAuthority: AUTHORITY,
  taskId: "1",
  recipient: VAULT_B,
  amountBaseUnits: "1000",
  expiresAtUnix: String(NOW / 1000 + 600),
};

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "agentvault-intents-http-"));
  const repository = new InMemoryDeveloperApiKeyRepository();
  const owner: ApiPrincipal = {
    principalId: "owner",
    role: "owner",
    vaults: [VAULT_A, VAULT_B],
    scopes: ["treasury:read"],
  };
  const makeKey = async (
    vault: string,
    scope: ApiScope,
    principalId = "dev-1"
  ) => {
    return (
      await issueDeveloperApiKey({
        issuer: owner,
        principalId,
        vault,
        scopes: [scope],
        expiresAt: NOW + 60 * 60 * 1000,
        now: NOW,
        repository,
      })
    ).token;
  };
  let policyChecks = 0;
  let genesis = GENESIS;
  let network: "devnet" | "localnet" = "devnet";
  const server: Server = createServer((req, res) => {
    const handler = createModelAPaymentHttpHandler({
      fallbackHandler: (_req, response) => {
        response.statusCode = 404;
        response.end();
      },
      lookupDeveloperKey: (id) => repository.findById(id),
      runtimeDir: dir,
      network,
      expectedGenesisHash: GENESIS,
      getGenesisHash: async () => genesis,
      now: () => NOW,
      checkPolicy: async ({ trustedScope, input }) => {
        policyChecks++;
        if (trustedScope.vault !== VAULT_A && trustedScope.vault !== VAULT_B) {
          throw new Error("wrong vault");
        }
        if (!input || typeof input !== "object") throw new Error("bad input");
      },
    });
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const base = `http://127.0.0.1:${addr.port}`;
  const call = (
    token: string,
    method = "POST",
    body: unknown = request,
    url = "/api/model-a/payment-intents"
  ) => {
    return fetch(base + url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  };
  const close = async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    repository,
    makeKey,
    call,
    close,
    get policyChecks() {
      return policyChecks;
    },
    setGenesis: (value: string) => {
      genesis = value;
    },
    setNetwork: (value: "devnet" | "localnet") => {
      network = value;
    },
  };
}

test("explicit payment key accepts an intent, idempotent retry and authorized status read", async () => {
  const h = await harness();
  try {
    const key = await h.makeKey(VAULT_A, "payments:request");
    const r = await h.call(key);
    assert.equal(r.status, 202);
    const body = (await r.json()) as {
      status: string;
      duplicate: boolean;
      vault: string;
    };
    assert.equal(body.status, "received");
    assert.equal(body.duplicate, false);
    assert.equal(body.vault, VAULT_A);
    assert.equal((await h.call(key)).status, 200);
    const detail = await h.call(
      key,
      "GET",
      undefined,
      "/api/model-a/payment-intents/request_1234"
    );
    assert.equal(detail.status, 200);
    const stored = (await detail.json()) as {
      status: string;
      principalId: string;
    };
    assert.equal(stored.status, "received");
    assert.equal(stored.principalId, "dev-1");
    assert.equal(h.policyChecks, 2);
  } finally {
    await h.close();
  }
});

test("read-only credentials and unknown tokens cannot create or inspect intents", async () => {
  const h = await harness();
  try {
    const activity = await h.makeKey(VAULT_A, "activity:read");
    assert.equal((await h.call(activity)).status, 403);
    assert.equal(
      (
        await h.call(
          activity,
          "GET",
          undefined,
          "/api/model-a/payment-intents/request_1234"
        )
      ).status,
      403
    );
    assert.equal(
      (await h.call("owner-bearer-token-that-is-long-but-not-api-key")).status,
      401
    );
    assert.equal(h.policyChecks, 0);
  } finally {
    await h.close();
  }
});

test("same request ID cannot mutate payment terms", async () => {
  const h = await harness();
  try {
    const key = await h.makeKey(VAULT_A, "payments:request");
    assert.equal((await h.call(key)).status, 202);
    assert.equal(
      (await h.call(key, "POST", { ...request, amountBaseUnits: "2000" }))
        .status,
      409
    );
  } finally {
    await h.close();
  }
});

test("status read and intake are isolated per authenticated vault and principal", async () => {
  const h = await harness();
  try {
    const keyA = await h.makeKey(VAULT_A, "payments:request", "agent-A");
    const keyB = await h.makeKey(VAULT_B, "payments:request", "agent-B");
    const keyC = await h.makeKey(VAULT_A, "payments:request", "agent-C");
    assert.equal((await h.call(keyA)).status, 202);
    const uri = "/api/model-a/payment-intents/request_1234";
    assert.equal((await h.call(keyB, "GET", undefined, uri)).status, 404);
    assert.equal((await h.call(keyC, "GET", undefined, uri)).status, 404);
    assert.equal((await h.call(keyB)).status, 202);
  } finally {
    await h.close();
  }
});

test("Devnet mismatch denies all intake before policy and storage", async () => {
  const h = await harness();
  try {
    const key = await h.makeKey(VAULT_A, "payments:request");
    h.setNetwork("localnet");
    assert.equal((await h.call(key)).status, 503);
    h.setNetwork("devnet");
    h.setGenesis("different-genesis");
    assert.equal((await h.call(key)).status, 503);
    assert.equal(h.policyChecks, 0);
  } finally {
    await h.close();
  }
});

test("wrong methods, query parameters and invalid bodies are rejected", async () => {
  const h = await harness();
  try {
    const key = await h.makeKey(VAULT_A, "payments:request");
    assert.equal((await h.call(key, "GET", undefined)).status, 405);
    assert.equal(
      (
        await h.call(
          key,
          "POST",
          request,
          "/api/model-a/payment-intents?scope=extra"
        )
      ).status,
      400
    );
    assert.equal(
      (await h.call(key, "POST", { ...request, vault: VAULT_A })).status,
      400
    );
    assert.equal(
      (await h.call(key, "POST", { ...request, requestId: "not valid" }))
        .status,
      400
    );
  } finally {
    await h.close();
  }
});

test("payment keys must be explicitly granted and expire within one day", async () => {
  const repository = new InMemoryDeveloperApiKeyRepository();
  const owner: ApiPrincipal = {
    principalId: "owner",
    role: "owner",
    vaults: [VAULT_A],
    scopes: [],
  };
  await assert.rejects(
    issueDeveloperApiKey({
      issuer: owner,
      principalId: "dev",
      vault: VAULT_A,
      scopes: ["payments:request"],
      expiresAt: NOW + 2 * 86_400_000,
      now: NOW,
      repository,
    }),
    /expiry within 24 hours/
  );
  assert.ok(
    await issueDeveloperApiKey({
      issuer: owner,
      principalId: "dev",
      vault: VAULT_A,
      scopes: ["payments:request"],
      expiresAt: NOW + 60_000,
      now: NOW,
      repository,
    })
  );
});
