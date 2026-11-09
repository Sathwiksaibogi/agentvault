import test from "node:test";
import assert from "node:assert/strict";
import * as nacl from "tweetnacl";

import { Ed25519Program, Keypair, PublicKey } from "@solana/web3.js";

import {
  encodeWorkflow,
  type WorkflowApproval,
  type ApprovalScope,
} from "./signed-workflow";

import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";

import {
  buildBoundModelBOwnerInstruction,
  type ModelBWorkflowBinding,
} from "./model-b-workflow-binding";

function fixture() {
  const owner = Keypair.generate();
  const key = () => Keypair.generate().publicKey.toBase58();

  const programId = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), authority.toBuffer()],
    programId
  );

  const taskIdBytes = Buffer.alloc(8);
  taskIdBytes.writeBigUInt64LE(BigInt(7));

  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskIdBytes],
    programId
  );

  const nowUnix = 1_800_000_000;

  const workflow: WorkflowApproval = {
    version: 1,
    network: "devnet",
    requestId: "modelb-binding-001",
    genesisHash: key(),
    programId: programId.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: key(),
    assignedAgent: "agent-a",
    agentAuthority: authority.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: key(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 3600,
    description: "Purchase authorized compute capacity",
  };

  const signedWorkflow = {
    workflow,
    signature: Buffer.from(
      nacl.sign.detached(encodeWorkflow(workflow), owner.secretKey)
    ).toString("base64"),
  };

  const paymentApproval: PaymentApprovalV2 = {
    version: 2,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
    agent: agentPda.toBase58(),
    agentAuthority: workflow.agentAuthority,
    task: approvedTaskPda.toBase58(),
    recipient: workflow.recipient,
    amountBaseUnits: "1000",
    nonce: "0",
    expiresAtUnix: String(nowUnix + 1800),
    requestId: workflow.requestId,
  };

  function signPayment(value: PaymentApprovalV2): string {
    return Buffer.from(
      nacl.sign.detached(encodePaymentApprovalV2(value), owner.secretKey)
    ).toString("base64");
  }

  const scope: ApprovalScope = {
    network: workflow.network,
    genesisHash: workflow.genesisHash,
    programId: workflow.programId,
    vault: workflow.vault,
    owner: workflow.owner,
    mint: workflow.mint,
  };

  const binding: ModelBWorkflowBinding = {
    signedWorkflow,
    paymentApproval,
    signatureBase64: signPayment(paymentApproval),
    scope,
    agentPda,
    approvedTaskPda,
    nextNonce: "0",
    taskExpiresAtUnix: String(nowUnix + 7200),
    nowUnix,
  };

  return { binding, owner, signPayment };
}

test("accepts matching v1 workflow and v2 owner approval", () => {
  const { binding } = fixture();

  const ix = buildBoundModelBOwnerInstruction(binding);

  assert.ok(ix.programId.equals(Ed25519Program.programId));
  assert.equal(ix.data.readUInt16LE(14), 0xffff);
  assert.deepEqual(
    ix.data.subarray(112),
    encodePaymentApprovalV2(binding.paymentApproval)
  );
});

test("rejects a separately signed but altered payment amount", () => {
  const { binding, signPayment } = fixture();

  const altered = {
    ...(binding.paymentApproval as PaymentApprovalV2),
    amountBaseUnits: "2000",
  };

  assert.throws(
    () =>
      buildBoundModelBOwnerInstruction({
        ...binding,
        paymentApproval: altered,
        signatureBase64: signPayment(altered),
      }),
    /Model B binding mismatch: amountBaseUnits/
  );
});

test("rejects an approval for a different task", () => {
  const { binding, signPayment } = fixture();

  const altered = {
    ...(binding.paymentApproval as PaymentApprovalV2),
    task: Keypair.generate().publicKey.toBase58(),
  };

  assert.throws(
    () =>
      buildBoundModelBOwnerInstruction({
        ...binding,
        paymentApproval: altered,
        signatureBase64: signPayment(altered),
      }),
    /Model B binding mismatch: task/
  );
});

test("rejects an incorrect on-chain nonce", () => {
  const { binding } = fixture();

  assert.throws(
    () =>
      buildBoundModelBOwnerInstruction({
        ...binding,
        nextNonce: "1",
      }),
    /Model B binding mismatch: nonce/
  );
});

test("rejects a Model B approval outliving the workflow", () => {
  const { binding, signPayment } = fixture();

  const workflow = (
    binding.signedWorkflow as {
      workflow: WorkflowApproval;
    }
  ).workflow;

  const altered = {
    ...(binding.paymentApproval as PaymentApprovalV2),
    expiresAtUnix: String(workflow.expiresAtUnix + 1),
  };

  assert.throws(
    () =>
      buildBoundModelBOwnerInstruction({
        ...binding,
        paymentApproval: altered,
        signatureBase64: signPayment(altered),
      }),
    /Model B approval expiry invalid/
  );
});

test("rejects an invalid owner signature", () => {
  const { binding } = fixture();

  assert.throws(
    () =>
      buildBoundModelBOwnerInstruction({
        ...binding,
        signatureBase64: Buffer.alloc(64, 3).toString("base64"),
      }),
    /Invalid Model B owner signature/
  );
});
