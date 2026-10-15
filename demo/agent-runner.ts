import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Agentvault } from "../target/types/agentvault";

const RPC_URL = "http://127.0.0.1:8899";
const LOCAL_DIR = join(process.cwd(), "demo/local");

// Usage:
// pnpm exec tsx demo/agent-runner.ts agent-a 40000
// pnpm exec tsx demo/agent-runner.ts agent-b 30000

async function main() {
  const agentName = process.argv[2];
  const amountText = process.argv[3];

  assert.ok(
    agentName === "agent-a" || agentName === "agent-b",
    "Usage: agent-runner.ts <agent-a|agent-b> <amount>"
  );

  assert.ok(
    amountText && /^[0-9]+$/.test(amountText),
    "Amount must be a positive integer in token base units"
  );

  const amount = new BN(amountText);

  assert.ok(amount.gt(new BN(0)), "Amount must exceed zero");

  // 1. Connect directly to the validator.
  const connection = new Connection(RPC_URL, "confirmed");

  // 2. Read public bootstrap configuration.
  const state = JSON.parse(readFileSync(join(LOCAL_DIR, "state.json"), "utf8"));

  assert.strictEqual(
    await connection.getGenesisHash(),
    state.genesisHash,
    "Wrong validator ledger"
  );

  // 3. Load ONLY the selected agent's private key.
  // The Vault owner's keypair is never loaded.
  const secretKey = JSON.parse(
    readFileSync(join(LOCAL_DIR, `${agentName}.json`), "utf8")
  ) as number[];

  const agentKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  // 4. Load the Anchor program without an owner wallet.
  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;

  const program = new anchor.Program<Agentvault>(idl, { connection });

  assert.strictEqual(program.programId.toBase58(), state.programId);

  const vaultPda = new PublicKey(state.vault);
  const mint = new PublicKey(state.mint);
  const treasury = new PublicKey(state.treasury);

  // 5. Derive the agent identity and Task 1.
  const [agentPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("agent"),
      vaultPda.toBuffer(),
      agentKeypair.publicKey.toBuffer(),
    ],
    program.programId
  );

  const taskId = new BN(1);

  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      taskId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  // 6. Fetch the actual on-chain policies.
  const vault = await program.account.vault.fetch(vaultPda, "processed");

  const agent = await program.account.agent.fetch(agentPda, "processed");

  const task = await program.account.task.fetch(taskPda, "processed");

  assert.ok(vault.tokenMint.equals(mint), "Incorrect token mint");

  assert.ok(
    agent.authority.equals(agentKeypair.publicKey),
    "Agent authority mismatch"
  );

  assert.ok(agent.vault.equals(vaultPda));
  assert.ok(task.vault.equals(vaultPda));
  assert.ok(task.agent.equals(agentPda));

  assert.strictEqual(vault.paused, false);
  assert.strictEqual(agent.active, true);
  assert.strictEqual(task.active, true);

  // 7. Read the approved recipient from the task.
  // The caller cannot choose an arbitrary recipient.
  const recipient = task.recipient;

  const canonicalTreasury = getAssociatedTokenAddressSync(
    mint,
    vaultPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  assert.ok(treasury.equals(canonicalTreasury), "Treasury address mismatch");

  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // 8. Validate the remaining allocation before submission.
  // The Rust program independently repeats policy checks.
  const remaining = task.budget.sub(task.spent);

  assert.ok(
    amount.lte(remaining),
    `Payment exceeds remaining task budget ${remaining.toString()}`
  );

  // 9. Read the latest on-chain nonce.
  const nonce = task.nextNonce;

  // 10. Verify the agent has SOL for fees and ATA rent.
  const agentSol = await connection.getBalance(
    agentKeypair.publicKey,
    "processed"
  );

  assert.ok(
    agentSol > 10_000_000,
    "Agent needs local SOL for fees and ATA rent"
  );

  // 11. Snapshot token balances and accounting.
  const treasuryBefore = await getAccount(
    connection,
    treasury,
    "processed",
    TOKEN_PROGRAM_ID
  );

  const recipientInfo = await connection.getAccountInfo(
    recipientAta,
    "processed"
  );

  const recipientBefore = recipientInfo
    ? new BN(
        (
          await getAccount(
            connection,
            recipientAta,
            "processed",
            TOKEN_PROGRAM_ID
          )
        ).amount.toString()
      )
    : new BN(0);

  // 12. Build the program payment instruction.
  const paymentInstruction = await program.methods
    .executeTaskPayment(amount, nonce)
    .accountsPartial({
      agentAuthority: agentKeypair.publicKey,
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

  // 13. Create the recipient ATA if needed.
  // The idempotent instruction is safe to include
  // even if the ATA already exists.
  const createRecipientAta = createAssociatedTokenAccountIdempotentInstruction(
    agentKeypair.publicKey,
    recipientAta,
    recipient,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // 14. Construct one atomic transaction.
  const transaction = new Transaction().add(
    createRecipientAta,
    paymentInstruction
  );

  // Agent is the fee payer. Not the Vault owner.
  transaction.feePayer = agentKeypair.publicKey;

  console.log("\n=== AGENT PAYMENT REQUEST ===");
  console.log("Agent:", agentName);
  console.log("Authority:", agentKeypair.publicKey.toBase58());
  console.log("Task:", taskPda.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Amount:", amount.toString());
  console.log("Nonce:", nonce.toString());
  console.log("Remaining before:", remaining.toString());

  // 15. Sign and submit with ONLY the agent keypair.
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [agentKeypair],
    {
      commitment: "confirmed",
      preflightCommitment: "processed",
    }
  );

  // 16. Read results after confirmation.
  const taskAfter = await program.account.task.fetch(taskPda, "processed");

  const vaultAfter = await program.account.vault.fetch(vaultPda, "processed");

  const treasuryAfter = await getAccount(
    connection,
    treasury,
    "processed",
    TOKEN_PROGRAM_ID
  );

  const recipientAfter = await getAccount(
    connection,
    recipientAta,
    "processed",
    TOKEN_PROGRAM_ID
  );

  // 17. Verify payment accounting.
  assert.ok(taskAfter.spent.eq(task.spent.add(amount)));

  assert.ok(taskAfter.nextNonce.eq(nonce.add(new BN(1))));

  assert.ok(vaultAfter.totalReserved.eq(vault.totalReserved.sub(amount)));

  assert.ok(
    new BN(treasuryAfter.amount.toString()).eq(
      new BN(treasuryBefore.amount.toString()).sub(amount)
    )
  );

  assert.ok(
    new BN(recipientAfter.amount.toString()).eq(recipientBefore.add(amount))
  );

  console.log("\n=== PAYMENT CONFIRMED ===");
  console.log("Signature:", signature);
  console.log("Fee payer:", agentKeypair.publicKey.toBase58());
  console.log("Spent:", taskAfter.spent.toString());
  console.log("Next nonce:", taskAfter.nextNonce.toString());
  console.log("Treasury balance:", treasuryAfter.amount.toString());
  console.log("Vault reserved:", vaultAfter.totalReserved.toString());
  console.log("Recipient balance:", recipientAfter.amount.toString());
}

main().catch((error) => {
  console.error("Agent payment failed:", error);
  process.exitCode = 1;
});
