import BN from "bn.js";
import bs58 from "bs58";

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { NETWORK, RUNTIME_DIR } from "./runtime-config";

import { evaluateApprovedWorkflow } from "./ai-workflow";

import {
  assertPaymentInstructions,
  assertExactAgentVaultPayment,
  assertSerializedAgentVaultPayment,
} from "./payment-transaction-guard";

import { verifyWorkflowApproval, type ApprovalScope } from "./signed-workflow";

import { claimApprovedWorkflow } from "./request-journal";

import { prepareSignedPayment, loadPreparedPayment } from "./prepared-payment";

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

async function main() {
  const requestId = process.argv[2];
  const mode = process.argv[3];

  assert.ok(
    requestId && REQUEST_ID_PATTERN.test(requestId),
    "Usage: execute-ai-workflow.ts <request-id> [--execute]"
  );

  assert.ok(
    mode === undefined || mode === "--execute",
    "Only --execute is supported"
  );

  const execute = mode === "--execute";

  if (execute) {
    assert.strictEqual(
      NETWORK,
      "devnet",
      "Real execution is restricted to Devnet"
    );

    assert.ok(
      process.stdin.isTTY,
      "Execution requires an interactive terminal"
    );
  }

  // Never silently reuse an already claimed request.
  const journalPath = join(RUNTIME_DIR, "journal", `${requestId}.json`);

  assert.ok(
    !existsSync(journalPath),
    "Request already claimed. Use payment recovery; do not execute again."
  );

  console.log("\n=== AGENTVAULT EXECUTION COORDINATOR ===");
  console.log("Network:", NETWORK);
  console.log("Request:", requestId);
  console.log("Mode:", execute ? "EXECUTION REQUESTED" : "PREVIEW ONLY");

  // 1. The existing validator performs:
  // - owner signature verification
  // - workflow routing checks
  // - on-chain agent and task checks
  // - Gemini proposal evaluation
  // - exact proposal amount validation
  const context = await evaluateApprovedWorkflow(requestId);

  const {
    connection,
    program,
    state,
    workflow,
    vaultPda,
    mint,
    treasury,
    agentPda,
    taskPda,
    recipient,
  } = context;

  const authority = new PublicKey(workflow.agentAuthority);

  const amount = new BN(workflow.amountBaseUnits);

  // 2. Re-read live policy state AFTER Gemini returns.
  // The state could have changed during model inference.
  const vault = await program.account.vault.fetch(vaultPda, "confirmed");

  const agent = await program.account.agent.fetch(agentPda, "confirmed");

  const task = await program.account.task.fetch(taskPda, "confirmed");

  assert.strictEqual(vault.paused, false);
  assert.strictEqual(agent.active, true);
  assert.strictEqual(task.active, true);

  assert.ok(vault.owner.equals(new PublicKey(workflow.owner)));

  assert.ok(vault.tokenMint.equals(mint));
  assert.ok(agent.vault.equals(vaultPda));
  assert.ok(agent.authority.equals(authority));

  assert.ok(task.vault.equals(vaultPda));
  assert.ok(task.agent.equals(agentPda));
  assert.ok(task.taskId.eq(new BN(workflow.taskId)));

  assert.ok(task.recipient.equals(recipient), "On-chain recipient changed");

  assert.ok(task.spent.lte(task.budget), "Invalid task accounting");

  assert.ok(
    amount.lte(task.budget.sub(task.spent)),
    "Insufficient remaining task budget"
  );

  assert.ok(amount.lte(vault.totalReserved), "Insufficient reserved funds");

  const treasuryAccount = await getAccount(
    connection,
    treasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  assert.ok(treasuryAccount.owner.equals(vaultPda));
  assert.ok(treasuryAccount.mint.equals(mint));

  assert.ok(
    vault.totalReserved.lte(new BN(treasuryAccount.amount.toString())),
    "Treasury reservation invariant violated"
  );

  // 3. Reverify the approval using Solana chain time.
  const signedApproval = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "approvals", `${requestId}.json`), "utf8")
  );

  const genesisHash = await connection.getGenesisHash();

  assert.strictEqual(genesisHash, state.genesisHash);

  const clock = await connection.getAccountInfo(
    SYSVAR_CLOCK_PUBKEY,
    "confirmed"
  );

  assert.ok(clock, "Solana clock unavailable");

  const nowUnix = Number(clock.data.readBigInt64LE(32));

  const scope: ApprovalScope = {
    network: NETWORK,
    genesisHash,
    programId: program.programId.toBase58(),
    vault: vaultPda.toBase58(),
    owner: workflow.owner,
    mint: mint.toBase58(),
  };

  const verifiedWorkflow = verifyWorkflowApproval(
    signedApproval,
    scope,
    nowUnix
  );

  assert.strictEqual(verifiedWorkflow.requestId, requestId);

  assert.ok(
    BigInt(task.expiresAt.toString()) > BigInt(nowUnix),
    "On-chain task expired"
  );

  assert.ok(
    BigInt(workflow.expiresAtUnix) <= BigInt(task.expiresAt.toString()),
    "Approval outlives the task"
  );

  // 4. Derive the only approved recipient ATA.
  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const nonce = task.nextNonce;

  const paymentInstruction = await program.methods
    .executeTaskPayment(amount, nonce)
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

  const ataInstruction = createAssociatedTokenAccountIdempotentInstruction(
    authority,
    recipientAta,
    recipient,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

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

  // 5. Verify all instruction addresses, data,
  // signer flags, writable flags and ordering.
  assertPaymentInstructions(transaction, expected);

  // 6. Simulate without loading signing keys.
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();

  const simulatedTransaction = new VersionedTransaction(message);

  const simulation = await connection.simulateTransaction(
    simulatedTransaction,
    {
      commitment: "confirmed",
      sigVerify: false,
    }
  );

  if (simulation.value.err !== null) {
    console.error(simulation.value.logs?.join("\n") ?? "");

    throw new Error(
      `Payment simulation failed: ${JSON.stringify(simulation.value.err)}`
    );
  }

  console.log("\n=== VERIFIED PAYMENT ===");
  console.log("Request:", requestId);
  console.log("Agent:", workflow.assignedAgent);
  console.log("Authority:", authority.toBase58());
  console.log("Task:", taskPda.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Amount:", amount.toString());
  console.log("Nonce:", nonce.toString());
  console.log("Instructions:", transaction.instructions.length);
  console.log(
    "Simulation compute units:",
    simulation.value.unitsConsumed ?? "Unavailable"
  );

  if (!execute) {
    console.log("\n=== SAFE PREVIEW COMPLETE ===");
    console.log("No private keys loaded.");
    console.log("No journal claimed.");
    console.log("No transaction signed or broadcast.");
    return;
  }

  // 7. Explicit human authorization before accessing
  // the agent's private key.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let answer: string;

  try {
    answer = await rl.question(
      `\nType EXECUTE ${requestId} to submit the Devnet payment: `
    );
  } finally {
    rl.close();
  }

  assert.strictEqual(
    answer.trim(),
    `EXECUTE ${requestId}`,
    "Execution cancelled"
  );

  // 8. Recheck the most important live conditions
  // after the human confirmation.
  const refreshedTask = await program.account.task.fetch(taskPda, "confirmed");

  const refreshedAgent = await program.account.agent.fetch(
    agentPda,
    "confirmed"
  );

  const refreshedVault = await program.account.vault.fetch(
    vaultPda,
    "confirmed"
  );

  assert.strictEqual(refreshedTask.active, true);
  assert.strictEqual(refreshedAgent.active, true);
  assert.strictEqual(refreshedVault.paused, false);

  assert.ok(
    refreshedTask.nextNonce.eq(nonce),
    "Task nonce changed since preview"
  );

  assert.ok(refreshedTask.spent.lte(refreshedTask.budget));

  assert.ok(
    amount.lte(refreshedTask.budget.sub(refreshedTask.spent)),
    "Task budget changed"
  );

  assert.ok(amount.lte(refreshedVault.totalReserved), "Reserved funds changed");

  const latestClock = await connection.getAccountInfo(
    SYSVAR_CLOCK_PUBKEY,
    "confirmed"
  );

  assert.ok(latestClock);

  const latestUnix = Number(latestClock.data.readBigInt64LE(32));

  verifyWorkflowApproval(signedApproval, scope, latestUnix);

  assert.ok(
    BigInt(refreshedTask.expiresAt.toString()) > BigInt(latestUnix),
    "Task expired before execution"
  );

  const currentBlockHeight = await connection.getBlockHeight("confirmed");

  assert.ok(
    currentBlockHeight <= lastValidBlockHeight,
    "Blockhash expired. Run a fresh preview."
  );

  // 9. Only now load the assigned agent keypair.
  // The owner's private key is never loaded here.
  const agentKeyFile = join(RUNTIME_DIR, `${workflow.assignedAgent}.json`);

  const secretKey = JSON.parse(readFileSync(agentKeyFile, "utf8")) as number[];

  const agentSigner = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  assert.ok(
    agentSigner.publicKey.equals(authority),
    "Agent keypair does not match approved authority"
  );

  // 10. Atomically claim the request BEFORE any
  // transaction is broadcast.
  claimApprovedWorkflow(RUNTIME_DIR, signedApproval, scope, latestUnix);

  // From this point onward, failures must leave
  // the request locked for explicit investigation.

  // 11. Sign with the independent agent identity.
  transaction.sign(agentSigner);

  assertExactAgentVaultPayment(transaction, expected);

  // 12. Durably persist the exact signed transaction.
  prepareSignedPayment(
    RUNTIME_DIR,
    requestId,
    workflow.assignedAgent,
    authority,
    taskPda,
    workflow.amountBaseUnits,
    nonce.toString(),
    lastValidBlockHeight,
    transaction
  );

  // 13. Restore the saved bytes and verify again.
  const prepared = loadPreparedPayment(RUNTIME_DIR, requestId);

  assertSerializedAgentVaultPayment(prepared.transaction, expected);
  assert.strictEqual(
    prepared.record.lastValidBlockHeight,
    lastValidBlockHeight
  );

  assert.strictEqual(prepared.record.taskPda, taskPda.toBase58());

  assert.strictEqual(prepared.record.nonce, nonce.toString());

  const signature = bs58.encode(prepared.transaction.signature!);

  console.log("\n=== PAYMENT DURABLY PREPARED ===");
  console.log("Request:", requestId);
  console.log("Signature:", signature);
  console.log("Agent signer:", authority.toBase58());

  // 14. Simulate the exact saved signed bytes.
  // If this fails, the claim remains locked.
  const finalSimulation = await connection.simulateTransaction(
    VersionedTransaction.deserialize(prepared.raw),
    {
      commitment: "confirmed",
      sigVerify: true,
    }
  );

  if (finalSimulation.value.err !== null) {
    console.error(finalSimulation.value.logs?.join("\n") ?? "");

    throw new Error(
      "Saved signed transaction failed simulation; request remains locked"
    );
  }

  // 15. Broadcast ONLY the stored transaction bytes.
  // An RPC error is potentially an uncertain outcome.
  // Never construct a replacement automatically.
  const returnedSignature = await connection.sendRawTransaction(prepared.raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 2,
  });

  assert.strictEqual(
    returnedSignature,
    signature,
    "Broadcast signature mismatch"
  );

  console.log("\n=== PAYMENT BROADCAST ===");
  console.log("Signature:", signature);
  console.log(
    "Explorer:",
    `https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );

  // 16. Wait for confirmation.
  // Errors or timeouts do not release the journal.
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed"
  );

  assert.strictEqual(
    confirmation.value.err,
    null,
    "Payment transaction failed on-chain"
  );

  console.log("\n=== AI PAYMENT CONFIRMED ===");
  console.log("Owner approval: VERIFIED");
  console.log("Gemini proposal: ACCEPTED");
  console.log("Security policies: VERIFIED");
  console.log("Agent signature: VERIFIED");
  console.log("Payment: CONFIRMED");
  console.log("Request remains journaled.");
}

main().catch((error) => {
  console.error(
    "\nEXECUTOR STOPPED:",
    error instanceof Error ? error.message : error
  );

  console.error(
    "If a request journal exists, do not delete it or rerun execution."
  );

  console.error("Inspect the original payment with the recovery CLI.");

  process.exitCode = 1;
});
