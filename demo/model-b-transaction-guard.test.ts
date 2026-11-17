import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nacl from "tweetnacl";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import {
  encodeWorkflowV2,
  type WorkflowApprovalV2,
} from "./signed-workflow-v2";
import {
  encodePaymentApprovalV2,
  type PaymentApprovalV2,
} from "./payment-approval-v2";
import { buildBoundModelBOwnerInstruction } from "./model-b-workflow-binding";
import {
  assertExactModelBPayment,
  assertModelBPaymentInstructions,
  assertSerializedModelBPayment,
} from "./model-b-transaction-guard";

function fixture() {
  const owner = Keypair.generate();
  const agentSigner = Keypair.generate();
  const vault = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const genesisHash = Keypair.generate().publicKey;

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vault.toBuffer(), agentSigner.publicKey.toBuffer()],
    AGENTVAULT_PROGRAM_ID
  );

  const taskId = Buffer.alloc(8);
  taskId.writeBigUInt64LE(BigInt(7));

  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agentPda.toBuffer(), taskId],
    AGENTVAULT_PROGRAM_ID
  );

  const nowUnix = 1_800_000_000;

  const workflow: WorkflowApprovalV2 = {
    version: 2,
    authorizationModel: "model-b",
    network: "devnet",
    requestId: "modelb-guard-001",
    genesisHash: genesisHash.toBase58(),
    programId: AGENTVAULT_PROGRAM_ID.toBase58(),
    vault: vault.toBase58(),
    owner: owner.publicKey.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: "agent-a",
    agentAuthority: agentSigner.publicKey.toBase58(),
    kind: "procurement",
    taskId: 7,
    recipient: recipient.toBase58(),
    amountBaseUnits: 1000,
    expiresAtUnix: nowUnix + 3600,
    description: "Authorized compute infrastructure purchase",
  };

  const signedWorkflow = {
    workflow,
    signature: Buffer.from(
      nacl.sign.detached(encodeWorkflowV2(workflow), owner.secretKey)
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

  const signatureBase64 = Buffer.from(
    nacl.sign.detached(
      encodePaymentApprovalV2(paymentApproval),
      owner.secretKey
    )
  ).toString("base64");

  const binding = {
    signedWorkflow,
    paymentApproval,
    signatureBase64,
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

  const data = Buffer.alloc(64);

  createHash("sha256")
    .update("global:execute_approved_payment")
    .digest()
    .copy(data, 0, 0, 8);

  data.writeBigUInt64LE(BigInt(1000), 8);
  data.writeBigUInt64LE(BigInt(0), 16);
  data.writeBigInt64LE(BigInt(paymentApproval.expiresAtUnix), 24);

  createHash("sha256")
    .update(paymentApproval.requestId)
    .digest()
    .copy(data, 32);

  const treasury = getAssociatedTokenAddressSync(mint, vault, true);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);

  const metas = [
    [agentSigner.publicKey, true, false],
    [vault, false, true],
    [agentPda, false, false],
    [approvedTaskPda, false, true],
    [mint, false, false],
    [treasury, false, true],
    [recipient, false, false],
    [recipientAta, false, true],
    [SYSVAR_INSTRUCTIONS_PUBKEY, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ] as const;

  const paymentInstruction = new TransactionInstruction({
    programId: AGENTVAULT_PROGRAM_ID,
    data,
    keys: metas.map(([pubkey, isSigner, isWritable]) => ({
      pubkey,
      isSigner,
      isWritable,
    })),
  });

  const ataInstruction = createAssociatedTokenAccountIdempotentInstruction(
    agentSigner.publicKey,
    recipientAta,
    recipient,
    mint
  );

  const edInstruction = buildBoundModelBOwnerInstruction(binding);

  const transaction = new Transaction({
    feePayer: agentSigner.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(ataInstruction, edInstruction, paymentInstruction);

  const expected = { binding, paymentInstruction };

  return { transaction, expected, agentSigner, owner };
}

test("accepts exactly the approved Model B transaction", () => {
  const { transaction, expected, agentSigner } = fixture();

  assertModelBPaymentInstructions(transaction, expected);

  transaction.sign(agentSigner);

  assertExactModelBPayment(transaction, expected);

  const restored = Transaction.from(transaction.serialize());

  assertSerializedModelBPayment(restored, expected);
});

test("rejects an inserted instruction between Ed25519 and payment", () => {
  const { transaction, expected, agentSigner, owner } = fixture();

  transaction.instructions.splice(
    2,
    0,
    SystemProgram.transfer({
      fromPubkey: agentSigner.publicKey,
      toPubkey: owner.publicKey,
      lamports: 1,
    })
  );

  assert.throws(
    () => assertModelBPaymentInstructions(transaction, expected),
    /exactly three instructions/
  );
});

test("rejects a changed payment amount", () => {
  const { transaction, expected } = fixture();

  transaction.instructions[2].data[8] ^= 1;

  assert.throws(
    () => assertModelBPaymentInstructions(transaction, expected),
    /Expected values to be strictly equal/
  );
});

test("rejects an altered payment account", () => {
  const { transaction, expected } = fixture();

  transaction.instructions[2].keys[3].pubkey = Keypair.generate().publicKey;

  assert.throws(
    () => assertModelBPaymentInstructions(transaction, expected),
    /Model B account 3 mismatch/
  );
});

test("rejects a malformed owner approval", () => {
  const { transaction, expected } = fixture();

  transaction.instructions[1].data[14] = 0;

  assert.throws(
    () => assertModelBPaymentInstructions(transaction, expected),
    /Model B instruction 1: data/
  );
});

test("rejects a modified transaction after agent signing", () => {
  const { transaction, expected, agentSigner } = fixture();

  transaction.sign(agentSigner);

  const restored = Transaction.from(transaction.serialize());

  restored.instructions[2].data[8] ^= 1;

  assert.throws(
    () => assertSerializedModelBPayment(restored, expected),
    /Model B signed transaction message mismatch/
  );
});
