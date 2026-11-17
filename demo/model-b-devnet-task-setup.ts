/**
 * AgentVault 7.5G.4H — dedicated Model B task creation.
 * Default is read-only. --create is the only signing/broadcast path.
 * This script does NOT create an owner workflow approval or pay anyone.
 */
import assert from "node:assert/strict";
import { readFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { Agentvault } from "../target/types/agentvault";
import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";
import {
  inspectModelBDevnetPreflight,
  type ModelBDevnetState,
} from "./model-b-devnet-preflight";

export const DEVNET_AGENT_AUTHORITIES = {
  "agent-a": "24y99x9EPoJ2ToqygjM37eU9AXz3aFwiDcHFv87LXQfQ",
  "agent-b": "5qHQ9f5E6vQ91JhrDRbbBLpSFudzRBGNdvpXkT1iDLxT",
} as const;

export type SetupAgent = keyof typeof DEVNET_AGENT_AUTHORITIES;
export type ModelBSetupArgs = {
  mode: "inspect" | "create";
  agent: SetupAgent;
  taskId: string;
  budget: string;
  recipient: "owner" | string;
  expiresHours: number;
};

const U64_MAX = BigInt("18446744073709551615");
const DEMO_MAX_BUDGET = BigInt("50000");
const USAGE =
  "Usage: model-b-devnet-task-setup.ts --agent agent-a|agent-b --task-id 1001 --budget 20000 --recipient owner|PUBKEY [--expires-hours 24] [--create]";

function canonicalU64(value: string, field: string): bigint {
  assert.match(value, /^(0|[1-9][0-9]*)$/, `Invalid ${field}`);
  const parsed = BigInt(value);
  assert.ok(parsed <= U64_MAX, `${field} exceeds u64`);
  return parsed;
}

/** Strong, explicit CLI parsing; unknown/duplicate flags are rejected. */
export function parseModelBTaskArgs(argv: readonly string[]): ModelBSetupArgs {
  const values = new Map<string, string>();
  let mode: ModelBSetupArgs["mode"] = "inspect";
  const valueFlags = new Set([
    "--agent",
    "--task-id",
    "--budget",
    "--recipient",
    "--expires-hours",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--create") {
      assert.equal(mode, "inspect", "Duplicate --create");
      mode = "create";
      continue;
    }
    assert.ok(valueFlags.has(arg), `${USAGE} (unknown flag: ${arg})`);
    assert.ok(!values.has(arg), `Duplicate ${arg}`);
    const value = argv[++i];
    assert.ok(
      value && !value.startsWith("--"),
      `${USAGE} (missing value for ${arg})`
    );
    values.set(arg, value);
  }
  const agent = values.get("--agent");
  assert.ok(agent === "agent-a" || agent === "agent-b", USAGE);
  const taskId = values.get("--task-id");
  const budget = values.get("--budget");
  const recipient = values.get("--recipient");
  assert.ok(
    taskId !== undefined && budget !== undefined && recipient !== undefined,
    USAGE
  );
  canonicalU64(taskId, "task ID");
  const budgetAmount = canonicalU64(budget, "budget");
  assert.ok(
    budgetAmount > BigInt("0") && budgetAmount <= DEMO_MAX_BUDGET,
    "Demo budget must be from 1 to 50,000 base units"
  );
  if (recipient !== "owner") {
    assert.equal(
      new PublicKey(recipient).toBase58(),
      recipient,
      "Invalid recipient"
    );
    assert.notEqual(
      recipient,
      SystemProgram.programId.toBase58(),
      "Invalid recipient"
    );
  }
  const hoursString = values.get("--expires-hours") ?? "24";
  assert.match(hoursString, /^(0|[1-9][0-9]*)$/, "Invalid expiry hours");
  const expiresHours = Number(hoursString);
  assert.ok(
    Number.isSafeInteger(expiresHours) &&
      expiresHours >= 2 &&
      expiresHours <= 72,
    "Expiry hours must be 2..72"
  );
  return { mode, agent, taskId, budget, recipient, expiresHours };
}

export function deriveApprovedTaskPda(
  agent: PublicKey,
  taskId: string,
  programId: PublicKey
): PublicKey {
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(canonicalU64(taskId, "task ID"));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agent.toBuffer(), idBytes],
    programId
  )[0];
}

