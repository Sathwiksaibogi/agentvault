import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

import type { WorkflowApprovalV2 } from "./signed-workflow-v2";
import type { ModelBOwnerPolicySnapshot } from "./model-b-owner-policy";
import { assertModelBAiWorkflowMatchesPolicy } from "./model-b-ai-evaluator-guard";

const address = () => Keypair.generate().publicKey.toBase58();
const authority = address();
const recipient = address();

function fixture(): {
  workflow: WorkflowApprovalV2;
  policy: ModelBOwnerPolicySnapshot;
} {
  return {
    workflow: {
      version: 2,
      authorizationModel: "model-b",
      network: "devnet",
      requestId: "modelb-eval-001",
      genesisHash: address(),
      programId: address(),
      vault: address(),
      owner: address(),
      mint: address(),
      assignedAgent: "agent-a",
      agentAuthority: authority,
      kind: "procurement",
      taskId: 7,
      recipient,
      amountBaseUnits: 1000,
      expiresAtUnix: 1800003600,
      description: "Approved infrastructure purchase",
    },
    policy: {
      nowUnix: 1800000000,
      recipient,
      nextNonce: "0",
      taskExpiresAtUnix: "1800007200",
      budget: "1500",
      spent: "200",
      remaining: "1300",
      totalReserved: "1200",
      treasuryBalance: "1500",
    },
  };
}

test("accepts workflow v2 that matches fresh Model B policy", () => {
  const { workflow, policy } = fixture();
  assert.doesNotThrow(() =>
    assertModelBAiWorkflowMatchesPolicy(workflow, policy, authority)
  );
});

test("rejects an on-chain recipient changed since owner approval", () => {
  const { workflow, policy } = fixture();
  assert.throws(
    () =>
      assertModelBAiWorkflowMatchesPolicy(
        workflow,
        { ...policy, recipient: address() },
        authority
      ),
    /on-chain recipient/
  );
});

test("rejects a different trusted agent authority", () => {
  const { workflow, policy } = fixture();
  assert.throws(
    () => assertModelBAiWorkflowMatchesPolicy(workflow, policy, address()),
    /untrusted agent authority/
  );
});

test("rejects an agent with the wrong workflow category", () => {
  const { workflow, policy } = fixture();
  assert.throws(
    () =>
      assertModelBAiWorkflowMatchesPolicy(
        { ...workflow, kind: "operations" },
        policy,
        authority
      ),
    /workflow mismatch/
  );
});

test("rejects an approval that outlives the task", () => {
  const { workflow, policy } = fixture();
  assert.throws(
    () =>
      assertModelBAiWorkflowMatchesPolicy(
        { ...workflow, expiresAtUnix: 1800007201 },
        policy,
        authority
      ),
    /outlives on-chain task/
  );
});

test("rejects an amount beyond the remaining task budget", () => {
  const { workflow, policy } = fixture();
  assert.throws(
    () =>
      assertModelBAiWorkflowMatchesPolicy(
        workflow,
        { ...policy, remaining: "999" },
        authority
      ),
    /remaining task budget/
  );
});

test("rejects an amount beyond the vault reservation", () => {
  const { workflow, policy } = fixture();
  assert.throws(
    () =>
      assertModelBAiWorkflowMatchesPolicy(
        workflow,
        { ...policy, totalReserved: "999" },
        authority
      ),
    /reserved funds/
  );
});

test("rejects an amount above the app cap", () => {
  const { workflow, policy } = fixture();
  assert.throws(
    () =>
      assertModelBAiWorkflowMatchesPolicy(
        { ...workflow, amountBaseUnits: 50001 },
        policy,
        authority
      ),
    /application cap/
  );
});

test("rejects workflow v1 and an authorization-model downgrade", () => {
  const { workflow, policy } = fixture();
  assert.throws(
    () =>
      assertModelBAiWorkflowMatchesPolicy(
        { ...workflow, version: 1 } as unknown as WorkflowApprovalV2,
        policy,
        authority
      ),
    /workflow v2/
  );
  assert.throws(() =>
    assertModelBAiWorkflowMatchesPolicy(
      {
        ...workflow,
        authorizationModel: "model-a",
      } as unknown as WorkflowApprovalV2,
      policy,
      authority
    )
  );
});
