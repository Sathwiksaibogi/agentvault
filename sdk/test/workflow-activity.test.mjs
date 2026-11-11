import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentVaultClient,
  AgentVaultHttpError,
  AgentVaultProtocolError,
} from "../dist/index.js";

const id = "pay_request-123";
const workflow = {
  requestId: id,
  assignedAgent: "agent-1",
  workflowKind: "vendor_payment",
  taskId: 2,
  amountBaseUnits: 12000,
  network: "devnet",
  recipient: "RecipientPubkey",
  approval: {
    signatureVerified: true,
    currentlyValid: false,
    expiresAtUnix: 1799999999,
  },
  aiDecision: {
    receiptFilePresent: false,
    verification: "not_performed",
  },
  execution: { journalStatus: "unclaimed", payment: null },
};
const activity = {
  signature: "TransactionSignature",
  slot: 202,
  blockTimeUnix: null,
  agentId: "agent-1",
  workflow: "vendor_payment",
  taskId: 2,
  taskPda: "TaskPda",
  succeeded: true,
  explorerUrl: "https://explorer.solana.com/tx/example?cluster=devnet",
};
function createClient(fetchImpl) {
  return new AgentVaultClient({
    baseUrl: "http://127.0.0.1:3000",
    token: "test-secret-token",
    fetchImpl,
  });
}

test("listWorkflowIds unwraps existing API envelope and sends Bearer auth", async () => {
  const client = createClient(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:3000/api/workflows");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer test-secret-token");
    return Response.json({ network: "devnet", requestIds: [id] });
  });
  assert.deepEqual(await client.listWorkflowIds(), [id]);
});

test("listWorkflowIds handles empty index and rejects invalid IDs", async () => {
  assert.deepEqual(await createClient(async () => Response.json({ requestIds: [] })).listWorkflowIds(), []);
  await assert.rejects(
    createClient(async () => Response.json({ requestIds: ["../foo"] })).listWorkflowIds(),
    AgentVaultProtocolError,
  );
  await assert.rejects(
    createClient(async () => Response.json({ requestIds: "oops" })).listWorkflowIds(),
    AgentVaultProtocolError,
  );
});

test("getWorkflow reads existing workflow status including null payment", async () => {
  const client = createClient(async (url, init) => {
    assert.equal(url, `http://127.0.0.1:3000/api/workflows/${id}`);
    assert.equal(init.headers.Authorization, "Bearer test-secret-token");
    return Response.json(workflow);
  });
  assert.deepEqual(await client.getWorkflow(id), workflow);
});

test("getWorkflow reads signed payment state and validates nonce", async () => {
  const signed = {
    ...workflow,
    execution: {
      journalStatus: "signed_transaction_saved",
      payment: {
        signature: "TransactionSignature",
        recoveryState: "confirmed",
        amountBaseUnits: 12000,
        nonce: "18446744073709551615",
      },
    },
  };
  const client = createClient(async () => Response.json(signed));
  assert.deepEqual(await client.getWorkflow(id), signed);
  await assert.rejects(
    createClient(async () => Response.json({ ...signed, execution: {
      ...signed.execution,
      payment: { ...signed.execution.payment, nonce: 12 },
    } })).getWorkflow(id),
    AgentVaultProtocolError,
  );
});

test("getWorkflow rejects invalid path IDs before calling fetch", async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls++;
    return Response.json(workflow);
  });
  for (const bad of ["x", "../unsafe", "abc%2Fdef", "not valid id", "a".repeat(65)]) {
    await assert.rejects(client.getWorkflow(bad), TypeError);
  }
  assert.equal(calls, 0);
});

test("getWorkflow rejects mismatched ID, missing fields and unsafe numbers", async () => {
  for (const bad of [
    { ...workflow, requestId: "different-id" },
    { ...workflow, execution: { payment: null } },
    { ...workflow, amountBaseUnits: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    await assert.rejects(
      createClient(async () => Response.json(bad)).getWorkflow(id),
      AgentVaultProtocolError,
    );
  }
});

test("listActivity unwraps activity, supports null block time and empty arrays", async () => {
  const client = createClient(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:3000/api/activity");
    assert.equal(init.headers.Authorization, "Bearer test-secret-token");
    return Response.json({ network: "devnet", activity: [activity] });
  });
  assert.deepEqual(await client.listActivity(), [activity]);
  assert.deepEqual(await createClient(async () => Response.json({ activity: [] })).listActivity(), []);
});

test("listActivity rejects malformed envelopes and malformed entries", async () => {
  for (const body of [
    { activity: {} },
    { activity: [{ ...activity, slot: "202" }] },
    { activity: [{ ...activity, succeeded: "yes" }] },
  ]) {
    await assert.rejects(createClient(async () => Response.json(body)).listActivity(), AgentVaultProtocolError);
  }
});

test("workflow 404 stays a typed HTTP error and does not leak credentials", async () => {
  await assert.rejects(
    createClient(async () => Response.json({ error: "missing" }, { status: 404 })).getWorkflow(id),
    (error) => {
      assert.ok(error instanceof AgentVaultHttpError);
      assert.equal(error.status, 404);
      assert.equal(error.path, `/api/workflows/${id}`);
      assert.ok(!error.message.includes("test-secret-token"));
      return true;
    },
  );
});
