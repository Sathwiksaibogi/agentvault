import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import { buildUnsignedModelBPayment } from "./model-b-payment-builder";
import { signModelBOwnerApprovalPackage } from "./model-b-owner-approval";
import { assertModelBPaymentInstructions } from "./model-b-transaction-guard";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import type { WorkflowApprovalV2 } from "./signed-workflow-v2";
import type { PaymentApprovalV2 } from "./payment-approval-v2";

function fixture() {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const key = () => Keypair.generate().publicKey;
  const vault = key();
  const mint = key();
  const recipient = key();
  const genesisHash = key();
  const taskId = Buffer.alloc(8);
  taskId.writeBigUInt64LE(BigInt(7));
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agent.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );
  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskId],
    AGENTVAULT_PROGRAM_ID
  );

  const nowUnix = 1_800_000_000;
  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-builder-001",
    genesisHash: genesisHash.toBase58(),
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: agent.publicKey.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: recipient.toBase58(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 3600,
    description: "Authorized infrastructure procurement",
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
    expiresAtUnix: String(nowUnix + 1200),
    requestId: workflow.requestId,
  };

  const context = {
    scope: {
      network: workflow.network,
      genesisHash: workflow.genesisHash,
      programId: workflow.programId,
      vault: workflow.vault,
      owner: workflow.owner,
      mint: workflow.mint,
    },
    agentPda,
    approvedTaskPda,
    nextNonce: "0",
    taskExpiresAtUnix: String(nowUnix + 7200),
    nowUnix,
  };

  const ownerApproval = signModelBOwnerApprovalPackage(
    workflow,
    paymentApproval,
    owner,
    context
  );

  const binding: ModelBWorkflowBinding = { ...context, ...ownerApproval };
  const blockhash = key().toBase58();
  return { binding, blockhash, agent };
}

test("builds exactly ATA, native Ed25519 and Model B payment", () => {
  const { binding, blockhash, agent } = fixture();
  const { transaction, paymentInstruction } = buildUnsignedModelBPayment(
    binding,
    blockhash
  );

  assert.equal(transaction.instructions.length, 3);
  assert.ok(transaction.feePayer?.equals(agent.publicKey));
  assert.ok(
    transaction.instructions[1].programId.equals(Ed25519Program.programId)
  );
  assert.equal(transaction.signatures.length, 0);
  assert.equal(transaction.recentBlockhash, blockhash);
  assertModelBPaymentInstructions(transaction, { binding, paymentInstruction });

  const bytes = paymentInstruction.data;
  assert.equal(bytes.length, 64);
  assert.equal(bytes.readBigUInt64LE(8).toString(), "1000");
  assert.equal(bytes.readBigUInt64LE(16).toString(), "0");
  assert.equal(
    bytes.readBigInt64LE(24).toString(),
    String(binding.nowUnix + 1200)
  );
  assert.ok(
    bytes
      .subarray(32)
      .equals(createHash("sha256").update("modelb-builder-001").digest())
  );
});

test("rejects changing the payment amount without a new owner signature", () => {
  const { binding, blockhash } = fixture();
  assert.throws(
    () =>
      buildUnsignedModelBPayment(
        {
          ...binding,
          paymentApproval: {
            ...(binding.paymentApproval as PaymentApprovalV2),
            amountBaseUnits: "1001",
          },
        },
        blockhash
      ),
    /Model B binding mismatch: amountBaseUnits/
  );
});

test("rejects a nonce inconsistent with the on-chain policy", () => {
  const { binding, blockhash } = fixture();
  assert.throws(
    () => buildUnsignedModelBPayment({ ...binding, nextNonce: "1" }, blockhash),
    /Model B binding mismatch: nonce/
  );
});

test("rejects tampered owner signature", () => {
  const { binding, blockhash } = fixture();
  assert.throws(
    () =>
      buildUnsignedModelBPayment(
        {
          ...binding,
          signatureBase64: Buffer.alloc(64, 1).toString("base64"),
        },
        blockhash
      ),
    /Invalid Model B owner signature/
  );
});

test("rejects an unexpected transfer inserted into the transaction", () => {
  const { binding, blockhash, agent } = fixture();
  const { transaction, paymentInstruction } = buildUnsignedModelBPayment(
    binding,
    blockhash
  );
  transaction.instructions.splice(
    1,
    0,
    SystemProgram.transfer({
      fromPubkey: agent.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    })
  );
  assert.throws(
    () =>
      assertModelBPaymentInstructions(transaction, {
        binding,
        paymentInstruction,
      }),
    /Model B requires exactly three instructions/
  );
});
