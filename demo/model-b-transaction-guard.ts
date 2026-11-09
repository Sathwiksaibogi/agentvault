import { createHash } from "node:crypto";
import assert from "node:assert/strict";

import {
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { paymentApprovalV2Schema } from "./payment-approval-v2";
import {
  buildBoundModelBOwnerInstruction,
  type ModelBWorkflowBinding,
} from "./model-b-workflow-binding";

export type ExpectedModelBPayment = {
  binding: ModelBWorkflowBinding;
  paymentInstruction: TransactionInstruction;
};

const PAYMENT_DISCRIMINATOR = createHash("sha256")
  .update("global:execute_approved_payment")
  .digest()
  .subarray(0, 8);

function equalInstruction(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
  label: string
): void {
  assert.ok(actual.programId.equals(expected.programId), `${label}: program`);
  assert.ok(
    Buffer.from(actual.data).equals(Buffer.from(expected.data)),
    `${label}: data`
  );
  assert.equal(actual.keys.length, expected.keys.length, `${label}: accounts`);

  for (let i = 0; i < expected.keys.length; i++) {
    assert.ok(
      actual.keys[i].pubkey.equals(expected.keys[i].pubkey),
      `${label}: account ${i}`
    );
    assert.equal(
      actual.keys[i].isSigner,
      expected.keys[i].isSigner,
      `${label}: signer ${i}`
    );
    assert.equal(
      actual.keys[i].isWritable,
      expected.keys[i].isWritable,
      `${label}: writable ${i}`
    );
  }
}

function canonicalInstructions(expected: ExpectedModelBPayment) {
  const { binding, paymentInstruction } = expected;

  // Verifies both signed approvals, their scopes, PDAs,
  // nonce, amount, request identity and expiry bounds.
  const ed25519Instruction = buildBoundModelBOwnerInstruction(binding);
  const approval = paymentApprovalV2Schema.parse(binding.paymentApproval);

  const authority = new PublicKey(approval.agentAuthority);
  const vault = new PublicKey(approval.vault);
  const mint = new PublicKey(approval.mint);
  const recipient = new PublicKey(approval.recipient);

  const treasury = getAssociatedTokenAddressSync(mint, vault, true);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);

  assert.ok(
    ed25519Instruction.programId.equals(Ed25519Program.programId),
    "Invalid Model B Ed25519 program"
  );

  assert.ok(
    paymentInstruction.programId.equals(AGENTVAULT_PROGRAM_ID),
    "Invalid Model B payment program"
  );

  // Verify the exact Anchor instruction discriminator and
  // arguments, independently of the supplied expected IX.
  const data = Buffer.from(paymentInstruction.data);

  assert.equal(data.length, 64, "Invalid Model B instruction length");
  assert.ok(
    data.subarray(0, 8).equals(PAYMENT_DISCRIMINATOR),
    "Expected executeApprovedPayment"
  );

  assert.equal(data.readBigUInt64LE(8).toString(), approval.amountBaseUnits);
  assert.equal(data.readBigUInt64LE(16).toString(), approval.nonce);
  assert.equal(data.readBigInt64LE(24).toString(), approval.expiresAtUnix);

  const requestHash = createHash("sha256")
    .update(approval.requestId, "utf8")
    .digest();

  assert.ok(
    data.subarray(32, 64).equals(requestHash),
    "Model B request hash mismatch"
  );

  // Exact on-chain account order and permissions.
  const metas = [
    [authority, true, false],
    [vault, false, true],
    [binding.agentPda, false, false],
    [binding.approvedTaskPda, false, true],
    [mint, false, false],
    [treasury, false, true],
    [recipient, false, false],
    [recipientAta, false, true],
    [SYSVAR_INSTRUCTIONS_PUBKEY, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ] as const;

  assert.equal(paymentInstruction.keys.length, metas.length);

  metas.forEach(([pubkey, isSigner, isWritable], i) => {
    const actual = paymentInstruction.keys[i];

    assert.ok(actual.pubkey.equals(pubkey), `Model B account ${i} mismatch`);
    assert.equal(actual.isSigner, isSigner, `Model B signer ${i} mismatch`);
    assert.equal(
      actual.isWritable,
      isWritable,
      `Model B writable ${i} mismatch`
    );
  });

  const ataInstruction = createAssociatedTokenAccountIdempotentInstruction(
    authority,
    recipientAta,
    recipient,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return {
    authority,
    instructions: [ataInstruction, ed25519Instruction, paymentInstruction],
  };
}

/** Check the original, uncompiled instruction sequence. */
export function assertModelBPaymentInstructions(
  transaction: Transaction,
  expected: ExpectedModelBPayment
): void {
  const canonical = canonicalInstructions(expected);

  assert.ok(
    transaction.feePayer?.equals(canonical.authority),
    "Incorrect Model B fee payer"
  );

  assert.equal(
    transaction.instructions.length,
    3,
    "Model B requires exactly three instructions"
  );

  for (let i = 0; i < 3; i++) {
    equalInstruction(
      transaction.instructions[i],
      canonical.instructions[i],
      `Model B instruction ${i}`
    );
  }
}

/** Check the final agent-signed transaction before persistence. */
export function assertExactModelBPayment(
  transaction: Transaction,
  expected: ExpectedModelBPayment
): void {
  assertModelBPaymentInstructions(transaction, expected);
  assertAgentSignature(transaction, expected);
}

function assertAgentSignature(
  transaction: Transaction,
  expected: ExpectedModelBPayment
): void {
  const approval = paymentApprovalV2Schema.parse(
    expected.binding.paymentApproval
  );

  const authority = new PublicKey(approval.agentAuthority);

  assert.equal(transaction.signatures.length, 1);
  assert.ok(transaction.signatures[0].publicKey.equals(authority));
  assert.ok(transaction.signature, "Missing agent signature");
  assert.ok(transaction.verifySignatures(), "Invalid agent signature");
}

/**
 * Check a restored transaction by comparing its compiled,
 * signed message. This handles web3.js account-meta
 * normalization during serialization.
 */
export function assertSerializedModelBPayment(
  transaction: Transaction,
  expected: ExpectedModelBPayment
): void {
  const canonical = canonicalInstructions(expected);

  assert.ok(transaction.recentBlockhash, "Missing blockhash");
  assert.ok(
    transaction.feePayer?.equals(canonical.authority),
    "Incorrect Model B fee payer"
  );

  const reconstructed = new Transaction({
    feePayer: canonical.authority,
    recentBlockhash: transaction.recentBlockhash,
  }).add(...canonical.instructions);

  assertModelBPaymentInstructions(reconstructed, expected);

  assert.ok(
    Buffer.from(transaction.serializeMessage()).equals(
      Buffer.from(reconstructed.serializeMessage())
    ),
    "Model B signed transaction message mismatch"
  );

  assertAgentSignature(transaction, expected);
}
