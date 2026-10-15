import test from "node:test";
import assert from "node:assert/strict";

import {
  validateWorkflowProposal,
  type TrustedWorkflow,
  type AiProposal,
} from "./workflow-policy";

const workflow: TrustedWorkflow = {
  requestId: "procurement-001",
  assignedAgent: "agent-a",
  kind: "procurement",
  taskId: 1,
  amountBaseUnits: 10_000,
  description: "Purchase replacement equipment",
};

const validProposal: AiProposal = {
  decision: "PAY",
  amountBaseUnits: 10_000,
  reason: "Valid procurement request",
};

test("accepts a correctly routed payment proposal", () => {
  const result = validateWorkflowProposal(workflow, "agent-a", validProposal);

  assert.deepEqual(result, { approved: true });
});

test("rejects procurement executed by Operations Agent", () => {
  const result = validateWorkflowProposal(workflow, "agent-b", validProposal);

  assert.equal(result.approved, false);

  if (!result.approved) {
    assert.equal(result.code, "AGENT_MISMATCH");
  }
});

test("rejects incorrect workflow category", () => {
  const result = validateWorkflowProposal(
    { ...workflow, kind: "operations" },
    "agent-a",
    validProposal
  );

  assert.equal(result.approved, false);

  if (!result.approved) {
    assert.equal(result.code, "WORKFLOW_MISMATCH");
  }
});

test("rejects AI-inflated payment amount", () => {
  const result = validateWorkflowProposal(workflow, "agent-a", {
    ...validProposal,
    amountBaseUnits: 20_000,
  });

  assert.equal(result.approved, false);

  if (!result.approved) {
    assert.equal(result.code, "AMOUNT_MISMATCH");
  }
});

test("rejects AI-reduced payment amount", () => {
  const result = validateWorkflowProposal(workflow, "agent-a", {
    ...validProposal,
    amountBaseUnits: 5_000,
  });

  assert.equal(result.approved, false);

  if (!result.approved) {
    assert.equal(result.code, "AMOUNT_MISMATCH");
  }
});

test("rejects payments above the application cap", () => {
  const result = validateWorkflowProposal(
    { ...workflow, amountBaseUnits: 90_000 },
    "agent-a",
    { ...validProposal, amountBaseUnits: 90_000 }
  );

  assert.equal(result.approved, false);

  if (!result.approved) {
    assert.equal(result.code, "PAYMENT_CAP_EXCEEDED");
  }
});

test("rejects payment when AI decides REJECT", () => {
  const result = validateWorkflowProposal(workflow, "agent-a", {
    decision: "REJECT",
    amountBaseUnits: 0,
    reason: "Insufficient justification",
  });

  assert.equal(result.approved, false);

  if (!result.approved) {
    assert.equal(result.code, "AI_REJECTED");
  }
});

test("rejects invalid workflow request IDs", () => {
  const result = validateWorkflowProposal(
    { ...workflow, requestId: "" },
    "agent-a",
    validProposal
  );

  assert.equal(result.approved, false);

  if (!result.approved) {
    assert.equal(result.code, "INVALID_REQUEST_ID");
  }
});
