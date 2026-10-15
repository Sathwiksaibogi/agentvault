import { strict as assert } from "node:assert";

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const AGENTVAULT_PROGRAM_ID = new PublicKey(
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
);

export type ExpectedPayment = {
  agentAuthority: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;

  // Must be built from the verified owner approval and
  // live on-chain accounts, never from Gemini output.
  paymentInstruction: TransactionInstruction;
};

function assertInstructionEqual(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
  label: string
): void {
  assert.ok(
    actual.programId.equals(expected.programId),
    `${label}: incorrect program ID`
  );

  assert.ok(
    Buffer.from(actual.data).equals(Buffer.from(expected.data)),
    `${label}: instruction data mismatch`
  );

  assert.equal(
    actual.keys.length,
    expected.keys.length,
    `${label}: account count mismatch`
  );

  for (let i = 0; i < expected.keys.length; i++) {
    const actualKey = actual.keys[i];
    const expectedKey = expected.keys[i];

    assert.ok(
      actualKey.pubkey.equals(expectedKey.pubkey),
      `${label}: account ${i} address mismatch`
    );

    assert.equal(
      actualKey.isSigner,
      expectedKey.isSigner,
      `${label}: account ${i} signer flag mismatch`
    );

    assert.equal(
      actualKey.isWritable,
      expectedKey.isWritable,
      `${label}: account ${i} writable flag mismatch`
    );
  }
}

export function assertExactAgentVaultPayment(
  transaction: Transaction,
  expected: ExpectedPayment
): void {
  const { agentAuthority, recipient, mint, paymentInstruction } = expected;

  // 1. Only the expected AgentVault program is permitted.
  assert.ok(
    paymentInstruction.programId.equals(AGENTVAULT_PROGRAM_ID),
    "Unexpected AgentVault program ID"
  );

  // 2. The agent must be the transaction fee payer.
  assert.ok(
    transaction.feePayer?.equals(agentAuthority),
    "Incorrect agent fee payer"
  );

  // 3. The exact approved recipient ATA is derived
  // deterministically, not supplied by the AI model.
  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // 4. Verify that the expected payment instruction
  // actually references its agent and recipient ATA.
  assert.ok(
    paymentInstruction.keys.some(
      (key) => key.pubkey.equals(agentAuthority) && key.isSigner
    ),
    "Payment instruction lacks agent authority signer"
  );

  assert.ok(
    paymentInstruction.keys.some((key) => key.pubkey.equals(recipient)),
    "Payment instruction lacks approved recipient"
  );

  assert.ok(
    paymentInstruction.keys.some((key) => key.pubkey.equals(recipientAta)),
    "Payment instruction lacks approved recipient ATA"
  );

  // 5. Reconstruct the only permitted setup instruction.
  const expectedAtaInstruction =
    createAssociatedTokenAccountIdempotentInstruction(
      agentAuthority,
      recipientAta,
      recipient,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

  // We intentionally allow exactly two instructions.
  // No additional SOL transfers, arbitrary CPIs,
  // approvals, or unrelated instructions.
  assert.equal(
    transaction.instructions.length,
    2,
    "Transaction must contain exactly two instructions"
  );

  assertInstructionEqual(
    transaction.instructions[0],
    expectedAtaInstruction,
    "Recipient ATA creation"
  );

  assertInstructionEqual(
    transaction.instructions[1],
    paymentInstruction,
    "AgentVault payment"
  );

  // 6. Ensure the agent has signed the final message.
  assert.equal(
    transaction.signatures.length,
    1,
    "Expected exactly one transaction signer"
  );

  assert.ok(
    transaction.signatures[0].publicKey.equals(agentAuthority),
    "Unexpected transaction signer"
  );

  assert.ok(transaction.signature, "Missing agent transaction signature");

  assert.ok(transaction.verifySignatures(), "Invalid transaction signature");
}
