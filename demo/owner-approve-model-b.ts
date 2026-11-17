import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

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
  getMint,
} from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";

import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

import {
  AGENT_WORKFLOWS,
  MAX_PAYMENT_AMOUNT,
  type AgentId,
} from "./workflow-policy";

import { workflowApprovalV2Schema } from "./signed-workflow-v2";

import { paymentApprovalV2Schema } from "./payment-approval-v2";

import type { ModelBWorkflowBinding } from "./model-b-workflow-binding";
import {
  assertModelBOwnerPolicy,
  assertUnchangedModelBOwnerPolicy,
  type ModelBOwnerPolicySnapshot,
} from "./model-b-owner-policy";

import {
  signModelBOwnerApprovalPackage,
  saveModelBOwnerApprovalPackage,
  loadModelBOwnerApprovalPackage,
} from "./model-b-owner-approval";

const PROGRAM_ID = "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d";

const OWNER_ID = "J2GL63eJnVsmJipKkFiaLvwrdSiGnfj5ESpa1HcJXS2G";

// Match the registered authorities in the existing demo.
// Do not accept an agent authority from an AI response.
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

type BindingContext = Omit<
  ModelBWorkflowBinding,
  "signedWorkflow" | "paymentApproval" | "signatureBase64"
>;

function readOwnerKeypair(owner: PublicKey): Keypair {
  const path =
    process.env.AGENTVAULT_OWNER_KEYPAIR ??
    join(homedir(), ".config/solana/id.json");

  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];

  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));

  assert.ok(
    keypair.publicKey.equals(owner),
    "Owner keypair does not match the Vault owner"
  );

  return keypair;
}