/** Pure policy guard against stale, mistaken, or over-reserving plans. */
export function validateModelBTaskPlan(
  args: ModelBSetupArgs,
  context: {
    state: ModelBDevnetState;
    vault: {
      owner: PublicKey;
      tokenMint: PublicKey;
      paused: boolean;
      totalReserved: BN;
    };
    agent: { vault: PublicKey; authority: PublicKey; active: boolean };
    treasuryBalance: bigint;
    nowUnix: bigint;
    taskAlreadyExists: boolean;
  }
): { recipient: PublicKey; freeBalance: bigint; expiryUnix: bigint } {
  const { state, vault, agent, treasuryBalance, nowUnix, taskAlreadyExists } =
    context;
  assert.ok(
    vault.owner.equals(new PublicKey(state.owner)),
    "On-chain owner differs from state"
  );
  assert.ok(
    vault.tokenMint.equals(new PublicKey(state.mint)),
    "On-chain mint differs from state"
  );
  assert.equal(vault.paused, false, "Vault is paused");
  assert.ok(
    agent.vault.equals(new PublicKey(state.vault)),
    "Agent belongs to another Vault"
  );
  assert.ok(
    agent.authority.equals(new PublicKey(DEVNET_AGENT_AUTHORITIES[args.agent])),
    "Agent authority differs from pinned Devnet authority"
  );
  assert.equal(agent.active, true, "Agent is inactive");
  assert.equal(
    taskAlreadyExists,
    false,
    "ApprovedTask already exists: do not recreate or reuse its task ID"
  );
  const reserved = BigInt(vault.totalReserved.toString());
  assert.ok(
    reserved >= BigInt("0") && treasuryBalance >= reserved,
    "Treasury is undercollateralized"
  );
  const freeBalance = treasuryBalance - reserved;
  assert.ok(
    freeBalance >= BigInt(args.budget),
    "Insufficient unreserved treasury tokens"
  );
  assert.ok(
    nowUnix > BigInt("0") && nowUnix < BigInt("4102444800"),
    "Unexpected chain clock"
  );
  const expiryUnix = nowUnix + BigInt(args.expiresHours) * BigInt("3600");
  const recipient =
    args.recipient === "owner"
      ? new PublicKey(state.owner)
      : new PublicKey(args.recipient);
  assert.ok(!recipient.equals(SystemProgram.programId), "Invalid recipient");
  return { recipient, freeBalance, expiryUnix };
}

function loadApprovedOwnerKey(expected: PublicKey): Keypair {
  const path =
    process.env.AGENTVAULT_OWNER_KEYPAIR ??
    join(homedir(), ".config/solana/id.json");
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    "Owner key must be a regular file"
  );
  assert.equal(
    stat.mode & 0o022,
    0,
    "Owner key must not be group/world-writable"
  );
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(
    Array.isArray(input) &&
      input.length === 64 &&
      input.every(
        (v) =>
          typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255
      ),
    "Invalid owner keypair file"
  );
  const signer = Keypair.fromSecretKey(Uint8Array.from(input as number[]));
  assert.ok(
    signer.publicKey.equals(expected),
    "Signing wallet does not own this Vault"
  );
  return signer;
}

