/**
 * AgentVault — retire a Devnet Model B task whose test recipient key was exposed.
 * Default: inspect only. Explicit --revoke requires interactive confirmation.
 * This script only targets task 1002 and its exact original recipient.
 */
import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import * as anchor from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import type { Agentvault } from "../target/types/agentvault";
import { NETWORK, RPC_URL, RUNTIME_DIR } from "./runtime-config";

export const COMPROMISED_TASK_ID = "1002";
export const COMPROMISED_RECIPIENT =
  "528X1s4ik1kJJdw1L7mwsRvV1ZkKNnDwGAvs2WUsgSb3";
export const COMPROMISED_TASK_PDA =
  "C2TykugMWocGnsDTszRGUz16ALsKriWeifQ3KZoGgSTe";
export const EXPECTED_AGENT_AUTHORITY =
  "24y99x9EPoJ2ToqygjM37eU9AXz3aFwiDcHFv87LXQfQ";
export const EXPECTED_PROGRAM_ID =
  "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d";
export const EXPECTED_VAULT = "9uwN9YvPXKTdnRjKth6uAxK9AcWWLA5ckXMGdb5KbuXB";
export const EXPECTED_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function parseRevokeArgs(argv: readonly string[]): "inspect" | "revoke" {
  assert.ok(
    argv.length === 0 || (argv.length === 1 && argv[0] === "--revoke"),
    "Only --revoke is supported; no flags means inspect-only"
  );
  return argv.length === 0 ? "inspect" : "revoke";
}

function deriveTaskPda(agent: PublicKey, programId: PublicKey): PublicKey {
  const taskBytes = Buffer.alloc(8);
  taskBytes.writeBigUInt64LE(BigInt(COMPROMISED_TASK_ID));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("approved-task"), agent.toBuffer(), taskBytes],
    programId
  )[0];
}

export function assertCompromisedTaskIsSafeToRevoke(view: {
  programId: PublicKey;
  vaultKey: PublicKey;
  stateOwner: PublicKey;
  vault: { owner: PublicKey; totalReserved: { toString(): string } };
  agentKey: PublicKey;
  agent: { vault: PublicKey; authority: PublicKey };
  taskKey: PublicKey;
  task: {
    vault: PublicKey;
    agent: PublicKey;
    recipient: PublicKey;
    taskId: { toString(): string };
    budget: { toString(): string };
    spent: { toString(): string };
    nextNonce: { toString(): string };
    active: boolean;
    genesisHash: PublicKey;
  };
}): bigint {
  const {
    programId,
    vaultKey,
    stateOwner,
    vault,
    agentKey,
    agent,
    taskKey,
    task,
  } = view;
  assert.equal(programId.toBase58(), EXPECTED_PROGRAM_ID, "Unexpected program");
  assert.equal(vaultKey.toBase58(), EXPECTED_VAULT, "Unexpected Vault");
  assert.ok(vault.owner.equals(stateOwner), "Vault owner mismatch");
  assert.ok(agent.vault.equals(vaultKey), "Agent/Vault mismatch");
  assert.equal(
    agent.authority.toBase58(),
    EXPECTED_AGENT_AUTHORITY,
    "Wrong agent authority"
  );
  assert.ok(
    task.vault.equals(vaultKey) && task.agent.equals(agentKey),
    "Task relationship mismatch"
  );
  assert.ok(
    deriveTaskPda(agentKey, programId).equals(taskKey),
    "Derived task PDA mismatch"
  );
  assert.equal(taskKey.toBase58(), COMPROMISED_TASK_PDA, "Unexpected task PDA");
  assert.equal(
    task.taskId.toString(),
    COMPROMISED_TASK_ID,
    "Unexpected task ID"
  );
  assert.equal(
    task.recipient.toBase58(),
    COMPROMISED_RECIPIENT,
    "Unexpected recipient"
  );
  assert.equal(
    task.genesisHash.toBase58(),
    EXPECTED_GENESIS,
    "Unexpected task genesis hash"
  );
  assert.equal(task.budget.toString(), "10000", "Unexpected original budget");
  assert.equal(
    task.spent.toString(),
    "0",
    "Task has spending activity: review before revoking"
  );
  assert.equal(
    task.nextNonce.toString(),
    "0",
    "Task nonce changed: review before revoking"
  );
  assert.equal(
    task.active,
    true,
    "Task is already inactive; do not submit again"
  );
  const unused = BigInt(task.budget.toString()) - BigInt(task.spent.toString());
  assert.ok(
    BigInt(vault.totalReserved.toString()) >= unused,
    "Reservation invariant failed"
  );
  return unused;
}

function loadOwnerSigner(expected: PublicKey): Keypair {
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
    "Owner key cannot be group/world-writable"
  );
  const contents: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(
    Array.isArray(contents) &&
      contents.length === 64 &&
      contents.every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
    "Invalid owner secret key file"
  );
  const signer = Keypair.fromSecretKey(Uint8Array.from(contents as number[]));
  assert.ok(signer.publicKey.equals(expected), "Wrong owner signer");
  return signer;
}

