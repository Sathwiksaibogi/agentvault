import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";

import {
  encodeWorkflow,
  verifyWorkflowApproval,
  type WorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";

const owner = Keypair.generate();

const address = () => Keypair.generate().publicKey.toBase58();

const workflow: WorkflowApproval = {
  version: 1,
  network: "devnet",
  requestId: "procurement-002",

  genesisHash: address(),
  programId: address(),
  vault: address(),
  owner: owner.publicKey.toBase58(),
  mint: address(),

  assignedAgent: "agent-a",
  agentAuthority: address(),
  kind: "procurement",
  taskId: 1,

  recipient: address(),
  amountBaseUnits: 10_000,
  expiresAtUnix: 2_000_000_000,
  description: "Purchase replacement equipment",
};

const scope: ApprovalScope = {
  network: workflow.network,
  genesisHash: workflow.genesisHash,
  programId: workflow.programId,
  vault: workflow.vault,
  owner: workflow.owner,
  mint: workflow.mint,
};

const testTime = 1_900_000_000;

function sign(data: WorkflowApproval = workflow, signer: Keypair = owner) {
  const signature = nacl.sign.detached(encodeWorkflow(data), signer.secretKey);

  return {
    workflow: data,
    signature: Buffer.from(signature).toString("base64"),
  };
}

test("accepts a correctly signed owner approval", () => {
  const result = verifyWorkflowApproval(sign(), scope, testTime);

  assert.equal(result.requestId, "procurement-002");
  assert.equal(result.amountBaseUnits, 10_000);
});

test("rejects a modified payment amount", () => {
  const signed = sign();

  assert.throws(
    () =>
      verifyWorkflowApproval(
        {
          ...signed,
          workflow: {
            ...signed.workflow,
            amountBaseUnits: 20_000,
          },
        },
        scope,
        testTime
      ),
    /Invalid owner signature/
  );
});

test("rejects a modified recipient", () => {
  const signed = sign();

  assert.throws(
    () =>
      verifyWorkflowApproval(
        {
          ...signed,
          workflow: {
            ...signed.workflow,
            recipient: address(),
          },
        },
        scope,
        testTime
      ),
    /Invalid owner signature/
  );
});

test("rejects a modified agent identity", () => {
  const signed = sign();

  assert.throws(
    () =>
      verifyWorkflowApproval(
        {
          ...signed,
          workflow: {
            ...signed.workflow,
            agentAuthority: address(),
          },
        },
        scope,
        testTime
      ),
    /Invalid owner signature/
  );
});

test("rejects signature from a different wallet", () => {
  const attacker = Keypair.generate();

  assert.throws(
    () => verifyWorkflowApproval(sign(workflow, attacker), scope, testTime),
    /Invalid owner signature/
  );
});

test("rejects approvals from another network", () => {
  assert.throws(
    () =>
      verifyWorkflowApproval(
        sign(),
        { ...scope, network: "localnet" },
        testTime
      ),
    /Approval scope mismatch/
  );
});

test("rejects approvals for another token mint", () => {
  assert.throws(
    () =>
      verifyWorkflowApproval(sign(), { ...scope, mint: address() }, testTime),
    /Approval scope mismatch/
  );
});

test("rejects expired workflow approvals", () => {
  assert.throws(
    () => verifyWorkflowApproval(sign(), scope, workflow.expiresAtUnix + 1),
    /Workflow approval expired/
  );
});

test("rejects malformed signatures", () => {
  assert.throws(
    () =>
      verifyWorkflowApproval(
        {
          workflow,
          signature: "invalid-signature",
        },
        scope,
        testTime
      ),
    /Malformed owner signature/
  );
});

test("rejects unexpected approval fields", () => {
  assert.throws(() =>
    verifyWorkflowApproval(
      {
        ...sign(),
        workflow: {
          ...workflow,
          bypassSecurity: true,
        },
      },
      scope,
      testTime
    )
  );
});
