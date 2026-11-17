/** Offline tests for the exact v1 Phantom/CLI encoding contract and scope. */
import test from "node:test";
import { strict as assert } from "node:assert";
import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import {
  encodeWorkflow,
  verifyWorkflowApproval,
  type WorkflowApproval,
} from "./signed-workflow";
import {
  encodeSelectedVaultApproval,
  type SelectedVaultApproval,
} from "../frontend/src/selected-vault-approval";

const id = () => Keypair.generate().publicKey.toBase58();
function fixture() {
  const owner = Keypair.generate();
  const workflow: WorkflowApproval = {
    version: 1,
    network: "devnet",
    requestId: "model-a-selected-02",
    genesisHash: id(),
    programId: id(),
    vault: id(),
    owner: owner.publicKey.toBase58(),
    mint: id(),
    assignedAgent: "agent-a",
    agentAuthority: id(),
    kind: "procurement",
    taskId: 2,
    recipient: id(),
    amountBaseUnits: 50_000,
    expiresAtUnix: 2_100_000_000,
    description: "Devnet supply order for test",
  };
  const signature = Buffer.from(
    nacl.sign.detached(encodeWorkflow(workflow), owner.secretKey)
  ).toString("base64");
  const scope = {
    network: workflow.network,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
  };
  return { workflow, signature, scope };
}

test("browser encoder matches existing Model A v1 byte-for-byte", () => {
  const { workflow } = fixture();
  assert.deepEqual(
    Buffer.from(encodeSelectedVaultApproval(workflow as SelectedVaultApproval)),
    Buffer.from(encodeWorkflow(workflow))
  );
});

test("real owner signature accepted for exact selected vault", () => {
  const { workflow, signature, scope } = fixture();
  assert.deepEqual(
    verifyWorkflowApproval({ workflow, signature }, scope, 1_900_000_000),
    workflow
  );
});

test("cross-vault, wrong owner and wrong mint are rejected", () => {
  const { workflow, signature, scope } = fixture();
  for (const field of [
    "vault",
    "owner",
    "mint",
    "genesisHash",
    "programId",
  ] as const) {
    assert.throws(
      () =>
        verifyWorkflowApproval(
          { workflow, signature },
          { ...scope, [field]: id() },
          1_900_000_000
        ),
      /scope mismatch/
    );
  }
});

test("changing payment amount, task or recipient invalidates the signature", () => {
  const { workflow, signature, scope } = fixture();
  for (const modified of [
    { ...workflow, amountBaseUnits: 1 },
    { ...workflow, taskId: 1 },
    { ...workflow, recipient: id() },
    { ...workflow, agentAuthority: id() },
  ]) {
    assert.throws(
      () =>
        verifyWorkflowApproval(
          { workflow: modified, signature },
          scope,
          1_900_000_000
        ),
      /Invalid owner signature/
    );
  }
});

test("expiry and malformed owner signatures fail closed", () => {
  const { workflow, signature, scope } = fixture();
  assert.throws(
    () =>
      verifyWorkflowApproval(
        { workflow, signature },
        scope,
        workflow.expiresAtUnix
      ),
    /expired/
  );
  assert.throws(
    () =>
      verifyWorkflowApproval(
        { workflow, signature: "wrong" },
        scope,
        1_900_000_000
      ),
    /Malformed/
  );
});
