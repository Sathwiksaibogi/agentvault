import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentVaultClient,
  AgentVaultHttpError,
  AgentVaultProtocolError,
  AgentVaultTransportError,
} from "../dist/index.js";

const treasury = {
  network: "devnet",
  vault: "VaultPda",
  owner: "OwnerPubkey",
  tokenMint: "MintPubkey",
  treasury: "TreasuryPda",
  vaultId: "2",
  decimals: 6,
  paused: false,
  balanceBaseUnits: "900719925474099312345",
  reservedBaseUnits: "100",
  availableBaseUnits: "900719925474099312245",
};

const agent = {
  id: "agent-1",
  name: "Agent 1",
  workflow: "vendor_payment",
  authority: "AuthorityPubkey",
  agentPda: "AgentPda",
  active: true,
  task: {
    taskId: 1,
    taskPda: "TaskPda",
    active: true,
    recipient: "RecipientPubkey",
    budgetBaseUnits: "1000",
    spentBaseUnits: "100",
    remainingBaseUnits: "900",
    nextNonce: "3",
    expiresAtUnix: "1799999999",
  },
};

function clientWith(fetchImpl) {
  return new AgentVaultClient({
    baseUrl: "http://127.0.0.1:3000",
    token: "secret-test-token",
    fetchImpl,
  });
}

test("GET treasury sends Bearer auth and preserves large decimal amounts", async () => {
  const calls = [];
  const client = clientWith(async (url, init) => {
    calls.push({ url, init });
    return Response.json(treasury);
  });
  const result = await client.getTreasury();
  assert.equal(result.balanceBaseUnits, treasury.balanceBaseUnits);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3000/api/treasury");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-test-token");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.cache, "no-store");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("GET agents unwraps the existing { agents } envelope", async () => {
  const client = clientWith(async (url) => {
    assert.equal(url, "http://127.0.0.1:3000/api/agents");
    return Response.json({ agents: [agent] });
  });
  assert.deepEqual(await client.listAgents(), [agent]);
});

test("401/403 remain authorization errors without exposing credentials", async () => {
  for (const status of [401, 403]) {
    const client = clientWith(async () => Response.json({ error: "blocked" }, { status }));
    await assert.rejects(client.getTreasury(), (error) => {
      assert.ok(error instanceof AgentVaultHttpError);
      assert.equal(error.status, status);
      assert.equal(error.path, "/api/treasury");
      assert.ok(!error.message.includes("secret-test-token"));
      return true;
    });
  }
});

test("malformed JSON and malformed shapes fail closed", async () => {
  const invalidJson = clientWith(async () => new Response("not-json"));
  await assert.rejects(invalidJson.getTreasury(), AgentVaultProtocolError);

  const wrongAmountType = clientWith(async () =>
    Response.json({ ...treasury, balanceBaseUnits: 123 }),
  );
  await assert.rejects(wrongAmountType.getTreasury(), AgentVaultProtocolError);

  const wrongEnvelope = clientWith(async () => Response.json({ agents: {} }));
  await assert.rejects(wrongEnvelope.listAgents(), AgentVaultProtocolError);

  const wrongAgent = clientWith(async () =>
    Response.json({ agents: [{ ...agent, task: { ...agent.task, nextNonce: 3 } }] }),
  );
  await assert.rejects(wrongAgent.listAgents(), AgentVaultProtocolError);
});

test("transport errors do not include sensitive token or underlying URL", async () => {
  const client = clientWith(async () => {
    throw new Error("secret-test-token: request failed");
  });
  await assert.rejects(client.getTreasury(), (error) => {
    assert.ok(error instanceof AgentVaultTransportError);
    assert.ok(!error.message.includes("secret-test-token"));
    return true;
  });
});

test("rejects insecure remote origins and malformed credentials", () => {
  const base = { baseUrl: "http://127.0.0.1:3000", token: "abc" };
  assert.throws(
    () => new AgentVaultClient({ ...base, baseUrl: "http://example.com" }),
    TypeError,
  );
  assert.throws(
    () => new AgentVaultClient({ ...base, baseUrl: "https://user:pass@example.com" }),
    TypeError,
  );
  assert.throws(
    () => new AgentVaultClient({ ...base, baseUrl: "https://example.com/api" }),
    TypeError,
  );
  assert.throws(() => new AgentVaultClient({ ...base, token: "abc\r\nBad: true" }), TypeError);
  assert.throws(() => new AgentVaultClient({ ...base, timeoutMs: 0 }), RangeError);
  assert.doesNotThrow(() => new AgentVaultClient({ ...base, baseUrl: "https://api.example.com" }));
});
