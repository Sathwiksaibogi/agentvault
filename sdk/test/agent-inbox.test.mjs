import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentVaultClient,
  AgentVaultHttpError,
  AgentVaultProtocolError,
  AgentVaultTransportError,
} from "../dist/index.js";

function clientWith(fetchImpl) {
  return new AgentVaultClient({
    baseUrl: "http://127.0.0.1:3000",
    token: "secret-test-token",
    fetchImpl,
  });
}

const VAULT = "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep";
const AGENT = "8xF8jf7n4WHVNekuEggo9Ekvt8NYEarNo1c9M6fFD7pY";
const NONCE = "dGVzdC1ub25jZS0xMjM0NTY3ODkwMTI=";
const SIG = "5MsnFq4kR7";

test("requestAgentInboxChallenge posts vault and agentAuthority", async () => {
  const client = clientWith(async (url, init) => {
    assert.equal(
      url,
      "http://127.0.0.1:3000/api/model-a/agent-inbox/challenge"
    );
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.vault, VAULT);
    assert.equal(body.agentAuthority, AGENT);
    return Response.json({
      nonce: NONCE,
      message: "AgentVault Agent Inbox v1\n...",
      expiresAtUnix: 1800000060,
    });
  });

  const res = await client.requestAgentInboxChallenge({
    vault: VAULT,
    agentAuthority: AGENT,
  });
  assert.equal(res.nonce, NONCE);
  assert.equal(res.expiresAtUnix, 1800000060);
});

test("pollAgentInbox sends challenge response and receives items", async () => {
  const client = clientWith(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:3000/api/model-a/agent-inbox/poll");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.nonce, NONCE);
    assert.equal(body.signature, SIG);
    return Response.json({
      network: "devnet",
      vault: VAULT,
      agentAuthority: AGENT,
      items: [],
      notice: "Discovery only",
    });
  });

  const res = await client.pollAgentInbox({
    nonce: NONCE,
    signature: SIG,
  });
  assert.equal(res.network, "devnet");
  assert.equal(res.vault, VAULT);
  assert.deepEqual(res.items, []);
});

test("acknowledgeAgentInboxItem sends requestId and receives delivery receipt", async () => {
  const client = clientWith(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:3000/api/model-a/agent-inbox/ack");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.nonce, NONCE);
    assert.equal(body.signature, SIG);
    assert.equal(body.requestId, "invoice_1042");
    return Response.json({
      network: "devnet",
      vault: VAULT,
      agentAuthority: AGENT,
      requestId: "invoice_1042",
      acknowledgedAtUnix: 1800000000,
      duplicate: false,
      notice: "Durable delivery receipt only",
    });
  });

  const res = await client.acknowledgeAgentInboxItem({
    nonce: NONCE,
    signature: SIG,
    requestId: "invoice_1042",
  });
  assert.equal(res.requestId, "invoice_1042");
  assert.equal(res.acknowledgedAtUnix, 1800000000);
  assert.equal(res.duplicate, false);
});

test("agent inbox methods reject invalid arguments before sending HTTP requests", async () => {
  const client = clientWith(async () => {
    throw new Error("Should not be called");
  });

  await assert.rejects(
    client.requestAgentInboxChallenge({ vault: "", agentAuthority: AGENT }),
    TypeError
  );
  await assert.rejects(
    client.pollAgentInbox({ nonce: "", signature: SIG }),
    TypeError
  );
  await assert.rejects(
    client.acknowledgeAgentInboxItem({
      nonce: NONCE,
      signature: SIG,
      requestId: "bad",
    }),
    TypeError
  );
});