async function main(): Promise<void> {
  const [agentInput, taskIdInput, requestId, amountInput, ...descriptionParts] =
    process.argv.slice(2);

  const description = descriptionParts.join(" ").trim();

  assert.ok(
    agentInput === "agent-a" || agentInput === "agent-b",
    "Choose agent-a or agent-b"
  );

  const selectedAgent: AgentId = agentInput;

  assert.match(requestId ?? "", /^[a-zA-Z0-9_-]{8,64}$/, "Invalid request ID");

  assert.match(taskIdInput ?? "", /^(0|[1-9][0-9]*)$/, "Invalid task ID");

  const taskIdNumber = Number(taskIdInput);

  assert.ok(
    Number.isSafeInteger(taskIdNumber) && taskIdNumber >= 0,
    "Task ID must be a safe nonnegative integer"
  );

  assert.match(
    amountInput ?? "",
    /^[0-9]+$/,
    "Amount must be a positive integer"
  );

  const amount = Number(amountInput);

  assert.ok(
    Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_PAYMENT_AMOUNT,
    "Invalid amount or payment cap exceeded"
  );

  assert.ok(
    description.length >= 8 && description.length <= 300,
    "Description must contain 8–300 characters"
  );

  assert.ok(
    process.stdin.isTTY,
    "Model B owner approval requires an interactive terminal"
  );

  // Refuse to reuse an existing request ID, irrespective
  // of authorization model. The persistence layer checks
  // these paths again when saving.
  const workflowPath = join(RUNTIME_DIR, "approvals", `${requestId}.json`);

  const paymentPath = join(
    RUNTIME_DIR,
    "approvals",
    `${requestId}.payment.json`
  );

  const journalPath = join(RUNTIME_DIR, "journal", `${requestId}.json`);

  assert.ok(
    !existsSync(workflowPath) &&
      !existsSync(paymentPath) &&
      !existsSync(journalPath),
    "Request ID already exists"
  );

  // --------------------------------------------------
  // 1. Pin the deployed program, owner and chain.
  // --------------------------------------------------

  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  ) as DemoState;

  assert.equal(state.programId, PROGRAM_ID);
  assert.equal(state.owner, OWNER_ID);

  const connection = new Connection(RPC_URL, "confirmed");

  assert.equal(
    await connection.getGenesisHash(),
    state.genesisHash,
    "RPC ledger does not match runtime state"
  );

  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;

  const program = new anchor.Program<Agentvault>(idl, { connection });

  assert.equal(program.programId.toBase58(), PROGRAM_ID);

  const owner = new PublicKey(state.owner);
  const vaultPda = new PublicKey(state.vault);
  const mint = new PublicKey(state.mint);
  const treasury = new PublicKey(state.treasury);
  const vaultId = new BN(state.vaultId);
  const taskId = new BN(taskIdNumber);

  const authority = new PublicKey(AGENT_AUTHORITIES[NETWORK][selectedAgent]);

  const [expectedVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  assert.ok(expectedVault.equals(vaultPda), "Vault PDA mismatch");

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultPda.toBuffer(), authority.toBuffer()],
    program.programId
  );

  const [approvedTaskPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("approved-task"),
      agentPda.toBuffer(),
      taskId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );

  const expectedTreasury = getAssociatedTokenAddressSync(
    mint,
    vaultPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  assert.ok(treasury.equals(expectedTreasury), "Treasury ATA mismatch");

  // --------------------------------------------------
  // 2. Independently inspect all live payment policy.
  // Called twice: before and after owner confirmation.
  // --------------------------------------------------

  async function inspectLivePolicy(): Promise<ModelBOwnerPolicySnapshot> {
    assert.equal(
      await connection.getGenesisHash(),
      state.genesisHash,
      "RPC ledger changed"
    );

    const [vault, agent, approvedTask, clockAccount, treasuryAccount] =
      await Promise.all([
        program.account.vault.fetch(vaultPda, "confirmed"),
        program.account.agent.fetch(agentPda, "confirmed"),
        program.account.approvedTask.fetch(approvedTaskPda, "confirmed"),
        connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"),
        getAccount(connection, treasury, "confirmed", TOKEN_PROGRAM_ID),
      ]);

    assert.ok(clockAccount, "Solana clock is unavailable");

    // Verify the mint is owned by the classic SPL token program.
    await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);

    // Independently validate every live account relationship,
    // expiry, nonce, budget, reservation and treasury invariant.
    return assertModelBOwnerPolicy({
      expected: {
        owner: owner.toBase58(),
        vault: vaultPda.toBase58(),
        vaultId: vaultId.toString(),
        mint: mint.toBase58(),
        agentPda: agentPda.toBase58(),
        agentAuthority: authority.toBase58(),
        taskId: taskId.toString(),
        genesisHash: state.genesisHash,
      },
      amountBaseUnits: amount,
      chainTime: clockAccount.data.readBigInt64LE(32).toString(),
      vault: {
        owner: vault.owner.toBase58(),
        tokenMint: vault.tokenMint.toBase58(),
        vaultId: vault.vaultId.toString(),
        paused: vault.paused,
        totalReserved: vault.totalReserved.toString(),
      },
      agent: {
        vault: agent.vault.toBase58(),
        authority: agent.authority.toBase58(),
        active: agent.active,
      },
      approvedTask: {
        vault: approvedTask.vault.toBase58(),
        agent: approvedTask.agent.toBase58(),
        taskId: approvedTask.taskId.toString(),
        recipient: approvedTask.recipient.toBase58(),
        budget: approvedTask.budget.toString(),
        spent: approvedTask.spent.toString(),
        expiresAt: approvedTask.expiresAt.toString(),
        nextNonce: approvedTask.nextNonce.toString(),
        genesisHash: approvedTask.genesisHash.toBase58(),
        active: approvedTask.active,
      },
      treasury: {
        owner: treasuryAccount.owner.toBase58(),
        mint: treasuryAccount.mint.toBase58(),
        amount: treasuryAccount.amount.toString(),
      },
    });
  }

  const before = await inspectLivePolicy();

  // --------------------------------------------------
  // 3. Show exact authorization intent to the owner.
  // --------------------------------------------------

  console.log("\n=== AGENTVAULT MODEL B APPROVAL ===");
  console.log("Network:", NETWORK);
  console.log("Request ID:", requestId);
  console.log("Authorization: Model B / PER-PAYMENT");
  console.log("Owner:", owner.toBase58());
  console.log("Agent:", selectedAgent);
  console.log("Agent authority:", authority.toBase58());
  console.log("Vault:", vaultPda.toBase58());
  console.log("ApprovedTask:", approvedTaskPda.toBase58());
  console.log("Task ID:", taskId.toString());
  console.log("Recipient:", before.recipient);
  console.log("Amount (base units):", amount);
  console.log("Nonce:", before.nextNonce);
  console.log("Task expiry:", before.taskExpiresAtUnix);
  console.log("Remaining budget:", before.remaining);
  console.log("Treasury balance:", before.treasuryBalance);
  console.log("Purpose:", description);

  console.log("\nYou will sign two approvals:");
  console.log("1. Workflow v2 with signed authorizationModel=model-b");
  console.log("2. PaymentApprovalV2 for the exact recipient, amount and nonce");

  console.log("\nNo payment will be submitted by this command.");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let answer: string;

  try {
    answer = await rl.question(`\nType APPROVE MODEL-B ${requestId} to sign: `);
  } finally {
    rl.close();
  }

  assert.equal(
    answer.trim(),
    `APPROVE MODEL-B ${requestId}`,
    "Owner declined Model B approval"
  );

  // --------------------------------------------------
  // 4. Revalidate ALL live policy before signing.
  // --------------------------------------------------

  const after = await inspectLivePolicy();

  assertUnchangedModelBOwnerPolicy(before, after);

  // Workflow may last at most 48 hours, and neither
  // approval may extend beyond the on-chain task.
  const taskExpiry = Number(after.taskExpiresAtUnix);

  const workflowExpiry = Math.min(after.nowUnix + 48 * 60 * 60, taskExpiry);

  const paymentExpiry = Math.min(after.nowUnix + 15 * 60, workflowExpiry);

  assert.ok(
    workflowExpiry > after.nowUnix + 60,
    "Insufficient workflow approval validity"
  );

  assert.ok(
    paymentExpiry > after.nowUnix + 60,
    "Insufficient payment approval validity"
  );

  // --------------------------------------------------
  // 5. Build two cryptographically bound approvals.
  // --------------------------------------------------

  const workflow = workflowApprovalV2Schema.parse({
    version: 2,
    authorizationModel: "model-b",
    network: NETWORK,
    requestId,
    genesisHash: state.genesisHash,
    programId: PROGRAM_ID,
    vault: vaultPda.toBase58(),
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    assignedAgent: selectedAgent,
    agentAuthority: authority.toBase58(),
    kind: AGENT_WORKFLOWS[selectedAgent],
    taskId: taskIdNumber,
    recipient: after.recipient,
    amountBaseUnits: amount,
    expiresAtUnix: workflowExpiry,
    description,
  });

  const paymentApproval = paymentApprovalV2Schema.parse({
    version: 2,
    genesisHash: state.genesisHash,
    programId: PROGRAM_ID,
    vault: vaultPda.toBase58(),
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    agent: agentPda.toBase58(),
    agentAuthority: authority.toBase58(),
    task: approvedTaskPda.toBase58(),
    recipient: after.recipient,
    amountBaseUnits: String(amount),
    nonce: after.nextNonce,
    expiresAtUnix: String(paymentExpiry),
    requestId,
  });

  const context: BindingContext = {
    scope: {
      network: NETWORK,
      genesisHash: state.genesisHash,
      programId: PROGRAM_ID,
      vault: vaultPda.toBase58(),
      owner: owner.toBase58(),
      mint: mint.toBase58(),
    },
    agentPda,
    approvedTaskPda,
    nextNonce: after.nextNonce,
    taskExpiresAtUnix: after.taskExpiresAtUnix,
    nowUnix: after.nowUnix,
  };

  // Load the private owner key only after explicit
  // confirmation and the second on-chain validation.
  const ownerKeypair = readOwnerKeypair(owner);

  const approvalPackage = signModelBOwnerApprovalPackage(
    workflow,
    paymentApproval,
    ownerKeypair,
    context
  );

  const paths = saveModelBOwnerApprovalPackage(
    RUNTIME_DIR,
    approvalPackage,
    context
  );

  // Verify both stored files before reporting success.
  const restored = loadModelBOwnerApprovalPackage(
    RUNTIME_DIR,
    requestId,
    context
  );

  assert.deepEqual(restored, approvalPackage);

  console.log("\n=== MODEL B APPROVED ===");
  console.log("Workflow v2 signature: VERIFIED");
  console.log("Payment v2 signature: VERIFIED");
  console.log("ApprovedTask nonce:", paymentApproval.nonce);
  console.log(
    "Payment approval expiry:",
    new Date(paymentExpiry * 1000).toISOString()
  );
  console.log("Workflow saved:", paths.workflowPath);
  console.log("Payment saved:", paths.paymentPath);
  console.log("\nNO PAYMENT SUBMITTED");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "\nMODEL B OWNER APPROVAL: BLOCKED",
      error instanceof Error ? error.message : error
    );

    process.exitCode = 1;
  });
}