async function run(): Promise<void> {
  assert.equal(NETWORK, "devnet", "Devnet task setup is Devnet-only");
  const args = parseModelBTaskArgs(process.argv.slice(2));
  if (args.mode === "create") {
    assert.equal(
      process.stdin.isTTY,
      true,
      "Creation requires an interactive terminal"
    );
  }

  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  ) as ModelBDevnetState;
  const connection = new Connection(RPC_URL, "confirmed");
  await inspectModelBDevnetPreflight(NETWORK, state, connection, async () => {
    const treasury = await getAccount(
      connection,
      new PublicKey(state.treasury),
      "confirmed"
    );
    return {
      owner: treasury.owner,
      mint: treasury.mint,
      amount: treasury.amount,
    };
  });

  const idl = JSON.parse(
    readFileSync(join(process.cwd(), "target/idl/agentvault.json"), "utf8")
  ) as Agentvault;
  const program = new anchor.Program<Agentvault>(idl, { connection });
  assert.equal(
    program.programId.toBase58(),
    state.programId,
    "IDL program mismatch"
  );

  const owner = new PublicKey(state.owner);
  const vaultKey = new PublicKey(state.vault);
  const agentAuthority = new PublicKey(DEVNET_AGENT_AUTHORITIES[args.agent]);
  const [agentKey] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultKey.toBuffer(), agentAuthority.toBuffer()],
    program.programId
  );
  const taskKey = deriveApprovedTaskPda(
    agentKey,
    args.taskId,
    program.programId
  );

  async function freshPlan() {
    assert.equal(
      await connection.getGenesisHash(),
      state.genesisHash,
      "Devnet RPC ledger mismatch"
    );
    const [vault, agent, existingTask, treasury, clock] = await Promise.all([
      program.account.vault.fetch(vaultKey, "confirmed"),
      program.account.agent.fetch(agentKey, "confirmed"),
      connection.getAccountInfo(taskKey, "confirmed"),
      getAccount(connection, new PublicKey(state.treasury), "confirmed"),
      connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"),
    ]);
    assert.ok(clock && clock.data.length >= 40, "On-chain clock unavailable");
    const nowUnix = clock.data.readBigInt64LE(32);
    const report = validateModelBTaskPlan(args, {
      state,
      vault,
      agent,
      treasuryBalance: treasury.amount,
      nowUnix,
      taskAlreadyExists: existingTask !== null,
    });
    assert.equal(
      await connection.getGenesisHash(),
      state.genesisHash,
      "RPC ledger switched"
    );
    return { report, vault, treasury };
  }

  const first = await freshPlan();
  // Freeze expiry at the initially reviewed chain time. Do not silently extend it after confirmation.
  const expiry = first.report.expiryUnix;
  console.log("\n=== MODEL B DEVNET TASK PLAN ===");
  console.log(
    JSON.stringify(
      {
        mode: args.mode.toUpperCase(),
        network: NETWORK,
        vault: state.vault,
        agent: args.agent,
        agentPda: agentKey.toBase58(),
        agentAuthority: agentAuthority.toBase58(),
        taskId: args.taskId,
        approvedTaskPda: taskKey.toBase58(),
        recipient: first.report.recipient.toBase58(),
        budgetBaseUnits: args.budget,
        expiryUnix: expiry.toString(),
        nextNonce: "0",
        treasuryBalance: first.treasury.amount.toString(),
        reservedBefore: first.vault.totalReserved.toString(),
        unreservedBefore: first.report.freeBalance.toString(),
        expectedReservedAfter: (
          BigInt(first.vault.totalReserved.toString()) + BigInt(args.budget)
        ).toString(),
      },
      null,
      2
    )
  );

  if (args.mode === "inspect") {
    console.log(
      "\nREAD ONLY. Add --create only after reviewing the plan and agreeing to reserve the displayed tokens."
    );
    return;
  }

  const phrase = `CREATE MODEL-B TASK ${args.taskId}`;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question(
      `\nType ${phrase} to reserve the displayed budget on Devnet: `
    );
  } finally {
    rl.close();
  }
  assert.equal(answer, phrase, "Task creation declined");

  const second = await freshPlan();
  assert.ok(
    second.report.recipient.equals(first.report.recipient),
    "Recipient changed after review"
  );
  assert.ok(
    second.report.freeBalance >= BigInt(args.budget),
    "Reservation availability changed"
  );
  assert.ok(second.report.expiryUnix >= expiry, "Clock moved backwards");
  assert.ok(
    expiry >
      second.report.expiryUnix -
        BigInt(args.expiresHours) * BigInt("3600") +
        BigInt("120"),
    "Reviewed expiry is too close; repeat dry run with fresh parameters"
  );

  const ownerSigner = loadApprovedOwnerKey(owner);
  assert.ok(
    (await connection.getBalance(owner, "confirmed")) > 10_000_000,
    "Owner has insufficient Devnet SOL for account rent and fees"
  );
  const instruction = await program.methods
    .createApprovedTask(
      new BN(args.taskId),
      new BN(args.budget),
      first.report.recipient,
      new BN(expiry.toString()),
      new PublicKey(state.genesisHash)
    )
    .accountsPartial({
      owner,
      vault: vaultKey,
      agent: agentKey,
      tokenMint: new PublicKey(state.mint),
      treasury: new PublicKey(state.treasury),
      approvedTask: taskKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // One explicit send attempt only. If the RPC response is uncertain, inspect
  // this PDA on-chain rather than blindly sending again.
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(instruction),
    [ownerSigner],
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      skipPreflight: false,
    }
  );
  const task = await program.account.approvedTask.fetch(taskKey, "confirmed");
  assert.ok(
    task.vault.equals(vaultKey) && task.agent.equals(agentKey),
    "Created task relationship mismatch"
  );
  assert.equal(task.budget.toString(), args.budget);
  assert.equal(task.spent.toString(), "0");
  assert.equal(task.nextNonce.toString(), "0");
  assert.equal(task.expiresAt.toString(), expiry.toString());
  assert.ok(task.recipient.equals(first.report.recipient));
  assert.equal(task.active, true);
  const updatedVault = await program.account.vault.fetch(vaultKey, "confirmed");
  assert.equal(
    updatedVault.totalReserved.toString(),
    (
      BigInt(first.vault.totalReserved.toString()) + BigInt(args.budget)
    ).toString(),
    "Reservation changed concurrently; review all task/accounting updates"
  );

  console.log("\nCREATED Model B task:", taskKey.toBase58());
  console.log("Devnet transaction signature:", signature);
  console.log("No workflow approval, journal claim, or payment was created.");
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(
      "MODEL B TASK SETUP STOPPED:",
      error instanceof Error ? error.message : error
    );
    console.error(
      "If --create was confirmed, inspect the ApprovedTask PDA before attempting creation again."
    );
    process.exitCode = 1;
  });
}