async function main() {
  const mode = parseRevokeArgs(process.argv.slice(2));
  assert.equal(NETWORK, "devnet", "Devnet only");
  if (mode === "revoke") {
    assert.equal(
      process.stdin.isTTY,
      true,
      "Revocation needs an interactive terminal"
    );
  }
  const state = JSON.parse(
    readFileSync(join(RUNTIME_DIR, "state.json"), "utf8")
  ) as {
    genesisHash: string;
    programId: string;
    owner: string;
    vault: string;
  };
  assert.equal(state.genesisHash, EXPECTED_GENESIS, "Unexpected saved genesis");
  assert.equal(
    state.programId,
    EXPECTED_PROGRAM_ID,
    "Unexpected saved program"
  );
  assert.equal(state.vault, EXPECTED_VAULT, "Unexpected saved Vault");

  const connection = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(
    readFileSync("target/idl/agentvault.json", "utf8")
  ) as Agentvault;
  const program = new anchor.Program<Agentvault>(idl, { connection });
  const programId = program.programId;
  const vaultKey = new PublicKey(state.vault);
  const stateOwner = new PublicKey(state.owner);
  const agentAuthority = new PublicKey(EXPECTED_AGENT_AUTHORITY);
  const [agentKey] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), vaultKey.toBuffer(), agentAuthority.toBuffer()],
    programId
  );
  const taskKey = new PublicKey(COMPROMISED_TASK_PDA);

  async function inspect() {
    assert.equal(
      await connection.getGenesisHash(),
      EXPECTED_GENESIS,
      "Wrong Devnet ledger"
    );
    const [vault, agent, task] = await Promise.all([
      program.account.vault.fetch(vaultKey, "confirmed"),
      program.account.agent.fetch(agentKey, "confirmed"),
      program.account.approvedTask.fetch(taskKey, "confirmed"),
    ]);
    const unused = assertCompromisedTaskIsSafeToRevoke({
      programId,
      vaultKey,
      stateOwner,
      vault,
      agentKey,
      agent,
      taskKey,
      task,
    });
    assert.equal(
      await connection.getGenesisHash(),
      EXPECTED_GENESIS,
      "RPC ledger switched"
    );
    return { unused, reserved: BigInt(vault.totalReserved.toString()) };
  }

  const initial = await inspect();
  console.log("\n=== COMPROMISED MODEL B TASK / DEVNET ===");
  console.log(
    JSON.stringify(
      {
        mode: mode.toUpperCase(),
        taskId: COMPROMISED_TASK_ID,
        approvedTask: taskKey.toBase58(),
        compromisedRecipient: COMPROMISED_RECIPIENT,
        taskActive: true,
        taskSpent: "0",
        amountToUnreserve: initial.unused.toString(),
        reservedBefore: initial.reserved.toString(),
        expectedReservedAfter: (initial.reserved - initial.unused).toString(),
      },
      null,
      2
    )
  );
  if (mode === "inspect") {
    console.log(
      "READ ONLY; pass --revoke only if the displayed task is correct."
    );
    return;
  }
  const phrase = "REVOKE MODEL-B TASK 1002";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let response: string;
  try {
    response = await rl.question(
      `Type ${phrase} to permanently deactivate task 1002: `
    );
  } finally {
    rl.close();
  }
  assert.equal(response, phrase, "Revocation declined");
  const fresh = await inspect();
  assert.equal(
    fresh.reserved,
    initial.reserved,
    "Vault reservation changed; stop"
  );
  assert.equal(
    fresh.unused,
    initial.unused,
    "Task remaining budget changed; stop"
  );
  const ownerSigner = loadOwnerSigner(stateOwner);
  const instruction = await program.methods
    .revokeApprovedTask()
    .accountsPartial({
      owner: stateOwner,
      vault: vaultKey,
      agent: agentKey,
      approvedTask: taskKey,
    })
    .instruction();
  // Exactly one send attempt; if RPC is ambiguous, inspect the PDA before retrying.
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
  const [afterTask, afterVault] = await Promise.all([
    program.account.approvedTask.fetch(taskKey, "confirmed"),
    program.account.vault.fetch(vaultKey, "confirmed"),
  ]);
  assert.equal(afterTask.active, false, "Revocation not reflected on task");
  assert.equal(
    afterVault.totalReserved.toString(),
    (initial.reserved - initial.unused).toString(),
    "Reservation differs from expected; inspect concurrent changes"
  );
  console.log("\nREVOKED Model B task:", taskKey.toBase58());
  console.log("Devnet signature:", signature);
  console.log(
    "Unspent reservation released:",
    initial.unused.toString(),
    "base units"
  );
  console.log("No payment was submitted.");
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(
      "MODEL B TASK REVOCATION STOPPED:",
      e instanceof Error ? e.message : e
    );
    console.error(
      "If --revoke was confirmed, inspect the task PDA and Vault before attempting again."
    );
    process.exitCode = 1;
  });
}
