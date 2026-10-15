import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import * as nacl from "tweetnacl";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Agentvault } from "../target/types/agentvault";
import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";
import {
  AGENT_WORKFLOWS,
  MAX_PAYMENT_AMOUNT,
  type AgentId,
} from "./workflow-policy";
import {
  encodeWorkflow,
  verifyWorkflowApproval,
  workflowApprovalSchema,
  type ApprovalScope,
} from "./signed-workflow";

// Public keys only. These are our existing demo agents.
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

const APPROVAL_DIR = join(RUNTIME_DIR, "approvals");
const TASK_ID = new BN(1);

async function main() {
  const agentName = process.argv[2];
  const requestId = process.argv[3];
  const amountText = process.argv[4];
  const description = process.argv.slice(5).join(" ").trim();

  assert.ok(
    agentName === "agent-a" || agentName === "agent-b",
    "Choose agent-a or agent-b"
  );

  assert.ok(
    requestId && /^[a-zA-Z0-9_-]{8,64}$/.test(requestId),
    "Invalid request ID"
  );

  assert.ok(
    amountText && /^[0-9]+$/.test(amountText),
    "Amount must be a positive integer"
  );

  const amount = Number(amountText);

  assert.ok(
    Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_PAYMENT_AMOUNT,
    "Invalid amount or payment cap exceeded"
  );

  assert.ok(
    description.length >= 8 && description.length <= 300,
    "Description must contain 8–300 characters"
  );

  // Owner approval is deliberately restricted to
  // interactive terminal sessions.
  assert.ok(
    process.stdin.isTTY,
    "Owner approval requires an interactive terminal"
  );

  const selectedAgent: AgentId = agentName;

  mkdirSync(APPROVAL_DIR, {
    recursive: true,
    mode: 0o700,
  });

  const approvalPath = join(APPROVAL_DIR, `${requestId}.json`);

  assert.ok(
    !existsSync(approvalPath),
    "An approval file already exists for this request ID"
  );

  // 1. Connect to the selected network without a wallet.
  const connection = new Connection(RPC_URL, "confirmed");

  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  );

  assert.strictEqual(
    await connection.getGenesisHash(),
    state.genesisHash,
    "Wrong network state"
  );

  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;

  const program = new anchor.Program<Agentvault>(idl, { connection });

  assert.strictEqual(
    program.programId.toBase58(),
    "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
  );

  assert.strictEqual(program.programId.toBase58(), state.programId);

  const owner = new PublicKey(state.owner);
  const mint = new PublicKey(state.mint);
  const vaultPda = new PublicKey(state.vault);
  const treasury = new PublicKey(state.treasury);
  const vaultId = new BN(state.vaultId);

  // 2. Derive the Vault PDA independently.
  const [expectedVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  assert.ok(expectedVault.equals(vaultPda), "Vault PDA mismatch");

  // 3. Derive the registered agent and task.
  const agentAuthority = new PublicKey(
    AGENT_AUTHORITIES[NETWORK][selectedAgent]
  );

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultPda.toBuffer(), agentAuthority.toBuffer()],
    program.programId
  );

  const [taskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("task"),
      agentPda.toBuffer(),
      TASK_ID.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  // 4. Read and validate real on-chain accounts.
  const vault = await program.account.vault.fetch(vaultPda, "confirmed");

  const agent = await program.account.agent.fetch(agentPda, "confirmed");

  const task = await program.account.task.fetch(taskPda, "confirmed");

  assert.ok(vault.owner.equals(owner));
  assert.ok(vault.tokenMint.equals(mint));
  assert.ok(vault.vaultId.eq(vaultId));
  assert.strictEqual(vault.paused, false);

  assert.ok(agent.vault.equals(vaultPda));
  assert.ok(agent.authority.equals(agentAuthority));
  assert.strictEqual(agent.active, true);

  assert.ok(task.vault.equals(vaultPda));
  assert.ok(task.agent.equals(agentPda));
  assert.ok(task.taskId.eq(TASK_ID));
  assert.strictEqual(task.active, true);

  assert.ok(task.spent.lte(task.budget), "Task accounting is inconsistent");

  const remaining = task.budget.sub(task.spent);

  assert.ok(
    new BN(amount).lte(remaining),
    "Workflow exceeds remaining task budget"
  );

  // 5. Verify the actual Vault-controlled treasury.
  const expectedTreasury = getAssociatedTokenAddressSync(
    mint,
    vaultPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  assert.ok(expectedTreasury.equals(treasury), "Treasury address mismatch");

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

  assert.ok(
    new BN(amount).lte(vault.totalReserved),
    "Amount exceeds reserved funds"
  );

  // 6. Read Solana's clock for approval expiry.
  const clock = await connection.getAccountInfo(
    SYSVAR_CLOCK_PUBKEY,
    "confirmed"
  );

  assert.ok(clock);

  const nowUnix = Number(clock.data.readBigInt64LE(32));

  assert.ok(Number.isSafeInteger(nowUnix));

  const taskExpiry = Number(task.expiresAt.toString());

  assert.ok(taskExpiry > nowUnix, "Task has already expired");

  // Approval is valid for at most 48 hours,
  // and cannot outlive the on-chain task.
  const expiresAtUnix = Math.min(nowUnix + 48 * 60 * 60, taskExpiry);

  assert.ok(
    expiresAtUnix > nowUnix + 60,
    "Insufficient approval validity period"
  );

  // 7. Construct the exact approval payload.
  const workflow = workflowApprovalSchema.parse({
    version: 1,
    network: NETWORK,
    requestId,
    genesisHash: state.genesisHash,
    programId: program.programId.toBase58(),
    vault: vaultPda.toBase58(),
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: selectedAgent,
    agentAuthority: agentAuthority.toBase58(),
    kind: AGENT_WORKFLOWS[selectedAgent],
    taskId: TASK_ID.toNumber(),
    recipient: task.recipient.toBase58(),
    amountBaseUnits: amount,
    expiresAtUnix,
    description,
  });

  // 8. Display the authorization details.
  console.log("\n=== OWNER WORKFLOW APPROVAL ===");
  console.log("Network:", NETWORK);
  console.log("Request ID:", workflow.requestId);
  console.log("Owner:", workflow.owner);
  console.log("Vault:", workflow.vault);
  console.log("Agent:", workflow.assignedAgent);
  console.log("Agent authority:", workflow.agentAuthority);
  console.log("Workflow:", workflow.kind);
  console.log("Task ID:", workflow.taskId);
  console.log("Recipient:", workflow.recipient);
  console.log("Amount (base units):", workflow.amountBaseUnits);
  console.log("Purpose:", workflow.description);
  console.log("Expires:", new Date(expiresAtUnix * 1000).toISOString());
  console.log("Remaining task budget:", remaining.toString());

  console.log("\nThis signature authorizes the specified workflow.");
  console.log("It does not submit a payment.");

  // 9. Require explicit human approval.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let answer: string;

  try {
    answer = await rl.question(`\nType APPROVE ${requestId} to sign: `);
  } finally {
    rl.close();
  }

  assert.strictEqual(
    answer.trim(),
    `APPROVE ${requestId}`,
    "Owner declined approval"
  );

  // 10. Load the owner key ONLY after confirmation.
  const ownerKeyPath =
    process.env.AGENTVAULT_OWNER_KEYPAIR ??
    join(homedir(), ".config/solana/id.json");

  const secretKey = JSON.parse(readFileSync(ownerKeyPath, "utf8")) as number[];

  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  assert.ok(
    ownerKeypair.publicKey.equals(owner),
    "Signing wallet is not the Vault owner"
  );

  // 11. Produce an Ed25519 signature.
  const signature = nacl.sign.detached(
    encodeWorkflow(workflow),
    ownerKeypair.secretKey
  );

  const signed = {
    workflow,
    signature: Buffer.from(signature).toString("base64"),
  };

  // 12. Verify the signature before writing.
  const scope: ApprovalScope = {
    network: workflow.network,
    genesisHash: state.genesisHash,
    programId: program.programId.toBase58(),
    vault: vaultPda.toBase58(),
    owner: owner.toBase58(),
    mint: mint.toBase58(),
  };

  const verified = verifyWorkflowApproval(signed, scope, nowUnix);

  assert.strictEqual(verified.requestId, requestId);

  // 13. Write the signed approval privately.
  // 'wx' prevents accidental overwrite.
  writeFileSync(approvalPath, JSON.stringify(signed, null, 2), {
    flag: "wx",
    mode: 0o600,
  });

  console.log("\n=== WORKFLOW APPROVED ===");
  console.log("Signature verified: YES");
  console.log("Request ID:", requestId);
  console.log("Saved:", approvalPath);
  console.log("NO PAYMENT SUBMITTED");
}

main().catch((error) => {
  console.error(
    "Owner approval failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
