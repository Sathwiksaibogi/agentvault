/**
 * Read-only Vault 2 dashboard source.
 * No wallet, keypair, Gemini, journal, or filesystem secrets are accessed here.
 */
import { strict as assert } from "node:assert";
import type * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";
import type { Agent, ActivityEntry, DashboardData } from "../frontend/src/api";
import { webAgents } from "../frontend/src/webAgents";
import { NETWORK } from "./runtime-config";

/** Read exclusively from the hard-coded, independently verified web-vault config. */
export async function getWebVaultDashboard(
  connection: Connection,
  program: anchor.Program<Agentvault>,
  expectedGenesisHash: string
): Promise<DashboardData> {
  assert.equal(NETWORK, "devnet", "Web vault dashboard requires Devnet");
  assert.equal(await connection.getGenesisHash(), expectedGenesisHash);
  assert.equal(webAgents.network, "devnet");
  assert.equal(program.programId.toBase58(), webAgents.programId);

  const owner = new PublicKey(webAgents.owner);
  const vaultPda = new PublicKey(webAgents.vault);
  const tokenMint = new PublicKey(webAgents.mint);
  const treasuryAta = new PublicKey(webAgents.treasury);
  const vaultId = new BN(webAgents.vaultId);

  const [derivedVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );
  assert.ok(derivedVault.equals(vaultPda), "Web vault PDA mismatch");
  assert.ok(
    getAssociatedTokenAddressSync(tokenMint, vaultPda, true).equals(
      treasuryAta
    ),
    "Web treasury ATA mismatch"
  );

  const [vault, treasuryAccount, mintInfo] = await Promise.all([
    program.account.vault.fetch(vaultPda, "confirmed"),
    getAccount(connection, treasuryAta, "confirmed", TOKEN_PROGRAM_ID),
    getMint(connection, tokenMint, "confirmed", TOKEN_PROGRAM_ID),
  ]);

  assert.ok(vault.owner.equals(owner), "Vault owner mismatch");
  assert.ok(vault.tokenMint.equals(tokenMint), "Vault mint mismatch");
  assert.ok(vault.vaultId.eq(vaultId), "Vault ID mismatch");
  assert.ok(
    treasuryAccount.owner.equals(vaultPda),
    "Treasury authority mismatch"
  );
  assert.ok(treasuryAccount.mint.equals(tokenMint), "Treasury mint mismatch");

  const reserved = BigInt(vault.totalReserved.toString());
  const balance = treasuryAccount.amount;
  assert.ok(reserved <= balance, "Vault reservation exceeds treasury balance");

  const agents: Agent[] = [];
  let activeTaskReservations = BigInt(0);

  // Two known public authorities. Never import agent signing keypairs here.
  for (const config of webAgents.agents) {
    const authority = new PublicKey(config.authority);
    const recipient = new PublicKey(config.recipient);
    const taskId = new BN(config.taskId);

    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), vaultPda.toBuffer(), authority.toBuffer()],
      program.programId
    );
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

    assert.ok(agent.vault.equals(vaultPda), "Agent belongs to another vault");
    assert.ok(agent.authority.equals(authority), "Unexpected agent authority");
    assert.ok(task.vault.equals(vaultPda), "Task belongs to another vault");
    assert.ok(task.agent.equals(agentPda), "Task belongs to another agent");
    assert.ok(task.taskId.eq(taskId), "Unexpected task ID");
    assert.ok(task.recipient.equals(recipient), "Unexpected task recipient");
    assert.ok(
      task.budget.eq(new BN(config.budgetBaseUnits)),
      "Unexpected task budget"
    );

    const budget = BigInt(task.budget.toString());
    const spent = BigInt(task.spent.toString());
    assert.ok(spent <= budget, "Task spent exceeds budget");
    if (task.active) activeTaskReservations += budget - spent;

    agents.push({
      id: config.id,
      name: `${config.name} Agent`,
      workflow: config.id === "agent-a" ? "procurement" : "operations",
      authority: authority.toBase58(),
      agentPda: agentPda.toBase58(),
      active: agent.active,
      task: {
        taskId: taskId.toNumber(),
        taskPda: taskPda.toBase58(),
        active: task.active,
        recipient: recipient.toBase58(),
        budgetBaseUnits: budget.toString(),
        spentBaseUnits: spent.toString(),
        remainingBaseUnits: (budget - spent).toString(),
        nextNonce: task.nextNonce.toString(),
        expiresAtUnix: task.expiresAt.toString(),
      },
    });
  }

  assert.equal(
    reserved,
    activeTaskReservations,
    "Vault reservations do not match configured active task balances"
  );

  // These are task-account transactions, including task creation; NOT a list
  // of verified payment transfers or off-chain AI workflow approvals.
  const pages = await Promise.all(
    agents.map(async (agent) => {
      const signatures = await connection.getSignaturesForAddress(
        new PublicKey(agent.task.taskPda),
        { limit: 8 },
        "confirmed"
      );
      return signatures.map(
        (entry): ActivityEntry => ({
          signature: entry.signature,
          slot: entry.slot,
          blockTimeUnix: entry.blockTime,
          agentId: agent.id,
          workflow: agent.workflow,
          taskId: agent.task.taskId,
          taskPda: agent.task.taskPda,
          succeeded: entry.err === null,
          explorerUrl: `https://explorer.solana.com/tx/${entry.signature}?cluster=devnet`,
        })
      );
    })
  );

  return {
    treasury: {
      network: "devnet",
      vault: vaultPda.toBase58(),
      owner: owner.toBase58(),
      tokenMint: tokenMint.toBase58(),
      treasury: treasuryAta.toBase58(),
      vaultId: vaultId.toString(),
      decimals: mintInfo.decimals,
      paused: vault.paused,
      balanceBaseUnits: balance.toString(),
      reservedBaseUnits: reserved.toString(),
      availableBaseUnits: (balance - reserved).toString(),
    },
    agents,
    activity: pages
      .flat()
      .sort((a, b) => b.slot - a.slot)
      .slice(0, 20),
    // Web-vault signed approvals are NOT stored in the Vault 1 local journal.
    // Do not clone Vault 1 workflows into Vault 2.
    workflows: [],
  };
}
