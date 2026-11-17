import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import { buildBoundModelBOwnerInstruction } from "./model-b-workflow-binding";
import { paymentApprovalV2Schema } from "./payment-approval-v2";
import { AGENTVAULT_PROGRAM_ID } from "./payment-transaction-guard";
import { assertModelBPaymentInstructions } from "./model-b-transaction-guard";

export type UnsignedModelBPayment = {
  transaction: Transaction;
  paymentInstruction: TransactionInstruction;
};

/**
 * Build, but do not sign, a single precisely owner-approved Model B payment.
 * The transaction is always: idempotent ATA -> Ed25519 -> payment.
 */
export function buildUnsignedModelBPayment(
  binding: ModelBWorkflowBinding,
  recentBlockhash: string
): UnsignedModelBPayment {
  // Cryptographically verify both owner signatures, signed workflow routing,
  // PDA relationships, nonce, amount and expiry before building anything.
  const ownerVerification = buildBoundModelBOwnerInstruction(binding);
  const approval = paymentApprovalV2Schema.parse(binding.paymentApproval);

  // A blockhash is a 32-byte base58 Solana hash.
  const blockhash = new PublicKey(recentBlockhash).toBase58();
  assert.equal(blockhash, recentBlockhash, "Noncanonical blockhash");

  const authority = new PublicKey(approval.agentAuthority);
  const vault = new PublicKey(approval.vault);
  const mint = new PublicKey(approval.mint);
  const recipient = new PublicKey(approval.recipient);

  const treasury = getAssociatedTokenAddressSync(
    mint,
    vault,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Anchor execute_approved_payment(amount: u64, nonce: u64,
  // expires_at: i64, request_hash: [u8; 32]).
  const data = Buffer.alloc(64);
  createHash("sha256")
    .update("global:execute_approved_payment", "utf8")
    .digest()
    .copy(data, 0, 0, 8);

  data.writeBigUInt64LE(BigInt(approval.amountBaseUnits), 8);
  data.writeBigUInt64LE(BigInt(approval.nonce), 16);
  data.writeBigInt64LE(BigInt(approval.expiresAtUnix), 24);
  createHash("sha256")
    .update(approval.requestId, "utf8")
    .digest()
    .copy(data, 32);

  const paymentInstruction = new TransactionInstruction({
    programId: AGENTVAULT_PROGRAM_ID,
    data,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: binding.agentPda, isSigner: false, isWritable: false },
      { pubkey: binding.approvedTaskPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: recipientAta, isSigner: false, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });

  const ataInstruction = createAssociatedTokenAccountIdempotentInstruction(
    authority,
    recipientAta,
    recipient,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const transaction = new Transaction({
    feePayer: authority,
    recentBlockhash: blockhash,
  }).add(ataInstruction, ownerVerification, paymentInstruction);

  // Independent existing guard compares instructions, account metas, args,
  // program IDs, order, exact fee payer, and both signatures' bindings.
  assertModelBPaymentInstructions(transaction, {
    binding,
    paymentInstruction,
  });

  return { transaction, paymentInstruction };
}
