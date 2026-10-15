import BN from "bn.js";

import { strict as assert } from "node:assert";

import {
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { evaluateApprovedWorkflow } from "./ai-workflow";

import { assertPaymentInstructions } from "./payment-transaction-guard";

async function main() {
  const requestId = process.argv[2];

  assert.ok(
    requestId && /^[a-zA-Z0-9_-]{8,64}$/.test(requestId),
    "Usage: preview-ai-payment.ts <request-id>"
  );

  // 1. Verify owner signature, Gemini decision,
  // business policy, and live Solana accounts.
  const context = await evaluateApprovedWorkflow(requestId);

  const {
    connection,
    program,
    workflow,
    vaultPda,
    mint,
    treasury,
    agentPda,
    taskPda,
    recipient,
    nonce,
  } = context;

  const authority = new PublicKey(workflow.agentAuthority);

  const amount = new BN(workflow.amountBaseUnits);

  // 2. Derive the recipient's canonical ATA.
  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // 3. Build the exact AgentVault instruction.
  // Amount comes from the signed workflow.
  // Nonce comes from live Solana account state.
  const paymentInstruction = await program.methods
    .executeTaskPayment(amount, new BN(nonce))
    .accountsPartial({
      agentAuthority: authority,
      vault: vaultPda,
      agent: agentPda,
      task: taskPda,
      tokenMint: mint,
      treasury,
      recipient,
      recipientToken: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // 4. Include only the required recipient ATA setup.
  const ataInstruction = createAssociatedTokenAccountIdempotentInstruction(
    authority,
    recipientAta,
    recipient,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  // 5. Construct the unsigned payment transaction.
  const transaction = new Transaction({
    feePayer: authority,
    recentBlockhash: blockhash,
  }).add(ataInstruction, paymentInstruction);

  const expected = {
    agentAuthority: authority,
    recipient,
    mint,
    paymentInstruction,
  };

  // 6. Reject all unexpected instructions and accounts.
  assertPaymentInstructions(transaction, expected);

  console.log("\n=== EXACT PAYMENT STRUCTURE ===");
  console.log("Request:", requestId);
  console.log("Agent:", workflow.assignedAgent);
  console.log("Fee payer:", authority.toBase58());
  console.log("Task:", taskPda.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Recipient ATA:", recipientAta.toBase58());
  console.log("Amount:", amount.toString());
  console.log("Nonce:", nonce);
  console.log("Instructions:", transaction.instructions.length);

  // 7. Simulate the same two instructions.
  // Use an unsigned v0 simulation transaction;
  // signature verification is disabled for simulation.
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();

  const simulationTransaction = new VersionedTransaction(message);

  const simulation = await connection.simulateTransaction(
    simulationTransaction,
    {
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    }
  );

  if (simulation.value.err !== null) {
    console.error("\nSIMULATION FAILED:", simulation.value.err);

    console.error(simulation.value.logs?.join("\n") ?? "");

    throw new Error("AgentVault payment simulation failed");
  }

  console.log("\n=== PAYMENT SIMULATION PASSED ===");
  console.log(
    "Compute units:",
    simulation.value.unitsConsumed ?? "Unavailable"
  );
  console.log("Expected amount:", amount.toString());
  console.log("Expected nonce:", nonce);
  console.log("Instruction structure: VERIFIED");

  console.log("\nMODE: SIMULATION ONLY");
  console.log("No private keys loaded.");
  console.log("No request journal claimed.");
  console.log("No transaction signed or broadcast.");
}

main().catch((error) => {
  console.error(
    "AI payment preview failed:",
    error instanceof Error ? error.message : error
  );

  process.exitCode = 1;
});
