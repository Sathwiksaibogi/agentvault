/**
 * Selected-vault Model A payment preview. NO signer, journal, Gemini or broadcast.
 * This intentionally does not reuse the single-owner demo's state.json.
 * Usage:
 *   AGENTVAULT_NETWORK=devnet pnpm exec tsx demo/preview-selected-vault-payment.ts \
 *      /absolute/path/agentvault-approval-<request-id>.json <expected-vault-address>
 */
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { strict as assert } from "node:assert";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  Connection,
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
import type { Agentvault } from "../target/types/agentvault";
import { NETWORK, RPC_URL } from "./runtime-config";
import {
  verifyWorkflowApproval,
  signedWorkflowSchema,
} from "./signed-workflow";
import { AGENT_WORKFLOWS } from "./workflow-policy";
import { assertPaymentInstructions } from "./payment-transaction-guard";

const PINNED_PROGRAM = "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d";

async function main() {
  assert.equal(NETWORK, "devnet", "This preview is Devnet only");
  assert.equal(
    process.argv.length,
    4,
    "Usage: preview-selected-vault-payment.ts <signed-approval-json> <expected-vault>"
  );
  const file = resolve(process.argv[2]);
  const expectedVault = new PublicKey(process.argv[3]);
  assert.equal(
    expectedVault.toBase58(),
    process.argv[3],
    "Noncanonical expected vault"
  );
  assert.ok(statSync(file).isFile(), "Approval must be a regular file");
  assert.ok(statSync(file).size < 32_768, "Approval file is too large");
  const signed = signedWorkflowSchema.parse(
    JSON.parse(readFileSync(file, "utf8"))
  );
  assert.equal(signed.workflow.network, "devnet");
  assert.equal(signed.workflow.programId, PINNED_PROGRAM);
  assert.equal(
    signed.workflow.vault,
    expectedVault.toBase58(),
    "Approval is for a different vault"
  );
  assert.equal(
    signed.workflow.kind,
    AGENT_WORKFLOWS[signed.workflow.assignedAgent],
    "Workflow category mismatch"
  );

  // No local state.json or hardcoded demo owner. Read ALL scope from live chain.
  const connection = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(
    readFileSync(resolve("target/idl/agentvault.json"), "utf8")
  ) as Agentvault;
  const program = new anchor.Program<Agentvault>(idl, { connection });
  assert.equal(
    program.programId.toBase58(),
    PINNED_PROGRAM,
    "IDL/program mismatch"
  );
  const [genesisHash, clockInfo, vault] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"),
    program.account.vault.fetch(expectedVault, "confirmed"),
  ]);
  assert.ok(clockInfo, "Solana clock unavailable");
  assert.ok(clockInfo.data.length >= 40, "Invalid Solana clock account");
  const chainTime = clockInfo.data.readBigInt64LE(32);
  const nowUnix = Number(chainTime);
  assert.ok(Number.isSafeInteger(nowUnix), "Invalid on-chain time");
  assert.equal(vault.paused, false, "Vault is paused");
  const mint = vault.tokenMint;
  const owner = vault.owner;
  const vaultId = vault.vaultId;
  const [derivedVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );
  assert.ok(derivedVault.equals(expectedVault), "Selected vault PDA mismatch");
  const workflow = verifyWorkflowApproval(
    signed,
    {
      network: "devnet",
      genesisHash,
      programId: PINNED_PROGRAM,
      vault: expectedVault.toBase58(),
      owner: owner.toBase58(),
      mint: mint.toBase58(),
    },
    nowUnix
  );

  const authority = new PublicKey(workflow.agentAuthority);
  const recipient = new PublicKey(workflow.recipient);
  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), expectedVault.toBuffer(), authority.toBuffer()],
    program.programId
  );
  const taskId = new BN(workflow.taskId);
  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      taskId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );
  const [agent, task] = await Promise.all([
    program.account.agent.fetch(agentPda, "confirmed"),
    program.account.task.fetch(taskPda, "confirmed"),
  ]);
  assert.equal(agent.active, true, "Agent deactivated");
  assert.equal(task.active, true, "Task revoked");
  assert.ok(
    agent.vault.equals(expectedVault) && agent.authority.equals(authority),
    "Agent ownership mismatch"
  );
  assert.ok(
    task.vault.equals(expectedVault) && task.agent.equals(agentPda),
    "Task ownership mismatch"
  );
  assert.ok(task.taskId.eq(taskId), "Task ID mismatch");
  assert.ok(
    task.recipient.equals(recipient),
    "Recipient differs from task allowlist"
  );
  assert.ok(BigInt(task.expiresAt.toString()) > chainTime, "Task expired");
  assert.ok(
    BigInt(workflow.expiresAtUnix) <= BigInt(task.expiresAt.toString()),
    "Approval expires after task"
  );
  assert.ok(task.spent.lte(task.budget), "Task accounting invalid");
  const amount = new BN(workflow.amountBaseUnits);
  assert.ok(
    amount.gt(new BN(0)) && amount.lte(task.budget.sub(task.spent)),
    "Insufficient remaining task budget"
  );
  assert.ok(
    amount.lte(vault.totalReserved),
    "Insufficient total vault reservation"
  );

  const treasury = getAssociatedTokenAddressSync(
    mint,
    expectedVault,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const treasuryAccount = await getAccount(
    connection,
    treasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  assert.ok(
    treasuryAccount.owner.equals(expectedVault),
    "Treasury authority mismatch"
  );
  assert.ok(treasuryAccount.mint.equals(mint), "Treasury mint mismatch");
  assert.ok(
    vault.totalReserved.lte(new BN(treasuryAccount.amount.toString())),
    "Treasury undercollateralized"
  );

  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const paymentIx = await program.methods
    .executeTaskPayment(amount, task.nextNonce)
    .accountsPartial({
      agentAuthority: authority,
      vault: expectedVault,
      agent: agentPda,
      task: taskPda,
      tokenMint: mint,
      treasury,
      recipient,
      recipientToken: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    authority,
    recipientAta,
    recipient,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: authority,
    recentBlockhash: blockhash,
  }).add(ataIx, paymentIx);
  assertPaymentInstructions(tx, {
    agentAuthority: authority,
    recipient,
    mint,
    paymentInstruction: paymentIx,
  });
  // Same unsigned simulation used by the existing Model A executor.
  const compiled = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: tx.instructions,
  }).compileToV0Message();
  const unsigned = new VersionedTransaction(compiled);
  const simulation = await connection.simulateTransaction(unsigned, {
    commitment: "confirmed",
    sigVerify: false,
  });
  if (simulation.value.err !== null) {
    console.error(simulation.value.logs?.join("\n") ?? "");
    throw new Error(
      `Payment simulation failed: ${JSON.stringify(simulation.value.err)}`
    );
  }
  console.log("\n=== SELECTED-VAULT PAYMENT PREVIEW PASSED ===");
  console.log("Request ID:", workflow.requestId);
  console.log("Vault:", expectedVault.toBase58());
  console.log("Owner:", owner.toBase58());
  console.log("Agent:", authority.toBase58());
  console.log("Task:", workflow.taskId, taskPda.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Amount (base units):", workflow.amountBaseUnits);
  console.log("Next nonce:", task.nextNonce.toString());
  console.log(
    "Simulation units:",
    simulation.value.unitsConsumed ?? "unavailable"
  );
  console.log(
    "No Gemini decision, private keys, journal claims, signed transactions or payments."
  );
}

main().catch((error) => {
  console.error(
    "PREVIEW BLOCKED:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
