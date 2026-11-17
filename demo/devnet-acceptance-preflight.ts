/**
 * AgentVault Devnet Acceptance Readiness Preflight (Read-Only).
 *
 * Verifies on-chain Devnet state, accounts, treasury, policy, permissions,
 * RPC availability, and executes a read-only transaction simulation.
 *
 * SAFETY GUARANTEES:
 * - Read-only: Never loads private keys or secrets.
 * - Never signs or broadcasts any transaction.
 * - Uses public keys and on-chain Anchor IDL decoding only.
 *
 * Usage:
 *   npx tsx demo/devnet-acceptance-preflight.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import {
  Connection,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
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

export const DEVNET_PROGRAM_ID = new PublicKey(
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d"
);
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const REFERENCE_DEVNET_STATE = {
  vault: "G2GY1MSTtYK2UMiEJWCDDHQPBwTHKn1b9jZvSkghn77U",
  owner: "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc",
  agentAuthority: "AeP6wgJ1BktbP7q4MyEuKbuXXbQJgoLgMtgbGDi7hp8L",
  agentPda: "DNT9yiPV6dTxzccUF9fr928xnFYPt8Wp7DmTErC41D6u",
  taskPda: "8NM3stPQxoEFLkxKcG6a9nxnd4osp4XhEpmtNk8iophv",
  recipient: "DmSyacb7BBjtUYFB76uk4K3YyQbHVwb38tn4uj7JuEVT",
  mint: "EwgEeTw1XurM1FuUDKDNwss7T4Qc4sDgzBupAFYMoP9x",
};

export type DevnetPreflightOptions = {
  rpcUrl?: string;
  connection?: Connection;
  program?: anchor.Program<Agentvault>;
  programId?: PublicKey;
  state?: Partial<typeof REFERENCE_DEVNET_STATE>;
  clockTimeOverride?: number;
};

export type DevnetPreflightResult = {
  ok: boolean;
  diagnosticOk: boolean;
  acceptanceReadiness: "READY" | "BLOCKED";
  blockedReason?: string;
  rpcAvailable: boolean;
  genesisHash: string;
  programExecutable: boolean;
  clock: {
    chainTimeUnix: number;
    chainTimeIso: string;
  };
  vault: {
    address: string;
    owner: string;
    mint: string;
    paused: boolean;
    totalReserved: string;
  };
  agent: {
    address: string;
    authority: string;
    active: boolean;
  };
  task: {
    address: string;
    recipient: string;
    budget: string;
    spent: string;
    remaining: string;
    nextNonce: string;
    expiresAtUnix: number;
    expiresAtIso: string;
    expired: boolean;
    active: boolean;
  };
  treasury: {
    address: string;
    balance: string;
    owner: string;
  };
  simulation: {
    attempted: boolean;
    success: boolean;
    logs?: string[];
    err?: unknown;
    errorCode?: number;
    errorName?: string;
  };
};

export async function runDevnetPreflight(
  optionsOrRpcUrl: string | DevnetPreflightOptions = "https://api.devnet.solana.com"
): Promise<DevnetPreflightResult> {
  const options: DevnetPreflightOptions =
    typeof optionsOrRpcUrl === "string"
      ? { rpcUrl: optionsOrRpcUrl }
      : optionsOrRpcUrl;

  const rpcUrl = options.rpcUrl ?? "https://api.devnet.solana.com";
  const connection = options.connection ?? new Connection(rpcUrl, "confirmed");
  const programId = options.programId ?? DEVNET_PROGRAM_ID;
  const state = { ...REFERENCE_DEVNET_STATE, ...options.state };

  // 1. RPC & Genesis Hash
  const genesisHash = await connection.getGenesisHash();
  assert.equal(
    genesisHash,
    DEVNET_GENESIS_HASH,
    `Devnet genesis hash mismatch: expected ${DEVNET_GENESIS_HASH}, got ${genesisHash}`
  );

  // 2. Program ID & Deployment
  const programInfo = await connection.getAccountInfo(programId);
  assert.ok(programInfo, "AgentVault program not found on Devnet");
  assert.equal(programInfo.executable, true, "Program must be executable");

  const idlPath = join(process.cwd(), "target/idl/agentvault.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Agentvault;
  const program =
    options.program ??
    new anchor.Program<Agentvault>(idl, { connection });

  // 3. Vault Account
  const vaultPubkey = new PublicKey(state.vault!);
  const vault = await program.account.vault.fetch(vaultPubkey);
  assert.equal(vault.owner.toBase58(), state.owner!);
  assert.equal(vault.tokenMint.toBase58(), state.mint!);

  // 4. Agent Account
  const agentPubkey = new PublicKey(state.agentPda!);
  const agent = await program.account.agent.fetch(agentPubkey);
  assert.equal(agent.vault.toBase58(), state.vault!);
  assert.equal(
    agent.authority.toBase58(),
    state.agentAuthority!
  );

  // 5. Task Account
  const taskPubkey = new PublicKey(state.taskPda!);
  const task = await program.account.task.fetch(taskPubkey);
  assert.equal(task.vault.toBase58(), state.vault!);
  assert.equal(task.agent.toBase58(), state.agentPda!);
  assert.equal(task.recipient.toBase58(), state.recipient!);

  let chainTime: number;
  if (options.clockTimeOverride !== undefined) {
    chainTime = options.clockTimeOverride;
  } else {
    const clockInfo = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    assert.ok(clockInfo && clockInfo.data.length >= 40, "Cannot read Solana clock");
    chainTime = Number(clockInfo.data.readBigInt64LE(32));
  }
  const taskExpiresAt = Number(task.expiresAt);
  const expired = chainTime >= taskExpiresAt;

  const budgetBn = new BN(task.budget.toString());
  const spentBn = new BN(task.spent.toString());
  assert.ok(spentBn.lte(budgetBn), "Task spent exceeds budget");
  const remainingBn = budgetBn.sub(spentBn);

  // 6. Treasury Token Account
  const mintPubkey = new PublicKey(state.mint!);
  const expectedTreasury = getAssociatedTokenAddressSync(
    mintPubkey,
    vaultPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const treasuryAccount = await getAccount(
    connection,
    expectedTreasury,
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  assert.equal(treasuryAccount.owner.toBase58(), state.vault!);
  assert.equal(treasuryAccount.mint.toBase58(), state.mint!);

  const treasuryBalance = BigInt(treasuryAccount.amount.toString());
  const vaultTotalReserved = BigInt(vault.totalReserved.toString());

  // 7. Transaction Construction & Simulation (Read-only, zero private keys)
  const recipientPubkey = new PublicKey(state.recipient!);
  const recipientAta = getAssociatedTokenAddressSync(
    mintPubkey,
    recipientPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      new PublicKey(state.agentAuthority!),
      recipientAta,
      recipientPubkey,
      mintPubkey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];

  // Build Model A payment instruction with simulated 1000 base units
  const testPaymentAmount = new BN(1000);
  const paymentIx = await (program.methods as any)
    .executeTaskPayment(testPaymentAmount, new BN(task.nextNonce.toString()))
    .accounts({
      agentAuthority: new PublicKey(state.agentAuthority!),
      vault: vaultPubkey,
      agent: agentPubkey,
      task: taskPubkey,
      tokenMint: mintPubkey,
      treasury: expectedTreasury,
      recipient: recipientPubkey,
      recipientToken: recipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  instructions.push(paymentIx);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const messageV0 = new TransactionMessage({
    payerKey: new PublicKey(state.agentAuthority!),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const dummyVersionedTx = new VersionedTransaction(messageV0);

  // Simulate without signature verification (read-only instruction simulation)
  let simSuccess = false;
  let simLogs: string[] | undefined;
  let simErr: unknown = null;
  let errorCode: number | undefined;
  let errorName: string | undefined;

  try {
    const simRes = await connection.simulateTransaction(dummyVersionedTx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    simLogs = simRes.value.logs ?? undefined;
    simErr = simRes.value.err;
    simSuccess = simErr === null;
  } catch (err) {
    simErr = (err as Error).message;
  }

  if (simErr && typeof simErr === "object") {
    const errObj = simErr as any;
    if (errObj.InstructionError && Array.isArray(errObj.InstructionError)) {
      const customErr = errObj.InstructionError[1];
      if (customErr && typeof customErr === "object" && typeof customErr.Custom === "number") {
        errorCode = customErr.Custom;
        if (errorCode === 6012) {
          errorName = "TaskExpired";
        }
      }
    }
  }

  // Distinguish diagnostic success from payment-execution readiness
  let acceptanceReadiness: "READY" | "BLOCKED" = "READY";
  let blockedReason: string | undefined;

  if (vault.paused) {
    acceptanceReadiness = "BLOCKED";
    blockedReason = "BLOCKED — VaultPaused";
  } else if (!agent.active) {
    acceptanceReadiness = "BLOCKED";
    blockedReason = "BLOCKED — AgentInactive";
  } else if (!task.active) {
    acceptanceReadiness = "BLOCKED";
    blockedReason = "BLOCKED — TaskInactive";
  } else if (expired || errorCode === 6012 || errorName === "TaskExpired") {
    acceptanceReadiness = "BLOCKED";
    blockedReason = "BLOCKED — TaskExpired";
  } else if (treasuryBalance < vaultTotalReserved) {
    acceptanceReadiness = "BLOCKED";
    blockedReason = "BLOCKED — TreasuryBalanceInsufficient";
  } else if (simErr !== null) {
    acceptanceReadiness = "BLOCKED";
    blockedReason = `BLOCKED — SimulationFailed: ${JSON.stringify(simErr)}`;
  }

  return {
    ok: true,
    diagnosticOk: true,
    acceptanceReadiness,
    blockedReason,
    rpcAvailable: true,
    genesisHash,
    programExecutable: true,
    clock: {
      chainTimeUnix: chainTime,
      chainTimeIso: new Date(chainTime * 1000).toISOString(),
    },
    vault: {
      address: vaultPubkey.toBase58(),
      owner: vault.owner.toBase58(),
      mint: vault.tokenMint.toBase58(),
      paused: vault.paused,
      totalReserved: vault.totalReserved.toString(),
    },
    agent: {
      address: agentPubkey.toBase58(),
      authority: agent.authority.toBase58(),
      active: agent.active,
    },
    task: {
      address: taskPubkey.toBase58(),
      recipient: task.recipient.toBase58(),
      budget: task.budget.toString(),
      spent: task.spent.toString(),
      remaining: remainingBn.toString(),
      nextNonce: task.nextNonce.toString(),
      expiresAtUnix: taskExpiresAt,
      expiresAtIso: new Date(taskExpiresAt * 1000).toISOString(),
      expired,
      active: task.active,
    },
    treasury: {
      address: expectedTreasury.toBase58(),
      balance: treasuryAccount.amount.toString(),
      owner: treasuryAccount.owner.toBase58(),
    },
    simulation: {
      attempted: true,
      success: simSuccess,
      logs: simLogs,
      err: simErr,
      errorCode,
      errorName,
    },
  };
}

async function main() {
  console.log("====================================================");
  console.log("  AgentVault Devnet Acceptance Readiness Preflight  ");
  console.log("====================================================");
  console.log("Mode: READ ONLY (Zero private keys, no broadcasts)\n");

  const result = await runDevnetPreflight();

  console.log("Devnet RPC:          CONNECTED");
  console.log(`Genesis Hash:        ${result.genesisHash}`);
  console.log(`Program ID:          ${DEVNET_PROGRAM_ID.toBase58()} (EXECUTABLE)`);
  console.log(`On-Chain Clock:      ${result.clock.chainTimeIso} (${result.clock.chainTimeUnix})`);
  console.log(`Vault PDA:           ${result.vault.address}`);
  console.log(`  Owner:             ${result.vault.owner}`);
  console.log(`  Token Mint:        ${result.vault.mint}`);
  console.log(`  Status:            ${result.vault.paused ? "PAUSED" : "ACTIVE"}`);
  console.log(`  Total Reserved:    ${result.vault.totalReserved}`);
  console.log(`Treasury ATA:        ${result.treasury.address}`);
  console.log(`  Balance:           ${result.treasury.balance} base units`);
  console.log(`Agent PDA:           ${result.agent.address}`);
  console.log(`  Authority:         ${result.agent.authority}`);
  console.log(`  Active:            ${result.agent.active}`);
  console.log(`Task PDA:            ${result.task.address}`);
  console.log(`  Recipient:         ${result.task.recipient}`);
  console.log(`  Budget:            ${result.task.budget}`);
  console.log(`  Spent:             ${result.task.spent}`);
  console.log(`  Remaining:         ${result.task.remaining}`);
  console.log(`  Next Nonce:        ${result.task.nextNonce}`);
  console.log(`  Expires At:        ${result.task.expiresAtIso}`);
  console.log(`  Expired:           ${result.task.expired}`);
  console.log(`  Active:            ${result.task.active}`);
  console.log(`Read-Only Simulation: ${result.simulation.success ? "SUCCEEDED" : "SIMULATED (expected preflight status)"}`);
  if (result.simulation.err) {
    console.log(`  Simulation Result: ${JSON.stringify(result.simulation.err)}`);
  }
  if (result.simulation.errorName) {
    console.log(`  Simulation Error:  ${result.simulation.errorName} (${result.simulation.errorCode})`);
  }

  console.log(`\nDIAGNOSTIC STATUS:    ${result.diagnosticOk ? "PASSED" : "FAILED"}`);
  if (result.acceptanceReadiness === "BLOCKED") {
    console.log(`ACCEPTANCE READINESS: ${result.blockedReason}`);
    console.log("PAYMENT EXECUTION READINESS: BLOCKED until an active, unexpired task passes preflight.");
  } else {
    console.log("ACCEPTANCE READINESS: READY");
    console.log("PREFLIGHT VERIFICATION: PASSED");
    console.log("The deployed Devnet protocol is ready for controlled acceptance testing.");
  }
}

if (process.argv[1] && process.argv[1].endsWith("devnet-acceptance-preflight.ts")) {
  main().catch((err) => {
    console.error("DEVNET PREFLIGHT FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
