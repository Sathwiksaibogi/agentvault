import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Agentvault } from "../target/types/agentvault";
import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";
import { MAX_PAYMENT_AMOUNT, type AgentId } from "./workflow-policy";

// Public addresses only. Never store signing secrets here.
const AGENT_AUTHORITIES = {
  localnet: {
    "agent-a": "3WTKm7Bf4xRT9ZAkP8C3TVfrEHAYWSrzH3nsmb6VdukE",
    "agent-b": "FwfrNRLJF2L2fGvGrLocEmccs5nQEnBWQbkSRDRQbRei",
  },
  devnet: {
    "agent-a": "24y99x9EPoJ2ToqygjM37eU9AXz3aFwiDcHFv87LXQfQ",
    "agent-b": "5qHQ9f5E6vQ91JhrDRbbBLpSFudzRBGNdvpXkT1iDLxT",
  },
} as const;

type DemoState = {
  genesisHash: string;
  programId: string;
  owner: string;
  vaultId: string;
  mint: string;
  vault: string;
  treasury: string;
};

async function main() {
  const agentName = process.argv[2];
  const amountText = process.argv[3];

  assert.ok(
    agentName === "agent-a" || agentName === "agent-b",
    "Usage: onchain-preflight.ts <agent-a|agent-b> <amount>"
  );

  assert.ok(
    amountText && /^[0-9]+$/.test(amountText),
    "Amount must be a positive integer"
  );

  const amountNumber = Number(amountText);

  assert.ok(
    Number.isSafeInteger(amountNumber) && amountNumber > 0,
    "Invalid payment amount"
  );

  assert.ok(
    amountNumber <= MAX_PAYMENT_AMOUNT,
    "Payment exceeds application-level cap"
  );

  const amount = new BN(amountNumber);
  const selectedAgent: AgentId = agentName;

  // READ-ONLY connection: no wallet or private keys.
  const connection = new Connection(RPC_URL, "confirmed");

  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  ) as DemoState;

  assert.strictEqual(
    await connection.getGenesisHash(),
    state.genesisHash,
    "Runtime state belongs to a different ledger"
  );

  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;

  const program = new anchor.Program<Agentvault>(idl, { connection });

  assert.strictEqual(
    program.programId.toBase58(),
    state.programId,
    "Unexpected program ID"
  );

  const owner = new PublicKey(state.owner);
  const mint = new PublicKey(state.mint);
  const vaultPda = new PublicKey(state.vault);
  const treasury = new PublicKey(state.treasury);

  // 1. Independently verify Vault PDA derivation.
  const vaultId = new BN(state.vaultId);

  const [expectedVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  assert.ok(expectedVault.equals(vaultPda), "Invalid Vault PDA");

  // 2. Derive Agent PDA from the approved demo identity.
  const authority = new PublicKey(AGENT_AUTHORITIES[NETWORK][selectedAgent]);

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultPda.toBuffer(), authority.toBuffer()],
    program.programId
  );

  // 3. Derive Task 1 PDA.
  const taskId = new BN(1);

  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      taskId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  // 4. Read actual Solana program accounts.
  // Anchor verifies their account discriminators and owner.
  const vault = await program.account.vault.fetch(vaultPda, "confirmed");

  const agent = await program.account.agent.fetch(agentPda, "confirmed");

  const task = await program.account.task.fetch(taskPda, "confirmed");

  // 5. Verify account relationships and identities.
  assert.ok(vault.owner.equals(owner));
  assert.ok(vault.tokenMint.equals(mint));
  assert.ok(vault.vaultId.eq(vaultId));

  assert.ok(agent.vault.equals(vaultPda));
  assert.ok(agent.authority.equals(authority));

  assert.ok(task.vault.equals(vaultPda));
  assert.ok(task.agent.equals(agentPda));
  assert.ok(task.taskId.eq(taskId));

  // 6. Verify active status.
  assert.strictEqual(vault.paused, false, "Vault paused");
  assert.strictEqual(agent.active, true, "Agent inactive");
  assert.strictEqual(task.active, true, "Task inactive");

  // 7. Compare expiry against the Solana Clock sysvar.
  const clockAccount = await connection.getAccountInfo(
    SYSVAR_CLOCK_PUBKEY,
    "confirmed"
  );

  assert.ok(clockAccount, "Cannot read Solana clock");

  // Clock layout: unix_timestamp is an i64 at byte 32.
  const chainTime = clockAccount.data.readBigInt64LE(32);

  assert.ok(BigInt(task.expiresAt.toString()) > chainTime, "Task has expired");

  // 8. Independently verify canonical treasury ATA.
  const expectedTreasury = getAssociatedTokenAddressSync(
    mint,
    vaultPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  assert.ok(treasury.equals(expectedTreasury), "Treasury ATA mismatch");

  const treasuryAccount = await getAccount(
    connection,
    treasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );

  assert.ok(
    treasuryAccount.owner.equals(vaultPda),
    "Treasury must be controlled by Vault PDA"
  );

  assert.ok(treasuryAccount.mint.equals(mint), "Treasury token mint mismatch");

  // 9. Verify task allocation and global reservation.
  assert.ok(task.spent.lte(task.budget), "Task accounting inconsistent");

  const remaining = task.budget.sub(task.spent);

  assert.ok(
    amount.lte(remaining),
    "Requested amount exceeds remaining task budget"
  );

  assert.ok(
    amount.lte(vault.totalReserved),
    "Requested amount exceeds reserved funds"
  );

  assert.ok(
    vault.totalReserved.lte(new BN(treasuryAccount.amount.toString())),
    "Reserved funds exceed treasury balance"
  );

  console.log("\n=== ON-CHAIN PREFLIGHT ===");
  console.log("Network:", NETWORK);
  console.log("Program:", program.programId.toBase58());
  console.log("Agent:", selectedAgent);
  console.log("Authority:", authority.toBase58());
  console.log("Agent PDA:", agentPda.toBase58());
  console.log("Task PDA:", taskPda.toBase58());
  console.log("Approved recipient:", task.recipient.toBase58());
  console.log("Task budget:", task.budget.toString());
  console.log("Previously spent:", task.spent.toString());
  console.log("Remaining budget:", remaining.toString());
  console.log("Next on-chain nonce:", task.nextNonce.toString());
  console.log("Treasury balance:", treasuryAccount.amount.toString());
  console.log("Vault reserved:", vault.totalReserved.toString());
  console.log("Requested amount:", amount.toString());

  console.log("\nON-CHAIN PREFLIGHT: PASSED");
  console.log("Mode: READ ONLY");
  console.log("No transaction was submitted.");
  console.log(
    "Workflow authorization and duplicate-request checks are still required."
  );
}

main().catch((error) => {
  console.error(
    "\nON-CHAIN PREFLIGHT: BLOCKED",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
